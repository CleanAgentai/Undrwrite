require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

(async () => {
  console.log('R9-E FOLLOWUP — Sunday active_deals anomaly');
  console.log('='.repeat(80));

  // 1. Get every daily_summaries row with html_length + message_id
  const { data: ds } = await supabase
    .from('daily_summaries')
    .select('date_edmonton, status, html_length, message_id, active_deals_count')
    .order('date_edmonton', { ascending: true });
  console.log('\ndaily_summaries with html_length + message_id:');
  for (const r of ds) {
    const mid = r.message_id ? r.message_id.slice(0, 12) + '...' : '(null)';
    console.log(`  ${r.date_edmonton} | status=${r.status} | html_len=${r.html_length} | active_deals=${r.active_deals_count} | mid=${mid}`);
  }

  // 2. Inspect deals table — how many "active" deals exist now? And what's the status distribution?
  console.log('\n\ndeals table — status distribution (current):');
  const { data: allDeals } = await supabase
    .from('deals')
    .select('id, status, created_at, updated_at');
  const statusDist = {};
  for (const d of allDeals) statusDist[d.status] = (statusDist[d.status] || 0) + 1;
  console.log('  total deals:', allDeals.length);
  console.log('  status distribution:', JSON.stringify(statusDist, null, 2));

  // 3. What status values does getActiveDeals() return? Look at the code
  const { execSync } = require('child_process');
  console.log('\n\ngetActiveDeals + getRecentMessages source:');
  const grep = (pattern, file, n) => {
    try {
      return execSync(`grep -nE "${pattern}" ${file} 2>/dev/null | head -${n} || true`).toString().trim();
    } catch { return ''; }
  };
  console.log(grep('getActiveDeals|getRecentMessages', 'src/services/deals.js', 30));

  // 4. What deals existed on Sunday May 24 21:00 Edmonton (= 2026-05-25T03:00:00 UTC)?
  // Active = not in terminal states; need to know exact list.
  // Deals created BEFORE Sunday + still in active state at that point.
  // We can approximate by looking at created_at + status. But terminal-state
  // transitions don't have a "transitioned_at" we can backtrack from.
  console.log('\n\ndeals created before Sunday 03:00 UTC May 25 (cumulative active candidates):');
  const before = allDeals.filter(d => new Date(d.created_at) < new Date('2026-05-25T03:00:00Z'));
  const byStatusBefore = {};
  for (const d of before) byStatusBefore[d.status] = (byStatusBefore[d.status] || 0) + 1;
  console.log('  count:', before.length);
  console.log('  current-status distribution:', JSON.stringify(byStatusBefore, null, 2));
  // Note: these are CURRENT statuses; some may have transitioned since Sunday.

  // 5. Check messages table for recent activity around Sunday
  console.log('\n\nmessages in 24h pre-Sunday-cron (2026-05-24T03:00:00Z to 2026-05-25T03:00:00Z):');
  const { data: msgs } = await supabase
    .from('messages')
    .select('id, deal_id, direction, subject, created_at')
    .gte('created_at', '2026-05-24T03:00:00Z')
    .lte('created_at', '2026-05-25T03:00:00Z')
    .order('created_at', { ascending: false });
  console.log('  total messages in window:', msgs?.length || 0);
  const dirDist = {};
  for (const m of (msgs || [])) dirDist[m.direction] = (dirDist[m.direction] || 0) + 1;
  console.log('  direction distribution:', JSON.stringify(dirDist));

  // 6. Compare to neighboring days
  console.log('\n\nmessages in 24h pre-each-cron (per day):');
  for (const day of ['2026-05-22T03:00:00Z', '2026-05-23T03:00:00Z', '2026-05-24T03:00:00Z', '2026-05-25T03:00:00Z', '2026-05-26T03:00:00Z']) {
    const dayStart = new Date(day);
    const dayPrev = new Date(dayStart.getTime() - 24 * 60 * 60 * 1000);
    const { count } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', dayPrev.toISOString())
      .lte('created_at', dayStart.toISOString());
    console.log(`  ${dayPrev.toISOString().slice(0, 10)} → ${day.slice(0, 10)}: ${count} messages`);
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
