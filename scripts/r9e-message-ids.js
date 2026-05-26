require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

(async () => {
  console.log('R9-E — daily_summaries FULL message_id + html_length inspection');
  console.log('='.repeat(80));

  const { data: ds } = await supabase
    .from('daily_summaries')
    .select('date_edmonton, attempted_at, completed_at, status, message_id, html_length, active_deals_count, reminders_sent')
    .order('attempted_at', { ascending: true });

  for (const r of ds) {
    console.log(`\n${r.date_edmonton}:`);
    console.log(`  attempted_at:  ${r.attempted_at}`);
    console.log(`  completed_at:  ${r.completed_at}`);
    console.log(`  duration:      ${(new Date(r.completed_at) - new Date(r.attempted_at)) / 1000}s`);
    console.log(`  message_id:    "${r.message_id}"`);
    console.log(`  html_length:   ${r.html_length}`);
    console.log(`  active_deals:  ${r.active_deals_count}`);
    console.log(`  reminders:     ${r.reminders_sent}`);
  }

  // Also check messages table for any outbound messages matching MOCK ids
  console.log('\n\n' + '='.repeat(80));
  console.log('messages table — any outbound with MOCK external_message_id?');
  console.log('='.repeat(80));
  const { data: mockMsgs } = await supabase
    .from('messages')
    .select('id, deal_id, direction, subject, external_message_id, created_at')
    .like('external_message_id', 'MOCK-%')
    .order('created_at', { ascending: false })
    .limit(50);
  console.log(`MOCK-prefixed messages: ${mockMsgs?.length || 0}`);
  for (const m of (mockMsgs || []).slice(0, 30)) {
    console.log(`  ${m.created_at.slice(0, 19)} | dir=${m.direction.padEnd(8)} | mid="${m.external_message_id}" | subj="${(m.subject || '').slice(0, 80)}"`);
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
