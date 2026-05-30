#!/usr/bin/env node
// FRANCO-Q1 unit harness — payout-language gate on R11-B-3 carve-out + default
// transaction_type + purchase-signal detection. Conservative payout detector
// (lean false-negative). The carve-out is now THREE-condition: refinance +
// lender-match + payoutConfirmed.

const cf = require('../src/services/canonical-fields');
const dE = require('../src/services/discrepancy-engine');

let pass = 0, fail = 0;
const ok = (label, cond) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}`); };
const payout = (t) => cf.detectPayoutLanguage(t).present;

console.log('\n[1] payout detector — STRONG language fires');
for (const s of [
  'the RBC will be paid out at closing',
  'the existing mortgage will be paid out at closing',
  'we are paying out the existing Scotiabank mortgage',
  'refinance to pay off the existing lender',
  'we will discharge the existing mortgage at closing',
]) ok(`fires: "${s}"`, payout(s) === true);

console.log('\n[2] payout detector — WEAK language does NOT fire (false-positive guard)');
for (const s of [
  'refinancing his existing RBC first mortgage',
  'this is a refinance',
  'replacing the current mortgage',
  'consolidating some debt',
  'Refi for Sarah Chen',
]) ok(`no fire: "${s}"`, payout(s) === false);

console.log('\n[3] purchase-signal detector');
ok('purchase_contract doc → purchase signal', cf.detectPurchaseSignal('', [{ classification: 'purchase_contract' }]).present === true);
ok('purchase language → purchase signal', cf.detectPurchaseSignal('We are purchasing this property.', []).present === true);
ok('"refinance ... purchase" → NOT purchase (refi context)', cf.detectPurchaseSignal('Refinance; borrower will later purchase another home.', []).present === false);
ok('plain refi → no purchase signal', cf.detectPurchaseSignal('Refinance for Marcus.', []).present === false);

console.log('\n[4] default transaction_type (extractCanonicalFields)');
const noSignal = cf.extractCanonicalFields('Refi for Sarah Chen. Loan amount $460,000.', []);
ok('no purchase + no explicit → defaults refinance', (noSignal.transaction_type || []).some(t => t.value === 'refinance' && t.source === 'defaulted_from_purchase_absence'));
ok('defaulted refinance w/ no payout → payoutConfirmed false', (noSignal.transaction_type || []).every(t => t.payoutConfirmed === false));
const purchaseDoc = cf.extractCanonicalFields('New purchase submission.', [{ classification: 'purchase_contract', text: '' }]);
ok('purchase_contract present → defaults purchase (not refinance)', (purchaseDoc.transaction_type || []).some(t => t.value === 'purchase'));

console.log('\n[5] payoutConfirmed tagging (extractCanonicalFields)');
const withPayout = cf.extractCanonicalFields('Refinance for Marcus — the existing RBC mortgage will be paid out at closing. Loan $408,000.', []);
ok('payout language → all transaction_type tuples payoutConfirmed=true', (withPayout.transaction_type || []).length > 0 && (withPayout.transaction_type || []).every(t => t.payoutConfirmed === true));

console.log('\n[6] carve-out gate (computeCombinedLtv) — three conditions');
const baseMap = {
  existing_first_mortgage_balance: [{ value: 400000, classification: 'mortgage_statement' }],
  existing_first_mortgage_lender: [{ value: 'RBC', classification: 'mortgage_statement' }],
  requested_loan_amount: [{ value: 408000, classification: 'broker_initial_intent' }],
  subject_property_market_value: [{ value: 680000 }],
};
const fires = dE.computeCombinedLtv({ ...baseMap, transaction_type: [{ value: 'refinance', classification: 'broker_correction', rawPhrase: 'refinancing existing RBC mortgage', payoutConfirmed: true }] });
ok('refinance + lender match + payoutConfirmed → carve-out fires (60%, existing=0)', fires.combined_ltv_percent === 60.0 && fires.components.existing === 0);
const gated = dE.computeCombinedLtv({ ...baseMap, transaction_type: [{ value: 'refinance', classification: 'broker_correction', rawPhrase: 'refinancing existing RBC mortgage', payoutConfirmed: false }] });
ok('refinance + lender match but NO payout → carve-out GATED → additive (118.8%)', gated.combined_ltv_percent === Math.round(((400000 + 408000) / 680000) * 100 * 10) / 10 && gated.components.existing === 400000);

console.log('\n[7] A14-shape end-to-end — terse Refi, no payout → NOW carve-out fires (FRANCO-Q1-RULE-REFINEMENT 2026-05-30: confident refinance = payout-implicit)');
// A14 numbers: loan 460k, value 815k, existing balance 380k → standalone 56.4%.
// PRE-REFINEMENT this escalated (additive 103%, require explicit payout); Franco's refined
// rule ("refinance IS payout") fires the carve-out for a confident refinance + lender match.
const a14Map = cf.extractCanonicalFields('Refi for Sarah Chen at 4421 Kingsway. Loan amount $460,000.', [
  { classification: 'mortgage_statement', text: 'Lender: BMO\nBalance: $380,000' },
]);
a14Map.existing_first_mortgage_balance = [{ value: 380000, classification: 'mortgage_statement' }];
a14Map.existing_first_mortgage_lender = [{ value: 'BMO', classification: 'mortgage_statement' }];
a14Map.requested_loan_amount = [{ value: 460000, classification: 'broker_initial_intent' }];
a14Map.subject_property_market_value = [{ value: 815000 }];
const a14Combined = dE.computeCombinedLtv(a14Map);
ok('A14 transaction_type defaulted refinance, payoutConfirmed false, refinanceConfident true', (a14Map.transaction_type || []).some(t => t.value === 'refinance' && !t.payoutConfirmed && t.refinanceConfident === true));
ok('A14 carve-out NOW fires → standalone 56.4% (active, not escalate) per Franco-Q1-rule-refinement', a14Combined.combined_ltv_percent === 56.4 && a14Combined.components.existing === 0 && a14Combined.components.existing_source === 'refinance-implicit-payout');

console.log(`\n[franco-q1-harness] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
