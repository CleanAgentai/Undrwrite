// R9-E Q4-a cleanup — DELETE polluted MOCK-N daily_summaries rows.
//
// Context: Pre-R9-E, test-trigger.js running across 21:00 Edmonton wrote
// daily_summaries rows with message_id=MOCK-${N} (from the emailService.sendEmail
// mock at test-trigger.js:86) and active_deals_count=1 (from the Bug A stub
// at test-trigger.js:3449). These rows blocked Render's production cron via
// the R5-F-2 UNIQUE constraint on date_edmonton, causing Franco to miss
// daily summary emails on those days.
//
// Expected pre-cleanup state (verified during R9-E empirical-grounding):
//   - 2026-05-21 (Thu) | mid=MOCK-3 | active_deals=1 | reminders=1
//   - 2026-05-22 (Fri) | mid=MOCK-5 | active_deals=1 | reminders=1
//   - 2026-05-24 (Sun) | mid=MOCK-3 | active_deals=1 | reminders=1
//
// Action: DELETE FROM daily_summaries WHERE message_id LIKE 'MOCK-%'.
//
// Post-cleanup verification: re-SELECT confirms zero MOCK-prefixed rows.
// The 3 lost daily-summary days are not reconstructed — reconstruction
// value is minimal (action info captured in messages table; AI-summary
// HTML is decorative).
//
// Run AFTER R9-E code ships clean. Not part of the code commit itself.
// Safe to re-run: idempotent (no MOCK rows on second run = zero deletes).

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

(async () => {
  console.log('R9-E Q4-a CLEANUP — DELETE MOCK-N daily_summaries rows');
  console.log('═'.repeat(80));

  // 1. Pre-cleanup snapshot
  console.log('\nSTEP 1: pre-cleanup snapshot (rows matching message_id LIKE \'MOCK-%\')');
  console.log('─'.repeat(80));
  const { data: pre, error: preErr } = await supabase
    .from('daily_summaries')
    .select('id, date_edmonton, status, message_id, active_deals_count, reminders_sent')
    .like('message_id', 'MOCK-%')
    .order('date_edmonton', { ascending: true });
  if (preErr) { console.error('ERR (pre-snapshot):', preErr.message); process.exit(1); }
  console.log(`pre-cleanup MOCK rows: ${pre.length}`);
  for (const r of pre) {
    console.log(`  ${r.date_edmonton} | status=${r.status} | mid=${r.message_id} | active_deals=${r.active_deals_count} | reminders=${r.reminders_sent}`);
  }
  if (pre.length === 0) {
    console.log('\nNo MOCK rows present — cleanup is a no-op. Exiting.');
    return;
  }

  // 2. DELETE
  console.log('\n\nSTEP 2: DELETE FROM daily_summaries WHERE message_id LIKE \'MOCK-%\'');
  console.log('─'.repeat(80));
  const { error: delErr, count } = await supabase
    .from('daily_summaries')
    .delete({ count: 'exact' })
    .like('message_id', 'MOCK-%');
  if (delErr) { console.error('ERR (delete):', delErr.message); process.exit(1); }
  console.log(`rows deleted: ${count}`);
  if (count !== pre.length) {
    console.warn(`WARN: deletion count (${count}) does not match pre-snapshot count (${pre.length}). Investigate.`);
  }

  // 3. Post-cleanup verification
  console.log('\n\nSTEP 3: post-cleanup re-SELECT verification');
  console.log('─'.repeat(80));
  const { data: post } = await supabase
    .from('daily_summaries')
    .select('id, date_edmonton, message_id')
    .like('message_id', 'MOCK-%');
  console.log(`post-cleanup MOCK rows: ${post?.length || 0}`);
  if ((post?.length || 0) !== 0) {
    console.error('FAIL: MOCK rows remain post-cleanup. Investigate.');
    process.exit(1);
  }

  // 4. Full daily_summaries audit — confirm the remaining rows are all real Postmark IDs
  console.log('\n\nSTEP 4: full daily_summaries audit (all remaining rows)');
  console.log('─'.repeat(80));
  const { data: all } = await supabase
    .from('daily_summaries')
    .select('date_edmonton, status, message_id, active_deals_count, reminders_sent')
    .order('date_edmonton', { ascending: true });
  console.log(`total remaining rows: ${all?.length || 0}`);
  for (const r of (all || [])) {
    const midPreview = r.message_id ? r.message_id.slice(0, 16) + '...' : '(null)';
    console.log(`  ${r.date_edmonton} | status=${r.status} | mid=${midPreview} | active_deals=${r.active_deals_count} | reminders=${r.reminders_sent}`);
  }

  console.log('\n═'.repeat(80));
  console.log('R9-E Q4-a CLEANUP COMPLETE');
  console.log('═'.repeat(80));
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
