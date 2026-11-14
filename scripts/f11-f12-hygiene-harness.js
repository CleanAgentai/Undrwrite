#!/usr/bin/env node
// F11 — dead AI functions removed; comments corrected. F12 — unreachable branches fixed.
const fs = require('fs');
const ai = require('../src/services/ai');
const wh = fs.readFileSync('src/routes/webhook.js', 'utf8');
let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };
for (const n of ['classifyImage', 'updateDealSummary', 'generateInfoRequestEmail', 'generateDocReviewNotification']) ok(`F11: ${n} removed (never called)`, typeof ai[n] === 'undefined');
ok('F11: live AI functions still exported', ['processInitialEmail', 'generateBrokerResponse', 'generateLeadSummary', 'parseAdminReply', 'generateHighLtvCollateralAsk'].every(n => typeof ai[n] === 'function'));
ok('F11: non-function exports intact (DOC_DISPLAY_NAMES — swallowed by the first removal pass, caught live)', ai.DOC_DISPLAY_NAMES && ai.DOC_DISPLAY_NAMES.government_id === 'Government-Issued ID' && Object.keys(ai.DOC_DISPLAY_NAMES).length === 25);
ok('F11: "SOLE setter" comment corrected', !/SOLE setter of status='completed'/.test(wh));
ok('F11: approval_completed no longer annotated unreachable', !/structurally unreachable from the autonomous close-out path/.test(wh));
ok('F12: ambiguous collateral reply is marked', /existingDeal\._ambiguousCollateralReply = true;/.test(wh));
ok('F12: dedicated re-ask keyed on the marker (was an impossible status check)', /if \(existingDeal\._ambiguousCollateralReply && !_r10cActiveCollateralOffered && result\.responseEmail\)/.test(wh) && !/if \(existingDeal\.status === 'awaiting_collateral' && !_r10cActiveCollateralOffered/.test(wh));
ok('F12: always-false status re-write removed', !/if \(!\['active', 'under_review', 'awaiting_collateral', 'ltv_escalated', 'completed', 'rejected'\]\.includes\(existingDeal\.status\)\)/.test(wh));
console.log(`\n[f11-f12-hygiene] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
