#!/usr/bin/env node
// FRANCO-C01-ADMIN-INTAKE-AS-BROKER-SUBMITTED (Franco 2026-05-30). Admin-sent intake is
// treated as broker-submitted and processed normally — NOT routed to a paused
// admin_controlled / admin_handoff state, NOT requiring acknowledgment. Investigation
// found the code ALREADY implements this (admin_controlled is set ONLY on the
// link-submission path); the stale artifact was the C01 spec. This harness locks the
// no-pause-on-admin-intake invariant.
const fs = require('fs');
let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };
const wh = fs.readFileSync('src/routes/webhook.js', 'utf8');

console.log('[1] admin_controlled is set ONLY on the link-submission path (never on admin intake)');
const assignSites = (wh.match(/dealsService\.update\([^)]*admin_controlled: true/g) || []);
ok('exactly 1 admin_controlled=true persistence site (excludes comments)', assignSites.length === 1);
// that one site is inside the link-submission (_ahIsLinkOnly) branch
ok('the assignment is gated by the link-submission branch (_ahIsLinkOnly)',
   /_ahIsLinkOnly\s*\)\s*\{[\s\S]{0,400}admin_controlled: true/.test(wh));

console.log('[2] admin-intake branch (isAdmin && !existingDeal) does NOT pause');
const adminIntakeBlock = (wh.match(/if \(isAdmin && !existingDeal\) \{[\s\S]{0,4000}/) || [''])[0];
ok('admin-new-intake branch present', /if \(isAdmin && !existingDeal\)/.test(wh));
ok('admin-new-intake branch does NOT set admin_controlled=true', !/admin_controlled: true/.test(adminIntakeBlock));

console.log('[3] C01 spec reflects Franco disposition (active, not admin_handoff)');
const c01 = JSON.parse(fs.readFileSync('test-fixtures/bulletproof/scenarios/C01-admin-handoff-intake/expected.json', 'utf8'));
ok('C01 workflow_state = active (broker-submitted processing)', c01.layer1_structural.workflow_state.value === 'active');
ok('C01 intake_classification = broker_submitted (not admin_handoff)', c01.layer1_structural.intake_classification.value === 'broker_submitted');

console.log(`\n[franco-c01-admin-intake] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
