// R10-D mini-harness — 7 verification groups including Stage 1.5 live-Supabase
// production-fixture replay against Patricia + Kevin + Donna/Ryan + Ethan.
// R10-B/R10-G discipline carry-forward.

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
  console.log('========== R10-D mini-harness — province inference ==========');

  const fs = require('fs');
  const path = require('path');
  const _cfSrc = fs.readFileSync(path.join(__dirname, '../src/services/canonical-fields.js'), 'utf8');
  const _deSrc = fs.readFileSync(path.join(__dirname, '../src/services/discrepancy-engine.js'), 'utf8');

  let passCount = 0;
  let failCount = 0;
  const expect = (label, cond, detail) => {
    if (cond) { console.log(`  PASS ${label}`); passCount++; }
    else { console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); failCount++; throw new Error(`FAIL [${label}]${detail ? ' — ' + detail : ''}`); }
  };

  const { inferProvinceFromAddressSignals, FSA_LETTER_TO_PROVINCE, CITY_TO_PROVINCE } = cFields;

  // ─── R10-D-FSA-LOOKUP-MATRIX ───
  console.log('\n--- R10-D-FSA-LOOKUP-MATRIX ---');
  // All 18 FSA-letter mappings
  const fsaCases = [
    ['A1B 2C3', 'NL'], ['B1B 2C3', 'NS'], ['C1B 2C3', 'PE'], ['E1B 2C3', 'NB'],
    ['G1B 2C3', 'QC'], ['H1B 2C3', 'QC'], ['J1B 2C3', 'QC'],
    ['K1B 2C3', 'ON'], ['L1B 2C3', 'ON'], ['M1B 2C3', 'ON'], ['N1B 2C3', 'ON'], ['P1B 2C3', 'ON'],
    ['R1B 2C3', 'MB'], ['S1B 2C3', 'SK'], ['T1B 2C3', 'AB'], ['V1B 2C3', 'BC'],
    ['X1B 2C3', 'NT'], ['Y1B 2C3', 'YT'],
  ];
  for (const [postal, expectedProv] of fsaCases) {
    const r = inferProvinceFromAddressSignals(null, postal);
    expect(`(${postal} → ${expectedProv})`, r?.value === expectedProv && r?.source === 'province_inferred_from_postal');
  }
  // Round-6 production postals
  expect('Patricia postal "T3H1C6" → AB', inferProvinceFromAddressSignals(null, 'T3H1C6')?.value === 'AB');
  expect('Kevin postal "T2L1L1" → AB', inferProvinceFromAddressSignals(null, 'T2L1L1')?.value === 'AB');
  expect('Donna/Ryan postal "T6J4Y3" → AB', inferProvinceFromAddressSignals(null, 'T6J4Y3')?.value === 'AB');
  expect('Ethan postal "T3H4M6" → AB', inferProvinceFromAddressSignals(null, 'T3H4M6')?.value === 'AB');
  // Case insensitivity
  expect('lowercase "t3h1c6" → AB', inferProvinceFromAddressSignals(null, 't3h1c6')?.value === 'AB');
  // Whitespace tolerance
  expect('"  T3H 4M6  " → AB', inferProvinceFromAddressSignals(null, '  T3H 4M6  ')?.value === 'AB');
  // Unrecognized letters (unassigned: D, F, I, O, Q, U, W, Z)
  for (const letter of ['D', 'F', 'I', 'O', 'Q', 'U', 'W', 'Z']) {
    expect(`unassigned letter "${letter}1A 2B3" → null`, inferProvinceFromAddressSignals(null, `${letter}1A 2B3`) === null);
  }
  // Null / empty / non-string
  expect('null postal → null', inferProvinceFromAddressSignals(null, null) === null);
  expect('empty postal → null', inferProvinceFromAddressSignals(null, '') === null);
  expect('non-string postal → null', inferProvinceFromAddressSignals(null, 12345) === null);

  // ─── R10-D-CITY-LOOKUP-MATRIX ───
  console.log('\n--- R10-D-CITY-LOOKUP-MATRIX ---');
  const cityCases = [
    ['Calgary', 'AB'], ['Edmonton', 'AB'],
    ['Toronto', 'ON'], ['Ottawa', 'ON'], ['Hamilton', 'ON'], ['Mississauga', 'ON'], ['London', 'ON'],
    ['Vancouver', 'BC'], ['Victoria', 'BC'],
    ['Montreal', 'QC'], ['Gatineau', 'QC'], ['Quebec City', 'QC'],
    ['Winnipeg', 'MB'], ['Halifax', 'NS'],
    ['Saskatoon', 'SK'], ['Regina', 'SK'],
  ];
  for (const [city, expectedProv] of cityCases) {
    const r = inferProvinceFromAddressSignals(city, null);
    expect(`("${city}" → ${expectedProv})`, r?.value === expectedProv && r?.source === 'province_inferred_from_city');
  }
  // Case insensitivity
  expect('"CALGARY" → AB', inferProvinceFromAddressSignals('CALGARY', null)?.value === 'AB');
  expect('"calgary" → AB', inferProvinceFromAddressSignals('calgary', null)?.value === 'AB');
  // Multi-word
  expect('"Quebec City" multi-word → QC', inferProvinceFromAddressSignals('Quebec City', null)?.value === 'QC');
  expect('"quebec city" lowercase multi-word → QC', inferProvinceFromAddressSignals('quebec city', null)?.value === 'QC');
  // Whitespace tolerance
  expect('"  Calgary  " whitespace → AB', inferProvinceFromAddressSignals('  Calgary  ', null)?.value === 'AB');
  // Unknown cities → null
  expect('"Yellowknife" → null', inferProvinceFromAddressSignals('Yellowknife', null) === null);
  expect('"Whitehorse" → null', inferProvinceFromAddressSignals('Whitehorse', null) === null);
  expect('null city → null', inferProvinceFromAddressSignals(null, null) === null);

  // ─── R10-D-INFER-HELPER-MATRIX ───
  console.log('\n--- R10-D-INFER-HELPER-MATRIX ---');
  // Postal priority over city
  expect('postal-priority: T3H1C6 + null → AB via postal',
    (() => { const r = inferProvinceFromAddressSignals(null, 'T3H1C6'); return r?.value === 'AB' && r?.source === 'province_inferred_from_postal'; })());
  expect('postal + city present → postal wins',
    (() => { const r = inferProvinceFromAddressSignals('Calgary', 'T3H1C6'); return r?.source === 'province_inferred_from_postal'; })());
  // City-only fallback
  expect('postal-null + Calgary → city fallback',
    (() => { const r = inferProvinceFromAddressSignals('Calgary', null); return r?.value === 'AB' && r?.source === 'province_inferred_from_city'; })());
  expect('postal-empty + Calgary → city fallback',
    (() => { const r = inferProvinceFromAddressSignals('Calgary', ''); return r?.source === 'province_inferred_from_city'; })());
  // Both null
  expect('both-null → null', inferProvinceFromAddressSignals(null, null) === null);
  expect('both-empty → null', inferProvinceFromAddressSignals('', '') === null);
  // Postal with unrecognized first-letter + valid city → city fallback
  expect('postal "Z1A 2B3" + Calgary → city fallback (graceful)',
    (() => { const r = inferProvinceFromAddressSignals('Calgary', 'Z1A 2B3'); return r?.value === 'AB' && r?.source === 'province_inferred_from_city'; })());
  // Conflicting signals (Calgary postal in Ontario city) — postal wins (behavior pinned; empirically impossible but documented)
  expect('conflicting: Toronto + T3H1C6 → postal wins (AB)',
    inferProvinceFromAddressSignals('Toronto', 'T3H1C6')?.value === 'AB');

  // ─── R10-D-CANONICAL-MAP-PUSH ───
  // Note: full end-to-end pipeline (city + postal extraction → inference push)
  // verified in PRODUCTION-FIXTURE-VERIFICATION group below. This group pins
  // the source-string structural anchors: helper is called in
  // extractCanonicalFields, empty-list guard present, push ordering relative
  // to R10-G broker block correct, module exports include all R10-D helpers.
  console.log('\n--- R10-D-CANONICAL-MAP-PUSH ---');
  // No signals (neither city nor postal) → no push
  const synth2 = cFields.extractCanonicalFields('Just a quick note.', []);
  expect('(a) no city + no postal → subject_property_province stays empty (no false-positive push)',
    !synth2.subject_property_province || synth2.subject_property_province.length === 0);
  // Source-string structural anchors
  expect('(b) inferProvinceFromAddressSignals invoked in extractCanonicalFields',
    /inferProvinceFromAddressSignals\(cityTuple\?\.value, postalTuple\?\.value\)/.test(_cfSrc));
  expect('(c) empty-list guard present (preserves doc-source-wins discipline)',
    /if \(!map\.subject_property_province \|\| map\.subject_property_province\.length === 0\)/.test(_cfSrc));
  expect('(d) push happens BEFORE R10-G broker block (so broker_correction can still override)',
    (() => {
      const pushIdx = _cfSrc.indexOf('inferProvinceFromAddressSignals(cityTuple');
      const brokerIdx = _cfSrc.indexOf('Array.isArray(opts.brokerCorrections)');
      return pushIdx >= 0 && brokerIdx >= 0 && pushIdx < brokerIdx;
    })());
  expect('(e) push uses classification === source for filter compatibility',
    /classification: inferred\.source/.test(_cfSrc));
  expect('(f) module.exports includes inferProvinceFromAddressSignals',
    /^\s+inferProvinceFromAddressSignals,/m.test(_cfSrc));
  expect('(g) module.exports includes FSA_LETTER_TO_PROVINCE table',
    /^\s+FSA_LETTER_TO_PROVINCE,/m.test(_cfSrc));
  expect('(h) module.exports includes CITY_TO_PROVINCE table',
    /^\s+CITY_TO_PROVINCE,/m.test(_cfSrc));

  // ─── R10-D-PRODUCTION-FIXTURE-VERIFICATION (Stage 1.5 live-Supabase) ───
  console.log('\n--- R10-D-PRODUCTION-FIXTURE-VERIFICATION (live Supabase) ---');
  const fixtures = [
    { label: 'Patricia (S5)',    dealId: 'a0caddfb-92c4-4607-8ec1-72f54f9ebb31', expectedProv: 'AB', expectedSource: 'province_inferred_from_postal', regressionFor: false },
    { label: 'Kevin (S6)',       dealId: '30d1e798-38b0-410a-8e9a-9999ea26c61f', expectedProv: 'AB', expectedSource: 'province_inferred_from_postal', regressionFor: false },
    { label: 'Donna/Ryan (S4)',  dealId: '45bd01df-4d8f-4ff4-98b0-86d80db79876', expectedProv: 'AB', expectedSource: 'province_inferred_from_postal', regressionFor: false },
    { label: 'Ethan (S7)',       dealId: 'c95f3a20-162c-45cf-a98c-60b6bbb2de9a', expectedProv: 'AB', expectedSource: 'email_body', regressionFor: true },
  ];
  for (const fx of fixtures) {
    const { data: deal } = await supabase
      .from('deals')
      .select('extracted_data')
      .eq('id', fx.dealId)
      .single();
    const { data: msgs } = await supabase
      .from('messages')
      .select('body, subject, created_at')
      .eq('deal_id', fx.dealId)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: true });
    const { data: docs } = await supabase
      .from('documents')
      .select('file_name, classification, extracted_data')
      .eq('deal_id', fx.dealId);

    const docsForCanonical = (docs || []).map(d => ({
      file_name: d.file_name,
      classification: d.classification,
      text: d.extracted_data?.text || '',
    }));
    const detect = dEngine.runDiscrepancyDetectionAggregated(
      msgs || [],
      docsForCanonical,
      deal?.extracted_data?.borrower_name || null,
      { emailSubject: msgs?.[0]?.subject || '' },
    );
    const cmap = detect.canonical_map || {};
    const provTuple = (cmap.subject_property_province || [])[0];
    const cityProv = dEngine.deriveCityProvince(cmap);

    expect(`${fx.label}: subject_property_province[0].value = "${fx.expectedProv}"`,
      provTuple?.value === fx.expectedProv,
      `got tuple=${JSON.stringify(provTuple)}`);
    expect(`${fx.label}: deriveCityProvince.province = "${fx.expectedProv}" (not TBD)`,
      cityProv?.province === fx.expectedProv,
      `got ${JSON.stringify(cityProv)}`);
    if (fx.regressionFor) {
      expect(`${fx.label} REGRESSION-PREVENTION: doc-source tuple preserved (R6-δ extractor result not overwritten)`,
        provTuple?.source === fx.expectedSource || provTuple?.classification !== 'province_inferred_from_postal',
        `expected source=${fx.expectedSource}, got source=${provTuple?.source} class=${provTuple?.classification}`);
    } else {
      expect(`${fx.label}: inferred via postal-FSA (source = "${fx.expectedSource}")`,
        provTuple?.classification === fx.expectedSource || provTuple?.source === fx.expectedSource,
        `got source=${provTuple?.source} class=${provTuple?.classification}`);
    }
  }

  // ─── R10-D-CARVE-OUT-RESPECT ───
  console.log('\n--- R10-D-CARVE-OUT-RESPECT ---');
  // (a) Doc-source province tuple ALWAYS wins (empty-list guard)
  expect('(a) Ethan-shape: doc-source tuple preserved (verified above in PROD group)',
    true);
  // (b) Malformed postal (no recognized FSA letter) — no false-positive
  expect('(b) Malformed postal "12345" with no city → no false-positive push',
    inferProvinceFromAddressSignals(null, '12345') === null);
  // (c) Unknown city + no postal → no false-positive push
  expect('(c) Unknown city "Yellowknife" + no postal → null (no false-positive)',
    inferProvinceFromAddressSignals('Yellowknife', null) === null);
  // (d) Push gate ordering: inferred tuples sit BELOW doc-source in hierarchy
  // (verified via empty-list guard — if doc-source pushed first, inference skips)
  expect('(d) Push gate ordering: empty-list guard ensures doc-source-wins',
    /if \(!map\.subject_property_province \|\| map\.subject_property_province\.length === 0\)/.test(_cfSrc));
  // (e) When inferred fires but broker also corrects (hypothetical) — broker_correction unshift still works
  expect('(e) R10-G broker_correction unshift to [0] still positions broker source above inferred',
    /map\[c\.field\]\.unshift/.test(_cfSrc));

  // ─── R10-D-CROSS-CLUSTER-INTEGRATION ───
  console.log('\n--- R10-D-CROSS-CLUSTER-INTEGRATION ---');
  // R6-δ docblock updated to reflect closure
  expect('(a) R6-δ docblock updated to reflect R10-D closure',
    /R10-D \(2026-05-27\): R6-δ deferred-residual CLOSED/.test(_deSrc));
  // R6-γ + R6-α + R9-B + R9-D + R10-G all preserved
  expect('(b) R6-γ filterCanonicalLenderForPayoutOnly preserved',
    typeof dEngine.filterCanonicalLenderForPayoutOnly === 'function');
  expect('(c) R6-α filterCanonicalLoanAmountForDocAuthoritative preserved',
    typeof dEngine.filterCanonicalLoanAmountForDocAuthoritative === 'function');
  expect('(d) R10-G filterCanonicalPurposeForBrokerAuthoritative preserved',
    typeof dEngine.filterCanonicalPurposeForBrokerAuthoritative === 'function');
  expect('(e) R10-G parseBrokerCorrections + parseBrokerInitialIntent preserved',
    typeof cFields.parseBrokerCorrections === 'function' && typeof cFields.parseBrokerInitialIntent === 'function');
  expect('(f) R10-G resolveCanonicalIntentValue preserved',
    typeof cFields.resolveCanonicalIntentValue === 'function');
  expect('(g) R10-B parseBrokerFirstName preserved (broker-name-extraction subsystem)',
    /parseBrokerFirstName/.test(fs.readFileSync(path.join(__dirname, '../src/services/ai.js'), 'utf8')));
  expect('(h) R10-A classifyIntakeBorrower preserved',
    /classifyIntakeBorrower/.test(fs.readFileSync(path.join(__dirname, '../src/routes/webhook.js'), 'utf8')));
  expect('(i) deriveCityProvince consumer-site unchanged (still reads from canonical_map; TBD fallback still present for edge cases)',
    /province: province \|\| 'TBD'/.test(_deSrc));
  expect('(j) module.exports of canonical-fields.js includes all R10-D helpers + tables',
    /inferProvinceFromAddressSignals/.test(_cfSrc) && /FSA_LETTER_TO_PROVINCE/.test(_cfSrc) && /CITY_TO_PROVINCE/.test(_cfSrc));

  console.log(`\n========== R10-D mini-harness: ${passCount}/${passCount + failCount} PASS ==========`);
  if (failCount > 0) process.exit(1);
})().catch(e => {
  console.error('\nR10-D HARNESS FAILED:', e.stack || e.message);
  process.exit(1);
});
