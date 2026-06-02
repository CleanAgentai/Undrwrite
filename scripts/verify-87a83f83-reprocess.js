#!/usr/bin/env node
// Offline reprocess verification of Finding 1 (deal 87a83f83) with the line-490
// fix in place. Confirms: (1) the active-continuation crash is gone, (2) the
// clarification merge clears the RBC/Scotiabank lender discrepancy now that the
// RBC payout statement (mortgage_statement) is on file, (3) the gate resolves to
// a prelim (not escalate/decline/hold). Final dispatch-to-admin confirmation is
// a post-push staging replay (can't deploy while holding the commit).
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const dEngine = require('../src/services/discrepancy-engine');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

(async () => {
  const { data: deals } = await s.from('deals').select('id,status,extracted_data').eq('email', 'franco@francomaione.com').order('created_at', { ascending: false }).limit(1);
  const deal = deals[0];
  const { data: msgs } = await s.from('messages').select('body').eq('deal_id', deal.id).eq('direction', 'inbound').order('created_at');
  const { data: docs } = await s.from('documents').select('file_name,classification,extracted_data').eq('deal_id', deal.id).order('created_at');

  const inbound = msgs.map(m => ({ body: (m.body || '').replace(/<[^>]+>/g, ' ') }));
  const savedDocs = docs.map(d => ({ file_name: d.file_name, classification: d.classification, text: d.extracted_data?.text || '', extracted_data: { text: d.extracted_data?.text || '' } }));

  console.log(`Deal ${deal.id}  (${docs.length} docs, ${inbound.length} inbound turns)`);
  console.log(`  docs: ${docs.map(d => d.classification).join(', ')}\n`);

  // AGGREGATED merge across BOTH turns (intake + clarification) — the active-deal path
  const r = dEngine.runDiscrepancyDetectionAggregated(inbound, savedDocs, null, { emailSubject: 'New Mortgage submission' });
  const cm = r.canonical_map;
  const show = (f) => (cm[f] || []).map(t => `${t.value}[${t.classification || t.source}]`).join(', ');

  console.log('=== MERGED CANONICAL (both turns) ===');
  console.log('  existing_first_mortgage_lender:', show('existing_first_mortgage_lender'));
  console.log('  existing_first_mortgage_balance:', show('existing_first_mortgage_balance'));
  console.log('  requested_loan_amount:', show('requested_loan_amount'));
  console.log('  mortgage_position (raw):', show('mortgage_position'));
  const filtered = dEngine.filterCanonicalMortgagePositionForObjectiveAuthoritative(JSON.parse(JSON.stringify(cm)));
  console.log('  mortgage_position (filtered):', (filtered.mortgage_position || []).map(t => `${t.value}[${t.classification || t.source}]`).join(', '));

  const combined = dEngine.computeCombinedLtv(cm);
  const standalone = dEngine.computeStandaloneLtv(cm);
  const mismatch = dEngine.computeExistingLenderRefinanceMismatch(cm);
  const brokerFacing = dEngine.filterBrokerFacing(r.discrepancy_set, { marketDeltaFlagsEnabled: false });

  console.log('\n=== GATE EVALUATION (post-clarification) ===');
  console.log(`  standalone LTV: ${standalone}   combined LTV: ${combined ? combined.combined_ltv_percent + ' (' + combined.components.existing_source + ')' : 'null'}`);
  console.log(`  shouldEscalateOnAnyLtv: ${dEngine.shouldEscalateOnAnyLtv({ standaloneLtv: standalone, combinedLtv: combined ? combined.combined_ltv_percent : null })}`);
  console.log(`  shouldAutoDeclineOver90: ${dEngine.shouldAutoDeclineOver90({ standaloneLtv: standalone, combinedLtv: combined ? combined.combined_ltv_percent : null, combinedResolved: dEngine.isCombinedLtvResolved(cm) }).decline}`);
  console.log(`  lender-mismatch flag (computeExistingLenderRefinanceMismatch): ${mismatch ? JSON.stringify(mismatch) : 'null (CLEARED — RBC now matches)'}`);
  console.log(`  broker-facing discrepancy_set: ${brokerFacing.length} entries${brokerFacing.length ? ' → ' + brokerFacing.map(e => e.field).join(', ') : ' (none → no prelim-hold)'}`);

  console.log('\n=== EXPECTED POST-FIX OUTCOME ===');
  console.log('  No crash (ltv ReferenceError removed). RBC payout statement (mortgage_statement) now matches');
  console.log('  email RBC → lender discrepancy clears → no broker-facing discrepancy → prelim fires (not held).');
  console.log('  LTV 60% standalone, not escalate/decline → deal proceeds to admin prelim (active → under_review).');
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
