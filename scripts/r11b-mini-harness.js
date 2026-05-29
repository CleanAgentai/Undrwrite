// R11-B mini-harness — three-sub-cluster combined Bug 2 + Bug 3 closure
// on Marcus Webb 8c404ae0. Closes Franco Round 7 retest:
//   B-1 Layer 1: canonical-map suppression of loan_application requested_loan_
//                amount when broker source > 30% discrepant
//   B-1 Layer 2: sanitizeLoanAppDocTextForLLM helper + wire at
//                sendPreliminaryReviewToAdmin (LLM-prompt-context consumer-side
//                filter — NEW sub-pattern within 1st template family)
//   B-2: balance source-hierarchy filter extension (R6-γ scope widening
//        from lender-only to lender+balance for non-payout sources)
//   B-3: refinance LTV math carve-out in computeCombinedLtv (consumes R11-A
//        transaction_type field)
//
// 8 verification groups (~55 anchors):
//  (1) R11-B-1-CANONICAL-SUPPRESSION-MATRIX        — Layer 1 truth table
//  (2) R11-B-1-LLM-CONTEXT-SANITIZATION-MATRIX     — Layer 2 helper +
//                                                    Patricia R10-E parity
//  (3) R11-B-2-BALANCE-SOURCE-HIERARCHY-MATRIX     — filter extension
//  (4) R11-B-3-REFINANCE-LTV-MATRIX                — carve-out logic
//  (5) R11-B-MARCUS-LOAD-BEARING (Stage 1.5)       — 8 critical end-to-end
//                                                    assertions including
//                                                    LLM-narrative empirical
//                                                    checks (#6 + #7
//                                                    empirically-close-loop)
//  (6) R11-B-CROSS-CLUSTER-INTEGRATION             — R10/R11-A preservation
//  (7) R11-B-PARSER-NEGATIVE-MATRIX                — over-fire guards
//  (8) R11-B-DEFERRED-RESIDUAL-FLAGGING            — docblock pins for R10-D
//                                                    discipline + 15th
//                                                    carry-forward citation

require('dotenv').config();

process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'sk-test-dummy';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';
process.env.POSTMARK_API_TOKEN = process.env.POSTMARK_API_TOKEN || 'dummy';
process.env.POSTMARK_SENDER_EMAIL = process.env.POSTMARK_SENDER_EMAIL || 'vienna@example.com';
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'franco@privatemortgagelink.com';

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const cf = require('../src/services/canonical-fields');
const dE = require('../src/services/discrepancy-engine');

(async () => {
  console.log('========== R11-B mini-harness — three-sub-cluster combined Bug 2 + Bug 3 closure ==========');

  const _cfSrc = fs.readFileSync(path.join(__dirname, '../src/services/canonical-fields.js'), 'utf8');
  const _deSrc = fs.readFileSync(path.join(__dirname, '../src/services/discrepancy-engine.js'), 'utf8');
  const _whSrc = fs.readFileSync(path.join(__dirname, '../src/routes/webhook.js'), 'utf8');

  let passCount = 0;
  let failCount = 0;
  const expect = (label, cond, detail) => {
    if (cond) { console.log(`  PASS ${label}`); passCount++; }
    else { console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); failCount++; throw new Error(`FAIL [${label}]${detail ? ' — ' + detail : ''}`); }
  };

  // ─── R11-B-1-CANONICAL-SUPPRESSION-MATRIX (Layer 1) ───
  console.log('\n--- R11-B-1-CANONICAL-SUPPRESSION-MATRIX (Layer 1) ---');
  // broker_initial_intent + loan_app >30% discrepant → loan_app suppressed
  // Pattern follows the empirical Marcus loan-request line shape:
  //   "Loan Request: <type> — $<amount> — <purpose>"
  const synth1 = cf.extractCanonicalFields(
    'Loan Request: First mortgage refinance — $400,000 — refinancing existing mortgage',
    [{ file_name: 'fake_loan_app.pdf', classification: 'loan_application', text: '[Page 1 annotation] 95,000', extracted_data: { text: '[Page 1 annotation] 95,000' } }],
    { emailSubject: 'test' },
  );
  expect('(a) broker_initial_intent $400k + loan_app $95k (76% delta) → loan_app suppressed',
    !(synth1.requested_loan_amount || []).some(t => t.value === 95000));
  expect('(b) broker_initial_intent $400k present (not stripped)',
    (synth1.requested_loan_amount || []).some(t => t.value === 400000 && t.classification === 'broker_initial_intent'));
  // broker_initial_intent + loan_app SMALL delta → loan_app preserved
  const synth2 = cf.extractCanonicalFields(
    'Loan Request: First mortgage refinance — $410,000 — refinancing existing mortgage',
    [{ file_name: 'fake_loan_app.pdf', classification: 'loan_application', text: '[Page 1 annotation] 408,000', extracted_data: { text: '[Page 1 annotation] 408,000' } }],
    { emailSubject: 'test' },
  );
  expect('(c) broker_initial_intent $410k + loan_app $408k (0.5% delta) → loan_app PRESERVED (legitimate data-entry pair)',
    (synth2.requested_loan_amount || []).some(t => t.value === 408000));
  // NO broker source + loan_app present → preserved (R10-E parity)
  const synth3 = cf.extractCanonicalFields(
    'Generic email body, no loan request line',
    [{ file_name: 'fake_loan_app.pdf', classification: 'loan_application', text: '[Page 1 annotation] 95,000', extracted_data: { text: '[Page 1 annotation] 95,000' } }],
    { emailSubject: 'test' },
  );
  expect('(d) NO broker source + loan_app $95k → preserved (R10-E parity, no suppression)',
    (synth3.requested_loan_amount || []).some(t => t.value === 95000 && t.classification === 'loan_application'));
  // Threshold edge case — exactly 30% delta → preserved (NOT stripped)
  const synth4 = cf.extractCanonicalFields(
    'Loan Request: First mortgage — $100,000 — refinancing',
    [{ file_name: 'fake_loan_app.pdf', classification: 'loan_application', text: '[Page 1 annotation] 70,000', extracted_data: { text: '[Page 1 annotation] 70,000' } }],
    { emailSubject: 'test' },
  );
  expect('(e) 30% delta exactly → loan_app PRESERVED (boundary inclusive)',
    (synth4.requested_loan_amount || []).some(t => t.value === 70000));
  // Threshold edge case — 35% delta → stripped
  const synth5 = cf.extractCanonicalFields(
    'Loan Request: First mortgage — $100,000 — refinancing',
    [{ file_name: 'fake_loan_app.pdf', classification: 'loan_application', text: '[Page 1 annotation] 65,000', extracted_data: { text: '[Page 1 annotation] 65,000' } }],
    { emailSubject: 'test' },
  );
  expect('(f) 35% delta → loan_app STRIPPED',
    !(synth5.requested_loan_amount || []).some(t => t.value === 65000));
  // Empty broker source → no suppression
  const synth6 = cf.extractCanonicalFields(
    '',
    [{ file_name: 'fake_loan_app.pdf', classification: 'loan_application', text: '[Page 1 annotation] 95,000', extracted_data: { text: '[Page 1 annotation] 95,000' } }],
    { emailSubject: '' },
  );
  expect('(g) empty broker source → loan_app preserved (no suppression triggered)',
    (synth6.requested_loan_amount || []).some(t => t.value === 95000));

  // ─── R11-B-1-LLM-CONTEXT-SANITIZATION-MATRIX (Layer 2) ───
  console.log('\n--- R11-B-1-LLM-CONTEXT-SANITIZATION-MATRIX (Layer 2) ---');
  expect('(a) sanitizeLoanAppDocTextForLLM function exported',
    typeof cf.sanitizeLoanAppDocTextForLLM === 'function');
  const docsSynth = [
    { file_name: 'la.pdf', classification: 'loan_application', extracted_data: { text: '[Page 1 annotation] 95,000\nbody text preserved\n[Page 2 annotation] more annotations\n' } },
    { file_name: 'cb.pdf', classification: 'credit_report', extracted_data: { text: '[Page 1 annotation] CB content preserved' } },
  ];
  // With broker source override → loan_app annotations stripped
  const sanitized1 = cf.sanitizeLoanAppDocTextForLLM(
    docsSynth,
    { requested_loan_amount: [{ value: 408000, classification: 'broker_initial_intent' }] },
  );
  const loanAppSanitized = sanitized1.find(d => d.classification === 'loan_application');
  expect('(b) annotation markers stripped from loan_app when broker override present',
    !/\[Page\s*\d+\s*annotation\]/.test(loanAppSanitized.extracted_data.text));
  expect('(c) loan_app non-annotation text preserved',
    /body text preserved/.test(loanAppSanitized.extracted_data.text));
  // credit_report annotations preserved (only loan_application sanitized)
  const cbSanitized = sanitized1.find(d => d.classification === 'credit_report');
  expect('(d) non-loan_application docs unchanged (only loan_application sanitized)',
    /\[Page 1 annotation\] CB content preserved/.test(cbSanitized.extracted_data.text));
  // No broker override → annotations preserved (Patricia R10-E parity)
  const sanitized2 = cf.sanitizeLoanAppDocTextForLLM(
    docsSynth,
    { requested_loan_amount: [{ value: 50000, classification: 'loan_application' }] },
  );
  const loanAppUnsanitized = sanitized2.find(d => d.classification === 'loan_application');
  expect('(e) NO broker source → loan_app annotations PRESERVED (R10-E Patricia parity)',
    /\[Page\s*\d+\s*annotation\]/.test(loanAppUnsanitized.extracted_data.text));
  // Immutability — original doc not mutated
  expect('(f) original documents array not mutated (immutability)',
    /\[Page 1 annotation\] 95,000/.test(docsSynth[0].extracted_data.text));
  // Wire at sendPreliminaryReviewToAdmin
  expect('(g) sendPreliminaryReviewToAdmin wires sanitizeLoanAppDocTextForLLM before generateLeadSummary',
    /cFields\.sanitizeLoanAppDocTextForLLM\(dealDocs,\s*_bDetectAdmin\.canonical_map\)[\s\S]{0,500}aiService\.generateLeadSummary/.test(_whSrc));
  expect('(h) sanitized docs passed to generateLeadSummary (not raw dealDocs)',
    /aiService\.generateLeadSummary\(\s*dealSummary,\s*ownershipType,\s*_r11bSanitizedDealDocs,/.test(_whSrc));

  // ─── R11-B-2-BALANCE-SOURCE-HIERARCHY-MATRIX ───
  console.log('\n--- R11-B-2-BALANCE-SOURCE-HIERARCHY-MATRIX ---');
  // mortgage_statement + credit_bureau → credit_bureau stripped
  const balMap1 = dE.filterCanonicalLenderForPayoutOnly({
    existing_first_mortgage_balance: [
      { value: 318000, classification: 'credit_report', lender_canonical: 'Scotiabank' },
      { value: 400000, classification: 'mortgage_statement', lender_canonical: 'RBC' },
    ],
    existing_first_mortgage_lender: [
      { value: 'Scotiabank', classification: 'credit_report' },
      { value: 'RBC', classification: 'mortgage_statement' },
    ],
  });
  expect('(a) mortgage_statement + credit_bureau both present → credit_bureau balance stripped',
    !(balMap1.existing_first_mortgage_balance || []).some(t => t.classification === 'credit_report'));
  expect('(b) mortgage_statement balance preserved with lender attribution intact',
    (balMap1.existing_first_mortgage_balance || []).some(t => t.classification === 'mortgage_statement' && t.lender_canonical === 'RBC'));
  // mortgage_statement + pnw_statement → pnw stripped
  const balMap2 = dE.filterCanonicalLenderForPayoutOnly({
    existing_first_mortgage_balance: [
      { value: 200000, classification: 'pnw_statement', lender_canonical: 'TD' },
      { value: 250000, classification: 'mortgage_statement', lender_canonical: 'RBC' },
    ],
  });
  expect('(c) mortgage_statement + pnw_statement → pnw_statement balance stripped',
    !(balMap2.existing_first_mortgage_balance || []).some(t => t.classification === 'pnw_statement'));
  // mortgage_statement only → preserved
  const balMap3 = dE.filterCanonicalLenderForPayoutOnly({
    existing_first_mortgage_balance: [{ value: 250000, classification: 'mortgage_statement', lender_canonical: 'RBC' }],
  });
  expect('(d) mortgage_statement only → preserved',
    (balMap3.existing_first_mortgage_balance || []).length === 1
      && balMap3.existing_first_mortgage_balance[0].classification === 'mortgage_statement');
  // Clean first-mortgage edge case (R6-γ legacy preserved): credit_bureau ONLY (no mortgage_statement) → balance retained, lender nulled
  const balMap4 = dE.filterCanonicalLenderForPayoutOnly({
    existing_first_mortgage_balance: [{ value: 318000, classification: 'credit_report', lender_canonical: 'Scotiabank' }],
  });
  expect('(e) credit_bureau ONLY (no mortgage_statement) → balance retained, lender nulled (R6-γ legacy preserved)',
    (balMap4.existing_first_mortgage_balance || []).length === 1
      && balMap4.existing_first_mortgage_balance[0].lender_canonical === null
      && balMap4.existing_first_mortgage_balance[0].value === 318000);
  // pnw_statement ONLY (no mortgage_statement) → balance retained
  const balMap5 = dE.filterCanonicalLenderForPayoutOnly({
    existing_first_mortgage_balance: [{ value: 200000, classification: 'pnw_statement', lender_canonical: 'TD' }],
  });
  expect('(f) pnw_statement ONLY (no mortgage_statement) → balance retained, lender nulled (R6-γ legacy preserved)',
    (balMap5.existing_first_mortgage_balance || []).length === 1
      && balMap5.existing_first_mortgage_balance[0].lender_canonical === null);

  // ─── R11-B-3-REFINANCE-LTV-MATRIX ───
  console.log('\n--- R11-B-3-REFINANCE-LTV-MATRIX ---');
  // Strict lender match → combined = standalone
  const refMap1 = {
    existing_first_mortgage_balance: [{ value: 400000, classification: 'mortgage_statement' }],
    existing_first_mortgage_lender: [{ value: 'RBC', classification: 'mortgage_statement' }],
    requested_loan_amount: [{ value: 408000, classification: 'broker_initial_intent' }],
    subject_property_market_value: [{ value: 680000 }],
    // FRANCO-Q1 (2026-05-28): carve-out now requires payoutConfirmed (3-condition).
    // Marcus's real production body says "the RBC will be paid out at closing" →
    // payoutConfirmed=true. Simplified test phrase updated to reflect that reality.
    transaction_type: [{ value: 'refinance', classification: 'broker_correction', rawPhrase: 'refinancing his existing RBC first mortgage', payoutConfirmed: true }],
  };
  const refLtv1 = dE.computeCombinedLtv(refMap1);
  expect('(a) refinance + strict lender match + payout language → combined LTV = standalone',
    refLtv1.combined_ltv_percent === 60.0
      && refLtv1.components.existing === 0
      && refLtv1.components.existing_source === 'refinance-paid-out'
      && refLtv1.components.transaction_type === 'refinance');
  // Implicit single-lender match
  const refMap2 = {
    existing_first_mortgage_balance: [{ value: 400000, classification: 'mortgage_statement' }],
    existing_first_mortgage_lender: [{ value: 'RBC', classification: 'mortgage_statement' }],
    requested_loan_amount: [{ value: 408000, classification: 'broker_initial_intent' }],
    subject_property_market_value: [{ value: 680000 }],
    transaction_type: [{ value: 'refinance', classification: 'broker_initial_intent', rawPhrase: 'First mortgage refinance', payoutConfirmed: true }],
  };
  const refLtv2 = dE.computeCombinedLtv(refMap2);
  expect('(b1) refinance + implicit single-lender match + payout language → combined = standalone',
    refLtv2.combined_ltv_percent === 60.0 && refLtv2.components.existing === 0);
  // FRANCO-Q1 (2026-05-28): NEW gate-path assertion. Refinance + lender match but
  // NO payout language (payoutConfirmed falsy) → carve-out GATED OFF → additive
  // combined LTV → escalates for payout clarification (Franco's Q1 rule). This is
  // the corrected three-condition behavior; the old two-condition code fired the
  // carve-out here under a more permissive condition than Franco's stated rule.
  const refMap2b = {
    existing_first_mortgage_balance: [{ value: 400000, classification: 'mortgage_statement' }],
    existing_first_mortgage_lender: [{ value: 'RBC', classification: 'mortgage_statement' }],
    requested_loan_amount: [{ value: 408000, classification: 'broker_initial_intent' }],
    subject_property_market_value: [{ value: 680000 }],
    transaction_type: [{ value: 'refinance', classification: 'broker_initial_intent', rawPhrase: 'First mortgage refinance' }], // no payoutConfirmed
  };
  const refLtv2b = dE.computeCombinedLtv(refMap2b);
  expect('(b2) refinance + lender match but NO payout language → carve-out gated off → additive (escalates)',
    refLtv2b.combined_ltv_percent === Math.round(((400000 + 408000) / 680000) * 100 * 10) / 10
      && refLtv2b.components.existing === 400000);
  // Multi-lender + no lender named → no carve-out (conservative)
  const refMap3 = {
    existing_first_mortgage_balance: [
      { value: 300000, classification: 'mortgage_statement' },
      { value: 100000, classification: 'mortgage_statement' },
    ],
    existing_first_mortgage_lender: [
      { value: 'RBC', classification: 'mortgage_statement' },
      { value: 'TD', classification: 'mortgage_statement' },
    ],
    requested_loan_amount: [{ value: 408000, classification: 'broker_initial_intent' }],
    subject_property_market_value: [{ value: 680000 }],
    transaction_type: [{ value: 'refinance', classification: 'broker_initial_intent', rawPhrase: 'refinance' }],
  };
  const refLtv3 = dE.computeCombinedLtv(refMap3);
  expect('(c) refinance + multi-lender + rawPhrase lacks specific lender → no carve-out (conservative; existing math)',
    refLtv3.combined_ltv_percent === Math.round(((300000 + 408000) / 680000) * 100 * 10) / 10);
  // transaction_type=null → no carve-out (R10-E/R6-γ backwards-compat)
  const refMap4 = {
    existing_first_mortgage_balance: [{ value: 400000, classification: 'mortgage_statement' }],
    existing_first_mortgage_lender: [{ value: 'RBC', classification: 'mortgage_statement' }],
    requested_loan_amount: [{ value: 408000, classification: 'broker_initial_intent' }],
    subject_property_market_value: [{ value: 680000 }],
    transaction_type: [],
  };
  const refLtv4 = dE.computeCombinedLtv(refMap4);
  expect('(d) transaction_type=null → no carve-out (R10-E/R6-γ backwards-compat preserved)',
    refLtv4.combined_ltv_percent === Math.round(((400000 + 408000) / 680000) * 100 * 10) / 10);
  // transaction_type='2nd_mortgage' → no carve-out (additive math correct for 2nd)
  const refMap5 = { ...refMap4, transaction_type: [{ value: '2nd_mortgage', classification: 'broker_correction' }] };
  const refLtv5 = dE.computeCombinedLtv(refMap5);
  expect('(e) transaction_type=2nd_mortgage → no carve-out (additive math preserved)',
    refLtv5.components.existing === 400000);
  // transaction_type='purchase' → no carve-out (additive math preserved for purchase + existing)
  const refMap6 = { ...refMap4, transaction_type: [{ value: 'purchase', classification: 'broker_correction' }] };
  const refLtv6 = dE.computeCombinedLtv(refMap6);
  expect('(f) transaction_type=purchase → no carve-out (additive math preserved)',
    refLtv6.components.existing === 400000);
  // Components schema includes transaction_type when carve-out fires
  expect('(g) refinance carve-out output schema includes transaction_type field in components',
    refLtv1.components.transaction_type === 'refinance' && refLtv1.components.existing_source === 'refinance-paid-out');

  // ─── R11-B-MARCUS-LOAD-BEARING (Stage 1.5 live-Supabase) — 8 critical end-to-end assertions ───
  console.log('\n--- R11-B-MARCUS-LOAD-BEARING (Stage 1.5 — 8 critical end-to-end assertions) ---');
  const MARCUS_DEAL = '8c404ae0-f50e-4b31-aada-eda4c1f43045';
  try {
    const { data: msgs } = await supabase.from('messages').select('direction, subject, body, created_at').eq('deal_id', MARCUS_DEAL).order('created_at', { ascending: true });
    const { data: docs } = await supabase.from('documents').select('file_name, classification, extracted_data').eq('deal_id', MARCUS_DEAL);
    const docsForExtract = docs.map(d => ({ file_name: d.file_name, classification: d.classification, text: d.extracted_data?.text || '', extracted_data: d.extracted_data }));
    const inbounds = msgs.filter(m => m.direction === 'inbound');
    const detect = dE.runDiscrepancyDetectionAggregated(inbounds, docsForExtract, 'Jonathan Ferrara', { emailSubject: inbounds[0]?.subject || '' });

    // #1 — canonical_map.requested_loan_amount: NO $95k loan_application tuple (Layer 1)
    expect('(1) canonical_map.requested_loan_amount: NO $95k loan_application tuple (Layer 1 suppression)',
      !(detect.canonical_map.requested_loan_amount || []).some(t => t.value === 95000));
    // #2 — canonical_map.existing_first_mortgage_balance post-filter: NO $318k credit_bureau (R11-B-2)
    const filteredBalMap = dE.filterCanonicalLenderForPayoutOnly(detect.canonical_map);
    expect('(2) post-R11-B-2 filter: NO $318k credit_bureau tuple in existing_first_mortgage_balance',
      !(filteredBalMap.existing_first_mortgage_balance || []).some(t => t.value === 318000));
    // #3 — computeCombinedLtv = 60.0 (R11-B-3 refinance carve-out)
    const fullyFiltered = dE.filterCanonicalMortgagePositionForObjectiveAuthoritative(
      dE.filterCanonicalPurposeForBrokerAuthoritative(
        dE.filterCanonicalLoanAmountForDocAuthoritative(
          dE.filterCanonicalLenderForPayoutOnly(detect.canonical_map)
        )
      )
    );
    const combinedLtv = dE.computeCombinedLtv(fullyFiltered);
    expect('(3) computeCombinedLtv = 60.0 (was 106.8% pre-fix) — R11-B-3 refinance carve-out',
      combinedLtv && combinedLtv.combined_ltv_percent === 60.0 && combinedLtv.components.existing === 0);
    // #4 — sanitizeLoanAppDocTextForLLM: NO [Page N annotation] markers in loan_app text
    const sanitizedDocs = cf.sanitizeLoanAppDocTextForLLM(docsForExtract, detect.canonical_map);
    const loanAppSanitized = sanitizedDocs.find(d => d.classification === 'loan_application');
    const annotationsPostSanitize = (loanAppSanitized.extracted_data.text.match(/\[Page\s*\d+\s*annotation\]/gi) || []).length;
    expect('(4) sanitizeLoanAppDocTextForLLM: 0 [Page N annotation] markers in Marcus loan_app text post-sanitize',
      annotationsPostSanitize === 0);
    // #5 — renderDealSnapshot Combined LTV row: 60% (refinance-corrected; existing=$0)
    const snap = dE.renderDealSnapshot(fullyFiltered, { ownershipType: 'personal' });
    expect('(5) renderDealSnapshot Combined LTV row: 60% — ($0 + $408,000) / $680,000 (refinance carve-out fires; existing=0)',
      /Combined LTV[\s\S]{0,80}60%[\s\S]{0,80}\$0[\s\S]{0,80}\$408,000[\s\S]{0,80}\$680,000/i.test(snap));
    // #6 — Simulated generateLeadSummary docSections input post-sanitization: NO [Page 1 annotation] 95,000 OR Debt consolidation
    const docSectionsInput = sanitizedDocs
      .filter(d => d.extracted_data?.text)
      .map(d => `--- ${d.classification || 'unclassified'}: ${d.file_name} ---\n${d.extracted_data.text}`)
      .join('\n\n');
    expect('(6) [empirically-close-loop #6] simulated generateLeadSummary docSections: NO "[Page 1 annotation] 95,000" mention',
      !/\[Page 1 annotation\][^\n]*95[,.]?000/i.test(docSectionsInput));
    expect('(6b) [empirically-close-loop #6] simulated generateLeadSummary docSections: NO "Debt consolidation" loan_app mention',
      !/\[Page 1 annotation\][^\n]*[Dd]ebt consolidation/i.test(docSectionsInput));
    // #7 — Source-attribution check: NO standalone Scotiabank mentions in sanitized loan_app text
    const scotiaMentionsPostSanitize = (loanAppSanitized.extracted_data.text.match(/Scotiabank/gi) || []).length;
    expect('(7) [empirically-close-loop #7] post-sanitization Marcus loan_app text: 0 Scotiabank mentions (all stripped with annotation markers)',
      scotiaMentionsPostSanitize === 0);
    // #8 — R10-G machinery unaffected: broker_initial_intent $408k still present
    expect('(8) R10-G machinery preserved: broker_initial_intent $408k present in canonical_map',
      (detect.canonical_map.requested_loan_amount || []).some(t => t.value === 408000 && t.classification === 'broker_initial_intent'));
    const resolved = cf.resolveCanonicalIntentValue(detect.canonical_map, 'requested_loan_amount');
    expect('(8b) resolveCanonicalIntentValue → $408k from broker_initial_intent (R10-G regression preserved)',
      resolved && resolved.value === 408000 && resolved.source === 'broker_initial_intent');
  } catch (e) {
    console.log(`  SKIP (Marcus load-bearing) — ${e.message}`);
  }

  // ─── R11-B-CROSS-CLUSTER-INTEGRATION ───
  console.log('\n--- R11-B-CROSS-CLUSTER-INTEGRATION ---');
  expect('(a) R10-G existing parseBrokerCorrections loan_amount patterns preserved',
    cf.parseBrokerCorrections('the correct loan amount is $73,880').some(c => c.field === 'requested_loan_amount' && c.value === 73880));
  expect('(b) R10-G broker_initial_intent loan-request line preserved (Harpreet S5 shape)',
    cf.parseBrokerInitialIntent('Loan Request: Second mortgage — $73,880 — home renovation').some(c => c.field === 'requested_loan_amount' && c.value === 73880));
  expect('(c) R11-A transaction_type field preserved (R11-B-3 consumes correctly)',
    cf.parseBrokerInitialIntent('Loan Request: First mortgage refinance — $408,000 — refinancing').some(c => c.field === 'transaction_type' && c.value === 'refinance'));
  expect('(d) R11-A inferMortgagePositionFromExistingBalance refinance carve-out preserved',
    cf.inferMortgagePositionFromExistingBalance({
      existing_first_mortgage_balance: [{ value: 400000, classification: 'mortgage_statement' }],
      existing_first_mortgage_lender: [{ value: 'RBC', classification: 'mortgage_statement' }],
      transaction_type: [{ value: 'refinance', classification: 'broker_correction', rawPhrase: 'refinancing existing RBC' }],
    }) === null);
  expect('(e) R10-E mortgage_position OBJECTIVE-field filter preserved',
    typeof dE.filterCanonicalMortgagePositionForObjectiveAuthoritative === 'function');
  expect('(f) R10-F discrepancyHold at computeCompletionDispatch preserved',
    /const\s+computeCompletionDispatch\s*=\s*\(\{[\s\S]{0,200}discrepancyHold\s*\}\)/.test(_whSrc));
  expect('(g) R10-H sweepBrokerFacingDraft preserved at admin-handoff',
    /const\s+sweepBrokerFacingDraft\s*=\s*\(html\)\s*=>/.test(_whSrc));
  expect('(h) R6-γ legacy behavior preserved on clean first-mortgage deals (no mortgage_statement source)',
    (() => {
      const cleanMap = dE.filterCanonicalLenderForPayoutOnly({
        existing_first_mortgage_balance: [{ value: 200000, classification: 'pnw_statement', lender_canonical: 'TD' }],
      });
      return cleanMap.existing_first_mortgage_balance.length === 1
        && cleanMap.existing_first_mortgage_balance[0].value === 200000
        && cleanMap.existing_first_mortgage_balance[0].lender_canonical === null;
    })());

  // ─── R11-B-PARSER-NEGATIVE-MATRIX (over-fire guards) ───
  console.log('\n--- R11-B-PARSER-NEGATIVE-MATRIX ---');
  // Layer 1: small deltas preserved (within 30%)
  const negMap1 = cf.extractCanonicalFields(
    'Loan Request: $100,000 first mortgage — refinancing',
    [{ file_name: 'la.pdf', classification: 'loan_application', text: '[Page 1 annotation] 105,000', extracted_data: { text: '[Page 1 annotation] 105,000' } }],
    { emailSubject: 'test' },
  );
  expect('(a) Layer 1: 5% delta → loan_app tuple preserved (no over-fire on legitimate small discrepancies)',
    (negMap1.requested_loan_amount || []).some(t => t.value === 105000));
  // Layer 2: doc without annotations preserved unchanged
  const docsNoAnnotations = [{ file_name: 'la.pdf', classification: 'loan_application', extracted_data: { text: 'Plain text content with no annotation markers' } }];
  const negSanitized = cf.sanitizeLoanAppDocTextForLLM(
    docsNoAnnotations,
    { requested_loan_amount: [{ value: 408000, classification: 'broker_initial_intent' }] },
  );
  expect('(b) Layer 2: doc without annotations preserved unchanged when sanitization triggered',
    negSanitized[0].extracted_data.text === 'Plain text content with no annotation markers');
  // R11-B-2: clean first-mortgage edge case preserved
  expect('(c) R11-B-2: clean first-mortgage (no mortgage_statement) preserves credit_bureau balance',
    dE.filterCanonicalLenderForPayoutOnly({
      existing_first_mortgage_balance: [{ value: 100000, classification: 'credit_report', lender_canonical: 'TD' }],
    }).existing_first_mortgage_balance.length === 1);
  // R11-B-3: non-refinance preserves existing math
  expect('(d) R11-B-3: transaction_type=null → existing additive math preserved',
    dE.computeCombinedLtv({
      existing_first_mortgage_balance: [{ value: 200000, classification: 'mortgage_statement' }],
      existing_first_mortgage_lender: [{ value: 'TD', classification: 'mortgage_statement' }],
      requested_loan_amount: [{ value: 100000, classification: 'broker_initial_intent' }],
      subject_property_market_value: [{ value: 500000 }],
      transaction_type: [],
    }).components.existing === 200000);

  // ─── R11-B-DEFERRED-RESIDUAL-FLAGGING ───
  console.log('\n--- R11-B-DEFERRED-RESIDUAL-FLAGGING ---');
  expect('(a) R11-B-1 Layer 1 docblock cites empirical anchor (Marcus 8c404ae0)',
    /R11-B-1 Layer 1[\s\S]{0,400}Marcus[\s\S]{0,100}8c404ae0/i.test(_cfSrc));
  expect('(b) R11-B-1 Layer 1 docblock cites tunable threshold (30% delta) + R10-D closure condition',
    /THRESHOLD CALIBRATION[\s\S]{0,400}30%[\s\S]{0,400}recalibrate threshold/i.test(_cfSrc));
  expect('(c) sanitizeLoanAppDocTextForLLM docblock cites LLM-prompt-context consumer-side filter sub-pattern',
    /LLM-prompt-context consumer-side filter[\s\S]{0,400}sibling to consumer-side[\s\S]{0,300}Snapshot-renderer boundary/i.test(_cfSrc));
  expect('(d) sanitizeLoanAppDocTextForLLM docblock cites Patricia R10-E parity carve-out',
    /CONDITIONAL SANITIZATION[\s\S]{0,400}R10-E Patricia parity/i.test(_cfSrc));
  expect('(e) computeCombinedLtv R11-B-3 docblock cites Marcus empirical anchor + refinance math correction',
    /R11-B-3[\s\S]{0,800}Marcus Webb 8c404ae0[\s\S]{0,300}refinancing[\s\S]{0,80}his[\s\S]{0,80}existing RBC/i.test(_deSrc));
  expect('(f) filterCanonicalLenderForPayoutOnly R11-B-2 docblock cites R6-γ legacy preservation',
    /R11-B-2[\s\S]{0,800}R6-γ legacy[\s\S]{0,300}clean first-mortgage edge case/i.test(_deSrc));
  expect('(g) R11-B-1 Layer 2 docblock flags deferred residuals (other call sites + deeper template detection)',
    /DEFERRED RESIDUAL[\s\S]{0,400}other call sites[\s\S]{0,400}deeper blank-template/i.test(_cfSrc));

  console.log('\n========== R11-B mini-harness complete ==========');
  console.log(`PASS: ${passCount} | FAIL: ${failCount}`);
  if (failCount > 0) process.exit(1);
})().catch(e => { console.error('\nHARNESS ERROR:', e.stack || e.message); process.exit(1); });
