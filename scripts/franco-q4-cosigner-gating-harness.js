#!/usr/bin/env node
// FRANCO-Q4 unit harness — conservative cosigner/guarantor role gating.
// Failure-mode asymmetry: counting a true guarantor over-qualifies (the error
// Franco wants avoided) → ambiguous defaults to guarantor-only (NOT counted) +
// clarification. Tests role determination, conservative default, resolvedRoles
// override, the failure-mode guard, and Snapshot surfacing.

const bq = require('../src/services/borrower-qualification');
const dEngine = require('../src/services/discrepancy-engine');

let pass = 0, fail = 0;
const ok = (label, cond) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}`); };
const roleOf = (roster, name) => (roster.roster.find(r => r.name === name) || {}).role;
const countsOf = (roster, name) => (roster.roster.find(r => r.name === name) || {}).countsTowardQualification;

const base = { detectedBorrowers: ['Marcus Webb', 'Sarah Chen'], primaryName: 'Marcus Webb' };

console.log('\n[1] explicit co-applicant signal → COUNT');
const coapp = bq.buildQualificationRoster({ ...base, textSources: 'Sarah Chen is a co-applicant on this file.' });
ok('Sarah = co_applicant', roleOf(coapp, 'Sarah Chen') === 'co_applicant');
ok('Sarah counts', countsOf(coapp, 'Sarah Chen') === true);
ok('countingCount 2', coapp.countingCount === 2);
ok('no clarification pending', coapp.clarificationPending === false);

console.log('\n[2] explicit guarantor signal → GUARANTOR_ONLY (not counted)');
const guar = bq.buildQualificationRoster({ ...base, textSources: 'Sarah Chen is acting as guarantor only.' });
ok('Sarah = guarantor_only', roleOf(guar, 'Sarah Chen') === 'guarantor_only');
ok('Sarah NOT counted', countsOf(guar, 'Sarah Chen') === false);
ok('countingCount 1 (primary only)', guar.countingCount === 1);
ok('no clarification (explicit, unambiguous)', guar.clarificationPending === false);

console.log('\n[3] ambiguous "cosigner" → conservative default guarantor-only + clarification');
const ambig = bq.buildQualificationRoster({ ...base, textSources: 'Sarah Chen is the cosigner.' });
ok('Sarah defaulted to guarantor_only', roleOf(ambig, 'Sarah Chen') === 'guarantor_only');
ok('Sarah NOT counted (conservative)', countsOf(ambig, 'Sarah Chen') === false);
ok('marked ambiguous', ambig.roster.find(r => r.name === 'Sarah Chen').ambiguous === true);
ok('clarificationPending true', ambig.clarificationPending === true);
ok('clarification message names Sarah + offers both dispositions', /Sarah Chen/.test(ambig.clarificationMessage) && /co-applicant/.test(ambig.clarificationMessage) && /guarantor-only/.test(ambig.clarificationMessage));

console.log('\n[4] resolvedRoles override (broker clarified)');
const resCo = bq.buildQualificationRoster({ ...base, textSources: 'Sarah Chen is the cosigner.', resolvedRoles: { 'Sarah Chen': 'co_applicant' } });
ok('resolved co_applicant → counts', roleOf(resCo, 'Sarah Chen') === 'co_applicant' && countsOf(resCo, 'Sarah Chen') === true);
ok('resolved → no clarification pending', resCo.clarificationPending === false);
const resGu = bq.buildQualificationRoster({ ...base, textSources: 'Sarah Chen is the cosigner.', resolvedRoles: { 'Sarah Chen': 'guarantor_only' } });
ok('resolved guarantor_only → NOT counted', roleOf(resGu, 'Sarah Chen') === 'guarantor_only' && countsOf(resGu, 'Sarah Chen') === false);

console.log('\n[5] FAILURE-MODE GUARD — strict-guarantor reading must NOT count');
ok('explicit guarantor income NOT in counting set', !guar.roster.filter(r => r.countsTowardQualification).some(r => r.name === 'Sarah Chen'));
ok('ambiguous cosigner income NOT in counting set', !ambig.roster.filter(r => r.countsTowardQualification).some(r => r.name === 'Sarah Chen'));
ok('aggregation directive lists guarantor as NOT counted', /GUARANTOR-ONLY/.test(guar.aggregationDirective) && /Sarah Chen/.test(guar.aggregationDirective.split('GUARANTOR-ONLY')[1]));

console.log('\n[6] Q3 regression — pure joint (no role labels) still counts both');
const pure = bq.buildQualificationRoster({ ...base, textSources: 'Joint refinance for the Webb/Chen household.' });
ok('no role label → both count', pure.countingCount === 2 && pure.clarificationPending === false);

console.log('\n[7] Snapshot surfaces guarantor disposition + clarification note');
const cmap = { requested_loan_amount: [{ value: 260000, source: 'loan_application' }], subject_property_market_value: [{ value: 500000, source: 'appraisal' }] };
const snapGuar = dEngine.renderDealSnapshot(cmap, { qualificationRoster: guar });
ok('guarantor-only disposition rendered', /Sarah Chen — guarantor-only \(liable on default; NOT counted/.test(snapGuar));
const snapAmbig = dEngine.renderDealSnapshot(cmap, { qualificationRoster: ambig });
ok('clarification note rendered on ambiguous', /Cosigner role — clarification needed:/.test(snapAmbig));

console.log(`\n[franco-q4-harness] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
