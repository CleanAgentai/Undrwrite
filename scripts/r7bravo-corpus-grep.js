// R7-B + R7-C probe — pull reminder corpus for Fatima Al-Rashid (S9 / James
// Okafor) + Preethi Subramaniam (S7 / Ethan Broussard) fixtures. Confirm:
//   (1) reminder subject shape (broker's original submission vs admin-thread)
//   (2) In-Reply-To / References headers on reminders (R6-λ pattern)
//   (3) reminder body specificity — "the items we previously requested" vs
//       specific outstanding doc list (R7-C scope)
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const FIXTURES = [
  // James Okafor S9 — Fatima Al-Rashid (Prairie Mortgage Partners). Per
  // r6kappa probe seen earlier, deal 004cf263 had hourly reminders at
  // 18:30 / 19:30 / 20:30 on 2026-05-21.
  { label: 'James Okafor S9 / Fatima Al-Rashid', deal_id: '004cf263-7a41-4779-9f0b-79a28b24b91c' },
];

(async () => {
  // First locate Ethan Broussard S7 / Preethi Subramaniam deal.
  console.log('Locating Ethan Broussard / Preethi Subramaniam deals\n' + '─'.repeat(72));
  const { data: ethanDeals } = await supabase
    .from('deals')
    .select('id, borrower_name, status, created_at, prelim_approved_at')
    .ilike('borrower_name', '%Ethan%Broussard%')
    .order('created_at', { ascending: false })
    .limit(10);
  for (const d of ethanDeals || []) {
    console.log(`  • ${d.id} | ${d.borrower_name} | status=${d.status} | created=${d.created_at}`);
  }

  // Pick the most recent Ethan with Preethi as broker — check messages.
  for (const d of ethanDeals || []) {
    const { data: m } = await supabase
      .from('messages')
      .select('id, direction, subject, body')
      .eq('deal_id', d.id)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: true })
      .limit(1);
    const body = (m?.[0]?.body || '').toLowerCase();
    if (body.includes('preethi') || body.includes('ridgeline')) {
      FIXTURES.push({ label: 'Ethan Broussard S7 / Preethi Subramaniam', deal_id: d.id });
      console.log(`  → matched Preethi/Ridgeline on ${d.id}`);
      break;
    }
  }

  // For each fixture, dump full timeline + flag reminder messages.
  for (const f of FIXTURES) {
    console.log(`\n${'═'.repeat(72)}\n${f.label} — deal ${f.deal_id}\n${'═'.repeat(72)}`);
    const { data: msgs } = await supabase
      .from('messages')
      .select('direction, subject, body, created_at, external_message_id')
      .eq('deal_id', f.deal_id)
      .order('created_at', { ascending: true });
    console.log(`total messages: ${msgs.length} (${msgs.filter(m => m.direction === 'inbound').length} in + ${msgs.filter(m => m.direction === 'outbound').length} out)`);

    // Find the broker's INITIAL submission subject (msg #0 typically).
    const initialBrokerMsg = msgs.find(m => m.direction === 'inbound');
    console.log(`\nInitial broker submission subject: "${initialBrokerMsg?.subject || '(none)'}"`);
    console.log(`Initial broker MessageID: ${initialBrokerMsg?.external_message_id || '(none)'}`);

    // Flag reminder messages — body contains "items we previously requested" /
    // "check in" / "follow up" / "didn't slip through the cracks" / "close this file".
    console.log(`\n${'─'.repeat(60)}\nREMINDER MESSAGES + threading inspection\n${'─'.repeat(60)}`);
    const reminderHits = [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.direction !== 'outbound') continue;
      const text = (m.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const isReminder = /\b(items we previously requested|just wanted to check in|wanted to make sure|didn't slip through the cracks|wanted to follow up|close this file)\b/i.test(text);
      if (isReminder) reminderHits.push({ m, text, idx: i });
    }
    console.log(`  reminder count: ${reminderHits.length}`);
    for (const { m, text, idx } of reminderHits) {
      console.log(`\n  ── REMINDER #${idx} ${m.created_at} ──`);
      console.log(`     subject: ${m.subject}`);
      console.log(`     mid:     ${m.external_message_id || '(none)'}`);
      // Subject-threading inspection.
      const subjThreaded = m.subject?.startsWith('Re:') || m.subject?.includes(initialBrokerMsg?.subject?.replace(/^Re:\s*/, ''));
      const subjMatchesInitial = initialBrokerMsg?.subject && m.subject?.includes(initialBrokerMsg.subject.replace(/^Re:\s*/, ''));
      console.log(`     subject starts with "Re:" : ${m.subject?.startsWith('Re:') ? 'YES' : 'NO'}`);
      console.log(`     subject threads to initial broker submission: ${subjMatchesInitial ? 'YES' : 'NO ⚠'}`);
      console.log(`     body[0..600]: ${text.slice(0, 600)}`);

      // R7-C check: does body specify outstanding items, or use generic phrase?
      const hasGeneric = /\bitems we previously requested\b/i.test(text);
      const hasSpecific = /\b(appraisal|credit bureau|noa|t4|government[\s-]?id|payout statement|loan application|pnw)\b/i.test(text);
      console.log(`     R7-C generic "items we previously requested": ${hasGeneric ? 'YES ⚠' : 'NO'}`);
      console.log(`     R7-C specific doc names mentioned: ${hasSpecific ? 'YES' : 'NO ⚠'}`);
    }
  }

  // Also surface the reminder code path in webhook.js / cron.
  console.log(`\n\n${'═'.repeat(72)}\nCODE-PATH SEARCH — reminder/follow-up dispatch sites\n${'═'.repeat(72)}`);
  console.log('  Will be inspected via grep in next step.');
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
