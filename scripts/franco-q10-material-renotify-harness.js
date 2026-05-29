#!/usr/bin/env node
// FRANCO-Q10 unit harness — post-prelim broker-correction admin re-notification.
// Tests the deterministic material-change detector + false-positive guards + the
// source invariants of the text-only-noop hook. Full behavioral (email fires on a
// real post-prelim correction) is the Phase-5 integration spot-check.

const fs = require('fs');
let q10DetectMaterialChanges, q10ParsePriorFromPrelim;
try { ({ q10DetectMaterialChanges, q10ParsePriorFromPrelim } = require('../src/routes/webhook').__test__); }
catch (e) { console.error('require webhook __test__ failed:', e.message); process.exit(2); }

let pass = 0, fail = 0;
const ok = (label, cond) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}`); };

const prior = { loan_amount_requested: 260000, property_value: 700000, existing_mortgage_balance: 380000, property_address: '1142 Tory Rd NW', loan_type: 'refinance' };

console.log('\n[1] material change → detected');
const c1 = q10DetectMaterialChanges(prior, { ...prior, loan_amount_requested: 295000 });
ok('loan amount 260k→295k detected', c1.length === 1 && c1[0].key === 'loan_amount_requested' && c1[0].new === 295000 && c1[0].old === 260000);
const c2 = q10DetectMaterialChanges(prior, { ...prior, property_value: 735000 });
ok('property value change detected', c2.length === 1 && c2[0].key === 'property_value');
const c3 = q10DetectMaterialChanges(prior, { ...prior, loan_type: 'purchase' });
ok('loan_type (transaction/position) change detected', c3.length === 1 && c3[0].key === 'loan_type');
const c4 = q10DetectMaterialChanges(prior, { ...prior, existing_mortgage_balance: 400000 });
ok('existing balance change detected', c4.length === 1);

console.log('\n[2] false-positive guards');
ok('no change → 0', q10DetectMaterialChanges(prior, { ...prior }).length === 0);
ok('non-material change (borrower_name) → 0', q10DetectMaterialChanges(prior, { ...prior, borrower_name: 'New Name', contact_phone: '555' }).length === 0);
ok('before-prelim (no prior snapshot) → 0 (admin sees first prelim)', q10DetectMaterialChanges(null, { ...prior, loan_amount_requested: 999 }).length === 0);
ok('current field null/absent → not counted as change', q10DetectMaterialChanges(prior, { ...prior, loan_amount_requested: null }).length === 0);

console.log('\n[3] multiple material changes → all detected');
const cm = q10DetectMaterialChanges(prior, { ...prior, loan_amount_requested: 295000, property_value: 735000, loan_type: 'purchase' });
ok('3 material changes detected', cm.length === 3);
ok('each carries old→new + field label', cm.every(c => c.old != null && c.new != null && typeof c.field === 'string'));

console.log('\n[3b] v2 prior-null guard + prelim parse');
// prior parseable for loan only (PV null) → PV change NOT flagged (false-positive guard)
ok('prior field null → not a change', q10DetectMaterialChanges({ loan_amount_requested: 260000, property_value: null }, { loan_amount_requested: 260000, property_value: 700000 }).length === 0);
const parsed = q10ParsePriorFromPrelim('<p><strong>Loan Amount Requested:</strong> $260,000</p><p><strong>Appraised Value:</strong> $700,000</p>');
ok('q10ParsePriorFromPrelim parses loan + appraised value', parsed.loan_amount_requested === 260000 && parsed.property_value === 700000);
ok('parse returns null for absent figures', q10ParsePriorFromPrelim('<p>no money here</p>').loan_amount_requested === null);
// end-to-end v2: prior parsed from prelim (260k) vs current (295k) → change
ok('v2 flow: prelim-parsed prior 260k vs current 295k → change', q10DetectMaterialChanges(q10ParsePriorFromPrelim('<p><strong>Loan Amount Requested:</strong> $260,000</p>'), { loan_amount_requested: 295000 }).length === 1);

console.log('\n[4] source invariants (v2)');
const wh = fs.readFileSync(fs.existsSync('src/routes/webhook.js') ? 'src/routes/webhook.js' : '../src/routes/webhook.js', 'utf8');
ok('prior derived from prelim outbound (q10ParsePriorFromPrelim)', /_q10LastPrelim\s*\?\s*q10ParsePriorFromPrelim\(_q10LastPrelim\.body\)/.test(wh));
ok('re-notify hooked in text-only-noop branch', /text-only-noop[\s\S]{0,2600}q10DetectMaterialChanges\(_q10Prior, reviewResult\.updatedSummary\)/.test(wh));
ok('audit trail (_q10_admin_renotified_at + fields)', /_q10_admin_renotified_at/.test(wh) && /_q10_renotified_fields/.test(wh));
ok('sendAdminMaterialCorrectionNotice helper exists', /const sendAdminMaterialCorrectionNotice = async/.test(wh));
ok('delta-only notice (not full Snapshot re-render)', /Delta only; the full prelim Snapshot is not re-sent/.test(wh));
ok('NO clobber-prone snapshot write at prelim (removed in v2)', !/_q10_last_notified:\s*_q10LastNotified/.test(wh));
const ae = fs.readFileSync(fs.existsSync('test-fixtures/bulletproof/lib/assertEngine.js') ? 'test-fixtures/bulletproof/lib/assertEngine.js' : '../test-fixtures/bulletproof/lib/assertEngine.js', 'utf8');
ok('assertEngine recognizes admin_material_correction_notice kind', /admin_material_correction_notice:/.test(ae));

console.log(`\n[franco-q10-harness] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
