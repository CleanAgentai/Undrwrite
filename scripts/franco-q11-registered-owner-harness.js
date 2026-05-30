#!/usr/bin/env node
// FRANCO-Q11 — registered-property-owner rule. "Registered owner(s) must be on the
// application; if there's only one registered owner, the other applicant is a guarantor."
const ro = require('../src/services/registered-owner');
const bq = require('../src/services/borrower-qualification');
const { ROLE } = bq;
let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };
const roster = (cands, text, primary) => {
  const det = ro.detectRegisteredOwners(text, cands);
  return bq.buildQualificationRoster({ detectedBorrowers: cands, primaryName: primary || cands[0], textSources: text, registeredOwners: det.owners, registeredOwnerSignal: det.signalPresent });
};
const roleOf = (r, name) => (r.roster.find(x => x.name === name) || {}).role;

console.log('[1] both registered owners → both co-applicants (count)');
let r = roster(['Marcus Webb', 'Patricia Webb'], 'Joint refi for Marcus Webb and Patricia Webb — both on title.', 'Marcus Webb');
ok('Marcus primary', roleOf(r, 'Marcus Webb') === ROLE.PRIMARY);
ok('Patricia co-applicant (counts, not guarantor)', roleOf(r, 'Patricia Webb') === ROLE.CO_APPLICANT && r.countingCount === 2);

console.log('[2] single registered owner + other applicant → other is GUARANTOR (supersedes Q4)');
r = roster(['Marcus Webb', 'Patricia Webb'], 'Refi for Marcus Webb, who is the sole registered owner. Patricia Webb is his spouse and co-applicant.', 'Marcus Webb');
ok('Marcus primary (owner)', roleOf(r, 'Marcus Webb') === ROLE.PRIMARY);
ok('Patricia GUARANTOR despite "co-applicant" language (Q11 supersedes Q4)', roleOf(r, 'Patricia Webb') === ROLE.GUARANTOR_ONLY);
ok('only 1 counts toward qualification', r.countingCount === 1);

console.log('[3] registered owner NOT on application → broker_clarification asks for them');
r = roster(['Marcus Webb'], 'Application for Marcus Webb. Jennifer Tran is the registered owner of the property.', 'Marcus Webb');
ok('clarification pending (owner missing)', r.clarificationPending === true);
ok('clarification names the missing owner', /Jennifer Tran/.test(r.clarificationMessage || ''));

console.log('[4] single registered owner + single applicant who IS the owner → standard standalone');
r = roster(['Marcus Webb'], 'Refi for Marcus Webb, the sole registered owner.', 'Marcus Webb');
ok('single-party roster, counts standalone', r.countingCount === 1 && r.multiParty === false);
ok('no clarification', !r.clarificationPending);

console.log('[5] corporate owner + individual applicant → individual is guarantor');
r = roster(['Webb Holdings Ltd.', 'Marcus Webb'], 'Webb Holdings Ltd. is the sole registered owner. Marcus Webb is also on the application.', 'Webb Holdings Ltd.');
ok('corporate entity primary (owner)', roleOf(r, 'Webb Holdings Ltd.') === ROLE.PRIMARY);
ok('individual Marcus → GUARANTOR (non-owner, single owner)', roleOf(r, 'Marcus Webb') === ROLE.GUARANTOR_ONLY);

console.log('[6] NEGATIVE — no owner signal → no Q11 classification (defers to Q3/Q4)');
r = roster(['Marcus Webb', 'Patricia Webb'], 'Joint refi for Marcus Webb and Patricia Webb, co-applicants.', 'Marcus Webb');
ok('no owner signal → both count (Q3/Q4 unchanged)', r.countingCount === 2 && roleOf(r, 'Patricia Webb') === ROLE.CO_APPLICANT);

console.log(`\n[franco-q11-registered-owner] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
