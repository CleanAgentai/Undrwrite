#!/usr/bin/env node
// FRANCO-Q3 unit harness — multi-party qualification roster + aggregation directive.
// DETERMINISTIC SCOPE (honest boundary): tests the JS roster + the directive text +
// the Snapshot disposition rendering. The numeric SUM itself is LLM-rendered (income/
// debt are narrative, not structured) and is verified only in the gated integration pass.

const bq = require('../src/services/borrower-qualification');
const dEngine = require('../src/services/discrepancy-engine');

let pass = 0, fail = 0;
const ok = (label, cond) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}`); };

console.log('\n[1] single / no borrower → passthrough (no aggregation)');
const solo = bq.buildQualificationRoster({ detectedBorrowers: ['Marcus Webb'], primaryName: 'Marcus Webb' });
ok('multiParty false', solo.multiParty === false);
ok('directive null (no aggregation)', solo.aggregationDirective === null);
ok('roster has the single primary', solo.roster.length === 1 && solo.roster[0].role === 'primary');
const none = bq.buildQualificationRoster({ detectedBorrowers: null });
ok('null detected → empty roster, passthrough', none.multiParty === false && none.roster.length === 0);

console.log('\n[2] joint 2 — both counted');
const two = bq.buildQualificationRoster({ detectedBorrowers: ['Marcus Webb', 'Sarah Chen'], primaryName: 'Marcus Webb' });
ok('multiParty true', two.multiParty === true);
ok('countingCount 2', two.countingCount === 2);
ok('exactly one primary', two.roster.filter(r => r.role === 'primary').length === 1);
ok('the rest are co-applicants', two.roster.filter(r => r.role === 'co_applicant').length === 1);
ok('all count toward qualification', two.roster.every(r => r.countsTowardQualification === true));

console.log('\n[3] joint 3+ — scales');
const three = bq.buildQualificationRoster({ detectedBorrowers: ['A One', 'B Two', 'C Three'], primaryName: 'A One' });
ok('countingCount 3', three.countingCount === 3);
ok('directive names all 3', /A One/.test(three.aggregationDirective) && /B Two/.test(three.aggregationDirective) && /C Three/.test(three.aggregationDirective));

console.log('\n[4] aggregation directive format — combined AND per-borrower');
ok('directive says SUM / aggregate', /AGGREGATE \(SUM\)/i.test(two.aggregationDirective));
ok('directive demands combined totals', /combined totals/i.test(two.aggregationDirective));
ok('directive demands per-borrower breakdown', /per-borrower breakdown/i.test(two.aggregationDirective));
ok('directive forbids primary-only', /do NOT use primary-borrower-only/i.test(two.aggregationDirective));

console.log('\n[5] primaryName fallback — unmatched primaryName → first promoted');
const fb = bq.buildQualificationRoster({ detectedBorrowers: ['X', 'Y'], primaryName: 'Not In List' });
ok('exactly one primary even when primaryName unmatched', fb.roster.filter(r => r.role === 'primary').length === 1);

console.log('\n[6] Snapshot disposition rows render from roster');
const cmap = {
  subject_property_address: [{ value: '1142 tory rd nw', source: 'email_body' }],
  requested_loan_amount: [{ value: 260000, source: 'loan_application' }],
  subject_property_market_value: [{ value: 500000, source: 'appraisal' }],
};
const snap = dEngine.renderDealSnapshot(cmap, { qualificationRoster: two });
ok('renders "Qualification basis" row', /Qualification basis:<\/strong> combined across 2 borrower/.test(snap));
ok('renders per-borrower disposition (primary)', /Marcus Webb — counted \(primary\)/.test(snap));
ok('renders per-borrower disposition (co-applicant)', /Sarah Chen — counted \(co-applicant\)/.test(snap));

console.log('\n[7] regression — single-borrower / no roster → no qualification rows (additive)');
const snapSolo = dEngine.renderDealSnapshot(cmap, { qualificationRoster: solo });
const snapNone = dEngine.renderDealSnapshot(cmap, {});
ok('single-borrower roster → no qualification-basis row', !/Qualification basis:/.test(snapSolo));
ok('no roster opt → no qualification-basis row', !/Qualification basis:/.test(snapNone));
ok('existing rows intact', /<strong>Loan Amount Requested:<\/strong>/.test(snapNone) && /<strong>Borrower Type:<\/strong>/.test(snapNone));

console.log(`\n[franco-q3-harness] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
