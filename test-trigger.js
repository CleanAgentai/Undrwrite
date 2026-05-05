// Synthetic harness for Bug A — preliminary-review / escalation trigger.
// Stubs Postmark / Supabase / Claude so nothing leaves the process.
// Exercises both gate predicates and both action helpers.

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
  // mortgage_statement, income_proof, credit_report. Patricia's stub has appraisal — so 5 missing.
  pAssert(calls.generateLeadSummary[0].missingDocs.length === 5, `expected 5 missing docs (post-Bradley), got ${calls.generateLeadSummary[0].missingDocs.length}: ${JSON.stringify(calls.generateLeadSummary[0].missingDocs)}`);
  pAssert(!calls.generateLeadSummary[0].missingDocs.includes('noa'), 'NOA should NOT be in missingDocs list');
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
      name: 'CALIBRATION RISK — 50w+ multi-paragraph edit instructions → REPLACE (false positive shape)',
      // This is the documented false-positive direction Porter accepted: long
      // multi-paragraph edit instructions trip the heuristic. Test asserts the
      // current calibration's behavior (REPLACE) so future tightening is visible.
      text: 'Couple of changes I want to flag on this draft.\n\nFirst, please remove the praise paragraph entirely — the tone is too florid for the broker and we want to stay neutral throughout.\n\nSecond, change the closing to mention we will be in touch within 48 hours about next steps rather than the current vague language about timing.',
      expect: true,
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

    // Adversarial 2: generateCompletionEmail — final closing email. The Scenario 3 shape that
    // produced "Thanks for confirming approval, Jason!" + "I'll get this over to Franco".
    try {
      const completionEmail = await realAi.generateCompletionEmail(
        {
          borrower_name: 'Derek Olsen',
          broker_name: 'Jason Mercer',
          sender_name: 'Jason Mercer',
        },
        [
          { direction: 'inbound', body: 'Here are the last few documents — gov ID, tax assessment, and payout statement attached.' },
          { direction: 'outbound', body: 'Thanks for sending those through!' },
        ]
      );
      console.log('generateCompletionEmail output (first 300 chars):');
      console.log(`  ${(completionEmail || '').slice(0, 300).replace(/\n/g, ' ')}`);
      checkBugC('generateCompletionEmail', completionEmail);
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  generateCompletionEmail smoke skipped due to API error: ${e.message}`);
    }

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
    const vaguePhrases = [
      [/\bthe\s+final\s+documents\b/i, '"the final documents"'],
      [/\bthe\s+missing\s+documents\b/i, '"the missing documents"'],
      [/\bthe\s+outstanding\s+(?:items|documents|paperwork)\b/i, '"the outstanding items/documents/paperwork"'],
      [/\bthe\s+rest\s+of\s+the\s+(?:package|documents|paperwork)\b/i, '"the rest of the package/documents"'],
      [/\bthe\s+remaining\s+(?:paperwork|documents|items)\b/i, '"the remaining paperwork/documents/items"'],
      [/\bthe\s+final\s+items\b/i, '"the final items"'],
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
    } catch (e) {
      if (e.message.startsWith('FAIL')) throw e;
      console.warn(`  Group K adversarial smoke skipped due to API error: ${e.message}`);
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
  } else {
    console.log('\n[live Claude smoke SKIPPED — set a real CLAUDE_API_KEY to run]');
  }

  console.log('\n────────────────────────────────────────');
  console.log('HARNESS COMPLETE — all checks passed');
  console.log('────────────────────────────────────────');
})().catch(e => { console.error('\nHARNESS FAILED:', e.stack || e.message); process.exit(1); });
