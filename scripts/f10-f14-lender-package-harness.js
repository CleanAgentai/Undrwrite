#!/usr/bin/env node
// F10 — lender-package checklist follows the completion gate's document rules.
// F14 — the "Ready to Close" lender package uses the same code-built Snapshot, roster
//       (Q3/Q4/Q11) and corporate detection (Q5) as the admin prelim.
const fs = require('fs');
const { buildReviewSnapshotParts } = require('../src/routes/webhook').__test__;
const ai = fs.readFileSync('src/services/ai.js', 'utf8');
const wh = fs.readFileSync('src/routes/webhook.js', 'utf8');
let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}${d ? ` — ${d}` : ''}`); };

// F10 — exercise the checklist builder directly (it's module-private; load it from source).
const src = ai.slice(ai.indexOf('const labelIncomeDocument'), ai.indexOf('const INITIAL_EMAIL_PROMPT'));
const build = new Function(`${src}; return buildLenderPackageChecklist;`)();
const doc = (classification, file_name) => ({ classification, file_name });
let html = build([doc('mortgage_balance_statement', 'Balance_Statement.pdf')]);
ok('F10: balance statement alone → payout row NOT ticked', /Mortgage Payout Statement — ✗ Not on file \(balance statement received: Balance_Statement\.pdf/.test(html));
html = build([doc('mortgage_statement', 'Payout_Statement.pdf')]);
ok('F10: real payout statement → ticked', /Mortgage Payout Statement — ✓ Received \(Payout_Statement\.pdf\)/.test(html));
html = build([doc('purchase_contract', 'APS.pdf')], { isPurchase: true });
ok('F10: purchase deal lists the purchase contract instead of a payout statement', /Purchase Contract — ✓ Received \(APS\.pdf\)/.test(html) && !/Mortgage Payout/.test(html));
ok('F10: both checklist call sites pass isPurchase', (ai.match(/buildLenderPackageChecklist\(documents, \{ isPurchase: isPurchaseFromSummary\(dealSummary\) \}\)/g) || []).length === 2);

// F14 — shared parts produce the code-built Snapshot with roster + corporate rows.
const parts = buildReviewSnapshotParts({
  deal: { borrower_name: 'Webb Holdings Ltd.' },
  dealSummary: { borrower_name: 'Webb Holdings Ltd.' },
  dealDocs: [], inboundMessages: [{ body: 'Corporate refi for Webb Holdings Ltd. Marcus Webb is the guarantor.' }],
  detect: { joint_multi_borrower: [] },
  filteredMap: { requested_loan_amount: [{ value: 400000 }], subject_property_market_value: [{ value: 800000 }] },
  ownershipType: 'corporate',
});
ok('F14: shared parts render a Deal Snapshot', /Deal Snapshot/i.test(parts.snapshotHtml));
ok('F14: corporate borrower row present (Q5)', /Corporate borrower/i.test(parts.snapshotHtml) && parts.corporate.isCorporate === true);
ok('F14: roster built (Q3/Q4; single party → no aggregation directive)', Array.isArray(parts.roster?.roster) && parts.roster.multiParty === false && parts.roster.aggregationDirective === null);
ok('F14: prelim uses the shared helper', /const \{ roster: _q3Roster, corporate: _q5Corporate, snapshotHtml: _bSnapshotHtml \} = buildReviewSnapshotParts\(/.test(wh));
ok('F14: lender package uses the shared helper + code-built Snapshot', /const _f14 = buildReviewSnapshotParts\([\s\S]{0,900}noSnapshot: true[\s\S]{0,400}multiPartyQualificationOverride: _f14\.roster\.aggregationDirective[\s\S]{0,200}prependDealSnapshot\(aiService\.stripVienna_DealSnapshot\(pkg\)\.stripped, _f14\.snapshotHtml\)/.test(wh));

console.log(`\n[f10-f14-lender-package] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
