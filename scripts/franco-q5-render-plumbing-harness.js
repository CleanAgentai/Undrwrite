#!/usr/bin/env node
// FRANCO-Q5 RENDER-PLUMBING FIX harness (BATCH 12). The detector + threading were
// always correct; the gap was the INPUT — _q5Corporate keyed on leadSummaryBrokerName
// (broker-first), shadowing the corporate borrower. This harness proves the input
// choice is decisive + locks the fix at both webhook.js call sites + the render.
const fs = require('fs');
const ce = require('../src/services/corporate-entities');
const de = require('../src/services/discrepancy-engine');
let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };

console.log('[1] input choice is decisive (the root cause)');
ok('borrower identity "Webb Holdings Ltd." → isCorporate', ce.detectCorporateEntities({ borrowerName: 'Webb Holdings Ltd.', textSources: 'Corporate refi for Webb Holdings Ltd.' }).isCorporate === true);
ok('broker name "Jason Mercer" → NOT corporate (the shadowing bug)', ce.detectCorporateEntities({ borrowerName: 'Jason Mercer', textSources: 'Corporate refi for Webb Holdings Ltd.' }).isCorporate === false);
ok('empty borrowerName → NOT corporate (L1 does not scan textSources)', ce.detectCorporateEntities({ borrowerName: '', textSources: 'Webb Holdings Ltd.' }).isCorporate === false);

console.log('[2] render: corporateEntities → Snapshot "Corporate borrower" row');
const corp = ce.detectCorporateEntities({ borrowerName: 'Webb Holdings Ltd.', textSources: '' });
const html = de.renderDealSnapshot({ requested_loan_amount: [{ value: 585000 }], subject_property_market_value: [{ value: 900000 }] }, { corporateEntities: corp });
ok('Snapshot renders "Corporate borrower:" row', /<strong>\s*Corporate borrower\s*:\s*<\/strong>/i.test(html));
ok('row names the entity + accountant financials', /Webb Holdings Ltd\./.test(html) && /accountant-prepared financials/i.test(html));

console.log('[3] source invariants — both webhook.js call sites key on borrower identity');
const wh = fs.readFileSync('src/routes/webhook.js', 'utf8');
ok('prelim site uses deal.borrower_name (not leadSummaryBrokerName)', /_q5Corporate = ce\.detectCorporateEntities\(\{\s*borrowerName: dealSummary\?\.borrower_name \|\| deal\.borrower_name/.test(wh));
ok('prelim site no longer falls back to leadSummaryBrokerName for Q5', !/borrowerName: dealSummary\?\.borrower_name \|\| leadSummaryBrokerName/.test(wh));
ok('R10-I site prefers deal.borrower_name', /borrowerName: dealSummary\?\.borrower_name \|\| deal\.borrower_name \|\| borrowerName/.test(wh));

console.log('[4] negative — broker-name still must not trigger (regression guard)');
ok('"Mercer Mortgage Group" (broker co.) not corporate via L1 borrower slot when borrower is personal', ce.detectCorporateEntities({ borrowerName: 'Marcus Webb', textSources: 'from Mercer Mortgage Group' }).isCorporate === false);

console.log(`\n[franco-q5-render-plumbing] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
