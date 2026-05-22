// R6-α probe — find Derek deal(s) with the "$452K vs $110K hallucination loop"
// pattern. Vienna insists the loan_application shows $452K when broker says
// $110K across 3 broker exchanges. Empirical-grounding scope.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

(async () => {
  // 1. All Derek deals (most-recent first).
  console.log('STRATEGY 1: Derek deals by borrower_name\n' + '─'.repeat(72));
  const { data: dealMatch } = await supabase
    .from('deals')
    .select('id, borrower_name, status, created_at, prelim_approved_at')
    .ilike('borrower_name', '%Derek%')
    .order('created_at', { ascending: false })
    .limit(15);
  console.log(`Derek deals: ${dealMatch?.length || 0}`);
  for (const d of dealMatch || []) {
    console.log(`  • ${d.id} | ${d.borrower_name} | status=${d.status} | created=${d.created_at} | prelim_approved=${d.prelim_approved_at}`);
  }

  // 2. Grep all outbounds for the literal $452,000 / $452K numbers — narrow
  //    to Derek deals.
  console.log(`\nSTRATEGY 2: outbounds across Derek deals containing $452,000 / 452K / 452,000\n${'─'.repeat(72)}`);
  const dealIds = (dealMatch || []).map(d => d.id);
  if (dealIds.length === 0) { console.log('no Derek deals to scan'); process.exit(0); }

  const { data: outbounds } = await supabase
    .from('messages')
    .select('deal_id, direction, subject, body, created_at')
    .in('deal_id', dealIds)
    .order('created_at', { ascending: true });
  console.log(`total messages across Derek deals: ${outbounds.length}`);

  const hits452 = [];
  for (const m of outbounds) {
    const body = m.body || '';
    if (/\$?\s*452[,\s]*000|452K\b|\$\s*110[,\s]*000|110K\b/i.test(body)) {
      hits452.push(m);
    }
  }
  console.log(`messages mentioning 452K OR 110K: ${hits452.length}`);
  for (const m of hits452) {
    const text = (m.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const idx452 = text.toLowerCase().search(/452[,\s]*000|452k/i);
    const idx110 = text.toLowerCase().search(/110[,\s]*000|110k/i);
    const ctx452 = idx452 > 0 ? text.slice(Math.max(0, idx452 - 100), Math.min(text.length, idx452 + 200)) : '(no 452 hit)';
    const ctx110 = idx110 > 0 ? text.slice(Math.max(0, idx110 - 100), Math.min(text.length, idx110 + 200)) : '(no 110 hit)';
    console.log(`\n──────── ${m.direction.toUpperCase()} ${m.created_at} (deal ${m.deal_id.slice(0, 8)}…) ────────`);
    console.log(`  subject: ${m.subject}`);
    console.log(`  $452 context: ${ctx452}`);
    console.log(`  $110 context: ${ctx110}`);
  }

  // 3. Search by subject for "hallucination" / persistent-claim / "I see" /
  //    "according to the loan application" patterns across Derek deals.
  console.log(`\n\nSTRATEGY 3: persistent-claim phrasing across Derek outbounds\n${'─'.repeat(72)}`);
  const patternHits = [];
  for (const m of outbounds.filter(x => x.direction === 'outbound')) {
    const body = (m.body || '').replace(/<[^>]+>/g, ' ');
    const persistent = [
      /the loan application shows[^.]{0,80}/i,
      /according to the loan application[^.]{0,80}/i,
      /the loan app shows[^.]{0,80}/i,
      /I'm seeing[^.]{0,80}/i,
      /our records show[^.]{0,80}/i,
      /the application indicates[^.]{0,80}/i,
    ];
    for (const p of persistent) {
      const matches = body.match(p);
      if (matches) patternHits.push({ m, pattern: p.source.slice(0, 30), text: matches[0] });
    }
  }
  console.log(`persistent-claim phrasing hits: ${patternHits.length}`);
  for (const h of patternHits.slice(0, 25)) {
    console.log(`  deal=${h.m.deal_id.slice(0, 8)}… created=${h.m.created_at}`);
    console.log(`    pattern: ${h.pattern}`);
    console.log(`    text: "${h.text}"`);
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
