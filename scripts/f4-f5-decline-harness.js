#!/usr/bin/env node
// F4 — a first email over the auto-decline line gets the decline only (no welcome first).
// F5 — both auto-decline emails (Q2 >90%, Q7 non-Canadian) pass the broker-facing sweep.
// Structural checks on the dispatch code plus a behavioural check of the shared sweep.
const fs = require('fs');
const wh = fs.readFileSync('src/routes/webhook.js', 'utf8');
const { __test__ } = require('../src/routes/webhook');
const ai = require('../src/services/ai');
let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };

const welcomeIdx = wh.indexOf("// Send the AI-generated response with forms attached");
const f4Idx = wh.indexOf('const _f4WillAutoDecline');
ok('F4: auto-decline decision computed before the welcome send', f4Idx > 0 && f4Idx < welcomeIdx);
ok('F4: welcome send is skipped when the deal will auto-decline', /if \(_f4WillAutoDecline\) \{[\s\S]{0,200}\} else \{\s*welcomeQueued = true;\s*emailService\.sendEmailDelayed\(/.test(wh));
ok('F4: identity clash still takes precedence over Q2', /_f4WillAutoDecline = !dealSummary\?\.identity_clash && dEngine\.shouldAutoDeclineOver90/.test(wh));
ok('F5: Q2 decline (sendAutoDecline) is swept', /const declineHtml = sweepBrokerFacing\(await aiService\.generateRejectionEmail/.test(wh));
ok('F5: Q7 decline is swept', /_q7DeclineEmail = sweepBrokerFacing\(await aiService\.generateRejectionEmail/.test(wh));
ok('first-email Q2 path uses the shared sendAutoDecline', /Initial submission >90% LTV auto-decline[\s\S]{0,1500}await sendAutoDecline\(\{/.test(wh));

// Behaviour of the sweep the declines now share (routing-leak + "Perfect" opener).
const leaky = '<p>Perfect! Franco reviewed your file and decided to pass.</p>';
const swept = ai.stripPerfectOpener(ai.enforceNoRoutingLeak(leaky).swept).swept;
ok('sweep removes the admin-name routing leak', !/Franco reviewed/i.test(swept));
ok('sweep neutralizes the "Perfect" opener', !/^<p>Perfect!/.test(swept));

// High-LTV code-built summary names the borrower (decline subject, hold notice) — was "the borrower".
const lab = ai.extractBorrowerLabelFallback;
ok('label: "Refinance — Jennifer Tran (83% LTV)" subject', lab('Refinance — Jennifer Tran (83% LTV)', '') === 'Jennifer Tran');
ok('label: "refi for Jennifer Tran." prose', lab('Hello', 'High-LTV refi for Jennifer Tran. $746k') === 'Jennifer Tran');
ok('label: "New file for Laura Bennett." prose', lab('x', 'New file for Laura Bennett.') === 'Laura Bennett');
ok('label: lowercase "the borrower" never captured', lab('Hello', 'this file for the borrower.') === null);

console.log(`\n[f4-f5-decline] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
