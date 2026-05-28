#!/usr/bin/env node
// FRANCO-PREDICTED-Q8 unit harness — joint-applicant Snapshot row.
// Asserts: (1) jointBorrowers array (>=2) renders a "Joint Applicants:" row;
// (2) null/absent/single does NOT render the row (purely additive);
// (3) regression — all existing Snapshot rows still render unchanged.

const dEngine = require('../src/services/discrepancy-engine');

let pass = 0, fail = 0;
const ok = (label, cond) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}`); };

const canonicalMap = {
  subject_property_address: [{ value: '1142 tory road nw', source: 'email_body' }],
  subject_property_city: [{ value: 'Edmonton', source: 'email_body' }],
  subject_property_province: [{ value: 'AB', source: 'email_body' }],
  requested_loan_amount: [{ value: 260000, source: 'loan_application' }],
  subject_property_market_value: [{ value: 500000, source: 'appraisal' }],
  mortgage_position: [{ value: '1st', source: 'loan_application' }],
};

console.log('\n[1] positive — jointBorrowers (2) renders the row');
const two = dEngine.renderDealSnapshot(canonicalMap, { jointBorrowers: ['Marcus Webb', 'Sarah Chen'] });
ok('row present', /<strong>Joint Applicants:<\/strong>/.test(two));
ok('both names present', /Marcus Webb/.test(two) && /Sarah Chen/.test(two));
ok('count rendered "(2 borrowers)"', /\(2 borrowers\)/.test(two));

console.log('\n[2] positive — 3 borrowers');
const three = dEngine.renderDealSnapshot(canonicalMap, { jointBorrowers: ['A One', 'B Two', 'C Three'] });
ok('count rendered "(3 borrowers)"', /\(3 borrowers\)/.test(three));

console.log('\n[3] negative/edge — no row when null / absent / single');
const none = dEngine.renderDealSnapshot(canonicalMap, {});
const nul = dEngine.renderDealSnapshot(canonicalMap, { jointBorrowers: null });
const solo = dEngine.renderDealSnapshot(canonicalMap, { jointBorrowers: ['Only One'] });
ok('absent → no joint row', !/Joint Applicants:/.test(none));
ok('null → no joint row', !/Joint Applicants:/.test(nul));
ok('single (len 1) → no joint row', !/Joint Applicants:/.test(solo));

console.log('\n[4] regression — existing rows still render (additive only)');
ok('Property Address row intact', /<strong>Property Address:<\/strong>/.test(none));
ok('City / Province row intact', /<strong>City \/ Province:<\/strong>/.test(none));
ok('Loan Amount Requested row intact', /<strong>Loan Amount Requested:<\/strong>/.test(none));
ok('LTV row intact', /<strong>LTV:<\/strong>/.test(none));
ok('Borrower Type row intact', /<strong>Borrower Type:<\/strong>/.test(none));
ok('Deal Snapshot header intact', /<h2>Deal Snapshot<\/h2>/.test(none));
// the joint row sits immediately before Borrower Type when present
ok('joint row positioned before Borrower Type', two.indexOf('Joint Applicants:') < two.indexOf('Borrower Type:'));

console.log(`\n[franco-q8-harness] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
