#!/usr/bin/env node
// FRANCO-Q2 unit harness — >90% canonical-LTV auto-decline.
// Standalone always reliable; combined only when payout status is RESOLVED.
// STRICT > 90 boundary. Verifies the Q1↔Q2 composition (A14 escalates, not declines).

const dE = require('../src/services/discrepancy-engine');

let pass = 0, fail = 0;
const ok = (label, cond) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}`); };
const decl = (args) => dE.shouldAutoDeclineOver90(args).decline;

console.log('\n[1] standalone boundary (strict > 90)');
ok('89.9% → no decline', decl({ standaloneLtv: 89.9 }) === false);
ok('90.0% → no decline (boundary, not strict-over)', decl({ standaloneLtv: 90.0 }) === false);
ok('90.01% → auto-decline', decl({ standaloneLtv: 90.01 }) === true);
ok('95% → auto-decline', decl({ standaloneLtv: 95 }) === true);

console.log('\n[2] combined only counts when resolved');
ok('combined 103% UNRESOLVED → no decline (escalates per Q1)', decl({ standaloneLtv: 56, combinedLtv: 103.1, combinedResolved: false }) === false);
ok('combined 95% RESOLVED (explicit 2nd) → auto-decline', decl({ standaloneLtv: 45, combinedLtv: 95, combinedResolved: true }) === true);
ok('combined 95% resolved but standalone 56 — declines on combined', decl({ standaloneLtv: 56, combinedLtv: 95, combinedResolved: true }) === true);

console.log('\n[3] scenario shapes');
ok('A14: standalone 56, combined 103 unresolved → NO decline (Q1 escalates)', decl({ standaloneLtv: 56.4, combinedLtv: 103.1, combinedResolved: false }) === false);
ok('Marcus: standalone 60 resolved → no decline (<90)', decl({ standaloneLtv: 60, combinedLtv: 60, combinedResolved: true }) === false);
ok('F04: standalone 26, combined 78 → no decline (<90 regardless)', decl({ standaloneLtv: 26, combinedLtv: 78, combinedResolved: true }) === false);
ok('explicit refi w/ payout at 95 standalone → decline (>90 applies to refi too)', decl({ standaloneLtv: 95, combinedLtv: 95, combinedResolved: true }) === true);

console.log('\n[4] isCombinedLtvResolved');
ok('payoutConfirmed refinance → resolved', dE.isCombinedLtvResolved({ transaction_type: [{ value: 'refinance', payoutConfirmed: true }] }) === true);
ok('explicit 2nd_mortgage → resolved', dE.isCombinedLtvResolved({ transaction_type: [{ value: '2nd_mortgage' }] }) === true);
ok('broker "2nd" position correction → resolved', dE.isCombinedLtvResolved({ transaction_type: [], mortgage_position: [{ value: '2nd', classification: 'broker_correction' }] }) === true);
ok('defaulted refinance, no payout → NOT resolved (A14)', dE.isCombinedLtvResolved({ transaction_type: [{ value: 'refinance', source: 'defaulted_from_purchase_absence', payoutConfirmed: false }] }) === false);
ok('empty map → NOT resolved', dE.isCombinedLtvResolved({}) === false);

console.log('\n[5] threshold constant + null safety');
ok('AUTO_DECLINE_LTV_THRESHOLD_PCT === 90', dE.AUTO_DECLINE_LTV_THRESHOLD_PCT === 90);
ok('null standalone + null combined → no decline', decl({ standaloneLtv: null, combinedLtv: null }) === false);
ok('null standalone, resolved combined 92 → decline', decl({ standaloneLtv: null, combinedLtv: 92, combinedResolved: true }) === true);

console.log('\n[6] composition with computeCombinedLtv (A14 end-to-end shape)');
// A14: carve-out gated off (no payout) → additive 103.1%; combinedResolved false → no decline.
const a14Map = {
  existing_first_mortgage_balance: [{ value: 380000, classification: 'mortgage_statement' }],
  existing_first_mortgage_lender: [{ value: 'BMO', classification: 'mortgage_statement' }],
  requested_loan_amount: [{ value: 460000, classification: 'broker_initial_intent' }],
  subject_property_market_value: [{ value: 815000 }],
  transaction_type: [{ value: 'refinance', source: 'defaulted_from_purchase_absence', payoutConfirmed: false }],
};
const a14Combined = dE.computeCombinedLtv(a14Map).combined_ltv_percent;
const a14Decline = dE.shouldAutoDeclineOver90({ standaloneLtv: 56.4, combinedLtv: a14Combined, combinedResolved: dE.isCombinedLtvResolved(a14Map) });
ok('A14 combined = 103.1 (additive, carve-out gated)', a14Combined === 103.1);
ok('A14 → NO auto-decline (escalates for payout clarification)', a14Decline.decline === false);

console.log(`\n[franco-q2-harness] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
