// R9-E empirical-grounding — Sunday cron not firing investigation.
//
// Hypothesis: Sunday May 24 2026 21:00 Edmonton cron tick didn't fire
// (no daily summary received by Franco). Per code-side investigation:
//   - src/cron/dailySummary.js CRON_SCHEDULE = '0 21 * * *' (daily; no day-of-week filter)
//   - timezone: 'America/Edmonton' (IANA, DST-aware via node-cron)
//   - shouldFireDailySummaryNow checks hour=21 + minute=0 only (no day-of-week)
//   - daily_summaries table UNIQUE on date_edmonton (atomic idempotency)
//   - status enum: pending / sent / failed (per migration docblock)
//
// Diagnostic tasks:
//   (1) Past 8 weeks of daily_summaries records — day-of-week distribution
//       Does Sunday firing ever work? Is May 24 the only Sunday missing?
//   (2) May 24 specifically: any record at all (pending/sent/failed)?
//       - YES record + status=sent → cron fired + email sent (Franco missed/spam?)
//       - YES record + status=failed → cron fired + send failed (downstream bug)
//       - YES record + status=pending → cron fired + crashed before finalize
//       - NO record → cron didn't fire at all (schedule-level issue)
//   (3) Neighboring days (Sat May 23, Mon May 25) for control comparison
//   (4) Earliest record in table — when was first daily summary stored?
//       (table created 2026-05-21; earlier days had no records pre-migration)

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

(async () => {
  console.log('R9-E EMPIRICAL GROUNDING — Sunday cron not firing investigation');
  console.log('═'.repeat(80));

  // 1. Schema discovery
  console.log('\nSTRATEGY 1: daily_summaries schema sample');
  console.log('─'.repeat(80));
  const { data: schemaSample } = await supabase
    .from('daily_summaries')
    .select('*')
    .limit(1);
  if (schemaSample && schemaSample[0]) {
    const cols = Object.keys(schemaSample[0]);
    console.log(`daily_summaries columns (${cols.length}):`);
    for (const c of cols) console.log(`  - ${c}`);
  } else {
    console.log('daily_summaries: NO ROWS (table is empty)');
  }

  // 2. Full corpus
  console.log('\n\nSTRATEGY 2: full daily_summaries corpus (last 90 days)');
  console.log('─'.repeat(80));
  const { data: rows, error } = await supabase
    .from('daily_summaries')
    .select('id, date_edmonton, attempted_at, completed_at, status, message_id, active_deals_count, reminders_sent, error_message')
    .order('date_edmonton', { ascending: true });

  if (error) {
    console.error('ERR:', error.message);
    return;
  }

  console.log(`total rows: ${rows.length}`);
  if (rows.length === 0) {
    console.log('TABLE EMPTY — table created 2026-05-21 migration; first row indicates first successful claim');
    return;
  }
  console.log(`earliest: ${rows[0].date_edmonton} (attempted: ${rows[0].attempted_at})`);
  console.log(`latest:   ${rows[rows.length - 1].date_edmonton} (attempted: ${rows[rows.length - 1].attempted_at})`);

  // 3. Day-of-week distribution
  console.log('\n\nSTRATEGY 3: day-of-week distribution');
  console.log('─'.repeat(80));
  const dowCount = { Sun: 0, Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0 };
  const dowMap = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (const r of rows) {
    // Parse date_edmonton as YYYY-MM-DD; need to interpret as Edmonton date.
    // For day-of-week purposes, treat as local date (parse as YYYY-MM-DD with UTC).
    const d = new Date(r.date_edmonton + 'T12:00:00Z'); // noon UTC = safe across DST
    dowCount[dowMap[d.getUTCDay()]]++;
  }
  console.log(`distribution: ${JSON.stringify(dowCount)}`);

  // 4. May 24 + neighbors
  console.log('\n\nSTRATEGY 4: target dates inspection (May 23 / 24 / 25)');
  console.log('─'.repeat(80));
  const targetDates = ['2026-05-22', '2026-05-23', '2026-05-24', '2026-05-25', '2026-05-26'];
  for (const d of targetDates) {
    const row = rows.find(r => r.date_edmonton === d);
    const dow = dowMap[new Date(d + 'T12:00:00Z').getUTCDay()];
    if (row) {
      console.log(`  ${d} (${dow}): STATUS=${row.status} attempted=${row.attempted_at} completed=${row.completed_at} active_deals=${row.active_deals_count} reminders=${row.reminders_sent} error=${row.error_message || '(none)'}`);
    } else {
      console.log(`  ${d} (${dow}): NO ROW — cron either didn't fire OR claimDailySummarySlot was never called`);
    }
  }

  // 5. Full table dump (small enough since table started 2026-05-21)
  console.log('\n\nSTRATEGY 5: every row (chronological)');
  console.log('─'.repeat(80));
  for (const r of rows) {
    const dow = dowMap[new Date(r.date_edmonton + 'T12:00:00Z').getUTCDay()];
    console.log(`  ${r.date_edmonton} (${dow}) | status=${r.status.padEnd(7)} | attempted=${r.attempted_at} | completed=${r.completed_at || '(null)'} | reminders=${r.reminders_sent ?? '(null)'} | err=${r.error_message || '(none)'}`);
  }

  // 6. Pending or failed (anomaly markers)
  console.log('\n\nSTRATEGY 6: pending/failed anomalies');
  console.log('─'.repeat(80));
  const anomalies = rows.filter(r => r.status !== 'sent');
  console.log(`anomalies (status != 'sent'): ${anomalies.length}`);
  for (const a of anomalies) {
    const dow = dowMap[new Date(a.date_edmonton + 'T12:00:00Z').getUTCDay()];
    console.log(`  ${a.date_edmonton} (${dow}) | status=${a.status} | error=${a.error_message || '(none)'}`);
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
