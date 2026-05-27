// R11-C mini-harness — Bug 4 postal-code discrepancy renderer fix on
// Marcus Webb 8c404ae0. Closes Franco Round 7 retest Bug 4 via two
// mechanisms:
//   M1 — Strip inline postal suffix from Property Address row in
//        renderDealSnapshot (Property Address field becomes clean street
//        address only)
//   M2/M3 — JS-deterministic Risk Factors callout
//        (injectPostalCodeDiscrepancyCallout) wired at sendPreliminary-
//        ReviewToAdmin. Sibling to R10-C-2's injectElevatedLtvBandCallout
//        — 2nd instance of JS-INJECTED ADMIN RISK FACTORS CALLOUT
//        sub-pattern within 1st template family.
//
// EMPIRICALLY-CLOSE-LOOP DISCIPLINE (15th methodology carry-forward, R11-B)
// applied: Vienna's LLM-narrative did NOT flag postal-code in Risk Factors
// for Marcus's production prelim (LLM probabilistic). JS-deterministic
// callout guarantees admin visibility. MARCUS-LOAD-BEARING dual-anchor:
// BOTH clean Property Address row AND visible Risk Factors callout must
// pass for Franco's Bug 4 to empirically close.
//
// 6 verification groups (~30 anchors):
//  (1) R11-C-PROPERTY-ADDRESS-CLEANUP-MATRIX  — Property Address row
//                                                 clean across multi/single/no-postal
//  (2) R11-C-POSTAL-CALLOUT-COMPOSER-MATRIX   — injectPostalCodeDiscrepancyCallout
//                                                 truth table + idempotence
//  (3) R11-C-WIRING-AT-SENDPRELIM             — sendPreliminaryReviewToAdmin
//                                                 invokes callout when multi-postal
//  (4) R11-C-MARCUS-LOAD-BEARING (Stage 1.5)  — 5 critical end-to-end
//                                                 assertions per empirically-
//                                                 close-loop discipline
//  (5) R11-C-CROSS-CLUSTER-INTEGRATION        — R6-δ + R10-D + R10-C-2 +
//                                                 R10-E + R10-G + R10-F +
//                                                 R10-H + R11-A + R11-B
//                                                 all preserved
//  (6) R11-C-DEFERRED-RESIDUAL-FLAGGING       — docblock pins for design-
//                                                 intent change + sub-pattern
//                                                 lineage + broker-facing
//                                                 surface unchanged

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

const ai = require('../src/services/ai');
const dE = require('../src/services/discrepancy-engine');
const cf = require('../src/services/canonical-fields');

(async () => {
  console.log('========== R11-C mini-harness — Bug 4 postal-code renderer fix ==========');

  const _aiSrc = fs.readFileSync(path.join(__dirname, '../src/services/ai.js'), 'utf8');
  const _deSrc = fs.readFileSync(path.join(__dirname, '../src/services/discrepancy-engine.js'), 'utf8');
  const _whSrc = fs.readFileSync(path.join(__dirname, '../src/routes/webhook.js'), 'utf8');

  let passCount = 0;
  let failCount = 0;
  const expect = (label, cond, detail) => {
    if (cond) { console.log(`  PASS ${label}`); passCount++; }
    else { console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); failCount++; throw new Error(`FAIL [${label}]${detail ? ' — ' + detail : ''}`); }
  };

  // ─── R11-C-PROPERTY-ADDRESS-CLEANUP-MATRIX (M1) ───
  console.log('\n--- R11-C-PROPERTY-ADDRESS-CLEANUP-MATRIX (M1) ---');
  // Multi-postal: Property Address row contains ONLY clean street address (no suffix)
  const multiPostalMap = {
    subject_property_address: [{ value: '1142 tory road nw', source: 'email_body' }],
    subject_property_postal_code: [
      { value: 'T6R3K2', source: 'email_body' },
      { value: 'T6R3K2', source: 'Appraisal.pdf' },
      { value: 'T6R0S4', source: 'RBC_Payout_Statement.pdf' },
    ],
  };
  const snap1 = dE.renderDealSnapshot(multiPostalMap, { ownershipType: 'personal' });
  expect('(a) multi-postal → Property Address row contains ONLY clean street address',
    /<p>\s*<strong>\s*Property Address:\s*<\/strong>\s*1142 tory road nw\s*<\/p>/i.test(snap1));
  expect('(b) multi-postal → NO "postal codes differ" inline suffix in Property Address row',
    !/Property Address[\s\S]{0,200}postal codes differ/i.test(snap1));
  expect('(c) multi-postal → NO " — " separator + postal labels in Property Address row',
    !/<p>\s*<strong>\s*Property Address[\s\S]{0,200}—[\s\S]{0,200}T6R0S4/i.test(snap1));
  // Single-postal: Property Address row unchanged (R6-δ legacy preserved)
  const singlePostalMap = {
    subject_property_address: [{ value: '123 main st', source: 'email_body' }],
    subject_property_postal_code: [{ value: 'M5V3X1', source: 'email_body' }],
  };
  const snap2 = dE.renderDealSnapshot(singlePostalMap, { ownershipType: 'personal' });
  expect('(d) single-postal → Property Address row = clean street address (R6-δ legacy preserved)',
    /<p>\s*<strong>\s*Property Address:\s*<\/strong>\s*123 main st\s*<\/p>/i.test(snap2));
  // No-postal: Property Address row unchanged
  const noPostalMap = {
    subject_property_address: [{ value: '456 oak ave', source: 'email_body' }],
    subject_property_postal_code: [],
  };
  const snap3 = dE.renderDealSnapshot(noPostalMap, { ownershipType: 'personal' });
  expect('(e) no-postal → Property Address row preserved (TBD fallback path)',
    /<p>\s*<strong>\s*Property Address:\s*<\/strong>\s*456 oak ave\s*<\/p>/i.test(snap3));

  // ─── R11-C-POSTAL-CALLOUT-COMPOSER-MATRIX (M2) ───
  console.log('\n--- R11-C-POSTAL-CALLOUT-COMPOSER-MATRIX (M2) ---');
  expect('(a) injectPostalCodeDiscrepancyCallout function exported on ai module',
    typeof ai.injectPostalCodeDiscrepancyCallout === 'function');
  // Multi-postal → callout injected with both values + source labels
  const sampleSnapshotHtml = '<h2>Deal Snapshot</h2><p>Property: X</p><h2>Risk Factors</h2><p>blah</p>';
  const multiPostalTuples = [
    { value: 'T6R3K2', source: 'email_body' },
    { value: 'T6R3K2', source: 'Appraisal_1142_Tory_Road_NW_Edmonton.pdf' },
    { value: 'T6R0S4', source: 'RBC_Payout_Statement_Marcus_Webb.pdf' },
  ];
  const withCallout = ai.injectPostalCodeDiscrepancyCallout(sampleSnapshotHtml, multiPostalTuples);
  expect('(b) multi-postal → callout injected with marker pattern',
    /<p[^>]*data-marker="R11-C-POSTAL-CODE-DISCREPANCY-CALLOUT"[^>]*>/.test(withCallout));
  expect('(c) callout includes Postal Code Discrepancy label + both values',
    /Postal Code Discrepancy[\s\S]{0,200}T6R3K2[\s\S]{0,200}T6R0S4/i.test(withCallout));
  expect('(d) callout source labels formatted correctly (no .pdf suffix; no underscores)',
    /per email body, Appraisal 1142 Tory Road NW Edmonton/i.test(withCallout)
      && /per RBC Payout Statement Marcus Webb/i.test(withCallout)
      && !/Appraisal_1142_Tory_Road_NW_Edmonton/.test(withCallout));
  // Single-postal → no callout (passthrough)
  const singleTuple = ai.injectPostalCodeDiscrepancyCallout(sampleSnapshotHtml, [{ value: 'T6R3K2', source: 'email_body' }]);
  expect('(e) single-postal → no callout injected (passthrough)',
    singleTuple === sampleSnapshotHtml);
  // Empty tuples → no callout
  const emptyTuples = ai.injectPostalCodeDiscrepancyCallout(sampleSnapshotHtml, []);
  expect('(f) empty tuples → no callout injected (passthrough)',
    emptyTuples === sampleSnapshotHtml);
  // Idempotence — re-injecting yields single callout
  const idempotent = ai.injectPostalCodeDiscrepancyCallout(withCallout, multiPostalTuples);
  expect('(g) idempotent: re-injecting yields single callout marker',
    (idempotent.match(/R11-C-POSTAL-CODE-DISCREPANCY-CALLOUT/g) || []).length === 1);
  // Inserted after Deal Snapshot block, before Risk Factors (reading order)
  expect('(h) callout inserted AFTER Deal Snapshot, BEFORE Risk Factors (reading order)',
    (() => {
      const snapIdx = withCallout.indexOf('<h2>Deal Snapshot</h2>');
      const calloutIdx = withCallout.indexOf('R11-C-POSTAL-CODE-DISCREPANCY-CALLOUT');
      const rfIdx = withCallout.indexOf('<h2>Risk Factors</h2>');
      return snapIdx >= 0 && calloutIdx > snapIdx && rfIdx > calloutIdx;
    })());

  // ─── R11-C-WIRING-AT-SENDPRELIM (M3) ───
  console.log('\n--- R11-C-WIRING-AT-SENDPRELIM (M3) ---');
  expect('(a) sendPreliminaryReviewToAdmin contains R11-C postal callout wiring',
    /R11-C[\s\S]{0,400}postal-code discrepancy callout/i.test(_whSrc));
  expect('(b) wiring reads postal tuples from filtered canonical_map',
    /_bFilteredCanonicalMap\.subject_property_postal_code/.test(_whSrc));
  expect('(c) wiring gates on multi-value (Set distinct count > 1)',
    /_r11cDistinctPostals\.size\s*>\s*1/.test(_whSrc));
  expect('(d) wiring invokes aiService.injectPostalCodeDiscrepancyCallout',
    /aiService\.injectPostalCodeDiscrepancyCallout\(leadSummary,\s*_r11cPostalTuples\)/.test(_whSrc));
  expect('(e) wiring placed after R10-C-2 elevated-band callout (sibling pattern reading order)',
    (() => {
      const r10cIdx = _whSrc.indexOf('R10-C-2: elevated LTV band');
      const r11cIdx = _whSrc.indexOf('R11-C: postal-code discrepancy');
      return r10cIdx > 0 && r11cIdx > 0 && r11cIdx > r10cIdx;
    })());

  // ─── R11-C-MARCUS-LOAD-BEARING (Stage 1.5 live-Supabase) ───
  // 5 critical end-to-end assertions per empirically-close-loop discipline.
  // Franco's Bug 4 closes only if BOTH clean Property Address AND visible
  // Risk Factors callout pass.
  console.log('\n--- R11-C-MARCUS-LOAD-BEARING (Stage 1.5 — 5 critical empirically-close-loop assertions) ---');
  const MARCUS_DEAL = '8c404ae0-f50e-4b31-aada-eda4c1f43045';
  try {
    const { data: msgs } = await supabase.from('messages').select('direction, subject, body').eq('deal_id', MARCUS_DEAL).order('created_at', { ascending: true });
    const { data: docs } = await supabase.from('documents').select('file_name, classification, extracted_data').eq('deal_id', MARCUS_DEAL);
    const docsForExtract = docs.map(d => ({ file_name: d.file_name, classification: d.classification, text: d.extracted_data?.text || '', extracted_data: d.extracted_data }));
    const inbounds = msgs.filter(m => m.direction === 'inbound');
    const detect = dE.runDiscrepancyDetectionAggregated(inbounds, docsForExtract, 'Jonathan Ferrara', { emailSubject: inbounds[0]?.subject || '' });
    const fullyFiltered = dE.filterCanonicalMortgagePositionForObjectiveAuthoritative(
      dE.filterCanonicalPurposeForBrokerAuthoritative(
        dE.filterCanonicalLoanAmountForDocAuthoritative(
          dE.filterCanonicalLenderForPayoutOnly(detect.canonical_map)
        )
      )
    );
    // #1 — Marcus canonical_map has 3 postal tuples with 2 distinct values
    const postalTuples = fullyFiltered.subject_property_postal_code || [];
    const distinctVals = new Set(postalTuples.map(t => t.value));
    expect('(1) Marcus canonical_map: 3 postal tuples with 2 distinct values (T6R3K2 + T6R0S4)',
      postalTuples.length === 3 && distinctVals.size === 2 && distinctVals.has('T6R3K2') && distinctVals.has('T6R0S4'));
    // #2 — renderDealSnapshot Property Address row is clean
    const snap = dE.renderDealSnapshot(fullyFiltered, { ownershipType: 'personal' });
    expect('(2) [empirically-close-loop #2] Marcus renderDealSnapshot Property Address row: clean "1142 tory road nw" (no postal suffix)',
      /<p>\s*<strong>\s*Property Address:\s*<\/strong>\s*1142 tory road nw\s*<\/p>/i.test(snap));
    expect('(2b) Marcus renderDealSnapshot Property Address row: NO "postal codes differ" text anywhere in Property Address line',
      !/Property Address[\s\S]{0,200}postal codes differ/i.test(snap));
    // #3 — injectPostalCodeDiscrepancyCallout fires + produces callout with both values
    const withCalloutMarcus = ai.injectPostalCodeDiscrepancyCallout(snap, postalTuples);
    expect('(3) [empirically-close-loop #3] Marcus prelim post-callout-inject: postal-code Risk Factors callout PRESENT with both values',
      /R11-C-POSTAL-CODE-DISCREPANCY-CALLOUT[\s\S]{0,300}T6R3K2[\s\S]{0,200}T6R0S4/.test(withCalloutMarcus));
    // #4 — Source labels: "email body, Appraisal..." + "RBC Payout Statement..."
    expect('(4) Marcus callout source labels properly formatted (email_body → "email body"; PDF suffix stripped; underscores → spaces)',
      /per email body[\s\S]{0,300}per RBC Payout Statement Marcus Webb/i.test(withCalloutMarcus));
    // #5 — Full prelim composition: BOTH clean Property Address AND visible callout (load-bearing dual-anchor)
    expect('(5) [empirically-close-loop LOAD-BEARING DUAL-ANCHOR] Marcus full prelim composition: clean Property Address AND visible Risk Factors callout',
      /<p>\s*<strong>\s*Property Address:\s*<\/strong>\s*1142 tory road nw\s*<\/p>/i.test(withCalloutMarcus)
        && /R11-C-POSTAL-CODE-DISCREPANCY-CALLOUT/.test(withCalloutMarcus));
  } catch (e) {
    console.log(`  SKIP (Marcus load-bearing) — ${e.message}`);
  }

  // ─── R11-C-CROSS-CLUSTER-INTEGRATION ───
  console.log('\n--- R11-C-CROSS-CLUSTER-INTEGRATION ---');
  expect('(a) R6-δ province inference (deriveCityProvince) preserved',
    typeof dE.deriveCityProvince === 'function');
  expect('(b) R10-D province inference helper (inferProvinceFromAddressSignals) preserved',
    typeof cf.inferProvinceFromAddressSignals === 'function');
  expect('(c) R10-C-2 elevated-LTV-band callout helper preserved',
    typeof ai.injectElevatedLtvBandCallout === 'function');
  expect('(d) R10-E mortgage_position OBJECTIVE-field filter preserved',
    typeof dE.filterCanonicalMortgagePositionForObjectiveAuthoritative === 'function');
  expect('(e) R10-G broker_initial_intent + parseBrokerCorrections preserved',
    typeof cf.parseBrokerInitialIntent === 'function' && typeof cf.parseBrokerCorrections === 'function');
  expect('(f) R10-F discrepancyHold gate at computeCompletionDispatch preserved',
    /const\s+computeCompletionDispatch\s*=\s*\(\{[\s\S]{0,200}discrepancyHold\s*\}\)/.test(_whSrc));
  expect('(g) R10-H sweepBrokerFacingDraft preserved at admin-handoff',
    /const\s+sweepBrokerFacingDraft\s*=\s*\(html\)\s*=>/.test(_whSrc));
  expect('(h) R11-A transaction_type + refinance carve-out preserved',
    typeof cf.inferMortgagePositionFromExistingBalance === 'function');
  expect('(i) R11-B sanitizeLoanAppDocTextForLLM + filter extension preserved',
    typeof cf.sanitizeLoanAppDocTextForLLM === 'function');
  // Broker-facing surface untouched: FIELD_DISPLAY_NAMES.subject_property_postal_code preserved
  expect('(j) Broker-facing discrepancy section infrastructure preserved (renderDiscrepancyBullet + FIELD_DISPLAY_NAMES untouched)',
    typeof dE.renderDiscrepancyBullet === 'function'
      && /subject_property_postal_code:\s*['"]the postal code['"]/i.test(_deSrc));
  // Snapshot still renders Combined LTV row + other Snapshot rows (no unrelated regression)
  const fullCanonicalMap = {
    subject_property_address: [{ value: '1 main st', source: 'email_body' }],
    subject_property_postal_code: [{ value: 'A1A1A1', source: 'email_body' }],
    subject_property_market_value: [{ value: 500000, source: 'appraisal' }],
    requested_loan_amount: [{ value: 100000, source: 'broker_initial_intent', classification: 'broker_initial_intent' }],
    existing_first_mortgage_balance: [{ value: 200000, source: 'mortgage_statement', classification: 'mortgage_statement' }],
    existing_first_mortgage_lender: [{ value: 'TD', source: 'mortgage_statement', classification: 'mortgage_statement' }],
    mortgage_position: [{ value: '2nd', source: 'loan_application' }],
    transaction_type: [],
    purpose: [],
    requested_loan_term_months: [{ value: 12, source: 'email_body' }],
  };
  const fullSnap = dE.renderDealSnapshot(fullCanonicalMap, { ownershipType: 'personal' });
  expect('(k) renderDealSnapshot still renders other rows correctly (Combined LTV / Mortgage Position / etc.)',
    /Combined LTV/.test(fullSnap)
      && /Mortgage Position/.test(fullSnap)
      && /Appraised Value/.test(fullSnap));

  // ─── R11-C-DEFERRED-RESIDUAL-FLAGGING ───
  console.log('\n--- R11-C-DEFERRED-RESIDUAL-FLAGGING ---');
  expect('(a) renderDealSnapshot docblock cites R11-C design-intent change (inline → Risk Factors callout)',
    /R11-C[\s\S]{0,400}DESIGN INTENT CHANGE[\s\S]{0,400}Franco Round 7 retest Bug 4/i.test(_deSrc));
  expect('(b) renderDealSnapshot docblock cites Marcus empirical anchor (8c404ae0)',
    /R11-C[\s\S]{0,1200}Marcus Webb[\s\S]{0,80}8c404ae0/i.test(_deSrc));
  expect('(c) injectPostalCodeDiscrepancyCallout docblock cites R10-C-2 sibling pattern',
    /SIBLING to R10-C-2[\s\S]{0,300}injectElevatedLtvBandCallout/i.test(_aiSrc));
  expect('(d) injectPostalCodeDiscrepancyCallout docblock cites JS-INJECTED ADMIN RISK FACTORS CALLOUT sub-pattern lineage',
    /JS-INJECTED ADMIN RISK[\s\S]{0,80}FACTORS CALLOUT pattern lineage[\s\S]{0,400}R10-C-2[\s\S]{0,200}R11-C/i.test(_aiSrc));
  expect('(e) injectPostalCodeDiscrepancyCallout docblock cites empirically-close-loop discipline + R8-B justification',
    /EMPIRICALLY-CLOSE-LOOP DISCIPLINE[\s\S]{0,400}Vienna's LLM[\s\S]{0,300}did NOT cite the postal-code/i.test(_aiSrc));
  expect('(f) injectPostalCodeDiscrepancyCallout docblock cites broker-facing surface unchanged',
    /BROKER-FACING SURFACE UNCHANGED[\s\S]{0,400}renderDiscrepancyBullet/i.test(_aiSrc));
  expect('(g) injectPostalCodeDiscrepancyCallout docblock cites 3+-instance promotion gate',
    /Promotion to its own sub-pattern[\s\S]{0,200}3\+ instances/i.test(_aiSrc));

  console.log('\n========== R11-C mini-harness complete ==========');
  console.log(`PASS: ${passCount} | FAIL: ${failCount}`);
  if (failCount > 0) process.exit(1);
})().catch(e => { console.error('\nHARNESS ERROR:', e.stack || e.message); process.exit(1); });
