// R8-A + R8-B probe — Nadia Petrov S15 (Eastview Mortgage Group). Verify
// both bug shapes:
//   R8-A: "Hi there!" greeting in broker-facing replies despite Nadia's
//         name being in every broker email
//   R8-B: "Perfect" opener on a broker-replied turn (R6-ζ's gated block
//         doesn't fire because brokerRepliedSinceLastViennaOutbound=true)
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

(async () => {
  // 1. Locate Nadia Petrov deal (or Anna Bergstrom borrower).
  console.log('STRATEGY: locate Nadia Petrov / Anna Bergstrom S15 deal\n' + '─'.repeat(72));
  const { data: deals } = await supabase
    .from('deals')
    .select('id, borrower_name, status, created_at, extracted_data')
    .ilike('borrower_name', '%Anna%Bergstrom%')
    .order('created_at', { ascending: false })
    .limit(10);
  console.log(`Anna Bergstrom deals: ${deals?.length || 0}`);
  for (const d of deals || []) {
    const brokerName = d.extracted_data?.broker_name || d.extracted_data?.sender_name || '(none)';
    console.log(`  • ${d.id} | borrower=${d.borrower_name} | broker=${brokerName} | status=${d.status} | created=${d.created_at}`);
  }

  // Pick the most recent Nadia/Eastview deal.
  let target = (deals || []).find(d => /nadia|eastview/i.test(JSON.stringify(d.extracted_data || {})));
  if (!target) target = (deals || []).find(d => d.created_at > '2026-05-21');
  if (!target) target = (deals || [])[0];
  if (!target) { console.log('NO target deal'); process.exit(1); }

  console.log(`\nResolving on ${target.id}\n${'═'.repeat(72)}`);

  // Pull full timeline.
  const { data: msgs } = await supabase
    .from('messages')
    .select('direction, subject, body, created_at, external_message_id')
    .eq('deal_id', target.id)
    .order('created_at', { ascending: true });
  console.log(`total messages: ${msgs.length} (${msgs.filter(m => m.direction === 'inbound').length} in + ${msgs.filter(m => m.direction === 'outbound').length} out)`);

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const text = (m.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log(`\n──── #${i} ${m.direction.toUpperCase()} ${m.created_at} ────`);
    console.log(`  subject: ${m.subject}`);
    console.log(`  body[0..900]: ${text.slice(0, 900)}`);
    // R8-A flags
    const hasHiThere = /\bHi there\b/i.test(text);
    const hasHiNadia = /\bHi Nadia\b/i.test(text);
    // R8-B flags
    const hasPerfectOpener = /^\s*Perfect[\s,!.—\-]/i.test(text);
    const hasPerfectAny = /\bPerfect\b/i.test(text);
    const flags = [];
    if (m.direction === 'outbound' && hasHiThere) flags.push('R8-A: "Hi there!" greeting (broker name missing)');
    if (m.direction === 'outbound' && hasHiNadia) flags.push('R8-A counter: "Hi Nadia!" greeting (correct shape)');
    if (m.direction === 'outbound' && hasPerfectOpener) flags.push('R8-B: "Perfect" OPENER (always-prohibited per Franco)');
    if (m.direction === 'outbound' && hasPerfectAny && !hasPerfectOpener) flags.push('R8-B mention: "Perfect" mid-body (not opener)');
    if (flags.length > 0) console.log(`  ⚠ FLAGS: ${flags.join(' | ')}`);
  }

  // 2. Surface broker name from extracted_data
  console.log(`\n\n${'═'.repeat(72)}\nBROKER NAME EXTRACTION STATE (deal ${target.id})\n${'═'.repeat(72)}`);
  const ed = target.extracted_data || {};
  console.log(`  broker_name: ${JSON.stringify(ed.broker_name)}`);
  console.log(`  sender_name: ${JSON.stringify(ed.sender_name)}`);
  console.log(`  sender_type: ${JSON.stringify(ed.sender_type)}`);
  console.log(`  name_collides_with_admin: ${JSON.stringify(ed.name_collides_with_admin)}`);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
