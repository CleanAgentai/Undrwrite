#!/usr/bin/env node
// F6 — outbound emails that can be replied to are saved with their Message-IDs, and an
//      admin reply to a system alert with no deal thread is not treated as a referral.
// F13 — the sender denylist matches the parsed address by domain (incl. subdomains).
const fs = require('fs');
const { isReplyToSystemAlert: alert, isIgnoredSender: ign } = require('../src/routes/webhook').__test__;
const wh = fs.readFileSync('src/routes/webhook.js', 'utf8');
let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };

const list = ['support@postmarkapp.com', 'noreply@', 'no-reply@', '@anthropic.com', 'mailer-daemon@', '@fyi.postmarkapp.com', '@fsagent.com', 'gabriela@vimarealty.com', 'vienna@solveraiq.ai'];
ok('F13: notice@email.anthropic.com blocked (the live spam deal 0283bf88)', ign('notice@email.anthropic.com', list));
ok('F13: "Anthropic <news@mail.anthropic.com>" display form blocked', ign('Anthropic <news@mail.anthropic.com>', list));
ok('F13: noreply@anything blocked', ign('noreply@bank.example.com', list));
ok('F13: MAILER-DAEMON bounce blocked', ign('MAILER-DAEMON@mx.google.com', list));
ok('F13: Vienna\'s own sending address blocked', ign('vienna@solveraiq.ai', list));
ok('F13: franco@vimarealty.com (test broker proxy) still passes', !ign('franco@vimarealty.com', list));
ok('F13: normal broker passes', !ign('jason@mercerbrokerage.ca', list));
ok('F13: lookalike domain not caught (notanthropic.com)', !ign('x@notanthropic.com', list));
ok('F13: "noreply" as a substring of a real local part does not block', !ign('bonnoreply@x.com', list));

ok('F6: reply to [Auto-Decline] alert is a system-alert reply', alert('Re: [Auto-Decline] LTV over 90% — Laura Bennett'));
ok('F6: reply to [Intake Filter] / [Out of Scope] / [Potential Duplicate]', alert('RE: [Intake Filter] New-client intake rejected — x') && alert('Re: Re: [Out of Scope] Non-Canadian property') && alert('Fwd: [Potential Duplicate] A — b@c.com'));
ok('F6: reply to a dispatch-failure alert', alert('Re: New-client dispatch failed — Refinance'));
ok('F6: a genuine referral is not mistaken for an alert reply', !alert('Referral — Sarah Chen, refinance in Calgary'));

ok('F6: link-only holding reply saved with MessageID', /saveMessage\(deal\.id, 'outbound', `Re: \$\{email\.subject \|\| 'Mortgage submission'\}`, _ahHoldingBody, _ahHoldingSent\?\.MessageID\)/.test(wh));
ok('F6: link-only admin handoff saved with MessageID', /_ahAdminBody, _ahAdminSent\?\.MessageID\)/.test(wh));
ok('F6: admin-controlled forward saved with MessageID', /_ahcSubject, _ahcBody, _ahcSent\?\.MessageID\)/.test(wh));
ok('F6: auto-decline + alert saved with MessageIDs (sendAutoDecline)', /saveMessage\(deal\.id, 'outbound', subject, declineHtml, sent\?\.MessageID\)[\s\S]{0,900}saveMessage\(deal\.id, 'outbound', alertSubject, alertBody, alert\?\.MessageID\)/.test(wh));
ok('F6: referral path skips system-alert replies before parsing', /isAdmin && !existingDeal && isReplyToSystemAlert\(email\.subject\)/.test(wh));

console.log(`\n[f6-f13-threading-denylist] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
