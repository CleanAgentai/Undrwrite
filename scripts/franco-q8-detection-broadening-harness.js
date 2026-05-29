#!/usr/bin/env node
// FRANCO-PREDICTED-Q8-EXTENSION harness (BATCH 12) — joint-via-name-conjunction
// detection broadening. Positives = the 3 joint fixtures' phrasings; negatives =
// FP-guards; plus the existing-mortgage-non-suppression regression guard.
const de = require('../src/services/discrepancy-engine');
const fs = require('fs');
const { detectJointFromNames, runDiscrepancyDetectionAggregated } = de;
let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };
const joint = (s) => detectJointFromNames('', s);

console.log('[1] positives — the 3 joint fixtures (detected via textSources)');
ok('E11 spousal', (joint('Joint refi for Marcus Webb and Patricia Webb (spouses, both on title).')||[]).length === 2);
ok('E12 non-spousal', (joint('Non-spousal joint refi: David Okafor and Jennifer Tran are unrelated co-owners.')||[]).join('|') === 'David Okafor|Jennifer Tran');
ok('F12 spousal', (joint('Joint refi for Patricia Simmons and James Simmons (spouses).')||[]).join('|') === 'Patricia Simmons|James Simmons');
ok('ampersand "&" form', (joint('Refi for Marcus Webb & Patricia Webb.')||[]).length === 2);
ok('borrower_name field direct', (detectJointFromNames('Marcus Webb and Patricia Webb', '')||[]).length === 2);

console.log('[2] negatives — false-positive guards');
ok('single borrower → null', joint('Refi for Marcus Webb. Clean file.') === null);
ok('named accountant role-disqualified', joint('Marcus Webb and John Smith, his accountant, are on the file.') === null);
ok('lowercase "his accountant" → null', joint('Marcus Webb and his accountant handle it.') === null);
ok('single first-names "Tom and Jerry" → null (require full names)', joint('Tom and Jerry are the contacts.') === null);
ok('guarantor context → null', joint('The guarantor is Jane Doe and Marcus Webb co-signs.') === null);
ok('cosigner (no "and") → null', joint('Marcus Webb with co-signer Patricia Webb.') === null);
ok('same name twice → null', joint('Marcus Webb and Marcus Webb typo.') === null);

console.log('[3] regression guard — existing_first_mortgage NOT suppressed for name-conjunction (spousal shares one mortgage)');
const inbound = [{ direction: 'inbound', body: 'Joint refi for Marcus Webb and Patricia Webb (spouses). Existing first mortgage: RBC, balance $300,000. Loan $280k against $650k.' }];
const docs = [{ file_name: 'mortgage_statement.pdf', classification: 'mortgage_statement', text: 'RBC payout total $300,000 on 1142 Tory Road.' }];
const res = runDiscrepancyDetectionAggregated(inbound, docs, 'Jonathan Ferrara', { emailSubject: 'Refinance — Marcus Webb and Patricia Webb' });
ok('joint_multi_borrower detected via name-conjunction (display signal)', Array.isArray(res.joint_multi_borrower) && res.joint_multi_borrower.length === 2);
// Suppression is gated on detectJointMultiBorrower (credit-bureau). No credit reports →
// it returns null → suppression SKIPPED → a spousal name-conjunction joint keeps its
// (single, shared) existing_first_mortgage data. This is the regression guard.
ok('suppression trigger (detectJointMultiBorrower) null → suppression skipped', de.detectJointMultiBorrower(docs) === null);

console.log('[4] source invariants');
const eng = fs.readFileSync('src/services/discrepancy-engine.js', 'utf8');
ok('display union NOT triggering suppression (jointDisplay separate var)', /jointDisplay = jointBorrowers \|\| detectJointFromNames/.test(eng));
ok('suppression still keyed on credit-bureau jointBorrowers only', /const jointBorrowers = detectJointMultiBorrower\(savedDocs\);[\s\S]{0,200}existing_first_mortgage_lender = \[\]/.test(eng));

console.log(`\n[franco-q8-detection-broadening] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
