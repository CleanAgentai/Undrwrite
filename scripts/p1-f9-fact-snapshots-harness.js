#!/usr/bin/env node
// P1 — the deal's structured facts are snapshotted (intake, prelim, each change) as
//      append-only system rows that conversation queries never see.
// F9 — Q10 re-notification compares code-built facts to the prelim snapshot across all
//      five material fields (was: model summary vs 3 figures parsed from prelim HTML).
const fs = require('fs');
const { q10DetectMaterialChanges: diff } = require('../src/routes/webhook').__test__;
let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}${d ? ` — ${d}` : ''}`); };
const prior = { loan_amount_requested: 525000, property_value: 850000, existing_mortgage_balance: 210000, property_address: 'V5R5T7', loan_type: 'refinance' };
const keys = (now) => diff(prior, now).map(c => c.key).sort().join(',');

ok('no change → no notice', keys({ ...prior }) === '');
ok('loan amount change detected', keys({ ...prior, loan_amount_requested: 560000 }) === 'loan_amount_requested');
ok('property value change detected', keys({ ...prior, property_value: 800000 }) === 'property_value');
ok('existing balance change detected', keys({ ...prior, existing_mortgage_balance: 260000 }) === 'existing_mortgage_balance');
ok('F9: property (postal) change detected — unreachable before', keys({ ...prior, property_address: 'T2T1A1' }) === 'property_address');
ok('F9: transaction type / position change detected — unreachable before', keys({ ...prior, loan_type: 'refinance / 2nd' }) === 'loan_type');
ok('a field missing now (doc not yet parsed) is not a change', keys({ ...prior, existing_mortgage_balance: null }) === '');
ok('prior 0 balance = not yet known, not a change (Path B guard kept)', diff({ ...prior, existing_mortgage_balance: 0 }, { ...prior, existing_mortgage_balance: 210000 }).length === 0);

const wh = fs.readFileSync('src/routes/webhook.js', 'utf8');
const deals = fs.readFileSync('src/services/deals.js', 'utf8');
ok('prelim send records a prelim snapshot', /saveMessage\(deal\.id, 'outbound', subject, enforcedLeadSummary, reviewResult\.MessageID\);\s*await recordFactSnapshot\(deal, 'prelim'\)/.test(wh));
ok('Q10 text-only path diffs prelim snapshot vs thread facts', /_q10Prior = await q10PriorFacts\(existingDeal, _q10Msgs\)[\s\S]{0,200}q10DetectMaterialChanges\(_q10Prior, _q10Now\?\.facts\)/.test(wh));
ok('Path B uses the same diff', /q10DetectMaterialChanges\(await q10PriorFacts\(existingDeal, _pbMsgs\), _pbNow\?\.facts\)/.test(wh));
ok('conversation queries exclude snapshot rows', (deals.match(/\.neq\('direction', 'system'\)/g) || []).length >= 2);

console.log(`\n[p1-f9-fact-snapshots] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
