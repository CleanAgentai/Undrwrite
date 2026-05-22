// R7-A probe — Lena Park / Carlos Mendez Scenario 14. Vienna sent COMPLETE
// template "FINAL REVIEW: All Documents Received" / status "COMPLETE — Ready
// for Review" on FIRST admin-facing review when admin had never approved.
// Franco rule: PRELIMINARY = always first admin-facing review, regardless of
// doc count. COMPLETE = only after admin has previously approved + conditions
// fulfilled.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

(async () => {
  // Locate Lena Park deal via borrower-name + recent.
  console.log('LENA PARK deals (most recent first)\n' + '─'.repeat(72));
  const { data: deals } = await supabase
    .from('deals')
    .select('id, borrower_name, status, created_at, prelim_approved_at, conditions_sent_at, aml_pep_requested_at')
    .ilike('borrower_name', '%Lena%Park%')
    .order('created_at', { ascending: false })
    .limit(10);
  for (const d of deals || []) {
    console.log(`  • ${d.id} | ${d.borrower_name} | status=${d.status} | prelim_approved=${d.prelim_approved_at || 'null'} | conditions_sent=${d.conditions_sent_at || 'null'} | aml_pep_requested=${d.aml_pep_requested_at || 'null'}`);
  }

  // Focus on the most recent Lena Park deal — Franco's S14 fixture is the
  // Carlos Mendez submission. Should be 4850dc32-prefix per R6-θ corpus.
  const seedDeal = (deals || []).find(d => d.id.startsWith('4850dc32'))
    || (deals || []).find(d => d.created_at > '2026-05-21')
    || (deals || [])[0];

  if (!seedDeal) { console.log('NO seed deal'); process.exit(1); }
  console.log(`\nResolving on deal_id=${seedDeal.id}\n${'═'.repeat(72)}`);

  // Full message timeline.
  const { data: msgs } = await supabase
    .from('messages')
    .select('direction, subject, body, created_at, external_message_id')
    .eq('deal_id', seedDeal.id)
    .order('created_at', { ascending: true });
  console.log(`  total messages: ${msgs.length} (${msgs.filter(m => m.direction === 'inbound').length} in + ${msgs.filter(m => m.direction === 'outbound').length} out)\n`);

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const text = (m.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log(`  ── #${i} ${m.direction.toUpperCase()} ${m.created_at} ──`);
    console.log(`     subject: ${m.subject}`);
    console.log(`     body[0..1200]: ${text.slice(0, 1200)}`);
    // Flag the smoking-gun phrases.
    const flags = [];
    if (/FINAL REVIEW/.test(m.subject)) flags.push('FINAL REVIEW subject (admin-facing)');
    if (/COMPLETE Review/.test(m.subject)) flags.push('COMPLETE Review subject');
    if (/PRELIMINARY Review/.test(m.subject)) flags.push('PRELIMINARY Review subject');
    if (/FILE STATUS:\s*COMPLETE/.test(text)) flags.push('FILE STATUS: COMPLETE');
    if (/FILE STATUS:\s*PRELIMINARY/.test(text)) flags.push('FILE STATUS: PRELIMINARY');
    if (flags.length > 0) console.log(`     ⚠ FLAGS: ${flags.join(' | ')}`);
    console.log();
  }

  // Documents on file for the deal — confirm the broker's package shape
  // (which triggers the COMPLETE-template selection).
  const { data: docs } = await supabase
    .from('documents')
    .select('file_name, classification, created_at')
    .eq('deal_id', seedDeal.id)
    .order('created_at', { ascending: true });
  console.log(`\n${'═'.repeat(72)}\nDOCUMENTS ON FILE — ${seedDeal.id}\n${'═'.repeat(72)}`);
  console.log(`  total docs: ${docs?.length || 0}`);
  for (const d of docs || []) {
    console.log(`    • ${d.file_name} (${d.classification}) created=${d.created_at}`);
  }

  // Pivotal question: at the time of the first admin-facing dispatch, what
  // was the deal's prelim_approved_at? Should be null (no prior approval).
  console.log(`\nKEY EMPIRICAL ANCHORS:`);
  console.log(`  deal.status: ${seedDeal.status}`);
  console.log(`  deal.prelim_approved_at: ${seedDeal.prelim_approved_at || 'null (no prior approval — PRELIMINARY should fire, not COMPLETE)'}`);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
