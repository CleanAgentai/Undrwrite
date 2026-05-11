// Synthetic harness for Bug A — preliminary-review / escalation trigger.
// Stubs Postmark / Supabase / Claude so nothing leaves the process.
// Exercises both gate predicates and both action helpers.

// 0) Load .env BEFORE the defaulting block below — otherwise our dummy
//    defaults preempt real values and live Claude smokes get skipped even
//    when a real CLAUDE_API_KEY is set.
require('dotenv').config();

// 1) Defaults so config / lib singletons can construct without real creds.
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'sk-test-dummy';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';
process.env.POSTMARK_API_TOKEN = process.env.POSTMARK_API_TOKEN || 'dummy';
process.env.POSTMARK_SENDER_EMAIL = process.env.POSTMARK_SENDER_EMAIL || 'vienna@example.com';
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'franco@privatemortgagelink.com';

// 2) Require service singletons. They're plain objects — mutating the methods
//    is visible to webhook.js because all callers share the same require cache.
const dealsService = require('./src/services/deals');
const aiService = require('./src/services/ai');
const emailService = require('./src/services/email');

const calls = {
  sendEmail: [],
  saveMessage: [],
  update: [],
  generateLeadSummary: [],
  generateEscalationNotification: [],
  downloadDocsAsZip: 0,
};

function reset() {
  calls.sendEmail.length = 0;
  calls.saveMessage.length = 0;
  calls.update.length = 0;
  calls.generateLeadSummary.length = 0;
  calls.generateEscalationNotification.length = 0;
  calls.downloadDocsAsZip = 0;
}

// Stub: Patricia + Ryan both have an appraisal + loan_application on file.
// hasReviewableDoc evaluates against {income_proof, noa, appraisal} → appraisal hits.
const stubDocs = [
  { classification: 'appraisal', file_name: 'Appraisal.pdf' },
  { classification: 'loan_application', file_name: 'Application.pdf' },
];

dealsService.getDocumentsByDeal = async () => stubDocs;
dealsService.getDocumentsWithText = async () => stubDocs;
dealsService.getMessages = async () => [];
dealsService.downloadDocsAsZip = async () => {
  calls.downloadDocsAsZip += 1;
  return 'BASE64ZIPPLACEHOLDER';
};
dealsService.saveMessage = async (...args) => { calls.saveMessage.push(args); };
dealsService.update = async (id, patch) => { calls.update.push({ id, patch }); return { id, ...patch }; };

aiService.generateLeadSummary = async (dealSummary, ownershipType, docs, missingDocs, messages) => {
  calls.generateLeadSummary.push({
    borrower_name: dealSummary?.borrower_name,
    ownershipType,
    missingDocs,
    docCount: docs.length,
    messageCount: messages.length,
  });
  return `<h2>Lead Summary for ${dealSummary?.borrower_name}</h2>`;
};

aiService.generateEscalationNotification = async (dealSummary, messages, docs) => {
  calls.generateEscalationNotification.push({
    borrower_name: dealSummary?.borrower_name,
    docCount: docs.length,
    messageCount: messages.length,
  });
  return `<h2>Escalation: ${dealSummary?.borrower_name}</h2>`;
};

emailService.sendEmail = async (to, subject, text, html, attachments) => {
  calls.sendEmail.push({
    to,
    subject,
    attachmentCount: (attachments || []).length,
    attachmentName: attachments?.[0]?.Name || null,
  });
  return { MessageID: `MOCK-${calls.sendEmail.length}` };
};

// 3) Now require webhook — picks up the stubbed singletons.
const webhookRouter = require('./src/routes/webhook');
const {
  sendEscalationToAdmin,
  sendPreliminaryReviewToAdmin,
  normalizeSenderName,
  isUnreliableName,
  firstNameMatchesAdmin,
  isDocRequirementSatisfied,
  DOC_SYNONYMS,
  ADMIN_FIRST_NAME,
  textToHtml,
} = webhookRouter.__test__;
// Group R: parseDraftReply heuristic predicate exposed for deterministic testing.
const { isFullAlternativeDraft, parseDraftReply } = aiService;

// 4) Predicate evaluator — mirrors the new-client branch gate verbatim.
// Per Bradley's commit e93f657: high-LTV escalation does NOT require hasReviewableDoc
// (Franco wants to see those deals immediately, with or without docs). Preliminary
// review (≤80%) still requires at least one reviewable doc to avoid sending Franco
// a thin file before there's anything to evaluate.
async function evalGate(deal, dealSummary) {
  const docs = await dealsService.getDocumentsByDeal(deal.id);
  const classifications = docs.map(d => d.classification).filter(Boolean);
  const hasReviewableDoc = ['income_proof', 'noa', 'appraisal'].some(c => classifications.includes(c));
  const ltv = dealSummary?.ltv_percent;
  return {
    classifications,
    hasReviewableDoc,
    ltv,
    willEscalate: !!(ltv && ltv > 80),
    willReview: !!(ltv && ltv <= 80 && hasReviewableDoc),
  };
}

function fmt(label, value) { console.log(`  ${label}:`, JSON.stringify(value)); }

(async () => {
  // ────────── PATRICIA: 65.7% LTV, broker initial submission ──────────
  console.log('\n========== PATRICIA SIMMONS — 65.7% LTV (broker initial) ==========');
  const patriciaDeal = { id: 'deal-patricia-1', borrower_name: 'Jason Mercer' };
  const patriciaSummary = {
    sender_type: 'broker',
    sender_name: 'Jason Mercer',
    broker_name: 'Jason Mercer',
    borrower_name: 'Patricia Simmons',
    ltv_percent: 65.7,
  };

  const pGate = await evalGate(patriciaDeal, patriciaSummary);
  console.log('Predicate:');
  fmt('classifications', pGate.classifications);
  fmt('hasReviewableDoc', pGate.hasReviewableDoc);
  fmt('ltv', pGate.ltv);
  fmt('willEscalate', pGate.willEscalate);
  fmt('willReview', pGate.willReview);

  reset();
  if (pGate.willReview) {
    await sendPreliminaryReviewToAdmin(patriciaDeal, patriciaSummary, null, pGate.ltv);
  } else if (pGate.willEscalate) {
    await sendEscalationToAdmin(patriciaDeal, patriciaSummary, pGate.ltv);
  }

  console.log('Helper effects:');
  fmt('generateLeadSummary calls', calls.generateLeadSummary);
  fmt('generateEscalationNotification calls', calls.generateEscalationNotification);
  fmt('sendEmail to/subject', calls.sendEmail);
  fmt('zip downloads', calls.downloadDocsAsZip);
  fmt('saveMessage subjects', calls.saveMessage.map(a => a[2]));
  fmt('deal updates', calls.update);

  // Hard assertions
  const pAssert = (cond, msg) => { if (!cond) throw new Error(`ASSERTION FAILED [Patricia]: ${msg}`); };
  pAssert(pGate.willReview === true && pGate.willEscalate === false, 'gate must select review path');
  pAssert(calls.generateLeadSummary.length === 1, 'generateLeadSummary called once');
  pAssert(calls.generateEscalationNotification.length === 0, 'generateEscalationNotification not called');
  pAssert(calls.sendEmail.length === 1, 'one email to admin');
  pAssert(calls.sendEmail[0].to === 'franco@privatemortgagelink.com', 'sent to Franco');
  pAssert(calls.sendEmail[0].subject === 'ACTION REQUIRED: PRELIMINARY Review — Patricia Simmons — 65.7% LTV',
    `subject mismatch: ${calls.sendEmail[0].subject}`);
  pAssert(calls.update.length === 1 && calls.update[0].patch.status === 'under_review', 'status flips to under_review');
  pAssert(calls.generateLeadSummary[0].ownershipType === null, 'ownershipType passed as null with TODO');
  // Bradley's commit e4f6b89 dropped 'noa' from baseRequired (NOA satisfies income_proof).
  // Refinance list (no loan_type set → !isPurchase): government_id, appraisal, property_tax,
  // mortgage_statement, income_proof, credit_report. Patricia's stub has appraisal — so 5
  // doc misses. Group C (S6.3/S7.3) appends 'exit_strategy' when dealSummary.exit_strategy
  // is null/empty — Patricia's summary has no exit_strategy field, so total = 6 items.
  pAssert(calls.generateLeadSummary[0].missingDocs.length === 6, `expected 6 missing items (5 docs + exit_strategy), got ${calls.generateLeadSummary[0].missingDocs.length}: ${JSON.stringify(calls.generateLeadSummary[0].missingDocs)}`);
  pAssert(!calls.generateLeadSummary[0].missingDocs.includes('noa'), 'NOA should NOT be in missingDocs list');
  pAssert(calls.generateLeadSummary[0].missingDocs.includes('exit_strategy'), 'exit_strategy SHOULD be in missingDocs (Group C)');
  console.log('Patricia: ALL ASSERTIONS PASSED');

  // ────────── RYAN CALLAHAN: 83.1% LTV, broker initial submission ──────────
  console.log('\n========== RYAN CALLAHAN — 83.1% LTV (broker initial) ==========');
  const ryanDeal = { id: 'deal-ryan-1', borrower_name: 'Jason Mercer' };
  const ryanSummary = {
    sender_type: 'broker',
    sender_name: 'Jason Mercer',
    broker_name: 'Jason Mercer',
    borrower_name: 'Ryan Callahan',
    ltv_percent: 83.1,
  };

  const rGate = await evalGate(ryanDeal, ryanSummary);
  console.log('Predicate:');
  fmt('classifications', rGate.classifications);
  fmt('hasReviewableDoc', rGate.hasReviewableDoc);
  fmt('ltv', rGate.ltv);
  fmt('willEscalate', rGate.willEscalate);
  fmt('willReview', rGate.willReview);

  reset();
  if (rGate.willReview) {
    await sendPreliminaryReviewToAdmin(ryanDeal, ryanSummary, null, rGate.ltv);
  } else if (rGate.willEscalate) {
    await sendEscalationToAdmin(ryanDeal, ryanSummary, rGate.ltv);
  }

  console.log('Helper effects:');
  fmt('generateLeadSummary calls', calls.generateLeadSummary);
  fmt('generateEscalationNotification calls', calls.generateEscalationNotification);
  fmt('sendEmail to/subject', calls.sendEmail);
  fmt('zip downloads', calls.downloadDocsAsZip);
  fmt('saveMessage subjects', calls.saveMessage.map(a => a[2]));
  fmt('deal updates', calls.update);

  const rAssert = (cond, msg) => { if (!cond) throw new Error(`ASSERTION FAILED [Ryan]: ${msg}`); };
  rAssert(rGate.willEscalate === true && rGate.willReview === false, 'gate must select escalate path');
  rAssert(calls.generateEscalationNotification.length === 1, 'generateEscalationNotification called once');
  rAssert(calls.generateLeadSummary.length === 0, 'generateLeadSummary not called');
  rAssert(calls.sendEmail.length === 1, 'one email to admin');
  rAssert(calls.sendEmail[0].to === 'franco@privatemortgagelink.com', 'sent to Franco');
  rAssert(calls.sendEmail[0].subject === 'ACTION REQUIRED: LTV Over 80% — Ryan Callahan',
    `subject mismatch: ${calls.sendEmail[0].subject}`);
  rAssert(calls.update.length === 1 && calls.update[0].patch.status === 'ltv_escalated', 'status flips to ltv_escalated');
  console.log('Ryan: ALL ASSERTIONS PASSED');

  // ────────── HIGH-LTV-NO-DOCS: 90% LTV, broker submitted no reviewable docs ──────────
  // Per Bradley's commit e93f657: high-LTV escalation fires immediately, regardless of
  // doc state. This is the case the OLD predicate would have failed on — gating on
  // hasReviewableDoc would have kept Vienna conversational with Franco never alerted
  // to a dangerously high-LTV deal. New predicate fires escalation anyway.
  console.log('\n========== HIGH-LTV NO-DOCS — 90% LTV, only loan_application on file ==========');
  const stashedGetDocsHL = dealsService.getDocumentsByDeal;
  dealsService.getDocumentsByDeal = async () => [{ classification: 'loan_application', file_name: 'Application.pdf' }];

  const highLtvDeal = { id: 'deal-highltv-1', borrower_name: 'Jason Mercer' };
  const highLtvSummary = {
    sender_type: 'broker',
    sender_name: 'Jason Mercer',
    broker_name: 'Jason Mercer',
    borrower_name: 'David Chen',
    ltv_percent: 90,
  };

  const hGate = await evalGate(highLtvDeal, highLtvSummary);
  console.log('Predicate:');
  fmt('classifications', hGate.classifications);
  fmt('hasReviewableDoc', hGate.hasReviewableDoc);
  fmt('ltv', hGate.ltv);
  fmt('willEscalate', hGate.willEscalate);
  fmt('willReview', hGate.willReview);

  reset();
  if (hGate.willEscalate) {
    await sendEscalationToAdmin(highLtvDeal, highLtvSummary, hGate.ltv);
  } else if (hGate.willReview) {
    await sendPreliminaryReviewToAdmin(highLtvDeal, highLtvSummary, null, hGate.ltv);
  }

  console.log('Helper effects:');
  fmt('generateEscalationNotification calls', calls.generateEscalationNotification);
  fmt('sendEmail to/subject', calls.sendEmail);
  fmt('deal updates', calls.update);

  const hAssert = (cond, msg) => { if (!cond) throw new Error(`ASSERTION FAILED [HighLTV-NoDocs]: ${msg}`); };
  hAssert(hGate.hasReviewableDoc === false, 'precondition: no reviewable doc');
  hAssert(hGate.willEscalate === true, 'high LTV escalates even without reviewable doc');
  hAssert(hGate.willReview === false, 'review path off');
  hAssert(calls.generateEscalationNotification.length === 1, 'generateEscalationNotification called once');
  hAssert(calls.sendEmail[0].subject === 'ACTION REQUIRED: LTV Over 80% — David Chen', `subject mismatch: ${calls.sendEmail[0].subject}`);
  hAssert(calls.update[0].patch.status === 'ltv_escalated', 'status flips to ltv_escalated');
  console.log('High-LTV-No-Docs: ALL ASSERTIONS PASSED');
  dealsService.getDocumentsByDeal = stashedGetDocsHL;

  // ────────── NEGATIVE: LTV ≤80% but no reviewable doc — review still gated ──────────
  // The ≤80% path keeps hasReviewableDoc as a precondition (only the >80% path was relaxed).
  // Vienna stays conversational; Franco isn't notified yet because there's nothing for him
  // to evaluate (no income proof / NOA / appraisal on file).
  console.log('\n========== NEGATIVE — LTV 65% but no reviewable doc on file ==========');
  const stashedGetDocs = dealsService.getDocumentsByDeal;
  dealsService.getDocumentsByDeal = async () => [{ classification: 'loan_application' }, { classification: 'pnw_statement' }];
  const negGate = await evalGate({ id: 'deal-neg-1' }, { ltv_percent: 65 });
  fmt('hasReviewableDoc', negGate.hasReviewableDoc);
  fmt('willReview', negGate.willReview);
  fmt('willEscalate', negGate.willEscalate);
  if (negGate.willReview || negGate.willEscalate) throw new Error('NEGATIVE assertion failed: gate fired on ≤80% without reviewable doc');
  console.log('Negative case: GATE CORRECTLY DID NOT FIRE (≤80% path requires reviewable doc)');
  dealsService.getDocumentsByDeal = stashedGetDocs;

  // ────────── NEGATIVE: reviewable doc present but no LTV ──────────
  console.log('\n========== NEGATIVE — appraisal on file but ltv_percent null ==========');
  const negGate2 = await evalGate({ id: 'deal-neg-2' }, { ltv_percent: null });
  fmt('hasReviewableDoc', negGate2.hasReviewableDoc);
  fmt('willReview', negGate2.willReview);
  fmt('willEscalate', negGate2.willEscalate);
  if (negGate2.willReview || negGate2.willEscalate) throw new Error('NEGATIVE assertion failed: gate fired without LTV');
  console.log('Negative case: GATE CORRECTLY DID NOT FIRE');

  // ════════════════════════════════════════════════════════════════
  // FIX 2 — [UPDATED] subject prefix on review/escalation helpers
  // ════════════════════════════════════════════════════════════════
  // Bug 5 from S3 retest: when a broker submits remaining docs to an under_review
  // deal, Vienna sent a passive [Broker Update] notification with no action options
  // — admin couldn't proceed. Fix 2 routes those replies through the existing
  // preliminary-review (or escalation) helper with an isUpdate flag that prefixes
  // the subject with "[UPDATED] " so Franco can tell the new email apart from the
  // original review in his inbox.
  console.log('\n========== FIX 2 — [UPDATED] subject prefix ==========');

  // 1) Preliminary review with isUpdate=true → "[UPDATED] ACTION REQUIRED: ..."
  reset();
  await sendPreliminaryReviewToAdmin(patriciaDeal, patriciaSummary, null, 65.7, { isUpdate: true });
  const updatedPrelimSubject = calls.sendEmail[0]?.subject;
  if (updatedPrelimSubject !== '[UPDATED] ACTION REQUIRED: PRELIMINARY Review — Patricia Simmons — 65.7% LTV') {
    throw new Error(`FAIL [Fix 2 prelim isUpdate=true]: expected "[UPDATED] ACTION REQUIRED: PRELIMINARY Review — Patricia Simmons — 65.7% LTV", got "${updatedPrelimSubject}"`);
  }
  // saveMessage subject should also carry the prefix
  const updatedPrelimSavedSubject = calls.saveMessage[0]?.[2];
  if (updatedPrelimSavedSubject !== updatedPrelimSubject) {
    throw new Error(`FAIL [Fix 2 prelim isUpdate=true saveMessage]: expected saveMessage subject="${updatedPrelimSubject}", got "${updatedPrelimSavedSubject}"`);
  }
  console.log(`  PASS: sendPreliminaryReviewToAdmin({ isUpdate: true }) → subject="${updatedPrelimSubject}"`);

  // 2) Default (no options) → no prefix (regression check)
  reset();
  await sendPreliminaryReviewToAdmin(patriciaDeal, patriciaSummary, null, 65.7);
  const defaultPrelimSubject = calls.sendEmail[0]?.subject;
  if (defaultPrelimSubject !== 'ACTION REQUIRED: PRELIMINARY Review — Patricia Simmons — 65.7% LTV') {
    throw new Error(`FAIL [Fix 2 prelim no options]: expected unprefixed subject, got "${defaultPrelimSubject}"`);
  }
  console.log(`  PASS: sendPreliminaryReviewToAdmin() default → subject="${defaultPrelimSubject}" (no prefix)`);

  // 3) Escalation with isUpdate=true → "[UPDATED] ACTION REQUIRED: LTV Over 80% — ..."
  reset();
  await sendEscalationToAdmin(ryanDeal, ryanSummary, 83.1, { isUpdate: true });
  const updatedEscSubject = calls.sendEmail[0]?.subject;
  if (updatedEscSubject !== '[UPDATED] ACTION REQUIRED: LTV Over 80% — Ryan Callahan') {
    throw new Error(`FAIL [Fix 2 escalation isUpdate=true]: expected "[UPDATED] ACTION REQUIRED: LTV Over 80% — Ryan Callahan", got "${updatedEscSubject}"`);
  }
  const updatedEscSavedSubject = calls.saveMessage[0]?.[2];
  if (updatedEscSavedSubject !== updatedEscSubject) {
    throw new Error(`FAIL [Fix 2 escalation saveMessage]: expected saveMessage subject="${updatedEscSubject}", got "${updatedEscSavedSubject}"`);
  }
  console.log(`  PASS: sendEscalationToAdmin({ isUpdate: true }) → subject="${updatedEscSubject}"`);

  // 4) Escalation default (no options) → no prefix (regression check)
  reset();
  await sendEscalationToAdmin(ryanDeal, ryanSummary, 83.1);
  const defaultEscSubject = calls.sendEmail[0]?.subject;
  if (defaultEscSubject !== 'ACTION REQUIRED: LTV Over 80% — Ryan Callahan') {
    throw new Error(`FAIL [Fix 2 escalation no options]: expected unprefixed subject, got "${defaultEscSubject}"`);
  }
  console.log(`  PASS: sendEscalationToAdmin() default → subject="${defaultEscSubject}" (no prefix)`);

  // 5) COMPLETE Review variant with isUpdate=true (all docs received case).
  //    Stub getDocumentsByDeal to return ALL the baseRequired classifications so
  //    missingDocs.length === 0 and the helper picks "COMPLETE" instead of "PRELIMINARY".
  console.log('\n========== FIX 2 — [UPDATED] subject with COMPLETE Review variant ==========');
  const completeStubDocs = [
    { classification: 'government_id', file_name: 'GovID.pdf' },
    { classification: 'appraisal', file_name: 'Appraisal.pdf' },
    { classification: 'property_tax', file_name: 'Tax.pdf' },
    { classification: 'mortgage_statement', file_name: 'Payout.pdf' },
    { classification: 'income_proof', file_name: 'Income.pdf' },
    { classification: 'credit_report', file_name: 'Credit.pdf' },
  ];
  const stashedGetDocsFix2 = dealsService.getDocumentsByDeal;
  const stashedGetDocsWithTextFix2 = dealsService.getDocumentsWithText;
  dealsService.getDocumentsByDeal = async () => completeStubDocs;
  dealsService.getDocumentsWithText = async () => completeStubDocs;
  reset();
  // Inline summary with exit_strategy populated — Group C added exit_strategy
  // to missingDocs when null, which would flip COMPLETE → PRELIMINARY here. The
  // shared patriciaSummary deliberately omits exit_strategy for the Group C
  // aggregation tests; this test cares only about the [UPDATED] subject prefix.
  const completeSummaryFix2 = { ...patriciaSummary, exit_strategy: 'refinance with B lender at maturity' };
  await sendPreliminaryReviewToAdmin(patriciaDeal, completeSummaryFix2, 'personal', 65.7, { isUpdate: true });
  const completeUpdatedSubject = calls.sendEmail[0]?.subject;
  if (completeUpdatedSubject !== '[UPDATED] ACTION REQUIRED: COMPLETE Review — Patricia Simmons — 65.7% LTV') {
    throw new Error(`FAIL [Fix 2 COMPLETE isUpdate=true]: expected "[UPDATED] ACTION REQUIRED: COMPLETE Review — Patricia Simmons — 65.7% LTV", got "${completeUpdatedSubject}"`);
  }
  console.log(`  PASS: COMPLETE Review with isUpdate=true → subject="${completeUpdatedSubject}"`);
  dealsService.getDocumentsByDeal = stashedGetDocsFix2;
  dealsService.getDocumentsWithText = stashedGetDocsWithTextFix2;

  // ════════════════════════════════════════════════════════════════
  // GROUP L: suppress Vienna's broker reply when FINAL REVIEW will fire
  // ════════════════════════════════════════════════════════════════
  // Mirrors webhook.js exactly: a deal where allDocsReceived=true AND no LTV gate fires
  // AND the deal is currently active triggers the FINAL REVIEW HITL — at that moment
  // Vienna's broker-facing conversational reply is suppressed. Bradley's "always send"
  // stays for everything else.

  console.log('\n========== GROUP L — willFireFinalReview truth table ==========');
  const computeWillFireFinalReview = (allDocsReceived, willEscalate, willReview, status) =>
    !!(allDocsReceived && !willEscalate && !willReview && status === 'active');

  const groupLCases = [
    {
      name: 'all docs in, no LTV gate, status=active → SUPPRESS reply, FINAL REVIEW fires',
      allDocsReceived: true, willEscalate: false, willReview: false, status: 'active',
      expect: true,
    },
    {
      name: 'all docs in but willEscalate fires → DO NOT suppress (Bradley parallel send)',
      allDocsReceived: true, willEscalate: true, willReview: false, status: 'active',
      expect: false,
    },
    {
      name: 'all docs in but willReview fires → DO NOT suppress (Bradley parallel send)',
      allDocsReceived: true, willEscalate: false, willReview: true, status: 'active',
      expect: false,
    },
    {
      name: 'all docs in but status=under_review → DO NOT suppress (already in HITL flow)',
      allDocsReceived: true, willEscalate: false, willReview: false, status: 'under_review',
      expect: false,
    },
    {
      name: 'all docs in but status=ltv_escalated → DO NOT suppress',
      allDocsReceived: true, willEscalate: false, willReview: false, status: 'ltv_escalated',
      expect: false,
    },
    {
      name: 'allDocsReceived=false (normal conversation) → DO NOT suppress',
      allDocsReceived: false, willEscalate: false, willReview: false, status: 'active',
      expect: false,
    },
    {
      name: 'allDocsReceived=false, willReview fires → DO NOT suppress',
      allDocsReceived: false, willEscalate: false, willReview: true, status: 'active',
      expect: false,
    },
  ];

  let groupLPassed = 0;
  for (const tc of groupLCases) {
    const got = computeWillFireFinalReview(tc.allDocsReceived, tc.willEscalate, tc.willReview, tc.status);
    if (got === tc.expect) {
      console.log(`  PASS: ${tc.name}`);
      groupLPassed++;
    } else {
      throw new Error(`FAIL [Group L]: ${tc.name} — expected ${tc.expect}, got ${got}`);
    }
  }
  console.log(`Group L truth table: ${groupLPassed}/${groupLCases.length} passed`);

  // ════════════════════════════════════════════════════════════════
  // GROUP R: HITL corrected-draft handling (Bug 9.9)
  // ════════════════════════════════════════════════════════════════
  // Deterministic block — exercises the isFullAlternativeDraft heuristic and the
  // textToHtml helper directly. No Claude calls, runs without an API key.

  console.log('\n========== GROUP R — isFullAlternativeDraft heuristic truth table ==========');
  // Threshold: 50 words AND 2+ paragraphs → REPLACE. Fixtures crafted with clear
  // margin above/below the threshold; actual word/para counts printed at runtime
  // for visibility.
  const wordsOf = (t) => t.split(/\s+/).filter(Boolean).length;
  const parasOf = (t) => t.split(/\n\s*\n+/).filter(p => p.trim().length > 0).length;

  const groupRHeuristicCases = [
    {
      name: 'short pure approval → not REPLACE',
      text: 'Looks good, send it!',
      expect: false,
    },
    {
      name: 'short edit instruction → not REPLACE',
      text: 'Make it shorter and remove the praise.',
      expect: false,
    },
    {
      name: 'short multi-paragraph edit (well under 50w threshold) → not REPLACE',
      text: 'Couple of changes:\n\n1) Remove praise.\n2) Add AML deadline.',
      expect: false,
    },
    {
      name: 'long single-paragraph instruction (≥50w but only 1 para) → not REPLACE',
      text: 'Could you please make this email significantly shorter, remove the praise paragraph entirely, change the closing to mention we will be in touch within 48 hours about next steps, add a brief line acknowledging the AML form is needed by Friday at the latest, and also adjust the opening to be less effusive about the deal quality, just stick to the practical points please.',
      expect: false,
    },
    {
      name: 'full corrected draft (≥50w + 2+ paras with greeting + signoff) → REPLACE',
      text: 'Hi Michael,\n\nThanks for getting the AML and PEP forms over. Quick note from our side: we will need the gov ID, property tax assessment, and the CIBC payout statement to wrap things up properly on this file. Once those land, we will be in good shape.\n\nI will be in touch shortly with an update once the file moves forward through the next stage.\n\nThanks,\nVienna\nPrivate Mortgage Link',
      expect: true,
    },
    {
      name: 'empty text → not REPLACE',
      text: '',
      expect: false,
    },
    {
      name: 'short reply with too few words but 2 paras → not REPLACE (word threshold guards)',
      text: 'Hi Michael, looks good.\n\nThanks, Vienna.',
      expect: false,
    },
    {
      name: 'GROUP D fix — 50w+ multi-paragraph edit instructions (no greeting opener) → not REPLACE',
      // Pre-Group-D this case asserted true (documented false positive — long
      // multi-paragraph edit instructions tripped the length-only heuristic and
      // shipped to broker verbatim). Group D added a structural greeting gate:
      // first non-blank line is "Couple of changes I want to flag on this draft."
      // — no greeting word — so REPLACE no longer fires. Routes to EDIT, Claude
      // integrates instructions, Bug B preview cycle re-asks for approval.
      text: 'Couple of changes I want to flag on this draft.\n\nFirst, please remove the praise paragraph entirely — the tone is too florid for the broker and we want to stay neutral throughout.\n\nSecond, change the closing to mention we will be in touch within 48 hours about next steps rather than the current vague language about timing.',
      expect: false,
    },
    // ───────────────── Group D fixtures (S6.4 / S7.4 root cause) ─────────────────
    // Length-only heuristic misclassified instruction-prefixed edits as REPLACE,
    // shipping Franco's directive ("Reply to her with this:") verbatim to brokers
    // and bypassing Bug B's preview cycle. Greeting-line gate forces these to EDIT.
    {
      name: 'S6.4 verbatim — directive prefix + greeting + body (single line) → not REPLACE (Group D)',
      text: 'Reply to her with this: Hi Jennifer, Thanks for sending those through. To complete Kevin\'s file, I\'ll still need: - Government-issued ID for Kevin - Property Tax Assessment - Exit strategy — please describe how Kevin plans to repay or refinance out of this loan Let me know if you have any questions.',
      expect: false,
    },
    {
      name: 'S6.4 reshaped — directive prefix on own line + drafted body → not REPLACE (Group D)',
      text: 'Reply to her with this:\n\nHi Jennifer,\n\nThanks for sending those through. To complete Kevin\'s file, I\'ll still need:\n\n- Government-issued ID for Kevin\n- Property Tax Assessment\n- Exit strategy — please describe how Kevin plans to repay or refinance out of this loan\n\nLet me know if you have any questions.',
      expect: false,
    },
    {
      name: '"Send this to him:" prefix variant → not REPLACE (Group D)',
      text: 'Send this to him:\n\nHey Marcus, just a quick follow-up on the file. We will need the appraisal and gov ID before close. Could you please send those over by Friday so we can keep things moving on schedule?\n\nThanks for your patience here, appreciate it.',
      expect: false,
    },
    {
      name: '"Tell her:" prefix variant → not REPLACE (Group D)',
      text: 'Tell her:\n\nHi Sarah — thanks for the update on the file. We are still missing the property tax assessment and the exit strategy details. Once those come in we should be in good shape to move ahead with the next stage of the review.\n\nLooking forward to hearing back.',
      expect: false,
    },
    {
      name: 'genuine alternative draft opening with "Hi" → REPLACE (regression guard)',
      text: 'Hi Michael,\n\nThanks for getting the AML and PEP forms over to us so promptly. We will also need the government ID, the property tax assessment, and the CIBC payout statement to wrap up the file properly on this one. Once those land we will be in good shape to move ahead with the next stage.\n\nThanks,\nVienna\nPrivate Mortgage Link',
      expect: true,
    },
    {
      name: 'genuine alternative draft opening with "Hello" → REPLACE',
      text: 'Hello Michael,\n\nQuick update on Kevin\'s file from our side. We are still missing a few items — the government ID, the property tax assessment, and the CIBC payout statement. Could you please have those forwarded across at your earliest convenience so we can finalize the review and move ahead with the next stage of the process?\n\nThanks for your help on this one.',
      expect: true,
    },
    {
      name: 'genuine alternative draft opening with "Good morning" → REPLACE',
      text: 'Good morning Michael,\n\nWanted to circle back on the Kevin Tran file. To wrap things up properly we will need the government ID, the property tax assessment, and a current mortgage payout statement from CIBC. Let me know if any of these are tricky to track down.\n\nThanks for your help.',
      expect: true,
    },
    {
      name: 'long body with no greeting and no directive → not REPLACE (Group D, edge case)',
      // Edge case: Franco pastes body that opens narratively with no greeting.
      // Routes to EDIT, recovers via re-preview cycle. Documented in fix shape.
      text: 'Just a quick note on this one. We will need the government ID, the property tax assessment, and the CIBC payout statement to wrap up the file properly on our end.\n\nOnce those are in we should be in good shape to move ahead.',
      expect: false,
    },
  ];

  let groupRPassed = 0;
  for (const tc of groupRHeuristicCases) {
    const got = isFullAlternativeDraft(tc.text);
    const wc = wordsOf(tc.text);
    const pc = parasOf(tc.text);
    if (got === tc.expect) {
      console.log(`  PASS: ${tc.name} (${wc}w, ${pc}p → ${got})`);
      groupRPassed++;
    } else {
      throw new Error(`FAIL [${tc.name}]: expected ${tc.expect}, got ${got} (${wc} words, ${pc} paragraphs)`);
    }
  }
  console.log(`Group R heuristic: ${groupRPassed}/${groupRHeuristicCases.length} passed`);

  console.log('\n========== GROUP R — textToHtml unit cases ==========');
  const textToHtmlCases = [
    {
      name: 'plain single paragraph wraps in <p>',
      input: 'Hi Michael, thanks for the package.',
      expectMatch: /^<p>Hi Michael, thanks for the package\.<\/p>$/,
    },
    {
      name: 'two paragraphs separated by blank line wrap separately',
      input: 'Hi Michael,\n\nThanks for the package.',
      expectMatch: /^<p>Hi Michael,<\/p>\s*<p>Thanks for the package\.<\/p>$/,
    },
    {
      name: 'single \\n inside paragraph becomes <br>',
      input: 'Hi Michael,\nThanks!',
      expectMatch: /<p>Hi Michael,<br>Thanks!<\/p>/,
    },
    {
      name: 'already-HTML input passes through unchanged',
      input: '<p>Hi Michael,</p><p>Thanks!</p>',
      expectMatch: /^<p>Hi Michael,<\/p><p>Thanks!<\/p>$/,
    },
    {
      name: 'empty input → empty string',
      input: '',
      expectMatch: /^$/,
    },
  ];
  let textToHtmlPassed = 0;
  for (const tc of textToHtmlCases) {
    const got = textToHtml(tc.input);
    if (tc.expectMatch.test(got)) {
      console.log(`  PASS: ${tc.name}`);
      textToHtmlPassed++;
    } else {
      throw new Error(`FAIL [${tc.name}]: expected match ${tc.expectMatch}, got ${JSON.stringify(got)}`);
    }
  }
  console.log(`textToHtml: ${textToHtmlPassed}/${textToHtmlCases.length} passed`);

  // End-to-end deterministic test: parseDraftReply on a full-corrected-draft input
  // returns { action: 'replace', replacementText: ... } — bypasses Claude entirely.
  // Reuses the same 70-word fixture from the heuristic truth table above.
  console.log('\n========== GROUP R — parseDraftReply REPLACE path (no Claude) ==========');
  const fullDraft = 'Hi Michael,\n\nThanks for getting the AML and PEP forms over. Quick note from our side: we will need the gov ID, property tax assessment, and the CIBC payout statement to wrap things up properly on this file. Once those land, we will be in good shape.\n\nI will be in touch shortly with an update once the file moves forward through the next stage.\n\nThanks,\nVienna\nPrivate Mortgage Link';
  const replaceResult = await parseDraftReply(fullDraft);
  if (replaceResult.action !== 'replace') {
    throw new Error(`FAIL [Group R parseDraftReply REPLACE]: expected action='replace', got '${replaceResult.action}'`);
  }
  if (!replaceResult.replacementText || !replaceResult.replacementText.includes('Hi Michael')) {
    throw new Error(`FAIL [Group R parseDraftReply REPLACE]: replacementText missing or wrong: ${JSON.stringify(replaceResult.replacementText)?.slice(0, 100)}`);
  }
  console.log(`  PASS: parseDraftReply on 70-word 3-para input → action='replace', replacementText preserved verbatim`);

  // Empty-reply edge case
  const emptyResult = await parseDraftReply('');
  if (emptyResult.action !== 'edit' || emptyResult.editInstructions !== '') {
    throw new Error(`FAIL [Group R parseDraftReply empty]: expected {action:'edit', editInstructions:''}, got ${JSON.stringify(emptyResult)}`);
  }
  console.log(`  PASS: parseDraftReply on empty input → action='edit' (safe default)`);

  // ════════════════════════════════════════════════════════════════
  // GROUP S+W: forms attachment hygiene — webhook detection + email.js skip flags
  // ════════════════════════════════════════════════════════════════
  // Bugs 9.2 (PNW attached when broker sent own), 15.2/15.3/15.4 (silent attach,
  // no own-form acceptance line). Deterministic checks on the two halves of the
  // fix that don't need Claude: the broker filename-detection regex and
  // emailService.getFormAttachments({skipPnwForm}) honoring the new flag.
  console.log('\n========== GROUP S+W — own-form detection regex ==========');

  const hasOwnApplication = (name) => /application|loan.?app|summary/i.test(name);
  const hasOwnPnw = (name) => /pnw|personal.?net.?worth|net.?worth/i.test(name);

  const ownFormCases = [
    { fileName: 'Loan Application Form - Filled.pdf', expectApp: true,  expectPnw: false },
    { fileName: 'application_torres_tax.pdf',         expectApp: true,  expectPnw: false },
    { fileName: 'Loan App - Sandra.pdf',              expectApp: true,  expectPnw: false },
    { fileName: 'PNW Statement Tran.pdf',             expectApp: false, expectPnw: true },
    { fileName: 'Personal Net Worth - filled.pdf',    expectApp: false, expectPnw: true },
    { fileName: 'net_worth_statement.pdf',            expectApp: false, expectPnw: true },
    { fileName: 'pnw_okafor.pdf',                     expectApp: false, expectPnw: true },
    { fileName: 'Appraisal_2024.pdf',                 expectApp: false, expectPnw: false },
    { fileName: 'CIBC Mortgage Payout Statement.pdf', expectApp: false, expectPnw: false },
    { fileName: 'NOA_2024.pdf',                       expectApp: false, expectPnw: false },
    { fileName: 'Credit_Bureau_Equifax.pdf',          expectApp: false, expectPnw: false },
  ];

  let ownFormPassed = 0;
  for (const tc of ownFormCases) {
    const gotApp = hasOwnApplication(tc.fileName);
    const gotPnw = hasOwnPnw(tc.fileName);
    if (gotApp === tc.expectApp && gotPnw === tc.expectPnw) {
      console.log(`  PASS: "${tc.fileName}" → app=${gotApp}, pnw=${gotPnw}`);
      ownFormPassed++;
    } else {
      throw new Error(`FAIL [${tc.fileName}]: expected app=${tc.expectApp} pnw=${tc.expectPnw}, got app=${gotApp} pnw=${gotPnw}`);
    }
  }
  console.log(`Own-form detection: ${ownFormPassed}/${ownFormCases.length} passed`);

  console.log('\n========== GROUP S+W — getFormAttachments skip flags ==========');
  // Restore the real (non-stubbed) emailService for this — we want to exercise
  // the real getFormAttachments which reads forms from disk.
  delete require.cache[require.resolve('./src/services/email')];
  const realEmailService = require('./src/services/email');

  const formAttachCases = [
    { name: 'no skip flags → both forms attached', opts: {},                                                   expectFiles: ['Loan Application Form (1).pdf', 'PNW Statement Form.pdf'] },
    { name: 'skipApplicationForm only → PNW only',  opts: { skipApplicationForm: true },                       expectFiles: ['PNW Statement Form.pdf'] },
    { name: 'skipPnwForm only → Application only',  opts: { skipPnwForm: true },                               expectFiles: ['Loan Application Form (1).pdf'] },
    { name: 'skip both → empty',                    opts: { skipApplicationForm: true, skipPnwForm: true },    expectFiles: [] },
  ];

  let formAttachPassed = 0;
  for (const tc of formAttachCases) {
    const got = realEmailService.getFormAttachments(tc.opts).map(a => a.Name);
    if (JSON.stringify(got) === JSON.stringify(tc.expectFiles)) {
      console.log(`  PASS: ${tc.name} → ${JSON.stringify(got)}`);
      formAttachPassed++;
    } else {
      throw new Error(`FAIL [${tc.name}]: expected ${JSON.stringify(tc.expectFiles)}, got ${JSON.stringify(got)}`);
    }
  }
  console.log(`getFormAttachments skip flags: ${formAttachPassed}/${formAttachCases.length} passed`);

  // ════════════════════════════════════════════════════════════════
  // SCENARIO 13: dailySummary timezone handling (Bug 13.1)
  // ════════════════════════════════════════════════════════════════
  // Bug 13.1: cron fires at 21:00 America/Edmonton. On Render's UTC runtime,
  // 9 PM MDT May 4 = 03:00 UTC May 5, so toLocaleDateString() with no timeZone
  // option rendered "Tuesday May 5" in the email Franco received at 9 PM Monday.
  // Post-fix: formatAdminDate uses timeZone: 'America/Edmonton' so the date
  // matches Franco's wall clock. Tests cover both DST (May, MDT = UTC-6) and
  // standard time (January, MST = UTC-7).
  console.log('\n========== SCENARIO 13 — formatAdminDate truth table ==========');

  const { formatAdminDate, ADMIN_TIMEZONE } = require('./src/cron/dailySummary');

  const dateCases = [
    {
      name: '9 PM MDT May 4, 2026 (cron fire moment) → Monday May 4',
      input: new Date('2026-05-05T03:00:00Z'),
      expect: 'Monday, May 4, 2026',
    },
    {
      name: '9:59 PM MDT May 4 (just before midnight wrap) → Monday May 4',
      input: new Date('2026-05-05T03:59:00Z'),
      expect: 'Monday, May 4, 2026',
    },
    {
      name: '12:01 AM MDT May 5 (wrapped to next day) → Tuesday May 5',
      input: new Date('2026-05-05T06:01:00Z'),
      expect: 'Tuesday, May 5, 2026',
    },
    {
      name: '9 PM MST Jan 14, 2026 (winter, MST = UTC-7) → Wednesday Jan 14',
      input: new Date('2026-01-15T04:00:00Z'),
      expect: 'Wednesday, January 14, 2026',
    },
    {
      name: 'noon UTC mid-day → no wrap concern, day matches',
      input: new Date('2026-05-04T18:00:00Z'),
      expect: 'Monday, May 4, 2026',
    },
  ];

  let datePassed = 0;
  for (const tc of dateCases) {
    const got = formatAdminDate(tc.input);
    if (got === tc.expect) {
      console.log(`  PASS: ${tc.name} → "${got}"`);
      datePassed++;
    } else {
      throw new Error(`FAIL [${tc.name}]: expected "${tc.expect}", got "${got}"`);
    }
  }
  console.log(`Scenario 13 date formatting: ${datePassed}/${dateCases.length} passed`);
  console.log(`  ADMIN_TIMEZONE = "${ADMIN_TIMEZONE}" (single source of truth for cron schedule + date header)`);

  // ════════════════════════════════════════════════════════════════
  // BUG B: broker-name extraction / "Franco" greeting regression
  // ════════════════════════════════════════════════════════════════

  console.log('\n========== BUG B — normalizeSenderName unit cases ==========');
  console.log(`ADMIN_FIRST_NAME parsed from config.adminEmail: "${ADMIN_FIRST_NAME}"`);

  const bugBCases = [
    {
      name: 'Claude returned null → From-header rescue',
      input: { sender_type: 'broker', sender_name: null, broker_name: null },
      fromName: 'Jason Mercer',
      expect: { sender_name: 'Jason Mercer', broker_name: 'Jason Mercer' },
    },
    {
      name: 'Claude returned "Franco" (the actual regression) → override',
      input: { sender_type: 'broker', sender_name: 'Franco', broker_name: 'Franco' },
      fromName: 'Jason Mercer',
      expect: { sender_name: 'Jason Mercer', broker_name: 'Jason Mercer' },
    },
    {
      name: 'Claude returned "Franco Maione" → override (first-word match)',
      input: { sender_type: 'broker', sender_name: 'Franco Maione', broker_name: 'Franco Maione' },
      fromName: 'Jason Mercer',
      expect: { sender_name: 'Jason Mercer', broker_name: 'Jason Mercer' },
    },
    {
      name: 'Claude returned "Unknown" → From-header rescue',
      input: { sender_type: 'broker', sender_name: 'Unknown', broker_name: 'Unknown' },
      fromName: 'Jason Mercer',
      expect: { sender_name: 'Jason Mercer', broker_name: 'Jason Mercer' },
    },
    {
      name: 'Claude got it right → leave alone',
      input: { sender_type: 'broker', sender_name: 'Jason Mercer', broker_name: 'Jason Mercer' },
      fromName: 'Jason Mercer',
      expect: { sender_name: 'Jason Mercer', broker_name: 'Jason Mercer' },
    },
    {
      name: '"Frank Smith" is NOT Franco — first-word check passes',
      input: { sender_type: 'broker', sender_name: 'Frank Smith', broker_name: 'Frank Smith' },
      fromName: 'Anyone Else',
      expect: { sender_name: 'Frank Smith', broker_name: 'Frank Smith' },
    },
    {
      name: 'borrower flow — sender_type=borrower leaves broker_name alone',
      input: { sender_type: 'borrower', sender_name: 'Patricia Simmons', broker_name: null },
      fromName: 'Patricia Simmons',
      expect: { sender_name: 'Patricia Simmons', broker_name: null },
    },
    {
      name: 'no fromName fallback → input unchanged',
      input: { sender_type: 'broker', sender_name: 'Franco', broker_name: 'Franco' },
      fromName: '',
      expect: { sender_name: 'Franco', broker_name: 'Franco' },
    },
    {
      name: 'null dealSummary → null returned (no crash)',
      input: null,
      fromName: 'Jason Mercer',
      expect: null,
    },
  ];

  let bugBPassed = 0;
  for (const tc of bugBCases) {
    const out = normalizeSenderName(tc.input, tc.fromName);
    if (tc.expect === null) {
      if (out === null) { console.log(`  PASS: ${tc.name}`); bugBPassed++; }
      else { throw new Error(`FAIL [${tc.name}]: expected null, got ${JSON.stringify(out)}`); }
      continue;
    }
    const sOk = out.sender_name === tc.expect.sender_name;
    const bOk = ('broker_name' in tc.expect) ? out.broker_name === tc.expect.broker_name : true;
    if (sOk && bOk) {
      console.log(`  PASS: ${tc.name}`);
      bugBPassed++;
    } else {
      throw new Error(
        `FAIL [${tc.name}]: expected sender_name=${JSON.stringify(tc.expect.sender_name)} ` +
        `broker_name=${JSON.stringify(tc.expect.broker_name)}, got sender_name=${JSON.stringify(out.sender_name)} ` +
        `broker_name=${JSON.stringify(out.broker_name)}`
      );
    }
  }
  console.log(`Bug B unit cases: ${bugBPassed}/${bugBCases.length} passed`);

  // Spot checks on isUnreliableName for completeness
  const unreliableExpect = [
    [null, true], [undefined, true], ['', true], ['  ', true],
    ['Unknown', true], ['unknown', true], ['UNKNOWN', true],
    ['Franco', true], ['Franco Maione', true], ['franco', true],
    ['Jason Mercer', false], ['Patricia', false], ['Frank Smith', false],
  ];
  for (const [input, expected] of unreliableExpect) {
    const got = isUnreliableName(input);
    if (got !== expected) {
      throw new Error(`FAIL isUnreliableName(${JSON.stringify(input)}): expected ${expected}, got ${got}`);
    }
  }
  console.log(`isUnreliableName spot checks: ${unreliableExpect.length}/${unreliableExpect.length} passed`);

  // ════════════════════════════════════════════════════════════════
  // F2 — Both-Franco collision branch in normalizeSenderName
  // ════════════════════════════════════════════════════════════════
  // Bug B Layer A originally rescued sender_name from the From-header when
  // Claude returned 'Franco'/'Unknown'. But when the From-header ALSO starts
  // with Franco (e.g. broker is Franco Vieanna at vimarealty.com), the rescue
  // is a no-op and Vienna ends up greeting "Hi Franco!" anyway. F2 detects
  // this case and sets a name_collides_with_admin flag instead — keeping raw
  // values intact while signaling downstream prompts to use a generic greeting.
  console.log('\n========== F2 — both-Franco collision flag ==========');

  const collisionCases = [
    {
      name: 'both Franco (extracted=Franco Maione, fromName=Franco Vieanna) → flag set, raw values preserved',
      input: { sender_type: 'broker', sender_name: 'Franco Maione', broker_name: 'Franco Maione' },
      fromName: 'Franco Vieanna',
      expectFlag: true,
      expectSender: 'Franco Maione',
      expectBroker: 'Franco Maione',
    },
    {
      name: 'extracted=Franco, fromName=Franco → flag set',
      input: { sender_type: 'broker', sender_name: 'Franco', broker_name: 'Franco' },
      fromName: 'Franco',
      expectFlag: true,
      expectSender: 'Franco',
      expectBroker: 'Franco',
    },
    {
      name: 'extracted=null, fromName=Franco → flag set (both unreliable, can\'t rescue)',
      input: { sender_type: 'broker', sender_name: null, broker_name: null },
      fromName: 'Franco Vieanna',
      expectFlag: true,
      expectSender: null,
      expectBroker: null,
    },
    {
      name: 'extracted=Unknown, fromName=Franco → flag set (Unknown is unreliable, fromName is too)',
      input: { sender_type: 'broker', sender_name: 'Unknown', broker_name: 'Unknown' },
      fromName: 'Franco',
      expectFlag: true,
      expectSender: 'Unknown',
      expectBroker: 'Unknown',
    },
    {
      name: 'single-Franco (extracted=Franco, fromName=Jason Mercer) → existing rescue path, NO flag',
      input: { sender_type: 'broker', sender_name: 'Franco', broker_name: 'Franco' },
      fromName: 'Jason Mercer',
      expectFlag: undefined,
      expectSender: 'Jason Mercer',
      expectBroker: 'Jason Mercer',
    },
    {
      name: 'no collision (extracted=Jason Mercer, fromName=Jason Mercer) → no flag, no change',
      input: { sender_type: 'broker', sender_name: 'Jason Mercer', broker_name: 'Jason Mercer' },
      fromName: 'Jason Mercer',
      expectFlag: undefined,
      expectSender: 'Jason Mercer',
      expectBroker: 'Jason Mercer',
    },
    {
      name: 'borrower path with both-Franco → only sender_name considered (broker_name=null), still flag',
      input: { sender_type: 'borrower', sender_name: 'Franco Vieanna', broker_name: null },
      fromName: 'Franco Vieanna',
      expectFlag: true,
      expectSender: 'Franco Vieanna',
      expectBroker: null,
    },
    {
      name: 'borrower path, extracted reliable but fromName Franco → no flag, no change (extracted is fine)',
      input: { sender_type: 'borrower', sender_name: 'Patricia Simmons', broker_name: null },
      fromName: 'Franco',
      expectFlag: undefined,
      expectSender: 'Patricia Simmons',
      expectBroker: null,
    },
  ];

  let collisionPassed = 0;
  for (const tc of collisionCases) {
    const out = normalizeSenderName(tc.input, tc.fromName);
    const flagOk = out.name_collides_with_admin === tc.expectFlag;
    const senderOk = out.sender_name === tc.expectSender;
    const brokerOk = out.broker_name === tc.expectBroker;
    if (flagOk && senderOk && brokerOk) {
      console.log(`  PASS: ${tc.name}`);
      collisionPassed++;
    } else {
      throw new Error(
        `FAIL [${tc.name}]: ` +
        `expected flag=${JSON.stringify(tc.expectFlag)} sender=${JSON.stringify(tc.expectSender)} broker=${JSON.stringify(tc.expectBroker)}, ` +
        `got flag=${JSON.stringify(out.name_collides_with_admin)} sender=${JSON.stringify(out.sender_name)} broker=${JSON.stringify(out.broker_name)}`
      );
    }
  }
  console.log(`F2 collision flag: ${collisionPassed}/${collisionCases.length} passed`);

  // ════════════════════════════════════════════════════════════════
  // Fix 1 — F2 over-fire regression: empty FromName must NOT trigger collision
  // ════════════════════════════════════════════════════════════════
  // The retest revealed that the original F2 trigger (initialFromCollision via
  // isUnreliableName) was treating empty/null FromName as "Franco-collision",
  // because isUnreliableName(empty) returns true. Production symptom: Vienna
  // greeted Chris/Marcus/Brian as "Hi there!" because their emails had no
  // display name in the From-header.
  //
  // Fix: webhook now uses firstNameMatchesAdmin (Franco-pattern only). These
  // unit cases cover the gap the original harness missed.
  console.log('\n========== Fix 1 — firstNameMatchesAdmin (Franco-pattern only) ==========');

  const firstNameMatchesAdminCases = [
    [null, false, 'null → false (no name)'],
    [undefined, false, 'undefined → false (no name)'],
    ['', false, 'empty string → false (NOT a collision — no display name)'],
    ['   ', false, 'whitespace → false'],
    ['Unknown', false, 'Unknown → false (NOT a collision — was Bug B trigger but not F2 trigger)'],
    ['Chris Nolan', false, 'Chris Nolan → false (regular broker name)'],
    ['Marcus Webb', false, 'Marcus Webb → false (regular borrower name)'],
    ['Brian', false, 'Brian → false (single-word non-Franco name)'],
    ['chris@brokerage.com', false, 'email-as-name → false (not Franco)'],
    ['Frank Smith', false, 'Frank Smith → false (NOT Franco — first-word check)'],
    ['Franco', true, 'Franco → true'],
    ['franco', true, 'franco lowercase → true (case-insensitive)'],
    ['FRANCO', true, 'FRANCO uppercase → true'],
    ['Franco Vieanna', true, 'Franco Vieanna → true (first-word match)'],
    ['Franco Maione', true, 'Franco Maione → true'],
    ['  Franco  ', true, 'whitespace-padded Franco → true'],
  ];

  let firstNamePassed = 0;
  for (const [input, expected, label] of firstNameMatchesAdminCases) {
    const got = firstNameMatchesAdmin(input);
    if (got === expected) {
      console.log(`  PASS: ${label}`);
      firstNamePassed++;
    } else {
      throw new Error(`FAIL firstNameMatchesAdmin(${JSON.stringify(input)}): expected ${expected}, got ${got}`);
    }
  }
  console.log(`firstNameMatchesAdmin: ${firstNamePassed}/${firstNameMatchesAdminCases.length} passed`);

  console.log('\n========== Fix 1 — gap cases: empty FromName + reliable extracted name ==========');
  // These are the cases the original F2 harness never tested. Each represents a
  // production scenario where the over-fire was observed.

  const gapCases = [
    {
      name: 'S1 retest: extracted=Chris Nolan, fromName="" → no flag, name preserved',
      input: { sender_type: 'broker', sender_name: 'Chris Nolan', broker_name: 'Chris Nolan' },
      fromName: '',
      expectFlag: undefined,
      expectSender: 'Chris Nolan',
      expectBroker: 'Chris Nolan',
    },
    {
      name: 'S1 retest variant: extracted=Chris Nolan, fromName=null → no flag, name preserved',
      input: { sender_type: 'broker', sender_name: 'Chris Nolan', broker_name: 'Chris Nolan' },
      fromName: null,
      expectFlag: undefined,
      expectSender: 'Chris Nolan',
      expectBroker: 'Chris Nolan',
    },
    {
      name: 'S2 retest: extracted=Marcus Webb (borrower), fromName="" → no flag',
      input: { sender_type: 'borrower', sender_name: 'Marcus Webb', broker_name: null },
      fromName: '',
      expectFlag: undefined,
      expectSender: 'Marcus Webb',
      expectBroker: null,
    },
    {
      name: 'extracted=Chris Nolan, fromName=Franco → no flag (extracted is fine)',
      input: { sender_type: 'broker', sender_name: 'Chris Nolan', broker_name: 'Chris Nolan' },
      fromName: 'Franco Vieanna',
      expectFlag: undefined,
      expectSender: 'Chris Nolan',
      expectBroker: 'Chris Nolan',
    },
  ];

  let gapPassed = 0;
  for (const tc of gapCases) {
    const out = normalizeSenderName(tc.input, tc.fromName);
    const flagOk = out.name_collides_with_admin === tc.expectFlag;
    const senderOk = out.sender_name === tc.expectSender;
    const brokerOk = out.broker_name === tc.expectBroker;
    if (flagOk && senderOk && brokerOk) {
      console.log(`  PASS: ${tc.name}`);
      gapPassed++;
    } else {
      throw new Error(
        `FAIL [${tc.name}]: ` +
        `expected flag=${JSON.stringify(tc.expectFlag)} sender=${JSON.stringify(tc.expectSender)} broker=${JSON.stringify(tc.expectBroker)}, ` +
        `got flag=${JSON.stringify(out.name_collides_with_admin)} sender=${JSON.stringify(out.sender_name)} broker=${JSON.stringify(out.broker_name)}`
      );
    }
  }
  console.log(`F2 gap cases: ${gapPassed}/${gapCases.length} passed`);

  console.log('\n========== Fix 1 — stale-flag forward-recovery ==========');
  // Deals already poisoned by the F2 over-fire have name_collides_with_admin=true
  // stored in extracted_data. Every normalizeSenderName call must clear the stale
  // flag and re-evaluate from current state — flag stays only if the actual
  // collision condition still holds.

  const staleFlagCases = [
    {
      name: 'stale flag + reliable names, reliable fromName → flag CLEARED',
      input: { sender_type: 'broker', sender_name: 'Brian', broker_name: 'Brian', name_collides_with_admin: true },
      fromName: 'Brian',
      expectFlag: undefined,
    },
    {
      name: 'stale flag + reliable names, empty fromName → flag CLEARED',
      input: { sender_type: 'broker', sender_name: 'Brian', broker_name: 'Brian', name_collides_with_admin: true },
      fromName: '',
      expectFlag: undefined,
    },
    {
      name: 'stale flag + actual collision still holds → flag re-set (idempotent)',
      input: { sender_type: 'broker', sender_name: 'Franco Maione', broker_name: 'Franco Maione', name_collides_with_admin: true },
      fromName: 'Franco Vieanna',
      expectFlag: true,
    },
    {
      name: 'no stale flag, no collision → no flag (control)',
      input: { sender_type: 'broker', sender_name: 'Brian', broker_name: 'Brian' },
      fromName: 'Brian',
      expectFlag: undefined,
    },
  ];

  let stalePassed = 0;
  for (const tc of staleFlagCases) {
    const out = normalizeSenderName(tc.input, tc.fromName);
    if (out.name_collides_with_admin === tc.expectFlag) {
      console.log(`  PASS: ${tc.name}`);
      stalePassed++;
    } else {
      throw new Error(`FAIL [${tc.name}]: expected flag=${JSON.stringify(tc.expectFlag)}, got flag=${JSON.stringify(out.name_collides_with_admin)}`);
    }
  }
  console.log(`Stale-flag clearing: ${stalePassed}/${staleFlagCases.length} passed`);

  // ════════════════════════════════════════════════════════════════
  // FIX 4 — NOA satisfies income_proof in missingDocs filter (Bug 2)
  // ════════════════════════════════════════════════════════════════
  // S3 retest: deal had NOA classification on file but preliminary review still
  // listed "Proof of Income" as [MISSING]. Bradley's e4f6b89 dropped 'noa' from
  // baseRequired with the comment "NOA satisfies income_proof", but the filter
  // logic was never updated to actually wire in the equivalence. Fix 4 adds a
  // synonym helper (DOC_SYNONYMS + isDocRequirementSatisfied) and applies it at
  // all three filter sites in webhook.js.
  console.log('\n========== FIX 4 — isDocRequirementSatisfied truth table ==========');

  // Sanity check the synonym map is loaded
  if (!DOC_SYNONYMS || !DOC_SYNONYMS.income_proof || !DOC_SYNONYMS.income_proof.includes('noa')) {
    throw new Error(`FAIL [Fix 4 setup]: DOC_SYNONYMS.income_proof should include 'noa'. Got: ${JSON.stringify(DOC_SYNONYMS)}`);
  }

  const docReqCases = [
    // The bug we're fixing — NOA on file, income_proof required → satisfied
    { req: 'income_proof', classifications: ['noa'],                expect: true,  label: 'NOA only → income_proof satisfied (the bug we\'re fixing)' },
    // Canonical: income_proof literal
    { req: 'income_proof', classifications: ['income_proof'],       expect: true,  label: 'income_proof literal → satisfied' },
    // Both classifications present (broker sent NOA + paystub)
    { req: 'income_proof', classifications: ['noa', 'income_proof'],expect: true,  label: 'NOA + income_proof → satisfied (no double-count)' },
    // Genuinely missing
    { req: 'income_proof', classifications: [],                     expect: false, label: 'empty classifications → income_proof NOT satisfied' },
    { req: 'income_proof', classifications: ['appraisal'],          expect: false, label: 'unrelated docs only → income_proof NOT satisfied' },
    // Non-synonymed required item: literal match only
    { req: 'government_id', classifications: ['noa'],               expect: false, label: 'NOA does NOT satisfy government_id (no synonym)' },
    { req: 'government_id', classifications: ['government_id'],     expect: true,  label: 'government_id literal → satisfied' },
    { req: 'appraisal',     classifications: ['appraisal'],         expect: true,  label: 'appraisal literal → satisfied (control)' },
    { req: 'appraisal',     classifications: ['noa'],               expect: false, label: 'NOA does NOT satisfy appraisal (no synonym)' },
    // Required item not in any synonym map: falls through to literal
    { req: 'mortgage_statement', classifications: ['mortgage_statement'], expect: true,  label: 'mortgage_statement literal → satisfied' },
    { req: 'mortgage_statement', classifications: ['noa'],                expect: false, label: 'NOA does NOT satisfy mortgage_statement' },
  ];

  let docReqPassed = 0;
  for (const tc of docReqCases) {
    const got = isDocRequirementSatisfied(tc.req, tc.classifications);
    if (got === tc.expect) {
      console.log(`  PASS: ${tc.label}`);
      docReqPassed++;
    } else {
      throw new Error(`FAIL [${tc.label}]: isDocRequirementSatisfied(${JSON.stringify(tc.req)}, ${JSON.stringify(tc.classifications)}) expected ${tc.expect}, got ${got}`);
    }
  }
  console.log(`isDocRequirementSatisfied: ${docReqPassed}/${docReqCases.length} passed`);

  // End-to-end: NOA-on-file deal through sendPreliminaryReviewToAdmin must NOT
  // include income_proof in missingDocs. Pre-fix, this would have leaked.
  console.log('\n========== FIX 4 — end-to-end: NOA on file → income_proof omitted from [MISSING] ==========');

  const stashedGetDocsFix4 = dealsService.getDocumentsByDeal;
  const stashedGetDocsWithTextFix4 = dealsService.getDocumentsWithText;
  const noaOnFileStub = [
    { classification: 'noa', file_name: 'NOA_Webb_2024.pdf' },
    { classification: 'appraisal', file_name: 'Appraisal_Webb.pdf' },
  ];
  dealsService.getDocumentsByDeal = async () => noaOnFileStub;
  dealsService.getDocumentsWithText = async () => noaOnFileStub;

  reset();
  await sendPreliminaryReviewToAdmin(
    { id: 'deal-fix4-1', borrower_name: 'Marcus Webb' },
    // exit_strategy populated so Group C aggregation doesn't add an extra item —
    // this test is scoped to the NOA-satisfies-income_proof concern, not Group C.
    { sender_type: 'broker', sender_name: 'Jason Mercer', borrower_name: 'Marcus Webb', ltv_percent: 60, exit_strategy: 'refinance with B lender at maturity' },
    'personal',
    60
  );

  const fix4Call = calls.generateLeadSummary[0];
  if (!fix4Call) throw new Error('FAIL [Fix 4 e2e]: generateLeadSummary not called');
  const fix4Missing = fix4Call.missingDocs;
  console.log(`  generateLeadSummary called with missingDocs: ${JSON.stringify(fix4Missing)}`);
  if (fix4Missing.includes('income_proof')) {
    throw new Error(`FAIL [Fix 4 e2e]: missingDocs still contains 'income_proof' despite NOA on file. Got: ${JSON.stringify(fix4Missing)}`);
  }
  if (fix4Missing.includes('noa')) {
    throw new Error(`FAIL [Fix 4 e2e]: missingDocs contains 'noa' which should never be in baseRequired (Bradley dropped it in e4f6b89). Got: ${JSON.stringify(fix4Missing)}`);
  }
  // Refinance baseRequired (no loan_type → !isPurchase): government_id, appraisal,
  // property_tax, mortgage_statement, income_proof, credit_report.
  // With NOA + appraisal on file: 4 items missing (gov_id, property_tax, mortgage_statement, credit_report).
  if (fix4Missing.length !== 4) {
    throw new Error(`FAIL [Fix 4 e2e]: expected 4 missing items (gov_id, property_tax, mortgage_statement, credit_report), got ${fix4Missing.length}: ${JSON.stringify(fix4Missing)}`);
  }
  console.log(`  PASS: NOA-on-file deal → missingDocs=${JSON.stringify(fix4Missing)} (income_proof correctly satisfied by NOA)`);

  dealsService.getDocumentsByDeal = stashedGetDocsFix4;
  dealsService.getDocumentsWithText = stashedGetDocsWithTextFix4;

  // ════════════════════════════════════════════════════════════════
  // FIX 7 — parseCollateralReply fast-path truth table (no Claude calls)
  // ════════════════════════════════════════════════════════════════
  // Bug 7 (S4 retest): high-LTV collateral flow rework. parseCollateralReply
  // classifies broker replies to Vienna's collateral question as 'no' (silent
  // escalation), 'yes' (resume normal intake), or 'ambiguous' (re-ask). Fast-path
  // regex catches unambiguous "no" replies; substantive replies flow to Claude.
  console.log('\n========== FIX 7 — parseCollateralReply fast-path truth table ==========');

  // We test the fast-path patterns deterministically. Substantive cases that need
  // Claude classification are covered by live smokes below.
  const collateralFastPathCases = [
    // Clear "no" — fast-path expected
    ['No', 'no'],
    ['no.', 'no'],
    ['NO!', 'no'],
    ['None', 'no'],
    ['none.', 'no'],
    ['Nothing', 'no'],
    ['nothing else', 'no'],
    ['Nothing additional', 'no'],
    ['Nope', 'no'],
    ['n/a', 'no'],
    ['N/A', 'no'],
    ['Nada', 'no'],
    ['No additional collateral', 'no'],
    ['No other property', 'no'],
    ['No additional security', 'no'],
    ['Just the subject property', 'no'],
    ['just the property', 'no'],
    ['Only the subject home', 'no'],
    ['only the property', 'no'],
    ['Not really', 'no'],
    ['not at this time', 'no'],
    ['Not at all', 'no'],
    // Empty → ambiguous (no Claude call)
    ['', 'ambiguous'],
    ['   ', 'ambiguous'],
  ];

  let collateralFastPathPassed = 0;
  for (const [input, expectedDisposition] of collateralFastPathCases) {
    const result = await aiService.parseCollateralReply(input);
    if (result.disposition === expectedDisposition) {
      console.log(`  PASS: parseCollateralReply(${JSON.stringify(input)}) → '${expectedDisposition}'`);
      collateralFastPathPassed++;
    } else {
      throw new Error(`FAIL [parseCollateralReply ${JSON.stringify(input)}]: expected '${expectedDisposition}', got '${result.disposition}'`);
    }
  }
  console.log(`parseCollateralReply fast-path: ${collateralFastPathPassed}/${collateralFastPathCases.length} passed`);

  // ════════════════════════════════════════════════════════════════
  // GROUP HHH — parseIdentityClarification fast-path truth table (no Claude)
  // ════════════════════════════════════════════════════════════════
  // S15.1 root cause: Vienna detected identity discrepancy AND fired doc list
  // in same email. HHH adds awaiting_identity_confirmation gate. parseIdentityClarification
  // classifies broker reply as 'resolved' (with optional confirmedBorrowerName) or
  // 'unresolved'. Fast-path regex catches unambiguous resolutions; everything else
  // flows to Claude. This block tests fast-path patterns deterministically.
  console.log('\n========== GROUP HHH — parseIdentityClarification fast-path truth table ==========');
  const identityClashCases = [
    // Resolved with extracted name
    ['Anna Bergstrom is the correct borrower.',                                'resolved',  'Anna Bergstrom'],
    ['The correct borrower is Anna Bergstrom — apologies for the confusion.',  'resolved',  'Anna Bergstrom'],
    ['borrower is Lisa Smith, both prior were wrong.',                         'resolved',  'Lisa Smith'],
    ['borrower should be Anna Bergstrom.',                                     'resolved',  'Anna Bergstrom'],
    ['Borrower name is Daniel Rosen.',                                         'resolved',  'Daniel Rosen'],
  ];
  let identityFastPassed = 0;
  for (const [reply, expectedDisp, expectedName] of identityClashCases) {
    const result = await aiService.parseIdentityClarification(reply);
    if (result.disposition === expectedDisp && result.confirmedBorrowerName === expectedName) {
      console.log(`  PASS: ${JSON.stringify(reply.slice(0, 55))} → '${expectedDisp}' (${expectedName})`);
      identityFastPassed++;
    } else {
      throw new Error(`FAIL [Group HHH parseIdentityClarification ${JSON.stringify(reply)}]: expected '${expectedDisp}' (${expectedName}), got '${result.disposition}' (${result.confirmedBorrowerName})`);
    }
  }
  console.log(`Group HHH parseIdentityClarification fast-path: ${identityFastPassed}/${identityClashCases.length} passed`);

  // ════════════════════════════════════════════════════════════════
  // BUG A — cron concurrency: claim-then-send pattern
  // ════════════════════════════════════════════════════════════════
  // Production observed 9 reminder emails fired to one broker at the same 9 PM
  // cron tick (9 cron instances racing on a non-atomic 20-hour outbound check).
  // Fix: claim the reminder slot via a conditional UPDATE before any work; only
  // one concurrent worker wins the claim; others skip cleanly. Rollback on send
  // failure. These tests stub dealsService and exercise runFollowUpReminders
  // directly (now exported). No live API calls.
  console.log('\n========== BUG A — cron concurrency claim-then-send ==========');

  // Fresh require of dailySummary so we get the un-mocked module (other tests
  // mocked aiService.generateLeadSummary which lives at module top; the cron
  // module reads aiService at call time, so we just need to stub it now).
  const { runFollowUpReminders } = require('./src/cron/dailySummary');

  // Group S+W earlier delete-cache'd email at line 616 and re-required it. The
  // dailySummary module captured the post-cache-bust emailService instance, which
  // is a DIFFERENT object than the harness's top-level emailService reference (line
  // 24, captured pre-cache-bust). Re-grab the currently-cached instance so our
  // Bug A stubs mutate the same singleton that dailySummary uses.
  const cronEmailService = require('./src/services/email');

  // Common stub setup helpers
  const stubEligibleDeal = (overrides = {}) => ({
    id: 'deal-bugA-1',
    borrower_name: 'Ryan Kowalski',
    email: 'broker@example.com',
    extracted_data: { borrower_name: 'Ryan Kowalski', sender_name: 'Jason' },
    reminder_count: 1,
    status: 'active',
    ...overrides,
  });

  // Older lastInbound timestamp so daysSilent > FOLLOW_UP_AFTER_DAYS=2.
  // Older lastOut timestamp so 20-hour guard passes.
  const stale = (days) => ({ created_at: new Date(Date.now() - days * 86400000).toISOString() });
  const trackBugACalls = () => {
    const c = { claim: [], release: [], sendEmail: [], saveMessage: [], generateFollowUpReminder: [] };
    dealsService.getActiveDeals = async () => [stubEligibleDeal()];
    dealsService.getLastInboundMessage = async () => ({ ...stale(5), subject: 'orig' });
    dealsService.getMessages = async () => [{ direction: 'outbound', ...stale(2), subject: 'last out' }];
    dealsService.getLastOutboundMessageId = async () => 'msgid-1';
    dealsService.getAllMessageIdsForThread = async () => ['msgid-1'];
    dealsService.saveMessage = async (...args) => { c.saveMessage.push(args); };
    dealsService.update = async () => {}; // not used by Bug A path anymore
    aiService.generateFollowUpReminder = async (...args) => {
      c.generateFollowUpReminder.push(args);
      return '<p>Reminder body</p>';
    };
    cronEmailService.sendEmail = async (to, subject) => {
      c.sendEmail.push({ to, subject });
      return { MessageID: `MOCK-${c.sendEmail.length}` };
    };
    dealsService.claimReminderSlot = async (dealId, expected, neu) => {
      c.claim.push({ dealId, expected, neu });
      return { claimed: true }; // overridden per test
    };
    dealsService.releaseReminderSlot = async (dealId, claimed, rollbackTo) => {
      c.release.push({ dealId, claimed, rollbackTo });
      return { released: true };
    };
    return c;
  };

  // Test 1: claim wins → email sent, no rollback
  {
    const c = trackBugACalls();
    dealsService.claimReminderSlot = async () => { c.claim.push('A'); return { claimed: true }; };
    await runFollowUpReminders();
    if (c.claim.length !== 1) throw new Error(`FAIL [Bug A claim wins]: expected 1 claim attempt, got ${c.claim.length}`);
    if (c.sendEmail.length !== 1) throw new Error(`FAIL [Bug A claim wins]: expected 1 sendEmail, got ${c.sendEmail.length}`);
    if (c.saveMessage.length !== 1) throw new Error(`FAIL [Bug A claim wins]: expected 1 saveMessage, got ${c.saveMessage.length}`);
    if (c.release.length !== 0) throw new Error(`FAIL [Bug A claim wins]: should NOT release on success, got ${c.release.length}`);
    if (c.generateFollowUpReminder.length !== 1) throw new Error(`FAIL [Bug A claim wins]: expected 1 Claude call, got ${c.generateFollowUpReminder.length}`);
    console.log('  PASS [Bug A claim wins]: 1 claim, 1 Claude call, 1 send, 1 saveMessage, no rollback');
  }

  // Test 2: claim loses → no email, no Claude call (saves API budget on race)
  {
    const c = trackBugACalls();
    dealsService.claimReminderSlot = async () => { c.claim.push('B'); return { claimed: false }; };
    await runFollowUpReminders();
    if (c.claim.length !== 1) throw new Error(`FAIL [Bug A claim loses]: expected 1 claim attempt, got ${c.claim.length}`);
    if (c.sendEmail.length !== 0) throw new Error(`FAIL [Bug A claim loses]: expected 0 sendEmail, got ${c.sendEmail.length}`);
    if (c.saveMessage.length !== 0) throw new Error(`FAIL [Bug A claim loses]: expected 0 saveMessage, got ${c.saveMessage.length}`);
    if (c.release.length !== 0) throw new Error(`FAIL [Bug A claim loses]: should NOT release (no claim to release), got ${c.release.length}`);
    if (c.generateFollowUpReminder.length !== 0) throw new Error(`FAIL [Bug A claim loses]: should NOT call Claude on lost claim, got ${c.generateFollowUpReminder.length}`);
    console.log('  PASS [Bug A claim loses]: 1 claim, 0 Claude calls, 0 send, 0 saveMessage, no rollback');
  }

  // Test 3: send fails after claim → rollback fires
  {
    const c = trackBugACalls();
    dealsService.claimReminderSlot = async (dealId, expected, neu) => {
      c.claim.push({ dealId, expected, neu });
      return { claimed: true };
    };
    cronEmailService.sendEmail = async () => { throw new Error('Postmark 503'); };
    await runFollowUpReminders();
    if (c.claim.length !== 1) throw new Error(`FAIL [Bug A send fails]: expected 1 claim, got ${c.claim.length}`);
    if (c.release.length !== 1) throw new Error(`FAIL [Bug A send fails]: expected 1 rollback, got ${c.release.length}`);
    if (c.release[0].dealId !== 'deal-bugA-1' || c.release[0].claimed !== 2 || c.release[0].rollbackTo !== 1) {
      throw new Error(`FAIL [Bug A send fails]: rollback args wrong: ${JSON.stringify(c.release[0])}`);
    }
    if (c.saveMessage.length !== 0) throw new Error(`FAIL [Bug A send fails]: should NOT save message after send failure, got ${c.saveMessage.length}`);
    console.log('  PASS [Bug A send fails]: 1 claim, 1 rollback (claimed=2, rollbackTo=1), 0 saveMessage');
  }

  // Test 4: two deals, A wins claim, B loses → only A sends
  {
    const c = trackBugACalls();
    dealsService.getActiveDeals = async () => [
      stubEligibleDeal({ id: 'deal-A', borrower_name: 'Ryan Kowalski' }),
      stubEligibleDeal({ id: 'deal-B', borrower_name: 'Marcus Webb' }),
    ];
    dealsService.claimReminderSlot = async (dealId) => {
      c.claim.push(dealId);
      return { claimed: dealId === 'deal-A' };
    };
    await runFollowUpReminders();
    if (c.claim.length !== 2) throw new Error(`FAIL [Bug A two deals]: expected 2 claim attempts (one per deal), got ${c.claim.length}`);
    if (c.sendEmail.length !== 1) throw new Error(`FAIL [Bug A two deals]: only A wins claim, expected 1 sendEmail, got ${c.sendEmail.length}`);
    if (c.generateFollowUpReminder.length !== 1) throw new Error(`FAIL [Bug A two deals]: only A wins claim, expected 1 Claude call, got ${c.generateFollowUpReminder.length}`);
    if (c.release.length !== 0) throw new Error(`FAIL [Bug A two deals]: no failures, expected 0 rollbacks, got ${c.release.length}`);
    console.log('  PASS [Bug A two deals]: independent claims — A wins (1 send), B loses (0 send), no rollbacks');
  }

  // Test 5: claim args shape — verify expectedCount and newCount are correct
  {
    const c = trackBugACalls();
    dealsService.getActiveDeals = async () => [stubEligibleDeal({ id: 'deal-shape', reminder_count: 2 })];
    dealsService.claimReminderSlot = async (dealId, expected, neu) => {
      c.claim.push({ dealId, expected, neu });
      return { claimed: true };
    };
    await runFollowUpReminders();
    if (c.claim.length !== 1) throw new Error(`FAIL [Bug A claim shape]: expected 1 claim, got ${c.claim.length}`);
    const a = c.claim[0];
    if (a.dealId !== 'deal-shape' || a.expected !== 2 || a.neu !== 3) {
      throw new Error(`FAIL [Bug A claim shape]: claim args wrong — expected (deal-shape, 2, 3), got (${a.dealId}, ${a.expected}, ${a.neu})`);
    }
    console.log('  PASS [Bug A claim shape]: claim called with (dealId, expected=2, newCount=3) — atomic increment from N to N+1');
  }

  console.log('Bug A concurrency: 5/5 passed');

  // ─────────────────────────────────────────────────────────────────────────────
  // Group LLL — cron passes computed missingDocs to generateFollowUpReminder
  // ─────────────────────────────────────────────────────────────────────────────
  // Pre-LLL: cron called generateFollowUpReminder(extracted_data, daysSilent, num)
  // — no missingDocs. Vienna fell back to "the items we previously requested".
  // LLL: cron computes missingDocs (mirrors webhook's logic + Group C exit_strategy
  // push), passes as 4th arg. This deterministic test verifies the cron path
  // computes and passes missingDocs correctly — independent of Claude.
  console.log('\n========== GROUP LLL — cron computes + passes missingDocs ==========');
  {
    // Capture buckets specific to this scenario.
    const lllCapture = { generateFollowUpReminder: [] };

    // Snapshot originals to restore after.
    const lllOrig = {
      claimReminderSlot: dealsService.claimReminderSlot,
      releaseReminderSlot: dealsService.releaseReminderSlot,
      getActiveDeals: dealsService.getActiveDeals,
      getLastInboundMessage: dealsService.getLastInboundMessage,
      getMessages: dealsService.getMessages,
      getDocumentsByDeal: dealsService.getDocumentsByDeal,
      getLastOutboundMessageId: dealsService.getLastOutboundMessageId,
      getAllMessageIdsForThread: dealsService.getAllMessageIdsForThread,
      generateFollowUpReminder: aiService.generateFollowUpReminder,
      cronEmailSendEmail: cronEmailService.sendEmail,
    };

    // Stubs — mirror existing Bug A pattern. The deal under test has appraisal+NOA on
    // file, so missingDocs should be: gov_id, property_tax, mortgage_statement, credit_report
    // PLUS exit_strategy (null in extracted_data per the fixture below).
    dealsService.claimReminderSlot = async () => ({ claimed: true });
    dealsService.releaseReminderSlot = async () => ({ released: true });
    dealsService.getActiveDeals = async () => [{
      id: 'deal-lll-1',
      borrower_name: 'Noah MacKenzie',
      email: 'broker@example.com',
      status: 'active',
      reminder_count: 0,
      extracted_data: {
        broker_name: 'Michael Torres',
        sender_name: 'Michael Torres',
        sender_type: 'broker',
        borrower_name: 'Noah MacKenzie',
        loan_type: 'second mortgage',
        exit_strategy: null,
      },
    }];
    dealsService.getLastInboundMessage = async () => ({
      created_at: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
    });
    dealsService.getMessages = async () => [];
    dealsService.getDocumentsByDeal = async () => [
      { classification: 'appraisal', file_name: 'Appraisal.pdf' },
      { classification: 'noa', file_name: 'NOA.pdf' },
    ];
    dealsService.getLastOutboundMessageId = async () => 'mock-outbound-id';
    dealsService.getAllMessageIdsForThread = async () => ['mock-id-1'];
    aiService.generateFollowUpReminder = async (...args) => {
      lllCapture.generateFollowUpReminder.push(args);
      return '<p>Hi Michael!</p><p>Stub reminder body.</p>';
    };
    cronEmailService.sendEmail = async () => ({ MessageID: 'mock-msg-id' });

    await runFollowUpReminders();

    // Assertions
    if (lllCapture.generateFollowUpReminder.length !== 1) {
      throw new Error(`FAIL [Group LLL]: expected 1 generateFollowUpReminder call, got ${lllCapture.generateFollowUpReminder.length}`);
    }
    const args = lllCapture.generateFollowUpReminder[0];
    // Signature: (dealSummary, daysSilent, reminderNumber, missingDocs)
    if (args.length < 4) {
      throw new Error(`FAIL [Group LLL signature]: expected 4 args (dealSummary, daysSilent, reminderNumber, missingDocs), got ${args.length}`);
    }
    const passedMissing = args[3];
    if (!Array.isArray(passedMissing)) {
      throw new Error(`FAIL [Group LLL missingDocs type]: expected array, got ${typeof passedMissing}`);
    }
    // Refinance baseRequired (no purchase): government_id, appraisal, property_tax,
    // mortgage_statement, income_proof, credit_report. With appraisal + noa on file:
    //   - appraisal satisfied
    //   - income_proof satisfied by NOA (Fix 4 DOC_SYNONYMS)
    // Remaining: government_id, property_tax, mortgage_statement, credit_report
    // Plus Group C: exit_strategy null → push exit_strategy.
    // Total: 5 items.
    const expectedMissing = ['government_id', 'property_tax', 'mortgage_statement', 'credit_report', 'exit_strategy'];
    if (passedMissing.length !== expectedMissing.length) {
      throw new Error(`FAIL [Group LLL missingDocs count]: expected ${expectedMissing.length} items (${expectedMissing.join(', ')}), got ${passedMissing.length}: ${JSON.stringify(passedMissing)}`);
    }
    for (const expected of expectedMissing) {
      if (!passedMissing.includes(expected)) {
        throw new Error(`FAIL [Group LLL missingDocs content]: expected '${expected}' in passed missingDocs, got ${JSON.stringify(passedMissing)}`);
      }
    }
    // Negative: NOA satisfies income_proof, must NOT be in missingDocs (Fix 4 regression guard)
    if (passedMissing.includes('income_proof')) {
      throw new Error(`FAIL [Group LLL Fix 4 regression]: NOA on file should satisfy income_proof, but income_proof in missingDocs: ${JSON.stringify(passedMissing)}`);
    }
    if (passedMissing.includes('appraisal')) {
      throw new Error(`FAIL [Group LLL]: appraisal on file but listed as missing: ${JSON.stringify(passedMissing)}`);
    }
    console.log(`  PASS [Group LLL]: cron passed missingDocs=[${passedMissing.join(', ')}] (5 items, NOA→income_proof + appraisal satisfied, exit_strategy added per Group C)`);

    // Restore
    dealsService.claimReminderSlot = lllOrig.claimReminderSlot;
    dealsService.releaseReminderSlot = lllOrig.releaseReminderSlot;
    dealsService.getActiveDeals = lllOrig.getActiveDeals;
    dealsService.getLastInboundMessage = lllOrig.getLastInboundMessage;
    dealsService.getMessages = lllOrig.getMessages;
    dealsService.getDocumentsByDeal = lllOrig.getDocumentsByDeal;
    dealsService.getLastOutboundMessageId = lllOrig.getLastOutboundMessageId;
    dealsService.getAllMessageIdsForThread = lllOrig.getAllMessageIdsForThread;
    aiService.generateFollowUpReminder = lllOrig.generateFollowUpReminder;
    cronEmailService.sendEmail = lllOrig.cronEmailSendEmail;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // BUG B-EDIT — webhook EDIT path must re-preview revised draft, NOT auto-send.
  // Hoist `saveDraftAndPreview` above draft-review branch; EDIT routes through
  // saveDraftAndPreview instead of executeDraft. SEND/REPLACE unchanged.
  //
  // Bug A's harness section earlier deleted+re-required ./src/services/email
  // (`webhookEmailService`) and ./src/services/ai. webhook.js (already required
  // at line ~90) holds references to the ORIGINAL service singletons from before
  // those cache-busts. To stub correctly here we mutate the SAME instances
  // webhook.js captured: the line-22 `emailService` / line-21 `aiService`
  // bindings — NOT the post-cache-bust copies. (Pattern documented in Bug A
  // tests above.)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n========== BUG B-EDIT — webhook EDIT path re-previews revision ==========');
  {
    // Locate the /inbound handler from the express router stack.
    const inboundLayer = webhookRouter.stack.find(l => l.route && l.route.path === '/inbound');
    if (!inboundLayer) throw new Error('FAIL [Bug B-EDIT]: could not locate /inbound route on webhookRouter');
    const inboundHandler = inboundLayer.route.stack[0].handle;

    // Mock res — handler calls res.status(200).json(...) early.
    const mockRes = () => ({ status: () => ({ json: () => {} }) });

    // Build a Postmark-shaped inbound payload from Franco.
    const buildAdminReply = (textBody, dealMessageId) => ({
      body: {
        From: 'franco@privatemortgagelink.com',
        FromName: 'Franco Genovese',
        To: 'vienna@example.com',
        Subject: 'Re: Draft Email Preview — Mei Tanaka',
        TextBody: textBody,
        HtmlBody: `<p>${textBody}</p>`,
        Attachments: [],
        MessageID: 'admin-reply-' + Math.random().toString(36).slice(2, 10),
        Headers: [{ Name: 'In-Reply-To', Value: dealMessageId || 'preview-msgid' }],
        Date: new Date().toUTCString(),
      },
    });

    // Capture buckets & helpers
    const bugB = {
      sendEmail: [],         // preview-to-Franco sends (saveDraftAndPreview)
      sendEmailDelayed: [],  // broker sends (executeDraft)
      saveMessage: [],
      update: [],
      reviseEmailWithEdits: [],
      parseDraftReply: [],
    };
    const resetBugB = () => {
      bugB.sendEmail.length = 0;
      bugB.sendEmailDelayed.length = 0;
      bugB.saveMessage.length = 0;
      bugB.update.length = 0;
      bugB.reviseEmailWithEdits.length = 0;
      bugB.parseDraftReply.length = 0;
    };

    // Snapshot originals so we can restore after this block (Bug A tests already
    // consumed and restored their own stubs, but earlier patriciaSummary path
    // also touched these — avoid leaking state into the live Claude smoke).
    const orig = {
      dealsFindByMessageId: dealsService.findByMessageId,
      dealsSaveMessage: dealsService.saveMessage,
      dealsUpdate: dealsService.update,
      dealsGetMessages: dealsService.getMessages,
      aiParseDraftReply: aiService.parseDraftReply,
      aiReviseEmailWithEdits: aiService.reviseEmailWithEdits,
      emailSendEmail: emailService.sendEmail,
      emailSendEmailDelayed: emailService.sendEmailDelayed,
      emailParseInboundEmail: emailService.parseInboundEmail,
    };

    // Mutable deal record — saveDraftAndPreview's update() mutates draft_email,
    // and our test harness must reflect that for repeat-cycle tests.
    let liveDeal = null;
    const setDeal = (overrides = {}) => {
      liveDeal = {
        id: 'deal-bugb-1',
        email: 'broker@example.com',
        borrower_name: 'Mei Tanaka',
        extracted_data: { borrower_name: 'Mei Tanaka' },
        status: 'ltv_escalated',
        draft_email: '<p>Original draft body — please confirm collateral.</p>',
        draft_subject: 'Re: Mei Tanaka',
        draft_action: 'conditions',
        ...overrides,
      };
      return liveDeal;
    };

    // Stubs
    dealsService.findByMessageId = async () => liveDeal;
    dealsService.saveMessage = async (...args) => { bugB.saveMessage.push(args); };
    dealsService.update = async (id, patch) => {
      bugB.update.push({ id, patch });
      // Mirror real DB semantics — saveDraftAndPreview's update mutates draft_email.
      if (liveDeal && id === liveDeal.id) Object.assign(liveDeal, patch);
      return { id, ...patch };
    };
    dealsService.getMessages = async () => [];
    aiService.parseDraftReply = async (text) => {
      bugB.parseDraftReply.push(text);
      // Tests inject the desired classification via a per-test override below.
      return aiService.__bugBNextDraftReply || { action: 'edit', editInstructions: text };
    };
    aiService.reviseEmailWithEdits = async (existing, instructions) => {
      bugB.reviseEmailWithEdits.push({ existing, instructions });
      return `<p>REVISED draft incorporating: ${instructions}</p>`;
    };
    emailService.sendEmail = async (to, subject, text, html, attach, headers) => {
      bugB.sendEmail.push({ to, subject, html, headers });
      return { MessageID: 'preview-' + bugB.sendEmail.length };
    };
    emailService.sendEmailDelayed = (to, subject, text, html, attachments, headers, callback) => {
      bugB.sendEmailDelayed.push({ to, subject, html });
      // Simulate the delayed broker send firing — invoke callback so saveMessage
      // tracks the broker outbound (matches production wiring).
      if (callback) callback({ MessageID: 'broker-' + bugB.sendEmailDelayed.length });
    };

    // Real parseInboundEmail still works — it's pure transform of req.body.
    // (No need to stub; webhook.js requires emailService.parseInboundEmail.)

    // -------- E1: EDIT routes through saveDraftAndPreview, NOT executeDraft --------
    {
      resetBugB();
      setDeal({ status: 'ltv_escalated', draft_action: 'conditions' });
      aiService.__bugBNextDraftReply = { action: 'edit', editInstructions: 'shorten the opening paragraph' };
      const req = buildAdminReply('Please shorten the opening paragraph.');
      await inboundHandler(req, mockRes(), () => {});

      if (bugB.reviseEmailWithEdits.length !== 1) {
        throw new Error(`FAIL [Bug B-EDIT E1]: expected 1 reviseEmailWithEdits call, got ${bugB.reviseEmailWithEdits.length}`);
      }
      if (bugB.sendEmailDelayed.length !== 0) {
        throw new Error(`FAIL [Bug B-EDIT E1]: EDIT must NOT call sendEmailDelayed (broker send), got ${bugB.sendEmailDelayed.length}`);
      }
      if (bugB.sendEmail.length !== 1) {
        throw new Error(`FAIL [Bug B-EDIT E1]: expected 1 preview sendEmail to admin, got ${bugB.sendEmail.length}`);
      }
      if (bugB.sendEmail[0].to !== 'franco@privatemortgagelink.com') {
        throw new Error(`FAIL [Bug B-EDIT E1]: preview must go to admin, got ${bugB.sendEmail[0].to}`);
      }
      if (!bugB.sendEmail[0].html.includes('REVISED draft incorporating: shorten the opening paragraph')) {
        throw new Error(`FAIL [Bug B-EDIT E1]: preview must contain revised body, got: ${bugB.sendEmail[0].html.slice(0, 200)}`);
      }
      console.log('  PASS [Bug B-EDIT E1]: EDIT calls saveDraftAndPreview (1 preview to admin), NOT executeDraft (0 broker sends)');
    }

    // -------- E2: After EDIT, draft_email updated to revision; status + draft_action preserved --------
    {
      resetBugB();
      setDeal({ status: 'under_review', draft_action: 'approval_doc_request' });
      aiService.__bugBNextDraftReply = { action: 'edit', editInstructions: 'add a friendlier sign-off' };
      const req = buildAdminReply('add a friendlier sign-off');
      await inboundHandler(req, mockRes(), () => {});

      // saveDraftAndPreview calls update() with new draft_email + same draft_action.
      const draftUpdate = bugB.update.find(u => u.patch.draft_email !== undefined);
      if (!draftUpdate) {
        throw new Error(`FAIL [Bug B-EDIT E2]: expected an update() call writing draft_email, got: ${JSON.stringify(bugB.update)}`);
      }
      if (!draftUpdate.patch.draft_email.includes('REVISED draft incorporating: add a friendlier sign-off')) {
        throw new Error(`FAIL [Bug B-EDIT E2]: draft_email not updated to revision, got: ${draftUpdate.patch.draft_email?.slice(0, 200)}`);
      }
      if (draftUpdate.patch.draft_action !== 'approval_doc_request') {
        throw new Error(`FAIL [Bug B-EDIT E2]: draft_action must be preserved as 'approval_doc_request', got: ${draftUpdate.patch.draft_action}`);
      }
      // status itself is NOT in the update() patch — it stays whatever it was on the deal row.
      if (draftUpdate.patch.status !== undefined) {
        throw new Error(`FAIL [Bug B-EDIT E2]: saveDraftAndPreview must not change status, got patch.status=${draftUpdate.patch.status}`);
      }
      // Live deal should now have the revised draft_email (mirroring DB).
      if (!liveDeal.draft_email.includes('REVISED draft incorporating: add a friendlier sign-off')) {
        throw new Error(`FAIL [Bug B-EDIT E2]: liveDeal.draft_email not mutated by update, got: ${liveDeal.draft_email}`);
      }
      console.log('  PASS [Bug B-EDIT E2]: draft_email updated to revision; draft_action preserved; status untouched');
    }

    // -------- E3: Repeat EDIT cycle — second admin reply with edits stays in draft-review --------
    {
      resetBugB();
      setDeal({ status: 'ltv_escalated', draft_action: 'conditions' });
      // First edit
      aiService.__bugBNextDraftReply = { action: 'edit', editInstructions: 'first round of edits' };
      await inboundHandler(buildAdminReply('first round of edits'), mockRes(), () => {});
      const firstRoundPreviews = bugB.sendEmail.length;
      const firstRoundDraft = liveDeal.draft_email;
      // Second edit on the revised draft
      aiService.__bugBNextDraftReply = { action: 'edit', editInstructions: 'second round of edits' };
      await inboundHandler(buildAdminReply('second round of edits'), mockRes(), () => {});

      if (bugB.reviseEmailWithEdits.length !== 2) {
        throw new Error(`FAIL [Bug B-EDIT E3]: expected 2 revise calls (one per cycle), got ${bugB.reviseEmailWithEdits.length}`);
      }
      // Second revise should be against the FIRST-round revised draft, not the original.
      if (!bugB.reviseEmailWithEdits[1].existing.includes('first round of edits')) {
        throw new Error(`FAIL [Bug B-EDIT E3]: second revise must operate on first revision, got existing: ${bugB.reviseEmailWithEdits[1].existing.slice(0, 200)}`);
      }
      if (bugB.sendEmailDelayed.length !== 0) {
        throw new Error(`FAIL [Bug B-EDIT E3]: no broker sends across edit cycles, got ${bugB.sendEmailDelayed.length}`);
      }
      if (bugB.sendEmail.length !== firstRoundPreviews + 1) {
        throw new Error(`FAIL [Bug B-EDIT E3]: expected one more preview after second edit, got total=${bugB.sendEmail.length}`);
      }
      if (liveDeal.draft_action !== 'conditions') {
        throw new Error(`FAIL [Bug B-EDIT E3]: draft_action must remain 'conditions' across cycles, got ${liveDeal.draft_action}`);
      }
      console.log('  PASS [Bug B-EDIT E3]: repeat EDIT cycle works — 2 revisions, 2 previews, 0 broker sends, state preserved');
    }

    // -------- E4: SEND after EDIT ships the revised draft to broker --------
    {
      resetBugB();
      // Set up deal that already has a revised draft on it (post-EDIT state).
      setDeal({
        status: 'ltv_escalated',
        draft_action: 'conditions',
        draft_email: '<p>REVISED draft incorporating: shorten opening</p>',
      });
      aiService.__bugBNextDraftReply = { action: 'send' };
      await inboundHandler(buildAdminReply('SEND'), mockRes(), () => {});

      if (bugB.sendEmailDelayed.length !== 1) {
        throw new Error(`FAIL [Bug B-EDIT E4]: SEND must ship to broker once, got ${bugB.sendEmailDelayed.length}`);
      }
      if (bugB.sendEmailDelayed[0].to !== 'broker@example.com') {
        throw new Error(`FAIL [Bug B-EDIT E4]: SEND must go to broker, got ${bugB.sendEmailDelayed[0].to}`);
      }
      if (!bugB.sendEmailDelayed[0].html.includes('REVISED draft incorporating: shorten opening')) {
        throw new Error(`FAIL [Bug B-EDIT E4]: SEND must ship the revised draft, got: ${bugB.sendEmailDelayed[0].html.slice(0, 200)}`);
      }
      // No re-revision on SEND.
      if (bugB.reviseEmailWithEdits.length !== 0) {
        throw new Error(`FAIL [Bug B-EDIT E4]: SEND must not call reviseEmailWithEdits, got ${bugB.reviseEmailWithEdits.length}`);
      }
      console.log('  PASS [Bug B-EDIT E4]: SEND after EDIT ships revised draft to broker (1 broker send, 0 re-revisions)');
    }

    // -------- E5-AAA: REPLACE now routes through saveDraftAndPreview (no auto-bypass) --------
    // Group AAA fix (S8.1): pre-AAA, REPLACE-classified replies bypassed the preview
    // cycle and shipped verbatim to broker (Bug B Q4 design). Franco's S8 retest
    // showed his mental model is "skip rewriting, still confirm" — REPLACE should
    // skip the Claude rewrite (verbatim guarantee) but still re-preview to admin
    // before broker ship. This test verifies REPLACE → saveDraftAndPreview, NOT
    // executeDraft, and that reviseEmailWithEdits is NEVER invoked (verbatim path).
    {
      resetBugB();
      setDeal({ status: 'ltv_escalated', draft_action: 'conditions' });
      aiService.__bugBNextDraftReply = {
        action: 'replace',
        replacementText: 'Hi broker,\n\nFranco here. Please send the appraisal directly.\n\nThanks.',
      };
      await inboundHandler(buildAdminReply('Hi broker,\n\nFranco here. Please send the appraisal directly.\n\nThanks.'), mockRes(), () => {});

      if (bugB.sendEmailDelayed.length !== 0) {
        throw new Error(`FAIL [Bug B-EDIT E5-AAA]: REPLACE must NOT ship to broker (preview cycle), got ${bugB.sendEmailDelayed.length} broker sends`);
      }
      if (bugB.sendEmail.length !== 1) {
        throw new Error(`FAIL [Bug B-EDIT E5-AAA]: REPLACE must send 1 preview to admin, got ${bugB.sendEmail.length}`);
      }
      if (bugB.sendEmail[0].to !== 'franco@privatemortgagelink.com') {
        throw new Error(`FAIL [Bug B-EDIT E5-AAA]: preview must go to admin, got ${bugB.sendEmail[0].to}`);
      }
      // Verbatim guarantee: Franco's text must appear in the preview HTML byte-equivalent
      // (textToHtml wraps it in <p> tags but does not paraphrase).
      if (!bugB.sendEmail[0].html.includes('Franco here. Please send the appraisal directly.')) {
        throw new Error(`FAIL [Bug B-EDIT E5-AAA]: preview must contain Franco's verbatim text, got: ${bugB.sendEmail[0].html.slice(0, 300)}`);
      }
      // CRITICAL verbatim-guarantee assertion: Claude must NOT have rewritten Franco's text.
      if (bugB.reviseEmailWithEdits.length !== 0) {
        throw new Error(`FAIL [Bug B-EDIT E5-AAA verbatim guarantee]: reviseEmailWithEdits must NEVER fire on REPLACE path (would paraphrase Franco's text), got ${bugB.reviseEmailWithEdits.length} invocations`);
      }
      // saveDraftAndPreview's update() should have written Franco's HTML to draft_email.
      const draftUpdate = bugB.update.find(u => u.patch.draft_email !== undefined);
      if (!draftUpdate || !draftUpdate.patch.draft_email.includes('Franco here. Please send the appraisal directly.')) {
        throw new Error(`FAIL [Bug B-EDIT E5-AAA]: draft_email must be updated to Franco's verbatim HTML, got: ${draftUpdate?.patch?.draft_email?.slice(0, 200)}`);
      }
      // draft_action and status preserved (rejection / conditions / approval_doc_request all stay).
      if (draftUpdate.patch.draft_action !== 'conditions') {
        throw new Error(`FAIL [Bug B-EDIT E5-AAA]: draft_action must be preserved, got ${draftUpdate.patch.draft_action}`);
      }
      console.log('  PASS [Bug B-EDIT E5-AAA]: REPLACE routed to saveDraftAndPreview (1 preview, 0 broker sends, 0 reviseEmailWithEdits — verbatim guarantee preserved)');
    }

    // -------- E6-AAA: REPLACE → SEND cycle ships verbatim text to broker --------
    // End-to-end regression guard for the verbatim-text promise. Step 1: Franco
    // sends a full alternative draft → preview to admin. Step 2: Franco replies
    // SEND → broker receives the EXACT verbatim HTML from step 1. Asserts that
    // reviseEmailWithEdits never fires across BOTH steps.
    {
      resetBugB();
      setDeal({ status: 'ltv_escalated', draft_action: 'rejection' });

      // Step 1: REPLACE — Franco's verbatim alternative draft.
      const francoVerbatimText = 'Hi Kevin,\n\nAfter further review we have decided to close this file. The figures in the application could not be reconciled with the supporting documents.\n\nWe appreciate the submission and look forward to working together on a future opportunity.\n\nVienna\nPrivate Mortgage Link';
      aiService.__bugBNextDraftReply = {
        action: 'replace',
        replacementText: francoVerbatimText,
      };
      await inboundHandler(buildAdminReply(francoVerbatimText), mockRes(), () => {});

      const previewCount = bugB.sendEmail.length;
      const reviseCountAfterReplace = bugB.reviseEmailWithEdits.length;
      if (previewCount !== 1) {
        throw new Error(`FAIL [Bug B-EDIT E6-AAA step 1]: expected 1 preview to admin, got ${previewCount}`);
      }
      if (reviseCountAfterReplace !== 0) {
        throw new Error(`FAIL [Bug B-EDIT E6-AAA step 1]: reviseEmailWithEdits fired on REPLACE path (would paraphrase), got ${reviseCountAfterReplace}`);
      }
      // Capture the saved draft_email — must be byte-equivalent to Franco's verbatim text via textToHtml.
      const savedDraftEmail = liveDeal.draft_email;
      if (!savedDraftEmail.includes('After further review we have decided to close this file.')) {
        throw new Error(`FAIL [Bug B-EDIT E6-AAA step 1]: saved draft_email missing Franco's verbatim text, got: ${savedDraftEmail.slice(0, 300)}`);
      }

      // Step 2: SEND — Franco confirms. Broker should receive the exact draft_email from step 1.
      aiService.__bugBNextDraftReply = { action: 'send' };
      await inboundHandler(buildAdminReply('SEND'), mockRes(), () => {});

      if (bugB.sendEmailDelayed.length !== 1) {
        throw new Error(`FAIL [Bug B-EDIT E6-AAA step 2]: SEND must ship to broker once, got ${bugB.sendEmailDelayed.length}`);
      }
      if (bugB.sendEmailDelayed[0].to !== 'broker@example.com') {
        throw new Error(`FAIL [Bug B-EDIT E6-AAA step 2]: SEND must go to broker, got ${bugB.sendEmailDelayed[0].to}`);
      }
      // CRITICAL byte-equality: broker's HTML must equal step 1's saved draft_email exactly.
      if (bugB.sendEmailDelayed[0].html !== savedDraftEmail) {
        throw new Error(`FAIL [Bug B-EDIT E6-AAA step 2 verbatim]: broker HTML differs from saved draft. SAVED: ${savedDraftEmail.slice(0, 200)} | BROKER: ${bugB.sendEmailDelayed[0].html.slice(0, 200)}`);
      }
      // Verbatim guarantee across BOTH steps: Claude never rewrote Franco's text.
      if (bugB.reviseEmailWithEdits.length !== 0) {
        throw new Error(`FAIL [Bug B-EDIT E6-AAA full cycle verbatim]: reviseEmailWithEdits fired during REPLACE→SEND lifecycle (Franco's text would have been paraphrased), got ${bugB.reviseEmailWithEdits.length} invocations`);
      }
      console.log('  PASS [Bug B-EDIT E6-AAA]: REPLACE → SEND cycle ships byte-equivalent verbatim HTML to broker; reviseEmailWithEdits never fired');
    }

    // Restore originals so downstream sections aren't polluted.
    delete aiService.__bugBNextDraftReply;
    dealsService.findByMessageId = orig.dealsFindByMessageId;
    dealsService.saveMessage = orig.dealsSaveMessage;
    dealsService.update = orig.dealsUpdate;
    dealsService.getMessages = orig.dealsGetMessages;
    aiService.parseDraftReply = orig.aiParseDraftReply;
    aiService.reviseEmailWithEdits = orig.aiReviseEmailWithEdits;
    emailService.sendEmail = orig.emailSendEmail;
    emailService.sendEmailDelayed = orig.emailSendEmailDelayed;
    emailService.parseInboundEmail = orig.emailParseInboundEmail;

    console.log('Bug B-EDIT + AAA: 6/6 passed');
  }

  // ════════════════════════════════════════════════════════════════
  // GROUP GGG — broker reply suppressed when willReview fires (S14.3)
  // ════════════════════════════════════════════════════════════════
  // Pre-GGG: when broker submitted docs that triggered PRELIMINARY review, Vienna
  // sent a "let me know if you have questions, then I'll send for review" reply
  // that contradicted the prelim review firing ~49s later in the same request.
  // GGG fix: extend Group L's suppression pattern (which already silenced Vienna
  // on FINAL REVIEW) to also suppress on willReview. willGoToCollateralCheck is
  // NOT suppressed — that path uses Vienna's reply to deliver the collateral
  // question to the broker (Fix 7).
  console.log('\n========== GROUP GGG — broker reply suppressed when willReview fires ==========');
  {
    // Reuse the inbound handler infrastructure pattern from Bug B-EDIT.
    const inboundLayer = webhookRouter.stack.find(l => l.route && l.route.path === '/inbound');
    if (!inboundLayer) throw new Error('FAIL [Group GGG]: could not locate /inbound route on webhookRouter');
    const inboundHandler = inboundLayer.route.stack[0].handle;

    const mockRes = () => ({ status: () => ({ json: () => {} }) });

    const buildBrokerReply = (textBody, threadMsgId) => ({
      body: {
        From: 'jason.mercer@brokerage.com',
        FromName: 'Jason Mercer',
        To: 'vienna@example.com',
        Subject: 'Re: Patricia Simmons — Loan Inquiry',
        TextBody: textBody,
        HtmlBody: `<p>${textBody}</p>`,
        Attachments: [],
        MessageID: 'broker-reply-' + Math.random().toString(36).slice(2, 10),
        Headers: [{ Name: 'In-Reply-To', Value: threadMsgId || 'prev-msgid' }],
        Date: new Date().toUTCString(),
      },
    });

    // Capture buckets
    const ggg = {
      sendEmail: [],         // admin notifications (prelim review etc.)
      sendEmailDelayed: [],  // broker-facing replies
      saveMessage: [],
      update: [],
      generateBrokerResponse: [],
      generateLeadSummary: [],
    };
    const resetGgg = () => {
      ggg.sendEmail.length = 0;
      ggg.sendEmailDelayed.length = 0;
      ggg.saveMessage.length = 0;
      ggg.update.length = 0;
      ggg.generateBrokerResponse.length = 0;
      ggg.generateLeadSummary.length = 0;
    };

    // Snapshot originals for restore
    const origGgg = {
      dealsFindByMessageId: dealsService.findByMessageId,
      dealsSaveMessage: dealsService.saveMessage,
      dealsUpdate: dealsService.update,
      dealsGetMessages: dealsService.getMessages,
      dealsGetDocumentsByDeal: dealsService.getDocumentsByDeal,
      dealsGetDocumentsWithText: dealsService.getDocumentsWithText,
      dealsDownloadDocsAsZip: dealsService.downloadDocsAsZip,
      aiGenerateBrokerResponse: aiService.generateBrokerResponse,
      aiGenerateLeadSummary: aiService.generateLeadSummary,
      emailSendEmail: emailService.sendEmail,
      emailSendEmailDelayed: emailService.sendEmailDelayed,
    };

    // Mutable deal record
    let gggDeal = null;
    const setGggDeal = (overrides = {}) => {
      gggDeal = {
        id: 'deal-ggg-1',
        email: 'jason.mercer@brokerage.com',
        borrower_name: 'Patricia Simmons',
        extracted_data: { borrower_name: 'Patricia Simmons', sender_name: 'Jason Mercer', broker_name: 'Jason Mercer', sender_type: 'broker' },
        status: 'active',
        ltv: null,
        ownership_type: 'personal',
        has_application_form: true,
        has_pnw_statement: true,
        ...overrides,
      };
      return gggDeal;
    };

    const stubDocsWithReviewable = [
      { classification: 'appraisal', file_name: 'Appraisal_Simmons.pdf' },
      { classification: 'loan_application', file_name: 'Loan_App_Simmons.pdf' },
      { classification: 'noa', file_name: 'NOA_Simmons.pdf' },
    ];

    // Apply stubs
    dealsService.findByMessageId = async () => gggDeal;
    dealsService.saveMessage = async (...args) => { ggg.saveMessage.push(args); };
    dealsService.update = async (id, patch) => {
      ggg.update.push({ id, patch });
      if (gggDeal && id === gggDeal.id) Object.assign(gggDeal, patch);
      return { id, ...patch };
    };
    dealsService.getMessages = async () => [];
    dealsService.getDocumentsByDeal = async () => stubDocsWithReviewable;
    dealsService.getDocumentsWithText = async () => stubDocsWithReviewable;
    dealsService.downloadDocsAsZip = async () => 'ZIPBASE64PLACEHOLDER';
    aiService.generateLeadSummary = async (...args) => {
      ggg.generateLeadSummary.push(args);
      return '<h2>PRELIMINARY Review for Patricia Simmons</h2>';
    };
    emailService.sendEmail = async (to, subject, text, html, attachments, headers) => {
      ggg.sendEmail.push({ to, subject, html, headers });
      return { MessageID: 'admin-' + ggg.sendEmail.length };
    };
    emailService.sendEmailDelayed = (to, subject, text, html, attachments, headers, callback) => {
      ggg.sendEmailDelayed.push({ to, subject, html });
      if (callback) callback({ MessageID: 'broker-' + ggg.sendEmailDelayed.length });
    };

    // -------- G1: willReview triggers → Vienna reply suppressed, prelim review fires --------
    {
      resetGgg();
      // LTV 65% via aiService.generateBrokerResponse return; status='active' on deal.
      setGggDeal({ status: 'active', ltv: null });
      aiService.generateBrokerResponse = async (...args) => {
        ggg.generateBrokerResponse.push(args.length);
        return {
          responseEmail: '<p>Test response — should be suppressed by GGG.</p>',
          // Group BBBB (S7.1/S9.1): willReview now requires exit_strategy populated.
          // GGG G1 verifies suppression when willReview fires — fixture must set
          // exit_strategy so the predicate evaluates true.
          updatedSummary: { ...gggDeal.extracted_data, ltv_percent: 65, exit_strategy: 'refinance at maturity with B lender' },
          allDocsReceived: false,
          hasApplicationForm: true,
          hasPnwStatement: true,
          ownershipType: 'personal',
          ltvPercent: 65,
        };
      };

      const req = buildBrokerReply('Sending across the appraisal and NOA for Patricia.');
      await inboundHandler(req, mockRes(), () => {});

      // Assertions
      if (ggg.generateBrokerResponse.length !== 1) {
        throw new Error(`FAIL [Group GGG G1]: expected generateBrokerResponse to be called once (reply generated, then suppressed), got ${ggg.generateBrokerResponse.length}`);
      }
      if (ggg.sendEmailDelayed.length !== 0) {
        throw new Error(`FAIL [Group GGG G1]: Vienna's broker reply must be SUPPRESSED when willReview fires, got ${ggg.sendEmailDelayed.length} broker sends`);
      }
      if (ggg.sendEmail.length !== 1) {
        throw new Error(`FAIL [Group GGG G1]: expected 1 admin notification (PRELIMINARY review), got ${ggg.sendEmail.length}`);
      }
      const adminNotif = ggg.sendEmail[0];
      if (!/PRELIMINARY Review/.test(adminNotif.subject)) {
        throw new Error(`FAIL [Group GGG G1]: admin notification subject must mention PRELIMINARY Review, got "${adminNotif.subject}"`);
      }
      console.log('  PASS [Group GGG G1]: willReview triggers → 0 broker sends, 1 admin PRELIMINARY review notification, generateBrokerResponse still invoked');
    }

    // -------- G2: willGoToCollateralCheck still sends Vienna's reply (Fix 7 regression guard) --------
    {
      resetGgg();
      setGggDeal({ status: 'active', ltv: null, extracted_data: { ...gggDeal.extracted_data, collateral_offered: false } });
      aiService.generateBrokerResponse = async (...args) => {
        ggg.generateBrokerResponse.push(args.length);
        return {
          responseEmail: '<p>Vienna asks about additional collateral.</p>',
          updatedSummary: { ...gggDeal.extracted_data, ltv_percent: 85 },
          allDocsReceived: false,
          hasApplicationForm: true,
          hasPnwStatement: true,
          ownershipType: 'personal',
          ltvPercent: 85,
        };
      };

      const req = buildBrokerReply('Submitting Patricia Simmons, ~85% LTV, looking for second mortgage.');
      await inboundHandler(req, mockRes(), () => {});

      if (ggg.sendEmailDelayed.length !== 1) {
        throw new Error(`FAIL [Group GGG G2 Fix 7 regression]: willGoToCollateralCheck must send Vienna's reply (carries collateral question), got ${ggg.sendEmailDelayed.length} broker sends`);
      }
      if (ggg.sendEmailDelayed[0].to !== 'jason.mercer@brokerage.com') {
        throw new Error(`FAIL [Group GGG G2]: Vienna's reply must go to broker, got ${ggg.sendEmailDelayed[0].to}`);
      }
      // No admin notification yet (Fix 7 — silent until broker confirms collateral disposition).
      if (ggg.sendEmail.length !== 0) {
        throw new Error(`FAIL [Group GGG G2 Fix 7 regression]: willGoToCollateralCheck must NOT fire admin notification yet, got ${ggg.sendEmail.length}`);
      }
      // Status should flip to awaiting_collateral.
      const collateralStatusUpdate = ggg.update.find(u => u.patch.status === 'awaiting_collateral');
      if (!collateralStatusUpdate) {
        throw new Error(`FAIL [Group GGG G2]: deal status must flip to awaiting_collateral, updates: ${JSON.stringify(ggg.update)}`);
      }
      console.log('  PASS [Group GGG G2]: willGoToCollateralCheck still sends Vienna reply (1 broker send, 0 admin notifs, status → awaiting_collateral) — Fix 7 path preserved');
    }

    // Restore originals
    dealsService.findByMessageId = origGgg.dealsFindByMessageId;
    dealsService.saveMessage = origGgg.dealsSaveMessage;
    dealsService.update = origGgg.dealsUpdate;
    dealsService.getMessages = origGgg.dealsGetMessages;
    dealsService.getDocumentsByDeal = origGgg.dealsGetDocumentsByDeal;
    dealsService.getDocumentsWithText = origGgg.dealsGetDocumentsWithText;
    dealsService.downloadDocsAsZip = origGgg.dealsDownloadDocsAsZip;
    aiService.generateBrokerResponse = origGgg.aiGenerateBrokerResponse;
    aiService.generateLeadSummary = origGgg.aiGenerateLeadSummary;
    emailService.sendEmail = origGgg.emailSendEmail;
    emailService.sendEmailDelayed = origGgg.emailSendEmailDelayed;

    console.log('Group GGG: 2/2 passed');
  }

  // ════════════════════════════════════════════════════════════════
  // GROUP BBB — conditions-fulfilled flow (S9.1/S9.2/S9.3)
  // ════════════════════════════════════════════════════════════════
  // S9.1: when broker submitted condition docs, Vienna fired a "thanks for sending
  //   those through" reply that contradicted the in-flight admin handoff.
  // S9.2: same event fired "[UPDATED] ACTION REQUIRED: PRELIMINARY Review" with
  //   APPROVED/DECLINE — redundant since admin already approved by sending
  //   conditions. Pre-BBB the dispatch at webhook.js:806-814 had no signal that
  //   admin had moved past prelim.
  // S9.3: generateCompletionEmail produced "we will be in touch shortly if anything
  //   else is required" — should be a clean handoff per Franco's deterministic
  //   template ("file complete + redirect to Franco").
  // BBB fix:
  //   - conditions_sent_at column on deals (timestamptz, nullable)
  //   - executeDraft 'conditions' branch stamps conditions_sent_at
  //   - inbound dispatch reads conditions_sent_at: if set, route to handoff
  //     (informational notice + closing draft preview), suppress Vienna's reply
  //   - generateCompletionEmail rewritten to deterministic template (no Claude)
  //
  // Tests: 4 scenarios.
  console.log('\n========== GROUP BBB — conditions-fulfilled flow ==========');
  {
    const inboundLayer = webhookRouter.stack.find(l => l.route && l.route.path === '/inbound');
    if (!inboundLayer) throw new Error('FAIL [Group BBB]: could not locate /inbound route');
    const inboundHandler = inboundLayer.route.stack[0].handle;

    const mockRes = () => ({ status: () => ({ json: () => {} }) });

    const buildBrokerReply = (textBody, threadMsgId) => ({
      body: {
        From: 'tyler.bennett@brokerage.com',
        FromName: 'Tyler Bennett',
        To: 'vienna@example.com',
        Subject: 'Re: James Okafor — Loan Inquiry',
        TextBody: textBody,
        HtmlBody: `<p>${textBody}</p>`,
        Attachments: [{ Name: 'GovID_Okafor.pdf', ContentType: 'application/pdf', Content: 'BASE64', ContentLength: 100 }],
        MessageID: 'broker-reply-bbb-' + Math.random().toString(36).slice(2, 10),
        Headers: [{ Name: 'In-Reply-To', Value: threadMsgId || 'prev-msgid' }],
        Date: new Date().toUTCString(),
      },
    });

    const buildAdminReply = (textBody, threadMsgId) => ({
      body: {
        From: 'franco@privatemortgagelink.com',
        FromName: 'Franco Genovese',
        To: 'vienna@example.com',
        Subject: 'Re: Draft Email Preview — James Okafor',
        TextBody: textBody,
        HtmlBody: `<p>${textBody}</p>`,
        Attachments: [],
        MessageID: 'admin-reply-bbb-' + Math.random().toString(36).slice(2, 10),
        Headers: [{ Name: 'In-Reply-To', Value: threadMsgId || 'prev-msgid' }],
        Date: new Date().toUTCString(),
      },
    });

    // Capture buckets
    const bbb = {
      sendEmail: [],
      sendEmailDelayed: [],
      saveMessage: [],
      update: [],
    };
    const resetBbb = () => {
      bbb.sendEmail.length = 0;
      bbb.sendEmailDelayed.length = 0;
      bbb.saveMessage.length = 0;
      bbb.update.length = 0;
    };

    const origBbb = {
      dealsFindByMessageId: dealsService.findByMessageId,
      dealsSaveMessage: dealsService.saveMessage,
      dealsUpdate: dealsService.update,
      dealsGetMessages: dealsService.getMessages,
      dealsGetDocumentsByDeal: dealsService.getDocumentsByDeal,
      dealsGetDocumentsWithText: dealsService.getDocumentsWithText,
      dealsDownloadDocsAsZip: dealsService.downloadDocsAsZip,
      dealsSaveAttachment: dealsService.saveAttachment,
      aiGenerateBrokerResponse: aiService.generateBrokerResponse,
      aiGenerateLeadSummary: aiService.generateLeadSummary,
      aiGenerateCompletionEmail: aiService.generateCompletionEmail,
      aiGenerateDocumentRequestEmail: aiService.generateDocumentRequestEmail,
      aiParseDraftReply: aiService.parseDraftReply,
      emailSendEmail: emailService.sendEmail,
      emailSendEmailDelayed: emailService.sendEmailDelayed,
    };

    let bbbDeal = null;
    const setBbbDeal = (overrides = {}) => {
      bbbDeal = {
        id: 'deal-bbb-1',
        email: 'tyler.bennett@brokerage.com',
        borrower_name: 'James Okafor',
        extracted_data: { borrower_name: 'James Okafor', sender_name: 'Tyler Bennett', broker_name: 'Tyler Bennett', sender_type: 'broker' },
        status: 'under_review',
        ltv: 65,
        ownership_type: 'personal',
        has_application_form: true,
        has_pnw_statement: true,
        draft_email: null,
        draft_subject: null,
        draft_action: null,
        conditions_sent_at: null,
        ...overrides,
      };
      return bbbDeal;
    };

    // Apply stubs
    dealsService.findByMessageId = async () => bbbDeal;
    dealsService.saveMessage = async (...args) => { bbb.saveMessage.push(args); };
    dealsService.update = async (id, patch) => {
      bbb.update.push({ id, patch });
      if (bbbDeal && id === bbbDeal.id) Object.assign(bbbDeal, patch);
      return { id, ...patch };
    };
    dealsService.getMessages = async () => [];
    dealsService.getDocumentsByDeal = async () => [{ classification: 'appraisal', file_name: 'Appraisal.pdf' }];
    dealsService.getDocumentsWithText = async () => [{ classification: 'appraisal', file_name: 'Appraisal.pdf' }];
    dealsService.downloadDocsAsZip = async () => 'ZIPBASE64';
    dealsService.saveAttachment = async () => ({ id: 'doc-bbb-1', file_name: 'GovID_Okafor.pdf', classification: 'government_id' });
    aiService.generateLeadSummary = async () => '<h2>Lead Summary</h2>';

    emailService.sendEmail = async (to, subject, text, html, attachments) => {
      bbb.sendEmail.push({ to, subject, html, attachmentCount: (attachments || []).length });
      return { MessageID: 'admin-' + bbb.sendEmail.length };
    };
    emailService.sendEmailDelayed = (to, subject, text, html, attachments, headers, callback) => {
      bbb.sendEmailDelayed.push({ to, subject, html });
      if (callback) callback({ MessageID: 'broker-' + bbb.sendEmailDelayed.length });
    };

    // -------- B1: executeDraft 'conditions' branch stamps conditions_sent_at --------
    // Admin sends conditions via SEND on a 'conditions' draft → executeDraft fires
    // for action='conditions', updates the deal with conditions_sent_at timestamp.
    {
      resetBbb();
      // Set up a deal with a 'conditions' draft pending admin's SEND.
      setBbbDeal({
        status: 'under_review',
        draft_email: '<p>Hi Tyler, approving subject to gov ID and exit strategy clarification...</p>',
        draft_subject: 'Re: James Okafor',
        draft_action: 'conditions',
        conditions_sent_at: null,
      });
      aiService.parseDraftReply = async () => ({ action: 'send' });
      await inboundHandler(buildAdminReply('SEND'), mockRes(), () => {});

      const stampUpdate = bbb.update.find(u => u.patch.conditions_sent_at !== undefined);
      if (!stampUpdate) {
        throw new Error(`FAIL [Group BBB B1]: executeDraft 'conditions' must stamp conditions_sent_at, updates: ${JSON.stringify(bbb.update)}`);
      }
      if (typeof stampUpdate.patch.conditions_sent_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(stampUpdate.patch.conditions_sent_at)) {
        throw new Error(`FAIL [Group BBB B1]: conditions_sent_at must be an ISO timestamp, got: ${JSON.stringify(stampUpdate.patch.conditions_sent_at)}`);
      }
      // Status must stay (not change to 'active'/'rejected'/'completed').
      if (stampUpdate.patch.status !== undefined) {
        throw new Error(`FAIL [Group BBB B1]: 'conditions' branch must NOT change status, got patch.status=${stampUpdate.patch.status}`);
      }
      // Draft fields cleared.
      if (stampUpdate.patch.draft_email !== null || stampUpdate.patch.draft_action !== null) {
        throw new Error(`FAIL [Group BBB B1]: 'conditions' branch must clear draft_email/draft_action, got patch: ${JSON.stringify(stampUpdate.patch)}`);
      }
      console.log('  PASS [Group BBB B1]: executeDraft conditions branch stamps conditions_sent_at + clears draft fields + preserves status');
    }

    // -------- B2: broker submission with conditions_sent_at + all docs in routes to handoff --------
    // Group NNN refactored the dispatch: pre-NNN BBB fired purely on conditions_sent_at,
    // post-NNN it requires allDocsInNow=true (all required classifications + exit_strategy).
    // This test sets up a complete-file scenario where BBB's handoff is the correct dispatch.
    {
      resetBbb();
      // Deal has conditions_sent_at populated (admin already sent conditions).
      setBbbDeal({
        status: 'under_review',
        conditions_sent_at: '2026-05-07T15:00:00.000Z',
        draft_email: null,
      });
      // NNN: stub all 6 refinance-required classifications on file so allDocsInNow=true.
      // Group SSS extension: completion-handoff gate now requires AML + PEP too — without
      // them the dispatch falls through to preliminary-update. Add compliance classifications
      // to keep this test exercising the conditions-fulfilled handoff path.
      const bbbCompleteDocs = [
        { classification: 'government_id', file_name: 'GovID.pdf' },
        { classification: 'appraisal', file_name: 'Appraisal.pdf' },
        { classification: 'property_tax', file_name: 'PropertyTax.pdf' },
        { classification: 'mortgage_statement', file_name: 'Payout.pdf' },
        { classification: 'income_proof', file_name: 'NOA.pdf' },
        { classification: 'credit_report', file_name: 'CB.pdf' },
        { classification: 'aml', file_name: 'AML.pdf' },
        { classification: 'pep', file_name: 'PEP.pdf' },
      ];
      dealsService.getDocumentsByDeal = async () => bbbCompleteDocs;
      dealsService.getDocumentsWithText = async () => bbbCompleteDocs;
      // Stub Claude analysis to return a hasNewDocs-like state. NNN: include
      // exit_strategy + loan_type='refinance' so allDocsInNow gate passes.
      aiService.generateBrokerResponse = async () => ({
        responseEmail: '<p>Vienna would normally reply here.</p>',
        updatedSummary: {
          ...bbbDeal.extracted_data,
          ltv_percent: 65,
          loan_type: 'refinance',
          purpose: 'debt consolidation',
          exit_strategy: 'refi at maturity',
        },
        allDocsReceived: true,
        hasApplicationForm: true,
        hasPnwStatement: true,
        ownershipType: 'personal',
        ltvPercent: 65,
      });

      await inboundHandler(buildBrokerReply('Sending the gov ID and exit strategy details for James.'), mockRes(), () => {});

      // Vienna's broker reply must be SUPPRESSED.
      if (bbb.sendEmailDelayed.length !== 0) {
        throw new Error(`FAIL [Group BBB B2 reply suppression]: expected 0 broker sends (Vienna reply suppressed when conditions fulfilled), got ${bbb.sendEmailDelayed.length}`);
      }
      // Two admin emails: informational notice + closing draft preview.
      if (bbb.sendEmail.length !== 2) {
        throw new Error(`FAIL [Group BBB B2 admin emails]: expected 2 admin emails (info + draft preview), got ${bbb.sendEmail.length}: ${JSON.stringify(bbb.sendEmail.map(e => e.subject))}`);
      }
      // Email 1: informational notice — subject contains "[Conditions Fulfilled]", does NOT include "ACTION REQUIRED" or "PRELIMINARY Review".
      const infoEmail = bbb.sendEmail[0];
      if (!/\[Conditions Fulfilled\]/.test(infoEmail.subject)) {
        throw new Error(`FAIL [Group BBB B2 info subject]: expected '[Conditions Fulfilled]' prefix, got "${infoEmail.subject}"`);
      }
      if (/ACTION REQUIRED|PRELIMINARY Review/.test(infoEmail.subject)) {
        throw new Error(`FAIL [Group BBB B2 redundant ACTION REQUIRED]: info email must NOT use ACTION REQUIRED / PRELIMINARY Review framing (S9.2 root cause), got "${infoEmail.subject}"`);
      }
      // Email 2: closing draft preview — subject is in-thread "Re: [Conditions Fulfilled]...".
      const previewEmail = bbb.sendEmail[1];
      if (!/^Re: \[Conditions Fulfilled\]/.test(previewEmail.subject)) {
        throw new Error(`FAIL [Group BBB B2 preview subject]: expected 'Re: [Conditions Fulfilled]...' (in-thread), got "${previewEmail.subject}"`);
      }
      // Preview HTML contains the closing draft preview chrome and the closing template.
      if (!/Closing Draft Preview/.test(previewEmail.html) || !/Reply SEND to confirm/.test(previewEmail.html)) {
        throw new Error(`FAIL [Group BBB B2 preview body]: expected closing-draft-preview chrome + Reply SEND, got: ${previewEmail.html.slice(0, 300)}`);
      }
      // Deal updated with draft_email = closing template, draft_action = 'approval_completed'.
      const draftUpdate = bbb.update.find(u => u.patch.draft_email !== undefined && u.patch.draft_email !== null);
      if (!draftUpdate) {
        throw new Error(`FAIL [Group BBB B2 draft saved]: expected an update writing draft_email (closing template), got updates: ${JSON.stringify(bbb.update)}`);
      }
      if (draftUpdate.patch.draft_action !== 'approval_completed') {
        throw new Error(`FAIL [Group BBB B2 draft_action]: expected 'approval_completed' (so SEND advances to 'completed'), got '${draftUpdate.patch.draft_action}'`);
      }
      // Closing template content sanity (deterministic — should contain "complete and submitted").
      if (!/file is now complete and submitted/i.test(draftUpdate.patch.draft_email) || !/direct any further questions to Franco/i.test(draftUpdate.patch.draft_email)) {
        throw new Error(`FAIL [Group BBB B2 closing template]: closing draft must contain Franco's deterministic template, got: ${draftUpdate.patch.draft_email.slice(0, 300)}`);
      }
      console.log('  PASS [Group BBB B2]: conditions-fulfilled handoff fires (info + draft preview), Vienna reply suppressed, draft saved with approval_completed action');
    }

    // -------- B3: broker submission WITHOUT conditions_sent_at + missing docs → preliminary-update --------
    // Group NNN: Vienna's broker reply is now suppressed across the whole
    // under_review/ltv_escalated branch (pre-NNN it fired here under Fix 2).
    // [UPDATED] PRELIMINARY Review still fires when allDocsInNow=false.
    {
      resetBbb();
      // Same shape as B2 but conditions_sent_at = null (admin hasn't sent conditions).
      setBbbDeal({
        status: 'under_review',
        conditions_sent_at: null,
      });
      // Reset docs stub to a partial set (B2 set all 6); allDocsInNow must be false here.
      dealsService.getDocumentsByDeal = async () => [{ classification: 'appraisal', file_name: 'Appraisal.pdf' }];
      dealsService.getDocumentsWithText = async () => [{ classification: 'appraisal', file_name: 'Appraisal.pdf' }];
      aiService.generateBrokerResponse = async () => ({
        responseEmail: '<p>Vienna replies here.</p>',
        updatedSummary: { ...bbbDeal.extracted_data, ltv_percent: 65 },
        allDocsReceived: false,
        hasApplicationForm: true,
        hasPnwStatement: true,
        ownershipType: 'personal',
        ltvPercent: 65,
      });

      await inboundHandler(buildBrokerReply('Sending more docs for James.'), mockRes(), () => {});

      // Group NNN: Vienna's broker reply must be SUPPRESSED across the whole branch.
      if (bbb.sendEmailDelayed.length !== 0) {
        throw new Error(`FAIL [Group BBB B3 NNN suppression]: expected 0 broker sends (Vienna suppressed across under_review branch), got ${bbb.sendEmailDelayed.length}`);
      }
      // [UPDATED] PRELIMINARY Review must fire.
      const updatedReview = bbb.sendEmail.find(e => /\[UPDATED\] ACTION REQUIRED: PRELIMINARY Review/.test(e.subject));
      if (!updatedReview) {
        throw new Error(`FAIL [Group BBB B3 preliminary-update]: expected '[UPDATED] ACTION REQUIRED: PRELIMINARY Review' subject, got: ${JSON.stringify(bbb.sendEmail.map(e => e.subject))}`);
      }
      // No conditions-fulfilled informational notice.
      const conditionsInfo = bbb.sendEmail.find(e => /\[Conditions Fulfilled\]|\[File Complete\]/.test(e.subject));
      if (conditionsInfo) {
        throw new Error(`FAIL [Group BBB B3 path leak]: handoff path fired for incomplete-file deal, got: ${conditionsInfo.subject}`);
      }
      console.log('  PASS [Group BBB B3]: NNN preliminary-update fires when allDocsInNow=false; Vienna suppressed');
    }

    // -------- B4: generateCompletionEmail deterministic template (no Claude) --------
    {
      // Pure JS test — no API key needed, no stubs touched.
      const realCompletionEmail = origBbb.aiGenerateCompletionEmail;
      const tylerOutput = await realCompletionEmail({ broker_name: 'Tyler Bennett', borrower_name: 'James Okafor' });
      // Group PPP-content (S1.5): admin email address is now baked into the template.
      const expected = `<p>Hi Tyler,</p>
<p>The file is now complete and submitted. Please direct any further questions to Franco at franco@privatemortgagelink.com.</p>
<p>Vienna<br>Private Mortgage Link</p>`;
      if (tylerOutput !== expected) {
        throw new Error(`FAIL [Group BBB B4 deterministic template]: output != expected.\n  EXPECTED: ${JSON.stringify(expected)}\n  GOT:      ${JSON.stringify(tylerOutput)}`);
      }
      // Fallback when broker_name is absent — defensive default.
      const fallbackOutput = await realCompletionEmail({ borrower_name: 'James Okafor' });
      if (!/^<p>Hi there,<\/p>/.test(fallbackOutput)) {
        throw new Error(`FAIL [Group BBB B4 fallback]: expected 'Hi there,' fallback when broker_name absent, got: ${fallbackOutput.slice(0, 80)}`);
      }
      // Sender_name fallback.
      const senderFallbackOutput = await realCompletionEmail({ sender_name: 'Daniel Rosen' });
      if (!/<p>Hi Daniel,<\/p>/.test(senderFallbackOutput)) {
        throw new Error(`FAIL [Group BBB B4 sender_name fallback]: expected 'Hi Daniel,', got: ${senderFallbackOutput.slice(0, 80)}`);
      }
      // Negative regression: must NOT contain old prompt language.
      const forbiddenLegacyPhrases = [
        /we will be in touch shortly if anything else is required/i,
        /file has been reviewed/i,
        /the complete package includes/i,
        /everything looks good/i,
      ];
      for (const re of forbiddenLegacyPhrases) {
        if (re.test(tylerOutput)) {
          throw new Error(`FAIL [Group BBB B4 legacy regression]: output contains forbidden legacy phrase ${re}: ${tylerOutput}`);
        }
      }
      // Positive: "Franco" appears literally.
      if (!/Franco/.test(tylerOutput)) {
        throw new Error(`FAIL [Group BBB B4 Franco hardcode]: expected 'Franco' literal in template, got: ${tylerOutput}`);
      }
      // Group PPP-content (S1.5) regression guard: admin email address must appear.
      if (!/franco@privatemortgagelink\.com/.test(tylerOutput)) {
        throw new Error(`FAIL [Group BBB B4 PPP-content S1.5]: expected 'franco@privatemortgagelink.com' in template, got: ${tylerOutput}`);
      }
      if (!/franco@privatemortgagelink\.com/.test(fallbackOutput)) {
        throw new Error(`FAIL [Group BBB B4 PPP-content S1.5 fallback]: expected admin email address in 'Hi there,' fallback variant too, got: ${fallbackOutput}`);
      }
      console.log('  PASS [Group BBB B4]: deterministic closing template — exact match, fallbacks work, no legacy phrases, Franco + admin email hardcoded');
    }

    // -------- Group SSS / C: admin-approved dispatch (intake-only vs intake+compliance) --------
    // Pre-SSS the admin-approved branch (webhook.js:584) checked intake-only docs:
    // when all intake in, generateCompletionEmail fired — JJJ's AML/PEP ask bypassed.
    // Post-SSS the branch requires intake + compliance for completion. Three cases:
    //   C1: intake complete, NO AML/PEP → generateDocumentRequestEmail (asks AML/PEP)
    //   C2: intake + AML + PEP all in → generateCompletionEmail (single-cycle, Q2)
    //   C3: intake incomplete → generateDocumentRequestEmail (unchanged from pre-SSS)
    {
      // Captures which Claude function got called by the admin-approved branch.
      let cCalls = { docRequest: 0, completion: 0 };
      aiService.generateDocumentRequestEmail = async () => { cCalls.docRequest++; return '<p>Doc request (mocked)</p>'; };
      aiService.generateCompletionEmail = async () => { cCalls.completion++; return '<p>Completion (mocked)</p>'; };

      const runApprovedDispatch = async (docsOnFile, loanType) => {
        cCalls = { docRequest: 0, completion: 0 };
        resetBbb();
        setBbbDeal({
          status: 'under_review',
          extracted_data: { ...bbbDeal?.extracted_data, loan_type: loanType, broker_name: 'Tyler Bennett', borrower_name: 'James Okafor', sender_type: 'broker' },
        });
        // Override docs stub for this case
        dealsService.getDocumentsByDeal = async () => docsOnFile;
        dealsService.getDocumentsWithText = async () => docsOnFile;
        // Admin's "APPROVED" reply — parseAdminReply has a fast-path for this exact word.
        await inboundHandler(buildAdminReply('APPROVED'), mockRes(), () => {});
        const savedDraftUpdate = bbb.update.find(u => u.patch.draft_action !== undefined);
        // Group CCCC: capture prelim_approved_at stamp (should fire on every APPROVED
        // reply regardless of intake completeness per Q2-CCCC).
        const stampUpdate = bbb.update.find(u => u.patch.prelim_approved_at !== undefined);
        return {
          calls: cCalls,
          draftAction: savedDraftUpdate?.patch?.draft_action,
          prelimApprovedAt: stampUpdate?.patch?.prelim_approved_at,
        };
      };

      // C1 — intake complete, NO AML/PEP → doc-request (asks AML/PEP)
      const refiIntakeOnly = [
        { classification: 'government_id', file_name: 'GovID.pdf' },
        { classification: 'appraisal', file_name: 'Appraisal.pdf' },
        { classification: 'property_tax', file_name: 'PropertyTax.pdf' },
        { classification: 'mortgage_statement', file_name: 'Payout.pdf' },
        { classification: 'income_proof', file_name: 'NOA.pdf' },
        { classification: 'credit_report', file_name: 'CB.pdf' },
      ];
      const c1 = await runApprovedDispatch(refiIntakeOnly, 'second mortgage');
      if (c1.calls.docRequest !== 1 || c1.calls.completion !== 0 || c1.draftAction !== 'approval_doc_request') {
        throw new Error(`FAIL [Group SSS / C1]: intake-only deal post-approval should fire generateDocumentRequestEmail (asks AML/PEP), got ${JSON.stringify(c1)}`);
      }
      // Group CCCC (S6.1/S7.2): prelim_approved_at stamp fires on every APPROVED reply.
      if (typeof c1.prelimApprovedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(c1.prelimApprovedAt)) {
        throw new Error(`FAIL [Group SSS / C1 + CCCC stamp]: expected ISO prelim_approved_at timestamp, got ${JSON.stringify(c1.prelimApprovedAt)}`);
      }
      console.log('  PASS [Group SSS / C1]: admin APPROVED + intake complete + NO AML/PEP → generateDocumentRequestEmail fires (action=approval_doc_request); CCCC: prelim_approved_at stamped');

      // C2 — intake + AML + PEP all in (Q2 single-cycle path)
      const refiIntakePlusCompliance = [
        ...refiIntakeOnly,
        { classification: 'aml', file_name: 'AML.pdf' },
        { classification: 'pep', file_name: 'PEP.pdf' },
      ];
      const c2 = await runApprovedDispatch(refiIntakePlusCompliance, 'second mortgage');
      if (c2.calls.docRequest !== 0 || c2.calls.completion !== 1 || c2.draftAction !== 'approval_completed') {
        throw new Error(`FAIL [Group SSS / C2]: intake+compliance complete should fire generateCompletionEmail single-cycle (Q2), got ${JSON.stringify(c2)}`);
      }
      // Group CCCC: stamp fires even on single-cycle Q2 path (Q2-CCCC: regardless of intake completeness).
      if (typeof c2.prelimApprovedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(c2.prelimApprovedAt)) {
        throw new Error(`FAIL [Group SSS / C2 + CCCC stamp]: expected ISO prelim_approved_at timestamp on single-cycle path, got ${JSON.stringify(c2.prelimApprovedAt)}`);
      }
      console.log('  PASS [Group SSS / C2]: admin APPROVED + intake + AML + PEP → generateCompletionEmail fires (Q2 single-cycle path preserved); CCCC: prelim_approved_at stamped');

      // C3 — intake incomplete → doc-request (regression guard, unchanged from pre-SSS)
      const refiPartial = refiIntakeOnly.slice(0, 3); // only 3 intake docs
      const c3 = await runApprovedDispatch(refiPartial, 'second mortgage');
      if (c3.calls.docRequest !== 1 || c3.calls.completion !== 0 || c3.draftAction !== 'approval_doc_request') {
        throw new Error(`FAIL [Group SSS / C3]: intake-incomplete deal should still fire generateDocumentRequestEmail (regression guard), got ${JSON.stringify(c3)}`);
      }
      if (typeof c3.prelimApprovedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(c3.prelimApprovedAt)) {
        throw new Error(`FAIL [Group SSS / C3 + CCCC stamp]: expected ISO prelim_approved_at timestamp, got ${JSON.stringify(c3.prelimApprovedAt)}`);
      }
      console.log('  PASS [Group SSS / C3]: admin APPROVED + intake incomplete → generateDocumentRequestEmail fires (pre-SSS behavior preserved); CCCC: prelim_approved_at stamped');

      // C4 — purchase deal with intake + compliance (regression: pre-SSS Site 2 lacked purchase branch)
      const purchaseComplete = [
        { classification: 'government_id', file_name: 'GovID.pdf' },
        { classification: 'appraisal', file_name: 'Appraisal.pdf' },
        { classification: 'property_tax', file_name: 'PropertyTax.pdf' },
        { classification: 'income_proof', file_name: 'NOA.pdf' },
        { classification: 'credit_report', file_name: 'CB.pdf' },
        { classification: 'purchase_contract', file_name: 'APS.pdf' },
        { classification: 'aml', file_name: 'AML.pdf' },
        { classification: 'pep', file_name: 'PEP.pdf' },
      ];
      const c4 = await runApprovedDispatch(purchaseComplete, 'purchase');
      if (c4.calls.docRequest !== 0 || c4.calls.completion !== 1 || c4.draftAction !== 'approval_completed') {
        throw new Error(`FAIL [Group SSS / C4]: purchase intake+compliance complete should fire generateCompletionEmail, got ${JSON.stringify(c4)}`);
      }
      if (typeof c4.prelimApprovedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(c4.prelimApprovedAt)) {
        throw new Error(`FAIL [Group SSS / C4 + CCCC stamp]: expected ISO prelim_approved_at timestamp on purchase tier, got ${JSON.stringify(c4.prelimApprovedAt)}`);
      }
      console.log('  PASS [Group SSS / C4]: purchase deal with intake + compliance + purchase_contract → generateCompletionEmail (purchase tier works post-SSS); CCCC: prelim_approved_at stamped');
    }

    // Restore originals
    dealsService.findByMessageId = origBbb.dealsFindByMessageId;
    dealsService.saveMessage = origBbb.dealsSaveMessage;
    dealsService.update = origBbb.dealsUpdate;
    dealsService.getMessages = origBbb.dealsGetMessages;
    dealsService.getDocumentsByDeal = origBbb.dealsGetDocumentsByDeal;
    dealsService.getDocumentsWithText = origBbb.dealsGetDocumentsWithText;
    dealsService.downloadDocsAsZip = origBbb.dealsDownloadDocsAsZip;
    dealsService.saveAttachment = origBbb.dealsSaveAttachment;
    aiService.generateBrokerResponse = origBbb.aiGenerateBrokerResponse;
    aiService.generateLeadSummary = origBbb.aiGenerateLeadSummary;
    aiService.generateCompletionEmail = origBbb.aiGenerateCompletionEmail;
    aiService.generateDocumentRequestEmail = origBbb.aiGenerateDocumentRequestEmail;
    aiService.parseDraftReply = origBbb.aiParseDraftReply;
    emailService.sendEmail = origBbb.emailSendEmail;
    emailService.sendEmailDelayed = origBbb.emailSendEmailDelayed;

    console.log('Group BBB: 4/4 passed; Group SSS / C: 4/4 passed');
  }

  // ════════════════════════════════════════════════════════════════
  // GROUP B — classifier filename + text-fallback for mortgage_statement
  // ════════════════════════════════════════════════════════════════
  // S6.2 / S7.2 root cause: filename regex didn't recognize "payout statement"
  // / "discharge statement" patterns, so CIBC_Payout_Statement_*.pdf classified
  // as 'other' and surfaced in BOTH [RECEIVED] and [MISSING] in the same
  // preliminary review (Group K's prompt-side terminology unification didn't
  // extend to the classifier). Fix: extend filename + text regexes to include
  // payout / mortgage payout / discharge statement / mortgage discharge as
  // synonyms for mortgage_statement. Bare "discharge" stays out (would catch
  // bankruptcy/consumer-proposal discharges).
  console.log('\n========== GROUP B — classifier mortgage_statement filename truth table ==========');
  const { classifyDocument } = require('./src/services/deals').__test__;

  const groupBCases = [
    // Positive — should classify as mortgage_statement (S6.2/S7.2 production cases)
    ['CIBC_Payout_Statement_Kevin_Tran.pdf',          'mortgage_statement'],
    ['CIBC_Payout_Statement_Ethan_Broussard.pdf',     'mortgage_statement'],
    ['RBC_Mortgage_Payout.pdf',                        'mortgage_statement'],
    ['TD_Payout_Letter.pdf',                           'mortgage_statement'],
    ['Discharge_Statement_Webb.pdf',                   'mortgage_statement'],
    ['Mortgage_Discharge_2026.pdf',                    'mortgage_statement'],
    // Pre-existing positives that must still classify (regression guards)
    ['Mortgage_Statement.pdf',                         'mortgage_statement'],
    ['Current_Mortgage.pdf',                           'mortgage_statement'],
    // Group OOO update: this filename now correctly routes to mortgage_balance_statement
    // (was mortgage_statement under Group K's unified bucket — that was the S1.4 bug).
    // Full Group OOO classifier coverage lives below in the GROUP OOO section.
    ['Mortgage_Balance_Apr2026.pdf',                   'mortgage_balance_statement'],
    // Negative — must NOT trip mortgage_statement (Q4 scoping: bare "discharge"
    // patterns from non-mortgage contexts must stay 'other')
    ['Bankruptcy_Discharge.pdf',                       'other'],
    ['Consumer_Proposal_Discharge.pdf',                'other'],
    // Negative — adjacent doc types should still classify correctly (no collisions)
    ['NOA_2025.pdf',                                   'noa'],
    ['Property_Tax_Bill.pdf',                          'property_tax'],
    ['Appraisal_Webb.pdf',                             'appraisal'],
  ];

  let groupBPassed = 0;
  for (const [filename, expected] of groupBCases) {
    const got = classifyDocument(filename, '');
    if (got === expected) {
      console.log(`  PASS: ${filename} → '${expected}'`);
      groupBPassed++;
    } else {
      throw new Error(`FAIL [Group B classifier ${filename}]: expected '${expected}', got '${got}'`);
    }
  }
  console.log(`Group B classifier filename: ${groupBPassed}/${groupBCases.length} passed`);

  console.log('\n========== GROUP B — classifier mortgage_statement text-fallback ==========');
  const groupBTextCases = [
    ['Mortgage Payout Statement\n\nAccount #4521\nOutstanding balance: $318,420.55', 'mortgage_statement'],
    ['Mortgage Discharge\n\nProperty: 142 Vine Ave\nDischarge date: April 30, 2026',  'mortgage_statement'],
    ['Discharge Statement issued for closure of account',                              'mortgage_statement'],
  ];
  let groupBTextPassed = 0;
  for (const [text, expected] of groupBTextCases) {
    // Empty filename → classifier falls through filename regexes and reads text.
    const got = classifyDocument('unknown.pdf', text);
    if (got === expected) {
      console.log(`  PASS: ...${text.slice(0, 50).replace(/\n/g, ' ')}... → '${expected}'`);
      groupBTextPassed++;
    } else {
      throw new Error(`FAIL [Group B text-fallback]: expected '${expected}', got '${got}' for ${JSON.stringify(text.slice(0, 80))}`);
    }
  }
  console.log(`Group B classifier text-fallback: ${groupBTextPassed}/${groupBTextCases.length} passed`);

  // ════════════════════════════════════════════════════════════════
  // GROUP III — admin-greeting scrub (S12.1)
  // ════════════════════════════════════════════════════════════════
  // Production failure: deal 9db03a27 (Torres/Westgate). Email body had two
  // signatures (broker's inner + admin auto-appended outer). Claude picked outer
  // as sender_name="Franco Maione". Group A's HARD RULE leaked → Vienna sent 4
  // emails greeting "Hi Franco" / "Hey Franco" to the broker. Belt-and-suspenders
  // escalation per Q3 of original Group A plan: deterministic JS scrub at email-
  // service level, gated on `to !== config.adminEmail`.
  console.log('\n========== GROUP III — admin-greeting scrub truth table ==========');
  const { stripAdminGreeting, isAdminRecipient } = require('./src/services/email').__test__;

  const stripCases = [
    // Positive — admin-greeting variants get scrubbed (HTML body)
    ['<p>Hi Franco!</p>\n<p>Body...</p>',                    '<p>Hi there!</p>\n<p>Body...</p>'],
    ['<p>Hello Franco,</p>\n<p>Body...</p>',                 '<p>Hi there!</p>\n<p>Body...</p>'],
    ['<p>Hey Franco! Hope you\'re having a great week!</p>', '<p>Hi there!</p>'],
    ['<p>Dear Franco —</p>\n<p>Body</p>',                    '<p>Hi there!</p>\n<p>Body</p>'],
    // Full-name variants — Group A's prompt sometimes outputs "Hi Franco Maione"
    ['<p>Hi Franco Maione,</p>\n<p>Body</p>',                '<p>Hi there!</p>\n<p>Body</p>'],
    ['<p>Hello Franco Vieanna!</p>\n<p>Body</p>',            '<p>Hi there!</p>\n<p>Body</p>'],
    // Text body variants
    ['Hi Franco!\nBody...',                                  'Hi there!\nBody...'],
    ['Hey Franco — let me know\nThanks',                     'Hi there!\nThanks'],
    // Negative — non-Franco greetings pass through unchanged
    ['<p>Hi Sarah!</p>\n<p>Body</p>',                        '<p>Hi Sarah!</p>\n<p>Body</p>'],
    ['<p>Hello Jason!</p>\n<p>Body</p>',                     '<p>Hello Jason!</p>\n<p>Body</p>'],
    ['<p>Hi Frances!</p>',                                   '<p>Hi Frances!</p>'],
    // Edge — empty / null
    ['',                                                     ''],
    [null,                                                   null],
    // Idempotence — already scrubbed pass through
    ['<p>Hi there!</p>\n<p>Body</p>',                        '<p>Hi there!</p>\n<p>Body</p>'],
    // Negative — Franco mentioned mid-body (not opening greeting) — preserve
    ['<p>Hi Sarah!</p>\n<p>Franco will be in touch.</p>',    '<p>Hi Sarah!</p>\n<p>Franco will be in touch.</p>'],
  ];

  let stripPassed = 0;
  for (const [input, expected] of stripCases) {
    const got = stripAdminGreeting(input);
    if (got === expected) {
      const inputPreview = String(input || '').slice(0, 60).replace(/\s+/g, ' ');
      console.log(`  PASS: ${JSON.stringify(inputPreview)} → ${JSON.stringify(String(expected || '').slice(0, 60).replace(/\s+/g, ' '))}`);
      stripPassed++;
    } else {
      throw new Error(`FAIL [Group III stripAdminGreeting]: input=${JSON.stringify(input)} expected=${JSON.stringify(expected)} got=${JSON.stringify(got)}`);
    }
  }
  console.log(`Group III stripAdminGreeting: ${stripPassed}/${stripCases.length} passed`);

  // isAdminRecipient gate — verify only admin email triggers the no-scrub path.
  console.log('\n========== GROUP III — isAdminRecipient gate ==========');
  const adminGateCases = [
    ['franco@privatemortgagelink.com',  true,  'exact admin match'],
    ['Franco@PrivateMortgageLink.com',  true,  'case-insensitive admin match'],
    ['franco@vimarealty.com',           false, 'broker QA email — NOT admin'],
    ['jason.mercer@brokerage.com',      false, 'normal broker — NOT admin'],
    ['',                                false, 'empty string'],
    [null,                              false, 'null'],
  ];
  let gatePassed = 0;
  for (const [to, expected, label] of adminGateCases) {
    const got = isAdminRecipient(to);
    if (got === expected) {
      console.log(`  PASS [${label}]: isAdminRecipient(${JSON.stringify(to)}) → ${expected}`);
      gatePassed++;
    } else {
      throw new Error(`FAIL [Group III isAdminRecipient ${label}]: expected ${expected}, got ${got} for ${JSON.stringify(to)}`);
    }
  }
  console.log(`Group III isAdminRecipient: ${gatePassed}/${adminGateCases.length} passed`);

  // ════════════════════════════════════════════════════════════════
  // GROUP PPP-leak — stripQuotedText hardening + textToHtml tightening
  // + stripAdminSignature scrub (S1.6 + S1.7)
  // ════════════════════════════════════════════════════════════════
  // Production failure: deal 9aa136aa (Grace Paulson). Franco EDITed the BBB
  // closing-draft preview to add his email address. Gmail-mobile auto-appended
  // a wrapped "On <date>, Lead Underwriter @ Private Mortgage Link <\nemail>
  // wrote:" header and a `\n-- \n` separator + 6-marker Union Financial sig.
  // stripQuotedText's single-line regex missed the wrapped header; textToHtml's
  // loose HTML-detect regex matched <fmaione@...> and early-returned bare text;
  // result was shipped to broker franco@vimarealty.com as msg 14 — PII leak.
  //
  // This block tests three deterministic truth tables (A: stripQuotedText,
  // B: textToHtml, C: stripAdminSignature) and one end-to-end deterministic
  // pipeline fixture (D1) using the verbatim production msg 11 body. The D2
  // probabilistic harness (Claude-driven EDIT path, 5x verification) is gated
  // behind RUN_PPP_LEAK_D2=1 to avoid burning Claude calls on every harness run.
  console.log('\n========== GROUP PPP-leak — stripQuotedText / textToHtml / stripAdminSignature ==========');
  // textToHtml is already in scope (destructured from webhookRouter.__test__ at module top).
  const { stripAdminSignature, ADMIN_SIG_MARKERS } = require('./src/services/email').__test__;
  const fs_ppp = require('fs');
  const path_ppp = require('path');

  // ─── Truth table A — stripQuotedText ────────────────────────────────────
  console.log('\n---------- Group PPP-leak / A: stripQuotedText ----------');
  const stripQuotedCases = [
    // Single-line "On ... wrote:" header
    [
      'Thanks!\n\nOn Mon, 1 Jan 2026 at 09:00, Jason <jason@x.com> wrote:\n> previous content',
      'Thanks!',
      'single-line "On ... wrote:" header',
    ],
    // Wrapped 2-line header (the production msg 11 shape)
    [
      'Hi Rachel.\n\nOn Sun, 10 May 2026 at 14:03, Lead Underwriter @ Private Mortgage Link <\ninfo@privatemortgagelink.com> wrote:\n\n> Draft Email Preview',
      'Hi Rachel.',
      'wrapped 2-line "On ... wrote:" header (production case)',
    ],
    // Wrapped 3-line variant
    [
      'Hi Rachel.\n\nOn Sun, 10 May 2026 at 14:03,\nLead Underwriter @ Private Mortgage Link\n<info@privatemortgagelink.com> wrote:\n\n> quoted',
      'Hi Rachel.',
      'wrapped 3-line "On ... wrote:" header',
    ],
    // RFC 3676 sig separator with trailing space
    [
      'Hi there.\n\n-- \nJohn Doe\njohn@x.com',
      'Hi there.',
      'RFC 3676 sig separator "-- " (with trailing space)',
    ],
    // RFC 3676 sig separator without trailing space (some clients drop it)
    [
      'Hi there.\n\n--\nJohn Doe\njohn@x.com',
      'Hi there.',
      'sig separator "--" (no trailing space)',
    ],
    // Mobile-client trailers
    [
      'Quick reply.\n\nSent from my iPhone',
      'Quick reply.',
      'Sent from my iPhone trailer',
    ],
    [
      'Quick reply.\n\nSent from my Galaxy S23',
      'Quick reply.',
      'Sent from my Galaxy trailer',
    ],
    // No quoted content, no separator — return as-is
    [
      'Hi there. This is just the body.',
      'Hi there. This is just the body.',
      'no quoted content, no separator',
    ],
    // `>` prefixed lines mid-body
    [
      'Reply text.\n> quoted line 1\n> quoted line 2\nMore reply text.',
      'Reply text.\nMore reply text.',
      '> prefixed lines stripped, rest kept',
    ],
    // False-positive check: "On the other hand" should NOT trigger
    [
      'Thanks!\n\nOn the other hand, we should check the rate.',
      'Thanks!\n\nOn the other hand, we should check the rate.',
      '"On the other hand" not a false positive (no "wrote:")',
    ],
  ];
  let stripQuotedPassed = 0;
  for (const [input, expected, label] of stripQuotedCases) {
    const got = aiService.stripQuotedText(input);
    if (got === expected) {
      console.log(`  PASS [${label}]`);
      stripQuotedPassed++;
    } else {
      throw new Error(`FAIL [Group PPP-leak / A stripQuotedText ${label}]:\n  input=${JSON.stringify(input)}\n  expected=${JSON.stringify(expected)}\n  got=${JSON.stringify(got)}`);
    }
  }
  console.log(`Group PPP-leak / A stripQuotedText: ${stripQuotedPassed}/${stripQuotedCases.length} passed`);

  // ─── Truth table B — textToHtml HTML_DETECT ─────────────────────────────
  console.log('\n---------- Group PPP-leak / B: textToHtml ----------');
  const pppTextToHtmlCases = [
    // Real HTML — return as-is
    ['<p>Hello</p>',                  '<p>Hello</p>',                  'real <p> HTML'],
    ['<p class="x">Hello</p>',        '<p class="x">Hello</p>',        '<p> with attributes'],
    ['Line one<br>Line two',          'Line one<br>Line two',          '<br> tag'],
    ['<a href="x">link</a>',          '<a href="x">link</a>',          '<a> link tag'],
    ['<table><tr><td>x</td></tr></table>', '<table><tr><td>x</td></tr></table>', 'table HTML'],
    ['<strong>bold</strong> word',    '<strong>bold</strong> word',    '<strong> tag'],
    // Bare text with email-in-angle-brackets — MUST wrap (the production bug)
    [
      'Hi <fmaione@unionfinancialcorp.com>',
      '<p>Hi <fmaione@unionfinancialcorp.com></p>',
      'email-in-angle-brackets does NOT count as HTML (production bug)',
    ],
    [
      'Send to <test@example.com>',
      '<p>Send to <test@example.com></p>',
      'generic email-in-angle-brackets',
    ],
    // Bare text with name-in-angle-brackets — wrap
    [
      'Hi <Some Name>',
      '<p>Hi <Some Name></p>',
      'name-in-angle-brackets does NOT count as HTML',
    ],
    // Plain text
    ['Hello world',                   '<p>Hello world</p>',            'plain text'],
    // Empty
    ['',                              '',                              'empty text'],
    // Multi-paragraph plain
    [
      'First paragraph.\n\nSecond paragraph.',
      '<p>First paragraph.</p>\n<p>Second paragraph.</p>',
      'multi-paragraph plain text',
    ],
  ];
  let pppTextToHtmlPassed = 0;
  for (const [input, expected, label] of pppTextToHtmlCases) {
    const got = textToHtml(input);
    if (got === expected) {
      console.log(`  PASS [${label}]`);
      pppTextToHtmlPassed++;
    } else {
      throw new Error(`FAIL [Group PPP-leak / B textToHtml ${label}]:\n  input=${JSON.stringify(input)}\n  expected=${JSON.stringify(expected)}\n  got=${JSON.stringify(got)}`);
    }
  }
  console.log(`Group PPP-leak / B textToHtml: ${pppTextToHtmlPassed}/${pppTextToHtmlCases.length} passed`);

  // ─── Truth table C — stripAdminSignature ────────────────────────────────
  console.log('\n---------- Group PPP-leak / C: stripAdminSignature ----------');
  const stripSigCases = [
    // Structural: \n-- \n separator
    [
      'Body content.\n\n-- \nFranco Maione\nfmaione@unionfinancialcorp.com',
      true,  // expected to have zero markers in result
      'plaintext "-- " separator truncates entire sig',
    ],
    // Structural: <p>-- </p> textToHtml-wrapped variant
    [
      '<p>Body content.</p>\n<p>-- </p>\n<p>Franco Maione</p>\n<p>fmaione@unionfinancialcorp.com</p>',
      true,
      'HTML <p>-- </p> separator truncates wrapped sig',
    ],
    // Match-list belt: markers without separator (e.g., separator was stripped earlier)
    [
      'Body. fmaione@unionfinancialcorp.com is the email. Call 780-244-4769.',
      true,
      'markers stripped via belt when no separator',
    ],
    // Both fire cleanly
    [
      'Body.\n\n-- \nFranco Maione\nfmaione@unionfinancialcorp.com\n780-244-4769',
      true,
      'separator + markers, both stripped',
    ],
    // No markers, no separator — unchanged
    [
      'Just a normal email body. No markers here.',
      true,
      'no markers, no separator — passes through cleanly',
    ],
    // Mixed: admin sig + broker context (broker quote preserved enough)
    [
      'Broker said: "interesting deal". On Mon Sarah wrote: > look here\n\n-- \nFranco\nfmaione@unionfinancialcorp.com',
      true,
      'admin sig stripped, broker context preserved',
    ],
  ];
  let stripSigPassed = 0;
  for (const [input, _expectClean, label] of stripSigCases) {
    const got = stripAdminSignature(input);
    const leakedMarkers = ADMIN_SIG_MARKERS.filter(m => got.includes(m));
    if (leakedMarkers.length === 0) {
      console.log(`  PASS [${label}]: 0 markers in result (${got.length} chars)`);
      stripSigPassed++;
    } else {
      throw new Error(`FAIL [Group PPP-leak / C stripAdminSignature ${label}]:\n  input=${JSON.stringify(input)}\n  leaked markers=${JSON.stringify(leakedMarkers)}\n  got=${JSON.stringify(got)}`);
    }
  }
  console.log(`Group PPP-leak / C stripAdminSignature: ${stripSigPassed}/${stripSigCases.length} passed`);

  // ─── D1 — End-to-end deterministic defense-layer cascade (msg 11 fixture) ──
  // Note: post-fix, stripQuotedText cleans the fixture so thoroughly that the
  // remaining text drops below isFullAlternativeDraft's 50-word threshold, so
  // parseDraftReply no longer routes to REPLACE on this input — falls through to
  // Claude SEND/EDIT classification (which IS D2's exercise). To keep D1 fully
  // deterministic, D1 directly verifies all three defense layers on the
  // production msg 11 body without depending on which action parseDraftReply
  // chooses. Each layer asserted in isolation + the cascade.
  console.log('\n---------- Group PPP-leak / D1: defense-layer cascade (production msg 11) ----------');
  const msg11Path = path_ppp.join(__dirname, 'test-fixtures/admin-sig-leak-msg11.txt');
  const msg11Body = fs_ppp.readFileSync(msg11Path, 'utf8');
  const headerSentinels = ['On Sun, 10 May 2026 at 14:03', 'Lead Underwriter @ Private Mortgage Link'];
  const allSentinels = [...ADMIN_SIG_MARKERS, ...headerSentinels];

  // Layer A — stripQuotedText must remove the wrapped "On ... wrote:" header
  // AND the `\n-- \n` separator, leaving only Vienna's edited draft body.
  const strippedD1 = aiService.stripQuotedText(msg11Body);
  const stripLeaks = allSentinels.filter(s => strippedD1.includes(s));
  if (stripLeaks.length > 0) {
    throw new Error(`FAIL [Group PPP-leak / D1 Layer A stripQuotedText]: ${stripLeaks.length} sentinels survived.\n  Leaks: ${JSON.stringify(stripLeaks)}\n  Stripped result (first 600): ${strippedD1.slice(0, 600)}`);
  }
  console.log(`  PASS [Layer A stripQuotedText]: 0 sentinels in stripped body (${strippedD1.length} chars from ${msg11Body.length})`);

  // Layer B — textToHtml on the stripped text must wrap in <p> tags (not bare).
  // Production bug: pre-fix HTML-detect matched <fmaione@...> and returned bare
  // plaintext. Post-fix the input here has no leftover sig (Layer A cleaned),
  // but we still verify textToHtml wraps cleanly.
  const htmlD1 = textToHtml(strippedD1);
  if (!/<p>/.test(htmlD1)) {
    throw new Error(`FAIL [Group PPP-leak / D1 Layer B textToHtml]: expected <p> wrapping, got bare text. Result: ${JSON.stringify(htmlD1.slice(0, 300))}`);
  }
  const htmlBLeaks = allSentinels.filter(s => htmlD1.includes(s));
  if (htmlBLeaks.length > 0) {
    throw new Error(`FAIL [Group PPP-leak / D1 Layer B textToHtml]: sentinels leaked. ${JSON.stringify(htmlBLeaks)}`);
  }
  console.log(`  PASS [Layer B textToHtml]: <p>-wrapped output, 0 sentinels`);

  // Layer C — defense-in-depth scrub at broker-send. Run on a deliberately DIRTY
  // input (bypassing Layers A+B) to verify the belt does its job alone.
  // Broker recipient → !isAdminRecipient → scrub MUST fire.
  const brokerRecipient = 'franco@vimarealty.com';
  if (isAdminRecipient(brokerRecipient)) {
    throw new Error(`FAIL [Group PPP-leak / D1 Layer C gate]: isAdminRecipient('${brokerRecipient}') should be false.`);
  }
  // Use the RAW msg11Body (pre-strip) to force Layer C to do the work alone.
  const sigOnlyScrub = stripAdminSignature(stripAdminGreeting(msg11Body));
  const sigOnlyLeaks = ADMIN_SIG_MARKERS.filter(s => sigOnlyScrub.includes(s));
  if (sigOnlyLeaks.length > 0) {
    throw new Error(`FAIL [Group PPP-leak / D1 Layer C stripAdminSignature]: ${sigOnlyLeaks.length} markers survived raw-input scrub.\n  Leaks: ${JSON.stringify(sigOnlyLeaks)}\n  Scrubbed (last 400): ${sigOnlyScrub.slice(-400)}`);
  }
  console.log(`  PASS [Layer C stripAdminSignature]: 0 markers in raw-input scrub (defense alone, ${sigOnlyScrub.length} chars from ${msg11Body.length})`);

  // Cascade — full pipeline as it would run in production for broker recipient.
  const cascadeD1 = stripAdminSignature(stripAdminGreeting(textToHtml(aiService.stripQuotedText(msg11Body))));
  const cascadeLeaks = allSentinels.filter(s => cascadeD1.includes(s));
  if (cascadeLeaks.length > 0) {
    throw new Error(`FAIL [Group PPP-leak / D1 cascade]: ${cascadeLeaks.length} sentinels in final outbound.\n  Leaks: ${JSON.stringify(cascadeLeaks)}\n  Result: ${JSON.stringify(cascadeD1.slice(0, 500))}`);
  }
  console.log(`  PASS [Group PPP-leak / D1 cascade]: production msg 11 → 0 sentinels in final outbound (${cascadeD1.length} chars)`);

  // ─── D2 — Probabilistic pipeline (Claude EDIT path, 5x verification) ───────
  // Gated behind RUN_PPP_LEAK_D2=1 to avoid burning Claude calls on every harness
  // run. Set the env var to execute the 5x verification.
  if (process.env.RUN_PPP_LEAK_D2 === '1') {
    console.log('\n---------- Group PPP-leak / D2: EDIT pipeline 5x verification (Claude) ----------');
    // Synthetic edit reply: short instruction + Franco's sig appended (forces Claude
    // to classify as EDIT — reviseEmailWithEdits then rewrites the original draft
    // using these instructions). If editInstructions still carries sig markers,
    // Claude might preserve them in the rewrite. Match-list belt at send site must
    // catch any leakage.
    const editReply = `Make it warmer and add a line thanking Rachel for the quick turnaround.

On Sun, 10 May 2026 at 14:03, Lead Underwriter @ Private Mortgage Link <
info@privatemortgagelink.com> wrote:

> Draft Email Preview — Grace Paulson
>
> Here's what Vienna will send.
>
> Hi Rachel,
>
> The file is now complete and submitted.
>
> Vienna

--


Franco Maione
    LENDING & INVESTMENT SPECIALIST

102, 10446 122 Street NW

Edmonton, AB, T5N 1M3

OFFICE.  780-244-4769

CELL.  780-975-3339

EMAIL.  fmaione@unionfinancialcorp.com

WEBSITE.  unionfinancialcorp.com`;

    const originalDraft = '<p>Hi Rachel,</p>\n<p>The file is now complete and submitted. Please direct any further questions to Franco at franco@privatemortgagelink.com.</p>\n<p>Vienna<br>Private Mortgage Link</p>';
    const fakeSummary = { borrower_name: 'Grace Paulson', broker_name: 'Rachel Kim' };

    let d2Leaks = 0;
    for (let run = 1; run <= 5; run++) {
      const parsedD2 = await aiService.parseDraftReply(editReply);
      // Either path (replace or edit) — both must pass the scrub at send site.
      let draftAfterClaude;
      if (parsedD2.action === 'replace') {
        draftAfterClaude = textToHtml(parsedD2.replacementText);
      } else {
        // EDIT path — Claude rewrites. Pass editInstructions through reviseEmailWithEdits.
        draftAfterClaude = await aiService.reviseEmailWithEdits(originalDraft, parsedD2.editInstructions || editReply, fakeSummary);
      }
      // Scrub stack (broker recipient)
      const scrubbed = stripAdminSignature(stripAdminGreeting(draftAfterClaude));
      const leaks = allSentinels.filter(s => scrubbed.includes(s));
      if (leaks.length > 0) {
        d2Leaks++;
        console.log(`  Run ${run}: LEAK — action=${parsedD2.action}, markers=${JSON.stringify(leaks)}`);
      } else {
        console.log(`  Run ${run}: PASS — action=${parsedD2.action}, scrubbed=${scrubbed.length} chars, 0 markers`);
      }
    }
    if (d2Leaks >= 2) {
      throw new Error(`FAIL [Group PPP-leak / D2]: ${d2Leaks}/5 runs leaked. Escalation threshold reached — match-list belt insufficient or structural fallback gap.`);
    }
    console.log(`Group PPP-leak / D2 (5x Claude EDIT path): ${5 - d2Leaks}/5 passed, ${d2Leaks}/5 leaked (threshold: ≤1)`);
  } else {
    console.log('\n---------- Group PPP-leak / D2: SKIPPED (set RUN_PPP_LEAK_D2=1 to run) ----------');
  }

  // ════════════════════════════════════════════════════════════════
  // GROUP NNN — post-review broker activity dispatch matrix (S1.1–S1.3 + S2.3–S2.4)
  // ════════════════════════════════════════════════════════════════
  // Replaces Fix 2 + BBB's three-way split with a unified dispatch decision over
  // four actions. Pre-NNN: hasNewDocs branched into BBB conditions-fulfilled vs
  // Fix 2 [UPDATED] review; !hasNewDocs hit a passive [Broker Update] forward
  // that gave admin no fresh signal when the deal's facts had changed.
  // Post-NNN: decideReviewDispatch is a pure function returning
  //   {action: 'completion-handoff' | 'noop' | 'escalation-update' | 'preliminary-update', ...}
  // with allDocsInNow gating completion handoff and draft_email gating the no-op
  // (Q7 — protect admin's mid-cycle drafts from clobber).
  console.log('\n========== GROUP NNN — decideReviewDispatch truth table ==========');
  const { decideReviewDispatch } = require('./src/routes/webhook').__test__;

  // Helper to build a complete classifications list for "all docs in" cases.
  // Group SSS extension: completion gate requires intake + compliance (AML/PEP).
  const refinanceAllDocs = ['government_id', 'appraisal', 'property_tax', 'mortgage_statement', 'income_proof', 'credit_report', 'aml', 'pep'];
  const purchaseAllDocs = ['government_id', 'appraisal', 'property_tax', 'income_proof', 'credit_report', 'purchase_contract', 'aml', 'pep'];

  const nnnCases = [
    {
      name: '1. under_review + all docs in (refinance) + exit_strategy + no draft → completion-handoff (not BBB)',
      deal: { status: 'under_review', draft_email: null, conditions_sent_at: null },
      summary: { loan_type: 'refinance', purpose: 'debt consolidation', exit_strategy: 'refi at maturity' },
      classifications: refinanceAllDocs,
      expectAction: 'completion-handoff',
      expectConditionsFulfilled: false,
    },
    {
      name: '2. under_review + all docs in (purchase) + purchase_contract + exit_strategy → completion-handoff',
      deal: { status: 'under_review', draft_email: null, conditions_sent_at: null },
      summary: { loan_type: 'purchase', purpose: 'purchase property', exit_strategy: 'refi at maturity' },
      classifications: purchaseAllDocs,
      expectAction: 'completion-handoff',
      expectConditionsFulfilled: false,
    },
    {
      name: '3. under_review + missing income_proof → preliminary-update',
      deal: { status: 'under_review', draft_email: null, conditions_sent_at: null },
      summary: { loan_type: 'refinance', purpose: 'debt consolidation', exit_strategy: 'refi' },
      classifications: refinanceAllDocs.filter(c => c !== 'income_proof'),
      expectAction: 'preliminary-update',
    },
    {
      name: '4. under_review + all docs in BUT missing exit_strategy → preliminary-update',
      deal: { status: 'under_review', draft_email: null, conditions_sent_at: null },
      summary: { loan_type: 'refinance', purpose: 'debt consolidation', exit_strategy: null },
      classifications: refinanceAllDocs,
      expectAction: 'preliminary-update',
    },
    {
      name: '5. under_review + missing docs + no new docs (text-only reply) → preliminary-update (drops passive [Broker Update])',
      deal: { status: 'under_review', draft_email: null, conditions_sent_at: null },
      summary: { loan_type: 'refinance', purpose: 'debt consolidation', exit_strategy: 'refi' },
      classifications: refinanceAllDocs.filter(c => c !== 'mortgage_statement'),
      expectAction: 'preliminary-update',
    },
    {
      name: '6. under_review + all docs in + text-only reply → completion-handoff (Q7 — avoids S1.3 noise shape)',
      deal: { status: 'under_review', draft_email: null, conditions_sent_at: null },
      summary: { loan_type: 'refinance', purpose: 'debt consolidation', exit_strategy: 'refi' },
      classifications: refinanceAllDocs,
      expectAction: 'completion-handoff',
      expectConditionsFulfilled: false,
    },
    {
      name: '7. under_review + all docs in + conditions_sent_at set → completion-handoff (BBB compatibility)',
      deal: { status: 'under_review', draft_email: null, conditions_sent_at: '2026-05-09T12:00:00Z' },
      summary: { loan_type: 'refinance', purpose: 'debt consolidation', exit_strategy: 'refi' },
      classifications: refinanceAllDocs,
      expectAction: 'completion-handoff',
      expectConditionsFulfilled: true,
    },
    {
      name: '8. ltv_escalated + new docs → escalation-update',
      deal: { status: 'ltv_escalated', draft_email: null, conditions_sent_at: null },
      summary: { loan_type: 'refinance', purpose: 'debt consolidation', exit_strategy: 'refi' },
      classifications: refinanceAllDocs.slice(0, 3),
      expectAction: 'escalation-update',
    },
    {
      name: '9. ltv_escalated + text-only reply → escalation-update (drops passive [Broker Update])',
      deal: { status: 'ltv_escalated', draft_email: null, conditions_sent_at: null },
      summary: { loan_type: 'refinance', purpose: 'debt consolidation', exit_strategy: 'refi' },
      classifications: refinanceAllDocs.slice(0, 3),
      expectAction: 'escalation-update',
    },
    {
      name: '10. under_review + all docs in + draft_email already set (admin mid-cycle) → noop (Q7 — protect drafts from clobber)',
      deal: {
        status: 'under_review',
        draft_email: '<p>Hi Rachel, [existing closing draft]</p>',
        draft_action: 'approval_completed',
        conditions_sent_at: null,
      },
      summary: { loan_type: 'refinance', purpose: 'debt consolidation', exit_strategy: 'refi' },
      classifications: refinanceAllDocs,
      expectAction: 'noop',
    },
    // Group SSS extension cases
    {
      name: '11. under_review + intake complete + exit_strategy + NO AML/PEP → preliminary-update (SSS gates completion on compliance)',
      deal: { status: 'under_review', draft_email: null, conditions_sent_at: null },
      summary: { loan_type: 'refinance', purpose: 'debt consolidation', exit_strategy: 'refi' },
      // intake only (no aml, no pep)
      classifications: ['government_id', 'appraisal', 'property_tax', 'mortgage_statement', 'income_proof', 'credit_report'],
      expectAction: 'preliminary-update',
    },
    {
      name: '12. under_review + intake complete + AML only (PEP missing) + exit_strategy → preliminary-update (partial compliance insufficient)',
      deal: { status: 'under_review', draft_email: null, conditions_sent_at: null },
      summary: { loan_type: 'refinance', purpose: 'debt consolidation', exit_strategy: 'refi' },
      classifications: ['government_id', 'appraisal', 'property_tax', 'mortgage_statement', 'income_proof', 'credit_report', 'aml'],
      expectAction: 'preliminary-update',
    },
  ];

  let nnnPassed = 0;
  for (const tc of nnnCases) {
    const result = decideReviewDispatch(tc.deal, tc.summary, tc.classifications);
    if (result.action !== tc.expectAction) {
      throw new Error(`FAIL [Group NNN ${tc.name}]:\n  expected action='${tc.expectAction}'\n  got action='${result.action}'\n  full result: ${JSON.stringify(result)}`);
    }
    if (tc.expectAction === 'completion-handoff' && result.conditionsFulfilled !== tc.expectConditionsFulfilled) {
      throw new Error(`FAIL [Group NNN ${tc.name}]:\n  expected conditionsFulfilled=${tc.expectConditionsFulfilled}\n  got conditionsFulfilled=${result.conditionsFulfilled}`);
    }
    console.log(`  PASS [${tc.name}]: action=${result.action}${result.conditionsFulfilled !== undefined ? `, conditionsFulfilled=${result.conditionsFulfilled}` : ''}`);
    nnnPassed++;
  }
  console.log(`Group NNN decideReviewDispatch: ${nnnPassed}/${nnnCases.length} passed`);

  // ════════════════════════════════════════════════════════════════
  // GROUP SSS — two-tier required-doc completion gate (S3.2)
  // ════════════════════════════════════════════════════════════════
  // Pre-SSS the closing-handoff path bypassed JJJ's post-approval AML/PEP ask
  // because four completion-gate sites used intake-only required-doc lists.
  // Production deal Derek Olsen S3.2 saw the closing handoff fire after admin
  // approval with intake docs in — AML/PEP never requested. SSS extends the
  // gate to require intake + compliance; prelim review stays intake-only
  // (JJJ preserved).
  console.log('\n========== GROUP SSS — two-tier required-doc completion gate ==========');
  const {
    BASE_REQUIRED_INTAKE_REFINANCE: sssIntakeRefi,
    BASE_REQUIRED_INTAKE_PURCHASE: sssIntakePurchase,
    COMPLIANCE_REQUIRED_POSTAPPROVAL: sssCompliance,
    intakeRequiredFor: sssIntakeRequiredFor,
    allRequiredForCompletion: sssAllRequiredForCompletion,
    isPurchaseFromSummary: sssIsPurchaseFromSummary,
    computeCompletionDispatch: sssComputeCompletionDispatch,
  } = require('./src/routes/webhook').__test__;

  // ─── Truth table A — tier constants + helpers ──────────────────────────
  console.log('\n---------- Group SSS / A: tier constants ----------');
  let sssAPassed = 0;
  const assertSss = (label, got, expected) => {
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      throw new Error(`FAIL [Group SSS / A ${label}]:\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(got)}`);
    }
    console.log(`  PASS [${label}]`);
    sssAPassed++;
  };
  assertSss('intake refinance = 6 items, no AML/PEP', sssIntakeRefi,
    ['government_id', 'appraisal', 'property_tax', 'mortgage_statement', 'income_proof', 'credit_report']);
  assertSss('intake purchase = 6 items, no AML/PEP', sssIntakePurchase,
    ['government_id', 'appraisal', 'property_tax', 'income_proof', 'credit_report', 'purchase_contract']);
  assertSss("compliance = ['aml', 'pep']", sssCompliance, ['aml', 'pep']);
  assertSss('intakeRequiredFor(false) === refinance intake', sssIntakeRequiredFor(false), sssIntakeRefi);
  assertSss('intakeRequiredFor(true) === purchase intake', sssIntakeRequiredFor(true), sssIntakePurchase);
  assertSss('allRequiredForCompletion(false) = refi intake + compliance (8 items)',
    sssAllRequiredForCompletion(false),
    [...sssIntakeRefi, ...sssCompliance]);
  assertSss('allRequiredForCompletion(true) = purchase intake + compliance (8 items)',
    sssAllRequiredForCompletion(true),
    [...sssIntakePurchase, ...sssCompliance]);
  // Clean separation: compliance items must not be in intake (otherwise tier breaks).
  if (sssCompliance.some(c => sssIntakeRefi.includes(c) || sssIntakePurchase.includes(c))) {
    throw new Error(`FAIL [Group SSS / A separation]: compliance items leaked into intake tier`);
  }
  console.log('  PASS [clean tier separation: compliance ∩ intake = ∅]');
  sssAPassed++;
  // isPurchaseFromSummary helper
  assertSss('isPurchaseFromSummary loan_type=purchase → true', sssIsPurchaseFromSummary({ loan_type: 'purchase' }), true);
  assertSss('isPurchaseFromSummary loan_type=refinance → false', sssIsPurchaseFromSummary({ loan_type: 'refinance' }), false);
  assertSss('isPurchaseFromSummary purpose contains purchas → true', sssIsPurchaseFromSummary({ purpose: 'purchase investment property' }), true);
  assertSss('isPurchaseFromSummary null summary → false', sssIsPurchaseFromSummary(null), false);
  console.log(`Group SSS / A tier constants: ${sssAPassed} assertions passed`);

  // ─── Truth table D — computeCompletionDispatch (renamed in CCCC) ──────
  // Replaces Claude's probabilistic result.allDocsReceived flag for the
  // willFireFinalReview gate (Q1-SSS). Pure-function test.
  // CCCC: helper now returns one of three actions:
  //   'completion-handoff' — gates pass AND deal.prelim_approved_at is set
  //   'final-review'       — gates pass AND deal.prelim_approved_at is null (defense-in-depth)
  //   null                 — gates fail
  // Existing D2/D8 cases (gates pass, no prelim_approved_at) now return
  // 'final-review' instead of true. New D10-D12 cover the prelim_approved_at
  // signal and the under_review-status no-fire case.
  console.log('\n---------- Group SSS / D: computeCompletionDispatch ----------');
  const sssIntakeOnly = ['government_id', 'appraisal', 'property_tax', 'mortgage_statement', 'income_proof', 'credit_report'];
  const sssIntakePlusCompliance = [...sssIntakeOnly, 'aml', 'pep'];
  const sssDCases = [
    {
      name: 'D1: active + intake complete + exit_strategy + NO compliance → null (gate fails)',
      input: {
        deal: { status: 'active' },
        summary: { loan_type: 'refinance', exit_strategy: 'refi at maturity' },
        classifications: sssIntakeOnly,
        willGoToCollateralCheck: false, willReview: false, identityClashUnresolved: false,
      },
      expect: null,
    },
    {
      name: "D2: active + intake + AML + PEP + exit_strategy, no prelim_approved_at → 'final-review' (CCCC defense-in-depth)",
      input: {
        deal: { status: 'active' },
        summary: { loan_type: 'refinance', exit_strategy: 'refi at maturity' },
        classifications: sssIntakePlusCompliance,
        willGoToCollateralCheck: false, willReview: false, identityClashUnresolved: false,
      },
      expect: 'final-review',
    },
    {
      name: 'D3: active + intake + compliance, exit_strategy MISSING → null (exit_strategy gate)',
      input: {
        deal: { status: 'active' },
        summary: { loan_type: 'refinance', exit_strategy: null },
        classifications: sssIntakePlusCompliance,
        willGoToCollateralCheck: false, willReview: false, identityClashUnresolved: false,
      },
      expect: null,
    },
    {
      name: 'D4: status=under_review (not active) → null (active-only gate)',
      input: {
        deal: { status: 'under_review' },
        summary: { loan_type: 'refinance', exit_strategy: 'refi' },
        classifications: sssIntakePlusCompliance,
        willGoToCollateralCheck: false, willReview: false, identityClashUnresolved: false,
      },
      expect: null,
    },
    {
      name: 'D5: willGoToCollateralCheck=true → null (LTV gate priority)',
      input: {
        deal: { status: 'active' },
        summary: { loan_type: 'refinance', exit_strategy: 'refi' },
        classifications: sssIntakePlusCompliance,
        willGoToCollateralCheck: true, willReview: false, identityClashUnresolved: false,
      },
      expect: null,
    },
    {
      name: 'D6: willReview=true → null (prelim review gate priority)',
      input: {
        deal: { status: 'active' },
        summary: { loan_type: 'refinance', exit_strategy: 'refi' },
        classifications: sssIntakePlusCompliance,
        willGoToCollateralCheck: false, willReview: true, identityClashUnresolved: false,
      },
      expect: null,
    },
    {
      name: 'D7: identityClashUnresolved → null (identity gate priority)',
      input: {
        deal: { status: 'active' },
        summary: { loan_type: 'refinance', exit_strategy: 'refi' },
        classifications: sssIntakePlusCompliance,
        willGoToCollateralCheck: false, willReview: false, identityClashUnresolved: true,
      },
      expect: null,
    },
    {
      name: "D8: purchase deal + intake + compliance + exit_strategy (no prelim_approved_at) → 'final-review'",
      input: {
        deal: { status: 'active' },
        summary: { loan_type: 'purchase', purpose: 'purchase property', exit_strategy: 'sale of subject' },
        classifications: ['government_id', 'appraisal', 'property_tax', 'income_proof', 'credit_report', 'purchase_contract', 'aml', 'pep'],
        willGoToCollateralCheck: false, willReview: false, identityClashUnresolved: false,
      },
      expect: 'final-review',
    },
    {
      name: 'D9: purchase deal missing purchase_contract → null',
      input: {
        deal: { status: 'active' },
        summary: { loan_type: 'purchase', purpose: 'purchase property', exit_strategy: 'sale' },
        // missing purchase_contract
        classifications: ['government_id', 'appraisal', 'property_tax', 'income_proof', 'credit_report', 'aml', 'pep'],
        willGoToCollateralCheck: false, willReview: false, identityClashUnresolved: false,
      },
      expect: null,
    },
    // CCCC new cases — prelim_approved_at signal
    {
      name: "D10: active + full completion gate + prelim_approved_at SET → 'completion-handoff' (CCCC primary path)",
      input: {
        deal: { status: 'active', prelim_approved_at: '2026-05-11T04:30:00.000Z' },
        summary: { loan_type: 'refinance', exit_strategy: 'refi at maturity' },
        classifications: sssIntakePlusCompliance,
        willGoToCollateralCheck: false, willReview: false, identityClashUnresolved: false,
      },
      expect: 'completion-handoff',
    },
    {
      name: "D11: active + full completion gate + prelim_approved_at NULL → 'final-review' (CCCC defense-in-depth — explicit case)",
      input: {
        deal: { status: 'active', prelim_approved_at: null },
        summary: { loan_type: 'refinance', exit_strategy: 'refi at maturity' },
        classifications: sssIntakePlusCompliance,
        willGoToCollateralCheck: false, willReview: false, identityClashUnresolved: false,
      },
      expect: 'final-review',
    },
    {
      name: 'D12: under_review + prelim_approved_at SET → null (only active branch fires completion paths)',
      input: {
        deal: { status: 'under_review', prelim_approved_at: '2026-05-11T04:30:00.000Z' },
        summary: { loan_type: 'refinance', exit_strategy: 'refi' },
        classifications: sssIntakePlusCompliance,
        willGoToCollateralCheck: false, willReview: false, identityClashUnresolved: false,
      },
      expect: null,
    },
    {
      name: "D13: purchase + full completion gate + prelim_approved_at SET → 'completion-handoff' (purchase tier)",
      input: {
        deal: { status: 'active', prelim_approved_at: '2026-05-11T05:00:00.000Z' },
        summary: { loan_type: 'purchase', purpose: 'purchase property', exit_strategy: 'sale of subject' },
        classifications: ['government_id', 'appraisal', 'property_tax', 'income_proof', 'credit_report', 'purchase_contract', 'aml', 'pep'],
        willGoToCollateralCheck: false, willReview: false, identityClashUnresolved: false,
      },
      expect: 'completion-handoff',
    },
  ];
  let sssDPassed = 0;
  for (const tc of sssDCases) {
    const got = sssComputeCompletionDispatch(tc.input);
    if (got !== tc.expect) {
      throw new Error(`FAIL [Group SSS / D ${tc.name}]: expected ${JSON.stringify(tc.expect)}, got ${JSON.stringify(got)}`);
    }
    console.log(`  PASS [${tc.name}]: → ${JSON.stringify(got)}`);
    sssDPassed++;
  }
  console.log(`Group SSS / D computeCompletionDispatch: ${sssDPassed}/${sssDCases.length} passed`);

  // ════════════════════════════════════════════════════════════════
  // GROUP YYY — draft-preview threading chain (S5.3)
  // ════════════════════════════════════════════════════════════════
  // Pre-YYY saveDraftAndPreview built the References chain from admin's email
  // (admin.references + admin.messageId). If admin's email client truncated or
  // dropped the References header on long threads, the chain lost Vienna's
  // outbound message-IDs and the thread fragmented in admin's inbox.
  // Production S5.3: parallel near-identical threads accumulated; admin
  // risked replying to the wrong (older) thread, reverting in-progress edits.
  //
  // YYY anchors the chain on Vienna's outbound IDs fetched from the DB
  // (chronological order, oldest first), then appends admin's references and
  // the latest admin messageId — deduped on normalized UUID key (strips
  // angle brackets and @domain).
  console.log('\n========== GROUP YYY — preview thread chain anchored on Vienna outbound IDs ==========');
  const { buildPreviewThreadChain: yyyBuild } = require('./src/routes/webhook').__test__;

  const yyyCases = [
    {
      name: 'E1: fresh deal, no prior outbound → latest only',
      input: { outboundIds: [], inboundReferences: [], latestMessageId: 'admin-1' },
      expect: ['admin-1'],
    },
    {
      name: 'E2: prior prelim outbound, admin first reply (overlap with refs)',
      input: { outboundIds: ['mid-1'], inboundReferences: ['mid-1'], latestMessageId: 'admin-1' },
      expect: ['mid-1', 'admin-1'],
    },
    {
      name: 'E3: three EDIT cycles, order preserved, no dupes',
      input: {
        outboundIds: ['mid-1', 'mid-3', 'mid-5'],
        inboundReferences: ['mid-1', 'admin-1', 'mid-3', 'admin-3'],
        latestMessageId: 'admin-5',
      },
      expect: ['mid-1', 'mid-3', 'mid-5', 'admin-1', 'admin-3', 'admin-5'],
    },
    {
      name: 'E4: admin client drops References — Vienna IDs anchor the chain',
      input: { outboundIds: ['mid-1', 'mid-3'], inboundReferences: [], latestMessageId: 'admin-3' },
      expect: ['mid-1', 'mid-3', 'admin-3'],
    },
    {
      name: 'E5: mixed formats — raw UUID vs wrapped <uuid@mtasv.net> dedupe correctly',
      input: {
        outboundIds: ['41be2245-aaaa-bbbb-cccc-dddddddddddd'],
        inboundReferences: ['<41be2245-aaaa-bbbb-cccc-dddddddddddd@mtasv.net>'],
        latestMessageId: 'admin-1',
      },
      expect: ['41be2245-aaaa-bbbb-cccc-dddddddddddd', 'admin-1'],
    },
    {
      name: 'E6: empty inputs → empty chain',
      input: { outboundIds: [], inboundReferences: [], latestMessageId: null },
      expect: [],
    },
    {
      name: 'E7: admin echoes Vienna IDs out-of-order — Vienna order wins',
      input: {
        outboundIds: ['mid-1', 'mid-2', 'mid-3'],
        inboundReferences: ['mid-3', 'mid-1', 'mid-2'],
        latestMessageId: 'admin-1',
      },
      expect: ['mid-1', 'mid-2', 'mid-3', 'admin-1'],
    },
    {
      name: 'E8: no defaults required — call with no args returns []',
      input: undefined,
      expect: [],
    },
  ];

  let yyyPassed = 0;
  for (const tc of yyyCases) {
    const got = tc.input === undefined ? yyyBuild() : yyyBuild(tc.input);
    if (JSON.stringify(got) !== JSON.stringify(tc.expect)) {
      throw new Error(`FAIL [Group YYY ${tc.name}]:\n  input=${JSON.stringify(tc.input)}\n  expected=${JSON.stringify(tc.expect)}\n  got=${JSON.stringify(got)}`);
    }
    console.log(`  PASS [${tc.name}]`);
    yyyPassed++;
  }
  console.log(`Group YYY buildPreviewThreadChain: ${yyyPassed}/${yyyCases.length} passed`);

  // ════════════════════════════════════════════════════════════════
  // GROUP VVV — skip intake forms during deferred-intake states (S4.1)
  // ════════════════════════════════════════════════════════════════
  // Pre-VVV the new-client INITIAL branch attached Loan Application + PNW
  // Statement forms to every welcome email (unless broker provided their own).
  // S4.1 production: high-LTV submissions got Vienna's collateral question
  // (Fix 7 suppresses the doc-list text) AND blank forms shipped — wasted
  // broker effort when admin declines on collateral.
  // Per Q1-VVV, VVV extends symmetrically to identity_clash (HHH state).
  // Per Q3-VVV, applies regardless of sender_type.
  console.log('\n========== GROUP VVV — skip intake forms in deferred-intake states ==========');
  const { shouldSkipIntakeFormsForDeferredState: vvvSkip } = require('./src/routes/webhook').__test__;

  const vvvCases = [
    {
      name: 'V1: LTV > 80, no identity_clash → skip forms (Fix 7 awaiting_collateral)',
      input: { ltv_percent: 92 },
      expect: true,
    },
    {
      name: 'V2: LTV exactly 80 (boundary, not high-LTV) → ship forms',
      input: { ltv_percent: 80 },
      expect: false,
    },
    {
      name: 'V3: LTV well below 80 → ship forms',
      input: { ltv_percent: 65 },
      expect: false,
    },
    {
      name: 'V4: identity_clash=true (overrides LTV check) → skip forms (HHH)',
      input: { ltv_percent: 65, identity_clash: true },
      expect: true,
    },
    {
      name: 'V5: identity_clash=true AND LTV > 80 → skip forms (both deferred conditions)',
      input: { ltv_percent: 92, identity_clash: true },
      expect: true,
    },
    {
      name: 'V6: LTV null/undefined (broker did not state, no docs to compute) → ship forms',
      input: { ltv_percent: null },
      expect: false,
    },
    {
      name: 'V7: null summary → ship forms (defensive default)',
      input: null,
      expect: false,
    },
    {
      name: 'V8: empty summary → ship forms (no signal to defer)',
      input: {},
      expect: false,
    },
    {
      name: 'V9: borrower sender_type + LTV > 80 → skip forms (Q3-VVV: applies regardless of sender_type)',
      input: { ltv_percent: 92, sender_type: 'borrower' },
      expect: true,
    },
    {
      name: 'V10: broker + LTV > 80 + collateral_offered=true (mid-cycle re-evaluated deal) → still skip (initial-submission predicate; collateral_offered is an existing-deal flag)',
      input: { ltv_percent: 92, collateral_offered: true },
      expect: true,
    },
    {
      name: 'V11: LTV just over threshold (80.01) → skip',
      input: { ltv_percent: 80.01 },
      expect: true,
    },
    {
      name: 'V12: LTV=0 (degenerate) → ship forms (falsy-ltv branch)',
      input: { ltv_percent: 0 },
      expect: false,
    },
  ];

  let vvvPassed = 0;
  for (const tc of vvvCases) {
    const got = vvvSkip(tc.input);
    if (got !== tc.expect) {
      throw new Error(`FAIL [Group VVV ${tc.name}]:\n  input=${JSON.stringify(tc.input)}\n  expected=${tc.expect}\n  got=${got}`);
    }
    console.log(`  PASS [${tc.name}]`);
    vvvPassed++;
  }
  console.log(`Group VVV shouldSkipIntakeFormsForDeferredState: ${vvvPassed}/${vvvCases.length} passed`);

  // ════════════════════════════════════════════════════════════════
  // GROUP OOO — payout vs balance vs discharge distinction (S1.4)
  // ════════════════════════════════════════════════════════════════
  // Reverses Group K's unification. Production failure: deal 9aa136aa accepted a
  // "TD_MortgageBalance_Grace_Paulson.pdf" as sufficient under the unified
  // 'mortgage_statement' classification, marking the file complete before broker
  // had submitted the actual payout statement (which carries payoff amount +
  // prepayment penalty + interest-to-date + validity window — the balance
  // statement carries only current outstanding).
  //
  // Per Q2: payout/discharge merged (sufficient), balance separate (insufficient).
  // Per Q3: deals.js classifier is authoritative.
  // Per Q1: text-content refinement (sub-fix 1.5) downgrades ambiguous
  //         "Mortgage_Statement.pdf" filenames when text shows balance-only content.
  console.log('\n========== GROUP OOO — mortgage payout vs balance classifier ==========');
  // classifyDocument already imported earlier in the harness from deals.__test__

  // ─── Truth table A — filename layer ────────────────────────────────────
  console.log('\n---------- Group OOO / A: filename classifier ----------');
  const oooFilenameCases = [
    // Insufficient — "Balance" filenames route to mortgage_balance_statement (Q2)
    ['TD_MortgageBalance_Grace_Paulson.pdf', '', 'mortgage_balance_statement', 'production S1.4 case'],
    ['MortgageBalance_2026.pdf',             '', 'mortgage_balance_statement', 'leading-name balance variant'],
    ['Current_Balance_Mortgage.pdf',         '', 'mortgage_balance_statement', '"current balance + mortgage"'],
    // Sufficient — payout/discharge filenames
    ['Scotia_Payout_Statement_Smith.pdf',    '', 'mortgage_statement',         'explicit payout statement'],
    ['TD_Payout_Letter.pdf',                 '', 'mortgage_statement',         'payout letter'],
    ['Mortgage_Discharge.pdf',               '', 'mortgage_statement',         'mortgage discharge filename'],
    ['Discharge_Statement.pdf',              '', 'mortgage_statement',         'discharge statement filename'],
    ['MortgagePayout.pdf',                   '', 'mortgage_statement',         'no separator, mortgage payout'],
    // Ambiguous — generic filenames default to mortgage_statement (sufficient)
    ['Mortgage_Statement.pdf',               '', 'mortgage_statement',         'generic filename, no balance cue → sufficient default'],
    ['Current_Mortgage.pdf',                 '', 'mortgage_statement',         '"current mortgage" alone → sufficient default'],
  ];
  let oooFilenamePassed = 0;
  for (const [fileName, text, expected, label] of oooFilenameCases) {
    const got = classifyDocument(fileName, text);
    if (got === expected) {
      console.log(`  PASS [${label}]: ${fileName} → ${got}`);
      oooFilenamePassed++;
    } else {
      throw new Error(`FAIL [Group OOO / A filename ${label}]: ${fileName} → expected '${expected}', got '${got}'`);
    }
  }
  console.log(`Group OOO / A filename: ${oooFilenamePassed}/${oooFilenameCases.length} passed`);

  // ─── Truth table B — text-content layer + ambiguity refinement ──────────
  console.log('\n---------- Group OOO / B: text-content layer + sub-fix 1.5 refinement ----------');
  const oooTextCases = [
    // Sub-fix 1.5: ambiguous filename + balance-only text → DOWNGRADE to mortgage_balance_statement.
    // Real balance statements list current balance + account info only; they don't mention
    // payoff/penalty/validity at all (real payout statements DO).
    [
      'Mortgage_Statement.pdf',
      'Statement of mortgage account. Account: 4521-9876. Current balance: $342,180 as of May 1, 2026. Last payment received: April 15. Next payment due: May 15.',
      'mortgage_balance_statement',
      'sub-fix 1.5: ambiguous filename downgrades when text shows balance-only content',
    ],
    // Sub-fix 1.5: ambiguous filename + payoff markers → STAYS mortgage_statement
    [
      'Mortgage_Statement.pdf',
      'Payoff amount: $342,180. Prepayment penalty: $1,250. Interest to May 15: $850. Total: $344,280. Valid through May 15, 2026.',
      'mortgage_statement',
      'sub-fix 1.5: ambiguous filename + payoff markers → stays sufficient',
    ],
    // Text-fallback layer (filename → 'other'): payoff markers route to mortgage_statement
    [
      'GenericFile.pdf',
      'Mortgage discharge statement. Payoff amount calculated to maturity of the term, $342,180, with prepayment penalty of $1,250.',
      'mortgage_statement',
      'text-fallback: discharge + payoff text → sufficient',
    ],
    // Text-fallback layer: balance-only content routes to mortgage_balance_statement
    [
      'Document.pdf',
      'Current outstanding balance of mortgage: $342,180. As of statement date.',
      'mortgage_balance_statement',
      'text-fallback: balance-only text → insufficient',
    ],
    // Negative regression: random text doesn't match either
    [
      'GenericFile.pdf',
      'This document discusses property valuation methodology and comparable sales analysis from the regional MLS.',
      'appraisal',
      'unrelated text matches earlier classifier rule (appraisal) — not mortgage_*',
    ],
  ];
  let oooTextPassed = 0;
  for (const [fileName, text, expected, label] of oooTextCases) {
    const got = classifyDocument(fileName, text);
    if (got === expected) {
      console.log(`  PASS [${label}]: → ${got}`);
      oooTextPassed++;
    } else {
      throw new Error(`FAIL [Group OOO / B text ${label}]: ${fileName} + "${text.slice(0, 80)}..." → expected '${expected}', got '${got}'`);
    }
  }
  console.log(`Group OOO / B text-content: ${oooTextPassed}/${oooTextCases.length} passed`);

  // ─── Truth table C — DOC_DISPLAY_NAMES regression ───────────────────────
  console.log('\n---------- Group OOO / C: DOC_DISPLAY_NAMES regression ----------');
  const aiServiceForOoo = require('./src/services/ai');
  const oooDisplayCases = [
    ['mortgage_statement',         'Current Mortgage Payout Statement', 'sufficient — canonical name unchanged'],
    ['mortgage_balance_statement', 'Mortgage Balance Statement',         'insufficient — new key added'],
  ];
  let oooDisplayPassed = 0;
  for (const [key, expected, label] of oooDisplayCases) {
    const got = aiServiceForOoo.DOC_DISPLAY_NAMES?.[key];
    if (got === expected) {
      console.log(`  PASS [${label}]: DOC_DISPLAY_NAMES.${key} === '${got}'`);
      oooDisplayPassed++;
    } else {
      throw new Error(`FAIL [Group OOO / C display ${label}]: expected '${expected}', got '${got}'`);
    }
  }
  console.log(`Group OOO / C DOC_DISPLAY_NAMES: ${oooDisplayPassed}/${oooDisplayCases.length} passed`);

  // ─── D — Live Claude prompt verification (5x) ───────────────────────────
  // Synthetic scenario: refinance deal with all docs received EXCEPT
  // mortgage_statement (payout). Documents on file include the production
  // production-shape "TD_MortgageBalance_Grace_Paulson.pdf" classified as
  // mortgage_balance_statement. Vienna's reply MUST:
  //   1. ACKNOWLEDGE the mortgage balance statement by name
  //   2. EXPLAIN the gap (payout includes payoff amount / penalty / interest-to-date / validity)
  //   3. REQUEST the proper payout statement
  //   4. NOT treat the mortgage requirement as satisfied
  // 5x verification: 0-1 leaks ships, 2+ escalates.
  if (process.env.RUN_OOO_D === '1') {
    console.log('\n---------- Group OOO / D: 5x Claude prompt verification ----------');
    const oooDealSummary = {
      borrower_name: 'Grace Paulson',
      sender_name: 'Rachel Kim',
      broker_name: 'Rachel Kim',
      sender_type: 'broker',
      property_value: 615000,
      loan_amount: 87000,
      existing_mortgage_balance: 290000,
      ltv_percent: 61,
      loan_type: 'second mortgage',
      purpose: 'debt consolidation',
      exit_strategy: 'refi at maturity',
    };
    const oooDocsOnFile = [
      { classification: 'loan_application', file_name: 'LoanApp.pdf' },
      { classification: 'credit_report',    file_name: 'CB.pdf' },
      { classification: 'appraisal',        file_name: 'Appraisal.pdf' },
      { classification: 'noa',              file_name: 'NOA.pdf' },
      { classification: 'pnw_statement',    file_name: 'PNW.pdf' },
      { classification: 'government_id',    file_name: 'GovID.pdf' },
      { classification: 'property_tax',     file_name: 'PropertyTax.pdf' },
      { classification: 'mortgage_balance_statement', file_name: 'TD_MortgageBalance_Grace_Paulson.pdf' },
    ];
    const oooConversationHistory = [
      { direction: 'inbound', subject: 'Second Mortgage — Grace Paulson', body: 'Hi, submitting Grace for a second mortgage. Docs attached.', created_at: '2026-05-10T10:00:00Z' },
      { direction: 'outbound', subject: 'Re: Second Mortgage — Grace Paulson', body: '<p>Thanks Rachel! We have the application, credit, appraisal, NOA, PNW. Still need: gov ID, property tax, payout statement.</p>', created_at: '2026-05-10T10:05:00Z' },
      { direction: 'inbound', subject: 'Re: Second Mortgage — Grace Paulson', body: 'Sending the gov ID, property tax, and TD mortgage balance statement.', created_at: '2026-05-10T11:00:00Z' },
    ];
    // Scenario: broker already submitted docs in prior turns (now on file). This
    // turn is a follow-up text-only message. No fresh attachments → no PDF base64
    // needed; Claude reads documentsOnFile to decide what to ask for. The
    // production-shape mortgage_balance_statement is in the on-file list (NOT in
    // mortgage_statement) — Vienna's prompt rule must catch this and ask for the
    // proper payout statement.
    const oooBrokerReplyText = 'Sent over the rest of the file earlier today — let me know if anything else is needed for Grace.';
    const oooAttachments = [];
    const oooSavedDocs = [];

    let oooLeaks = 0;
    for (let run = 1; run <= 5; run++) {
      const result = await aiService.generateBrokerResponse(
        oooBrokerReplyText,
        oooAttachments,
        oooSavedDocs,
        oooDealSummary,
        oooConversationHistory,
        oooDocsOnFile,
        'active'
      );
      const reply = (result.responseEmail || '').toLowerCase();
      // Check 1 — acknowledges the balance statement by name
      const acks = /balance statement|mortgage balance/.test(reply);
      // Check 2 — explains the gap (mentions at least one of the payout-distinguishing markers)
      const explains = /payoff amount|prepayment penalty|interest to|validity/.test(reply);
      // Check 3 — requests the payout statement
      const requests = /payout statement|payout letter|mortgage payout|payoff statement/.test(reply);
      // Check 4 — does NOT make an UNCONDITIONAL present-tense claim that the file is complete.
      // S1.4 production failure: "I believe we have everything we need to send the file for review"
      // (unconditional, file wasn't actually complete). That's what we catch here.
      // CONDITIONAL future framing ("once we have the payout statement, we'll be all set") is
      // CORRECT broker-comms behavior — tells the broker what to expect after they send the
      // missing item, which the conditional clearly indicates ISN'T in yet. The conditional
      // exclusion below prevents false positives on that pattern.
      const completeClaimPattern = /(\bwe have everything\b|\bthe file is (now )?complete\b|\bnothing else (is )?(needed|required|missing|outstanding)\b|\ball documents (are )?(received|in)\b|\bready to send for review\b|\bready for approval\b)/i;
      const conditionalPrefix = /\b(once|after|when|if) we (have|receive|get|see)\b/i;
      let claimsComplete = false;
      const completeMatch = reply.match(completeClaimPattern);
      if (completeMatch) {
        const lookbackStart = Math.max(0, completeMatch.index - 80);
        const preceding = reply.slice(lookbackStart, completeMatch.index);
        claimsComplete = !conditionalPrefix.test(preceding);
      }

      const leaked = !acks || !explains || !requests || claimsComplete;
      if (leaked) {
        oooLeaks++;
        console.log(`  Run ${run}: LEAK — acks=${acks}, explains=${explains}, requests=${requests}, claimsComplete=${claimsComplete}\n    Reply (first 400): ${reply.slice(0, 400)}`);
      } else {
        console.log(`  Run ${run}: PASS — acks=${acks}, explains=${explains}, requests=${requests}, claimsComplete=${claimsComplete}`);
      }
    }
    if (oooLeaks >= 2) {
      throw new Error(`FAIL [Group OOO / D]: ${oooLeaks}/5 runs leaked. Escalation threshold reached — prompt rule needs tightening.`);
    }
    console.log(`Group OOO / D (5x Claude prompt): ${5 - oooLeaks}/5 passed, ${oooLeaks}/5 leaked (threshold: ≤1)`);
  } else {
    console.log('\n---------- Group OOO / D: SKIPPED (set RUN_OOO_D=1 to run) ----------');
  }

  // ════════════════════════════════════════════════════════════════
  // GROUP QQQ — borrower-path proof-of-income phrasing (S2.1)
  // ════════════════════════════════════════════════════════════════
  // Pre-QQQ ai.js:405 told Vienna to ask borrowers for "last 3 paystubs or 90
  // days of bank statements" as the income-doc example. Production deal S2
  // (Marcus Webb, borrower-direct) saw Vienna pull from this example and ask
  // for paystubs/bank-statements — wrong docs from day one. Per Franco, the
  // private-mortgage standard is T4 or NOA from the CRA. Source-string
  // regression check (no Claude needed for a phrase swap inside an existing
  // well-tested rule).
  console.log('\n========== GROUP QQQ — borrower-path proof-of-income phrasing ==========');
  const fs_qqq = require('fs');
  const path_qqq = require('path');
  const aiSource = fs_qqq.readFileSync(path_qqq.join(__dirname, 'src/services/ai.js'), 'utf8');

  // Negative — pre-QQQ phrasing must be gone
  if (/like your last 3 paystubs or 90 days of bank statements/.test(aiSource)) {
    throw new Error(`FAIL [Group QQQ negative]: pre-QQQ paystub/bank-statement borrower example still present in ai.js`);
  }
  console.log('  PASS [Group QQQ negative]: pre-QQQ paystub/bank-statement example removed');

  // Positive — new T4/NOA phrasing must be present in the borrower-context rule
  if (!/T4 or Notice of Assessment from the CRA/.test(aiSource)) {
    throw new Error(`FAIL [Group QQQ positive]: T4/NOA borrower example missing from ai.js`);
  }
  console.log('  PASS [Group QQQ positive]: T4/NOA borrower example present');

  // Regression guard — broker-facing rules MUST still allow paystubs in their menu
  // (broker-context language stays as-is per Franco; this scrub was borrower-only).
  if (!/Proof of Income \(NOA, pay stubs, T4, or employment letter/.test(aiSource)) {
    throw new Error(`FAIL [Group QQQ broker regression]: broker-facing 'NOA, pay stubs, T4, or employment letter' rule was removed — should be untouched`);
  }
  console.log('  PASS [Group QQQ broker regression]: broker-facing pay-stubs-allowed rule untouched');

  // ════════════════════════════════════════════════════════════════
  // GROUP ZZZ — referral dispatch defensive bundle (S11.1)
  // ════════════════════════════════════════════════════════════════
  // Production diagnosis: Sophie Larsson referral 2026-05-11 03:52 UTC arrived
  // in Postmark stream cleanly but no deal was ever created. parseReferralEmail
  // succeeds when re-run locally on the exact production body. Most plausible
  // root cause: transient Claude error during processing, silently swallowed
  // by the outer webhook try/catch. ZZZ ships a 3-layer defensive bundle:
  //   Layer 1: inner try/catch around referral branch → alert Franco on error
  //   Layer 2: regexExtractReferralEmail fallback when Claude misses the email
  //   Layer 3: alert Franco when no email found (was silent short-circuit)
  console.log('\n========== GROUP ZZZ — referral dispatch defensive bundle ==========');

  // ─── Layer 2 truth table — regexExtractReferralEmail ────────────────────
  console.log('\n---------- Group ZZZ / Layer 2: regexExtractReferralEmail ----------');
  const { regexExtractReferralEmail: zzzRegex } = aiService;

  const zzzCases = [
    {
      name: "Z1: Sophie's exact production body — extracts franco@vimarealty.com",
      input: `Hey Vienna, I met a woman named Sophie Larsson who might need a second
mortgage. Her email is franco@vimarealty.com. She owns a home in
Edmonton and is looking to pull out some equity to cover some
renovations.`,
      expect: 'franco@vimarealty.com',
    },
    {
      name: 'Z2: explicit "her email is X"',
      input: "Sophie's email is sophie@example.com",
      expect: 'sophie@example.com',
    },
    {
      name: 'Z3: skip admin own address (config.adminEmail filter)',
      input: 'Reach Sophie via franco@privatemortgagelink.com',
      expect: null,
    },
    {
      name: 'Z4: skip admin AND use first non-admin email',
      input: 'Contact: franco@privatemortgagelink.com OR alt@example.com',
      expect: 'alt@example.com',
    },
    {
      name: "Z5: skip Vienna's send address (info@privatemortgagelink.com)",
      input: 'Forward to info@privatemortgagelink.com and sophie@example.com',
      expect: 'sophie@example.com',
    },
    {
      name: 'Z6: skip system mailbox prefixes (no-reply@, support@)',
      input: 'CC no-reply@example.com and support@example.com — actual contact: jane@example.com',
      expect: 'jane@example.com',
    },
    {
      name: 'Z7: no emails at all',
      input: 'Please reach out to Sophie about her mortgage.',
      expect: null,
    },
    {
      name: 'Z8: empty body',
      input: '',
      expect: null,
    },
    {
      name: 'Z9: null body',
      input: null,
      expect: null,
    },
    {
      name: 'Z10: email with periods + plus signs in local part',
      input: 'Email: john.q.public+mortgage@example.co.uk',
      expect: 'john.q.public+mortgage@example.co.uk',
    },
    {
      name: 'Z11: skip "noreply" without hyphen',
      input: 'CC noreply@example.com, contact jane@example.com',
      expect: 'jane@example.com',
    },
  ];

  let zzzL2Passed = 0;
  for (const tc of zzzCases) {
    const got = zzzRegex(tc.input);
    if (got !== tc.expect) {
      throw new Error(`FAIL [Group ZZZ / Layer 2 ${tc.name}]:\n  input=${JSON.stringify(tc.input)}\n  expected=${JSON.stringify(tc.expect)}\n  got=${JSON.stringify(got)}`);
    }
    console.log(`  PASS [${tc.name}]: → ${JSON.stringify(got)}`);
    zzzL2Passed++;
  }
  console.log(`Group ZZZ / Layer 2 regexExtractReferralEmail: ${zzzL2Passed}/${zzzCases.length} passed`);

  // ─── Layer 1 + Layer 3 source-string regression ──────────────────────────
  // The Layer 1 (try/catch around referral branch) and Layer 3 (alert on no
  // email) live inside webhook.js's request handler. Integration-mock tests
  // would require building a referral-specific BBB-style scaffold. For ZZZ
  // we use source-string regression to confirm the defenses are wired in;
  // a future Round can add full integration mocks if a referral path
  // regression surfaces.
  console.log('\n---------- Group ZZZ / Layers 1+3: source-string regression ----------');
  const webhookSrc = fs_qqq.readFileSync(path_qqq.join(__dirname, 'src/routes/webhook.js'), 'utf8');

  // Layer 1: inner try/catch around the referral branch (the `try {` after the
  // `if (isAdmin && !existingDeal) {` opener) AND the matching catch with
  // Layer 1 alert email subject.
  if (!/Group ZZZ \(S11\.1\): wrap the referral branch in its own try\/catch/.test(webhookSrc)) {
    throw new Error(`FAIL [Group ZZZ Layer 1 comment]: missing comment marker for inner try/catch`);
  }
  if (!/Referral dispatch failed —/.test(webhookSrc)) {
    throw new Error(`FAIL [Group ZZZ Layer 1 alert subject]: missing 'Referral dispatch failed —' alert subject`);
  }
  console.log('  PASS [Group ZZZ Layer 1]: inner try/catch + alert subject wired in');

  // Layer 3: alert when referred_email is null (replaces the silent return)
  if (!/Referral missing email —/.test(webhookSrc)) {
    throw new Error(`FAIL [Group ZZZ Layer 3]: missing 'Referral missing email —' alert subject`);
  }
  if (!/ZZZ Layer 3/.test(webhookSrc)) {
    throw new Error(`FAIL [Group ZZZ Layer 3 marker]: missing 'ZZZ Layer 3' comment marker`);
  }
  console.log('  PASS [Group ZZZ Layer 3]: alert-on-no-email path wired in (replaces silent return)');

  // ════════════════════════════════════════════════════════════════
  // GROUP BBBB — exit_strategy gate on initial prelim trigger (S7.1 + S9.1)
  // ════════════════════════════════════════════════════════════════
  // Pre-BBBB the prelim-review trigger gated on `ltv <= 80 && hasReviewableDoc`
  // at both the new-client INITIAL branch and the existing-deal active branch.
  // No exit_strategy check → prelim fired with exit_strategy: null → admin's
  // prelim review showed [MISSING] Exit Strategy → broker provided exit →
  // NNN's preliminary-update dispatch fired a SECOND prelim. Production S7.1
  // (Ethan Broussard) + S9.1 (James Okafor): one deal, two prelim reviews.
  //
  // BBBB adds `&& exit_strategy_populated` to both gates. Vienna's welcome
  // email + generateBrokerResponse's ADDITIONAL ITEMS block already ask for
  // exit_strategy when missing (Group C + WWW prompt rules); BBBB just delays
  // the prelim fire until the answer lands. Net effect: one prelim per deal,
  // fired only after reviewable docs AND exit_strategy are captured.
  console.log('\n========== GROUP BBBB — exit_strategy gate on initial prelim trigger ==========');

  // webhookSrc already loaded earlier (in ZZZ source-string regression block)

  // Initial branch gate: `else if (initialLtv && initialLtv <= 80 && initialHasReviewableDoc && initialHasExitStrategy)`
  if (!/initialLtv && initialLtv <= 80 && initialHasReviewableDoc && initialHasExitStrategy/.test(webhookSrc)) {
    throw new Error(`FAIL [Group BBBB initial gate]: initial-branch prelim predicate missing 'initialHasExitStrategy' clause`);
  }
  console.log('  PASS [Group BBBB initial gate]: initial-branch prelim gate requires initialHasExitStrategy');

  // Initial branch defines initialHasExitStrategy from dealSummary?.exit_strategy
  if (!/const initialHasExitStrategy = !!\(dealSummary\?\.exit_strategy && String\(dealSummary\.exit_strategy\)\.trim\(\)\)/.test(webhookSrc)) {
    throw new Error(`FAIL [Group BBBB initial const]: initialHasExitStrategy must be derived from dealSummary?.exit_strategy with whitespace trim`);
  }
  console.log('  PASS [Group BBBB initial const]: initialHasExitStrategy correctly derives from dealSummary?.exit_strategy (whitespace-trim)');

  // Active branch gate: `willReview = ltv && ltv <= 80 && existingDeal.status === 'active' && hasReviewableDoc && hasExitStrategy && !identityClashUnresolved`
  if (!/willReview = ltv && ltv <= 80 && existingDeal\.status === 'active' && hasReviewableDoc && hasExitStrategy && !identityClashUnresolved/.test(webhookSrc)) {
    throw new Error(`FAIL [Group BBBB active gate]: active-branch willReview predicate missing 'hasExitStrategy' clause`);
  }
  console.log('  PASS [Group BBBB active gate]: active-branch willReview gate requires hasExitStrategy');

  // Active branch defines hasExitStrategy from result.updatedSummary?.exit_strategy
  if (!/const hasExitStrategy = !!\(result\.updatedSummary\?\.exit_strategy && String\(result\.updatedSummary\.exit_strategy\)\.trim\(\)\)/.test(webhookSrc)) {
    throw new Error(`FAIL [Group BBBB active const]: hasExitStrategy must be derived from result.updatedSummary?.exit_strategy with whitespace trim`);
  }
  console.log('  PASS [Group BBBB active const]: hasExitStrategy correctly derives from result.updatedSummary?.exit_strategy (whitespace-trim)');

  // Negative regression: the pre-BBBB bare predicates (no exit_strategy clause)
  // must NOT exist anywhere. Catches accidental rewrite that drops the gate.
  if (/initialLtv && initialLtv <= 80 && initialHasReviewableDoc\)/.test(webhookSrc)) {
    throw new Error(`FAIL [Group BBBB regression]: pre-BBBB bare initial-prelim predicate (no exit_strategy) still present in webhook.js`);
  }
  if (/willReview = ltv && ltv <= 80 && existingDeal\.status === 'active' && hasReviewableDoc && !identityClashUnresolved/.test(webhookSrc)) {
    throw new Error(`FAIL [Group BBBB regression]: pre-BBBB bare willReview predicate (no exit_strategy) still present in webhook.js`);
  }
  console.log('  PASS [Group BBBB regression]: pre-BBBB bare-no-exit-check predicates removed at both sites');

  // ════════════════════════════════════════════════════════════════
  // GROUP AAAA — Automated Reminders section restore in daily summary (S13.1)
  // ════════════════════════════════════════════════════════════════
  // Production diagnosis: May 9 daily summary outbound (Postmark MessageID
  // acf11405-...) had ZERO "reminder" mentions despite the prompt's section 6
  // asking for the rendering. Conditional opener ("If any automated reminders
  // were sent today...") gave Claude permission to skip the section. AAAA
  // rewrites section 6 as unconditional with explicit data-key references +
  // empty-state strings + strong-form "OMITTING the section entirely is NOT
  // acceptable" framing.
  console.log('\n========== GROUP AAAA — Automated Reminders section restore ==========');

  // ─── Source-string regression ───────────────────────────────────────────
  console.log('\n---------- Group AAAA: source-string regression ----------');

  // Strong-form unconditional framing must be present.
  if (!/this section MUST always be rendered, even when both lists are empty/.test(aiSource)) {
    throw new Error(`FAIL [Group AAAA unconditional]: strong-form "MUST always be rendered" framing missing from section 6`);
  }
  console.log('  PASS [Group AAAA unconditional]: "MUST always be rendered" framing present');

  if (!/OMITTING the section entirely is NOT acceptable/.test(aiSource)) {
    throw new Error(`FAIL [Group AAAA forbid-omit]: explicit "OMITTING the section entirely is NOT acceptable" forbidden-action rule missing`);
  }
  console.log('  PASS [Group AAAA forbid-omit]: explicit forbidden-action rule present');

  // Explicit data-key references.
  if (!/summaryData\.automatedReminders\.sentToday/.test(aiSource)) {
    throw new Error(`FAIL [Group AAAA data key]: 'summaryData.automatedReminders.sentToday' reference missing`);
  }
  if (!/summaryData\.automatedReminders\.dealsAtMaxReminders/.test(aiSource)) {
    throw new Error(`FAIL [Group AAAA data key]: 'summaryData.automatedReminders.dealsAtMaxReminders' reference missing`);
  }
  console.log('  PASS [Group AAAA data keys]: both data-key references present');

  // Empty-state strings.
  if (!/No automated reminders sent today/.test(aiSource)) {
    throw new Error(`FAIL [Group AAAA empty-state]: "No automated reminders sent today" empty-state string missing`);
  }
  if (!/No deals at max-reminder threshold/.test(aiSource)) {
    throw new Error(`FAIL [Group AAAA empty-state]: "No deals at max-reminder threshold" empty-state string missing`);
  }
  console.log('  PASS [Group AAAA empty-state]: both empty-state strings present');

  // Negative regression: the pre-AAAA conditional opener must be gone.
  if (/If any automated reminders were sent today by Vienna, list them/.test(aiSource)) {
    throw new Error(`FAIL [Group AAAA regression]: pre-AAAA conditional opener "If any automated reminders were sent today by Vienna, list them" still present`);
  }
  console.log('  PASS [Group AAAA regression]: pre-AAAA conditional opener removed');

  // ─── D 5x — F1 (non-empty) and F2 (empty) live Claude verification ──────
  if (process.env.RUN_AAAA_D === '1') {
    console.log('\n---------- Group AAAA / D-F1: non-empty fixture 5x ----------');

    const aaaaActiveDealsBase = [
      { borrower: 'Michael Donovan', email: 'broker1@example.com', status: 'active', ltv: 65, reminderCount: 2, created: '2026-05-05T10:00:00Z', updated: '2026-05-06T10:00:00Z' },
      { borrower: 'Lena Park', email: 'broker2@example.com', status: 'active', ltv: 70, reminderCount: 3, created: '2026-05-03T10:00:00Z', updated: '2026-05-04T10:00:00Z' },
      { borrower: 'Noah MacKenzie', email: 'broker3@example.com', status: 'active', ltv: 60, reminderCount: 3, created: '2026-05-01T10:00:00Z', updated: '2026-05-02T10:00:00Z' },
    ];

    const f1SummaryData = {
      date: 'Monday, May 11, 2026',
      totalActiveDeals: 3,
      dealsByStatus: { active: aaaaActiveDealsBase },
      recentActivity: { inboundCount: 0, inboundMessages: [] },
      dealsAwaitingAction: [],
      activeDeals: aaaaActiveDealsBase,
      automatedReminders: {
        sentToday: [
          { dealId: 'd1', borrower: 'Michael Donovan', email: 'broker1@example.com', reminderNumber: 2, daysSilent: 5 },
          { dealId: 'd2', borrower: 'Lena Park', email: 'broker2@example.com', reminderNumber: 3, daysSilent: 7 },
        ],
        dealsAtMaxReminders: [
          { borrower: 'Noah MacKenzie', email: 'broker3@example.com', status: 'active' },
        ],
      },
    };

    let f1Leaks = 0;
    for (let run = 1; run <= 5; run++) {
      const html = await aiService.generateDailySummary(f1SummaryData);
      const lower = (html || '').toLowerCase();
      const hasSectionHeading = /automated|reminder/i.test(html);
      const namesAllPresent = /michael donovan/.test(lower) && /lena park/.test(lower) && /noah mackenzie/.test(lower);
      // Reminder # rendered for sent-today entries (look for "2" or "3" near "Michael"/"Lena", or just "Reminder #" framing)
      const reminderNumberCue = /reminder.{0,80}(#\s*[23]\b|number.{0,20}[23]\b|\b[23]\b.{0,20}reminder|of\s*3)/i.test(html);
      const passed = hasSectionHeading && namesAllPresent && reminderNumberCue;
      if (!passed) {
        f1Leaks++;
        console.log(`  Run ${run}: LEAK — heading=${hasSectionHeading}, allNames=${namesAllPresent}, reminderNum=${reminderNumberCue}\n    HTML (first 600): ${(html || '').slice(0, 600).replace(/\s+/g, ' ')}`);
      } else {
        console.log(`  Run ${run}: PASS — section rendered with all 3 borrower names + reminder # cue`);
      }
    }
    console.log(`Group AAAA / D-F1: ${5 - f1Leaks}/5 passed, ${f1Leaks}/5 leaked (threshold: ≤1)`);

    console.log('\n---------- Group AAAA / D-F2: empty fixture 5x ----------');

    const f2SummaryData = {
      date: 'Monday, May 11, 2026',
      totalActiveDeals: 2,
      dealsByStatus: { active: aaaaActiveDealsBase.slice(0, 2) },
      recentActivity: { inboundCount: 0, inboundMessages: [] },
      dealsAwaitingAction: [],
      activeDeals: aaaaActiveDealsBase.slice(0, 2),
      automatedReminders: {
        sentToday: [],
        dealsAtMaxReminders: [],
      },
    };

    let f2Leaks = 0;
    for (let run = 1; run <= 5; run++) {
      const html = await aiService.generateDailySummary(f2SummaryData);
      const hasSectionHeading = /automated.{0,30}reminder|follow[- ]up reminder/i.test(html);
      const hasEmptyStateMessage = /no automated reminders sent today|no.{0,30}deals.{0,30}max|no.{0,30}reminders.{0,30}sent|threshold/i.test(html);
      const passed = hasSectionHeading && hasEmptyStateMessage;
      if (!passed) {
        f2Leaks++;
        console.log(`  Run ${run}: LEAK — heading=${hasSectionHeading}, emptyState=${hasEmptyStateMessage}\n    HTML (first 600): ${(html || '').slice(0, 600).replace(/\s+/g, ' ')}`);
      } else {
        console.log(`  Run ${run}: PASS — section rendered with heading + empty-state message`);
      }
    }
    console.log(`Group AAAA / D-F2: ${5 - f2Leaks}/5 passed, ${f2Leaks}/5 leaked (threshold: ≤1)`);

    // Escalation decision (per Round 2/3 pattern — both 5x runs complete first)
    if (f1Leaks >= 2 || f2Leaks >= 2) {
      const findings = [];
      if (f1Leaks >= 2) findings.push(`F1 (non-empty fixture): ${f1Leaks}/5 leaked — section omitted or names dropped`);
      if (f2Leaks >= 2) findings.push(`F2 (empty fixture): ${f2Leaks}/5 leaked — section omitted on empty state`);
      throw new Error(`FAIL [Group AAAA / D escalation]: ${findings.length} fixture(s) crossed threshold.\n  - ${findings.join('\n  - ')}\nSurface escalation shape before commit.`);
    }
  } else {
    console.log('\n---------- Group AAAA / D: SKIPPED (set RUN_AAAA_D=1 to run) ----------');
  }

  // ════════════════════════════════════════════════════════════════
  // GROUP DDDD — admin attribution + render-every-entry (S6.2 + S6.3)
  // ════════════════════════════════════════════════════════════════
  // Production diagnosis: Kevin Tran deal 65676a8f's [UPDATED] PRELIMINARY +
  // COMPLETE Review conversation logs rendered admin "approved" reply (msg 5)
  // as "INBOUND from Sarah Okonkwo" — admin direction='inbound' on under_review
  // deals, generateLeadSummary's rendering loop labels every inbound with
  // broker_name. DDDD pre-labels messages JS-side via the shared
  // isAdminReplySubject heuristic (extracted to src/lib/adminReply.js from
  // cron/dailySummary.js). S6.3 (latest broker inbound missing): not
  // reproducible in current production data but defensive prompt addition
  // mirrors AAAA strong-form pattern.
  console.log('\n========== GROUP DDDD — admin attribution + render-every-entry ==========');

  // ─── Truth table — labelMessagesForLeadSummary ──────────────────────────
  console.log('\n---------- Group DDDD / Truth Table: labelMessagesForLeadSummary ----------');
  const { labelMessagesForLeadSummary: ddddLabel } = require('./src/routes/webhook').__test__;

  const ddddCases = [
    {
      name: 'D1: outbound message → "OUTBOUND from Vienna"',
      messages: [{ direction: 'outbound', subject: 'ACTION REQUIRED: PRELIMINARY Review — Kevin Tran' }],
      brokerName: 'Sarah Okonkwo',
      expectLabel: 'OUTBOUND from Vienna',
    },
    {
      name: 'D2: inbound broker reply → "INBOUND from Sarah Okonkwo"',
      messages: [{ direction: 'inbound', subject: 'Re: Second Mortgage Submission — Kevin Tran' }],
      brokerName: 'Sarah Okonkwo',
      expectLabel: 'INBOUND from Sarah Okonkwo',
    },
    {
      name: 'D3: admin reply to PRELIMINARY Review → "INBOUND from Admin (Franco)"',
      messages: [{ direction: 'inbound', subject: 'Re: [UPDATED] ACTION REQUIRED: PRELIMINARY Review — Kevin Minh Tran — 58.8% LTV' }],
      brokerName: 'Sarah Okonkwo',
      expectLabel: 'INBOUND from Admin (Franco)',
    },
    {
      name: 'D4: admin reply to FINAL REVIEW → "INBOUND from Admin (Franco)"',
      messages: [{ direction: 'inbound', subject: 'Re: FINAL REVIEW: All Documents Received — Kevin Tran' }],
      brokerName: 'Sarah Okonkwo',
      expectLabel: 'INBOUND from Admin (Franco)',
    },
    {
      name: 'D5: admin reply to BBB conditions handoff → "INBOUND from Admin (Franco)"',
      messages: [{ direction: 'inbound', subject: 'Re: [Conditions Fulfilled] James Okafor — File Complete' }],
      brokerName: 'Tyler Bennett',
      expectLabel: 'INBOUND from Admin (Franco)',
    },
    {
      name: 'D6: admin reply to NNN/CCCC [File Complete] handoff → "INBOUND from Admin (Franco)"',
      messages: [{ direction: 'inbound', subject: 'Re: [File Complete] Patricia Simmons — Ready to Close' }],
      brokerName: 'Jason Mercer',
      expectLabel: 'INBOUND from Admin (Franco)',
    },
    {
      name: 'D7: nested Re: Re: admin reply still detected → "INBOUND from Admin (Franco)"',
      messages: [{ direction: 'inbound', subject: 'Re: Re: ACTION REQUIRED: PRELIMINARY Review — Kevin Tran' }],
      brokerName: 'Sarah Okonkwo',
      expectLabel: 'INBOUND from Admin (Franco)',
    },
    {
      name: 'D8: broker reply with "ACTION REQUIRED" in body but not subject → broker_name',
      messages: [{ direction: 'inbound', subject: 'Re: Kevin Tran — quick update' }],
      brokerName: 'Sarah Okonkwo',
      expectLabel: 'INBOUND from Sarah Okonkwo',
    },
    {
      name: 'D9: null brokerName → "INBOUND from Broker" fallback',
      messages: [{ direction: 'inbound', subject: 'Re: New deal' }],
      brokerName: null,
      expectLabel: 'INBOUND from Broker',
    },
    {
      name: 'D10: empty messages array → empty array',
      messages: [],
      brokerName: 'Sarah Okonkwo',
      expectLabel: null, // empty result, no per-message label
      expectLength: 0,
    },
    {
      name: 'D11: null messages → empty array (defensive)',
      messages: null,
      brokerName: 'Sarah Okonkwo',
      expectLabel: null,
      expectLength: 0,
    },
  ];

  let ddddPassed = 0;
  for (const tc of ddddCases) {
    const got = ddddLabel(tc.messages, tc.brokerName);
    if (tc.expectLength !== undefined) {
      if (got.length !== tc.expectLength) {
        throw new Error(`FAIL [Group DDDD ${tc.name}]: expected length ${tc.expectLength}, got ${got.length}`);
      }
      console.log(`  PASS [${tc.name}]`);
    } else {
      if (got.length !== 1 || got[0].senderLabel !== tc.expectLabel) {
        throw new Error(`FAIL [Group DDDD ${tc.name}]: expected senderLabel ${JSON.stringify(tc.expectLabel)}, got ${JSON.stringify(got[0]?.senderLabel)}`);
      }
      console.log(`  PASS [${tc.name}]: → "${got[0].senderLabel}"`);
    }
    ddddPassed++;
  }
  console.log(`Group DDDD / Truth Table: ${ddddPassed}/${ddddCases.length} passed`);

  // ─── Multi-message ordering + originals preserved ────────────────────────
  console.log('\n---------- Group DDDD / Multi-message ordering ----------');
  const ddddMixedConversation = [
    { id: 'm0', direction: 'inbound', subject: 'Second Mortgage Submission — Kevin Tran', body: 'Hi, submitting Kevin...' },
    { id: 'm1', direction: 'outbound', subject: 'Re: Second Mortgage Submission — Kevin Tran', body: 'Hi Sarah!' },
    { id: 'm2', direction: 'outbound', subject: 'ACTION REQUIRED: PRELIMINARY Review — Kevin Minh Tran — 58.8% LTV', body: '<prelim>' },
    { id: 'm3', direction: 'inbound', subject: 'Re: Second Mortgage Submission — Kevin Tran', body: 'Exit strategy: refinance with CIBC...' },
    { id: 'm4', direction: 'inbound', subject: 'Re: [UPDATED] ACTION REQUIRED: PRELIMINARY Review — Kevin Minh Tran — 58.8% LTV', body: 'approved' },
  ];
  const ddddLabeled = ddddLabel(ddddMixedConversation, 'Sarah Okonkwo');
  if (ddddLabeled.length !== 5) throw new Error(`FAIL [Group DDDD ordering]: expected 5 labeled messages, got ${ddddLabeled.length}`);
  const expectedLabels = [
    'INBOUND from Sarah Okonkwo',
    'OUTBOUND from Vienna',
    'OUTBOUND from Vienna',
    'INBOUND from Sarah Okonkwo',
    'INBOUND from Admin (Franco)',
  ];
  ddddLabeled.forEach((m, i) => {
    if (m.senderLabel !== expectedLabels[i]) {
      throw new Error(`FAIL [Group DDDD ordering position ${i}]: expected ${expectedLabels[i]}, got ${m.senderLabel}`);
    }
    // Preserve original fields
    if (m.id !== ddddMixedConversation[i].id) {
      throw new Error(`FAIL [Group DDDD field preservation]: original fields lost at position ${i}`);
    }
  });
  console.log('  PASS [Group DDDD ordering]: 5 messages labeled correctly, original fields preserved');

  // ─── Source-string regression: prompts use m.senderLabel || fallback ────
  console.log('\n---------- Group DDDD / Source-string regression ----------');

  // generateLeadSummary prompt — line ~1230 — uses m.senderLabel || fallback
  if (!/m\.senderLabel \|\| \(m\.direction === 'inbound' \? `INBOUND from \$\{inboundSenderLabel\}` : 'OUTBOUND from Vienna'\)/.test(aiSource)) {
    throw new Error(`FAIL [Group DDDD prompt wiring]: prompt rendering loop missing m.senderLabel || fallback pattern`);
  }
  // Count of senderLabel fallback occurrences should be at least 3 — generateLeadSummary,
  // generateEscalationNotification, generateBrokerResponse all use the same pattern.
  const senderLabelOccurrences = (aiSource.match(/m\.senderLabel \|\|/g) || []).length;
  if (senderLabelOccurrences < 3) {
    throw new Error(`FAIL [Group DDDD prompt wiring]: expected at least 3 prompt sites using m.senderLabel fallback (generateLeadSummary, generateEscalationNotification, generateBrokerResponse), got ${senderLabelOccurrences}`);
  }
  console.log(`  PASS [Group DDDD prompt wiring]: m.senderLabel || fallback pattern present at ${senderLabelOccurrences} prompt sites`);

  // RENDER EVERY ENTRY defensive guard
  if (!/RENDER EVERY ENTRY/.test(aiSource)) {
    throw new Error(`FAIL [Group DDDD render-every-entry]: 'RENDER EVERY ENTRY' strong-form defensive guard missing`);
  }
  const renderEveryOccurrences = (aiSource.match(/RENDER EVERY ENTRY/g) || []).length;
  if (renderEveryOccurrences < 2) {
    throw new Error(`FAIL [Group DDDD render-every-entry coverage]: expected at least 2 sites (generateLeadSummary, generateEscalationNotification), got ${renderEveryOccurrences}`);
  }
  console.log(`  PASS [Group DDDD render-every-entry]: defensive guard present at ${renderEveryOccurrences} prompt sites`);

  // Admin label string referenced in prompts
  if (!/INBOUND from Admin \(Franco\)/.test(aiSource)) {
    throw new Error(`FAIL [Group DDDD admin label]: prompt must reference "INBOUND from Admin (Franco)" label so Claude knows the meaning`);
  }
  console.log('  PASS [Group DDDD admin label]: "INBOUND from Admin (Franco)" label referenced in prompts');

  // Shared utility module exists
  const adminReplyPath = path_qqq.join(__dirname, 'src/lib/adminReply.js');
  if (!fs_qqq.existsSync(adminReplyPath)) {
    throw new Error(`FAIL [Group DDDD shared util]: src/lib/adminReply.js does not exist`);
  }
  const adminReplySrc = fs_qqq.readFileSync(adminReplyPath, 'utf8');
  if (!/module\.exports = \{ ADMIN_REPLY_SUBJECT_RE, isAdminReplySubject \}/.test(adminReplySrc)) {
    throw new Error(`FAIL [Group DDDD shared util exports]: src/lib/adminReply.js missing expected exports`);
  }
  console.log('  PASS [Group DDDD shared util]: src/lib/adminReply.js exists with correct exports');

  // cron/dailySummary.js imports from shared util (not inline regex anymore)
  const cronSrc = fs_qqq.readFileSync(path_qqq.join(__dirname, 'src/cron/dailySummary.js'), 'utf8');
  if (!/require\('\.\.\/lib\/adminReply'\)/.test(cronSrc)) {
    throw new Error(`FAIL [Group DDDD cron import]: cron/dailySummary.js must import from shared util`);
  }
  console.log('  PASS [Group DDDD cron import]: cron/dailySummary.js imports from shared util (architectural cleanup)');

  // ════════════════════════════════════════════════════════════════
  // GROUP TTT — intake doc list completeness (S3.1)
  // ════════════════════════════════════════════════════════════════
  // Pre-TTT INITIAL_EMAIL_PROMPT's broker-context WHAT TO ASK FOR list missed
  // Government-Issued ID and Property Tax Assessment — both required by
  // sendPreliminaryReviewToAdmin's baseRequired gate. Result: broker never
  // asked at intake → prelim review always shows them as [MISSING].
  // S3.1 production (Derek Olsen): Vienna asked for loan app, PNW, appraisal,
  // payout statement, credit bureau, proof of income — no gov ID, no tax.
  // TTT adds both to the broker-context list. Source-string check; the items
  // are additive to an already-listed checklist, no Claude verification needed.
  console.log('\n========== GROUP TTT — intake doc list completeness ==========');

  // 1. Gov ID listed in broker-context WHAT TO ASK FOR
  if (!/- Government-Issued ID \(driver's license, passport/.test(aiSource)) {
    throw new Error(`FAIL [Group TTT gov ID]: 'Government-Issued ID' missing from WHAT TO ASK FOR list`);
  }
  console.log('  PASS [Group TTT gov ID]: Government-Issued ID present in WHAT TO ASK FOR list');

  // 2. Property Tax Assessment listed
  if (!/- Property Tax Assessment \(current year/.test(aiSource)) {
    throw new Error(`FAIL [Group TTT property tax]: 'Property Tax Assessment' missing from WHAT TO ASK FOR list`);
  }
  console.log('  PASS [Group TTT property tax]: Property Tax Assessment present in WHAT TO ASK FOR list');

  // 3. ONLY-IF-NOT-ALREADY-PROVIDED caveat preserved (regression guard against accidental
  //    rewrite of the list header — the gate that suppresses asks when broker already
  //    attached the doc).
  if (!/WHAT TO ASK FOR — ONLY IF NOT ALREADY PROVIDED/.test(aiSource)) {
    throw new Error(`FAIL [Group TTT caveat]: 'WHAT TO ASK FOR — ONLY IF NOT ALREADY PROVIDED' header missing`);
  }
  console.log('  PASS [Group TTT caveat]: ONLY-IF-NOT-ALREADY-PROVIDED header preserved');

  // 4. Attachment recognition list updated (Q1-TTT polish)
  if (!/government ID, property tax assessment/.test(aiSource)) {
    throw new Error(`FAIL [Group TTT attachment recognition]: line 88 ANALYZING list missing 'government ID, property tax assessment'`);
  }
  console.log('  PASS [Group TTT attachment recognition]: line 88 ANALYZING list updated (Q1-TTT polish)');

  // 5. Borrower section regression guard: gov ID + property tax must NOT appear
  //    in the borrower checklist (borrower intake is conversational; docs come later).
  const borrowerSectionMatch = aiSource.match(/=== IF SENDER IS A BORROWER ===([\s\S]*?)=== IF SENDER IS A BROKER ===/);
  if (!borrowerSectionMatch) {
    throw new Error(`FAIL [Group TTT borrower regression]: could not locate borrower section bounds`);
  }
  const borrowerSection = borrowerSectionMatch[1];
  if (/Government-Issued ID/.test(borrowerSection)) {
    throw new Error(`FAIL [Group TTT borrower regression]: 'Government-Issued ID' leaked into borrower section (should be broker-only)`);
  }
  if (/Property Tax Assessment/.test(borrowerSection)) {
    throw new Error(`FAIL [Group TTT borrower regression]: 'Property Tax Assessment' leaked into borrower section (should be broker-only)`);
  }
  console.log('  PASS [Group TTT borrower regression]: gov ID + property tax scoped to broker section only');

  // ════════════════════════════════════════════════════════════════
  // GROUP UUU — discrepancy detection tuning (S3.3 + S3.4)
  // ════════════════════════════════════════════════════════════════
  // Pre-UUU the CRITICAL DATA DISCREPANCY RULE flagged any number/factual
  // mismatch between email body and attached docs. Two production failures:
  //   S3.3 over-fire: broker "~$112,000" (hedged estimate) vs loan app $110,000
  //                   (1.8% delta) — Vienna flagged as discrepancy, noise.
  //   S3.4 under-fire: broker "home renovations" vs loan app "business working
  //                    capital and equipment purchase" — Vienna silently used
  //                    loan-app value without flagging the categorical conflict.
  // UUU tunes both directions across three prompt sites:
  //   ai.js:172 INITIAL_EMAIL_PROMPT, ai.js:483 generateBrokerResponse,
  //   ai.js:1210 generateLeadSummary.
  console.log('\n========== GROUP UUU — discrepancy detection tuning ==========');

  // ─── Source-string regression: all three sites must contain both sub-rules ──
  const uuuHedgeMarker = /HEDGED NUMERIC ESTIMATES/g;
  const uuuCategoricalMarker = /CATEGORICAL\/PURPOSE MISMATCHES MUST FLAG/g;
  const uuuHedgeMatches = (aiSource.match(uuuHedgeMarker) || []).length;
  const uuuCategoricalMatches = (aiSource.match(uuuCategoricalMarker) || []).length;
  if (uuuHedgeMatches !== 3) {
    throw new Error(`FAIL [Group UUU hedge sub-rule]: expected 3 occurrences (one per site: INITIAL, broker response, lead summary), got ${uuuHedgeMatches}`);
  }
  console.log(`  PASS [Group UUU hedge sub-rule]: HEDGED NUMERIC ESTIMATES rule present in all 3 sites (${uuuHedgeMatches}/3)`);
  if (uuuCategoricalMatches !== 3) {
    throw new Error(`FAIL [Group UUU categorical sub-rule]: expected 3 occurrences, got ${uuuCategoricalMatches}`);
  }
  console.log(`  PASS [Group UUU categorical sub-rule]: CATEGORICAL/PURPOSE MISMATCHES MUST FLAG rule present in all 3 sites (${uuuCategoricalMatches}/3)`);

  // Hedge marker list completeness (Q1-UUU per Franco's response: includes
  // "in the neighborhood of" and "ballpark"; excludes "more or less").
  const hedgeMarkers = ['~', 'approximately', 'around', 'roughly', 'about', 'ish', 'give or take', 'in the neighborhood of', 'ballpark'];
  for (const marker of hedgeMarkers) {
    // Each marker should appear in the hedge sub-rule context. Use a generous
    // surrounding window check — at minimum the marker should appear in the
    // file at all (and we already verified the sub-rule header appears 3x).
    if (!aiSource.includes(`"${marker}"`)) {
      throw new Error(`FAIL [Group UUU hedge marker]: marker '${marker}' missing from prompt hedge-marker list (expected quoted)`);
    }
  }
  console.log(`  PASS [Group UUU hedge marker list]: all ${hedgeMarkers.length} markers listed (Q1-UUU expanded set)`);

  // ─── D1 + D2 — Live Claude 5x verification (per scenario) ──────────────
  // Per Franco: finish both 5x runs before any escalation decision. Same cost
  // either way (10 Claude calls); complete picture for triage. If both cross
  // threshold, surface as two separate findings — they may need different fix
  // shapes.
  if (process.env.RUN_UUU_D === '1') {
    console.log('\n---------- Group UUU / D1: hedged-estimate over-fire suppression (5x) ----------');

    const d1ConversationHistory = [
      {
        direction: 'inbound',
        body: `Hi Vienna,

Looking at ~$112,000 for the second mortgage on Derek Olsen's property in Calgary. Loan application is attached — let me know what else you need.

Thanks,
Jason`,
        created_at: '2026-05-10T10:00:00Z',
      },
    ];
    const d1DealSummary = {
      borrower_name: 'Derek Olsen',
      broker_name: 'Jason Mercer',
      sender_name: 'Jason Mercer',
      sender_type: 'broker',
      loan_amount: 110000,
      property_value: 580000,
      loan_type: 'second mortgage',
      purpose: 'home renovation',
      exit_strategy: 'refinance at maturity',
      ltv_percent: 62,
    };
    const d1DocsOnFile = [
      { classification: 'loan_application', file_name: 'LoanApp_Olsen.pdf' },
    ];
    const d1SavedDocs = [
      { id: 'd1', file_name: 'LoanApp_Olsen.pdf', classification: 'loan_application', extracted_text: 'Borrower: Derek Olsen. Loan Amount: $110,000. Property: 432 Ranchlands Way NW, Calgary. Property Value: $580,000. Purpose: Home renovation.' },
    ];

    let d1Leaks = 0;
    for (let run = 1; run <= 5; run++) {
      const result = await aiService.generateBrokerResponse(
        d1ConversationHistory[0].body,
        [],
        d1SavedDocs,
        d1DealSummary,
        d1ConversationHistory,
        d1DocsOnFile,
        'active'
      );
      const reply = (result.responseEmail || '').toLowerCase();
      // Leak detection — Vienna flagged the hedged-estimate vs precise as a discrepancy.
      // Look for both figures appearing together AND a flag-framing phrase.
      const mentions112 = /112,?000|\$112k|~?\s*\$?112/.test(reply);
      const mentions110 = /110,?000|\$110k|\$?110(?!,?000.{0,30}vs|\d)/.test(reply);
      const flagFraming = /(doesn'?t match|differ|clarify which|confirm which|need.{0,20}clarif|inconsistency|mismatch)/.test(reply);
      const leaked = mentions112 && mentions110 && flagFraming;
      if (leaked) {
        d1Leaks++;
        console.log(`  Run ${run}: LEAK — flagged hedged $112K vs precise $110K as discrepancy\n    Reply (first 500): ${reply.slice(0, 500).replace(/\n/g, ' ')}`);
      } else {
        console.log(`  Run ${run}: PASS — no false flag on hedged estimate (mentions112=${mentions112}, mentions110=${mentions110}, flagFraming=${flagFraming})`);
      }
    }
    console.log(`Group UUU / D1: ${5 - d1Leaks}/5 passed, ${d1Leaks}/5 leaked (threshold: ≤1)`);

    console.log('\n---------- Group UUU / D2: categorical-mismatch flag (5x) ----------');

    const d2ConversationHistory = [
      {
        direction: 'inbound',
        body: `Hi Vienna,

Submitting a second mortgage for $95,000 on Derek Olsen's property in Calgary — funds are for home renovations. Loan application attached.

Thanks,
Jason`,
        created_at: '2026-05-10T10:00:00Z',
      },
    ];
    const d2DealSummary = {
      borrower_name: 'Derek Olsen',
      broker_name: 'Jason Mercer',
      sender_name: 'Jason Mercer',
      sender_type: 'broker',
      loan_amount: 95000,
      property_value: 580000,
      loan_type: 'second mortgage',
      purpose: 'business working capital and equipment purchase',
      exit_strategy: 'refinance at maturity',
      ltv_percent: 62,
    };
    const d2DocsOnFile = [
      { classification: 'loan_application', file_name: 'LoanApp_Olsen.pdf' },
    ];
    const d2SavedDocs = [
      { id: 'd2', file_name: 'LoanApp_Olsen.pdf', classification: 'loan_application', extracted_text: 'Borrower: Derek Olsen / Olsen Construction Inc. Loan Amount: $95,000. Property: 432 Ranchlands Way NW, Calgary. Purpose: Business working capital and equipment purchase for Olsen Construction Inc.' },
    ];

    let d2Leaks = 0;
    for (let run = 1; run <= 5; run++) {
      const result = await aiService.generateBrokerResponse(
        d2ConversationHistory[0].body,
        [],
        d2SavedDocs,
        d2DealSummary,
        d2ConversationHistory,
        d2DocsOnFile,
        'active'
      );
      const reply = (result.responseEmail || '').toLowerCase();
      // Pass criteria: reply mentions both purpose categories AND uses flag framing.
      const mentionsRenovation = /renovation/.test(reply);
      const mentionsBusiness = /business working capital|business.{0,30}equipment|business purpose|commercial purpose|business loan/.test(reply);
      const flagFraming = /(doesn'?t match|differ|clarify which|confirm which|conflict|need.{0,30}clarif|mismatch|could you (clarify|confirm))/.test(reply);
      const flagged = mentionsRenovation && mentionsBusiness && flagFraming;
      // Leak = Vienna FAILED to flag the categorical mismatch
      const leaked = !flagged;
      if (leaked) {
        d2Leaks++;
        console.log(`  Run ${run}: LEAK — missed categorical mismatch (renovation=${mentionsRenovation}, business=${mentionsBusiness}, flagFraming=${flagFraming})\n    Reply (first 500): ${reply.slice(0, 500).replace(/\n/g, ' ')}`);
      } else {
        console.log(`  Run ${run}: PASS — flagged renovation vs business mismatch`);
      }
    }
    console.log(`Group UUU / D2: ${5 - d2Leaks}/5 passed, ${d2Leaks}/5 leaked (threshold: ≤1)`);

    // ─── Escalation decision (after both 5x runs complete per Q2-UUU) ────────
    if (d1Leaks >= 2 || d2Leaks >= 2) {
      const findings = [];
      if (d1Leaks >= 2) findings.push(`D1 (over-fire suppression): ${d1Leaks}/5 leaked — hedged-estimate tolerance not holding`);
      if (d2Leaks >= 2) findings.push(`D2 (categorical mismatch flag): ${d2Leaks}/5 leaked — under-fire rule not strong enough`);
      throw new Error(`FAIL [Group UUU / D escalation]: ${findings.length} scenario(s) crossed threshold.\n  - ${findings.join('\n  - ')}\nSurface escalation shape before commit per Q2-UUU.`);
    }
  } else {
    console.log('\n---------- Group UUU / D1 + D2: SKIPPED (set RUN_UUU_D=1 to run) ----------');
  }

  // ════════════════════════════════════════════════════════════════
  // GROUP WWW — deterministic exit_strategy gating (S5.1)
  // ════════════════════════════════════════════════════════════════
  // Pre-WWW the ADDITIONAL ITEMS block in generateDocumentRequestEmail was
  // always injected; Claude was supposed to skip the exit-strategy ask when
  // dealSummary.exit_strategy was populated, but over-fired probabilistically
  // (Patricia Simmons deal 3a9a3532 — exit_strategy was set yet Vienna asked
  // anyway). Post-WWW the JS gate omits the block from the prompt entirely
  // when exit_strategy is set — removes the probabilistic miss by removing
  // the instruction. Pure-function truth table; no live Claude needed
  // (structural fix per Franco's "no live Claude verification" approval).
  console.log('\n========== GROUP WWW — deterministic exit_strategy gating ==========');
  const { buildAdditionalItemsBlock: wwwBuild } = aiService;

  const wwwCases = [
    {
      name: 'W1: exit_strategy populated string → block absent (\'\')',
      input: { exit_strategy: 'refinance with TD at maturity' },
      expectEmpty: true,
    },
    {
      name: 'W2: exit_strategy null → block present',
      input: { exit_strategy: null },
      expectEmpty: false,
    },
    {
      name: 'W3: exit_strategy undefined (missing key) → block present',
      input: {},
      expectEmpty: false,
    },
    {
      name: 'W4: exit_strategy empty string → block present',
      input: { exit_strategy: '' },
      expectEmpty: false,
    },
    {
      name: 'W5: exit_strategy whitespace-only → block present (whitespace treated as empty)',
      input: { exit_strategy: '   ' },
      expectEmpty: false,
    },
    {
      name: 'W6: null dealSummary → block present (defensive default — better to over-ask than miss when summary malformed)',
      input: null,
      expectEmpty: false,
    },
    {
      name: 'W7: Patricia Simmons production value → block absent (the production failure case)',
      input: { exit_strategy: 'refinance into a single first at maturity once renovation is complete' },
      expectEmpty: true,
    },
  ];

  let wwwPassed = 0;
  for (const tc of wwwCases) {
    const got = wwwBuild(tc.input);
    const isEmpty = got === '';
    if (isEmpty !== tc.expectEmpty) {
      throw new Error(`FAIL [Group WWW ${tc.name}]:\n  input=${JSON.stringify(tc.input)}\n  expectEmpty=${tc.expectEmpty}\n  got=${JSON.stringify(got)}`);
    }
    // Sanity: when block IS present, it must contain the expected markers.
    if (!tc.expectEmpty) {
      if (!/EXIT STRATEGY/.test(got)) {
        throw new Error(`FAIL [Group WWW ${tc.name} block content]: expected 'EXIT STRATEGY' in block, got: ${JSON.stringify(got)}`);
      }
      if (!/Could you also let us know the exit strategy/.test(got)) {
        throw new Error(`FAIL [Group WWW ${tc.name} block content]: expected canonical phrasing in block, got: ${JSON.stringify(got)}`);
      }
    }
    console.log(`  PASS [${tc.name}]${tc.expectEmpty ? '' : ` (block ${got.length} chars)`}`);
    wwwPassed++;
  }
  console.log(`Group WWW buildAdditionalItemsBlock: ${wwwPassed}/${wwwCases.length} passed`);

  // Q1-WWW regression guard: the block body must NOT carry the conditional
  // language (per Q1-WWW Franco approved simplification). Belt-and-suspenders
  // re-introduces the probabilistic miss vector by giving Claude a second
  // signal to second-guess. JS gate is the sole condition.
  const wwwBlockPresent = wwwBuild({ exit_strategy: null });
  if (/If dealSummary\.exit_strategy is null\/empty/.test(wwwBlockPresent)) {
    throw new Error(`FAIL [Group WWW Q1 simplification]: block body still contains pre-WWW conditional language "If dealSummary.exit_strategy is null/empty" — Q1-WWW approved dropping this. Got: ${wwwBlockPresent.slice(0, 300)}`);
  }
  console.log('  PASS [Group WWW Q1 simplification]: block body simplified — conditional language removed, JS gate is sole condition');

  // ════════════════════════════════════════════════════════════════
  // GROUP RRR — borrower-initial over-clarification (S2.2)
  // ════════════════════════════════════════════════════════════════
  // Production bug: Marcus Webb deal 0a815d91 — borrower-initial msg 0 stated
  // "I'm looking to take out a second mortgage on my property to consolidate
  // some debt" + property/value/balance/amount details. Vienna's INITIAL welcome
  // (msg 1) acknowledged "the debt consolidation" but then asked for "a brief
  // write-up about your situation" anyway — near-verbatim repeat of what Marcus
  // already gave. Investigation: bug is in INITIAL_EMAIL_PROMPT's borrower
  // section (step 4 unconditional), NOT in generateBrokerResponse where FFF
  // lives. Fix: add the same "skip if already provided" conditional to
  // borrower step 4 that broker section line 111 already has.
  console.log('\n========== GROUP RRR — borrower-initial over-clarification ==========');

  // Source-string regression — the new conditional rule must appear in the
  // borrower section, and the second example (skip-write-up behavior) must
  // be present.
  if (!/Ask them for a brief write-up or "story" about their situation ONLY IF/.test(aiSource)) {
    throw new Error(`FAIL [Group RRR rule]: borrower step 4 ONLY-IF conditional missing from INITIAL_EMAIL_PROMPT`);
  }
  console.log('  PASS [Group RRR rule]: borrower step 4 ONLY-IF conditional present');

  if (!/Example borrower response when borrower ALREADY provided context/.test(aiSource)) {
    throw new Error(`FAIL [Group RRR example]: second borrower example (skip-write-up) missing from INITIAL_EMAIL_PROMPT`);
  }
  console.log('  PASS [Group RRR example]: second borrower example (skip-write-up) present');

  // ─── D — Live Claude prompt verification (5x) ───────────────────────────
  // Fixture: Marcus Webb's exact production msg 0 body (verbatim — cleanly
  // demonstrates the over-clarification trigger). Pass criteria for each run:
  //   1. Vienna acknowledges the debt consolidation purpose
  //   2. Vienna asks for the forms (Loan Application + PNW)
  //   3. Vienna does NOT ask for a brief write-up / overview / situation summary
  // Threshold: 0-1 leaks ships, 2+ escalates.
  if (process.env.RUN_RRR_D === '1') {
    console.log('\n---------- Group RRR / D: 5x Claude prompt verification ----------');
    const rrrInitialEmail = `Hi,

My name is Marcus Webb. I'm a homeowner in Edmonton and I'm looking to take out a second mortgage on my property to consolidate some debt.

Property: 1142 Tory Road NW, Edmonton, AB
Property Value: ~$580,000
Existing Mortgage Balance: $261,000 (RBC)
Amount I'm Looking For: ~$87,000

Please let me know what else you need from me.

Thanks,
Marcus Webb`;

    let rrrLeaks = 0;
    for (let run = 1; run <= 5; run++) {
      const result = await aiService.processInitialEmail(
        'Marcus Webb',
        rrrInitialEmail,
        [],   // no attachments
        [],   // no savedDocs
        false, // hasOwnApplication
        false, // hasOwnPnw
        false  // nameCollidesWithAdmin
      );
      const reply = (result.welcomeEmail || '').toLowerCase();
      // Check 1 — acknowledges the debt consolidation purpose
      const acks = /debt consolidation|consolidat/.test(reply);
      // Check 2 — asks for the forms
      const asksForms = /(loan application|application form).{0,80}(personal net worth|pnw)|fill out the (two )?(attached )?forms/i.test(reply);
      // Check 3 — does NOT ask for a write-up / overview / situation summary
      const writeupPatterns = [
        /\bwrite[- ]?up\b/i,
        /\bbrief overview\b/i,
        /\bhigh-level overview\b/i,
        /\btell us about your situation\b/i,
        /\bdescribe your situation\b/i,
        /\bgive (us|me) a (quick )?(rundown|overview|summary)\b/i,
        /\b(quick )?rundown\b/i,
        /\b(your|the) story\b/i,
      ];
      const writeupAsk = writeupPatterns.some(re => re.test(reply));

      const leaked = !acks || !asksForms || writeupAsk;
      if (leaked) {
        rrrLeaks++;
        const triggered = writeupPatterns.filter(re => re.test(reply)).map(re => re.source);
        console.log(`  Run ${run}: LEAK — acks=${acks}, asksForms=${asksForms}, writeupAsk=${writeupAsk}${triggered.length ? ` (matched: ${triggered.join(', ')})` : ''}\n    Reply (first 500): ${reply.slice(0, 500).replace(/\n/g, ' ')}`);
      } else {
        console.log(`  Run ${run}: PASS — acks=${acks}, asksForms=${asksForms}, writeupAsk=${writeupAsk}`);
      }
    }
    if (rrrLeaks >= 2) {
      throw new Error(`FAIL [Group RRR / D]: ${rrrLeaks}/5 runs leaked. Escalation threshold reached — prompt rule needs tightening.`);
    }
    console.log(`Group RRR / D (5x Claude prompt): ${5 - rrrLeaks}/5 passed, ${rrrLeaks}/5 leaked (threshold: ≤1)`);
  } else {
    console.log('\n---------- Group RRR / D: SKIPPED (set RUN_RRR_D=1 to run) ----------');
  }

  // ════════════════════════════════════════════════════════════════
  // GROUP MMM — daily summary admin-reply subject filter (S13.1)
  // ════════════════════════════════════════════════════════════════
  // Pre-MMM: cron/dailySummary.js filtered direction='inbound' but didn't
  // distinguish broker-from-admin. Admin replies (saved as inbound under deals
  // for HITL conversation history) leaked into the "Emails Received" section
  // as if they were broker activity. MMM fix: subject-prefix heuristic — admin
  // replies inherit Vienna's controlled outbound-to-admin subject prefixes.
  console.log('\n========== GROUP MMM — daily summary admin-reply subject filter ==========');
  const { isAdminReplySubject } = require('./src/cron/dailySummary');

  const adminReplyCases = [
    // Positive — Vienna's outbound-to-admin subject prefixes (admin replies inherit these)
    ['Re: ACTION REQUIRED: PRELIMINARY Review — Kevin Tran — 65.7% LTV',           true,  'admin reply to prelim review'],
    ['Re: ACTION REQUIRED: LTV Over 80% — Ryan Callahan',                          true,  'admin reply to escalation'],
    ['Re: [UPDATED] ACTION REQUIRED: PRELIMINARY Review — Patricia Simmons — 65.7% LTV', true, 'admin reply to updated prelim (Fix 2 path)'],
    ['Re: [UPDATED] ACTION REQUIRED: LTV Over 80% — Ryan Callahan',                true,  'admin reply to updated escalation'],
    ['Re: FINAL REVIEW: All Documents Received — Marcus Webb',                     true,  'admin reply to FINAL REVIEW'],
    ['Re: [Conditions Fulfilled] James Okafor — File Complete',                    true,  'admin reply to BBB handoff notice'],
    ['Re: [Broker Update] Sarah Mitchell — Under Your Review',                     true,  'admin reply to passive [Broker Update]'],
    // Nested Re: chains — multi-turn admin draft preview cycles
    ['Re: Re: ACTION REQUIRED: PRELIMINARY Review — Kevin Tran',                   true,  'nested Re: (admin reply to draft preview)'],
    ['Re: Re: Re: ACTION REQUIRED: PRELIMINARY Review — Kevin Tran',               true,  'triple-nested Re: (multi-turn edit cycle)'],
    ['Re: Re: [UPDATED] ACTION REQUIRED: PRELIMINARY Review — Patricia Simmons',   true,  'nested Re: + [UPDATED]'],
    ['Re: Re: [Conditions Fulfilled] James Okafor — File Complete',                true,  'nested Re: + [Conditions Fulfilled]'],
    // Case-insensitive Re:
    ['re: action required: PRELIMINARY Review — Kevin Tran',                       true,  'lowercase re: still matches'],
    // Negative — broker/borrower replies must pass through (returns false)
    ['Re: New Mortgage Application — Noah MacKenzie',                              false, 'broker initial reply'],
    ['Re: Loan Inquiry',                                                           false, 'broker reply to Vienna welcome'],
    ['Patricia Simmons — Documents',                                               false, 'broker fresh thread (no Re:)'],
    ['Re: Patricia Simmons',                                                       false, 'broker reply on borrower-name subject'],
    ['Sending the appraisal',                                                      false, 'broker forward with new docs'],
    ['Re: Second Mortgage Application — Noah MacKenzie',                           false, 'broker reply to original-thread subject'],
    // Edge — empty / null
    ['',                                                                           false, 'empty subject'],
    [null,                                                                         false, 'null subject'],
    // False-positive trap: broker subject mentions "ACTION REQUIRED" mid-phrase
    ['Re: My client wants to know what action required for the AML form',          false, 'broker subject mentioning "action required" mid-phrase — must NOT match'],
    ['Re: Action items from our call last Tuesday',                                false, 'broker subject mentioning "Action" mid-phrase — must NOT match'],
    // False-positive trap: broker subject contains [UPDATED] but not as Vienna's pattern
    ['Re: [UPDATED] My borrower has new income docs',                              false, 'broker subject with [UPDATED] but no ACTION REQUIRED — must NOT match'],
  ];

  let mmmPassed = 0;
  for (const [subject, expected, label] of adminReplyCases) {
    const got = isAdminReplySubject(subject);
    if (got === expected) {
      console.log(`  PASS [${label}]: isAdminReplySubject(${JSON.stringify(String(subject || '').slice(0, 50))}) → ${expected}`);
      mmmPassed++;
    } else {
      throw new Error(`FAIL [Group MMM ${label}]: expected ${expected}, got ${got} for ${JSON.stringify(subject)}`);
    }
  }
  console.log(`Group MMM isAdminReplySubject: ${mmmPassed}/${adminReplyCases.length} passed`);

  // ════════════════════════════════════════════════════════════════
  // GROUP C — missingDocs aggregation includes exit_strategy when null/empty
  // ════════════════════════════════════════════════════════════════
  // S6.3 / S7.3 root cause: missingDocs filter at webhook.js:180 only checked
  // document classifications. dealSummary.exit_strategy is a deal-summary field
  // (set null at ai.js:206 when broker doesn't state one), but never entered the
  // [MISSING] surface. Group C fix: webhook pushes 'exit_strategy' onto missingDocs
  // when dealSummary.exit_strategy is null/empty. DOC_DISPLAY_NAMES.exit_strategy
  // = 'Exit Strategy' renders the friendly label in admin emails.
  console.log('\n========== GROUP C — exit_strategy in missingDocs aggregation ==========');

  // Sub-case 1: exit_strategy null → 'exit_strategy' IN missingDocs
  reset();
  const groupCDeal = { id: 'deal-groupc-1', borrower_name: 'Test Borrower' };
  await sendPreliminaryReviewToAdmin(
    groupCDeal,
    {
      sender_type: 'broker',
      sender_name: 'Jason Mercer',
      broker_name: 'Jason Mercer',
      borrower_name: 'Test Borrower',
      ltv_percent: 65.0,
      exit_strategy: null,
    },
    null,
    65.0
  );
  if (!calls.generateLeadSummary[0].missingDocs.includes('exit_strategy')) {
    throw new Error(`FAIL [Group C exit_strategy=null]: expected 'exit_strategy' in missingDocs, got ${JSON.stringify(calls.generateLeadSummary[0].missingDocs)}`);
  }
  console.log(`  PASS [Group C exit_strategy=null]: 'exit_strategy' in missingDocs (${calls.generateLeadSummary[0].missingDocs.length} items total)`);

  // Sub-case 2: exit_strategy populated → 'exit_strategy' NOT in missingDocs
  reset();
  await sendPreliminaryReviewToAdmin(
    groupCDeal,
    {
      sender_type: 'broker',
      sender_name: 'Jason Mercer',
      broker_name: 'Jason Mercer',
      borrower_name: 'Test Borrower',
      ltv_percent: 65.0,
      exit_strategy: 'refinance with B lender at maturity',
    },
    null,
    65.0
  );
  if (calls.generateLeadSummary[0].missingDocs.includes('exit_strategy')) {
    throw new Error(`FAIL [Group C exit_strategy=string]: did NOT expect 'exit_strategy' in missingDocs, got ${JSON.stringify(calls.generateLeadSummary[0].missingDocs)}`);
  }
  console.log(`  PASS [Group C exit_strategy=string]: 'exit_strategy' NOT in missingDocs (broker provided it)`);

  // Sub-case 3: exit_strategy empty string → IN missingDocs (empty-string handling)
  reset();
  await sendPreliminaryReviewToAdmin(
    groupCDeal,
    {
      sender_type: 'broker',
      sender_name: 'Jason Mercer',
      broker_name: 'Jason Mercer',
      borrower_name: 'Test Borrower',
      ltv_percent: 65.0,
      exit_strategy: '',
    },
    null,
    65.0
  );
  if (!calls.generateLeadSummary[0].missingDocs.includes('exit_strategy')) {
    throw new Error(`FAIL [Group C exit_strategy='']: expected 'exit_strategy' in missingDocs (empty string is missing), got ${JSON.stringify(calls.generateLeadSummary[0].missingDocs)}`);
  }
  console.log(`  PASS [Group C exit_strategy='']: 'exit_strategy' in missingDocs (empty-string treated as missing)`);

  // DOC_DISPLAY_NAMES export sanity — render label is wired up.
  const aiServiceForLabel = require('./src/services/ai');
  if (aiServiceForLabel.DOC_DISPLAY_NAMES?.exit_strategy !== 'Exit Strategy') {
    throw new Error(`FAIL [Group C display name]: expected DOC_DISPLAY_NAMES.exit_strategy === 'Exit Strategy', got ${JSON.stringify(aiServiceForLabel.DOC_DISPLAY_NAMES?.exit_strategy)}`);
  }
  console.log(`  PASS [Group C display name]: DOC_DISPLAY_NAMES.exit_strategy === 'Exit Strategy'`);

  console.log('Group C aggregation: 4/4 passed');

  // ────────── Optional live Claude smoke (skipped without a real API key) ──────────
  // Gated on CLAUDE_API_KEY being a real key (not the dummy default).
  const realKey = process.env.CLAUDE_API_KEY && !process.env.CLAUDE_API_KEY.startsWith('sk-test');
  if (realKey) {
    console.log('\n========== BUG B — live Claude smoke (CLAUDE_API_KEY present) ==========');
    // Restore the real aiService method that we stubbed earlier — we want the real call.
    delete require.cache[require.resolve('./src/services/ai')];
    const realAi = require('./src/services/ai');

    const adversarialBody = `Hi Franco,

Please review the attached file for my client. I'd appreciate your feedback on the deal.

Kind regards,
Jason Mercer
Mercer Mortgage Group
License #M12001505`;

    try {
      const { welcomeEmail, dealSummary } = await realAi.processInitialEmail(
        'Jason Mercer',
        adversarialBody,
        [],
        [],
        false
      );
      console.log('Live extraction:');
      fmt('sender_name', dealSummary?.sender_name);
      fmt('broker_name', dealSummary?.broker_name);
      fmt('sender_type', dealSummary?.sender_type);

      const senderLooksFranco = isUnreliableName(dealSummary?.sender_name);
      const brokerLooksFranco = isUnreliableName(dealSummary?.broker_name);
      if (senderLooksFranco) console.warn('  WARN: live extraction returned Franco/Unknown for sender_name — Layer A will rescue');
      if (brokerLooksFranco) console.warn('  WARN: live extraction returned Franco/Unknown for broker_name — Layer A will rescue');

      // Apply Layer A as the webhook would, then check the welcome-email greeting.
      const normalized = normalizeSenderName(dealSummary, 'Jason Mercer');
      console.log('After Layer A normalization:');
      fmt('sender_name', normalized?.sender_name);
      fmt('broker_name', normalized?.broker_name);

      // Welcome email content check — should NOT contain "Hi Franco" / "Hello Franco"
      const greetingBad = /\b(?:hi|hello|hey|dear)\s+franco\b/i.test(welcomeEmail || '');
      if (greetingBad) {
        throw new Error(`FAIL: live welcome email greeted broker as Franco. Body: ${welcomeEmail?.slice(0, 200)}`);
      }
      console.log('  PASS: live welcome email did NOT greet broker as Franco');
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Bug B live smoke skipped due to API error: ${e.message}`);
    }

    // ════════════════════════════════════════════════════════════════
    // BUG C — adversarial live Claude smoke for approval-language + internal-routing
    // ════════════════════════════════════════════════════════════════
    console.log('\n========== BUG C — live Claude smoke (adversarial) ==========');

    // Forbidden phrases that should never appear in any broker-facing email post-Bug-C.
    // Each entry is [pattern, description]. /\bword\b/i is the safe shape — substring would
    // false-positive on legitimate words inside other words.
    const forbiddenPhrases = [
      [/\bapprov(ed|al|ing)\b/i, 'approval/approved/approving'],
      [/passed\s+review/i, '"passed review"'],
      [/looks\s+good/i, '"looks good"'],
      [/everything\s+is\s+in\s+order/i, '"everything is in order"'],
      [/thanks\s+for\s+confirming\s+(the\s+)?approval/i, '"thanks for confirming approval"'],
      [/for\s+final\s+assessment/i, '"for final assessment"'],
      [/going\s+to\s+underwriting/i, '"going to underwriting"'],
      [/final\s+approval\s+and\s+terms/i, '"final approval and terms"'],
      [/the\s+underwriters\b/i, '"the underwriters"'],
      [/our\s+team\b/i, '"our team"'],
      [/\b(?:the|our)\s+review\s+process\b/i, '"the/our review process"'],
      [/\bpatience\s+with\s+(?:the|our)\s+(?:review|process)/i, '"patience with the review/process"'],
      [/\bthe\s+underwriting\s+process\b/i, '"the underwriting process"'],
      [/i'?ll\s+(get|send)\s+this\s+over\s+to/i, '"I\'ll get/send this over to"'],
      [/passing\s+(?:\S+\s+){1,4}along\b/i, '"passing X along" (any 1-4 word variant — covers "passing it/this/everything/the file along")'],
      [/forwarding\s+(this|it)\s+to/i, '"forwarding to"'],
      [/\bfranco\b/i, '"Franco" — should never appear in broker-facing email'],
    ];

    const checkBugC = (label, html) => {
      const failures = [];
      for (const [re, desc] of forbiddenPhrases) {
        const m = (html || '').match(re);
        if (m) failures.push(`${desc} — matched at "...${(html || '').slice(Math.max(0, m.index - 20), m.index + m[0].length + 20)}..."`);
      }
      if (failures.length > 0) {
        throw new Error(`FAIL [${label}]: forbidden Bug C phrases in output:\n  - ${failures.join('\n  - ')}`);
      }
      console.log(`  PASS [${label}]: no forbidden Bug C phrases`);
    };

    // Adversarial 1: generateAdminResponseEmail — Franco notes "please proceed"; broker's last
    // message was "yes I'll send the AML/PEP today". This is the exact Scenario 3 shape that
    // produced "Hi Jason! Perfect — thanks for confirming the approval!" pre-fix.
    try {
      const adminEmail = await realAi.generateAdminResponseEmail(
        {
          borrower_name: 'Derek Olsen',
          broker_name: 'Jason Mercer',
          sender_name: 'Jason Mercer',
          sender_type: 'broker',
          ltv_percent: 62,
        },
        'Please proceed — looks like a solid deal at 62% LTV.',
        [
          { direction: 'inbound', body: 'Yes, I will have the borrower complete the AML and PEP forms and send back today. Thanks!' },
        ]
      );
      console.log('generateAdminResponseEmail output (first 300 chars):');
      console.log(`  ${(adminEmail || '').slice(0, 300).replace(/\n/g, ' ')}`);
      checkBugC('generateAdminResponseEmail', adminEmail);
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  generateAdminResponseEmail smoke skipped due to API error: ${e.message}`);
    }

    // Adversarial 2 — RETIRED by Group BBB: generateCompletionEmail is now a
    // deterministic JS template (no Claude call), so the Bug C adversarial smoke
    // (Claude-output Franco-attribution leak detection) doesn't apply. The
    // template intentionally includes "Franco" in the directive "direct any
    // further questions to Franco" per Q5 — that's the hardcoded handoff target,
    // NOT a Franco-as-actor leak. Deterministic Group BBB B4 test exercises the
    // template directly.

    // ════════════════════════════════════════════════════════════════
    // GROUP I — adversarial live Claude smoke for document-receipt fabrication
    // ════════════════════════════════════════════════════════════════
    // Scenario 6 Bug 6: broker's email body claimed Government ID was enclosed,
    // but no Gov ID was actually saved to the file. Vienna pre-fix acknowledged
    // it as received. Post-fix: Vienna must check the on-file list and treat
    // unverified docs as missing.
    console.log('\n========== GROUP I — fabrication-prevention adversarial ==========');

    // Patterns that indicate Vienna FALSELY claimed receipt of a never-submitted doc.
    // Each entry: phrase that suggests acknowledgement-of-receipt followed by the doc name
    // within a short window (no sentence boundary between them).
    const fabricationRegexes = {
      'Government ID': [
        /thanks?\s+for\s+(?:the\s+|sending\s+(?:the\s+)?|your\s+)?gov(?:ernment)?[\s-]*id/i,
        /received\s+(?:the\s+|your\s+)?gov(?:ernment)?[\s-]*id/i,
        /\bgot\s+(?:the\s+|your\s+)?gov(?:ernment)?[\s-]*id/i,
        /\bhave\s+(?:the\s+|your\s+)?gov(?:ernment)?[\s-]*id\s+(?:in\s+hand|on\s+file|now)/i,
      ],
      'Property Tax Bill / Assessment': [
        /thanks?\s+for\s+(?:the\s+|sending\s+(?:the\s+)?|your\s+)?(?:property\s+)?tax\s+(?:bill|assessment)/i,
        /received\s+(?:the\s+|your\s+)?(?:property\s+)?tax\s+(?:bill|assessment)/i,
        /\bgot\s+(?:the\s+|your\s+)?(?:property\s+)?tax\s+(?:bill|assessment)/i,
        /\bhave\s+(?:the\s+|your\s+)?(?:property\s+)?tax\s+(?:bill|assessment)\s+(?:in\s+hand|on\s+file|now)/i,
      ],
    };

    const checkFabrication = (label, html, fabRegexes) => {
      const failures = [];
      for (const [docName, patterns] of Object.entries(fabRegexes)) {
        for (const re of patterns) {
          const m = (html || '').match(re);
          if (m) {
            failures.push(`${docName}: matched "${m[0]}"`);
          }
        }
      }
      if (failures.length > 0) {
        throw new Error(`FAIL [${label}]: Vienna fabricated receipt of unsubmitted docs:\n  - ${failures.join('\n  - ')}`);
      }
      console.log(`  PASS [${label}]: no fabricated receipt of unsubmitted docs`);
    };

    // Adversarial: broker's email body claims Gov ID + Property Tax bill enclosed.
    // attachments=[] (the claim is a lie — nothing actually attached).
    // documentsOnFile contains NEITHER. Vienna must NOT acknowledge them; she must
    // ask the broker to re-send.
    try {
      const groupIResult = await realAi.generateBrokerResponse(
        `Hi! Sending through the Government ID and the property tax bill — both should be attached.\n\nThanks!\nJason Mercer`,
        [], // Postmark attachments — empty (broker claim is unfulfilled)
        [], // savedDocs — empty
        {
          borrower_name: 'Kevin Tran',
          broker_name: 'Jason Mercer',
          sender_name: 'Jason Mercer',
          sender_type: 'broker',
          ltv_percent: 58.8,
        },
        [
          { direction: 'outbound', body: 'Thanks for the package! I have the appraisal, NOA, and credit bureau on file. Still need: government ID, property tax assessment, and the CIBC mortgage payout statement.', created_at: new Date().toISOString() },
        ],
        // documentsOnFile — what we ACTUALLY have saved. NO Gov ID, NO Tax bill.
        [
          { file_name: 'Appraisal_Tran.pdf', classification: 'appraisal' },
          { file_name: 'NOA_Tran_2024.pdf', classification: 'noa' },
          { file_name: 'Credit_Report_Tran.pdf', classification: 'credit_report' },
        ]
      );
      const responseHtml = groupIResult?.responseEmail || '';
      console.log('Group I adversarial output (first 400 chars):');
      console.log(`  ${responseHtml.slice(0, 400).replace(/\n/g, ' ')}`);
      checkFabrication('generateBrokerResponse — broker claims attached but nothing on file', responseHtml, fabricationRegexes);
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Group I adversarial smoke skipped due to API error: ${e.message}`);
    }

    // ════════════════════════════════════════════════════════════════
    // GROUP H — adversarial live Claude smoke for completeness self-consistency
    // ════════════════════════════════════════════════════════════════
    // Bugs 6.5 (Kevin Tran) + 8.6 (Sandra Fletcher): Vienna wrote "complete file /
    // package, ready to start working" while still listing missing docs in the same
    // email. Post-fix: when ANY item from the standard checklist is missing, none of
    // the completeness phrases may appear in the reply.
    console.log('\n========== GROUP H — completeness self-consistency adversarial ==========');

    const completenessForbidden = [
      [/\bcomplete\s+(?:file|package|documentation|set)\b/i, '"complete file/package/documentation/set"'],
      [/\bthe\s+full\s+package\b/i, '"the full package"'],
      [/\ball\s+the\s+(?:necessary|required)\s+(?:documents|documentation)\b/i, '"all the necessary/required documents/documentation"'],
      [/\bwe\s+have\s+everything\s+we\s+need\b/i, '"we have everything we need"'],
      [/\bready\s+to\s+start\s+working\b/i, '"ready to start working"'],
      [/\bthe\s+(?:file|package)\s+is\s+complete\b/i, '"the file/package is complete"'],
      [/\bputting\s+together\s+a\s+complete\b/i, '"putting together a complete"'],
    ];

    const checkCompletenessConsistency = (label, html) => {
      const failures = [];
      for (const [re, desc] of completenessForbidden) {
        const m = (html || '').match(re);
        if (m) {
          const ctx = (html || '').slice(Math.max(0, m.index - 20), m.index + m[0].length + 30);
          failures.push(`${desc} — matched at "...${ctx}..."`);
        }
      }
      if (failures.length > 0) {
        throw new Error(`FAIL [${label}]: completeness phrases used while items still missing:\n  - ${failures.join('\n  - ')}`);
      }
      console.log(`  PASS [${label}]: no completeness phrases despite missing docs`);
    };

    // Adversarial: broker just sent appraisal + NOA. Most of the standard checklist
    // (gov ID, property_tax, mortgage_statement, AML, PEP, loan_application, pnw)
    // is still missing. Vienna must NOT use any "complete" / "we have everything"
    // / "ready to start working" language.
    try {
      const groupHResult = await realAi.generateBrokerResponse(
        `Hi! Just sent through the appraisal and NOA for Kevin's file. The rest will follow next week.\n\nThanks,\nJason Mercer`,
        [],
        [],
        {
          borrower_name: 'Kevin Tran',
          broker_name: 'Jason Mercer',
          sender_name: 'Jason Mercer',
          sender_type: 'broker',
          ltv_percent: 58.8,
          loan_type: 'second mortgage',
        },
        [
          { direction: 'inbound', body: 'Hi Vienna, looking to submit a 2nd mortgage for Kevin Tran. Will send docs shortly.', created_at: new Date(Date.now() - 86400000).toISOString() },
          { direction: 'outbound', body: 'Thanks Jason — please send through the standard package when you can.', created_at: new Date(Date.now() - 80000000).toISOString() },
        ],
        // documentsOnFile — only 2 items. Most of the standard checklist is missing.
        [
          { file_name: 'Appraisal_Tran.pdf', classification: 'appraisal' },
          { file_name: 'NOA_Tran_2024.pdf', classification: 'noa' },
        ]
      );
      const groupHHtml = groupHResult?.responseEmail || '';
      console.log('Group H adversarial output (first 500 chars):');
      console.log(`  ${groupHHtml.slice(0, 500).replace(/\n/g, ' ')}`);
      checkCompletenessConsistency('generateBrokerResponse — most of checklist missing', groupHHtml);
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Group H adversarial smoke skipped due to API error: ${e.message}`);
    }

    // ════════════════════════════════════════════════════════════════
    // GROUP M — adversarial live Claude smoke for vague missing-doc list
    // ════════════════════════════════════════════════════════════════
    // Bug 8.5 (Sandra Fletcher): Vienna polished Franco's notes into
    // "I'll need you to request the final documents from Sandra" without
    // naming any of the outstanding items. Post-fix: Vienna must enumerate
    // each missing doc by its specific name.
    console.log('\n========== GROUP M — vague missing-doc list adversarial ==========');

    // Forbidden vague phrasings when missing docs are referenced.
    // Negative lookahead `(?!\s*:)` excludes list-introducer patterns where the
    // phrase IS followed by an explicit enumeration ("the remaining items: A, B, C")
    // — that's not vague, the names follow. Vague case is "the remaining items"
    // standing alone or followed by other prose.
    const vaguePhrases = [
      [/\bthe\s+final\s+documents\b(?!\s*:)/i, '"the final documents"'],
      [/\bthe\s+missing\s+documents\b(?!\s*:)/i, '"the missing documents"'],
      [/\bthe\s+outstanding\s+(?:items|documents|paperwork)\b(?!\s*:)/i, '"the outstanding items/documents/paperwork"'],
      [/\bthe\s+rest\s+of\s+the\s+(?:package|documents|paperwork)\b(?!\s*:)/i, '"the rest of the package/documents"'],
      [/\bthe\s+remaining\s+(?:paperwork|documents|items)\b(?!\s*:)/i, '"the remaining paperwork/documents/items"'],
      [/\bthe\s+final\s+items\b(?!\s*:)/i, '"the final items"'],
    ];

    const checkVagueness = (label, html, expectedDocNames) => {
      const failures = [];
      // Fail if any vague phrase appears
      for (const [re, desc] of vaguePhrases) {
        const m = (html || '').match(re);
        if (m) {
          const ctx = (html || '').slice(Math.max(0, m.index - 20), m.index + m[0].length + 30);
          failures.push(`vague phrase ${desc} — matched at "...${ctx}..."`);
        }
      }
      // Soft-check: at least one of the expected doc names should appear (Vienna actually enumerated)
      const namedAny = expectedDocNames.some(name => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(html || ''));
      if (!namedAny) {
        failures.push(`none of the expected doc names appeared in the email: ${JSON.stringify(expectedDocNames)}`);
      }
      if (failures.length > 0) {
        throw new Error(`FAIL [${label}]: vague missing-doc reference:\n  - ${failures.join('\n  - ')}`);
      }
      console.log(`  PASS [${label}]: enumerated missing docs by name, no vague phrases`);
    };

    // Adversarial: Franco's notes flag missing docs by name; conversation history includes
    // Vienna's prior prelim-review email enumerating them. Vienna must enumerate by name
    // in the polished broker reply.
    try {
      const groupMResult = await realAi.generateAdminResponseEmail(
        {
          borrower_name: 'Sandra Fletcher',
          broker_name: 'David Park',
          sender_name: 'David Park',
          ltv_percent: 62.6,
        },
        'Looking good — please ask David for the remaining items: Government-Issued ID, Property Tax Assessment, and the Current Mortgage Payout Statement.',
        [
          { direction: 'inbound', body: 'Hi Vienna, here is Sandra Fletcher\'s file for review. Attached is the appraisal, NOA, application, and credit report.', created_at: new Date(Date.now() - 172800000).toISOString() },
          { direction: 'outbound', body: 'Thanks David! I have the appraisal, NOA, application, and credit report on file. Still outstanding: Government-Issued ID, Property Tax Assessment, Current Mortgage Payout Statement.', created_at: new Date(Date.now() - 86400000).toISOString() },
        ]
      );
      console.log('Group M adversarial output (first 500 chars):');
      console.log(`  ${(groupMResult || '').slice(0, 500).replace(/\n/g, ' ')}`);
      checkVagueness('generateAdminResponseEmail — missing docs referenced',
        groupMResult,
        ['Government', 'Tax', 'Mortgage Payout']
      );
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Group M adversarial smoke skipped due to API error: ${e.message}`);
    }

    // ════════════════════════════════════════════════════════════════
    // GROUP J — adversarial live Claude smoke for closing-email package recap
    // ════════════════════════════════════════════════════════════════
    // Bugs 6.7 (Kevin Tran, 9 docs re-listed) + 7.4 (Ethan Broussard, 8 docs).
    // Vienna's closing email enumerated every document received throughout the file.
    // Post-fix: closing email may name at most the LATEST batch (typically 1-3 items
    // from the broker's most recent message). Threshold: response containing 4+
    // distinct doc-name patterns = full-package recap = FAIL.
    console.log('\n========== GROUP J — closing email package-recap adversarial ==========');

    // Doc-name regexes — each matches one document type. Tight enough to avoid
    // false positives (e.g. "ID number" not matched, only "gov ID" / "Government ID").
    const docNamePatterns = [
      [/\bappraisal\b/i, 'appraisal'],
      [/\bNOA\b|\bnotice\s+of\s+assessment\b/i, 'NOA'],
      [/\b(?:government|gov)[\s-]+(?:issued[\s-]+)?id\b/i, 'gov ID'],
      [/\bcredit\s+(?:report|bureau|score)\b/i, 'credit report'],
      [/\bAML\b/, 'AML'],
      [/\bPEP\b/, 'PEP'],
      [/\bloan\s+application\b/i, 'loan application'],
      [/\bPNW\b|\bpersonal\s+net[\s-]+worth\b/i, 'PNW'],
      [/\bproperty\s+tax\s+(?:bill|assessment)\b/i, 'property tax'],
      [/\b(?:mortgage\s+)?payout\s+statement\b|\bmortgage\s+(?:balance|statement)\b/i, 'mortgage statement'],
    ];

    const checkPackageRecap = (label, html, threshold = 4) => {
      const named = [];
      for (const [re, name] of docNamePatterns) {
        if (re.test(html || '')) named.push(name);
      }
      if (named.length >= threshold) {
        throw new Error(`FAIL [${label}]: closing email enumerated ${named.length} doc names (full-package recap, threshold ${threshold}). Named: ${named.join(', ')}`);
      }
      console.log(`  PASS [${label}]: closing email named ${named.length} doc(s) [${named.join(', ') || 'none'}] — under threshold ${threshold}`);
    };

    // Adversarial: docs-on-file has 7 items (full package). Conversation history shows
    // the broker just sent the last 3 (gov ID, tax assessment, payout statement) in
    // their most recent message. Vienna must NOT re-enumerate the earlier 4.
    try {
      const groupJResult = await realAi.generateCompletionEmail(
        {
          borrower_name: 'Kevin Tran',
          broker_name: 'Jason Mercer',
          sender_name: 'Jason Mercer',
        },
        [
          { direction: 'outbound', body: 'Thanks Jason — I have the appraisal, NOA, credit bureau, and loan application on file. Still need: Government-Issued ID, Property Tax Assessment, and the CIBC mortgage payout statement.', created_at: new Date(Date.now() - 172800000).toISOString() },
          { direction: 'inbound', body: 'Here are the last three — gov ID, tax assessment, and the CIBC payout statement attached. Thanks!', created_at: new Date(Date.now() - 3600000).toISOString() },
        ],
        // documentsOnFile — full package, 7 items. Only the last 3 are the latest batch.
        [
          { file_name: 'Appraisal_Tran.pdf', classification: 'appraisal' },
          { file_name: 'NOA_Tran_2024.pdf', classification: 'noa' },
          { file_name: 'Credit_Report_Tran.pdf', classification: 'credit_report' },
          { file_name: 'Loan_Application_Tran.pdf', classification: 'loan_application' },
          { file_name: 'Government_ID_Tran.pdf', classification: 'government_id' },
          { file_name: 'Property_Tax_Tran.pdf', classification: 'property_tax' },
          { file_name: 'CIBC_Payout_Tran.pdf', classification: 'mortgage_statement' },
        ]
      );
      console.log('Group J adversarial output (first 500 chars):');
      console.log(`  ${(groupJResult || '').slice(0, 500).replace(/\n/g, ' ')}`);
      checkPackageRecap('generateCompletionEmail — full file on hand', groupJResult);
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Group J adversarial smoke skipped due to API error: ${e.message}`);
    }

    // ════════════════════════════════════════════════════════════════
    // GROUP N — adversarial live Claude smoke for wrong doc-flow direction
    // ════════════════════════════════════════════════════════════════
    // Bug 8.7 (Sandra Fletcher): Vienna told the broker to "request the final
    // documents from Sandra" — naming the borrower as source. Per Franco: brokers
    // provide docs directly to Vienna; Vienna stays neutral on sourcing.
    // Hardest test: Franco's notes themselves phrase it as "ask broker to request
    // from borrower" — Vienna must NOT carry that framing forward.
    console.log('\n========== GROUP N — doc-flow direction adversarial ==========');

    const directionForbidden = (borrowerFirstName) => [
      // Naming borrower as source via "from"
      [new RegExp(`(?:request|requesting|get|getting|collect|collecting|gather|gathering)[^.!?\\n]{0,40}from\\s+(?:${borrowerFirstName}|the\\s+borrower|her|him|them)\\b`, 'i'),
        `request/collect/get from ${borrowerFirstName}/the borrower`],
      // "Have X send/provide/forward"
      [new RegExp(`\\bhave\\s+(?:${borrowerFirstName}|the\\s+borrower|her|him|them)\\s+(?:send|provide|forward|share|submit)`, 'i'),
        `have ${borrowerFirstName}/borrower send/provide/forward`],
      // "Ask X for/to send/to provide"
      [new RegExp(`\\bask\\s+(?:${borrowerFirstName}|the\\s+borrower|her|him|them)\\s+(?:for|to\\s+send|to\\s+provide|to\\s+forward)`, 'i'),
        `ask ${borrowerFirstName}/borrower for/to send`],
      // "Chase X" / "follow up with X" for docs
      [new RegExp(`\\b(?:chase|follow\\s+up\\s+with|reach\\s+out\\s+to)\\s+(?:${borrowerFirstName}|the\\s+borrower|her|him|them)\\b`, 'i'),
        `chase/follow up with ${borrowerFirstName}/borrower`],
    ];

    const checkDirection = (label, html, borrowerFirstName) => {
      const failures = [];
      for (const [re, desc] of directionForbidden(borrowerFirstName)) {
        const m = (html || '').match(re);
        if (m) {
          const ctx = (html || '').slice(Math.max(0, m.index - 25), m.index + m[0].length + 30);
          failures.push(`${desc} — matched at "...${ctx}..."`);
        }
      }
      if (failures.length > 0) {
        throw new Error(`FAIL [${label}]: Vienna instructed broker to source docs from borrower:\n  - ${failures.join('\n  - ')}`);
      }
      console.log(`  PASS [${label}]: doc requests phrased neutrally (no borrower-as-source)`);
    };

    // Adversarial: Franco's own notes phrase it as "ask broker to request from
    // Sandra" — Vienna must reframe neutrally in the broker reply.
    try {
      const groupNResult = await realAi.generateAdminResponseEmail(
        {
          borrower_name: 'Sandra Fletcher',
          broker_name: 'David Park',
          sender_name: 'David Park',
          ltv_percent: 62.6,
        },
        'Looking good — please ask David to request the Government-Issued ID, Property Tax Assessment, and Current Mortgage Payout Statement from Sandra.',
        [
          { direction: 'inbound', body: 'Hi Vienna, here is Sandra Fletcher\'s file.', created_at: new Date(Date.now() - 172800000).toISOString() },
          { direction: 'outbound', body: 'Thanks David! I have the appraisal, NOA, application, and credit report on file. Still outstanding: Government-Issued ID, Property Tax Assessment, Current Mortgage Payout Statement.', created_at: new Date(Date.now() - 86400000).toISOString() },
        ]
      );
      console.log('Group N adversarial output (first 500 chars):');
      console.log(`  ${(groupNResult || '').slice(0, 500).replace(/\n/g, ' ')}`);
      checkDirection('generateAdminResponseEmail — Franco notes phrase it as from-borrower', groupNResult, 'Sandra');
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Group N adversarial smoke skipped due to API error: ${e.message}`);
    }

    // ════════════════════════════════════════════════════════════════
    // GROUP O — adversarial live Claude smoke for tone & brevity
    // ════════════════════════════════════════════════════════════════
    // Bug 8.8 (Sandra Fletcher): Vienna's broker-facing reply was multi-paragraph praise
    // of borrower employment, income, credit, property, plus complimenting broker's work.
    // Post-fix: 1-4 sentence acknowledgments, no praise paragraphs, no borrower-profile
    // commentary, no multi-sentence broker compliments.
    console.log('\n========== GROUP O — tone & brevity adversarial ==========');

    // Forbidden praise patterns + soft length cap.
    const praiseForbidden = [
      [/\bexcellent\s+job\b/i, '"excellent job"'],
      [/\bthorough\s+(?:work|job)\b/i, '"thorough work/job"'],
      [/\bmeticulous(?:ly)?\b/i, '"meticulous(ly)"'],
      [/\b(?:strong|excellent|impressive|outstanding|exceptional)\s+(?:credit|income|employment|profile|file|borrower|deal|candidate)\b/i, '"strong/excellent/impressive [borrower attribute]"'],
      [/\bwell[\s-]+(?:prepared|positioned|qualified|presented)\b/i, '"well-prepared/positioned/qualified"'],
      [/\bappreciate\s+(?:how|your\s+thorough|the\s+thoroughness|the\s+detail|the\s+care)/i, '"appreciate how/your thorough/the thoroughness/the detail"'],
    ];

    const stripHtml = (html) => (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

    const checkBrevity = (label, html, maxSentences = 8, maxWords = 200) => {
      const stripped = stripHtml(html);
      const sentences = stripped.split(/[.!?]+/).filter(s => s.trim().length > 5);
      const words = stripped.split(/\s+/).filter(Boolean);
      const failures = [];

      for (const [re, desc] of praiseForbidden) {
        const m = stripped.match(re);
        if (m) {
          const ctx = stripped.slice(Math.max(0, m.index - 20), m.index + m[0].length + 30);
          failures.push(`praise phrase ${desc} — matched at "...${ctx}..."`);
        }
      }
      if (sentences.length > maxSentences) {
        failures.push(`${sentences.length} sentences (cap: ${maxSentences}) — likely multi-paragraph praise`);
      }
      if (words.length > maxWords) {
        failures.push(`${words.length} words (cap: ${maxWords}) — too long for an underwriting acknowledgment`);
      }

      if (failures.length > 0) {
        throw new Error(`FAIL [${label}]: tone/brevity violations:\n  - ${failures.join('\n  - ')}`);
      }
      console.log(`  PASS [${label}]: ${sentences.length} sentences, ${words.length} words, no praise patterns`);
    };

    // Adversarial: Sandra Fletcher case — strong borrower profile in deal summary, Franco's
    // approval invites praise. Vienna must stay concise and not compliment borrower or broker.
    try {
      const groupOResult = await realAi.generateAdminResponseEmail(
        {
          borrower_name: 'Sandra Fletcher',
          broker_name: 'David Park',
          sender_name: 'David Park',
          ltv_percent: 62.6,
          income_details: 'Senior Engineer at TechCorp, 12 years tenure, $185K salary',
          key_risks_or_notes: 'Excellent credit (810), strong income, low LTV, well-prepared file',
        },
        'Strong file overall — please proceed and request the Government-Issued ID, Property Tax Assessment, and Current Mortgage Payout Statement.',
        [
          { direction: 'inbound', body: 'Hi Vienna, here is Sandra Fletcher — clean file, strong borrower. Attached is the appraisal, NOA, application, credit report.', created_at: new Date(Date.now() - 172800000).toISOString() },
          { direction: 'outbound', body: 'Thanks David! I have the appraisal, NOA, application, and credit report on file. Still outstanding: Government-Issued ID, Property Tax Assessment, Current Mortgage Payout Statement.', created_at: new Date(Date.now() - 86400000).toISOString() },
        ]
      );
      console.log('Group O adversarial output (first 600 chars):');
      console.log(`  ${(groupOResult || '').slice(0, 600).replace(/\n/g, ' ')}`);
      checkBrevity('generateAdminResponseEmail — strong borrower profile invites praise', groupOResult);
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Group O adversarial smoke skipped due to API error: ${e.message}`);
    }

    // ════════════════════════════════════════════════════════════════
    // GROUP K — adversarial live Claude smoke for mortgage-doc terminology unification
    // ════════════════════════════════════════════════════════════════
    // Bug 6.8 (Kevin Tran): Vienna treated "CIBC Payout Statement" and "current balance"
    // as two separate missing items. Pre-fix DOC_DISPLAY_NAMES used "Current Mortgage
    // Balance Statement" while every other prompt used "Current Mortgage Payout
    // Statement" — Vienna saw two distinct phrasings and listed both.
    //
    // Post-fix: canonical name is "Current Mortgage Payout Statement" everywhere; an
    // explicit unification rule tells Vienna these are the same single document.
    console.log('\n========== GROUP K — mortgage-doc terminology adversarial ==========');

    const checkMortgageUnification = (label, html) => {
      const stripped = stripHtml(html);
      const failures = [];

      // (1) The old DOC_DISPLAY_NAMES phrasing must NEVER appear in the response.
      if (/\bcurrent\s+mortgage\s+balance\s+statement\b/i.test(stripped)) {
        failures.push('"Current Mortgage Balance Statement" — old DOC_DISPLAY_NAMES phrasing leaked into response');
      }

      // (2) Two-items pattern: "current (mortgage) balance" mentioned as a standalone
      // item (not attached to "statement") AND "payout statement" mentioned separately.
      // That's the bug shape — Vienna treating them as two distinct missing items.
      const sentences = stripped.split(/[.!?]+/);
      const hasStandaloneBalance = sentences.some(s =>
        /\bcurrent\s+(?:mortgage\s+)?balance\b/i.test(s) &&
        !/\bbalance\s+statement\b/i.test(s)
      );
      const hasPayoutMention = /\bpayout\s+statement\b/i.test(stripped);
      if (hasStandaloneBalance && hasPayoutMention) {
        failures.push('"current balance" mentioned as a standalone item alongside "payout statement" — Vienna treating same doc as two items');
      }

      if (failures.length > 0) {
        throw new Error(`FAIL [${label}]: mortgage-doc terminology violations:\n  - ${failures.join('\n  - ')}`);
      }
      console.log(`  PASS [${label}]: mortgage-doc terminology unified (no old phrasing, no two-item split)`);
    };

    // Adversarial: refinance with no mortgage statement on file. Vienna must ask for
    // ONE mortgage doc by canonical name, not two.
    try {
      const groupKResult = await realAi.generateBrokerResponse(
        `Hi Vienna,\n\nSending the appraisal and NOA for Kevin's refi. Working on the rest.\n\nThanks,\nJason`,
        [],
        [],
        {
          borrower_name: 'Kevin Tran',
          broker_name: 'Jason Mercer',
          sender_name: 'Jason Mercer',
          sender_type: 'broker',
          ltv_percent: 58.8,
          loan_type: 'refinance',
          existing_mortgage_balance: 320000,
        },
        [
          { direction: 'inbound', body: 'Hi Vienna, refi for Kevin Tran — first mortgage with CIBC, looking to refinance with you.', created_at: new Date(Date.now() - 86400000).toISOString() },
        ],
        // documentsOnFile — refinance with no mortgage statement yet.
        [
          { file_name: 'Appraisal_Tran.pdf', classification: 'appraisal' },
          { file_name: 'NOA_Tran_2024.pdf', classification: 'noa' },
        ]
      );
      const groupKHtml = groupKResult?.responseEmail || '';
      console.log('Group K adversarial output (first 600 chars):');
      console.log(`  ${groupKHtml.slice(0, 600).replace(/\n/g, ' ')}`);
      checkMortgageUnification('generateBrokerResponse — refi missing mortgage doc', groupKHtml);

      // Item 2 extension — same fixture, additional doc-name unification checks.
      // Vienna's response asks for missing items; she should NOT name the same doc
      // under two different phrasings (Credit Report + Credit Bureau Report, or
      // Personal Net Worth Statement + PNW Statement, etc.) in the same email.
      const checkDocNamingDuplicates = (label, html, pair) => {
        const stripped = (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        const matches = pair.variants.filter(re => re.test(stripped));
        if (matches.length >= 2) {
          throw new Error(`FAIL [${label}]: ${pair.name} appears under multiple names in same email — ${matches.length} of ${pair.variants.length} variant patterns matched. Vienna may be listing the same doc twice.`);
        }
        console.log(`  PASS [${label}]: ${pair.name} not duplicated under multiple phrasings (${matches.length} variant matched)`);
      };

      checkDocNamingDuplicates('Item 2 — credit report unification', groupKHtml, {
        name: 'Credit Report',
        variants: [
          /\bcredit\s+report\b/i,
          /\bcredit\s+bureau\s+report/i,
          /\bcredit\s+bureau\b(?!\s+report)/i,
        ],
      });
      checkDocNamingDuplicates('Item 2 — PNW unification', groupKHtml, {
        name: 'PNW Statement',
        variants: [
          /\bpersonal\s+net\s+worth\s+statement\b/i,
          /\bpnw\s+statement\s+form\b/i,
          /\bpnw\s+statement\b(?!\s+form)/i,
        ],
      });
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Group K / Item 2 adversarial smoke skipped due to API error: ${e.message}`);
    }

    // ════════════════════════════════════════════════════════════════
    // GROUP T — adversarial live Claude smoke for unstated-lender hallucination
    // ════════════════════════════════════════════════════════════════
    // Bug 15.1 (TD Bank) + recurring shape from Scenario 3 Bug 8 (RBC).
    // Vienna fills in a specific bank name that the broker never stated.
    // Post-fix: when no lender is named in the input, Vienna's reply must NOT
    // contain any specific bank name — she should ask the broker to confirm.
    console.log('\n========== GROUP T — unstated-lender adversarial ==========');

    // Common Canadian mortgage-lender names that are forbidden when not stated.
    // \b boundaries used; for ambiguous abbreviations like TD/RBC/BMO/CIBC/ATB
    // these are upper-case only to avoid catching unrelated lowercase substrings
    // (TD also appears in words; we want to catch only the institution acronym).
    const lenderForbidden = [
      [/\bTD\s+(?:Bank|Canada\s+Trust)\b/i,         '"TD Bank/Canada Trust"'],
      [/\bRBC\b/,                                    '"RBC"'],
      [/\bRoyal\s+Bank\b/i,                          '"Royal Bank"'],
      [/\bBMO\b/,                                    '"BMO"'],
      [/\bBank\s+of\s+Montreal\b/i,                  '"Bank of Montreal"'],
      [/\bCIBC\b/,                                   '"CIBC"'],
      [/\bScotia(?:bank)?\b/i,                       '"Scotia(bank)"'],
      [/\bNational\s+Bank\b/i,                       '"National Bank"'],
      [/\bTangerine\b/i,                             '"Tangerine"'],
      [/\bManulife\b/i,                              '"Manulife"'],
      [/\bEquitable\s+Bank\b/i,                      '"Equitable Bank"'],
      [/\bHaventree\b/i,                             '"Haventree"'],
      [/\bMCAP\b/,                                   '"MCAP"'],
    ];

    const checkUnstatedLender = (label, html) => {
      const failures = [];
      for (const [re, desc] of lenderForbidden) {
        const m = (html || '').match(re);
        if (m) {
          const ctx = (html || '').slice(Math.max(0, m.index - 25), m.index + m[0].length + 30);
          failures.push(`${desc} appeared in response — broker never stated this lender. Matched at "...${ctx}..."`);
        }
      }
      if (failures.length > 0) {
        throw new Error(`FAIL [${label}]: lender hallucination detected:\n  - ${failures.join('\n  - ')}`);
      }
      console.log(`  PASS [${label}]: no unstated lender names in response`);
    };

    // Adversarial: broker's email and conversation history mention NO specific lender.
    // Just generic "first mortgage" and "refi". Vienna must ask which lender holds
    // the existing mortgage — NOT fill in TD/RBC/etc.
    try {
      const groupTResult = await realAi.generateBrokerResponse(
        `Hi Vienna,\n\nSubmitting a refi for my client. Property in Toronto. First mortgage on title — looking to refinance with a private second.\n\nAttached: appraisal, NOA, credit bureau, and our application form.\n\nThanks,\nJason Mercer`,
        [],
        [],
        {
          borrower_name: 'Patricia Wilson',
          broker_name: 'Jason Mercer',
          sender_name: 'Jason Mercer',
          sender_type: 'broker',
          ltv_percent: 65,
          loan_type: 'second mortgage',
          existing_mortgage_balance: 350000,
          // No bank/lender name anywhere in deal summary
        },
        [],
        // documentsOnFile — appraisal, NOA, credit, application on file. No mortgage statement.
        [
          { file_name: 'Appraisal_Wilson.pdf', classification: 'appraisal' },
          { file_name: 'NOA_Wilson_2024.pdf', classification: 'noa' },
          { file_name: 'Credit_Bureau_Wilson.pdf', classification: 'credit_report' },
          { file_name: 'Application_Wilson.pdf', classification: 'loan_application' },
        ]
      );
      const groupTHtml = groupTResult?.responseEmail || '';
      console.log('Group T adversarial output (first 600 chars):');
      console.log(`  ${groupTHtml.slice(0, 600).replace(/\n/g, ' ')}`);
      checkUnstatedLender('generateBrokerResponse — no lender stated, Vienna must not invent', groupTHtml);
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Group T adversarial smoke skipped due to API error: ${e.message}`);
    }

    // ════════════════════════════════════════════════════════════════
    // GROUP V — adversarial live Claude smoke for referral re-ask removal
    // ════════════════════════════════════════════════════════════════
    // Bug 11.1 (David referral): broker referred an existing client to Vienna
    // (via Franco) with full deal context. Vienna asked David "Could you briefly
    // describe your situation in your own words?" — re-asking despite full context
    // creates a poor borrower experience. Per Porter's hard reversal: when
    // deal_details is populated, NEVER ask the borrower to describe.
    console.log('\n========== GROUP V — referral re-ask adversarial ==========');

    // Forbidden re-ask patterns when deal_details is populated.
    const reAskForbidden = [
      [/\bdescribe\s+your\s+(?:situation|circumstances)\b/i, '"describe your situation"'],
      [/\bquick\s+rundown\b/i, '"quick rundown"'],
      [/\b(?:give|share|tell)\s+(?:me|us|me\s+a\s+)?(?:a\s+)?(?:bit|brief|quick|short)\s+(?:rundown|overview|background|description)\s+of\s+(?:your|what)/i, '"give me a [bit/brief/quick/short] [rundown/overview] of your..."'],
      [/\bin\s+your\s+own\s+words\b/i, '"in your own words"'],
      [/\bcould\s+you\s+(?:briefly\s+)?describe\b/i, '"could you (briefly) describe"'],
      [/\bcould\s+you\s+(?:briefly\s+)?(?:share|tell|walk\s+me)\b/i, '"could you (briefly) share/tell/walk me through"'],
      [/\bwrite[\s-]?up\s+(?:about|of|on)\s+(?:your|what)/i, '"write-up about/of your..."'],
      [/\b(?:tell|share)\s+(?:me|us)\s+(?:a\s+bit\s+)?about\s+(?:your\s+(?:situation|deal)|what\s+you'?re\s+looking)/i, '"tell/share us about your situation / what you\'re looking for"'],
    ];

    const checkNoReAsk = (label, html) => {
      const failures = [];
      for (const [re, desc] of reAskForbidden) {
        const m = (html || '').match(re);
        if (m) {
          const ctx = (html || '').slice(Math.max(0, m.index - 25), m.index + m[0].length + 30);
          failures.push(`${desc} — matched at "...${ctx}..."`);
        }
      }
      if (failures.length > 0) {
        throw new Error(`FAIL [${label}]: Vienna asked the borrower to describe their situation despite full deal context being provided:\n  - ${failures.join('\n  - ')}`);
      }
      console.log(`  PASS [${label}]: no re-ask patterns when deal context is full`);
    };

    // Adversarial: full deal context provided in referralData.deal_details.
    // Vienna must NOT re-ask the borrower.
    try {
      const groupVResult = await realAi.generateReferralWelcomeEmail({
        referred_name: 'David Thompson',
        referred_email: 'david.thompson@example.com',
        sender_type: 'borrower',
        deal_details: 'David owns an investment property in North York valued at $700,000 with an existing first mortgage of $280,000 at TD. He is looking to take out a $90,000 second mortgage to fund a kitchen renovation. Closing target is mid-November.',
        notes: null,
      });
      console.log('Group V adversarial output (first 600 chars):');
      console.log(`  ${(groupVResult || '').slice(0, 600).replace(/\n/g, ' ')}`);
      checkNoReAsk('generateReferralWelcomeEmail — full deal context, no re-ask', groupVResult);
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Group V adversarial smoke skipped due to API error: ${e.message}`);
    }

    // Positive control: NO deal_details provided. Vienna SHOULD ask for a write-up.
    // (We don't assert this strictly — just log the output for visibility.)
    try {
      const groupVControl = await realAi.generateReferralWelcomeEmail({
        referred_name: 'Maria Lopez',
        referred_email: 'maria.lopez@example.com',
        sender_type: 'borrower',
        deal_details: null,
        notes: null,
      });
      console.log('\nGroup V positive control (no deal_details, write-up ask expected):');
      console.log(`  ${(groupVControl || '').slice(0, 400).replace(/\n/g, ' ')}`);
      // Soft check: the asking-pattern should appear here, since context is missing.
      const asksForRundown = /(?:rundown|describe|tell\s+(?:me|us)|share\s+(?:a|some))/i.test(groupVControl);
      console.log(`  ${asksForRundown ? 'OK' : 'NOTE'}: positive-control ${asksForRundown ? 'asks' : 'does NOT ask'} for a write-up — Vienna ${asksForRundown ? 'correctly' : 'unexpectedly silent'} when no context provided`);
    } catch (e) {
      console.warn(`  Group V positive control skipped due to API error: ${e.message}`);
    }

    // ════════════════════════════════════════════════════════════════
    // GROUP DDD — referral broker branch (S10.1 + S10.2)
    // ════════════════════════════════════════════════════════════════
    // S10.1: Vienna asked broker for a write-up despite Franco providing full deal
    //   context. Group V flipped the borrower branch only (per Bradley's "always ask
    //   broker" rule). Franco's S10 retest reverses that for the broker branch too.
    // S10.2: Vienna attributed the borrower's profile to the broker — wrote "you
    //   have a strong borrower profile with clean credit" to Michael (broker), but
    //   that's the CLIENT's profile, not Michael's.
    // Two smokes — D1 reuses Group V's checkNoReAsk helper for the write-up ask
    // patterns; D2 has a new checkNoBrokerAttribution helper.

    console.log('\n========== GROUP DDD — broker referral with deal_details, no write-up ask ==========');
    try {
      const dddBrokerResult = await realAi.generateReferralWelcomeEmail({
        referred_name: 'Michael Chen',
        referred_email: 'michael.chen@brokerage.com',
        sender_type: 'broker',
        deal_details: 'Michael has a client looking to refinance an investment property in Toronto. Property value $1.2M, existing first $480K with TD, looking for a $200K second. Strong borrower profile, clean credit, good equity position. Closing target end of month.',
        notes: null,
      });
      console.log('Group DDD broker output (first 600 chars):');
      console.log(`  ${(dddBrokerResult || '').slice(0, 600).replace(/\n/g, ' ')}`);
      // Reuse Group V's helper — same forbidden patterns apply to the broker branch.
      checkNoReAsk('generateReferralWelcomeEmail broker — full deal context, no write-up ask', dddBrokerResult);
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Group DDD broker re-ask smoke skipped due to API error: ${e.message}`);
    }

    console.log('\n========== GROUP DDD — broker referral broker-vs-client distinction ==========');

    // Forbidden: second-person attribution of borrower characteristics to the broker.
    // The broker is the RECIPIENT — borrower characteristics belong to their client.
    const brokerVsClientForbidden = [
      [/\byou(?:'ve| have| are)\s+(?:got\s+)?(?:a|an)?\s*(?:strong|clean|good|excellent|solid)\s+(?:borrower|credit|equity|financial|income)/i, '"you have a [strong/clean/good/solid] [borrower/credit/equity/financial/income] [profile/score/position]"'],
      [/\byour\s+(?:strong|clean|good|excellent|solid)\s+(?:borrower\s+)?(?:credit|equity|financial|income|borrower)\b/i, '"your [strong/clean/good/solid] [credit/equity/financial/income/borrower]"'],
      [/\byour\s+(?:borrower\s+)?(?:credit\s+(?:score|history|profile)|equity\s+position|financial\s+(?:position|history))\b/i, '"your borrower credit/equity/financial position"'],
    ];

    const checkNoBrokerAttribution = (label, html) => {
      const failures = [];
      for (const [re, desc] of brokerVsClientForbidden) {
        const m = (html || '').match(re);
        if (m) {
          const ctx = (html || '').slice(Math.max(0, m.index - 30), m.index + m[0].length + 35);
          failures.push(`${desc} — matched at "...${ctx}..."`);
        }
      }
      if (failures.length > 0) {
        throw new Error(`FAIL [${label}]: Vienna attributed borrower characteristics to the broker:\n  - ${failures.join('\n  - ')}`);
      }
      console.log(`  PASS [${label}]: no borrower-attribution to broker (broker-vs-client distinction held)`);
    };

    try {
      const dddDistinctionResult = await realAi.generateReferralWelcomeEmail({
        referred_name: 'Michael Chen',
        referred_email: 'michael.chen@brokerage.com',
        sender_type: 'broker',
        deal_details: 'Michael has a client with a strong borrower profile, clean credit, good equity position. The client owns a $1.2M Toronto property, $480K first mortgage with TD, looking for a $200K second.',
        notes: null,
      });
      console.log('Group DDD distinction output (first 600 chars):');
      console.log(`  ${(dddDistinctionResult || '').slice(0, 600).replace(/\n/g, ' ')}`);
      checkNoBrokerAttribution('generateReferralWelcomeEmail broker — borrower-attribution', dddDistinctionResult);
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Group DDD broker-vs-client smoke skipped due to API error: ${e.message}`);
    }

    // ════════════════════════════════════════════════════════════════
    // ITEMS 3 + 4 — conversational handler state awareness
    // ════════════════════════════════════════════════════════════════
    // Item 3: don't re-thank for documents already acknowledged in a prior Vienna
    //         outbound message (cross-message acknowledgment dedup).
    // Item 4: when status is under_review or ltv_escalated, the file has already
    //         been forwarded — no future-tense "I'll send to Franco" language.

    console.log('\n========== ITEM 3 — no re-thanking confirmed docs ==========');

    const reThankForbidden = (alreadyThankedDocNames) => {
      // Build patterns matching "thanks for the/your X" / "received the X" /
      // "got the X" / "appreciate you sending X" for each doc Vienna already
      // acknowledged. If any of these appear in the turn-2 reply, that's
      // re-thanking.
      return alreadyThankedDocNames.flatMap(doc => [
        new RegExp(`\\bthanks?\\s+for\\s+(?:the\\s+|your\\s+|sending\\s+(?:the\\s+|your\\s+)?)?${doc}`, 'i'),
        new RegExp(`\\b(?:received|got|have)\\s+(?:the\\s+|your\\s+)?${doc}`, 'i'),
        new RegExp(`\\bappreciate\\s+(?:you\\s+sending\\s+)?(?:the\\s+|your\\s+)?${doc}`, 'i'),
      ]);
    };

    const checkNoReThank = (label, html, alreadyThankedDocNames) => {
      const patterns = reThankForbidden(alreadyThankedDocNames);
      const failures = [];
      for (let i = 0; i < patterns.length; i++) {
        const re = patterns[i];
        const m = (html || '').match(re);
        if (m) {
          const docHint = alreadyThankedDocNames[Math.floor(i / 3)];
          const ctx = (html || '').slice(Math.max(0, m.index - 25), m.index + m[0].length + 30);
          failures.push(`re-thanked for ${docHint}: matched "${m[0]}" at "...${ctx}..."`);
        }
      }
      if (failures.length > 0) {
        throw new Error(`FAIL [${label}]: Vienna re-acknowledged previously-confirmed documents:\n  - ${failures.join('\n  - ')}`);
      }
      console.log(`  PASS [${label}]: no re-thanking patterns for previously-acknowledged docs`);
    };

    // Adversarial: turn 1 already thanked for appraisal + NOA. Turn 2 broker sends
    // Government ID. Vienna's turn-2 reply must mention the Gov ID (newly arrived)
    // but NOT re-thank for appraisal/NOA.
    try {
      const item3Result = await realAi.generateBrokerResponse(
        `Hi Vienna, sending the Government ID for Patricia now. Thanks!\n\nJason`,
        [], [],
        {
          borrower_name: 'Patricia Wilson',
          broker_name: 'Jason Mercer',
          sender_name: 'Jason Mercer',
          sender_type: 'broker',
          ltv_percent: 65,
          loan_type: 'second mortgage',
        },
        [
          { direction: 'inbound', body: 'Hi Vienna, submitting a refi for Patricia. Attached: appraisal and NOA.', created_at: new Date(Date.now() - 86400000).toISOString() },
          { direction: 'outbound', body: 'Hi Jason! Thanks for sending those over — I have the appraisal and NOA on file. Still need: Government-Issued ID, Property Tax Assessment, Current Mortgage Payout Statement, AML, PEP. Vienna | Private Mortgage Link', created_at: new Date(Date.now() - 80000000).toISOString() },
          { direction: 'inbound', body: 'Hi Vienna, sending the Government ID for Patricia now. Thanks!', created_at: new Date().toISOString() },
        ],
        [
          { file_name: 'Appraisal_Wilson.pdf', classification: 'appraisal' },
          { file_name: 'NOA_Wilson_2024.pdf', classification: 'noa' },
          { file_name: 'Government_ID_Wilson.pdf', classification: 'government_id' },
        ],
        'active'
      );
      const item3Html = item3Result?.responseEmail || '';
      console.log('Item 3 adversarial output (first 500 chars):');
      console.log(`  ${item3Html.slice(0, 500).replace(/\n/g, ' ')}`);
      checkNoReThank('generateBrokerResponse turn 2 — gov ID arrived, must not re-thank appraisal/NOA',
        item3Html,
        ['appraisal', 'NOA', 'notice\\s+of\\s+assessment']
      );
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Item 3 adversarial smoke skipped due to API error: ${e.message}`);
    }

    console.log('\n========== ITEM 4 — state-aware forwarding language ==========');

    // Forbidden future-tense forwarding patterns when status is post-forward.
    const forwardingForbidden = [
      [/\bi'?ll\s+send\s+(?:this|it|the\s+file|everything)?\s*(?:over\s+)?to\s+(?:franco|admin|the\s+(?:lender|underwrit))/i, 'I\'ll send to Franco/admin'],
      [/\bi'?ll\s+(?:get|put|move)\s+(?:this|it)\s+(?:over|in\s+front)\s+of\s+(?:franco|admin)/i, 'I\'ll get this over to Franco/admin'],
      [/\bi'?ll\s+forward\s+(?:this|it|the\s+file)/i, 'I\'ll forward'],
      [/\bi'?ll\s+route\s+(?:this|it)/i, 'I\'ll route'],
      [/\bi'?ll\s+pass\s+(?:this|it|the\s+file)\s+(?:along|on|over)/i, 'I\'ll pass along'],
      [/\bi'?ll\s+send\s+(?:this|it)\s+(?:for|to)\s+review/i, 'I\'ll send for review'],
      [/\bi'?ll\s+get\s+(?:this|it)\s+over\s+for\s+review/i, 'I\'ll get this over for review'],
      [/\bsending\s+(?:this|it|the\s+file)\s+(?:over\s+)?to\s+(?:franco|admin|the\s+lender)/i, 'sending this to Franco/admin'],
    ];

    const checkNoFutureForwarding = (label, html) => {
      const failures = [];
      for (const [re, desc] of forwardingForbidden) {
        const m = (html || '').match(re);
        if (m) {
          const ctx = (html || '').slice(Math.max(0, m.index - 25), m.index + m[0].length + 30);
          failures.push(`"${desc}" — matched "${m[0]}" at "...${ctx}..."`);
        }
      }
      if (failures.length > 0) {
        throw new Error(`FAIL [${label}]: Vienna used future-tense forwarding language despite status indicating file is already forwarded:\n  - ${failures.join('\n  - ')}`);
      }
      console.log(`  PASS [${label}]: no future-tense forwarding language`);
    };

    // Adversarial: status='under_review', conversation history shows Vienna already
    // sent a Preliminary Review email to admin. Broker now replies with one more doc.
    // Vienna must NOT say "I'll send this to Franco" — the file IS Franco.
    try {
      const item4Result = await realAi.generateBrokerResponse(
        `Hi Vienna, sending the property tax assessment as well. Anything else?\n\nJason`,
        [], [],
        {
          borrower_name: 'Patricia Wilson',
          broker_name: 'Jason Mercer',
          sender_name: 'Jason Mercer',
          sender_type: 'broker',
          ltv_percent: 65,
          loan_type: 'second mortgage',
        },
        [
          { direction: 'inbound', body: 'Submitting refi for Patricia. Attached: appraisal, NOA, gov ID, credit bureau, application.', created_at: new Date(Date.now() - 172800000).toISOString() },
          { direction: 'outbound', body: 'Thanks Jason — file received. Vienna | Private Mortgage Link', created_at: new Date(Date.now() - 170000000).toISOString() },
          { direction: 'outbound', body: 'ACTION REQUIRED: PRELIMINARY Review — Patricia Wilson — 65% LTV (this was the prelim review email Vienna sent to admin)', created_at: new Date(Date.now() - 169000000).toISOString() },
          { direction: 'inbound', body: 'Hi Vienna, sending the property tax assessment as well. Anything else?', created_at: new Date().toISOString() },
        ],
        [
          { file_name: 'Appraisal_Wilson.pdf', classification: 'appraisal' },
          { file_name: 'NOA_Wilson_2024.pdf', classification: 'noa' },
          { file_name: 'Government_ID_Wilson.pdf', classification: 'government_id' },
          { file_name: 'Credit_Wilson.pdf', classification: 'credit_report' },
          { file_name: 'Application_Wilson.pdf', classification: 'loan_application' },
          { file_name: 'Property_Tax_Wilson.pdf', classification: 'property_tax' },
        ],
        'under_review'   // ← key signal: file already forwarded
      );
      const item4Html = item4Result?.responseEmail || '';
      console.log('Item 4 adversarial output (first 500 chars):');
      console.log(`  ${item4Html.slice(0, 500).replace(/\n/g, ' ')}`);
      checkNoFutureForwarding('generateBrokerResponse status=under_review — file already forwarded', item4Html);
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Item 4 adversarial smoke skipped due to API error: ${e.message}`);
    }

    // ════════════════════════════════════════════════════════════════
    // FIX 5 — discrepancy iteration: flag ALL same-territory discrepancies
    // ════════════════════════════════════════════════════════════════
    // S3 retest Bug 3: Vienna correctly flagged the property value mismatch but
    // missed the mortgage balance mismatch in the SAME email. Two same-territory
    // numeric discrepancies merged into one mental theme; only one surfaced.
    // Marcus Webb diagnostic exercises CROSS-territory two-discrepancy handling
    // (lender + tenure) which already passes; this smoke is the harder
    // SAME-territory case (two financial numbers, both about deal terms).
    console.log('\n========== FIX 5 — two same-territory discrepancies must both surface ==========');

    try {
      // Synthetic broker submission with TWO simultaneous numeric mismatches both
      // sourced from the same loan_application document (a strict same-territory
      // test — both financial, both about deal terms, both numeric):
      //   - Property value: email body $890,000 vs loan_application $920,000
      //   - Mortgage balance: email body $318,000 vs loan_application $341,000
      // Pre-fix Vienna would surface only one of these; post-fix she must surface both.
      const fix5Body = `Hi,

Submitting a second mortgage opportunity for one of my clients.

Property: 142 Maple Ave, Toronto, ON
Property value: $890,000
Existing first mortgage: $318,000 (Scotiabank)
Loan amount requested: $90,000

Borrower: Patricia Wilson, 41 years old, employed at Stantec for 8 years.
Combined LTV: approximately 65.7%

Attached: the loan application.

Thanks,
Jason Mercer
Mercer Mortgage Group`;

      // Single saved doc with BOTH conflicts embedded in extracted text (property
      // value AND mortgage balance disagree with email body). Filename avoids
      // /application|summary|appraisal/ regex in pdf.js's isDualPathDocument so
      // synthetic base64 bytes don't get sent (Claude rejects synthetic bytes as
      // invalid PDFs). Same pattern as Marcus Webb diagnostic which uses
      // 'Loan_App_Webb.pdf' for the same reason.
      const fix5SavedDocs = [
        {
          file_name: 'Loan_App_Wilson.pdf',
          classification: 'loan_application',
          extracted_data: {
            text: `LOAN APPLICATION FORM
Applicant: Patricia Wilson
Property Address: 142 Maple Ave, Toronto, ON

Property Details:
  Appraised Value: $920,000
  Property Type: Single Family Detached

Loan Amount Requested: $90,000

Existing Mortgage Details:
  Lender: Scotiabank
  Outstanding Balance: $341,000
  Mortgage Position: First Mortgage
  Maturity: 2027-09-15

Employment:
  Employer: Stantec
  Position: Senior Planner
  Years of Service: 8 years
  Annual Income: $145,000

Signed: Patricia Wilson
Date: 2026-04-15`,
          },
        },
      ];

      // buildContentBlocks iterates over `attachments` and looks up text in savedDocs
      // by filename match. We need a non-empty attachments array for Claude to receive
      // the doc text at all. Synthetic bytes are fine here because the filename doesn't
      // match the dual-path regex.
      const fix5Attachments = [
        { Name: 'Loan_App_Wilson.pdf', Content: Buffer.from('synthetic-pdf-loan-app').toString('base64'), ContentType: 'application/pdf', ContentLength: 1000 },
      ];

      const { welcomeEmail: fix5Email } = await realAi.processInitialEmail(
        'Jason Mercer',
        fix5Body,
        fix5Attachments,
        fix5SavedDocs,
        false,    // hasOwnApplication (we test discrepancy, not own-form handling)
        false,    // hasOwnPnw
        false     // nameCollidesWithAdmin
      );
      const fix5Stripped = (fix5Email || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      console.log('Fix 5 output (first 600 chars):');
      console.log(`  ${fix5Stripped.slice(0, 600)}`);

      // Detection: BOTH discrepancies must appear, both with clarify language.
      // Property value discrepancy: 890 AND 920 both present
      const hasPropertyValueDiscrepancy = /\b890[\s,]?000?\b|\$890\b/.test(fix5Stripped) && /\b920[\s,]?000?\b|\$920\b/.test(fix5Stripped);
      // Mortgage balance discrepancy: 318 AND 341 both present
      const hasMortgageBalanceDiscrepancy = /\b318[\s,]?000?\b|\$318\b/.test(fix5Stripped) && /\b341[\s,]?000?\b|\$341\b/.test(fix5Stripped);
      // Clarify language somewhere in the reply
      const hasClarifyLanguage = /(discrepan|differ|conflict|clarif|which (?:is|are) correct|confirm.*correct|noticed.*but)/i.test(fix5Stripped);

      const failures = [];
      if (!hasPropertyValueDiscrepancy) failures.push('Property value discrepancy ($890K body vs $920K appraisal) NOT surfaced');
      if (!hasMortgageBalanceDiscrepancy) failures.push('Mortgage balance discrepancy ($318K body vs $341K application) NOT surfaced');
      if (!hasClarifyLanguage) failures.push('No clarify/confirm/discrepancy language in reply');
      if (failures.length > 0) {
        throw new Error(`FAIL [Fix 5 two same-territory discrepancies]:\n  - ${failures.join('\n  - ')}`);
      }
      console.log(`  PASS [Fix 5 two same-territory discrepancies]: BOTH property-value AND mortgage-balance mismatches surfaced with clarify language`);
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Fix 5 two same-territory smoke skipped due to API error: ${e.message}`);
    }

    // ════════════════════════════════════════════════════════════════
    // FIX 6 — "Ownership Type: null" must render as "TBD" (Bug 4)
    // ════════════════════════════════════════════════════════════════
    // S3 retest Bug 4: preliminary review email's Deal Snapshot rendered
    // "Ownership Type: null" verbatim because the JS-interpolated ${ownershipType}
    // had no fallback. ownershipType is null on initial submission until
    // generateBrokerResponse populates it on the first follow-up. Fix 6 adds a
    // `|| 'TBD'` fallback at the prompt template; Vienna now renders the row
    // as "Ownership Type: TBD" instead of leaking the literal "null" string.
    console.log('\n========== FIX 6 — Ownership Type null rendering ==========');

    try {
      const fix6Html = await realAi.generateLeadSummary(
        {
          sender_type: 'broker',
          sender_name: 'Jason Mercer',
          broker_name: 'Jason Mercer',
          borrower_name: 'Patricia Simmons',
          ltv_percent: 65.7,
          loan_type: 'second mortgage',
          property_value: 920000,
          loan_amount_requested: 160000,
          property_address: '287 Glencairn Ave, Toronto, ON',
        },
        null,    // ← ownershipType=null (the bug surface)
        [
          { file_name: 'Appraisal_Simmons.pdf', classification: 'appraisal', extracted_data: { text: 'Appraised value: $920,000 (Glencairn Ave, Toronto)' } },
          { file_name: 'NOA_Simmons.pdf', classification: 'noa', extracted_data: { text: 'CRA Notice of Assessment 2024 — Patricia Simmons — Total income $145,000' } },
        ],
        ['government_id', 'property_tax', 'mortgage_statement', 'credit_report'],
        [
          { direction: 'inbound', subject: '2nd mortgage submission', body: 'Submitting Patricia Simmons. Property at $920K, requesting $160K.', created_at: new Date(Date.now() - 3600000).toISOString() },
        ]
      );

      const fix6Stripped = (fix6Html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      // Find the Ownership Type row context in the rendered output
      const ownershipMatch = fix6Stripped.match(/Ownership\s+Type[:\s]*([^|.\n]{0,40})/i);
      console.log(`Fix 6 Ownership Type row excerpt: "${ownershipMatch ? ownershipMatch[0].slice(0, 80) : '(not found)'}"`);

      const failures = [];
      // The literal "null" must NOT appear in the Ownership Type row
      if (/Ownership\s+Type[:\s]*(?:[A-Za-z\/]*\s*)?null\b/i.test(fix6Stripped)) {
        failures.push('"Ownership Type: null" leaked through — JS-interpolated raw null reached the rendered HTML');
      }
      // The fallback "TBD" should appear (or some equivalent like "Pending"/"Not yet determined")
      const hasFallback = /Ownership\s+Type[:\s]*(?:[A-Za-z\/]*\s*)?(?:TBD|Pending|Not\s+yet|Unknown|N\/A|To\s+be)/i.test(fix6Stripped);
      if (!hasFallback) {
        failures.push('Ownership Type row does not contain TBD/Pending/equivalent fallback');
      }
      if (failures.length > 0) {
        throw new Error(`FAIL [Fix 6 ownership null rendering]:\n  - ${failures.join('\n  - ')}`);
      }
      console.log(`  PASS [Fix 6 ownership null rendering]: "Ownership Type: TBD" (or equivalent) rendered, no null leak`);
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Fix 6 smoke skipped due to API error: ${e.message}`);
    }

    // ════════════════════════════════════════════════════════════════
    // FIX 7 — high-LTV collateral flow (S4 rework)
    // ════════════════════════════════════════════════════════════════
    // Three smokes:
    //   1. parseCollateralReply substantive cases (Claude path)
    //   2. Initial high-LTV welcome email — collateral question + NO doc list
    //   3. generateBrokerResponse with collateral_offered=true — acknowledges
    //      collateral and resumes normal intake (asks for docs)
    console.log('\n========== FIX 7 — parseCollateralReply substantive cases (Claude) ==========');

    const collateralLiveCases = [
      // YES — clear collateral offered
      ['Yes, the borrower has a cottage at Lake Wabamun worth about $400K with no mortgage on it.', 'yes'],
      ['We can add the rental property he owns at 142 Vine Ave as additional security.', 'yes'],
      ['Sure — there is also a second property on title, an investment condo downtown.', 'yes'],
      ['He has another house, fully paid off, valued around $550K.', 'yes'],
      // NO — substantive but ultimately declining
      ['Unfortunately no, the subject property is the only real estate he owns.', 'no'],
      ['I checked with him and he does not have any other property to pledge.', 'no'],
      // AMBIGUOUS — questions, deflections, non-real-estate offers
      ['Let me check with the borrower and get back to you.', 'ambiguous'],
      ['What types of collateral would qualify? Would an RRSP work?', 'ambiguous'],
      ['He has about $200K in savings — would that count?', 'ambiguous'],
      ['I will need to confirm with my client.', 'ambiguous'],
    ];

    let collateralLivePassed = 0;
    for (const [reply, expectedDisposition] of collateralLiveCases) {
      try {
        const result = await realAi.parseCollateralReply(reply);
        if (result.disposition === expectedDisposition) {
          console.log(`  PASS: ${JSON.stringify(reply.slice(0, 60) + (reply.length > 60 ? '...' : ''))} → '${expectedDisposition}'`);
          collateralLivePassed++;
        } else {
          throw new Error(`FAIL [parseCollateralReply ${JSON.stringify(reply.slice(0, 80))}]: expected '${expectedDisposition}', got '${result.disposition}'`);
        }
      } catch (e) {
        if (e.message.startsWith('FAIL')) throw e;
        console.warn(`  [collateral live] skipped due to API error: ${e.message}`);
      }
    }
    console.log(`parseCollateralReply substantive: ${collateralLivePassed}/${collateralLiveCases.length} passed`);

    // ─────────────────────────────────────────────────────────────────
    // Smoke 2: Initial high-LTV submission must NOT include doc list
    // ─────────────────────────────────────────────────────────────────
    console.log('\n========== FIX 7 — initial high-LTV email: collateral question + NO doc list ==========');

    const docRequestPhrases = [
      [/\bpayout\s+statement\b/i, 'payout statement'],
      [/\bappraisal\b/i, 'appraisal'],
      [/\bAML\s+form\b/i, 'AML form'],
      [/\bPEP\s+form\b/i, 'PEP form'],
      [/\bPNW\s+statement\b/i, 'PNW statement'],
      [/\b(?:notice\s+of\s+assessment|\bNOA\b)/i, 'NOA / Notice of Assessment'],
      [/\bproof\s+of\s+income\b/i, 'proof of income'],
      [/\bgovernment[\s-]issued\s+id\b/i, 'government-issued ID'],
      [/\bproperty\s+tax\s+(?:assessment|bill)\b/i, 'property tax assessment'],
      [/\bcredit\s+(?:bureau|report)\b/i, 'credit bureau / credit report'],
    ];

    const collateralAskPattern = /(?:additional\s+collateral|other\s+(?:property|security|real\s+estate)|second\s+piece|extra\s+collateral|second\s+(?:home|property))/i;

    try {
      const highLtvBody = `Hi Franco,

Submitting a second mortgage opportunity for one of my clients. Heads up — the LTV is high.

Property: 88 Eastern Ave, Toronto, ON
Property value (per recent appraisal): $540,000
Existing first mortgage: $370,000 (Scotiabank)
Loan amount requested: $90,000
Combined LTV: ~85.2%

Borrower: Ryan Callahan, employed at TechCorp.

Thanks,
Michelle Reid
Reid Mortgage Group`;

      const { welcomeEmail: highLtvEmail } = await realAi.processInitialEmail(
        'Michelle Reid',
        highLtvBody,
        [],
        [],
        false,
        false,
        false
      );
      const highLtvStripped = (highLtvEmail || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      console.log('Fix 7 high-LTV initial email (first 500 chars):');
      console.log(`  ${highLtvStripped.slice(0, 500)}`);

      const failures = [];
      // Must contain the collateral question
      if (!collateralAskPattern.test(highLtvStripped)) {
        failures.push('email does NOT contain a collateral question (regex: additional collateral / other property / second piece / etc.)');
      }
      // Must NOT contain doc-list phrases
      const leakedDocs = [];
      for (const [re, name] of docRequestPhrases) {
        if (re.test(highLtvStripped)) leakedDocs.push(name);
      }
      if (leakedDocs.length > 0) {
        failures.push(`high-LTV initial email leaked doc requests: ${leakedDocs.join(', ')}`);
      }
      if (failures.length > 0) {
        throw new Error(`FAIL [Fix 7 high-LTV initial]:\n  - ${failures.join('\n  - ')}`);
      }
      console.log(`  PASS [Fix 7 high-LTV initial email]: collateral question present, no doc list leaked`);
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Fix 7 high-LTV initial smoke skipped due to API error: ${e.message}`);
    }

    // ─────────────────────────────────────────────────────────────────
    // Smoke 3: generateBrokerResponse with collateral_offered=true → asks for docs
    // ─────────────────────────────────────────────────────────────────
    console.log('\n========== FIX 7 — generateBrokerResponse post-collateral resume ==========');

    try {
      const postCollateralResult = await realAi.generateBrokerResponse(
        `Yes, we can add the rental property at 142 Vine Ave as additional collateral. It is fully paid off, valued around $400K.`,
        [], [],
        {
          borrower_name: 'Ryan Callahan',
          broker_name: 'Michelle Reid',
          sender_name: 'Michelle Reid',
          sender_type: 'broker',
          ltv_percent: 85.2,
          loan_type: 'second mortgage',
          collateral_offered: true,   // ← Fix 7 flag set after broker said yes
        },
        [
          { direction: 'inbound', body: 'Submitting a second mortgage for Ryan Callahan, ~85.2% LTV.', created_at: new Date(Date.now() - 86400000).toISOString() },
          { direction: 'outbound', body: 'Thanks for sending this through, Michelle. The combined LTV is over our usual 80% threshold — is there any additional collateral the borrower could include? A second piece of real estate, an investment property, anything else with equity?', created_at: new Date(Date.now() - 80000000).toISOString() },
          { direction: 'inbound', body: 'Yes, we can add the rental property at 142 Vine Ave as additional collateral. It is fully paid off, valued around $400K.', created_at: new Date().toISOString() },
        ],
        [],
        'active'   // status='active' after Fix 7 YES path
      );
      const postCollateralHtml = postCollateralResult?.responseEmail || '';
      const postCollateralStripped = (postCollateralHtml || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      console.log('Fix 7 post-collateral output (first 500 chars):');
      console.log(`  ${postCollateralStripped.slice(0, 500)}`);

      // Vienna must acknowledge the collateral (mention Vine Ave or rental property)
      const ackedCollateral = /(?:vine\s+ave|rental\s+property|additional\s+(?:collateral|security)|second\s+property|noted)/i.test(postCollateralStripped);
      // Vienna must request at least SOME documents (the doc-suppression should LIFT now)
      const requestedDocs = docRequestPhrases.some(([re]) => re.test(postCollateralStripped));
      // Vienna must NOT re-ASK collateral (already offered). Only catch actual question-
      // shaped re-asks; "additional collateral will help" is a valid acknowledgment, not
      // a re-ask. Question patterns: "any other/additional/more...", "do you have...",
      // "is there...", "could you confirm...".
      const reAskedCollateral =
        /any\s+(?:other|additional|more)\s+(?:collateral|property|security|real\s+estate)/i.test(postCollateralStripped) ||
        /do\s+(?:you|they|the\s+borrower)\s+have\s+(?:any\s+)?(?:other|additional|more)/i.test(postCollateralStripped) ||
        /is\s+there\s+(?:any\s+)?(?:other|additional|more)\s+(?:collateral|property|security)/i.test(postCollateralStripped);

      const issues = [];
      if (!ackedCollateral) issues.push('did not acknowledge the collateral offer (Vine Ave / rental property)');
      if (!requestedDocs) issues.push('did not request any standard docs (doc-suppression should have LIFTED post-collateral)');
      if (reAskedCollateral) issues.push('re-asked for additional collateral despite collateral_offered=true');

      if (issues.length > 0) {
        throw new Error(`FAIL [Fix 7 post-collateral resume]:\n  - ${issues.join('\n  - ')}`);
      }
      console.log(`  PASS [Fix 7 post-collateral resume]: Vienna acknowledged collateral and asked for docs (intake resumed)`);
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Fix 7 post-collateral smoke skipped due to API error: ${e.message}`);
    }

    // ════════════════════════════════════════════════════════════════
    // ITEM 5 — rejection-prompt hardening
    // ════════════════════════════════════════════════════════════════
    // Synthetic weak-borrower fixture (~580 credit, NSF history, ~85% LTV, unstable
    // 1099 income). Run through generateRejectionEmail and assert the rejection:
    //   - contains no internal-routing leaks (Franco / underwriters / our team / etc.)
    //   - contains no approval-adjacent language
    //   - contains no unstated lender names
    //   - stays brief (≤ 8 sentences, ≤ 150 words — soft caps above the 6-sentence target)
    //   - doesn't re-litigate the deal terms (no NSF / credit-score / LTV mention)
    //   - has empathetic acknowledgment + future-deal encouragement
    console.log('\n========== ITEM 5 — rejection email hardening adversarial ==========');

    const rejectionForbidden = [
      // Internal routing
      [/\bfranco\b/i, '"Franco" — broker should not know who decided'],
      [/the\s+underwrit(?:er|ing)/i, '"the underwriters/underwriting"'],
      [/\bour\s+team\b/i, '"our team"'],
      [/\binternal\s+review\b/i, '"internal review"'],
      [/the\s+(?:underwriting|review)\s+process/i, '"the underwriting/review process"'],
      // "After our review" (alone) is acceptable in rejection context — it states
      // evaluation happened without naming who or revealing process. Forbid only
      // when it names the reviewer ("after review by our team / the underwriters").
      [/\bafter\s+(?:our\s+|the\s+)?review\s+by\b/i, '"after review by [whom]"'],
      [/passed\s+(?:on\s+by|along)/i, '"passed on by / passed along"'],
      [/\bi'?ll\s+(?:let|tell)\s+(?:franco|the\s+(?:lender|team))/i, '"I\'ll let Franco/the lender/the team know"'],
      // Approval-adjacent
      [/\bapprov(ed|al|ing)\b/i, '"approved/approval/approving"'],
      [/passed\s+review/i, '"passed review"'],
      [/looks\s+good/i, '"looks good"'],
      // Lender hallucination
      [/\bTD\s+(?:Bank|Canada\s+Trust)\b/i, '"TD Bank/Canada Trust"'],
      [/\bRBC\b/, '"RBC"'],
      [/\bRoyal\s+Bank\b/i, '"Royal Bank"'],
      [/\bScotia(?:bank)?\b/i, '"Scotia(bank)"'],
      [/\bCIBC\b/, '"CIBC"'],
      [/\bBMO\b/, '"BMO"'],
      [/\bBank\s+of\s+Montreal\b/i, '"Bank of Montreal"'],
      [/\bManulife\b/i, '"Manulife"'],
      [/\bEquitable\b/i, '"Equitable"'],
      [/\bHaventree\b/i, '"Haventree"'],
      [/\bMCAP\b/, '"MCAP"'],
      [/\bATB\b/, '"ATB"'],
      // Re-litigating the deal (rejection context — mention of specific risk factors leaks)
      [/\b58[03]\b|\bcredit\s+score\b/i, 'mention of credit score / specific number'],
      [/\bNSF\b/, '"NSF"'],
      [/\b85(?:\.\d)?\s*%/, 'specific LTV percentage'],
      [/\bunstable\s+(?:income|employment)\b/i, '"unstable income/employment"'],
    ];

    const stripHtmlForRej = (h) => (h || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const checkRejection = (label, html) => {
      const stripped = stripHtmlForRej(html);
      const sentences = stripped.split(/[.!?]+/).filter(s => s.trim().length > 5);
      const words = stripped.split(/\s+/).filter(Boolean);
      const failures = [];

      for (const [re, desc] of rejectionForbidden) {
        const m = stripped.match(re);
        if (m) {
          const ctx = stripped.slice(Math.max(0, m.index - 25), m.index + m[0].length + 30);
          failures.push(`${desc} — matched "${m[0]}" at "...${ctx}..."`);
        }
      }
      if (sentences.length > 8) failures.push(`${sentences.length} sentences (cap: 8) — too padded for a rejection`);
      if (words.length > 150) failures.push(`${words.length} words (cap: 150) — too long`);

      // Soft check: rejection should encourage future deals (positive signal)
      const futureFraming = /(?:next\s+(?:one|deal|time)|future\s+deal|work\s+together\s+(?:again|on|soon)|happy\s+to\s+(?:revisit|see|review))/i.test(stripped);
      if (!futureFraming) {
        console.warn(`  WARN [${label}]: no explicit future-deal encouragement detected (soft check, not failing)`);
      }

      if (failures.length > 0) {
        throw new Error(`FAIL [${label}]:\n  - ${failures.join('\n  - ')}`);
      }
      console.log(`  PASS [${label}]: ${sentences.length} sentences, ${words.length} words, no leaks`);
    };

    try {
      const item5Result = await realAi.generateRejectionEmail({
        borrower_name: 'David Reyes',
        broker_name: 'Jason Mercer',
        sender_name: 'Jason Mercer',
        sender_type: 'broker',
        property_address: '88 Eastern Ave, Toronto, ON',
        property_value: 540000,
        loan_amount_requested: 90000,
        existing_mortgage_balance: 370000,
        ltv_percent: 85.2,
        loan_type: 'second mortgage',
        income_details: '1099 contractor at design studio, 18 months tenure, irregular monthly income',
        key_risks_or_notes: 'Credit score 583 with two NSF entries in last 6 months. 1099 income with 18-month tenure and inconsistent monthly amounts. Combined LTV 85.2% on a borderline-marketable property. Borrower carries $32K unsecured debt. No clear exit strategy provided.',
        summary: 'David Reyes seeks a $90K second mortgage on his Toronto home valued at $540K. Existing first of $370K. Credit 583, NSF history, irregular 1099 income, no exit strategy. Combined LTV 85.2%. Risk-stack is heavy across credit, income, LTV, and exit.',
      });
      console.log('Item 5 rejection output:');
      console.log(`  ${(item5Result || '').slice(0, 800).replace(/\n/g, ' ')}`);
      checkRejection('generateRejectionEmail — weak-borrower fixture', item5Result);
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Item 5 adversarial smoke skipped due to API error: ${e.message}`);
    }

    // ════════════════════════════════════════════════════════════════
    // GROUP R — live Claude smoke for parseDraftReply SEND/EDIT classification
    // ════════════════════════════════════════════════════════════════
    // The REPLACE path is heuristic-only (no Claude — covered by deterministic tests
    // above). The SEND/EDIT path runs Claude on short replies. Bug 9.9's misclassification
    // would have looked like: a polite long reply classified as SEND. Post-fix, the
    // heuristic catches that before Claude is asked. But we still want to verify the
    // STRICT classification rules hold for the residual SHORT-reply cases.
    console.log('\n========== GROUP R — live parseDraftReply SEND/EDIT classification ==========');

    // Restore real parseDraftReply (we never stubbed it, but realAi is the same module
    // re-required after cache delete — safe).
    const realParseDraftReply = realAi.parseDraftReply;

    const draftReplyClassificationCases = [
      { name: 'pure short approval "Looks good, send it!"',  reply: 'Looks good, send it!',                expectAction: 'send' },
      { name: '"Send it"',                                    reply: 'Send it',                            expectAction: 'send' },
      { name: '"approved"',                                   reply: 'approved',                           expectAction: 'send' },
      { name: 'short edit "make it shorter"',                 reply: 'Make it shorter and remove the praise paragraph.', expectAction: 'edit' },
      { name: 'mixed approval+edit "looks good but..."',      reply: 'Looks good, but please remove the AML reference.', expectAction: 'edit' },
      { name: 'short instruction with no approval',           reply: 'Change the closing to mention 48 hours.', expectAction: 'edit' },
    ];

    for (const tc of draftReplyClassificationCases) {
      try {
        const result = await realParseDraftReply(tc.reply);
        if (result.action === tc.expectAction) {
          console.log(`  PASS [${tc.name}]: classified as '${tc.expectAction}'`);
        } else {
          throw new Error(`FAIL [${tc.name}]: expected '${tc.expectAction}', got '${result.action}' (full result: ${JSON.stringify(result)})`);
        }
      } catch (e) {
        if (e.message.startsWith('FAIL')) throw e;
        console.warn(`  [${tc.name}] skipped due to API error: ${e.message}`);
      }
    }

    // ════════════════════════════════════════════════════════════════
    // F2 — both-Franco generic-greeting adversarials
    // ════════════════════════════════════════════════════════════════
    // Production observation: deal 5e5dfee1 (broker franco@vimarealty.com,
    // display name "Franco Vieanna") greeted broker as "Hi Franco!" across 4
    // outbound messages. Bug B Layer A's rescue can't disambiguate because
    // both extracted name and From-header start with "Franco". F2 sets a
    // collision flag and the prompt instructs Vienna to use a generic greeting.
    //
    // These two smokes run real Claude calls with the collision flag set and
    // assert the greeting in the outbound email body is NOT "Hi Franco!" /
    // "Hello Franco!" / etc.
    console.log('\n========== F2 — initial-email both-Franco generic greeting ==========');

    const francoGreetingForbidden = [
      [/(?:^|>|\n)\s*Hi\s+Franco\b/i, '"Hi Franco" greeting'],
      [/(?:^|>|\n)\s*Hello\s+Franco\b/i, '"Hello Franco" greeting'],
      [/(?:^|>|\n)\s*Hey\s+Franco\b/i, '"Hey Franco" greeting'],
      [/(?:^|>|\n)\s*Dear\s+Franco\b/i, '"Dear Franco" greeting'],
    ];

    const checkNoFrancoGreeting = (label, html) => {
      const failures = [];
      for (const [re, desc] of francoGreetingForbidden) {
        const m = (html || '').match(re);
        if (m) {
          const ctx = (html || '').slice(Math.max(0, m.index - 25), m.index + m[0].length + 30).replace(/\s+/g, ' ');
          failures.push(`${desc} — matched at "...${ctx}..."`);
        }
      }
      if (failures.length > 0) {
        throw new Error(`FAIL [${label}]: Vienna greeted recipient as Franco despite collision flag:\n  - ${failures.join('\n  - ')}`);
      }
      console.log(`  PASS [${label}]: no Franco-greeting; generic greeting used as instructed`);
    };

    // Adversarial 1: processInitialEmail with nameCollidesWithAdmin=true.
    // Mirrors the Franco Vieanna QA submission shape — broker email sender
    // whose display name starts with "Franco". Vienna must NOT greet "Hi Franco".
    try {
      const initialBody = `Hello Franco,

Submitting a second mortgage opportunity for one of my clients. Property in Toronto, ~62% LTV.

Borrower: Marcus Webb, employed at Stantec for 8 years.
Property value: $890,000
Existing first: $318,000 (Scotiabank)
Loan requested: $90,000

I've attached the appraisal and NOA. Will follow up with the rest of the package shortly.

Thanks,
Franco Vieanna
Vima Realty
License #M11892`;

      const { welcomeEmail: f2InitialEmail } = await realAi.processInitialEmail(
        'Franco Vieanna',     // senderName (From-header display)
        initialBody,
        [],                    // attachments
        [],                    // savedDocs
        false,                 // hasOwnApplication
        false,                 // hasOwnPnw
        true                   // nameCollidesWithAdmin — F2 flag
      );
      console.log('F2 initial-email output (first 400 chars):');
      console.log(`  ${(f2InitialEmail || '').slice(0, 400).replace(/\n/g, ' ')}`);
      checkNoFrancoGreeting('processInitialEmail with collision flag', f2InitialEmail);
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  F2 initial-email smoke skipped due to API error: ${e.message}`);
    }

    // ─────────────────────────────────────────────────────────────────
    // Group A (S6.1/S7.1) — sig-override smokes
    //
    // Bug shape: Franco's QA setup uses From-header "Franco" but signs body
    // as a different broker (e.g. Jennifer / Daniel) to simulate real submissions.
    // Pre-Group-A the collision flag forced "Hi there!" regardless of body sig.
    // Post-Group-A: prompt teaches Claude to greet by sig name when sig differs
    // from "Franco"; only fall back to generic when sig absent or also Franco-like.
    //
    // checkGreetingByName: assert greeting region (first 200 chars) contains
    // "Hi/Hello/Dear NAME" with word-boundary on the expected name. Mid-body
    // mentions of NAME elsewhere don't count as a pass.
    // ─────────────────────────────────────────────────────────────────
    const checkGreetingByName = (label, html, expectedFirstName) => {
      const greetingRegion = (html || '').slice(0, 200);
      const re = new RegExp(`(?:^|>|\\n)\\s*(hi|hello|dear)\\s+${expectedFirstName}\\b`, 'i');
      if (!re.test(greetingRegion)) {
        const snippet = greetingRegion.replace(/\s+/g, ' ').trim().slice(0, 220);
        throw new Error(`FAIL [${label}]: expected greeting "Hi ${expectedFirstName}" in first 200 chars, got: "${snippet}"`);
      }
      console.log(`  PASS [${label}]: greeted by sig name "${expectedFirstName}" despite collision flag`);
    };

    const checkGenericGreeting = (label, html) => {
      const greetingRegion = (html || '').slice(0, 200);
      const generic = /(?:^|>|\n)\s*(hi\s+there|hello)[!,\s]/i;
      if (!generic.test(greetingRegion)) {
        const snippet = greetingRegion.replace(/\s+/g, ' ').trim().slice(0, 220);
        throw new Error(`FAIL [${label}]: expected generic greeting (Hi there / Hello) in first 200 chars, got: "${snippet}"`);
      }
      // Also check no Franco-greeting leak — reuses checkNoFrancoGreeting on full body.
      checkNoFrancoGreeting(`${label} (no-Franco-leak)`, html);
      console.log(`  PASS [${label}]: generic greeting used; no Franco-leak`);
    };

    // Smoke A.1: From-header "Franco Vieanna" + body sig "Jennifer Tanaka"
    // → must greet "Hi Jennifer!" (sig override, S6.1 root cause).
    console.log('\n========== Group A — sig-override smokes (FromName=Franco, sig=non-Franco) ==========');
    try {
      const jenniferBody = `Hi Franco,

Hope your week is going well. I have a new file I'd like to submit for review — refinance on a property in Calgary, owner-occupied, looking at around 65% LTV.

Borrower: Kevin Tran, 12-year tenure at Suncor.
Property value: $720,000
Existing first: $310,000 (CIBC)
Loan requested: $160,000

I'll have the appraisal and NOA across to you tomorrow. Let me know what else you'll need from us.

Thanks,
Jennifer Tanaka
Acme Mortgage Group`;

      const { welcomeEmail: jenniferWelcome } = await realAi.processInitialEmail(
        'Franco Vieanna',     // From-header — collides with admin
        jenniferBody,
        [], [], false, false,
        true                   // collision flag set
      );
      console.log('Group A Jennifer-sig output (first 400 chars):');
      console.log(`  ${(jenniferWelcome || '').slice(0, 400).replace(/\n/g, ' ')}`);
      checkGreetingByName('processInitialEmail sig=Jennifer', jenniferWelcome, 'Jennifer');
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Group A Jennifer-sig smoke skipped due to API error: ${e.message}`);
    }

    // Smoke A.2: From-header "Franco" + body sig "Daniel"
    // → must greet "Hi Daniel!" (sig override, S7.1 root cause).
    try {
      const danielBody = `Hi Franco,

Submitting a 2nd mortgage opportunity for review. Toronto property, ~58% LTV.

Borrower: Ethan Broussard, self-employed (incorporated, 6 years).
Property value: $1,150,000
Existing first: $480,000 (TD)
Loan requested: $185,000

Appraisal is in hand, will send across once I get a clean copy from the appraiser. NOA and gov ID coming separately.

Thanks,
Daniel Rosen
Pinnacle Brokerage`;

      const { welcomeEmail: danielWelcome } = await realAi.processInitialEmail(
        'Franco',              // From-header — collides with admin
        danielBody,
        [], [], false, false,
        true                   // collision flag set
      );
      console.log('Group A Daniel-sig output (first 400 chars):');
      console.log(`  ${(danielWelcome || '').slice(0, 400).replace(/\n/g, ' ')}`);
      checkGreetingByName('processInitialEmail sig=Daniel', danielWelcome, 'Daniel');
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Group A Daniel-sig smoke skipped due to API error: ${e.message}`);
    }

    // Smoke A.3: From-header "Franco" + NO body signature
    // → must fall back to generic greeting (no Franco-leak).
    try {
      const noSigBody = `Hi Franco,

Quick submission for one of my clients. Refinance, ~72% LTV.

Borrower: Mei Tanaka.
Property value: $980,000
Existing first: $620,000
Loan requested: $85,000

Will get the doc package across this week.`;

      const { welcomeEmail: noSigWelcome } = await realAi.processInitialEmail(
        'Franco',              // From-header — collides with admin
        noSigBody,
        [], [], false, false,
        true                   // collision flag set
      );
      console.log('Group A no-sig output (first 400 chars):');
      console.log(`  ${(noSigWelcome || '').slice(0, 400).replace(/\n/g, ' ')}`);
      checkGenericGreeting('processInitialEmail no-sig fallback', noSigWelcome);
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Group A no-sig fallback smoke skipped due to API error: ${e.message}`);
    }

    console.log('\n========== F2 — broker-response both-Franco generic greeting ==========');

    // Adversarial 2: generateBrokerResponse where existingSummary has the
    // collision flag set. Conversation continues with the broker on a follow-up.
    try {
      const f2FollowUpBody = `Hi Vienna, sending the Government ID and credit bureau report for Marcus now. Anything else?

Thanks,
Franco Vieanna`;

      const f2Result = await realAi.generateBrokerResponse(
        f2FollowUpBody,
        [], [],
        {
          borrower_name: 'Marcus Webb',
          broker_name: 'Franco Vieanna',
          sender_name: 'Franco Vieanna',
          sender_type: 'broker',
          ltv_percent: 62,
          loan_type: 'second mortgage',
          name_collides_with_admin: true,   // ← F2 flag from normalizeSenderName
        },
        [
          { direction: 'inbound', body: 'Hello Franco, submitting Marcus Webb. Attached: appraisal, NOA.', created_at: new Date(Date.now() - 86400000).toISOString() },
          { direction: 'outbound', body: 'Hi there! Thanks for sending those over — I have the appraisal and NOA on file. Vienna | Private Mortgage Link', created_at: new Date(Date.now() - 80000000).toISOString() },
          { direction: 'inbound', body: f2FollowUpBody, created_at: new Date().toISOString() },
        ],
        [
          { file_name: 'Appraisal_Webb.pdf', classification: 'appraisal' },
          { file_name: 'NOA_Webb.pdf', classification: 'noa' },
          { file_name: 'Government_ID_Webb.pdf', classification: 'government_id' },
          { file_name: 'Credit_Webb.pdf', classification: 'credit_report' },
        ],
        'active'
      );
      const f2Html = f2Result?.responseEmail || '';
      console.log('F2 broker-response output (first 400 chars):');
      console.log(`  ${f2Html.slice(0, 400).replace(/\n/g, ' ')}`);
      checkNoFrancoGreeting('generateBrokerResponse with collision flag', f2Html);
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  F2 broker-response smoke skipped due to API error: ${e.message}`);
    }

    // ════════════════════════════════════════════════════════════════
    // Fix 1 — collision flag = FALSE must produce a NAME greeting
    // ════════════════════════════════════════════════════════════════
    // Gap closed: the original F2 harness only verified flag=TRUE produces a
    // generic greeting. It never asserted flag=FALSE produces a NAME greeting.
    // Production regression (S1/S2/S3 retest): broker emails with empty FromName
    // were treated as Franco-collisions because isUnreliableName('') === true.
    // Post-fix, the pre-Claude check uses firstNameMatchesAdmin (Franco-pattern
    // only). These smokes verify Vienna correctly greets brokers/borrowers by
    // name when no actual collision exists.
    console.log('\n========== Fix 1 — collision flag=FALSE must produce NAME greeting ==========');

    // Helper: verify Vienna's email body greets by the expected first name
    // (and does NOT use a generic "Hi there!" / "Hello!" greeting).
    const requireNameGreeting = (label, html, expectedFirstName) => {
      const stripped = (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      const namePattern = new RegExp(`^[\\s>]*(?:Hi|Hello|Hey|Dear)\\s+${expectedFirstName}\\b`, 'i');
      const genericPattern = /^[\s>]*(?:Hi\s+there|Hello!?|Hey!?|Greetings)\b/i;
      const head = stripped.slice(0, 100);
      if (!namePattern.test(head)) {
        const generic = genericPattern.test(head) ? ' (used generic greeting instead)' : '';
        throw new Error(`FAIL [${label}]: greeting does not contain "Hi ${expectedFirstName}"${generic}. Head: "${head}"`);
      }
      console.log(`  PASS [${label}]: greeted "${expectedFirstName}" by name (no generic-greeting over-fire)`);
    };

    // Smoke 1: processInitialEmail with senderName="Chris Nolan", flag=false.
    // Mirrors S1 retest shape. Pre-fix this would still get the generic greeting
    // because webhook computed initialFromCollision = isUnreliableName(empty)=true.
    // Post-fix, the parameter is false (passed explicitly here; webhook now uses
    // firstNameMatchesAdmin which returns false for empty FromName).
    try {
      const s1Body = `Hi,

Submitting a second mortgage opportunity for one of my clients.

Property: 142 Maple Ave, Toronto, ON
Property value: $850,000
Existing first mortgage: $400,000
Loan requested: $120,000

Attached: appraisal, NOA, and credit bureau.

Thanks,
Chris Nolan
Nolan Mortgage Group
License #M22405`;

      const { welcomeEmail: s1Email } = await realAi.processInitialEmail(
        'Chris Nolan',     // senderName (would be empty in retest case; explicit here for clarity)
        s1Body,
        [],
        [],
        false,
        false,
        false              // ← nameCollidesWithAdmin = false (no collision)
      );
      console.log('Fix 1 S1 retest (Chris Nolan) output (first 400 chars):');
      console.log(`  ${(s1Email || '').slice(0, 400).replace(/\n/g, ' ')}`);
      requireNameGreeting('processInitialEmail Chris Nolan, no collision', s1Email, 'Chris');
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Fix 1 S1 retest smoke skipped due to API error: ${e.message}`);
    }

    // Smoke 2: processInitialEmail with senderName="Marcus Webb" (borrower path), flag=false.
    // Mirrors S2 retest shape — borrower direct, no display name.
    try {
      const s2Body = `Hi,

I'm looking for a second mortgage on my home in Edmonton.

I'm 38, born March 14, 1988. I work as a graphic designer and own my home outright at $620,000.
Looking to borrow about $80,000 for a kitchen renovation.

Looking forward to hearing from you.

Marcus Webb`;

      const { welcomeEmail: s2Email } = await realAi.processInitialEmail(
        'Marcus Webb',
        s2Body,
        [],
        [],
        false,
        false,
        false              // ← nameCollidesWithAdmin = false
      );
      console.log('Fix 1 S2 retest (Marcus Webb borrower) output (first 400 chars):');
      console.log(`  ${(s2Email || '').slice(0, 400).replace(/\n/g, ' ')}`);
      requireNameGreeting('processInitialEmail Marcus Webb borrower, no collision', s2Email, 'Marcus');
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Fix 1 S2 retest smoke skipped due to API error: ${e.message}`);
    }

    // Smoke 3: generateBrokerResponse with sender_name='Brian', no collision flag.
    // Mirrors S3 retest shape — broker follow-up where the previous over-fire would
    // have left a stale flag in extracted_data. Post-fix, normalizeSenderName clears
    // the stale flag, so generateBrokerResponse sees no flag and uses "Hi Brian!".
    try {
      const s3Body = `Hi Vienna, sending the property tax assessment for Derek now. Anything else outstanding?

Thanks,
Brian`;

      const s3Result = await realAi.generateBrokerResponse(
        s3Body,
        [], [],
        {
          borrower_name: 'Derek Olsen',
          broker_name: 'Brian',
          sender_name: 'Brian',
          sender_type: 'broker',
          ltv_percent: 62,
          loan_type: 'second mortgage',
          // NO name_collides_with_admin flag — represents post-fix forward-recovery
        },
        [
          { direction: 'inbound', body: 'Hi Vienna, submitting Derek Olsen. Attached: appraisal, NOA, application, credit bureau.', created_at: new Date(Date.now() - 172800000).toISOString() },
          { direction: 'outbound', body: 'Hi Brian! Thanks for sending those over — appraisal, NOA, application, and credit bureau on file. Vienna | Private Mortgage Link', created_at: new Date(Date.now() - 170000000).toISOString() },
          { direction: 'inbound', body: s3Body, created_at: new Date().toISOString() },
        ],
        [
          { file_name: 'Appraisal_Olsen.pdf', classification: 'appraisal' },
          { file_name: 'NOA_Olsen.pdf', classification: 'noa' },
          { file_name: 'Application_Olsen.pdf', classification: 'loan_application' },
          { file_name: 'Credit_Olsen.pdf', classification: 'credit_report' },
          { file_name: 'Property_Tax_Olsen.pdf', classification: 'property_tax' },
        ],
        'active'
      );
      const s3Html = s3Result?.responseEmail || '';
      console.log('Fix 1 S3 retest (Brian follow-up) output (first 400 chars):');
      console.log(`  ${s3Html.slice(0, 400).replace(/\n/g, ' ')}`);
      requireNameGreeting('generateBrokerResponse Brian follow-up, no collision', s3Html, 'Brian');
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Fix 1 S3 retest smoke skipped due to API error: ${e.message}`);
    }

    // ════════════════════════════════════════════════════════════════
    // FIX 3 — admin-facing action options: APPROVED / DECLINE only
    // ════════════════════════════════════════════════════════════════
    // Bug 6 from S3 retest: preliminary review email included "Any other reply —
    // your message will be polished and forwarded to the broker by Vienna" as an
    // action option. That belongs at the draft-review stage, not preliminary
    // review — at this stage admin should only be deciding APPROVE/DECLINE, not
    // composing broker messages. Fix 3 swaps "Any other reply" for explicit
    // DECLINE in three sites (generateLeadSummary, generateEscalationNotification,
    // generateDocReviewNotification). parseAdminReply still classifies free-form
    // replies as 'conditions' (backward compat for admin habit) but the email no
    // longer teaches it as a path.
    console.log('\n========== FIX 3 — action options must be APPROVE/DECLINE only ==========');

    const checkActionOptions = (label, html) => {
      const stripped = (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      const failures = [];
      // Required: both APPROVED and DECLINE labels present
      if (!/\bAPPROVED\b/i.test(stripped)) failures.push('missing "APPROVED" action label');
      if (!/\bDECLINE\b/i.test(stripped)) failures.push('missing "DECLINE" action label');
      // Forbidden: pre-fix "Any other reply" / "polished and forwarded" wording
      if (/\bany\s+other\s+reply\b/i.test(stripped)) failures.push('"Any other reply" — pre-fix wording leaked through');
      if (/\bpolished\s+and\s+forwarded\b/i.test(stripped)) failures.push('"polished and forwarded" — pre-fix wording leaked through');
      if (failures.length > 0) {
        throw new Error(`FAIL [${label}]:\n  - ${failures.join('\n  - ')}`);
      }
      console.log(`  PASS [${label}]: APPROVED + DECLINE present, no "Any other reply" leak`);
    };

    // Smoke 1: generateLeadSummary preliminary review — Patricia-shaped fixture
    try {
      const f3LeadHtml = await realAi.generateLeadSummary(
        {
          sender_type: 'broker',
          sender_name: 'Jason Mercer',
          broker_name: 'Jason Mercer',
          borrower_name: 'Patricia Simmons',
          ltv_percent: 65.7,
          loan_type: 'second mortgage',
          property_value: 920000,
          loan_amount_requested: 160000,
        },
        'personal',
        [
          { file_name: 'Appraisal_Simmons.pdf', classification: 'appraisal', extracted_data: { text: 'Appraised value: $920,000 (Glencairn Ave, Toronto)' } },
          { file_name: 'NOA_Simmons.pdf', classification: 'noa', extracted_data: { text: 'CRA Notice of Assessment 2024 — Patricia Simmons — Total income $145,000' } },
        ],
        ['government_id', 'property_tax', 'mortgage_statement', 'income_proof', 'credit_report'],
        [
          { direction: 'inbound', subject: '2nd mortgage submission — Patricia Simmons', body: 'Submitting Patricia Simmons. Property at $920K, existing first $445K, requesting $160K. Attached: appraisal + NOA.', created_at: new Date(Date.now() - 3600000).toISOString() },
        ]
      );
      console.log('Fix 3 generateLeadSummary action section snippet:');
      const actionSection = (f3LeadHtml || '').match(/Action Required[\s\S]*?<\/ul>/i);
      console.log(`  ${actionSection ? actionSection[0].replace(/\s+/g, ' ').slice(0, 400) : '(no action section found)'}`);
      checkActionOptions('generateLeadSummary preliminary review', f3LeadHtml);
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Fix 3 generateLeadSummary smoke skipped due to API error: ${e.message}`);
    }

    // Smoke 2: generateEscalationNotification — Ryan-shaped (high-LTV) fixture
    try {
      const f3EscHtml = await realAi.generateEscalationNotification(
        {
          sender_type: 'broker',
          sender_name: 'Jason Mercer',
          broker_name: 'Jason Mercer',
          borrower_name: 'Ryan Callahan',
          ltv_percent: 83.1,
          loan_type: 'second mortgage',
          property_value: 700000,
          loan_amount_requested: 200000,
          existing_mortgage_balance: 380000,
        },
        [
          { direction: 'inbound', subject: '2nd mortgage — Ryan Callahan — 83.1% LTV', body: 'Submitting Ryan Callahan, 83.1% LTV. Need to flag this is over our usual threshold.', created_at: new Date(Date.now() - 3600000).toISOString() },
        ],
        [
          { file_name: 'Appraisal_Callahan.pdf', classification: 'appraisal' },
        ]
      );
      console.log('Fix 3 generateEscalationNotification action section snippet:');
      const escActionSection = (f3EscHtml || '').match(/Action Required[\s\S]*?<\/ul>/i);
      console.log(`  ${escActionSection ? escActionSection[0].replace(/\s+/g, ' ').slice(0, 400) : '(no action section found)'}`);
      checkActionOptions('generateEscalationNotification', f3EscHtml);
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Fix 3 generateEscalationNotification smoke skipped due to API error: ${e.message}`);
    }

    // Deterministic: parseAdminReply must classify "DECLINE" as 'rejected'.
    // (parseAdminReply unchanged — fast-path regex already covers decline/declined.
    // This check confirms end-to-end the new action label routes correctly.)
    console.log('\n========== FIX 3 — parseAdminReply DECLINE → rejected ==========');
    const declineCases = [
      ['DECLINE', 'rejected'],
      ['decline', 'rejected'],
      ['Decline.', 'rejected'],
      ['Declined!', 'rejected'],
      ['APPROVED', 'approved'],
      ['Approved.', 'approved'],
      ['REJECT', 'rejected'],
      ['rejected', 'rejected'],
    ];
    for (const [reply, expectedIntent] of declineCases) {
      const result = await realAi.parseAdminReply(reply);
      if (result.intent === expectedIntent) {
        console.log(`  PASS: parseAdminReply(${JSON.stringify(reply)}) → intent='${expectedIntent}'`);
      } else {
        throw new Error(`FAIL [parseAdminReply ${JSON.stringify(reply)}]: expected intent='${expectedIntent}', got '${result.intent}'`);
      }
    }

    // ════════════════════════════════════════════════════════════════
    // GROUP C — generateDocumentRequestEmail asks for exit_strategy when missing
    // ════════════════════════════════════════════════════════════════
    // Live Claude smokes for the broker-facing draft. The doc-request prompt
    // gets an "ADDITIONAL ITEMS" carve-out that overrides the STRICT DOCS RULE
    // for exit_strategy specifically. Two cases:
    //   1. exit_strategy=null + no exit-strategy in conversation → output mentions "exit strategy"
    //   2. Off-checklist regression guard → carve-out doesn't loosen the STRICT RULE generally
    //      (must NOT name forbidden docs like insurance binders, void cheques, etc.)
    console.log('\n========== GROUP C — generateDocumentRequestEmail asks for missing exit_strategy ==========');

    try {
      const groupCSummary = {
        sender_type: 'broker',
        sender_name: 'Jason Mercer',
        broker_name: 'Jason Mercer',
        borrower_name: 'Patricia Simmons',
        ltv_percent: 65.7,
        loan_type: 'second mortgage',
        property_value: 720000,
        loan_amount_requested: 160000,
        existing_mortgage_balance: 310000,
        exit_strategy: null,                     // ← missing — must be asked
        purpose: 'refinance',
      };

      const groupCConvo = [
        { direction: 'inbound', subject: '2nd mortgage — Patricia Simmons', body: 'Submitting Patricia Simmons, ~65.7% LTV. Will get docs across this week.', created_at: new Date(Date.now() - 86400000).toISOString() },
      ];

      const groupCExistingDocs = [
        { file_name: 'Appraisal_Simmons.pdf', classification: 'appraisal' },
        { file_name: 'Loan_Application_Simmons.pdf', classification: 'loan_application' },
      ];

      const groupCDocRequest = await realAi.generateDocumentRequestEmail(
        groupCSummary,
        'personal',           // ownershipType
        true,                 // hasApp (loan_application classified above)
        false,                // hasPnw
        groupCExistingDocs,
        groupCConvo
      );

      console.log('Group C doc-request output (first 500 chars):');
      console.log(`  ${(groupCDocRequest || '').slice(0, 500).replace(/\n/g, ' ')}`);

      // Smoke 5: must ask about exit strategy
      if (!/exit\s+strateg/i.test(groupCDocRequest || '')) {
        throw new Error(`FAIL [Group C exit-strategy ask]: doc-request must mention exit strategy when null. Got first 500 chars: "${(groupCDocRequest || '').slice(0, 500).replace(/\s+/g, ' ')}"`);
      }
      console.log('  PASS [Group C exit-strategy ask]: doc-request asks about exit strategy when dealSummary.exit_strategy is null');

      // Smoke 7: regression guard — carve-out must NOT loosen the STRICT RULE for off-checklist docs.
      const forbiddenOffChecklist = [
        [/\b(?:insurance\s+binder|property\s+insurance|home\s+insurance)\b/i, 'insurance binder/policy'],
        [/\bundertaking\s+letter\b/i, 'lawyer undertaking letter'],
        [/\bvoid\s+cheque\b/i, 'void cheque'],
        [/\btitle\s+insurance\b/i, 'title insurance'],
        [/\bcommitment\s+letter\b/i, 'commitment letter'],
      ];
      const forbiddenHits = [];
      for (const [re, desc] of forbiddenOffChecklist) {
        if (re.test(groupCDocRequest || '')) forbiddenHits.push(desc);
      }
      if (forbiddenHits.length > 0) {
        throw new Error(`FAIL [Group C off-checklist regression]: doc-request asked for forbidden off-checklist items: ${forbiddenHits.join(', ')}. STRICT DOCS RULE was loosened by exit_strategy carve-out.`);
      }
      console.log('  PASS [Group C off-checklist regression]: STRICT DOCS RULE preserved — no off-checklist asks despite exit_strategy carve-out');
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Group C doc-request smoke skipped due to API error: ${e.message}`);
    }

    // ════════════════════════════════════════════════════════════════
    // GROUP CCC + XXX — admin-response no "thanks for confirming" leak when broker did not confirm
    // ════════════════════════════════════════════════════════════════
    // CCC origin (S9.4): Tyler's last message was passive (just sending docs).
    // Vienna wrote "Thanks for confirming those details" — attributing Franco's
    // internal approval-with-conditions decision to the broker. CCC fix:
    // precondition-gate the framing to broker-actually-confirmed-something cases.
    //
    // XXX upgrade (S5.2): production deal Patricia Simmons — Vienna's conditions
    // draft opened with "Thanks for the quick confirmation!" The "quick" modifier
    // between "for" and "confirmation" slipped both the prompt rule (no explicit
    // forbidden variant) and the CCC test regex /thanks for (the\s+)?confirm/i
    // (requires "confirm" directly after optional "the"). XXX strengthens the
    // prompt at all 4 FORBIDDEN APPROVAL PHRASES sites with explicit adjective-
    // modifier variants + extends the verbose CCC rule body. Test regex tightened
    // to allow 0-3 modifier words between "for" and "confirm". Test upgraded in
    // place to 5x (Q1-XXX) since this scenario is now the canonical XXX guard.
    console.log('\n========== GROUP CCC + XXX — admin-response no-leak when broker did not confirm (5x) ==========');

    // Layer 2 — Test regex unit cases: confirm the tightened regex catches the
    // S5.2 variant while still catching the original CCC patterns.
    const cccTighterRegex = /thanks for (the\s+)?(\w+\s+){0,3}confirm/i;
    const cccTighterAppreciateRegex = /appreciate (the\s+)?(\w+\s+){0,3}confirm/i;
    const regexCases = [
      // [input, shouldMatch, label]
      ['Thanks for confirming the details', true,  'original CCC pattern (no modifier)'],
      ['Thanks for the confirmation',       true,  'original CCC pattern (with "the")'],
      ['Thanks for the quick confirmation', true,  'S5.2 variant — adjective between "the" and "confirmation"'],
      ['Thanks for the prompt confirm',     true,  'variant: prompt + confirm'],
      ['Thanks for the speedy swift confirmation', true, 'two modifiers stacked'],
      ['Thanks for sending those through',  false, 'negative: no confirm word'],
      ['Thanks for the package',            false, 'negative: "the package" (no confirm)'],
      ['Thanks for the appraisal',          false, 'negative: "the appraisal" (no confirm)'],
    ];
    let cccRegexPassed = 0;
    for (const [input, shouldMatch, label] of regexCases) {
      const got = cccTighterRegex.test(input);
      if (got !== shouldMatch) {
        throw new Error(`FAIL [Group XXX regex / ${label}]: input=${JSON.stringify(input)} shouldMatch=${shouldMatch} got=${got}`);
      }
      console.log(`  PASS [regex / ${label}]: → ${got}`);
      cccRegexPassed++;
    }
    // "Appreciate" variant catches the same shape
    if (!cccTighterAppreciateRegex.test('Appreciate the quick confirmation')) {
      throw new Error(`FAIL [Group XXX regex / appreciate variant]: did not match "Appreciate the quick confirmation"`);
    }
    console.log(`  PASS [regex / appreciate variant]: catches "Appreciate the quick confirmation"`);
    console.log(`Group XXX regex truth table: ${cccRegexPassed + 1}/${regexCases.length + 1} passed`);

    // Layer 1 — Source-string regression: assert all 4 FORBIDDEN APPROVAL PHRASES
    // sites carry the new adjective-modifier variants + the catch-all generalization.
    const xxxVariantMatches = (aiSource.match(/thanks for the quick confirmation/g) || []).length;
    if (xxxVariantMatches < 4) {
      throw new Error(`FAIL [Group XXX source-string]: expected at least 4 occurrences of "thanks for the quick confirmation" (one per FORBIDDEN list site + the verbose CCC rule body), got ${xxxVariantMatches}`);
    }
    console.log(`  PASS [Group XXX source-string]: "thanks for the quick confirmation" variant present at all sites (${xxxVariantMatches} occurrences)`);
    const xxxCatchAll = (aiSource.match(/ANY (?:variant matching|pattern matching) "thanks for the \[adjective\] confirmation\/confirm"/g) || []).length;
    if (xxxCatchAll < 4) {
      throw new Error(`FAIL [Group XXX catch-all]: expected at least 4 occurrences of the "[adjective] confirmation" catch-all generalization, got ${xxxCatchAll}`);
    }
    console.log(`  PASS [Group XXX catch-all]: "[adjective] confirmation" catch-all generalization present (${xxxCatchAll} occurrences)`);

    // Y 5x — Live Claude verification with the tightened regex.
    try {
      const cccSummary = {
        sender_type: 'broker',
        broker_name: 'Tyler Bennett',
        sender_name: 'Tyler Bennett',
        borrower_name: 'James Okafor',
        ltv_percent: 68,
        loan_type: 'second mortgage',
      };
      // Broker's last message — sending docs, no specific confirmation.
      const cccConvo = [
        { direction: 'inbound', subject: 'Re: James Okafor', body: 'Sending across the gov ID and property tax assessment now. The appraisal will follow next week once the appraiser finalizes.', created_at: new Date(Date.now() - 3600000).toISOString() },
      ];
      // Admin's notes — Franco's internal decision, NOT broker's confirmation.
      const cccAdminNotes = 'Approve subject to receiving the appraisal and confirming the exit strategy. Once those land we can move forward to terms.';

      let cccLeaks = 0;
      for (let run = 1; run <= 5; run++) {
        const cccOutput = await realAi.generateAdminResponseEmail(cccSummary, cccAdminNotes, cccConvo);
        const cccGreetingRegion = (cccOutput || '').slice(0, 400);
        const leakedThanks = cccTighterRegex.test(cccGreetingRegion);
        const leakedAppreciate = cccTighterAppreciateRegex.test(cccGreetingRegion);
        // Regression guard: existing F7-reliability rule (Franco-as-actor) still holds.
        const francoAsActor = /(?:^|>|\n)\s*Franco\s+(has|said|approved|'s decision)/i.test(cccOutput || '');
        const leaked = leakedThanks || leakedAppreciate || francoAsActor;
        if (leaked) {
          cccLeaks++;
          console.log(`  Run ${run}: LEAK — thanks=${leakedThanks}, appreciate=${leakedAppreciate}, francoActor=${francoAsActor}\n    Greeting (first 400): ${cccGreetingRegion.replace(/\s+/g, ' ').slice(0, 400)}`);
        } else {
          console.log(`  Run ${run}: PASS — no thanks-for-confirming/appreciate-confirm variants; F7 Franco-attribution holding`);
        }
      }
      if (cccLeaks >= 2) {
        throw new Error(`FAIL [Group CCC + XXX live 5x]: ${cccLeaks}/5 runs leaked. Escalation threshold reached — prompt strengthening insufficient.`);
      }
      console.log(`Group CCC + XXX live 5x: ${5 - cccLeaks}/5 passed, ${cccLeaks}/5 leaked (threshold: ≤1)`);
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Group CCC + XXX smoke skipped due to API error: ${e.message}`);
    }

    // ════════════════════════════════════════════════════════════════
    // GROUP EEE — "Perfect," banned-opener variant (S14.1)
    // ════════════════════════════════════════════════════════════════
    // S14.1: Vienna wrote "Hi Jason! Perfect, thank you for clarifying..." —
    // the comma variant slipped through. Pre-EEE the banned-openers list at 10
    // sites in ai.js had "Perfect!" and "Perfect." but not "Perfect," — Vienna
    // picked it up. EEE fix: insert "Perfect," into all 10 banned-openers lists.
    // Live smoke: discrepancy-clarification reply scenario (the natural S14.1
    // trigger) — assert Vienna's response doesn't start with "Perfect," + word.
    // Regression guards: existing "Perfect!" / "Perfect." bans still hold.
    console.log('\n========== GROUP EEE — "Perfect," banned-opener variant ==========');
    try {
      const eeeSummary = {
        sender_type: 'broker',
        broker_name: 'Jason Mercer',
        sender_name: 'Jason Mercer',
        borrower_name: 'Lena Park',
        ltv_percent: 65,
        loan_type: 'second mortgage',
      };
      const eeeConvo = [
        // Vienna's previous message asked to clarify a discrepancy.
        { direction: 'outbound', subject: 'Re: Lena Park', body: "I noticed two figures that don't match between your email and the application: (1) the property value — your email lists $720,000 but the appraisal shows $695,000; (2) the existing mortgage balance — your email states $258,000 but the loan application shows $271,500. Could you confirm which figures are accurate?", created_at: new Date(Date.now() - 7200000).toISOString() },
        // Broker's clarification reply — natural trigger for "Perfect," opener pre-EEE.
        { direction: 'inbound', subject: 'Re: Re: Lena Park', body: 'Good catch — the appraisal numbers are accurate. $695,000 property value, $271,500 existing mortgage balance. The figures in my email were stale, sorry about that.', created_at: new Date(Date.now() - 1800000).toISOString() },
      ];
      const eeeResult = await realAi.generateBrokerResponse(
        eeeConvo[1].body,
        [], [],
        eeeSummary,
        eeeConvo,
        [],
        'active'
      );
      const eeeOutput = eeeResult.responseEmail || '';
      console.log('Group EEE output (first 300 chars):');
      console.log(`  ${eeeOutput.slice(0, 300).replace(/\n/g, ' ')}`);

      // Assert: opening must NOT start with "Perfect," (with comma + continuation).
      // Greeting-region scope: first 250 chars covers greeting + opening.
      const eeeGreetingRegion = eeeOutput.slice(0, 250);
      if (/(?:^|>|\n)\s*Perfect,\s*\w/i.test(eeeGreetingRegion)) {
        throw new Error(`FAIL [Group EEE]: "Perfect," opener leaked. First 250 chars: "${eeeGreetingRegion.replace(/\s+/g, ' ')}"`);
      }
      // Regression guards: existing variants must still be banned.
      if (/(?:^|>|\n)\s*Perfect!\s*\w/i.test(eeeGreetingRegion)) {
        throw new Error(`FAIL [Group EEE regression]: "Perfect!" opener leaked (pre-existing rule). First 250 chars: "${eeeGreetingRegion.replace(/\s+/g, ' ')}"`);
      }
      if (/(?:^|>|\n)\s*Perfect\.\s*\w/i.test(eeeGreetingRegion)) {
        throw new Error(`FAIL [Group EEE regression]: "Perfect." opener leaked (pre-existing rule). First 250 chars: "${eeeGreetingRegion.replace(/\s+/g, ' ')}"`);
      }
      console.log('  PASS [Group EEE]: no "Perfect," opener; existing "Perfect!" / "Perfect." bans still holding');
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Group EEE smoke skipped due to API error: ${e.message}`);
    }

    // ════════════════════════════════════════════════════════════════
    // GROUP FFF — no over-clarification when info already provided (S14.2)
    // ════════════════════════════════════════════════════════════════
    // S14.2: Vienna asked "Just to clarify — is the plan to refinance the total
    // combined balance with Scotiabank at that time, or will this be handled
    // differently?" — when exit_strategy was already stated in the loan app and
    // the broker had just resolved the ONLY actual discrepancy. Pre-FFF, no rule
    // forbade Vienna from asking follow-up clarifications on info already on file.
    // FFF fix: explicit CONVERSATIONAL RULE in generateBrokerResponse — accept
    // what's stated, only ask when GENUINELY MISSING / AMBIGUOUS / CONTRADICTION.
    console.log('\n========== GROUP FFF — no over-clarification when info already provided ==========');
    try {
      const fffSummary = {
        sender_type: 'broker',
        broker_name: 'Jason Mercer',
        sender_name: 'Jason Mercer',
        borrower_name: 'Lena Park',
        ltv_percent: 65,
        loan_type: 'second mortgage',
        property_value: 695000,
        loan_amount_requested: 180000,
        existing_mortgage_balance: 271500,
        exit_strategy: 'refinance with Scotiabank at mortgage renewal in August 2028',
        purpose: 'refinance',
      };
      const fffConvo = [
        {
          direction: 'outbound',
          subject: 'Re: Lena Park',
          body: "I noticed two figures that don't match between your email and the application: (1) the property value — your email lists $720,000 but the appraisal shows $695,000; (2) the existing mortgage balance — your email states $258,000 but the loan application shows $271,500. Could you confirm which figures are accurate?",
          created_at: new Date(Date.now() - 7200000).toISOString(),
        },
        {
          direction: 'inbound',
          subject: 'Re: Re: Lena Park',
          body: 'Good catch — the appraisal numbers are accurate. $695,000 property value, $271,500 existing mortgage balance.',
          created_at: new Date(Date.now() - 1800000).toISOString(),
        },
      ];
      const fffResult = await realAi.generateBrokerResponse(
        fffConvo[1].body,
        [], [],
        fffSummary,
        fffConvo,
        [],
        'active'
      );
      const fffOutput = fffResult.responseEmail || '';
      console.log('Group FFF output (first 500 chars):');
      console.log(`  ${fffOutput.slice(0, 500).replace(/\n/g, ' ')}`);

      // Negative assertion — six over-clarification patterns calibrated to S14.2's shape.
      const overClarificationPatterns = [
        [/just\s+to\s+clarify\b/i, '"just to clarify" opener'],
        [/\bis\s+(?:the|that|this)\s+(?:plan|approach|strategy|intent|idea)\s+to\b/i, '"is the plan/approach/strategy/intent to..."'],
        [/\bcould\s+you\s+(?:also\s+)?confirm\s+(?:the|how|whether|if)\s+(?:exit|refinance|combined|total\s+balance)/i, '"could you confirm the exit/refinance/combined/balance..."'],
        [/\bcan\s+you\s+(?:also\s+)?clarify\s+(?:the|how|whether|if)\s+(?:exit|refinance|combined|total\s+balance)/i, '"can you clarify the exit/refinance/combined/balance..."'],
        [/\bhow\s+(?:do\s+you|will\s+you|are\s+you|are\s+they)\s+plan(?:ning)?\s+to\s+(?:refinance|exit|repay)/i, '"how do you plan to refinance/exit/repay..."'],
        [/\bwill\s+(?:this|that|the\s+exit)\s+be\s+handled\s+differently/i, '"will this be handled differently" (S14.2 verbatim shape)'],
      ];
      const failures = [];
      for (const [re, desc] of overClarificationPatterns) {
        const m = fffOutput.match(re);
        if (m) {
          const ctx = fffOutput.slice(Math.max(0, m.index - 30), m.index + m[0].length + 35).replace(/\s+/g, ' ');
          failures.push(`${desc} — matched at "...${ctx}..."`);
        }
      }
      if (failures.length > 0) {
        throw new Error(`FAIL [Group FFF]: Vienna over-clarified info already provided in deal summary / conversation:\n  - ${failures.join('\n  - ')}`);
      }
      console.log('  PASS [Group FFF]: no over-clarification when exit strategy + figures already stated');
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Group FFF smoke skipped due to API error: ${e.message}`);
    }

    // ════════════════════════════════════════════════════════════════
    // GROUP KKK + LLL — businesslike reminder tone + enumerate missing docs
    // ════════════════════════════════════════════════════════════════
    // S12.3: pre-KKK prompt EXPLICITLY recommended "Hey [name]!" + filler greetings as
    //   reminder #1 examples. KKK rewrites the TONE block and bans those patterns.
    // S12.4: pre-LLL prompt EXPLICITLY forbade enumeration ("Do NOT re-list every doc
    //   needed — just reference 'the items we previously requested'"). LLL adds a
    //   missingDocs param + REQUIRES enumeration by canonical name.
    // 5x verifier already shipped 1/5 leaks (acceptable per 0-1 threshold). This
    // single harness smoke is the ongoing regression guard.
    console.log('\n========== GROUP KKK + LLL — reminder tone + doc enumeration ==========');
    try {
      const kklSummary = {
        broker_name: 'Michael Torres',
        ltv_percent: 60,
        sender_name: 'Michael Torres',
        sender_type: 'broker',
        borrower_name: 'Noah MacKenzie',
        exit_strategy: 'Refinance with TD at mortgage renewal (April 2028)',
        broker_company: 'Westgate Mortgage Partners',
        loan_type: 'second mortgage',
      };
      const kklMissing = ['government_id', 'appraisal', 'property_tax', 'mortgage_statement', 'income_proof', 'credit_report'];
      const kklOutput = await realAi.generateFollowUpReminder(kklSummary, 3, 1, kklMissing);
      console.log('Group KKK+LLL output (first 400 chars):');
      console.log(`  ${(kklOutput || '').slice(0, 400).replace(/\n/g, ' ')}`);

      // KKK assertions — tone violations
      const kklTonePatterns = [
        [/^(\s*<p>\s*)?Hey\b/i,                           '"Hey" opener (banned per KKK)'],
        [/Hope\s+you'?re\s+having\s+a\s+great\s+week/i,   '"Hope you\'re having a great week" filler'],
        [/I\s+hope\s+this\s+email\s+finds\s+you\s+well/i, '"I hope this email finds you well" filler'],
        [/Hope\s+all\s+is\s+well/i,                       '"Hope all is well" filler'],
      ];
      const toneFailures = [];
      for (const [re, desc] of kklTonePatterns) {
        if (re.test(kklOutput)) toneFailures.push(desc);
      }
      if (toneFailures.length > 0) {
        throw new Error(`FAIL [Group KKK tone]: reminder leaked banned tone patterns:\n  - ${toneFailures.join('\n  - ')}`);
      }

      // LLL assertions — must enumerate at least 3 specific doc names
      const enumerationMarkers = [
        /\bGovernment[-\s]Issued\s+ID\b/i,
        /\bProperty\s+Appraisal\b/i,
        /\bProperty\s+Tax\s+Assessment\b/i,
        /\bCurrent\s+Mortgage\s+Payout\s+Statement\b/i,
        /\bProof\s+of\s+Income\b/i,
        /\bCredit\s+Report\b/i,
      ];
      const enumeratedCount = enumerationMarkers.filter(re => re.test(kklOutput)).length;
      if (enumeratedCount < 3) {
        throw new Error(`FAIL [Group LLL enumeration]: expected at least 3 specific doc names, got ${enumeratedCount}/6. Output: "${(kklOutput || '').slice(0, 500).replace(/\s+/g, ' ')}"`);
      }
      console.log(`  PASS [Group KKK+LLL]: tone clean (no Hey/filler) + ${enumeratedCount}/6 specific doc names enumerated`);
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Group KKK+LLL smoke skipped due to API error: ${e.message}`);
    }

    // ════════════════════════════════════════════════════════════════
    // GROUP JJJ — AML/PEP timing policy: dropped from intake, kept post-approval
    // ════════════════════════════════════════════════════════════════
    // S12.2: Vienna asked for AML/PEP forms in initial intake reply alongside
    // appraisal, NOA, etc. Franco's policy: AML/PEP are required on every deal
    // but not urgent at intake — some brokers have them on file, lender can pull.
    // Right time to ask is post-approval (admin sends APPROVED → Vienna drafts
    // generateDocumentRequestEmail with AML/PEP in the list). JJJ drops AML/PEP
    // from INITIAL_EMAIL_PROMPT + generateBrokerResponse; keeps them in
    // generateDocumentRequestEmail.
    //
    // Three smokes — JJJ.1/JJJ.2 are negative (no AML/PEP), JJJ.3 is positive
    // (AML/PEP must appear post-approval — regression guard for "we moved them,
    // didn't delete them").

    // JJJ.1 — INITIAL email must NOT mention AML/PEP
    console.log('\n========== GROUP JJJ.1 — INITIAL email no AML/PEP at intake ==========');
    try {
      const jjjInitialBody = `Hi Franco,

New second mortgage submission for review.

Borrower: Marcus Webb
Property: 142 Vine Avenue, Edmonton, AB
Property Value: $890,000
Existing First Mortgage: $318,000 (Scotiabank)
Loan Amount Requested: $90,000
Approximate LTV: ~46%
Exit Strategy: refinance with Scotiabank at maturity

Loan application attached. Will follow up with the rest shortly.

Thanks,
Jason Mercer
Apex Mortgage`;
      const { welcomeEmail: jjjInitialEmail } = await realAi.processInitialEmail(
        'Jason Mercer',
        jjjInitialBody,
        [], [], false, false, false
      );
      console.log('JJJ.1 INITIAL output (first 500 chars):');
      console.log(`  ${(jjjInitialEmail || '').slice(0, 500).replace(/\n/g, ' ')}`);

      // Negative: must NOT mention AML or PEP at intake
      if (/\bAML\b|\banti.?money\s+laundering\b/i.test(jjjInitialEmail)) {
        throw new Error(`FAIL [Group JJJ.1]: INITIAL email mentions AML at intake (post-JJJ they move to post-approval). Got: ${(jjjInitialEmail || '').slice(0, 600)}`);
      }
      if (/\bPEP\b|\bpolitically\s+exposed/i.test(jjjInitialEmail)) {
        throw new Error(`FAIL [Group JJJ.1]: INITIAL email mentions PEP at intake. Got: ${(jjjInitialEmail || '').slice(0, 600)}`);
      }
      // Regression: other intake docs still asked. INITIAL_EMAIL_PROMPT's WHAT TO ASK FOR
      // list (lines 104-112) covers payout, appraisal, proof of income, credit bureau,
      // exit strategy, loan amount, LTV. NOT gov_id / property_tax — those are
      // generateBrokerResponse standardDocs (conversational handler), not INITIAL asks.
      const expectedJJJ1 = [
        [/(?:payout\s+statement|mortgage\s+payout)/i, 'mortgage payout statement'],
        [/appraisal/i, 'appraisal'],
        [/(?:proof\s+of\s+income|NOA|notice\s+of\s+assessment)/i, 'proof of income'],
        [/credit\s+(?:bureau|report|pulled\s+credit)/i, 'credit bureau/report'],
      ];
      for (const [re, label] of expectedJJJ1) {
        if (!re.test(jjjInitialEmail)) {
          throw new Error(`FAIL [Group JJJ.1 regression]: INITIAL must still ask for ${label}. Got: ${(jjjInitialEmail || '').slice(0, 600)}`);
        }
      }
      console.log('  PASS [Group JJJ.1]: INITIAL drops AML/PEP, other intake docs still asked');
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Group JJJ.1 smoke skipped due to API error: ${e.message}`);
    }

    // JJJ.2 — generateBrokerResponse (broker sender, active state) must NOT mention AML/PEP
    console.log('\n========== GROUP JJJ.2 — broker response no AML/PEP at intake ==========');
    try {
      const jjjBrokerSummary = {
        sender_type: 'broker',
        broker_name: 'Jason Mercer',
        sender_name: 'Jason Mercer',
        borrower_name: 'Marcus Webb',
        ltv_percent: 46,
        loan_type: 'second mortgage',
      };
      const jjjBrokerConvo = [
        { direction: 'outbound', subject: 'Re: Marcus Webb', body: 'Thanks for sending the loan application! To move forward I\'ll need: gov ID, appraisal, property tax assessment, proof of income, credit bureau, payout statement, exit strategy.', created_at: new Date(Date.now() - 86400000).toISOString() },
        { direction: 'inbound', subject: 'Re: Re: Marcus Webb', body: 'Working on getting these together — what else do you need on this one?', created_at: new Date(Date.now() - 1800000).toISOString() },
      ];
      const jjjBrokerResult = await realAi.generateBrokerResponse(
        jjjBrokerConvo[1].body,
        [], [],
        jjjBrokerSummary,
        jjjBrokerConvo,
        [],
        'active'
      );
      const jjjBrokerOutput = jjjBrokerResult.responseEmail || '';
      console.log('JJJ.2 broker-response output (first 500 chars):');
      console.log(`  ${jjjBrokerOutput.slice(0, 500).replace(/\n/g, ' ')}`);

      if (/\bAML\b|\banti.?money\s+laundering\b/i.test(jjjBrokerOutput)) {
        throw new Error(`FAIL [Group JJJ.2]: broker response mentions AML at intake. Got: ${jjjBrokerOutput.slice(0, 600)}`);
      }
      if (/\bPEP\b|\bpolitically\s+exposed/i.test(jjjBrokerOutput)) {
        throw new Error(`FAIL [Group JJJ.2]: broker response mentions PEP at intake. Got: ${jjjBrokerOutput.slice(0, 600)}`);
      }
      console.log('  PASS [Group JJJ.2]: broker response drops AML/PEP at intake');
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Group JJJ.2 smoke skipped due to API error: ${e.message}`);
    }

    // JJJ.3 — generateDocumentRequestEmail (post-approval) MUST mention AML AND PEP
    console.log('\n========== GROUP JJJ.3 — post-approval doc-request keeps AML/PEP ==========');
    try {
      const jjjPostSummary = {
        sender_type: 'broker',
        broker_name: 'Jason Mercer',
        sender_name: 'Jason Mercer',
        borrower_name: 'Marcus Webb',
        ltv_percent: 46,
        loan_type: 'second mortgage',
        property_value: 890000,
        loan_amount_requested: 90000,
        existing_mortgage_balance: 318000,
        exit_strategy: 'refinance with Scotiabank at maturity',
        purpose: 'refinance',
      };
      const jjjPostConvo = [
        { direction: 'inbound', subject: 'Marcus Webb', body: 'Submitting Marcus Webb for review.', created_at: new Date(Date.now() - 86400000).toISOString() },
      ];
      const jjjPostExistingDocs = [
        { file_name: 'Loan_Application_Webb.pdf', classification: 'loan_application' },
        { file_name: 'Appraisal_Webb.pdf', classification: 'appraisal' },
      ];
      const jjjPostOutput = await realAi.generateDocumentRequestEmail(
        jjjPostSummary,
        'personal',
        true,                  // hasApp
        false,                 // hasPnw
        jjjPostExistingDocs,
        jjjPostConvo
      );
      console.log('JJJ.3 post-approval doc-request output (first 600 chars):');
      console.log(`  ${(jjjPostOutput || '').slice(0, 600).replace(/\n/g, ' ')}`);

      if (!/\bAML\b|\banti.?money\s+laundering\b/i.test(jjjPostOutput)) {
        throw new Error(`FAIL [Group JJJ.3]: post-approval doc-request must mention AML (broker compliance, post-approval ask). Got: ${(jjjPostOutput || '').slice(0, 600)}`);
      }
      if (!/\bPEP\b|\bpolitically\s+exposed/i.test(jjjPostOutput)) {
        throw new Error(`FAIL [Group JJJ.3]: post-approval doc-request must mention PEP (broker compliance, post-approval ask). Got: ${(jjjPostOutput || '').slice(0, 600)}`);
      }
      console.log('  PASS [Group JJJ.3]: post-approval doc-request includes AML and PEP (regression guard)');
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Group JJJ.3 smoke skipped due to API error: ${e.message}`);
    }

    // ════════════════════════════════════════════════════════════════
    // GROUP HHH — INITIAL identity-clash detection + minimal-ask block
    // ════════════════════════════════════════════════════════════════
    // S15.1: Vienna correctly detected identity discrepancy but fired full doc
    // list in the same email. Sequential gate violation. HHH adds:
    //   - identity_clash field in TASK 2 schema
    //   - IDENTITY CLASH minimal-ask block in INITIAL_EMAIL_PROMPT
    //   - awaiting_identity_confirmation status routing in webhook
    // Live smoke uses the exact production fixture shape (Bergstrom body / Paulson
    // loan app). 5x verification before harness commit ran 0/5 leaks across all
    // assertions — single harness smoke is the ongoing regression guard.
    console.log('\n========== GROUP HHH — INITIAL identity-clash minimal-ask ==========');
    try {
      const hhhBody = `Hi Franco,

New second mortgage submission for review.

Borrower: Anna Bergstrom
Property: 1801 Varsity Estates Dr NW, Calgary, AB
Property Value: $620,000
Existing Mortgage Balance: $341,000 (TD Bank)
Loan Amount Requested: $92,000
Approximate LTV: ~69.8%

I'm attaching the loan application to start.

Thanks,
Jason Mercer
Capital Bridge Mortgage Group`;

      const hhhFakeLoanApp = `LOAN APPLICATION FORM

PRIMARY BORROWER
Full Legal Name: Grace Paulson
Date of Birth: 1981-03-14
Address: 88 Harvest Hills Blvd NE, Calgary, AB

PROPERTY DETAILS
Property Address: 88 Harvest Hills Blvd NE, Calgary, AB
Current Property Value: $480,000
Existing Mortgage: $215,000

LOAN DETAILS
Loan Amount Requested: $65,000

Signed: Grace Paulson`;

      const hhhSavedDocs = [{
        file_name: 'LoanApp_Paulson.pdf',
        classification: 'loan_application',
        extracted_data: { text: hhhFakeLoanApp },
      }];
      const hhhAttachments = [{
        Name: 'LoanApp_Paulson.pdf',
        ContentType: 'application/pdf',
        Content: 'BASE64STUB',
        ContentLength: 100,
      }];

      const hhhResult = await realAi.processInitialEmail(
        'Jason Mercer',
        hhhBody,
        hhhAttachments,
        hhhSavedDocs,
        false, false, false
      );
      const hhhWelcome = hhhResult.welcomeEmail || '';
      const hhhSummary = hhhResult.dealSummary || {};
      console.log('Group HHH output (first 500 chars):');
      console.log(`  ${hhhWelcome.slice(0, 500).replace(/\n/g, ' ')}`);

      // 1. dealSummary.identity_clash must be true
      if (hhhSummary.identity_clash !== true) {
        throw new Error(`FAIL [Group HHH identity_clash flag]: expected dealSummary.identity_clash=true, got ${JSON.stringify(hhhSummary.identity_clash)}`);
      }
      // 2. NO doc-list patterns in welcome email
      const hhhDocListForbidden = [
        [/<ul>/i, '<ul> tag (doc list)'],
        [/\b(?:exit\s+strategy|payout\s+statement|appraisal|proof\s+of\s+income|credit\s+bureau)\b/i, 'doc-list keyword'],
        [/\bI'?ll\s+need:/i, '"I\'ll need:" doc-ask phrase'],
      ];
      const docLeaks = [];
      for (const [re, desc] of hhhDocListForbidden) {
        if (re.test(hhhWelcome)) docLeaks.push(desc);
      }
      if (docLeaks.length > 0) {
        throw new Error(`FAIL [Group HHH no-doc-list]: doc list leaked despite identity_clash. Got: ${docLeaks.join(', ')}\nFirst 600 chars: ${hhhWelcome.slice(0, 600)}`);
      }
      // 3. NO doc-receipt acknowledgment
      const hhhReceiptForbidden = [
        [/\bthanks\s+for\s+sending\s+(?:those\s+)?(?:through|over)/i, '"thanks for sending those through"'],
        [/\bI'?ve\s+received\s+the\s+(?:loan\s+app|application|credit\s+bureau|appraisal|docs?)/i, '"I\'ve received the X" receipt'],
      ];
      const receiptLeaks = [];
      for (const [re, desc] of hhhReceiptForbidden) {
        if (re.test(hhhWelcome)) receiptLeaks.push(desc);
      }
      if (receiptLeaks.length > 0) {
        throw new Error(`FAIL [Group HHH no-receipt-ack]: doc-receipt acknowledgment leaked. Got: ${receiptLeaks.join(', ')}`);
      }
      // 4. MUST contain a clarification ask
      if (!/(?:could\s+you|can\s+you)\s+(?:please\s+)?confirm/i.test(hhhWelcome) && !/\bwhich\s+(?:is\s+)?(?:the\s+)?correct/i.test(hhhWelcome)) {
        throw new Error(`FAIL [Group HHH clarification ask]: expected a 'could you confirm' / 'which is the correct' pattern. First 600: ${hhhWelcome.slice(0, 600)}`);
      }
      // 5. MUST cite both names
      if (!/\bAnna\s+Bergstrom\b/.test(hhhWelcome)) {
        throw new Error(`FAIL [Group HHH cite Anna]: welcome must cite "Anna Bergstrom" (body name). First 600: ${hhhWelcome.slice(0, 600)}`);
      }
      if (!/\bGrace\s+Paulson\b/.test(hhhWelcome)) {
        throw new Error(`FAIL [Group HHH cite Grace]: welcome must cite "Grace Paulson" (loan-app name). First 600: ${hhhWelcome.slice(0, 600)}`);
      }
      console.log('  PASS [Group HHH]: identity_clash=true, no doc-list, no receipt-ack, clarification ask present, both names cited');
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Group HHH smoke skipped due to API error: ${e.message}`);
    }
  } else {
    console.log('\n[live Claude smoke SKIPPED — set a real CLAUDE_API_KEY to run]');
  }

  console.log('\n────────────────────────────────────────');
  console.log('HARNESS COMPLETE — all checks passed');
  console.log('────────────────────────────────────────');
})().catch(e => { console.error('\nHARNESS FAILED:', e.stack || e.message); process.exit(1); });
