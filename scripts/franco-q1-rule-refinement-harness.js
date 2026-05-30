#!/usr/bin/env node
// FRANCO-Q1-RULE-REFINEMENT harness (Franco 2026-05-30). "Refinance and pay-out the
// existing mortgage are definitionally the same." A CONFIDENT refinance + lender match
// fires the carve-out WITHOUT explicit payout language. payoutConfirmed branch preserved
// (defense-in-depth). Confidence guards (ambiguous refi-vs-purchase, non-payout contra)
// keep those on the additive→escalate path.
const cf = require('../src/services/canonical-fields.js');
const de = require('../src/services/discrepancy-engine.js');
let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };

// ── Part A: extraction tags refinanceConfident correctly ──
const conf = (body) => {
  const m = cf.extractCanonicalFields(body, [], { brokerBodyText: body });
  const t = (m.transaction_type || []).find(x => x.value === 'refinance');
  return t ? t.refinanceConfident : null;
};
console.log('[A] extraction — refinanceConfident tagging');
ok('terse "Refi ... refinancing the existing RBC mortgage" → confident', conf('Refi for Sarah Chen, refinancing the existing RBC mortgage. Loan $525k.') === true);
ok('default-from-purchase-absence (terse "Refi") → confident', conf('Refi for Marcus Webb. Loan $280k against $650k.') === true);
ok('ambiguous "either refinancing or buying, depending on appraisal" → NOT confident', conf('We are either refinancing or buying a new place, depending on the appraisal.') === false);
ok('non-payout contra "second mortgage" → NOT confident', conf('Refinance for Marcus, second mortgage behind the existing RBC first.') === false);
ok('non-payout contra "existing stays in place" → NOT confident', conf('Refinancing the existing TD mortgage but the existing first stays in place.') === false);

// ── Part B: computeCombinedLtv branches ──
const mk = (over = {}) => ({
  existing_first_mortgage_balance: [{ value: 400000, source: 'mortgage_statement' }],
  requested_loan_amount: [{ value: 510000 }],
  subject_property_market_value: [{ value: 850000 }],
  existing_first_mortgage_lender: [{ value: 'RBC', classification: 'mortgage_statement' }],
  transaction_type: [{ value: 'refinance', rawPhrase: 'refinancing the existing RBC mortgage', payoutConfirmed: false, refinanceConfident: true }],
  ...over,
});
const stand = Math.round(510000 / 850000 * 100 * 10) / 10; // 60.0
const additive = Math.round((400000 + 510000) / 850000 * 100 * 10) / 10; // 107.1

console.log('[B] computeCombinedLtv');
ok('BRANCH 1 preserved: payoutConfirmed=true + lender → carve-out (standalone 60%)',
   de.computeCombinedLtv(mk({ transaction_type: [{ value: 'refinance', rawPhrase: 'RBC', payoutConfirmed: true, refinanceConfident: false }] })).combined_ltv_percent === stand);
ok('BRANCH 2 NEW: refinanceConfident + lender, NO payout → carve-out (standalone 60%) [A14 shape]',
   de.computeCombinedLtv(mk()).combined_ltv_percent === stand);
ok('ambiguous (refinanceConfident=false, no payout) → ADDITIVE (escalate path)',
   de.computeCombinedLtv(mk({ transaction_type: [{ value: 'refinance', rawPhrase: '', payoutConfirmed: false, refinanceConfident: false }] })).combined_ltv_percent === additive);
ok('confident refinance but NO lender match → ADDITIVE (lender-match still required)',
   de.computeCombinedLtv(mk({ existing_first_mortgage_lender: [] })).combined_ltv_percent === additive);
ok('purchase (no refinance tuple) → ADDITIVE',
   de.computeCombinedLtv(mk({ transaction_type: [{ value: 'purchase', payoutConfirmed: false }] })).combined_ltv_percent === additive);
ok('explicit 2nd_mortgage → ADDITIVE',
   de.computeCombinedLtv(mk({ transaction_type: [{ value: '2nd_mortgage', payoutConfirmed: false }] })).combined_ltv_percent === additive);

console.log(`\n[franco-q1-rule-refinement] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
