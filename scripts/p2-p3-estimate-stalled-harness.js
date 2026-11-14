#!/usr/bin/env node
// P2 — model-estimated LTV is labelled on the admin prelim (callout + "(est.)" subject).
// P3 — one [Stalled] alert per deal when the reminder cap is reached.
const fs = require('fs');
const ai = require('../src/services/ai');
let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };
const html = '<h2>Deal Snapshot</h2><p>LTV: TBD</p><hr><h2>Risk</h2>';
const once = ai.injectLtvEstimateCallout(html, 65);
ok('callout injected after the Deal Snapshot', /Deal Snapshot<\/h2><p>LTV: TBD<\/p>\n<p data-marker="p2-ltv-estimate"><strong>LTV is an estimate/.test(once));
ok('callout names the estimated value', /~65%/.test(once));
ok('idempotent (re-injection keeps one callout)', (ai.injectLtvEstimateCallout(once, 65).match(/p2-ltv-estimate/g) || []).length === 1);
const wh = fs.readFileSync('src/routes/webhook.js', 'utf8');
ok('prelim injects the callout only when canonical LTV is not computable', /if \(!computeCanonicalLtvForReview\(_bFilteredCanonicalMap\) && ltv != null\) \{\s*leadSummary = aiService\.injectLtvEstimateCallout/.test(wh));
ok('subject marks a non-canonical LTV as "(est.)"', /_p2LtvIsEstimate \? `~\$\{_r9bSubjectLtv\}% LTV \(est\.\)`/.test(wh));
const cron = fs.readFileSync('src/cron/dailySummary.js', 'utf8');
ok('cap reached → sendStalledAlertOnce', /reminderCount >= MAX_REMINDERS\) \{[\s\S]{0,200}await sendStalledAlertOnce\(deal, reminderCount\)/.test(cron));
ok('stalled alert is once per deal and saved with its Message-ID', /\^\\\[Stalled\\\]/.test(cron) && /saveMessage\(deal\.id, 'outbound', subject, body, r\?\.MessageID\)/.test(cron));
console.log(`\n[p2-p3-estimate-stalled] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
