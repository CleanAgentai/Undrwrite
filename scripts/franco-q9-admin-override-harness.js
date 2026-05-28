#!/usr/bin/env node
// FRANCO-PREDICTED-Q9 unit harness — admin-override on awaiting_collateral.
// The override logic is inline in webhook.js's admin-reply handler (a large
// handler with DB+AI side effects, not isolation-unit-testable), so this harness
// verifies: (1) webhook.js parses (syntax); (2) the audit-merge logic shape
// (pure-function replica); (3) source invariants — the branch exists, precedes
// the under_review branch, transitions to active, and stores the audit in
// extracted_data (NO new DB column / migration), keyed on email.from.
// Full behavioral verification is the gated post-bundle integration replay.

const fs = require('fs');
const { execSync } = require('child_process');

let pass = 0, fail = 0;
const ok = (label, cond) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}`); };

console.log('\n[1] webhook.js parses (node --check)');
try { execSync('node --check src/routes/webhook.js', { cwd: process.cwd() + '/..', stdio: 'pipe' }); ok('syntax valid', true); }
catch (e) {
  // fall back to checking from repo root regardless of cwd
  try { execSync('node --check src/routes/webhook.js', { stdio: 'pipe' }); ok('syntax valid', true); }
  catch (e2) { ok('syntax valid', false); console.log('    ' + String(e2.stderr || e2.message).split('\n')[0]); }
}

console.log('\n[2] audit-merge logic (pure-function replica of the override path)');
const overrideMerge = (extracted, overrideAt, by) => ({
  ...(extracted || {}),
  collateral_override_at: overrideAt,
  collateral_override_by: by,
});
const before = { borrower_name: 'Marcus Webb', collateral_offered: false, ltv_percent: 56 };
const after = overrideMerge(before, '2026-05-28T20:00:00.000Z', 'franco@privatemortgagelink.ca');
ok('preserves existing extracted_data fields', after.borrower_name === 'Marcus Webb' && after.ltv_percent === 56);
ok('stamps collateral_override_at', after.collateral_override_at === '2026-05-28T20:00:00.000Z');
ok('stamps collateral_override_by = sender', after.collateral_override_by === 'franco@privatemortgagelink.ca');
ok('does not clobber collateral_offered', after.collateral_offered === false);

console.log('\n[3] source invariants');
const root = fs.existsSync('src/routes/webhook.js') ? '.' : '..';
const src = fs.readFileSync(`${root}/src/routes/webhook.js`, 'utf8');
const idxAwc = src.indexOf("} else if (existingDeal.status === 'awaiting_collateral') {");
const idxUnder = src.indexOf("} else if (existingDeal.status === 'under_review') {");
ok('awaiting_collateral admin branch exists', idxAwc !== -1);
ok('precedes the under_review branch (correct chain order)', idxAwc !== -1 && idxUnder !== -1 && idxAwc < idxUnder);
const branch = src.slice(idxAwc, idxUnder);
ok('override transitions to active', /status:\s*'active'/.test(branch));
ok('audit stored in extracted_data (collateral_override_at)', /collateral_override_at/.test(branch) && /_q9UpdatedExtracted/.test(branch));
ok('audit keyed on sender (email.from)', /collateral_override_by:\s*email\.from/.test(branch));
ok('NO new top-level DB column update for override fields', !/update\([^)]*collateral_override_at:/.test(branch));
ok('handles rejected + conditions intents too', /intent === 'rejected'/.test(branch) && /generateAdminResponseEmail/.test(branch));

console.log(`\n[franco-q9-harness] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
