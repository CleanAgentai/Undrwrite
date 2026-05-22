// Probe Eric Johansson S15 R4 deal to confirm parallel bug shape.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

(async () => {
  const ERIC_DEAL = '11196627-4e3b-499a-98b8-3bee73f3cd66';
  const { data: deal } = await supabase.from('deals').select('id, borrower_name, extracted_data').eq('id', ERIC_DEAL).single();
  console.log(`Eric Johansson deal ${ERIC_DEAL}`);
  const ed = deal?.extracted_data || {};
  console.log(`  broker_name: ${JSON.stringify(ed.broker_name)}`);
  console.log(`  sender_name: ${JSON.stringify(ed.sender_name)}`);
  console.log(`  sender_type: ${JSON.stringify(ed.sender_type)}`);
  console.log(`  name_collides_with_admin: ${JSON.stringify(ed.name_collides_with_admin)}`);
  console.log(`  borrower_name: ${JSON.stringify(ed.borrower_name)}`);

  const { data: msgs } = await supabase
    .from('messages')
    .select('direction, subject, body, created_at')
    .eq('deal_id', ERIC_DEAL)
    .order('created_at', { ascending: true });
  console.log(`  messages: ${msgs.length} (${msgs.filter(m=>m.direction==='outbound').length} out)`);
  // Check outbound greetings.
  for (const m of msgs.filter(m=>m.direction==='outbound')) {
    const text = (m.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const greeting = text.match(/^(Hi [^!,]+!?|Hello[^!,]*!?|Hey [^!,]+!?)/i)?.[1] || '(no greeting)';
    console.log(`    ${m.created_at} → greeting: "${greeting}"`);
  }
})().catch(e => console.error(e.message));
