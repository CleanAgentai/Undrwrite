// R10-D empirical-grounding — province inference (Patricia + Kevin Round-6 deals).
// PERSISTENT-from-earlier-rounds; R6-δ documented at discrepancy-engine.js:219
// as a deferred residual ("no city→province lookup table"). R10-D fills the gap.
//
// Bug: subject_property_city populated, subject_property_province null →
// deriveCityProvince returns { city, province: 'TBD' } → Snapshot shows TBD.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const cFields = require('../src/services/canonical-fields');
const dEngine = require('../src/services/discrepancy-engine');

(async () => {
  console.log('R10-D EMPIRICAL — province inference');
  console.log('='.repeat(80));

  // (A) Patricia + Kevin + Ethan deal inventory — Round-6 fixtures
  const dealIds = {
    'Patricia (Round 6 Scenario 5)': 'a0caddfb-92c4-4607-8ec1-72f54f9ebb31',
    'Kevin (Round 6 Scenario 6)': '30d1e798-38b0-410a-8e9a-9999ea26c61f',
    'Ethan (Round 6 Scenario 7)': 'c95f3a20-162c-45cf-a98c-60b6bbb2de9a',
    'Donna/Ryan (Round 6 Scenario 4)': '45bd01df-4d8f-4ff4-98b0-86d80db79876',
  };

  for (const [label, did] of Object.entries(dealIds)) {
    console.log(`\n${label} — deal ${did}`);
    console.log('-'.repeat(80));
    const { data: deal } = await supabase
      .from('deals')
      .select('extracted_data')
      .eq('id', did)
      .single();
    const ed = deal?.extracted_data || {};
    console.log(`  property_address: "${ed.property_address || '(none)'}"`);

    // Pull docs + inbounds to run extractCanonicalFields the same way prod does
    const { data: msgs } = await supabase
      .from('messages')
      .select('body, subject, created_at')
      .eq('deal_id', did)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: true });
    const { data: docs } = await supabase
      .from('documents')
      .select('file_name, classification, extracted_data')
      .eq('deal_id', did);

    const docsForCanonical = (docs || []).map(d => ({
      file_name: d.file_name,
      classification: d.classification,
      text: d.extracted_data?.text || '',
    }));
    const detect = dEngine.runDiscrepancyDetectionAggregated(
      msgs || [],
      docsForCanonical,
      ed.borrower_name || null,
      { emailSubject: msgs?.[0]?.subject || '' },
    );
    const cmap = detect.canonical_map || {};
    console.log(`  canonical_map.subject_property_city: ${JSON.stringify((cmap.subject_property_city || []).map(t => t.value))}`);
    console.log(`  canonical_map.subject_property_province: ${JSON.stringify((cmap.subject_property_province || []).map(t => t.value))}`);
    console.log(`  canonical_map.subject_property_postal_code: ${JSON.stringify((cmap.subject_property_postal_code || []).map(t => t.value))}`);
    console.log(`  canonical_map.subject_property_address: ${JSON.stringify((cmap.subject_property_address || []).map(t => t.value).slice(0, 3))}`);

    // What does deriveCityProvince currently return?
    const cityProv = dEngine.deriveCityProvince(cmap);
    console.log(`  deriveCityProvince result: ${JSON.stringify(cityProv)}`);

    // What does the body actually contain re: province/postal?
    const firstBody = msgs?.[0]?.body || '';
    const postalMatch = firstBody.match(/\b([A-Z]\d[A-Z])\s?(\d[A-Z]\d)?\b/);
    console.log(`  inbound[0] postal-pattern match: ${postalMatch ? `"${postalMatch[0]}"` : '(none)'}`);
    const provinceInBody = firstBody.match(/\b(AB|BC|SK|MB|ON|QC|NB|NS|PE|NL|NT|YT|NU)\b/);
    console.log(`  inbound[0] province-token match: ${provinceInBody ? `"${provinceInBody[0]}"` : '(none)'}`);
  }

  // (B) Existing province lookup infrastructure?
  console.log('\n\n' + '='.repeat(80));
  console.log('STRATEGY B: existing province-lookup infrastructure');
  console.log('='.repeat(80));
  const { execSync } = require('child_process');
  const grep = (pattern, file, n = 10) => {
    try { return execSync(`grep -nE "${pattern}" ${file} 2>/dev/null | head -${n} || true`).toString().trim(); }
    catch { return ''; }
  };
  console.log('canonical-fields.js — postal FSA → province logic:');
  console.log(grep("postal.*province|province.*postal|FSA.*province|T[0-9]A.*Alberta|FSA_TO_PROVINCE|CITY_TO_PROVINCE", 'src/services/canonical-fields.js', 10));
  console.log('\ndiscrepancy-engine.js:');
  console.log(grep("CITY_TO_PROVINCE|FSA_TO_PROVINCE|lookup.*province|province.*table", 'src/services/discrepancy-engine.js', 10));
  console.log('\nrepo-wide:');
  console.log(grep("CITY_TO_PROVINCE|FSA_TO_PROVINCE", 'src/ -r', 10));

  // (C) Canadian postal-code FSA → province mapping (reference data)
  console.log('\n\n' + '='.repeat(80));
  console.log('STRATEGY C: Canadian postal-code FSA-letter → province table (Canada Post standard)');
  console.log('='.repeat(80));
  const FSA_PROV_MAP = {
    'A': 'NL', // Newfoundland and Labrador
    'B': 'NS', // Nova Scotia
    'C': 'PE', // Prince Edward Island
    'E': 'NB', // New Brunswick
    'G': 'QC', // Quebec East
    'H': 'QC', // Montreal area
    'J': 'QC', // Quebec West
    'K': 'ON', // Eastern Ontario
    'L': 'ON', // Central Ontario
    'M': 'ON', // Toronto
    'N': 'ON', // Southwestern Ontario
    'P': 'ON', // Northern Ontario
    'R': 'MB', // Manitoba
    'S': 'SK', // Saskatchewan
    'T': 'AB', // Alberta
    'V': 'BC', // British Columbia
    'X': 'NT', // Northwest Territories / Nunavut (X0A-X0G NU, others NT)
    'Y': 'YT', // Yukon
  };
  console.log('FSA first-letter → province map:');
  for (const [letter, prov] of Object.entries(FSA_PROV_MAP)) {
    console.log(`  ${letter} → ${prov}`);
  }
  console.log(`  Verification: Calgary postal codes start with T (Calgary=T1-T3) → Alberta`);
  console.log(`                Edmonton postal codes start with T (T5-T6) → Alberta`);
  console.log(`                Toronto postal codes start with M → Ontario`);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
