#!/usr/bin/env node
// BUG-3 harness — canonical money-extraction broker-shorthand widening.
// Positive: realistic broker phrasing per pattern. Negative: contexts that must
// NOT match (existing-loan refs, hypotheticals, down-payment/closing, doc names).
const cf = require('../src/services/canonical-fields.js');
const fn = cf.extractFromEmailBody;
let pass = 0, fail = 0;
const eq = (label, body, field, expected) => {
  const got = (fn(body) || {})[field];
  const ok = got === expected;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}  [${field}=${got} exp=${expected}]`);
};

console.log('[A] "Nth mortgage request: $X" family → loan');
eq('New 2nd mortgage request', 'New 2nd mortgage request: $120,000.', 'requested_loan_amount', 120000);
eq('New second mortgage (no request)', 'New second mortgage: $120,000.', 'requested_loan_amount', 120000);
eq('New 3rd mortgage requested', 'New 3rd mortgage requested: $85,000.', 'requested_loan_amount', 85000);
eq('2nd mortgage request bare', '2nd mortgage request: $145k.', 'requested_loan_amount', 145000);

console.log('[B] bare "Loan $X" shorthand → loan (+ magnitude)');
eq('Loan $280k', 'Refi for Marcus. Loan $280k. Clean file.', 'requested_loan_amount', 280000);
eq('Loan: $585k', 'Corporate refi, Loan: $585k.', 'requested_loan_amount', 585000);
eq('lower loan $460k', 'Refi for Patricia. loan $460k.', 'requested_loan_amount', 460000);
eq('Loan $1.2m', 'Loan $1.2m on a commercial-residential.', 'requested_loan_amount', 1200000);

console.log('[C] word-order "$X loan/requested/for <financing>"');
eq('$280k loan', 'Refi for Marcus, $280k loan, first mortgage.', 'requested_loan_amount', 280000);
eq('$120k requested', 'Property at X. $120k requested as a second.', 'requested_loan_amount', 120000);
eq('$300k for refinance', '$300k for refinance of the existing.', 'requested_loan_amount', 300000);

console.log('[E] "$X against $Y" → loan=X, value=Y');
eq('against loan side', '$260k against $650k = 40% LTV.', 'requested_loan_amount', 260000);
eq('against value side', '$260k against $650k = 40% LTV.', 'subject_property_market_value', 650000);
eq('against value w/ property word', 'Loan $331k against $425k property.', 'subject_property_market_value', 425000);
eq('against w/ Loan prefix → loan', 'Loan $331k against $425k property.', 'requested_loan_amount', 331000);

console.log('[D] bare "appraised $X" lowercase prose → property_value');
eq('appraised $720,000', '287 Glencairn Ave, Toronto, appraised $720,000.', 'subject_property_market_value', 720000);
eq('Appraised at still works', 'Appraised at $545,000.', 'subject_property_market_value', 545000);

console.log('[NEG] must NOT match (false-positive guards)');
eq('existing first mortgage balance', 'Existing first mortgage: Scotiabank, balance $380,000.', 'requested_loan_amount', null);
eq('first mortgage lender colon', 'First mortgage: RBC. Balance below.', 'requested_loan_amount', null);
eq('loan application doc name', 'Attached: Loan Application $0 placeholder form.', 'requested_loan_amount', null);
eq('down payment "$X down"', 'Purchase price $720,000, $252k down.', 'requested_loan_amount', null);
eq('down for the purchase (down breaks adjacency)', 'Purchase. $252k down for the purchase.', 'requested_loan_amount', null);
eq('hypothetical other-deal ref', 'Last deal they did $400k for closing costs elsewhere.', 'requested_loan_amount', null);
eq('balance figure not loan', 'RBC first mortgage, balance $225k per attached payout.', 'requested_loan_amount', null);

console.log('[F] BUG-3-EXTENSION (BATCH 14) — 2nd-mortgage "$X behind" + "$X property"');
eq('F04 "$185k behind existing 1st" → loan', '$185k behind existing Royal Bank of Canada 1st ($380k balance).', 'requested_loan_amount', 185000);
eq('F13 "($145k) behind existing 1st" → loan', 'New 2nd from Centum ($145k) behind existing 1st with RBC.', 'requested_loan_amount', 145000);
eq('F04 "on $720k property" → value', 'Combined LTV 78% on $720k property.', 'subject_property_market_value', 720000);
eq('NEG "$20k behind on payments" → not loan', 'borrower is $20k behind on payments currently.', 'requested_loan_amount', null);
eq('NEG "$8k property tax" → not value', 'property tax assessment shows $8k property tax owing.', 'subject_property_market_value', null);
eq('NEG existing-balance not loan via behind', 'existing first mortgage $380k balance, no payoff.', 'requested_loan_amount', null);

console.log('[REGRESSION] pre-Bug-3 formal/informal still work');
eq('Loan Amount Requested', 'Loan Amount Requested: $295,000.', 'requested_loan_amount', 295000);
eq('requesting $X', 'We are requesting $68,000 for a small second.', 'requested_loan_amount', 68000);
eq('Appraised Value formal', 'Appraised Value: $850,000.', 'subject_property_market_value', 850000);

console.log(`\n[bug3-loan-amount-widening] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
