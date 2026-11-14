#!/usr/bin/env node
// F15 — consistency fixes found by the post-Phase-1 code re-read:
//  admin alerts are admin-facing (threading/labelling); Q10 baseline = last notified facts;
//  thread facts use the prelim's guarded detection; one data source for follow-up gates;
//  post-approval >90% alert once per figure; lender package labels estimated LTV;
//  thresholds quoted in prompts come from config; conditions on hold are not an approval;
//  an LTV estimate never auto-declines; a stale hold draft is cleared on escalation;
//  the self-denylist uses parsed addresses.
const fs = require('fs');
const ar = require('../src/lib/adminReply');
const { evaluateFollowUpLtvGates: g } = require('../src/routes/webhook').__test__;
const wh = fs.readFileSync('src/routes/webhook.js', 'utf8');
const ai = fs.readFileSync('src/services/ai.js', 'utf8');
let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };

for (const s of ['[Stalled] Omar — no broker reply after 4 reminders', '[On hold — awaiting collateral] Jen — LTV 82.9%', '[UPDATED] Prelim correction — Sarah Chen: loan corrected', '[Auto-Decline] LTV over 90% — X', '[LTV over 90% after approval] X'])
  ok(`admin-facing: "${s.slice(0, 34)}…"`, ar.isAdminFacingSubject(s) && ar.isAdminReplySubject(`Re: ${s}`));
ok('broker thread subjects stay broker-facing', !ar.isAdminFacingSubject('Re: Refinance — Sarah Chen') && !ar.isAdminFacingSubject('Re: New Mortgage Submission — Omar'));

ok('Q10 baseline = last prelim OR notified snapshot', /x\.trigger === 'prelim' \|\| x\.trigger === 'notified'/.test(wh));
ok('Q10 notice records a notified snapshot', /sendAdminMaterialCorrectionNotice\(existingDeal, _q10Changes[\s\S]{0,200}recordFactSnapshot\(existingDeal, 'notified'/.test(wh));
ok('thread facts use the prelim\'s guarded detection', /const buildThreadFacts[\s\S]{0,700}runDiscrepancyDetectionAggregated\(/.test(wh));
ok('follow-up 80% gate reads the thread-aggregated map', /const _r1ActiveCanonicalMap = dEngine\.extractCanonicalFieldsAggregated\(/.test(wh) && /const _f3Map = _r1ActiveCanonicalMap;/.test(wh));
ok('post-approval >90% alert once per figure', /_f3Prior = [\s\S]{0,260}includes\(_f3Key\)/.test(wh));
ok('lender package labels an estimated LTV', /if \(!_ltvOverride && dealSummary\?\.ltv_percent != null\) pkg = aiService\.injectLtvEstimateCallout/.test(wh));
ok('no hard-coded 80% left in prompts (except a hypothetical example and a log line)', (ai.split('\n').filter(l => /80%/.test(l) && !/^\s*\/\//.test(l)).length) <= 2);
ok('conditions on collateral hold do not stamp approval', /existingDeal\.status === 'awaiting_collateral' \? \{\} : \{ prelim_approved_at:/.test(wh));
ok('escalation clears a stale hold draft', /status: 'ltv_escalated', draft_email: null, draft_subject: null, draft_action: null/.test(wh));
ok('self-denylist uses parsed addresses (incl. reply-to inbox)', /senderEmail\.toLowerCase\(\)\.replace\(\/\^\.\*<\|>\.\*\$\/g, ''\)/.test(wh) && /config\.email\.replyTo/.test(wh));

// An LTV estimate (no code-computed figure) never auto-declines; a computed one still does.
const fresh = { status: 'active', extracted_data: {} };
ok('estimate 95% → no auto-decline (held for the underwriter instead)', g({ deal: fresh, canonicalMap: {}, fallbackStandaloneLtv: 95 }).autoDecline.decline === false);
ok('computed 92% → auto-decline', g({ deal: fresh, canonicalMap: { requested_loan_amount: [{ value: 460000 }], subject_property_market_value: [{ value: 500000 }] } }).autoDecline.decline === true);
ok('first-email Q2 and F4 decide on computed LTV only', /standaloneLtv: dEngine\.computeStandaloneLtv\(_r1InitialCanonicalMap\),/.test(wh) && /standaloneLtv: dEngine\.computeStandaloneLtv\(_f4Map\), \/\/ F15/.test(wh));

console.log(`\n[f15-consistency] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
