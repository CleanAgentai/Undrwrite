require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

(async () => {
  console.log('R9-E — messages table around each cron tick (60min window post-tick)');
  console.log('='.repeat(80));
  // 5 cron ticks: 2026-05-22T03:00:00 through 2026-05-26T03:00:00 UTC
  for (const tickIso of ['2026-05-22T03:00:00Z', '2026-05-23T03:00:00Z', '2026-05-24T03:00:00Z', '2026-05-25T03:00:00Z', '2026-05-26T03:00:00Z']) {
    const tick = new Date(tickIso);
    const tickPlus = new Date(tick.getTime() + 60 * 60 * 1000); // +60min
    const tickMinus = new Date(tick.getTime() - 5 * 60 * 1000); // -5min for race

    const { data: msgs } = await supabase
      .from('messages')
      .select('id, deal_id, direction, subject, external_message_id, created_at')
      .gte('created_at', tickMinus.toISOString())
      .lte('created_at', tickPlus.toISOString())
      .order('created_at', { ascending: true });

    console.log(`\nTick ${tickIso} (Edmonton-date ${new Date(tick.getTime() - 6*60*60*1000).toISOString().slice(0,10)}):`);
    console.log(`  messages in window [${tickMinus.toISOString().slice(11,19)}, ${tickPlus.toISOString().slice(11,19)}]: ${msgs?.length || 0}`);
    for (const m of (msgs || []).slice(0, 10)) {
      const mid = m.external_message_id ? `"${m.external_message_id.slice(0, 24)}"` : '(null)';
      console.log(`    ${m.created_at.slice(11, 19)} | ${m.direction.padEnd(8)} | mid=${mid} | subj="${(m.subject || '').slice(0, 70)}"`);
    }
  }

  // Also check: messages with sender_email = admin (Franco)
  // Sometimes "admin daily summary" is stored separately
  console.log('\n\n' + '='.repeat(80));
  console.log('messages where direction=outbound AND subject LIKE "%Daily Summary%"');
  console.log('='.repeat(80));
  const { data: dsMsgs } = await supabase
    .from('messages')
    .select('id, deal_id, direction, subject, external_message_id, created_at, body')
    .like('subject', '%Daily Summary%')
    .order('created_at', { ascending: false })
    .limit(10);
  console.log(`results: ${dsMsgs?.length || 0}`);
  for (const m of (dsMsgs || [])) {
    const mid = m.external_message_id ? `"${m.external_message_id.slice(0, 24)}"` : '(null)';
    console.log(`  ${m.created_at} | dir=${m.direction} | mid=${mid} | deal_id=${m.deal_id} | subj="${m.subject}"`);
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
