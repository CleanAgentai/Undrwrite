// R6-κ probe — direct timeline pull for James S9 (deal 004cf263).
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const TARGET = '004cf263-7a41-4779-9f0b-79a28b24b91c';

(async () => {
  const { data: msgs } = await supabase
    .from('messages')
    .select('id, direction, subject, body, external_message_id, created_at')
    .eq('deal_id', TARGET)
    .order('created_at', { ascending: true });

  if (!msgs || msgs.length === 0) { console.log('no messages for deal', TARGET); process.exit(1); }
  console.log(`deal ${TARGET}: ${msgs.length} messages (${msgs.filter(m => m.direction === 'inbound').length} in + ${msgs.filter(m => m.direction === 'outbound').length} out)\n`);

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const text = (m.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log(`────────────── #${i} ${m.direction.toUpperCase()} ${m.created_at} ──────────────`);
    console.log(`  subject: ${m.subject}`);
    console.log(`  mid:     ${m.external_message_id || '(none)'}`);
    console.log(`  body[0..1200]:`);
    console.log(`    ${text.slice(0, 1200)}`);
    console.log();
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
