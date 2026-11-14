#!/usr/bin/env node
// F1 — an admin-approved or Q9-overridden deal must not re-enter awaiting_collateral on
// the broker's next email, and the broker reply prompt must stop raising the LTV.
const { shouldHoldForCollateral: hold } = require('../src/routes/webhook').__test__;
const fs = require('fs');
let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };
const base = { ltvShouldEscalate: true, collateralOffered: false, identityClashUnresolved: false };

ok('unapproved active >80% deal → hold (unchanged)', hold({ ...base, deal: { status: 'active', extracted_data: {} } }));
ok('admin-approved deal (prelim_approved_at) → no hold', !hold({ ...base, deal: { status: 'active', prelim_approved_at: '2026-11-14', extracted_data: {} } }));
ok('Q9-overridden deal (collateral_override_at) → no hold', !hold({ ...base, deal: { status: 'active', extracted_data: { collateral_override_at: '2026-11-14' } } }));
ok('collateral already offered → no hold (unchanged)', !hold({ ...base, collateralOffered: true, deal: { status: 'active', extracted_data: {} } }));
ok('identity clash pending → no hold (unchanged)', !hold({ ...base, identityClashUnresolved: true, deal: { status: 'active', extracted_data: {} } }));
ok('LTV within threshold → no hold (unchanged)', !hold({ ...base, ltvShouldEscalate: false, deal: { status: 'active', extracted_data: {} } }));

const ai = fs.readFileSync('src/services/ai.js', 'utf8');
const wh = fs.readFileSync('src/routes/webhook.js', 'utf8');
ok('broker-reply prompt has the LTV-cleared branch', /ltv_admin_cleared \? `LTV ALREADY CLEARED BY UNDERWRITING/.test(ai));
ok('active branch passes ltv_admin_cleared from prelim_approved_at / override', /ltv_admin_cleared: !!existingDeal\.prelim_approved_at \|\| !!existingDeal\.extracted_data\?\.collateral_override_at/.test(wh));

console.log(`\n[f1-no-collateral-loop] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
