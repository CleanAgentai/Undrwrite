// R10-G mini-harness — 7 verification groups in isolation including Stage 1.5
// production-fixture replay against Ethan Broussard deal c95f3a20 (R10-B
// discipline carry-forward).

require('dotenv').config();

process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'sk-test-dummy';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';
process.env.POSTMARK_API_TOKEN = process.env.POSTMARK_API_TOKEN || 'dummy';
process.env.POSTMARK_SENDER_EMAIL = process.env.POSTMARK_SENDER_EMAIL || 'vienna@example.com';
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'franco@privatemortgagelink.com';

const cFields = require('../src/services/canonical-fields');
const dEngine = require('../src/services/discrepancy-engine');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

(async () => {
  console.log('========== R10-G mini-harness — broker-correction canonical-map override ==========');

  const fs = require('fs');
  const path = require('path');
  const _aiSrc = fs.readFileSync(path.join(__dirname, '../src/services/ai.js'), 'utf8');
  const _cfSrc = fs.readFileSync(path.join(__dirname, '../src/services/canonical-fields.js'), 'utf8');
  const _deSrc = fs.readFileSync(path.join(__dirname, '../src/services/discrepancy-engine.js'), 'utf8');
  const _whSrc = fs.readFileSync(path.join(__dirname, '../src/routes/webhook.js'), 'utf8');

  let passCount = 0;
  let failCount = 0;
  const expect = (label, cond, detail) => {
    if (cond) { console.log(`  PASS ${label}`); passCount++; }
    else { console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); failCount++; throw new Error(`FAIL [${label}]${detail ? ' — ' + detail : ''}`); }
  };

  // ─── R10-G-CORRECTION-PARSER-MATRIX (15+ cases) ───
  console.log('\n--- R10-G-CORRECTION-PARSER-MATRIX ---');
  const { parseBrokerCorrections, parseBrokerInitialIntent } = cFields;

  // Loan amount correction patterns
  expect('(a) "The correct loan amount is $73,880." → loan amount 73880', (() => {
    const r = parseBrokerCorrections("Hi Vienna,\n\nThe correct loan amount is $73,880. Thanks.");
    return r.length === 1 && r[0].field === 'requested_loan_amount' && r[0].value === 73880 && r[0].source === 'broker_correction';
  })());
  expect('(b) "Correct amount: $73,880" → 73880', (() => {
    const r = parseBrokerCorrections("Correct amount: $73,880");
    return r.some(c => c.field === 'requested_loan_amount' && c.value === 73880);
  })());
  expect('(c) "actually $73,880 (not $74,000)" → 73880', (() => {
    const r = parseBrokerCorrections("Hi, actually $73,880 (not $74,000).");
    return r.some(c => c.field === 'requested_loan_amount' && c.value === 73880);
  })());
  expect('(d) "I meant $73,880" → 73880', (() => {
    const r = parseBrokerCorrections("Apologies — I meant $73,880.");
    return r.some(c => c.field === 'requested_loan_amount' && c.value === 73880);
  })());
  expect('(e) "amount should be $73,880" → 73880', (() => {
    const r = parseBrokerCorrections("The amount should be $73,880.");
    return r.some(c => c.field === 'requested_loan_amount' && c.value === 73880);
  })());
  expect('(f) "Yes, $73,880 is correct" → 73880 (confirmation pattern)', (() => {
    const r = parseBrokerCorrections("Yes, $73,880 is correct.");
    return r.some(c => c.field === 'requested_loan_amount' && c.value === 73880);
  })());
  expect('(g) "Looking at it again, $74,000 sounds right" → 74000 (reconsideration pattern)', (() => {
    const r = parseBrokerCorrections("Looking at it again, $74,000 sounds right.");
    return r.some(c => c.field === 'requested_loan_amount' && c.value === 74000);
  })());
  // Purpose correction patterns
  expect('(h) "The correct purpose is home renovation." → purpose "home renovation"', (() => {
    const r = parseBrokerCorrections("The correct purpose is home renovation.");
    return r.some(c => c.field === 'purpose' && /home renovation/i.test(c.value));
  })());
  expect('(i) "The actual purpose is debt consolidation" → "debt consolidation"', (() => {
    const r = parseBrokerCorrections("Just to clarify — the actual purpose is debt consolidation.");
    return r.some(c => c.field === 'purpose' && /debt consolidation/i.test(c.value));
  })());
  // CARVE-OUT: hedging
  expect('(j) HEDGING "I think the amount might be around $73,880" → [] (no false-positive)',
    parseBrokerCorrections("I think the amount might be around $73,880.").length === 0);
  expect('(k) HEDGING "approximately $73,880" → []',
    parseBrokerCorrections("The amount is approximately $73,880.").length === 0);
  // CARVE-OUT: question form
  expect('(l) QUESTION "Is the amount $73,880?" → [] (no false-positive)',
    parseBrokerCorrections("Is the amount $73,880?").length === 0);
  // Edge cases
  expect('(m) null → []', parseBrokerCorrections(null).length === 0);
  expect('(n) empty → []', parseBrokerCorrections('').length === 0);
  expect('(o) non-string → []', parseBrokerCorrections(12345).length === 0);
  expect('(p) plain message without correction → []',
    parseBrokerCorrections("Hi Vienna,\n\nThanks for the update. Best, Harpreet").length === 0);
  // Initial intent
  expect('(q) initial intent "Loan Request: Second mortgage — $73,880 — home renovation" → amount + purpose',
    (() => {
      const r = parseBrokerInitialIntent("Borrower: Ethan Loan Request: Second mortgage — $73,880 — home renovation\nExisting mortgage: CIBC");
      const amount = r.find(i => i.field === 'requested_loan_amount');
      const purpose = r.find(i => i.field === 'purpose');
      return amount && amount.value === 73880 && amount.source === 'broker_initial_intent'
          && purpose && /home renovation/i.test(purpose.value) && purpose.source === 'broker_initial_intent';
    })());

  // ─── R10-G-CANONICAL-MAP-EXTENSION ───
  console.log('\n--- R10-G-CANONICAL-MAP-EXTENSION ---');
  // Test that canonical_map has purpose tuple-list + broker classifications get unshifted
  const map1 = cFields.extractCanonicalFields('', [], {
    brokerCorrections: [{ field: 'requested_loan_amount', value: 73880, source: 'broker_correction' }],
    brokerInitialIntent: [{ field: 'purpose', value: 'home renovation', source: 'broker_initial_intent' }],
  });
  expect('(a) canonical_map.purpose tuple-list exists', Array.isArray(map1.purpose));
  expect('(b) broker_correction tuple unshifted to requested_loan_amount [0]',
    map1.requested_loan_amount[0]?.classification === 'broker_correction'
    && map1.requested_loan_amount[0]?.value === 73880);
  expect('(c) broker_initial_intent tuple unshifted to purpose [0]',
    map1.purpose[0]?.classification === 'broker_initial_intent'
    && /home renovation/i.test(map1.purpose[0]?.value));
  // Resolver hierarchy
  expect('(d) resolveCanonicalIntentValue: broker_correction wins',
    cFields.resolveCanonicalIntentValue(map1, 'requested_loan_amount')?.value === 73880);
  expect('(e) resolveCanonicalIntentValue: broker_initial_intent for purpose',
    /home renovation/i.test(cFields.resolveCanonicalIntentValue(map1, 'purpose')?.value));
  // Hierarchy with docs present
  const map2 = cFields.extractCanonicalFields('', [], {
    brokerCorrections: [{ field: 'requested_loan_amount', value: 73880, source: 'broker_correction' }],
  });
  map2.requested_loan_amount.push({ value: 74000, source: 'LoanApp.pdf', classification: 'loan_application' });
  expect('(f) broker_correction OUTRANKS loan_application even with doc tuple present',
    cFields.resolveCanonicalIntentValue(map2, 'requested_loan_amount')?.value === 73880);
  // Filter behavior
  const filteredAmount = dEngine.filterCanonicalLoanAmountForDocAuthoritative(map2);
  expect('(g) filter strips loan_application when broker_correction exists',
    filteredAmount.requested_loan_amount.every(t => t.classification === 'broker_correction'));
  expect('(h) filterCanonicalPurposeForBrokerAuthoritative defined',
    typeof dEngine.filterCanonicalPurposeForBrokerAuthoritative === 'function');

  // ─── R10-G-OVERRIDE-BLOCK-ANCHORS (12+ anchor content discipline) ───
  console.log('\n--- R10-G-OVERRIDE-BLOCK-ANCHORS ---');
  // Source pins on the override block + anti-phrasing anchors
  expect('(1) override block header "[BROKER STATEMENT AUTHORITATIVE FOR INTENT FIELDS]" present',
    /CRITICAL — BROKER STATEMENT AUTHORITATIVE FOR INTENT FIELDS/.test(_aiSrc));
  expect('(2) "R10-G JS-deterministic, USE THIS" intro',
    /R10-G JS-deterministic, USE THIS/.test(_aiSrc));
  expect('(3) "broker is the authoritative source" anti-source language',
    /broker is the authoritative source/.test(_aiSrc));
  expect('(4) source-hierarchy enumeration "broker_correction > broker_initial_intent > documents"',
    /broker_correction[\s\S]{0,50}>[\s\S]{0,50}broker_initial_intent[\s\S]{0,50}>[\s\S]{0,50}documents/.test(_aiSrc));
  expect('(5) LOAN AMOUNT directive for Deal Snapshot row',
    /Use "\$\{fmtMoney\(la\.value\)\}" in the Deal Snapshot "Loan Amount Requested" row/.test(_aiSrc));
  expect('(6) Anti-phrasing: "DO NOT phrase this as broker confirmed"',
    /DO NOT phrase this as "broker confirmed the application amount"/.test(_aiSrc));
  expect('(7) Anti-phrasing alternatives ("broker confirmed the application amount" + "broker has confirmed" + "as broker confirmed" all present)',
    /"broker confirmed the application amount"/.test(_aiSrc)
    && /"broker has confirmed"/.test(_aiSrc)
    && /"as broker confirmed"/.test(_aiSrc));
  expect('(8) Correct phrasing directive ("broker corrected to" / "broker clarified the amount as")',
    /broker \$\{verbLabel\} the amount to \$\{fmtMoney\(la\.value\)\}/.test(_aiSrc));
  expect('(9) "DO NOT raise this as a discrepancy" for loan amount',
    /DO NOT raise this as a "discrepancy" risk factor/.test(_aiSrc));
  expect('(10) PURPOSE block "broker statement is authoritative for purpose (broker INTENT)"',
    /broker statement is authoritative for purpose \(broker INTENT\)/.test(_aiSrc));
  expect('(11) PURPOSE: "OVERRIDES the loan_application + AML form" anti-source',
    /OVERRIDES document purpose text/.test(_aiSrc));
  expect('(12) Closing rationale: Deal Rating should reflect broker-stated intent resolved',
    /broker-stated intent is resolved/.test(_aiSrc));

  // ─── R10-G-ETHAN-LOAD-BEARING ───
  console.log('\n--- R10-G-ETHAN-LOAD-BEARING ---');
  // Synthetic Ethan-shape replay (without DB)
  const ethanInitial = `Hi,\n\nBorrower: Ethan James Broussard Property: 819 Strathmore Drive SW, Calgary, AB T3H 4M6 Loan Request: Second mortgage — $73,880 — home renovation\nExisting mortgage: CIBC (matures November 2027)\n\nHarpreet Gill\n`;
  const ethanCorrection = `Hi Vienna,\n\nThe correct loan amount is $73,880. The exit strategy is refinance at CIBC maturity in November 2027.\n\nHarpreet Gill\n`;
  const ethanInitialIntent = parseBrokerInitialIntent(ethanInitial);
  expect('(a) Ethan initial inbound → loan amount 73880',
    ethanInitialIntent.find(i => i.field === 'requested_loan_amount')?.value === 73880);
  expect('(b) Ethan initial inbound → purpose "home renovation"',
    /home renovation/i.test(ethanInitialIntent.find(i => i.field === 'purpose')?.value || ''));
  const ethanCorrections = parseBrokerCorrections(ethanCorrection);
  expect('(c) Ethan correction → amount 73880 via broker_correction',
    ethanCorrections.find(c => c.field === 'requested_loan_amount')?.value === 73880);

  // ─── R10-G-PRODUCTION-FIXTURE-VERIFICATION (Stage 1.5 live-Supabase replay) ───
  console.log('\n--- R10-G-PRODUCTION-FIXTURE-VERIFICATION (live Supabase) ---');
  const ETHAN_DEAL = 'c95f3a20-162c-45cf-a98c-60b6bbb2de9a';
  const { data: ethanInbounds } = await supabase
    .from('messages')
    .select('body, created_at')
    .eq('deal_id', ETHAN_DEAL)
    .eq('direction', 'inbound')
    .order('created_at', { ascending: true });
  expect('(a) Pulled Ethan inbound messages from production',
    ethanInbounds && ethanInbounds.length >= 2);
  const realInitial = ethanInbounds[0].body;
  const realCorrection = ethanInbounds[1].body;
  const realIntentParsed = parseBrokerInitialIntent(realInitial);
  expect('(b) PROD: Ethan inbound[0] body-prose parse → initial intent loan_amount=73880',
    realIntentParsed.find(i => i.field === 'requested_loan_amount')?.value === 73880);
  expect('(c) PROD: Ethan inbound[0] body-prose parse → initial intent purpose="home renovation"',
    /home renovation/i.test(realIntentParsed.find(i => i.field === 'purpose')?.value || ''));
  const realCorrectionParsed = parseBrokerCorrections(realCorrection);
  expect('(d) PROD: Ethan inbound[1] parseBrokerCorrections → amount 73880',
    realCorrectionParsed.find(c => c.field === 'requested_loan_amount')?.value === 73880);
  // Full canonical_map replay via dEngine aggregator
  const { data: ethanDocs } = await supabase
    .from('documents')
    .select('file_name, classification, extracted_data')
    .eq('deal_id', ETHAN_DEAL);
  const docsForCanonical = ethanDocs.map(d => ({ file_name: d.file_name, classification: d.classification, text: d.extracted_data?.text || '' }));
  const fullDetect = dEngine.runDiscrepancyDetectionAggregated(ethanInbounds, docsForCanonical, 'Ethan James Broussard', { emailSubject: 'New File Submission — Ethan Broussard' });
  const fullFiltered = dEngine.filterCanonicalPurposeForBrokerAuthoritative(
    dEngine.filterCanonicalLoanAmountForDocAuthoritative(
      dEngine.filterCanonicalLenderForPayoutOnly(fullDetect.canonical_map)
    )
  );
  const finalAmount = cFields.resolveCanonicalIntentValue(fullFiltered, 'requested_loan_amount');
  const finalPurpose = cFields.resolveCanonicalIntentValue(fullFiltered, 'purpose');
  expect('(e) PROD end-to-end: resolved loan amount = 73880 via broker_correction',
    finalAmount?.value === 73880 && finalAmount?.source === 'broker_correction');
  expect('(f) PROD end-to-end: resolved purpose = "home renovation" via broker_initial_intent',
    /home renovation/i.test(finalPurpose?.value || '') && finalPurpose?.source === 'broker_initial_intent');
  expect('(g) PROD end-to-end: filtered map.requested_loan_amount[0] = broker_correction tuple',
    fullFiltered.requested_loan_amount[0]?.classification === 'broker_correction');
  expect('(h) PROD end-to-end: filtered map.purpose[0] = broker_initial_intent tuple',
    fullFiltered.purpose[0]?.classification === 'broker_initial_intent');

  // ─── R10-G-CROSS-CLUSTER-INTEGRATION (10 anchors) ───
  console.log('\n--- R10-G-CROSS-CLUSTER-INTEGRATION ---');
  expect('(a) R6-γ filterCanonicalLenderForPayoutOnly preserved',
    typeof dEngine.filterCanonicalLenderForPayoutOnly === 'function');
  expect('(b) R6-α filterCanonicalLoanAmountForDocAuthoritative preserved',
    typeof dEngine.filterCanonicalLoanAmountForDocAuthoritative === 'function');
  expect('(c) R6-β-A loan_application Page-1 annotation extraction preserved',
    /R6-β-A.*Page-1 annotation extraction/.test(_cfSrc));
  expect('(d) R9-B canonical LTV resolver preserved',
    /computeCanonicalLtvForReview/.test(_whSrc));
  expect('(e) R9-D canonical lender override preserved',
    /computeCanonicalLenderForReview/.test(_whSrc));
  expect('(f) R10-B parseBrokerFirstName preserved',
    /parseBrokerFirstName/.test(_aiSrc));
  expect('(g) R10-A classifyIntakeBorrower preserved',
    /classifyIntakeBorrower/.test(_whSrc));
  expect('(h) R9-F findExistingDealForBorrower preserved',
    /findExistingDealForBorrower/.test(_whSrc));
  expect('(i) parseBrokerCorrections + parseBrokerInitialIntent exported',
    /parseBrokerCorrections/.test(_cfSrc) && /parseBrokerInitialIntent/.test(_cfSrc));
  expect('(j) canonicalCorrectionsOverride opt threaded into generateLeadSummary',
    /canonicalCorrectionsOverride/.test(_aiSrc) && /canonicalCorrectionsOverride/.test(_whSrc));

  // ─── R10-G-CARVE-OUT-RESPECT ───
  console.log('\n--- R10-G-CARVE-OUT-RESPECT ---');
  expect('(a) hedging "I think the amount might be around $73,880" → no false-positive correction',
    parseBrokerCorrections("I think the amount might be around $73,880.").length === 0);
  expect('(b) "approximately $73,880" → no false-positive',
    parseBrokerCorrections("approximately $73,880 should work").length === 0);
  expect('(c) question "Is the amount $73,880?" → no false-positive',
    parseBrokerCorrections("Is the amount $73,880?").length === 0);
  expect('(d) "Can you confirm $73,880?" → no false-positive (question form)',
    parseBrokerCorrections("Can you confirm $73,880?").length === 0);
  expect('(e) plain message without any correction phrasing → []',
    parseBrokerCorrections("Hi, just sending the documents over. Thanks.").length === 0);

  console.log(`\n========== R10-G mini-harness: ${passCount}/${passCount + failCount} PASS ==========`);
  if (failCount > 0) process.exit(1);
})().catch(e => {
  console.error('\nR10-G HARNESS FAILED:', e.stack || e.message);
  process.exit(1);
});
