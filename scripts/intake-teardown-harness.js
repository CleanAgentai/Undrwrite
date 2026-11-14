#!/usr/bin/env node
// After the broker's welcome is queued, a later failure in first-email processing must
// keep the deal (and alert), not delete it. Found live 2026-11-14: the email provider's
// daily quota ran out at the admin-prelim send and FFFF tore down deals whose brokers had
// already been welcomed.
const fs = require('fs');
const wh = fs.readFileSync('src/routes/webhook.js', 'utf8');
let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };
ok('welcomeQueued declared with the scaffold reference', /let createdDeal = null;[\s\S]{0,300}let welcomeQueued = false;/.test(wh));
ok('set when (and only when) the welcome is actually sent', /\} else \{\s*welcomeQueued = true;\s*emailService\.sendEmailDelayed\(/.test(wh) && (wh.match(/welcomeQueued = true/g) || []).length === 1);
ok('teardown skipped once welcomed', /if \(createdDeal && welcomeQueued\) \{[\s\S]{0,200}no teardown[\s\S]{0,40}\} else if \(createdDeal\) \{[\s\S]{0,120}deleteDeal\(createdDeal\.id\)/.test(wh));
ok('admin alert tells the truth about the welcome', /The broker HAS received the welcome email/.test(wh) && /The sender did NOT receive a welcome email/.test(wh));
console.log(`\n[intake-teardown] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
