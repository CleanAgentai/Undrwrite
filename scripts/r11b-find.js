// R11-B empirical-grounding — Marcus Webb deal 8c404ae0. Multi-cluster scope:
//   2a — loan_app $95k hallucination
//   2b — credit_bureau Scotiabank historical attribution
//   3a — computeCombinedLtv source-hierarchy gap
//   3b — refinance LTV math carve-out
//
// PRIORITY (per R11-A carry-forward): trace broker_initial_intent $408k for
// Marcus end-to-end. The R11-A pre-empirical found parser DID extract $408k
// from inbound[0] but final aggregated canonical_map showed ONLY $95k
// loan_application hallucination. Identify where the broker_initial_intent
// tuple is being dropped or where source-hierarchy inverts. If broker_
// initial_intent reaches canonical_map + outranks loan_application per
// R10-G hierarchy → $95k auto-resolves without blank-loan-app hardening.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const cf = require('../src/services/canonical-fields');
const dE = require('../src/services/discrepancy-engine');

const MARCUS_DEAL = '8c404ae0-f50e-4b31-aada-eda4c1f43045';

(async () => {
  console.log('R11-B EMPIRICAL — Marcus Webb broker_initial_intent + balance source-hierarchy + refinance LTV math');
  console.log('='.repeat(80));

  const { data: deal } = await supabase.from('deals').select('id, status, ltv, extracted_data, ownership_type').eq('id', MARCUS_DEAL).single();
  const { data: msgs } = await supabase.from('messages').select('id, direction, subject, body, created_at').eq('deal_id', MARCUS_DEAL).order('created_at', { ascending: true });
  const { data: docs } = await supabase.from('documents').select('file_name, classification, extracted_data').eq('deal_id', MARCUS_DEAL);
  const docsForExtract = docs.map(d => ({ file_name: d.file_name, classification: d.classification, text: d.extracted_data?.text || '' }));
  const inbounds = msgs.filter(m => m.direction === 'inbound');

  // ─── STAGE 1: parseBrokerInitialIntent on inbound[0] ───
  console.log('\nSTAGE 1: parseBrokerInitialIntent on Marcus inbound[0]');
  console.log('-'.repeat(80));
  const stripped0 = dE.stripQuotedReplyChain(inbounds[0].body || '');
  console.log(`  inbound[0] stripped body (${stripped0.length} chars):`);
  console.log(`    ${stripped0.slice(0, 400).replace(/\s+/g, ' ')}`);
  const intent0 = cf.parseBrokerInitialIntent(stripped0);
  console.log(`\n  parseBrokerInitialIntent output:`);
  for (const i of intent0) {
    console.log(`    field=${i.field} value=${JSON.stringify(i.value)} source=${i.source} rawPhrase="${i.rawPhrase}"`);
  }
  const intent408k = intent0.find(i => i.field === 'requested_loan_amount' && i.value === 408000);
  console.log(`\n  FINDING: requested_loan_amount $408k broker_initial_intent tuple ${intent408k ? 'FIRES' : 'DOES NOT FIRE'}`);

  // ─── STAGE 2: extractCanonicalFieldsAggregated (aggregated path) ───
  console.log('\nSTAGE 2: extractCanonicalFieldsAggregated (aggregated path — admin Snapshot rendering)');
  console.log('-'.repeat(80));
  const mapAgg = dE.extractCanonicalFieldsAggregated(inbounds, docsForExtract, { emailSubject: inbounds[0]?.subject || '' });
  console.log(`  canonical_map.requested_loan_amount tuples (aggregated):`);
  for (const t of (mapAgg.requested_loan_amount || [])) {
    console.log(`    value=${JSON.stringify(t.value)} source=${t.source} classification=${t.classification || ''}${t.rawPhrase ? ' rawPhrase="' + t.rawPhrase.slice(0, 80) + '"' : ''}`);
  }
  const agg408k = (mapAgg.requested_loan_amount || []).find(t => t.value === 408000 && t.classification === 'broker_initial_intent');
  console.log(`\n  FINDING: $408k broker_initial_intent tuple in aggregated canonical_map: ${agg408k ? 'PRESENT' : 'MISSING'}`);

  // ─── STAGE 3: filter chain at consumer site ───
  console.log('\nSTAGE 3: filter chain at consumer site (R10-G filterCanonicalLoanAmountForDocAuthoritative)');
  console.log('-'.repeat(80));
  const filteredMap = dE.filterCanonicalLoanAmountForDocAuthoritative(mapAgg);
  console.log(`  canonical_map.requested_loan_amount tuples (post-filter):`);
  for (const t of (filteredMap.requested_loan_amount || [])) {
    console.log(`    value=${JSON.stringify(t.value)} source=${t.source} classification=${t.classification || ''}`);
  }
  const filtered408k = (filteredMap.requested_loan_amount || []).find(t => t.value === 408000);
  const filtered95k = (filteredMap.requested_loan_amount || []).find(t => t.value === 95000);
  console.log(`\n  FINDING: post-filter map has $408k=${filtered408k ? 'YES' : 'NO'} / $95k=${filtered95k ? 'YES' : 'NO'}`);

  // ─── STAGE 4: resolveCanonicalIntentValue (R10-G resolver) ───
  console.log('\nSTAGE 4: resolveCanonicalIntentValue (R10-G resolver — picks broker > docs > email)');
  console.log('-'.repeat(80));
  const resolved = cf.resolveCanonicalIntentValue(mapAgg, 'requested_loan_amount');
  console.log(`  resolveCanonicalIntentValue('requested_loan_amount'): ${JSON.stringify(resolved)}`);

  // ─── STAGE 5: renderDealSnapshot ───
  console.log('\nSTAGE 5: renderDealSnapshot');
  console.log('-'.repeat(80));
  const fullyFilteredMap = dE.filterCanonicalMortgagePositionForObjectiveAuthoritative(
    dE.filterCanonicalPurposeForBrokerAuthoritative(
      dE.filterCanonicalLoanAmountForDocAuthoritative(
        dE.filterCanonicalLenderForPayoutOnly(mapAgg)
      )
    )
  );
  const snap = dE.renderDealSnapshot(fullyFilteredMap, { ownershipType: deal.ownership_type, isCommercial: false });
  const loanAmountRow = snap.match(/<p>\s*<strong>\s*Loan Amount Requested[^<]*<\/p>/i);
  console.log(`  Loan Amount Requested row: ${loanAmountRow ? loanAmountRow[0] : '(not found)'}`);

  // ─── STAGE 6: R6-γ balance source-hierarchy ───
  console.log('\nSTAGE 6: balance source-hierarchy (R11-B-2b empirical anchor)');
  console.log('-'.repeat(80));
  console.log(`  canonical_map.existing_first_mortgage_balance tuples (aggregated):`);
  for (const t of (mapAgg.existing_first_mortgage_balance || [])) {
    console.log(`    value=${JSON.stringify(t.value)} source=${t.source} classification=${t.classification || ''} lender_canonical=${t.lender_canonical || ''}`);
  }
  console.log(`\n  canonical_map.existing_first_mortgage_lender tuples (aggregated):`);
  for (const t of (mapAgg.existing_first_mortgage_lender || [])) {
    console.log(`    value=${JSON.stringify(t.value)} source=${t.source} classification=${t.classification || ''}`);
  }
  // R6-γ filter applied
  const lenderFiltered = dE.filterCanonicalLenderForPayoutOnly(mapAgg);
  console.log(`\n  post-R6-γ filter — existing_first_mortgage_balance tuples:`);
  for (const t of (lenderFiltered.existing_first_mortgage_balance || [])) {
    console.log(`    value=${JSON.stringify(t.value)} source=${t.source} classification=${t.classification || ''} lender_canonical=${t.lender_canonical || ''}`);
  }
  console.log(`\n  post-R6-γ filter — existing_first_mortgage_lender tuples:`);
  for (const t of (lenderFiltered.existing_first_mortgage_lender || [])) {
    console.log(`    value=${JSON.stringify(t.value)} source=${t.source} classification=${t.classification || ''}`);
  }

  // ─── STAGE 7: computeCombinedLtv source selection ───
  console.log('\nSTAGE 7: computeCombinedLtv (R11-B-3a empirical anchor)');
  console.log('-'.repeat(80));
  if (typeof dE.computeCombinedLtv === 'function') {
    const combined = dE.computeCombinedLtv(mapAgg);
    console.log(`  computeCombinedLtv(unfiltered aggregated map): ${JSON.stringify(combined)}`);
    const combinedFiltered = dE.computeCombinedLtv(fullyFilteredMap);
    console.log(`  computeCombinedLtv(filtered map): ${JSON.stringify(combinedFiltered)}`);
  }

  // ─── STAGE 8: loan_application $95k provenance — where exactly does it come from? ───
  console.log('\nSTAGE 8: loan_application $95k provenance');
  console.log('-'.repeat(80));
  const loanApp = docs.find(d => d.classification === 'loan_application');
  if (loanApp) {
    const text = loanApp.extracted_data?.text || '';
    // Search for $95k / 95,000 / 95000 in the loan_app text
    const dollarMatches = [...text.matchAll(/\$?\s*95[,.]?000(?:\.\d+)?/g)];
    const annotation95k = [...text.matchAll(/\[Page\s*\d+\s*annotation\][\s\S]{0,200}?95[,.]?000/gi)];
    console.log(`  $95k / 95,000 / 95000 occurrences in loan_app text: ${dollarMatches.length}`);
    for (const m of dollarMatches.slice(0, 5)) {
      const idx = text.indexOf(m[0]);
      console.log(`    "${m[0]}" — ctx: ${text.slice(Math.max(0, idx - 100), idx + 80).replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    console.log(`\n  [Page N annotation] occurrences containing $95k: ${annotation95k.length}`);
    for (const m of annotation95k.slice(0, 3)) {
      console.log(`    "${m[0].replace(/\s+/g, ' ').slice(0, 250)}"`);
    }
    // Also search for any number near "loan amount" / "amount" / "requested"
    const loanAmountMentions = [...text.matchAll(/(?:loan\s+amount|amount\s+requested|requested\s+loan|principal)[\s\S]{0,80}?\$?[\d,]+/gi)];
    console.log(`\n  loan-amount-near-number mentions:`);
    for (const m of loanAmountMentions.slice(0, 5)) {
      console.log(`    "${m[0].replace(/\s+/g, ' ').slice(0, 200)}"`);
    }
  }

  // ─── STAGE 9: extractFromLoanApplication invocation ───
  console.log('\nSTAGE 9: extractFromLoanApplication invocation on Marcus loan_app');
  console.log('-'.repeat(80));
  if (loanApp && typeof cf.extractFromLoanApplication === 'function') {
    const extracted = cf.extractFromLoanApplication(loanApp);
    console.log(`  extractFromLoanApplication output: ${JSON.stringify(extracted, null, 2).slice(0, 1200)}`);
  } else {
    console.log('  extractFromLoanApplication not exported OR loanApp missing');
    // Try to find via canonical-fields module exports
    const cfKeys = Object.keys(cf).filter(k => /loan/i.test(k));
    console.log(`  canonical-fields loan-related exports: ${cfKeys.join(', ')}`);
  }

  // ─── STAGE 10: Non-aggregated path for comparison ───
  console.log('\nSTAGE 10: extractCanonicalFields non-aggregated path (comparison)');
  console.log('-'.repeat(80));
  const nonAggMap = cf.extractCanonicalFields(stripped0, docsForExtract, { emailSubject: inbounds[0]?.subject || '' });
  console.log(`  non-aggregated canonical_map.requested_loan_amount tuples:`);
  for (const t of (nonAggMap.requested_loan_amount || [])) {
    console.log(`    value=${JSON.stringify(t.value)} source=${t.source} classification=${t.classification || ''}`);
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
