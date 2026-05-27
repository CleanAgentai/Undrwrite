// R10-E mini-harness — 7 verification groups including Stage 1.5 live-Supabase
// production-fixture replay against Patricia Simmons deal a0caddfb.
// R10-B/R10-G/R10-D discipline carry-forward.

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
  console.log('========== R10-E mini-harness — mortgage_position canonical resolver ==========');

  const fs = require('fs');
  const path = require('path');
  const _cfSrc = fs.readFileSync(path.join(__dirname, '../src/services/canonical-fields.js'), 'utf8');
  const _deSrc = fs.readFileSync(path.join(__dirname, '../src/services/discrepancy-engine.js'), 'utf8');
  const _whSrc = fs.readFileSync(path.join(__dirname, '../src/routes/webhook.js'), 'utf8');

  let passCount = 0;
  let failCount = 0;
  const expect = (label, cond, detail) => {
    if (cond) { console.log(`  PASS ${label}`); passCount++; }
    else { console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); failCount++; throw new Error(`FAIL [${label}]${detail ? ' — ' + detail : ''}`); }
  };

  const { extractMortgagePositionFromLoanApplication, inferMortgagePositionFromExistingBalance } = cFields;

  // ─── R10-E-ANNOTATION-EXTRACT-MATRIX ───
  console.log('\n--- R10-E-ANNOTATION-EXTRACT-MATRIX ---');
  // Position-shape annotations
  const synthDoc = (annText) => ({ extracted_data: { text: `Some preamble.\n${annText}\nMore text.` } });
  expect('(a) "[Page 1 annotation] Second Mortgage" → "2nd"',
    extractMortgagePositionFromLoanApplication(synthDoc('[Page 1 annotation] Second Mortgage')) === '2nd');
  expect('(b) "[Page 1 annotation] First Mortgage" → "1st"',
    extractMortgagePositionFromLoanApplication(synthDoc('[Page 1 annotation] First Mortgage')) === '1st');
  expect('(c) "[Page 1 annotation] Third Mortgage" → "3rd"',
    extractMortgagePositionFromLoanApplication(synthDoc('[Page 1 annotation] Third Mortgage')) === '3rd');
  expect('(d) "[Page 1 annotation] 1st Mortgage" → "1st"',
    extractMortgagePositionFromLoanApplication(synthDoc('[Page 1 annotation] 1st Mortgage')) === '1st');
  expect('(e) "[Page 1 annotation] 2nd Mortgage" → "2nd"',
    extractMortgagePositionFromLoanApplication(synthDoc('[Page 1 annotation] 2nd Mortgage')) === '2nd');
  expect('(f) "[Page 1 annotation] 3rd Mortgage" → "3rd"',
    extractMortgagePositionFromLoanApplication(synthDoc('[Page 1 annotation] 3rd Mortgage')) === '3rd');
  expect('(g) lowercase: "[Page 1 annotation] second mortgage" → "2nd"',
    extractMortgagePositionFromLoanApplication(synthDoc('[Page 1 annotation] second mortgage')) === '2nd');
  // Non-matching annotations skipped
  expect('(h) "[Page 1 annotation] Patricia Simmons" → null (not position-shape)',
    extractMortgagePositionFromLoanApplication(synthDoc('[Page 1 annotation] Patricia Simmons')) === null);
  expect('(i) "[Page 1 annotation] $85,000" → null',
    extractMortgagePositionFromLoanApplication(synthDoc('[Page 1 annotation] $85,000')) === null);
  expect('(j) "[Page 1 annotation] Calgary" → null',
    extractMortgagePositionFromLoanApplication(synthDoc('[Page 1 annotation] Calgary')) === null);
  // Mixed annotations — picks the position-shape one
  expect('(k) multiple annotations — picks position-shape',
    extractMortgagePositionFromLoanApplication(synthDoc('[Page 1 annotation] $85,000\n[Page 1 annotation] Second Mortgage\n[Page 1 annotation] Patricia')) === '2nd');
  // Edge cases
  expect('(l) null doc → null', extractMortgagePositionFromLoanApplication(null) === null);
  expect('(m) doc without text → null', extractMortgagePositionFromLoanApplication({}) === null);
  expect('(n) empty text → null', extractMortgagePositionFromLoanApplication({ extracted_data: { text: '' } }) === null);
  expect('(o) text with no annotation pattern → null',
    extractMortgagePositionFromLoanApplication({ extracted_data: { text: 'Just plain text about mortgages.' } }) === null);
  expect('(p) doc.text fallback (no extracted_data wrapper)',
    extractMortgagePositionFromLoanApplication({ text: '[Page 1 annotation] Second Mortgage' }) === '2nd');

  // ─── R10-E-DERIVED-SIGNAL-MATRIX ───
  console.log('\n--- R10-E-DERIVED-SIGNAL-MATRIX ---');
  // balance > 0 → "2nd"
  expect('(a) balance > 0 → "2nd" with correct source',
    (() => {
      const r = inferMortgagePositionFromExistingBalance({
        existing_first_mortgage_balance: [{ value: 342000, source: 'credit_bureau' }],
      });
      return r?.value === '2nd' && r?.source === 'mortgage_position_inferred_from_existing_balance';
    })());
  expect('(b) balance = 0 → null',
    inferMortgagePositionFromExistingBalance({
      existing_first_mortgage_balance: [{ value: 0, source: 'credit_bureau' }],
    }) === null);
  expect('(c) balance = null → null',
    inferMortgagePositionFromExistingBalance({
      existing_first_mortgage_balance: [{ value: null, source: 'credit_bureau' }],
    }) === null);
  expect('(d) no tuples → null',
    inferMortgagePositionFromExistingBalance({ existing_first_mortgage_balance: [] }) === null);
  expect('(e) field absent → null',
    inferMortgagePositionFromExistingBalance({}) === null);
  expect('(f) canonicalMap null → null',
    inferMortgagePositionFromExistingBalance(null) === null);
  expect('(g) multiple tuples, one with non-zero → "2nd"',
    inferMortgagePositionFromExistingBalance({
      existing_first_mortgage_balance: [{ value: 0 }, { value: 342000 }],
    })?.value === '2nd');
  expect('(h) non-numeric value (NaN) → ignored by Number.isFinite',
    inferMortgagePositionFromExistingBalance({
      existing_first_mortgage_balance: [{ value: NaN }],
    }) === null);
  expect('(i) string value → ignored',
    inferMortgagePositionFromExistingBalance({
      existing_first_mortgage_balance: [{ value: '342000' }],
    }) === null);

  // ─── R10-E-CANONICAL-MAP-PUSH ───
  console.log('\n--- R10-E-CANONICAL-MAP-PUSH ---');
  // Synthetic: loan_application doc with annotation pushes loan_application classification
  const synth1 = cFields.extractCanonicalFields(
    '',
    [{ file_name: 'LoanApp.pdf', classification: 'loan_application', text: '[Page 1 annotation] Second Mortgage' }],
  );
  expect('(a) loan_application annotation push → loan_application classification tuple',
    synth1.mortgage_position.some(t => t.classification === 'loan_application' && t.value === '2nd'));
  // Synthetic: derived signal push when balance > 0
  const synth2 = cFields.extractCanonicalFields(
    '',
    [
      { file_name: 'CB.pdf', classification: 'credit_report', text: 'CIBC Mortgage Oct 2017 $390,000 $342,000' },
    ],
  );
  expect('(b) credit_report with non-zero balance → derived signal tuple pushed',
    synth2.mortgage_position.some(t => t.classification === 'mortgage_position_inferred_from_existing_balance' && t.value === '2nd'));
  // Source-string structural anchors
  expect('(c) extractMortgagePositionFromLoanApplication invoked in loan_application branch',
    /extractMortgagePositionFromLoanApplication\(doc\)/.test(_cfSrc));
  // R11-A (2026-05-27) REORDER: inferMortgagePositionFromExistingBalance now
  // invoked AFTER R10-G broker block (was: before). The reorder is load-bearing
  // for R11-A's refinance carve-out (carve-out reads canonical_map.transaction_
  // type which is populated by broker push) AND the canonical-map-level
  // broker_correction suppression check. R10-E's call-site existence invariant
  // is preserved; only the relative ordering changed.
  expect('(d) inferMortgagePositionFromExistingBalance invoked after R10-D AND after R10-G broker block (R11-A reorder)',
    (() => {
      const inferIdx = _cfSrc.indexOf('inferMortgagePositionFromExistingBalance(map)');
      const r10dIdx = _cfSrc.indexOf('inferProvinceFromAddressSignals(cityTuple');
      const brokerIdx = _cfSrc.indexOf('Array.isArray(opts.brokerCorrections)');
      return r10dIdx >= 0 && inferIdx > r10dIdx && inferIdx > brokerIdx;
    })());
  expect('(e) push uses mortgage_position_inferred_from_existing_balance classification',
    /classification: inferredMortgagePos\.source/.test(_cfSrc));
  expect('(f) module.exports includes extractMortgagePositionFromLoanApplication',
    /^\s+extractMortgagePositionFromLoanApplication,/m.test(_cfSrc));
  expect('(g) module.exports includes inferMortgagePositionFromExistingBalance',
    /^\s+inferMortgagePositionFromExistingBalance,/m.test(_cfSrc));
  expect('(h) email_subject_or_body push now includes classification metadata (filter uniformity)',
    /push\('mortgage_position', email\.mortgage_position, 'email_subject_or_body', \{ classification: 'email_subject_or_body' \}\)/.test(_cfSrc));

  // ─── R10-E-FILTER-MATRIX ───
  console.log('\n--- R10-E-FILTER-MATRIX ---');
  // broker_correction wins universally (R10-G precedent)
  const filterMap1 = {
    mortgage_position: [
      { value: '1st', source: 'email_subject_or_body', classification: 'email_subject_or_body' },
      { value: '2nd', source: 'LoanApp.pdf', classification: 'loan_application' },
      { value: '3rd', source: 'broker_correction', classification: 'broker_correction' },
    ],
  };
  const filtered1 = dEngine.filterCanonicalMortgagePositionForObjectiveAuthoritative(filterMap1);
  expect('(a) broker_correction wins universally',
    filtered1.mortgage_position.length === 1 && filtered1.mortgage_position[0].classification === 'broker_correction');

  // loan_application wins over derived + email_body (no broker_correction)
  const filterMap2 = {
    mortgage_position: [
      { value: '1st', source: 'email_subject_or_body', classification: 'email_subject_or_body' },
      { value: '2nd', source: 'LoanApp.pdf', classification: 'loan_application' },
      { value: '2nd', source: 'mortgage_position_inferred_from_existing_balance', classification: 'mortgage_position_inferred_from_existing_balance' },
    ],
  };
  const filtered2 = dEngine.filterCanonicalMortgagePositionForObjectiveAuthoritative(filterMap2);
  expect('(b) loan_application wins over derived + email_body',
    filtered2.mortgage_position.length === 1 && filtered2.mortgage_position[0].classification === 'loan_application');

  // derived wins over email_body (no loan_application)
  const filterMap3 = {
    mortgage_position: [
      { value: '1st', source: 'email_subject_or_body', classification: 'email_subject_or_body' },
      { value: '2nd', source: 'mortgage_position_inferred_from_existing_balance', classification: 'mortgage_position_inferred_from_existing_balance' },
    ],
  };
  const filtered3 = dEngine.filterCanonicalMortgagePositionForObjectiveAuthoritative(filterMap3);
  expect('(c) derived signal wins over email_body',
    filtered3.mortgage_position.length === 1 && filtered3.mortgage_position[0].classification === 'mortgage_position_inferred_from_existing_balance');

  // email_body only → preserved (fail-open)
  const filterMap4 = {
    mortgage_position: [
      { value: '1st', source: 'email_subject_or_body', classification: 'email_subject_or_body' },
    ],
  };
  const filtered4 = dEngine.filterCanonicalMortgagePositionForObjectiveAuthoritative(filterMap4);
  expect('(d) email_body only → preserved (fail-open)',
    filtered4.mortgage_position.length === 1 && filtered4.mortgage_position[0].classification === 'email_subject_or_body');

  // No tuples → unchanged
  const filtered5 = dEngine.filterCanonicalMortgagePositionForObjectiveAuthoritative({ mortgage_position: [] });
  expect('(e) no tuples → unchanged (empty)',
    filtered5.mortgage_position.length === 0);

  // null canonicalMap → returns null
  expect('(f) null canonicalMap → null',
    dEngine.filterCanonicalMortgagePositionForObjectiveAuthoritative(null) === null);

  // Filter composes correctly in webhook.js wire site
  expect('(g) filterCanonicalMortgagePositionForObjectiveAuthoritative composes in webhook.js wire site (outermost)',
    /filterCanonicalMortgagePositionForObjectiveAuthoritative\([\s\S]*?filterCanonicalPurposeForBrokerAuthoritative/.test(_whSrc));

  // Filter exported
  expect('(h) filterCanonicalMortgagePositionForObjectiveAuthoritative exported',
    /^\s+filterCanonicalMortgagePositionForObjectiveAuthoritative,/m.test(_deSrc));

  // ─── R10-E-PATRICIA-LOAD-BEARING + R10-E-PRODUCTION-FIXTURE-VERIFICATION ───
  console.log('\n--- R10-E-PATRICIA-LOAD-BEARING + R10-E-PRODUCTION-FIXTURE-VERIFICATION (live Supabase) ---');
  const PATRICIA = 'a0caddfb-92c4-4607-8ec1-72f54f9ebb31';
  const { data: msgs } = await supabase
    .from('messages')
    .select('body, subject, direction, created_at')
    .eq('deal_id', PATRICIA)
    .order('created_at', { ascending: true });
  const { data: docs } = await supabase
    .from('documents')
    .select('file_name, classification, extracted_data')
    .eq('deal_id', PATRICIA);
  const { data: deal } = await supabase
    .from('deals')
    .select('extracted_data')
    .eq('id', PATRICIA)
    .single();

  const inbounds = msgs.filter(m => m.direction === 'inbound');
  const docsForCanonical = docs.map(d => ({
    file_name: d.file_name,
    classification: d.classification,
    text: d.extracted_data?.text || '',
  }));
  const detect = dEngine.runDiscrepancyDetectionAggregated(
    inbounds,
    docsForCanonical,
    deal?.extracted_data?.borrower_name || null,
    { emailSubject: inbounds[0]?.subject || '' },
  );
  const rawMap = detect.canonical_map || {};
  const filteredMap = dEngine.filterCanonicalMortgagePositionForObjectiveAuthoritative(
    dEngine.filterCanonicalPurposeForBrokerAuthoritative(
      dEngine.filterCanonicalLoanAmountForDocAuthoritative(
        dEngine.filterCanonicalLenderForPayoutOnly(rawMap),
      ),
    ),
  );

  // Pre-filter: at least one of (loan_application doc-source, derived signal) tuple should be present
  expect('(a) PROD raw map: mortgage_position has loan_application OR derived-signal tuple',
    rawMap.mortgage_position.some(t => t.classification === 'loan_application' || t.classification === 'mortgage_position_inferred_from_existing_balance'),
    `tuples: ${JSON.stringify(rawMap.mortgage_position)}`);
  // Pre-filter: email_body tuple "1st" should be present (broker's incorrect statement)
  expect('(b) PROD raw map: email_body tuple ("1st") still present pre-filter',
    rawMap.mortgage_position.some(t => t.classification === 'email_subject_or_body' && t.value === '1st'));
  // Post-filter: email_body tuple stripped
  expect('(c) PROD post-filter: email_body tuple stripped',
    !filteredMap.mortgage_position.some(t => t.classification === 'email_subject_or_body'));
  // Post-filter: [0].value === "2nd"
  expect('(d) PROD post-filter: canonical_map.mortgage_position[0].value === "2nd"',
    filteredMap.mortgage_position[0]?.value === '2nd',
    `got: ${JSON.stringify(filteredMap.mortgage_position)}`);
  // Post-filter: source is loan_application OR derived (both acceptable)
  expect('(e) PROD post-filter: [0].classification is loan_application OR derived',
    ['loan_application', 'mortgage_position_inferred_from_existing_balance'].includes(filteredMap.mortgage_position[0]?.classification),
    `got classification: ${filteredMap.mortgage_position[0]?.classification}`);
  // existing_first_mortgage_balance preserved (R10-E doesn't touch this)
  expect('(f) PROD: existing_first_mortgage_balance preserved (R10-E doesn\'t modify)',
    rawMap.existing_first_mortgage_balance.length >= 1 && rawMap.existing_first_mortgage_balance[0].value === 342000);
  // Snapshot renderer would render "Mortgage Position: 2nd"
  const snapshotRow = dEngine.renderDealSnapshot(filteredMap, { ownershipType: 'personal', isCommercial: false });
  expect('(g) PROD: Snapshot renderer outputs "Mortgage Position:" with "2nd"',
    /Mortgage Position:\s*<\/strong>\s*2nd/.test(snapshotRow),
    `Snapshot HTML excerpt: ${snapshotRow.match(/Mortgage Position[\s\S]{0,80}/)?.[0]}`);
  // Other canonical fields preserved
  expect('(h) PROD: Patricia broker_name + property + other canonical fields preserved (no regression)',
    deal?.extracted_data?.borrower_name === 'Patricia Simmons');

  // ─── R10-E-CARVE-OUT-RESPECT ───
  console.log('\n--- R10-E-CARVE-OUT-RESPECT ---');
  // Clean 1st-mortgage deal with no existing balance: email_body wins (sole signal)
  const cleanFirst = cFields.extractCanonicalFields(
    '*Mortgage Position:* 1st',
    [], // no docs
  );
  const cleanFirstFiltered = dEngine.filterCanonicalMortgagePositionForObjectiveAuthoritative(cleanFirst);
  expect('(a) clean 1st-mortgage no docs no balance → email_body "1st" preserved',
    cleanFirstFiltered.mortgage_position[0]?.value === '1st'
    && cleanFirstFiltered.mortgage_position[0]?.classification === 'email_subject_or_body');
  // 1st-mortgage with consistent docs: doc wins, value matches
  const consistentFirst = cFields.extractCanonicalFields(
    '*Mortgage Position:* 1st',
    [{ file_name: 'LoanApp.pdf', classification: 'loan_application', text: '[Page 1 annotation] First Mortgage' }],
  );
  const consistentFirstFiltered = dEngine.filterCanonicalMortgagePositionForObjectiveAuthoritative(consistentFirst);
  expect('(b) consistent: 1st email + 1st doc → doc wins (value still "1st")',
    consistentFirstFiltered.mortgage_position[0]?.value === '1st'
    && consistentFirstFiltered.mortgage_position[0]?.classification === 'loan_application');
  // Patricia shape: email "1st" + balance > 0 → derived wins, value "2nd"
  const patriciaShape = cFields.extractCanonicalFields(
    '*Mortgage Position:* 1st',
    [{ file_name: 'CB.pdf', classification: 'credit_report', text: 'CIBC Mortgage Oct 2017 $390,000 $342,000' }],
  );
  const patriciaShapeFiltered = dEngine.filterCanonicalMortgagePositionForObjectiveAuthoritative(patriciaShape);
  expect('(c) Patricia synthetic shape: derived wins, value "2nd"',
    patriciaShapeFiltered.mortgage_position[0]?.value === '2nd'
    && patriciaShapeFiltered.mortgage_position[0]?.classification === 'mortgage_position_inferred_from_existing_balance');
  // 3rd-mortgage future-trigger documented (docblock; no code path yet)
  expect('(d) 3rd-mortgage future-trigger flagged in helper docblock',
    /3rd-mortgage case/.test(_cfSrc));
  // No false-positive when both signals absent
  const noSignal = cFields.extractCanonicalFields('Just a note', []);
  expect('(e) no email + no docs + no balance → mortgage_position empty (no false-positive)',
    !noSignal.mortgage_position || noSignal.mortgage_position.length === 0);

  // ─── R10-E-CROSS-CLUSTER-INTEGRATION ───
  console.log('\n--- R10-E-CROSS-CLUSTER-INTEGRATION ---');
  expect('(a) R6-γ filterCanonicalLenderForPayoutOnly preserved',
    typeof dEngine.filterCanonicalLenderForPayoutOnly === 'function');
  expect('(b) R6-α filterCanonicalLoanAmountForDocAuthoritative preserved',
    typeof dEngine.filterCanonicalLoanAmountForDocAuthoritative === 'function');
  expect('(c) R10-G filterCanonicalPurposeForBrokerAuthoritative preserved',
    typeof dEngine.filterCanonicalPurposeForBrokerAuthoritative === 'function');
  expect('(d) R10-G parseBrokerCorrections + parseBrokerInitialIntent preserved',
    typeof cFields.parseBrokerCorrections === 'function' && typeof cFields.parseBrokerInitialIntent === 'function');
  expect('(e) R10-D inferProvinceFromAddressSignals preserved',
    typeof cFields.inferProvinceFromAddressSignals === 'function');
  expect('(f) R10-B parseBrokerFirstName preserved',
    /parseBrokerFirstName/.test(fs.readFileSync(path.join(__dirname, '../src/services/ai.js'), 'utf8')));
  expect('(g) R10-A classifyIntakeBorrower preserved',
    /classifyIntakeBorrower/.test(_whSrc));
  expect('(h) R10-E filter composes with R6-γ + R6-α + R10-G in wire site',
    /filterCanonicalMortgagePositionForObjectiveAuthoritative[\s\S]*?filterCanonicalPurposeForBrokerAuthoritative[\s\S]*?filterCanonicalLoanAmountForDocAuthoritative[\s\S]*?filterCanonicalLenderForPayoutOnly/.test(_whSrc));
  // R11-A (2026-05-27) REORDER: R10-E derived signal call site moved AFTER
  // R10-G broker block (was: BEFORE). Refinance carve-out + broker_correction
  // suppression check require canonical_map.transaction_type + mortgage_
  // position broker_correction tuples populated by broker push.
  expect('(i) push ordering: R10-E derived signal AFTER R10-D province AND AFTER R10-G broker block (R11-A reorder)',
    (() => {
      const r10dIdx = _cfSrc.indexOf('inferProvinceFromAddressSignals(cityTuple');
      const r10eIdx = _cfSrc.indexOf('inferMortgagePositionFromExistingBalance(map)');
      const r10gBrokerIdx = _cfSrc.indexOf('Array.isArray(opts.brokerCorrections)');
      return r10dIdx >= 0 && r10eIdx > r10dIdx && r10eIdx > r10gBrokerIdx;
    })());
  expect('(j) module.exports of canonical-fields.js includes all R10-E helpers',
    /extractMortgagePositionFromLoanApplication/.test(_cfSrc)
    && /inferMortgagePositionFromExistingBalance/.test(_cfSrc));

  console.log(`\n========== R10-E mini-harness: ${passCount}/${passCount + failCount} PASS ==========`);
  if (failCount > 0) process.exit(1);
})().catch(e => {
  console.error('\nR10-E HARNESS FAILED:', e.stack || e.message);
  process.exit(1);
});
