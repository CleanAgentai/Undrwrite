#!/usr/bin/env node
// Bug 2 harness — magnitude-suffix money family (k/K, m/M/MM, thousand, million).
// Pure (no API). normalizeMoney centralized parse + broker-written capture
// widening (email loan/value, corrections, annotations) + strict-zero family
// + no-suffix regression + sanity bound + no-following-word-capture + the
// doc-extractor confirmation (full amounts unchanged).

const cf = require('../src/services/canonical-fields');
const { normalizeMoney } = cf;

let pass = 0, fail = 0;
const eq = (label, got, exp) => {
  const ok = got === exp;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label} → ${got}${ok ? '' : ` (exp ${exp})`}`);
  ok ? pass++ : fail++;
};

console.log('\n[1] normalizeMoney — full magnitude family + regression');
for (const [inp, exp] of [
  ['280k', 280000], ['280K', 280000], ['$280k', 280000], ['$280K', 280000],
  ['1.2M', 1200000], ['1.2m', 1200000], ['$1.2M', 1200000],
  ['1.2MM', 1200000], ['$1.2MM', 1200000],
  ['1.2 million', 1200000], ['$1.2 million', 1200000],
  ['280 thousand', 280000], ['$280 thousand', 280000],
  ['$280,000', 280000], ['$280,000.00', 280000], ['280000', 280000], ['$295,000', 295000],
]) eq(`normalizeMoney("${inp}")`, normalizeMoney(inp), exp);

console.log('\n[2] sanity bound — malformed double-unit → flagged base, NOT silent absurd');
eq('normalizeMoney("$280,000k")', normalizeMoney('$280,000k'), 280000); // logs a warn (flagged-inferred)

console.log('\n[3] no following-word capture (normalizeMoney fallback path)');
eq('normalizeMoney("650,000 Market")', normalizeMoney('650,000 Market'), 650000);

const loanVal = (body) => {
  const m = cf.extractCanonicalFields(body, [], { emailSubject: '' });
  return (m.requested_loan_amount && m.requested_loan_amount[0]) ? m.requested_loan_amount[0].value : null;
};
const apprVal = (body) => {
  const m = cf.extractCanonicalFields(body, [], { emailSubject: '' });
  return (m.subject_property_market_value && m.subject_property_market_value[0]) ? m.subject_property_market_value[0].value : null;
};

console.log('\n[4] END-TO-END email loan-amount path — family + regression');
for (const [f, exp] of [
  ['$280k', 280000], ['280k', 280000], ['$1.2M', 1200000], ['$1.2 million', 1200000],
  ['$280 thousand', 280000], ['1.2MM', 1200000], ['$280,000', 280000], ['$295,000', 295000],
]) eq(`"Loan amount ${f}"`, loanVal(`Loan amount ${f}`), exp);

console.log('\n[5] END-TO-END email appraised-value path');
for (const [f, exp] of [['$650k', 650000], ['$1.5 million', 1500000], ['$815,000', 815000]])
  eq(`"Property Value: ${f}"`, apprVal(`Property Value: ${f}`), exp);

console.log('\n[6] no following-word capture END-TO-END');
eq('"Property Value: $650,000 Market comps strong"', apprVal('Property Value: $650,000 Market comps strong'), 650000);

console.log('\n[7] DOC-EXTRACTOR confirmation — full amounts unchanged (not widened, real docs full)');
const docMap = cf.extractCanonicalFields('refinance', [
  { file_name: 'stmt.pdf', classification: 'mortgage_statement', text: 'Lender: RBC\nOutstanding Principal Balance $225,000.00\nTOTAL PAYOUT AMOUNT $226,500.00' },
  { file_name: 'appr.pdf', classification: 'appraisal', text: 'SUBJECT PROPERTY\nReconciled Market Value: $650,000' },
], { emailSubject: '' });
eq('doc existing_first_mortgage_balance', (docMap.existing_first_mortgage_balance[0] || {}).value, 225000);
eq('doc subject_property_market_value', (docMap.subject_property_market_value[0] || {}).value, 650000);

console.log(`\n[bug2-harness] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
