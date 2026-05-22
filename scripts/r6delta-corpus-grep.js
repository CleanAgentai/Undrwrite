// R6-δ probe — pull admin Snapshot outbounds for Patricia S5 + Kevin S6 +
// Sandra S8 fixtures to identify the residual TBD rows post R6-β-A.
// Looking for: City / Province TBD, Loan Term TBD, LTV TBD (residual scope
// after R6-β-A closed loan_amount + property_value cascade).
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Seed names per project notes:
//  - Patricia S5 — Patricia/Aisha 6507de12 per R6-γ fixture comments
//  - Kevin S6   — Kevin Tran 178d714e per R6-ζ fixture comments
//  - Sandra S8  — Sandra Fletcher (Bayside Lending) per R6-β harness comment
const SEEDS = [
  { label: 'Patricia S5', borrower: 'Patricia',  hint_id: '6507de12' },
  { label: 'Kevin S6',    borrower: 'Kevin Tran', hint_id: '178d714e' },
  { label: 'Sandra S8',   borrower: 'Sandra Fletcher', hint_id: null },
];

(async () => {
  for (const { label, borrower, hint_id } of SEEDS) {
    console.log(`\n${'═'.repeat(72)}\n${label} — borrower=${borrower}  hint_id=${hint_id || '(none)'}\n${'═'.repeat(72)}`);

    // Resolve deal_id via borrower name + recent + status.
    const { data: dealMatch } = await supabase
      .from('deals')
      .select('id, borrower_name, status, created_at, prelim_approved_at')
      .ilike('borrower_name', `%${borrower}%`)
      .order('created_at', { ascending: false })
      .limit(10);
    console.log(`  deals matched: ${dealMatch?.length || 0}`);
    for (const d of dealMatch || []) {
      const mark = hint_id && d.id.startsWith(hint_id) ? ' ← matches hint_id' : '';
      console.log(`    • ${d.id} | ${d.borrower_name} | status=${d.status} | ${d.created_at}${mark}`);
    }

    // Pick the deal that matches hint_id if available, else most recent.
    let deal = (dealMatch || []).find(d => hint_id && d.id.startsWith(hint_id));
    if (!deal) {
      // Try by message subject search (some deals may have been deleted from deals table but messages remain).
      const { data: msgMatch } = await supabase
        .from('messages')
        .select('deal_id, subject, created_at')
        .ilike('subject', `%${borrower}%`)
        .order('created_at', { ascending: false })
        .limit(5);
      const dealIdSet = new Set((msgMatch || []).map(m => m.deal_id));
      console.log(`  unique deal_ids via message subject: ${dealIdSet.size}`);
      for (const d of dealIdSet) console.log(`    • via-msg deal=${d}`);
      if (hint_id) {
        const matchByHint = [...dealIdSet].find(id => id.startsWith(hint_id));
        if (matchByHint) deal = { id: matchByHint, borrower_name: borrower };
      }
      if (!deal && msgMatch && msgMatch.length > 0) {
        deal = { id: msgMatch[0].deal_id, borrower_name: borrower };
      }
    }
    if (!deal) { console.log('  NO DEAL FOUND'); continue; }
    console.log(`  resolving on deal_id=${deal.id}`);

    // Pull outbounds with "PRELIMINARY Review" or "COMPLETE Review" subject —
    // those are the admin Snapshot dispatches.
    const { data: msgs } = await supabase
      .from('messages')
      .select('id, direction, subject, body, created_at')
      .eq('deal_id', deal.id)
      .eq('direction', 'outbound')
      .or('subject.ilike.%PRELIMINARY Review%,subject.ilike.%COMPLETE Review%')
      .order('created_at', { ascending: true });

    if (!msgs || msgs.length === 0) {
      console.log('  NO admin Snapshot outbound found');
      continue;
    }
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const text = (m.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      console.log(`\n  ── Snapshot #${i} ${m.created_at} ──`);
      console.log(`     subject: ${m.subject}`);
      // Extract Deal Snapshot block — typically first 1500 chars contain the Snapshot section.
      // Find "Deal Snapshot" anchor + grab up to "Borrower Overview" or 2000 chars.
      const snapStart = text.indexOf('Deal Snapshot');
      const snapEnd = (() => {
        if (snapStart < 0) return Math.min(1500, text.length);
        const overviewIdx = text.indexOf('Borrower Overview', snapStart);
        return overviewIdx > 0 ? overviewIdx : Math.min(snapStart + 1500, text.length);
      })();
      const snapText = snapStart >= 0 ? text.slice(snapStart, snapEnd) : text.slice(0, 1500);
      console.log(`     snapshot block: ${snapText}`);

      // Specifically flag the residual TBD rows.
      const tbdHits = [];
      if (/City\s*\/?\s*Province\s*:?\s*TBD/i.test(snapText)) tbdHits.push('City/Province');
      if (/Loan Term\s*(Requested)?\s*:?\s*TBD/i.test(snapText)) tbdHits.push('Loan Term');
      if (/\bLTV\s*:?\s*TBD/i.test(snapText)) tbdHits.push('LTV');
      if (/Loan Amount\s*(Requested)?\s*:?\s*TBD/i.test(snapText)) tbdHits.push('Loan Amount');
      if (/Appraised Value\s*:?\s*TBD/i.test(snapText)) tbdHits.push('Appraised Value');
      if (/Property Address\s*:?\s*TBD/i.test(snapText)) tbdHits.push('Property Address');
      if (/Mortgage Position\s*:?\s*TBD/i.test(snapText)) tbdHits.push('Mortgage Position');
      if (/Ownership Type\s*:?\s*TBD/i.test(snapText)) tbdHits.push('Ownership Type');
      console.log(`     TBD-rows: ${tbdHits.length === 0 ? '(none)' : tbdHits.join(', ')}`);
    }

    // Also pull the original broker submission body to identify the source signals.
    const { data: inbound } = await supabase
      .from('messages')
      .select('subject, body, created_at')
      .eq('deal_id', deal.id)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: true })
      .limit(1);
    if (inbound && inbound[0]) {
      const text = (inbound[0].body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      console.log(`\n  ── INITIAL broker inbound — source signals ──`);
      console.log(`     subject: ${inbound[0].subject}`);
      console.log(`     body[0..1500]: ${text.slice(0, 1500)}`);
    }
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
