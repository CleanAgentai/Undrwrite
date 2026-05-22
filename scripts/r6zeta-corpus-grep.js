// R6-ζ empirical-grounding probe — pulls all outbound messages for the
// Kevin S6 (178d714e) + Ethan S7 (533fbd4f) Postmark inbound IDs,
// grep for "Thanks for the quick response" / "Thanks for the confirmation"
// + adjacent shapes. Reports per-deal turn-by-turn.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const SEED_INBOUND_PREFIXES = [
  { label: 'Kevin Tran S6',   prefix: '178d714e' },
  { label: 'Ethan Broussard S7', prefix: '533fbd4f' },
];

const TARGET_PHRASES = [
  /thanks for (the )?quick response/i,
  /thanks for (the )?confirmation/i,
  /thanks for confirming/i,
  /appreciate (the )?quick (reply|response|confirmation)/i,
  /thanks for getting back/i,
  /thanks for (the )?(prompt|swift) (reply|response)/i,
];

(async () => {
  for (const { label, prefix } of SEED_INBOUND_PREFIXES) {
    console.log(`\n════════════════════════════════════════`);
    console.log(`${label} — inbound prefix ${prefix}`);
    console.log(`════════════════════════════════════════`);

    // 1. Find the deal via the seed inbound message.
    const { data: seedRows, error: seedErr } = await supabase
      .from('messages')
      .select('deal_id, external_message_id, created_at, direction, subject')
      .like('external_message_id', `${prefix}%`)
      .limit(5);

    if (seedErr) { console.error('seed query err', seedErr); continue; }
    if (!seedRows || seedRows.length === 0) {
      console.log(`  NO inbound row found with external_message_id prefix ${prefix}`);
      continue;
    }

    const dealId = seedRows[0].deal_id;
    console.log(`  deal_id=${dealId}`);
    console.log(`  seed-row direction=${seedRows[0].direction} subject="${seedRows[0].subject}" created_at=${seedRows[0].created_at}`);

    // 2. Pull ALL messages for the deal in chronological order.
    const { data: allMsgs, error: allErr } = await supabase
      .from('messages')
      .select('id, direction, subject, body, external_message_id, created_at')
      .eq('deal_id', dealId)
      .order('created_at', { ascending: true });

    if (allErr) { console.error('msgs query err', allErr); continue; }
    console.log(`  total messages: ${allMsgs.length} (${allMsgs.filter(m => m.direction === 'inbound').length} inbound + ${allMsgs.filter(m => m.direction === 'outbound').length} outbound)`);

    // 3. Iterate. For each outbound, grep body for target phrases; also flag
    //    outbound turns that came AFTER an inbound vs AFTER another outbound
    //    (the latter = "admin-triggered without broker reply" — the R6-ζ
    //    structural condition).
    let prevDir = null;
    for (let i = 0; i < allMsgs.length; i++) {
      const m = allMsgs[i];
      const ts = m.created_at;
      if (m.direction === 'outbound') {
        const matches = TARGET_PHRASES.filter(rx => rx.test(m.body || ''));
        const adminTriggered = prevDir === 'outbound' || prevDir === null;
        const tag = adminTriggered ? '[ADMIN-TRIG/no-broker-reply]' : '[broker-reply]';
        if (matches.length > 0) {
          console.log(`\n  >>> MATCH on outbound #${i} ${tag} ${ts}`);
          console.log(`      subject: ${m.subject}`);
          console.log(`      matched patterns: ${matches.map(r => r.source).join(' | ')}`);
          // Print first 600 chars of body (HTML stripped).
          const text = (m.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          console.log(`      body[0..600]: ${text.slice(0, 600)}`);
        }
      }
      prevDir = m.direction;
    }
  }

  // 4. ALSO grep across recent admin-handoff outbounds (last 200 outbounds)
  //    for the target phrases — to find adjacent fixtures if Kevin/Ethan don't carry the shape.
  console.log(`\n════════════════════════════════════════`);
  console.log(`FALLBACK CORPUS SWEEP — last 500 outbounds across all deals`);
  console.log(`════════════════════════════════════════`);
  const { data: recent, error: recentErr } = await supabase
    .from('messages')
    .select('deal_id, subject, body, created_at, external_message_id')
    .eq('direction', 'outbound')
    .order('created_at', { ascending: false })
    .limit(500);
  if (recentErr) { console.error('recent query err', recentErr); process.exit(1); }
  console.log(`  scanning ${recent.length} outbounds`);
  const hits = [];
  for (const m of recent) {
    const matches = TARGET_PHRASES.filter(rx => rx.test(m.body || ''));
    if (matches.length > 0) {
      hits.push({ m, matches });
    }
  }
  console.log(`  HITS: ${hits.length}`);
  for (const { m, matches } of hits.slice(0, 50)) {
    const text = (m.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log(`\n  • deal=${m.deal_id} created=${m.created_at}`);
    console.log(`    subject: ${m.subject}`);
    console.log(`    matched: ${matches.map(r => r.source).join(' | ')}`);
    console.log(`    body[0..400]: ${text.slice(0, 400)}`);
  }
  console.log(`\n(showing first 50 hits; total hits ${hits.length})`);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
