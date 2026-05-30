#!/usr/bin/env node
// BUG-5 harness — deterministic Existing 1st Mortgage Balance row (render layer).
// A33's rare 'missing $410k' was LLM-narrative omission (refinance carve-out suppresses
// the Combined-LTV row → no deterministic balance surface). This makes the balance
// always-visible (value or TBD) when an existing 1st mortgage is indicated + no combined row.
// Deterministic verification (the production transient is rarer than any repetition probe).
const de = require('../src/services/discrepancy-engine');
let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };
const render = (cm) => de.renderDealSnapshot(cm, {});
const balRow = /<strong>\s*Existing 1st Mortgage Balance\s*:\s*<\/strong>\s*([^<]+)/i;

console.log('[1] A33 case — refinance + existing balance, no combined row → deterministic row with value');
// A33 active+prelim ⇒ combined null; model with no new loan → computeCombinedLtv null → BUG-5 fires.
let h = render({ transaction_type: [{ value: 'refinance' }], existing_first_mortgage_balance: [{ value: 410000 }], existing_first_mortgage_lender: [{ value: 'BMO' }], subject_property_market_value: [{ value: 850000 }] });
let m = balRow.exec(h);
ok('row renders with $410,000', !!m && /410,000/.test(m[1]));

console.log('[2] incompleteness transient — refinance indicated but balance null → row shows TBD (visible, not silent)');
h = render({ transaction_type: [{ value: 'refinance', payoutConfirmed: true }], existing_first_mortgage_lender: [{ value: 'BMO' }], requested_loan_amount: [{ value: 525000 }], subject_property_market_value: [{ value: 850000 }] });
m = balRow.exec(h);
ok('row renders TBD when balance null (existing mortgage indicated)', !!m && /TBD/i.test(m[1]));

console.log('[3] no redundancy — 2nd mortgage WITH combined row → no separate BUG-5 row');
h = render({ mortgage_position: [{ value: '2nd' }], existing_first_mortgage_balance: [{ value: 380000 }], requested_loan_amount: [{ value: 120000 }], subject_property_market_value: [{ value: 720000 }] });
ok('Combined LTV row present', /Combined LTV \(incl\. existing/i.test(h));
ok('no separate Existing-Balance row (avoid redundancy with combined)', !balRow.test(h));

console.log('[4] no over-fire — clean first-mortgage / purchase (no existing signal) → NO row');
h = render({ transaction_type: [{ value: 'purchase' }], requested_loan_amount: [{ value: 468000 }], subject_property_market_value: [{ value: 720000 }] });
ok('purchase → no Existing-Balance row', !balRow.test(h));
h = render({ requested_loan_amount: [{ value: 300000 }], subject_property_market_value: [{ value: 600000 }] });
ok('bare first-mortgage (no signal) → no Existing-Balance row', !balRow.test(h));

console.log('[5] source invariant');
const eng = require('fs').readFileSync('src/services/discrepancy-engine.js', 'utf8');
ok('BUG-5 deterministic row present + gated by existing-mortgage signal', /BUG-5[\s\S]{0,1600}_bug5IsRefiOr2nd[\s\S]{0,300}renderSnapshotRow\('Existing 1st Mortgage Balance'/.test(eng));

console.log(`\n[bug5-existing-balance-deterministic-row] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
