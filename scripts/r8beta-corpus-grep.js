// R8-B empirical-grounding — "Perfect"-as-opener corpus grep.
//
// Franco S15 retest framing: "this bug has appeared across multiple scenarios".
// Goal: surface ALL Vienna-outbound broker-facing messages whose body opens
// with "Perfect" (any punctuation: !, ., comma, em-dash, etc.). Cross-deal,
// cross-round, to identify the empirical leak surface.
//
// Anchor: Nadia S15 msg #2 "Perfect — thank you for the clarification!"
// (deal 0dbd9547-437c-4c0e-ae92-bf2d4c0798e8).
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const stripHtml = s => (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
// Match "Perfect" at the start of the cleaned body — TWO shapes observed in
// corpus:
//   Shape A (Nadia S15): "Hi there! Perfect — thank you for the clarification!"
//                        — Perfect as SECOND-position opener AFTER a greeting
//   Shape B (Mateen / Norris): "Perfect, <Name>!" / "Perfect, thanks <Name>!"
//                              — Perfect as ABSOLUTE first word, comma-delimited
// Both share the "Perfect" + trailing-punctuation-or-space pattern; differ
// only in whether a greeting prefix precedes.
const PERFECT_OPENER_RE = /^\s*(Hi\b[^!.,]{0,40}[!.,]\s*|Hello\b[^!.,]{0,40}[!.,]\s*|Hey\b[^!.,]{0,40}[!.,]\s*)?Perfect\s*[!.,\-–—…\s]/i;
const isPerfectOpener = body => PERFECT_OPENER_RE.test(stripHtml(body).slice(0, 80));

(async () => {
  console.log('R8-B EMPIRICAL GROUNDING — "Perfect"-as-opener corpus grep');
  console.log('═'.repeat(72));

  // 1. Verify Nadia S15 anchor.
  console.log('\nSTRATEGY 1: verify Nadia S15 msg #2 anchor');
  console.log('─'.repeat(72));
  const NADIA_DEAL = '0dbd9547-437c-4c0e-ae92-bf2d4c0798e8';
  const { data: nadiaDeal } = await supabase
    .from('deals')
    .select('id, borrower_name, status, extracted_data, created_at')
    .eq('id', NADIA_DEAL)
    .single();
  if (!nadiaDeal) {
    console.log('  WARN: Nadia deal not found at expected ID; searching by name…');
    const { data: byName } = await supabase
      .from('deals')
      .select('id, borrower_name, status, created_at, extracted_data')
      .or('borrower_name.ilike.%Anna%Bergstrom%,borrower_name.ilike.%Nadia%')
      .order('created_at', { ascending: false })
      .limit(5);
    for (const d of byName || []) {
      const brokerName = d.extracted_data?.broker_name || '(none)';
      console.log(`    ${d.id} | ${d.borrower_name} | broker=${brokerName} | ${d.created_at}`);
    }
  } else {
    console.log(`  Nadia deal: ${NADIA_DEAL} | borrower=${nadiaDeal.borrower_name} | broker_name=${nadiaDeal.extracted_data?.broker_name} | created=${nadiaDeal.created_at}`);
    const { data: nadiaMsgs } = await supabase
      .from('messages')
      .select('direction, subject, body, created_at')
      .eq('deal_id', NADIA_DEAL)
      .order('created_at', { ascending: true });
    console.log(`  total messages: ${nadiaMsgs?.length || 0}`);
    for (let i = 0; i < (nadiaMsgs?.length || 0); i++) {
      const m = nadiaMsgs[i];
      const text = stripHtml(m.body);
      const opener = text.slice(0, 80);
      const isOpener = isPerfectOpener(m.body);
      const flag = m.direction === 'outbound' && isOpener ? ' ⚠ PERFECT-OPENER' : '';
      console.log(`    #${i} ${m.direction.toUpperCase()} ${m.created_at} → "${opener}…"${flag}`);
    }
  }

  // 2. Cross-deal corpus grep.
  console.log('\n\nSTRATEGY 2: cross-deal "Perfect"-as-opener corpus grep');
  console.log('═'.repeat(72));
  // Pull all outbound messages. We grep client-side rather than via PostgREST
  // regex to avoid HTML-encoding edge cases.
  const { data: allOutbound, error } = await supabase
    .from('messages')
    .select('id, deal_id, direction, subject, body, created_at')
    .eq('direction', 'outbound')
    .order('created_at', { ascending: false });
  if (error) {
    console.error('ERROR:', error.message);
    process.exit(1);
  }
  console.log(`  total outbound messages: ${allOutbound.length}`);

  const hits = [];
  for (const m of allOutbound) {
    if (isPerfectOpener(m.body)) {
      hits.push({
        id: m.id,
        deal_id: m.deal_id,
        created_at: m.created_at,
        subject: m.subject,
        opener: stripHtml(m.body).slice(0, 120),
      });
    }
  }
  console.log(`  "Perfect"-as-opener hits: ${hits.length}`);
  if (hits.length === 0) {
    console.log('  (no hits)');
  } else {
    console.log();
    // Group hits by deal_id; pull deal context for each.
    const byDeal = {};
    for (const h of hits) {
      if (!byDeal[h.deal_id]) byDeal[h.deal_id] = [];
      byDeal[h.deal_id].push(h);
    }
    const dealIds = Object.keys(byDeal);
    const { data: dealContexts } = await supabase
      .from('deals')
      .select('id, borrower_name, status, created_at, extracted_data')
      .in('id', dealIds);
    const ctxById = Object.fromEntries((dealContexts || []).map(d => [d.id, d]));
    for (const dealId of dealIds) {
      const ctx = ctxById[dealId] || {};
      const broker = ctx.extracted_data?.broker_name || '(none)';
      const sender = ctx.extracted_data?.sender_name || '(none)';
      console.log(`\n  Deal ${dealId}`);
      console.log(`    borrower=${ctx.borrower_name} | broker=${broker} | sender=${sender} | status=${ctx.status} | created=${ctx.created_at}`);
      for (const h of byDeal[dealId]) {
        console.log(`    [${h.created_at}] "${h.subject}"`);
        console.log(`      "${h.opener}"`);
      }
    }
  }

  // 3. Per-round/per-fixture breakdown (cluster the deals by created_at month + borrower name).
  console.log('\n\nSTRATEGY 3: temporal distribution of "Perfect"-as-opener hits');
  console.log('═'.repeat(72));
  const monthBuckets = {};
  for (const h of hits) {
    const month = h.created_at.slice(0, 7);
    if (!monthBuckets[month]) monthBuckets[month] = 0;
    monthBuckets[month]++;
  }
  for (const month of Object.keys(monthBuckets).sort()) {
    console.log(`  ${month}: ${monthBuckets[month]} hit(s)`);
  }

  // 4. R6-ζ overlap check — how many "Perfect" openers ALSO match R6-ζ's
  //    forbidden-non-sequitur block pattern (i.e., admin-approval branch
  //    triggered, no broker reply since Vienna outbound)?
  console.log('\n\nSTRATEGY 4: R6-ζ overlap — "Perfect" + thanks-for-confirming compound shape');
  console.log('═'.repeat(72));
  const r6zOverlap = hits.filter(h =>
    /Perfect.*(thanks for|appreciate|confirm)/i.test(h.opener)
  );
  console.log(`  hits matching "Perfect ... (thanks for | appreciate | confirm)": ${r6zOverlap.length}`);
  for (const h of r6zOverlap) {
    console.log(`    [${h.created_at}] ${h.opener.slice(0, 100)}`);
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
