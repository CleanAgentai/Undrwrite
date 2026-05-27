// R10-C empirical-grounding — Ryan Callahan combined-LTV >80% escalation.
// Goal: verify the empirical LTV (combined + standalone), trace
// canonical_map at prelim time, inventory message thread for LTV-threshold
// language, identify the prelim-trigger path that fired.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const dEngine = require('../src/services/discrepancy-engine');

(async () => {
  console.log('R10-C EMPIRICAL — Ryan Callahan LTV>80% escalation');
  console.log('='.repeat(80));

  // (A) Find Ryan Callahan deal(s)
  console.log('\nSTRATEGY A: locate Ryan Callahan deal');
  console.log('-'.repeat(80));
  const { data: deals, error } = await supabase
    .from('deals')
    .select('id, borrower_name, status, ltv, ownership_type, extracted_data, prelim_approved_at, created_at')
    .ilike('borrower_name', '%ryan%callahan%')
    .order('created_at', { ascending: false });
  if (error) { console.error(error); process.exit(1); }
  console.log(`  matched ${deals.length} deal(s):`);
  for (const d of deals) {
    console.log(`    id=${d.id} borrower="${d.borrower_name}" status=${d.status} ltv=${d.ltv} created=${d.created_at}`);
  }
  if (deals.length === 0) {
    // Try fuzzy search via extracted_data
    const { data: alt } = await supabase
      .from('deals')
      .select('id, borrower_name, status, ltv, extracted_data, created_at')
      .order('created_at', { ascending: false })
      .limit(30);
    console.log('  fallback recent-30:');
    for (const d of (alt || [])) {
      const bn = d.extracted_data?.borrower_name || d.borrower_name;
      if (/ryan|callahan/i.test(bn || '')) {
        console.log(`    id=${d.id} borrower="${bn}" status=${d.status} ltv=${d.ltv}`);
      }
    }
  }
  if (deals.length === 0) { console.log('  no Ryan deals — aborting'); process.exit(0); }

  const RYAN = deals[0];
  const RYAN_ID = RYAN.id;
  console.log(`\nSelected RYAN_ID=${RYAN_ID}`);

  // (B) Full extracted_data
  console.log('\nSTRATEGY B: extracted_data inventory');
  console.log('-'.repeat(80));
  const ed = RYAN.extracted_data || {};
  const keysOfInterest = [
    'borrower_name', 'loan_type', 'purpose', 'mortgage_position',
    'requested_loan_amount', 'loan_amount_requested', 'property_value',
    'subject_property_market_value', 'existing_mortgage_balance',
    'existing_first_mortgage_balance', 'ltv_percent', 'combined_ltv_percent',
    'collateral_offered', 'exit_strategy', 'ownership_type',
  ];
  for (const k of keysOfInterest) {
    if (ed[k] !== undefined) console.log(`  ${k}: ${JSON.stringify(ed[k])}`);
  }
  console.log(`  deal.ltv (column): ${RYAN.ltv}`);
  console.log(`  deal.status: ${RYAN.status}`);
  console.log(`  deal.ownership_type: ${RYAN.ownership_type}`);

  // (C) Message thread
  console.log('\nSTRATEGY C: message thread inventory');
  console.log('-'.repeat(80));
  const { data: msgs } = await supabase
    .from('messages')
    .select('id, direction, subject, body, created_at')
    .eq('deal_id', RYAN_ID)
    .order('created_at', { ascending: true });
  console.log(`  Total messages: ${msgs.length}`);
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    console.log(`  [${i}] ${m.direction.toUpperCase()} | ${m.created_at.slice(0,19)} | ${(m.subject||'').slice(0,90)}`);
  }

  // (D) Pull all documents
  console.log('\nSTRATEGY D: documents on file');
  console.log('-'.repeat(80));
  const { data: docs } = await supabase
    .from('documents')
    .select('file_name, classification, extracted_data')
    .eq('deal_id', RYAN_ID);
  console.log(`  ${docs.length} doc(s):`);
  for (const d of docs) {
    console.log(`    [${d.classification || 'unclassified'}] ${d.file_name}`);
  }

  // (E) Replay canonical_map detection — extract market_value, balance, requested
  console.log('\nSTRATEGY E: canonical_map at prelim-time');
  console.log('-'.repeat(80));
  const inbounds = msgs.filter(m => m.direction === 'inbound');
  const docsForDetect = docs.map(d => ({
    file_name: d.file_name,
    classification: d.classification,
    text: d.extracted_data?.text || '',
  }));
  const detect = dEngine.runDiscrepancyDetectionAggregated(
    inbounds,
    docsForDetect,
    ed.borrower_name || null,
    { emailSubject: inbounds[0]?.subject || '' },
  );
  const cmap = detect.canonical_map || {};
  const ltvRelevantFields = [
    'subject_property_market_value', 'subject_property_assessment_value',
    'requested_loan_amount', 'existing_first_mortgage_balance',
    'existing_first_mortgage_payout_total', 'mortgage_position',
  ];
  for (const f of ltvRelevantFields) {
    const tuples = cmap[f] || [];
    console.log(`  ${f}:`);
    for (const t of tuples) {
      console.log(`    value=${JSON.stringify(t.value)} source=${t.source} classification=${t.classification || ''}`);
    }
  }

  // (F) Compute combined LTV via dEngine.computeCombinedLtv
  console.log('\nSTRATEGY F: computeCombinedLtv replay');
  console.log('-'.repeat(80));
  if (typeof dEngine.computeCombinedLtv === 'function') {
    const combined = dEngine.computeCombinedLtv(cmap);
    console.log(`  computeCombinedLtv(canonical_map) = ${combined}`);
  } else {
    console.log('  dEngine.computeCombinedLtv not found');
  }
  if (typeof dEngine.computeStandaloneLtv === 'function') {
    const standalone = dEngine.computeStandaloneLtv(cmap);
    console.log(`  computeStandaloneLtv(canonical_map) = ${standalone}`);
  }

  // (G) Inventory message thread for LTV-threshold language
  console.log('\nSTRATEGY G: LTV-threshold language in message corpus');
  console.log('-'.repeat(80));
  const ltvPhrases = [
    /80%?\s*(?:LTV|threshold|cap|limit|max)/i,
    /(?:LTV|loan-to-value).{0,30}(?:80|over\s+80|above\s+80|>\s*80|exceed)/i,
    /collateral/i,
    /additional\s+(?:collateral|security|property)/i,
    /reject(?:ed|ion)?/i,
    /(?:75|80)\s*%/,
    /high\s*(?:LTV|leverage)/i,
    /escalat(?:e|ion|ed)/i,
  ];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const body = (m.body || '') + ' ' + (m.subject || '');
    const hits = ltvPhrases.filter(re => re.test(body));
    if (hits.length > 0) {
      console.log(`  msg[${i}] ${m.direction} ${m.created_at.slice(0,19)} HITS: ${hits.length}`);
      for (const re of hits) {
        const match = body.match(re);
        if (match) {
          const idx = body.indexOf(match[0]);
          console.log(`    "${match[0]}" — ctx: ${body.slice(Math.max(0,idx-40), idx+80).replace(/\s+/g,' ').slice(0,150)}`);
        }
      }
    }
  }

  // (H) Find prelim outbound + LTV-related content
  console.log('\nSTRATEGY H: prelim outbound LTV content');
  console.log('-'.repeat(80));
  const prelims = msgs.filter(m =>
    m.direction === 'outbound'
    && /PRELIMINARY|ACTION REQUIRED/i.test(m.subject || '')
  );
  console.log(`  ${prelims.length} prelim outbounds`);
  for (const p of prelims) {
    console.log(`\n  ── ${p.created_at.slice(0,19)} | ${p.subject} ──`);
    const body = p.body || '';
    const ltvBand = body.match(/(?:Combined\s+)?LTV[:\s]*[\d.]+%?/gi);
    if (ltvBand) {
      console.log(`  LTV mentions: ${ltvBand.slice(0, 8).join(' | ')}`);
    }
    // Risk Factors
    const rfMatch = body.match(/Risk\s+Factors[\s\S]*?(?=<h2|<hr|$)/i);
    if (rfMatch) {
      console.log('  Risk Factors:');
      console.log(rfMatch[0].replace(/\s+/g, ' ').slice(0, 1500));
    }
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
