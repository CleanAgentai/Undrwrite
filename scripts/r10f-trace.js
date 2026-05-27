// R10-F — replay Patricia's active-branch detection to determine whether
// (a) discrepancy_set surfaced the mortgage_position divergence, and
// (b) shouldHoldPrelimForDiscrepancy gate fired.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const dEngine = require('../src/services/discrepancy-engine');

const PATRICIA_DEAL = 'a0caddfb-92c4-4607-8ec1-72f54f9ebb31';

(async () => {
  console.log('R10-F TRACE — Patricia active-branch discrepancy replay');
  console.log('='.repeat(80));

  const { data: msgs } = await supabase
    .from('messages')
    .select('id, direction, subject, body, created_at')
    .eq('deal_id', PATRICIA_DEAL)
    .order('created_at', { ascending: true });
  const { data: docs } = await supabase
    .from('documents')
    .select('file_name, classification, extracted_data')
    .eq('deal_id', PATRICIA_DEAL);

  const inbounds = msgs.filter(m => m.direction === 'inbound');
  console.log(`\nINBOUND ${inbounds.length} messages:`);
  inbounds.forEach((m, i) => {
    console.log(`  inbound[${i}] ${m.created_at.slice(0,19)} | subject: ${m.subject}`);
  });

  console.log('\n--- (A) runDiscrepancyDetection on inbound[1] (broker docs reply) ---');
  // The webhook active branch passes email.textBody (current inbound) + savedDocs (newly arriving) +
  // documentsOnFile (already-saved from prior turn). For Patricia msg[2], docs arrive on msg[2] so
  // savedDocs would include them. Production rebuild: pass all docs as savedDocs.
  const docsForDetect = docs.map(d => ({
    file_name: d.file_name,
    classification: d.classification,
    text: d.extracted_data?.text || '',
  }));
  const brokerName = msgs[0]?.subject || 'Clearpath';
  const detect = dEngine.runDiscrepancyDetection(
    inbounds[1]?.body || '',
    docsForDetect,
    brokerName,
    { emailSubject: inbounds[1]?.subject || '' },
  );
  console.log(`  discrepancy_set length: ${detect.discrepancy_set.length}`);
  for (const e of detect.discrepancy_set) {
    console.log(`    ${e.field}: ${e.groups.length} groups`);
    for (const g of e.groups) {
      console.log(`      value="${g.value}" sources=${g.sources.join(',')}`);
    }
  }
  const brokerFacing = dEngine.filterBrokerFacing(detect.discrepancy_set, { marketDeltaFlagsEnabled: false });
  console.log(`  brokerFacing length: ${brokerFacing.length}`);
  console.log(`  brokerFacing entries: ${JSON.stringify(brokerFacing.map(e => e.field))}`);

  console.log('\n--- (B) renderDiscrepancyBullet for each broker-facing entry ---');
  if (typeof dEngine.renderDiscrepancyBullet === 'function') {
    for (const e of brokerFacing) {
      const bullet = dEngine.renderDiscrepancyBullet(e);
      console.log(`  ${e.field}: ${bullet}`);
    }
  }

  console.log('\n--- (C) renderDiscrepancySection (broker-facing render) ---');
  const section = dEngine.renderDiscrepancySection(brokerFacing);
  console.log(`  length: ${section.length}`);
  console.log(`  content:`);
  console.log(section);

  console.log('\n--- (D) Existing post-approval doc-request outbound: discrepancy section present? ---');
  const finalOutbound = msgs.find(m =>
    m.direction === 'outbound'
    && /Re: New File Submission/i.test(m.subject || '')
    && m.created_at > '2026-05-27T02:32:00'
  );
  if (finalOutbound) {
    const hasDiscrepancy = /noticed an item that needs clarification|noticed a couple of items|noticed a few items|noticed a discrepancy/i.test(finalOutbound.body || '');
    console.log(`  outbound at ${finalOutbound.created_at.slice(0,19)}: discrepancy section present = ${hasDiscrepancy}`);
    console.log(`  outbound subject: ${finalOutbound.subject}`);
  } else {
    console.log('  no post-approval doc-request outbound found via subject pattern');
  }

  console.log('\n--- (E) Risk Factors narrative — admin-only surface ---');
  const prelim = msgs.find(m =>
    m.direction === 'outbound'
    && /ACTION REQUIRED: PRELIMINARY/i.test(m.subject || '')
  );
  if (prelim) {
    const rfMatch = (prelim.body || '').match(/<p>\s*<strong>\s*Discrepancy\s+Flag[\s\S]*?<\/p>/i);
    if (rfMatch) {
      console.log(`  Discrepancy Flag in Risk Factors:`);
      console.log(`    ${rfMatch[0].replace(/\s+/g, ' ').slice(0, 500)}`);
    } else {
      console.log('  No Discrepancy Flag <p><strong> found in prelim');
    }
  }

  console.log('\n--- (F) Code-path gate: shouldHoldPrelimForDiscrepancy inputs ---');
  console.log(`  brokerFacingDiscrepancyCount (from active path) = ${brokerFacing.length}`);
  console.log(`  prelim_approved_at: 2026-05-27T02:32:07 (set on admin-approval msg[4])`);
  console.log(`  prelim was sent at 02:21:27 — was prelim held by gate?`);
  console.log(`  shouldHoldPrelimForDiscrepancy returns true if brokerFacing.length > 0 — so prelim should have been HELD`);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
