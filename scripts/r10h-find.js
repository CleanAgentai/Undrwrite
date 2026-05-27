require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const ETHAN_DEAL = 'c95f3a20-162c-45cf-a98c-60b6bbb2de9a';

(async () => {
  console.log('R10-H empirical: find Vienna outbound with internal-review phrase');
  console.log('='.repeat(80));
  const { data: msgs } = await supabase
    .from('messages')
    .select('direction, subject, body, created_at')
    .eq('deal_id', ETHAN_DEAL)
    .order('created_at', { ascending: true });
  for (const m of msgs || []) {
    const body = m.body || '';
    const phrases = {
      'once we\'ve had a chance to review': /once we['']ve had a chance to review/i.test(body),
      'after our team reviews': /after our team reviews/i.test(body),
      'once the team has reviewed': /once the team has reviewed/i.test(body),
      'we\'ll review': /we['']ll review/i.test(body),
      'after internal review': /after internal review/i.test(body),
      'once we\'ve completed our review': /once we['']ve completed our review/i.test(body),
      'have a chance to review': /have a chance to review/i.test(body),
      'review everything': /review everything/i.test(body),
      'I\'ll be in touch shortly': /I['']ll be in touch shortly/i.test(body),
    };
    const hits = Object.entries(phrases).filter(([, v]) => v).map(([k]) => k);
    if (hits.length > 0) {
      console.log(`\n--- ${m.direction.toUpperCase()} | ${m.created_at.slice(0,19)} ---`);
      console.log(`subject: ${m.subject}`);
      console.log(`HITS: ${hits.join(' | ')}`);
      console.log(`body (full):`);
      console.log(body);
    }
  }
})().catch(e => { console.error(e.stack||e.message); process.exit(1); });
