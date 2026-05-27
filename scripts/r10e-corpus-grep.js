// R10-E empirical-grounding — mortgage_position canonical resolver
// Patricia Simmons deal a0caddfb: prelim Snapshot says "1st"; Risk Factors
// narrative says "second mortgage with $342,000 TD Bank first mortgage"
// (self-contradicting).

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const cFields = require('../src/services/canonical-fields');
const dEngine = require('../src/services/discrepancy-engine');

const PATRICIA_DEAL = 'a0caddfb-92c4-4607-8ec1-72f54f9ebb31';

(async () => {
  console.log('R10-E EMPIRICAL — mortgage_position canonical resolver');
  console.log('='.repeat(80));

  // (A) Patricia deal — current state
  console.log('\nSTRATEGY A: Patricia deal extracted_data + canonical_map');
  console.log('-'.repeat(80));
  const { data: deal } = await supabase
    .from('deals')
    .select('extracted_data, status')
    .eq('id', PATRICIA_DEAL)
    .single();
  const ed = deal?.extracted_data || {};
  console.log(`  loan_type: "${ed.loan_type || '(none)'}"`);
  console.log(`  purpose: "${ed.purpose || '(none)'}"`);
  console.log(`  existing_mortgage_balance: ${ed.existing_mortgage_balance || '(none)'}`);
  console.log(`  loan_amount_requested: ${ed.loan_amount_requested || '(none)'}`);

  // (B) Full canonical_map replay
  const { data: msgs } = await supabase
    .from('messages')
    .select('body, subject, direction, created_at')
    .eq('deal_id', PATRICIA_DEAL)
    .order('created_at', { ascending: true });
  const { data: docs } = await supabase
    .from('documents')
    .select('file_name, classification, extracted_data')
    .eq('deal_id', PATRICIA_DEAL);

  const inbounds = msgs.filter(m => m.direction === 'inbound');
  const outbounds = msgs.filter(m => m.direction === 'outbound');
  console.log(`  inbounds: ${inbounds.length}, outbounds: ${outbounds.length}`);

  const docsForCanonical = docs.map(d => ({
    file_name: d.file_name,
    classification: d.classification,
    text: d.extracted_data?.text || '',
  }));
  const detect = dEngine.runDiscrepancyDetectionAggregated(
    inbounds,
    docsForCanonical,
    ed.borrower_name || null,
    { emailSubject: inbounds[0]?.subject || '' },
  );
  const cmap = detect.canonical_map || {};
  console.log(`\n  canonical_map.mortgage_position tuples: ${JSON.stringify(cmap.mortgage_position || [])}`);
  console.log(`  canonical_map.existing_first_mortgage_balance tuples: ${JSON.stringify((cmap.existing_first_mortgage_balance || []).map(t => ({ value: t.value, source: t.source })))}`);
  console.log(`  canonical_map.existing_first_mortgage_lender tuples: ${JSON.stringify((cmap.existing_first_mortgage_lender || []).map(t => ({ value: t.value, source: t.source })))}`);
  console.log(`  canonical_map.requested_loan_amount tuples: ${JSON.stringify((cmap.requested_loan_amount || []).map(t => ({ value: t.value, source: t.source, classification: t.classification })))}`);

  // (C) First inbound — broker stated position
  console.log('\nSTRATEGY C: First inbound — broker stated position');
  console.log('-'.repeat(80));
  console.log(`  subject: "${inbounds[0]?.subject}"`);
  console.log(`  body (first 600 chars):\n${(inbounds[0]?.body || '').slice(0, 600)}`);

  // (D) Loan application doc — Page-1 annotation for mortgage position
  console.log('\nSTRATEGY D: Loan application Page-1 annotations');
  console.log('-'.repeat(80));
  const loanApp = docs.find(d => d.classification === 'loan_application');
  if (loanApp) {
    const text = loanApp.extracted_data?.text || '';
    const annotations = [...text.matchAll(/\[Page\s*1\s*annotation\]\s+([^\n]+)/gi)];
    console.log(`  loan_application annotations (${annotations.length}):`);
    for (const a of annotations) {
      const val = a[1].trim();
      console.log(`    "${val}"  ${/Mortgage\b/i.test(val) ? '<-- MORTGAGE POSITION ANNOTATION' : ''}`);
    }
  }

  // (E) Prelim outbound — find the Snapshot + Risk Factors
  console.log('\nSTRATEGY E: Prelim outbound — Snapshot vs Risk Factors mortgage position');
  console.log('-'.repeat(80));
  const prelim = outbounds.find(m => /PRELIMINARY/i.test(m.subject));
  if (prelim) {
    const body = prelim.body || '';
    const snapshotMortgagePos = body.match(/Mortgage Position[^<\n]*?([12][a-z]{2}|First|Second|Third)/i);
    const riskFactorsMatch = body.match(/Risk Factors[\s\S]*?(?=<h2>|$)/i);
    console.log(`  Snapshot "Mortgage Position": ${snapshotMortgagePos ? `"${snapshotMortgagePos[0]}"` : '(not found)'}`);
    if (riskFactorsMatch) {
      // Find mortgage references in Risk Factors
      const rf = riskFactorsMatch[0];
      const mortgageRefs = [...rf.matchAll(/(first|second|third)\s+mortgage|\b[12](st|nd|rd)\s+mortgage|existing.{0,30}mortgage/gi)];
      console.log(`  Risk Factors mortgage references (${mortgageRefs.length}):`);
      for (const m of mortgageRefs.slice(0, 5)) {
        const idx = rf.indexOf(m[0]);
        console.log(`    "${rf.slice(Math.max(0, idx - 30), idx + m[0].length + 50).replace(/\s+/g, ' ').slice(0, 150)}"`);
      }
    }
  }

  // (F) Code-path summary
  console.log('\nSTRATEGY F: code-path summary');
  console.log('-'.repeat(80));
  console.log('  mortgage_position canonical-map push sites:');
  const { execSync } = require('child_process');
  const grep = (pattern, file, n = 10) => {
    try { return execSync(`grep -nE "${pattern}" ${file} 2>/dev/null | head -${n} || true`).toString().trim(); }
    catch { return ''; }
  };
  console.log(grep("push.*mortgage_position|mortgage_position.*push", 'src/services/canonical-fields.js', 10));
  console.log('\n  Snapshot mortgage_position render site:');
  console.log(grep("Mortgage Position|mortgage_position", 'src/services/discrepancy-engine.js', 10));
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
