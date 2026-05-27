// R10-I empirical-grounding — Kevin Tran (Scenario 6) + Ethan Broussard
// (Scenario 7) production-fixture inventory for formatted-lender-package.
// Goals: find Franco's empirical artifact-needs signal in the message
// thread; identify any place where Franco asked-for/expected a "package"
// to broker; inventory the close-out emails to confirm what currently
// ships at file-complete; map the gap between R9-G (admin-side zip at
// completion) and Bug 6-? + 7-6 (broker-facing lender package).

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const KEVIN_DEAL = '178d714e'; // Kevin Tran S6 (from R6-η empirical anchor in commits)
const ETHAN_DEAL = 'c95f3a20-162c-45cf-a98c-60b6bbb2de9a'; // Ethan Broussard S7 (R10-H + R10-G empirical)

(async () => {
  console.log('R10-I EMPIRICAL — Kevin Tran + Ethan Broussard lender-package signal');
  console.log('='.repeat(80));

  for (const [label, prefix] of [['ETHAN', ETHAN_DEAL], ['KEVIN', KEVIN_DEAL]]) {
    let deal;
    if (prefix.includes('-')) {
      const { data: d } = await supabase.from('deals').select('id, borrower_name, status, ltv, ownership_type, extracted_data, prelim_approved_at, created_at').eq('id', prefix).single();
      deal = d;
    } else {
      const { data: d } = await supabase.from('deals').select('id, borrower_name, status, ltv, ownership_type, extracted_data, prelim_approved_at, created_at').ilike('id', prefix + '%').limit(1).single();
      deal = d;
    }
    if (!deal) { console.log(`\n${label}: NOT FOUND`); continue; }
    console.log(`\n${'='.repeat(80)}\n${label} — ${deal.id}  ${deal.borrower_name}  status=${deal.status}  ltv=${deal.ltv}`);
    console.log(`prelim_approved_at: ${deal.prelim_approved_at || '(none)'}`);

    const { data: msgs } = await supabase.from('messages')
      .select('id, direction, subject, body, created_at')
      .eq('deal_id', deal.id)
      .order('created_at', { ascending: true });
    console.log(`messages: ${msgs.length}`);
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      console.log(`  [${i}] ${m.direction.toUpperCase()} ${m.created_at.slice(0,19)} | ${(m.subject||'').slice(0,90)}`);
    }

    const { data: docs } = await supabase.from('documents')
      .select('file_name, classification')
      .eq('deal_id', deal.id);
    console.log(`docs: ${docs.length}`);
    for (const d of docs) console.log(`  [${d.classification || 'unclassified'}] ${d.file_name}`);

    // Search the inbound corpus for package-shaped requests
    console.log(`\n  LENDER-PACKAGE SIGNAL SCAN (inbound only):`);
    const packagePhrases = [
      /lender\s*package/i,
      /deal\s*package/i,
      /submission\s*package/i,
      /package.*lender/i,
      /send.*to\s+(?:the\s+)?lender/i,
      /forward.*lender/i,
      /complete.*package/i,
      /finished.*deal/i,
      /(?:deal|file)\s+(?:summary|writeup|write-up)/i,
      /everything\s+(?:I|we)\s+need/i,
    ];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.direction !== 'inbound') continue;
      const body = m.body || '';
      const hits = packagePhrases.filter(re => re.test(body));
      if (hits.length > 0) {
        console.log(`    msg[${i}] INBOUND HITS ${hits.length}`);
        for (const re of hits) {
          const match = body.match(re);
          if (match) {
            const idx = body.indexOf(match[0]);
            console.log(`      "${match[0]}" — ctx: ${body.slice(Math.max(0,idx-60), idx+120).replace(/\s+/g,' ').slice(0,200)}`);
          }
        }
      }
    }

    // Inventory the LAST outbound — what is currently sent at close-out?
    const lastOut = msgs.filter(m => m.direction === 'outbound').slice(-1)[0];
    if (lastOut) {
      console.log(`\n  LAST OUTBOUND — ${lastOut.created_at.slice(0,19)} | ${lastOut.subject}`);
      console.log(`  body (first 1200 chars):`);
      console.log(`  ${(lastOut.body || '').slice(0, 1200).replace(/\s+/g,' ')}`);
    }

    // Inventory all CLOSE-OUT shaped outbounds (File Complete / Conditions Fulfilled / Ready to Close)
    console.log(`\n  CLOSE-OUT SHAPED OUTBOUNDS:`);
    const closeoutShape = /File Complete|Conditions Fulfilled|Ready to Close|file is complete/i;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.direction !== 'outbound') continue;
      if (closeoutShape.test(m.subject || '') || closeoutShape.test(m.body || '')) {
        console.log(`    msg[${i}] ${m.created_at.slice(0,19)} | ${m.subject}`);
      }
    }
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
