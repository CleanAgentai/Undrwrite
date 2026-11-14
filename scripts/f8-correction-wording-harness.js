#!/usr/bin/env node
// F8 — broader broker-correction phrasing (loan amount) + existing-balance corrections,
// with the rule that a broker-asserted balance can escalate but never auto-decline alone.
const cf = require('../src/services/canonical-fields');
const de = require('../src/services/discrepancy-engine');
let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}${d ? ` — ${d}` : ''}`); };
const corr = (t) => cf.parseBrokerCorrections(t);
const val = (t, f) => (corr(t).find(c => c.field === f) || {}).value;

ok('A06 "Updating loan amount: $345,000"', val('Updating loan amount: $345,000. Borrower added an additional $35k.', 'requested_loan_amount') === 345000);
ok('A08 "actual loan amount is $290,000"', val('Quick correction — actual loan amount is $290,000. The $115k on the form is old.', 'requested_loan_amount') === 290000);
ok('"revised amount: $410k"', val('Revised amount: $410k per the borrower.', 'requested_loan_amount') === 410000);
ok('"loan amount is now $305,000"', val('The loan amount is now $305,000.', 'requested_loan_amount') === 305000);
ok('"updated the loan amount to $1.2m"', val('We updated the loan amount to $1.2m.', 'requested_loan_amount') === 1200000);
ok('existing pattern still works ("the correct amount is $300,000")', val('The correct amount is $300,000.', 'requested_loan_amount') === 300000);
ok('A34 "Current first mortgage balance is $222,500 not $225,000"', val('Balance update — Current first mortgage balance is $222,500 not $225,000.', 'existing_first_mortgage_balance') === 222500);
ok('"the mortgage balance is actually $198,000"', val('Sorry, the mortgage balance is actually $198,000.', 'existing_first_mortgage_balance') === 198000);

ok('FP guard: hedged ("around $345,000") → no correction', corr('Updating loan amount: around $345,000 I think').length === 0);
ok('FP guard: question → no correction', corr('Is the loan amount now $305,000?').length === 0);
ok('FP guard: "new loan amount" with no $ → no correction', val('We need a new loan amount soon.', 'requested_loan_amount') === undefined);
ok('FP guard: payout total sentence is not a balance correction', val('The payout amount is $226,500 including penalty.', 'existing_first_mortgage_balance') === undefined);

// Correction lands at the front of the field in the canonical map (what gates read).
const m = cf.extractCanonicalFields('Current first mortgage balance is $222,500 not $225,000.', [{ file_name: 'MortgageStatement.pdf', classification: 'mortgage_statement', text: 'Outstanding Principal Balance: $225,000.00\nLender: RBC' }], {});
ok('balance correction outranks the statement in the map', m.existing_first_mortgage_balance?.[0]?.value === 222500 && m.existing_first_mortgage_balance[0].classification === 'broker_correction', JSON.stringify(m.existing_first_mortgage_balance?.slice(0, 2)));

// Decline eligibility: broker-only balance blocks combinedResolved; doc balance doesn't.
const tt = [{ value: '2nd_mortgage', source: 'x' }];
ok('2nd mortgage + document balance → combined decline-eligible (unchanged)', de.isCombinedLtvResolved({ transaction_type: tt, existing_first_mortgage_balance: [{ value: 400000, classification: 'mortgage_statement' }] }) === true);
ok('2nd mortgage + broker-corrected balance → NOT decline-eligible', de.isCombinedLtvResolved({ transaction_type: tt, existing_first_mortgage_balance: [{ value: 400000, classification: 'broker_correction' }] }) === false);
ok('…but still escalates (shouldEscalateOnAnyLtv ignores eligibility)', de.shouldEscalateOnAnyLtv({ standaloneLtv: 30, combinedLtv: 95 }) === true);

console.log(`\n[f8-correction-wording] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
