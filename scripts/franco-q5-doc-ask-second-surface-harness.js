#!/usr/bin/env node
// FRANCO-Q5-DOC-ASK-SECOND-SURFACE-FIX harness (BATCH 14). Consolidated borrower-identity
// source correction across the 3rd same-root call site (doc-ask) + 2 audit-surfaced roster
// sites. The doc-ask self-compute now keys on dealSummary.borrower_name || dealBorrowerName
// (the persisted deal.borrower_name threaded from the webhook) instead of summary-only.
const ce = require('../src/services/corporate-entities');
const fs = require('fs');
let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };

console.log('[1] threading logic — borrower identity reaches detectCorporateEntities');
const pick = (summaryName, dealName) => summaryName || dealName || ''; // mirrors ai.js:2826 fallback
ok('summary empty + dealBorrowerName corporate → corporate name used',
   ce.detectCorporateEntities({ borrowerName: pick('', 'Webb Holdings Ltd.'), textSources: '' }).isCorporate === true);
ok('doc-ask lines produced for the corporate entity',
   /Webb Holdings Ltd\./.test(ce.detectCorporateEntities({ borrowerName: pick('', 'Webb Holdings Ltd.'), textSources: '' }).docAskLines));
ok('summary has corporate name → used directly (dealBorrowerName not needed)',
   ce.detectCorporateEntities({ borrowerName: pick('Webb Holdings Ltd.', null), textSources: '' }).isCorporate === true);
ok('PRE-FIX shape (summary-only, empty) → NO doc-ask (the bug)',
   ce.detectCorporateEntities({ borrowerName: pick('', null), textSources: 'Corporate refi for Webb Holdings Ltd.' }).isCorporate === false);
ok('personal borrower → no corporate doc-ask (no over-trigger)',
   ce.detectCorporateEntities({ borrowerName: pick('', 'Marcus Webb'), textSources: '' }).isCorporate === false);

console.log('[2] source invariants — ai.js doc-ask + 3 webhook call sites + 2 roster sites');
const aijs = fs.readFileSync('src/services/ai.js', 'utf8');
ok('ai.js generateDocumentRequestEmail accepts dealBorrowerName opt', /generateDocumentRequestEmail:[\s\S]{0,400}dealBorrowerName = null/.test(aijs));
ok('ai.js doc-ask keys on borrower identity (summary || dealBorrowerName)', /borrowerName: dealSummary\?\.borrower_name \|\| dealBorrowerName \|\| ''/.test(aijs));
const wh = fs.readFileSync('src/routes/webhook.js', 'utf8');
ok('all 3 generateDocumentRequestEmail call sites thread dealBorrowerName: existingDeal.borrower_name',
   (wh.match(/dealBorrowerName: existingDeal\.borrower_name/g) || []).length === 3);
ok('roster site 1 (prelim) uses deal.borrower_name (not leadSummaryBrokerName)', /primaryName: dealSummary\?\.borrower_name \|\| deal\.borrower_name \|\| null/.test(wh));
ok('roster site 2 (R10-I) prefers deal.borrower_name', /primaryName: dealSummary\?\.borrower_name \|\| deal\.borrower_name \|\| borrowerName \|\| null/.test(wh));
ok('no remaining _q3Roster broker-first fallback (leadSummaryBrokerName for primaryName)', !/primaryName: dealSummary\?\.borrower_name \|\| leadSummaryBrokerName/.test(wh));

console.log(`\n[franco-q5-doc-ask-second-surface] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
