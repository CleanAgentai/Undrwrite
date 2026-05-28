#!/usr/bin/env node
// FRANCO-Q5 unit harness — corporate-borrower detection + accountant-financials doc-ask.
// Layer 1 (reliable) primary detection; Layer 2 (best-effort) multi-entity + clarification;
// Layer 3 Snapshot flag. Numeric evaluation of financial-statement CONTENTS is out of scope.

const ce = require('../src/services/corporate-entities');
const dEngine = require('../src/services/discrepancy-engine');

let pass = 0, fail = 0;
const ok = (label, cond) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}`); };
const det = (borrowerName, textSources = '') => ce.detectCorporateEntities({ borrowerName, textSources });

console.log('\n[1] Layer 1 — primary detection on standard suffixes');
for (const n of ['Webb Industries Inc.', 'Maione Holdings Ltd.', 'Pinnacle Corp', 'Summit Corporation', 'Acme Incorporated', 'Northstar Limited', 'Maple LLC']) {
  ok(`"${n}" → corporate`, det(n).isCorporate === true);
}

console.log('\n[2] Layer 1 — numbered companies');
ok('"1234567 Ontario Inc." → corporate', det('1234567 Ontario Inc.').isCorporate === true);
ok('"2024-12345 BC Ltd." → corporate', det('2024-12345 BC Ltd.').isCorporate === true);

console.log('\n[3] false-positive guards');
ok('"John Smith" (personal) → NOT corporate', det('John Smith').isCorporate === false);
ok('"Smith Holdings" (no suffix, ambiguous) → NOT corporate', det('Smith Holdings').isCorporate === false);
ok('personal → no doc-ask', det('Jane Doe').docAskLines === '');

console.log('\n[4] single corporate → primary doc-ask + entityCount 1');
const one = det('Webb Industries Inc.', 'Refinance for Webb Industries Inc., 1142 Tory Rd.');
ok('entityCount 1', one.entityCount === 1);
ok('doc-ask is accountant-prepared + named', /Accountant-prepared financial statements for Webb Industries Inc\./.test(one.docAskLines));
ok('no clarification', one.clarificationPending === false);

console.log('\n[5] Layer 2 — multi-entity with clear linkage → both counted');
const multi = det('Webb Industries Inc.', 'The borrower also owns a rental property through Maione Capital Inc.');
ok('entityCount 2', multi.entityCount === 2);
ok('additional Maione Capital Inc. confirmed', multi.allEntities.some(e => /Maione Capital Inc/.test(e.name) && e.role === 'additional_confirmed'));
ok('doc-ask includes BOTH entities', /Webb Industries Inc\./.test(multi.docAskLines) && /Maione Capital Inc/.test(multi.docAskLines));
ok('no clarification (linkage clear)', multi.clarificationPending === false);

console.log('\n[6] Layer 2 — ambiguous additional entity → clarification, NOT silently added');
const ambig = det('Webb Industries Inc.', 'Webb Industries Inc. is the borrower. Separately, Pinnacle Group Corp was mentioned.');
ok('additional Pinnacle Group Corp pending', ambig.allEntities.some(e => /Pinnacle Group Corp/.test(e.name) && e.role === 'additional_pending'));
ok('clarificationPending true', ambig.clarificationPending === true);
ok('clarification message names the entity + asks about collateral linkage', /Pinnacle Group Corp/.test(ambig.clarificationMessage) && /collateral/.test(ambig.clarificationMessage));
ok('pending entity NOT in doc-ask (no silent guess)', !/Pinnacle Group Corp/.test(ambig.docAskLines));

console.log('\n[7] Layer 3 — Snapshot corporate flag rows');
const cmap = { requested_loan_amount: [{ value: 500000, source: 'loan_application' }], subject_property_market_value: [{ value: 900000, source: 'appraisal' }] };
const snapMulti = dEngine.renderDealSnapshot(cmap, { corporateEntities: multi });
ok('aggregate corporate row (2 entities)', /Corporate borrower:<\/strong> 2 entities — accountant-prepared financials required/.test(snapMulti));
ok('per-entity primary row', /Webb Industries Inc\. — primary/.test(snapMulti));
ok('per-entity additional (confirmed) row', /Maione Capital Inc.* — additional \(confirmed\)/.test(snapMulti));
const snapAmbig = dEngine.renderDealSnapshot(cmap, { corporateEntities: ambig });
ok('clarification-needed note on ambiguous', /Additional entity — clarification needed:/.test(snapAmbig));
const snapPersonal = dEngine.renderDealSnapshot(cmap, { corporateEntities: det('John Smith') });
ok('personal → no corporate rows (additive guard)', !/Corporate borrower:/.test(snapPersonal));

console.log(`\n[franco-q5-harness] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
