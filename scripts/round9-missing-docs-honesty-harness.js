// Round-9 (Katherine Morrison, 2026-06-11) — STANDING INVARIANT HARNESS.
// Franco Scenario-1 bug report, two bugs:
//   Bug 1 — broker welcome email declared "everything looks complete" while 3 intake
//           docs (gov ID, property tax, payout) were still outstanding.
//   Bug 2 — a T4 was misflagged as a Notice of Assessment in the admin prelim.
// This harness pins the deterministic invariants that eliminate both classes. It is a
// standalone self-asserting test (exit 1 on any failure) — run: node scripts/round9-missing-docs-honesty-harness.js
//
// INVARIANTS (must hold forever):
//   I1 (Bug 2): T4 content classifies as income_proof, never 'noa'; a T4 file produces
//               NO classification mismatch; a genuine NOA still classifies as 'noa'.
//   I2 (Bug 1): computeMissingIntakeItems is the single source of truth and reports the
//               actual outstanding intake set.
//   I3 (Bug 1): when intake items are missing, enforceMissingDocsHonesty strips EVERY
//               completeness overclaim AND ensures the outstanding items are communicated.
//   I4 (Bug 1): when nothing is missing, the guard is a strict no-op (legit complete path).

const assert = require('assert');
const deals = require('../src/services/deals');
const ai = require('../src/services/ai');
const { computeMissingIntakeItems } = require('../src/lib/dealType');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failures++; console.log('  ✗ ' + name + '\n      ' + e.message); }
};

// Representative real-document text bodies (markers that actual CRA docs carry).
const T4_TEXT = [
  'T4 Statement of Remuneration Paid',
  'Canada Revenue Agency / Agence du revenu du Canada',
  'Year: 2025',
  'Employer: Northbridge Logistics Inc.',
  'Box 14 Employment income  92,400.00',
  "Box 22 Income tax deducted  18,110.00",
].join('\n');

const NOA_TEXT = [
  'Notice of Assessment',
  'Canada Revenue Agency',
  'Tax year: 2024',
  'We assessed your 2024 income tax and benefit return.',
  'Total income: $94,200   Net federal tax: $12,880',
].join('\n');

console.log('\n=== I1 — Bug 2: T4 vs NOA classification ===');
check('T4 content classifies as income_proof (not noa)', () => {
  const c = deals.__test__.classifyByContent(T4_TEXT);
  assert.strictEqual(c, 'income_proof', `got '${c}'`);
});
check('T4 file produces NO classification mismatch', () => {
  const m = deals.detectClassificationMismatch('T4_Katherine_Morrison_2025.pdf', T4_TEXT);
  assert.strictEqual(m, null, `got mismatch ${JSON.stringify(m)}`);
});
check('genuine NOA still classifies as noa', () => {
  const c = deals.__test__.classifyByContent(NOA_TEXT);
  assert.strictEqual(c, 'noa', `got '${c}'`);
});
check('NOA file (named NOA, NOA content) produces NO mismatch', () => {
  const m = deals.detectClassificationMismatch('NOA_Katherine_2024.pdf', NOA_TEXT);
  assert.strictEqual(m, null, `got mismatch ${JSON.stringify(m)}`);
});

// Gov ID copies are collected FOR FINTRAC/AML identity verification, so their cover text
// cites AML/FINTRAC — must NOT classify as 'aml' or throw a false mismatch callout
// (surfaced on Franco's real Scenario-1 GovernmentID_Katherine_Morrison.pdf).
const GOV_ID_TEXT = [
  "GOVERNMENT-ISSUED IDENTIFICATION — COPY ON FILE",
  "Collected by broker for AML identification purposes — Private Mortgage Link",
  "PROVINCE OF ALBERTA  DRIVER'S LICENCE",
  "KATHERINE ANNE MORRISON",
  "LICENCE NO: AB-4418-76931   EXP: 2029-03-18",
  "collected from the borrower for the purpose of identity verification pursuant to FINTRAC Anti-Money Laundering regulations.",
].join('\n');
check('Gov ID with FINTRAC/AML cover text classifies as government_id (not aml)', () => {
  const c = deals.__test__.classifyByContent(GOV_ID_TEXT);
  assert.strictEqual(c, 'government_id', `got '${c}'`);
});
check('Gov ID file produces NO classification mismatch', () => {
  const m = deals.detectClassificationMismatch('GovernmentID_Katherine_Morrison.pdf', GOV_ID_TEXT);
  assert.strictEqual(m, null, `got mismatch ${JSON.stringify(m)}`);
});

// Form-template docs (PML blank Loan Application / PNW AcroForms) extract only field
// labels ("Mortgage Type", "Balance Owing") — must NOT drive a mismatch callout
// (Scenarios 8/9/12/14 false "PNW reads as Mortgage Balance Statement").
const PNW_FORM_TEXT = [
  'Personal Statement of Affairs', 'DOB: Gender:', 'SIN: Marital Status:',
  'Mortgage Type: First  Second', 'Asset Value', 'Balance Owing', 'Mortgage Balance',
  'Assets', 'Liabilities', 'Chequing Account', 'RRSP', 'TFSA', 'Name:', 'Email:',
].join('\n');
check('PNW form template produces NO mismatch (form-like, not content-classified)', () => {
  const m = deals.detectClassificationMismatch('PNW_Statement_Sandra_Fletcher.pdf', PNW_FORM_TEXT);
  assert.strictEqual(m, null, `got mismatch ${JSON.stringify(m)}`);
});
// Borrower name "Noah" must not trigger the NOA filename rule (Scenario 12).
check('T4 file for borrower "Noah" classifies income_proof, not noa (filename)', () => {
  const c = deals.__test__.classifyDocument('T4_Noah_MacKenzie_2025.pdf', T4_TEXT);
  assert.strictEqual(c, 'income_proof', `got '${c}'`);
});
check('genuine NOA-named file still classifies noa (filename)', () => {
  const c = deals.__test__.classifyDocument('NOA_Mateen_2025.pdf', NOA_TEXT);
  assert.strictEqual(c, 'noa', `got '${c}'`);
});
check('AML/PEP forms never drive a mismatch callout (compliance suppression)', () => {
  // AML form whose body cites the verified ID type ("Driver's Licence") → content may read
  // government_id; compliance-class on either side suppresses the callout.
  const amlText = 'FINTRAC Client Identification and Verification — Anti-Money Laundering\nID Type verified: Driver\'s Licence  Licence No: AB-123\nProceeds of Crime (Money Laundering) Act compliance.';
  assert.strictEqual(deals.detectClassificationMismatch('AML_Form_Sandra_Whitfield.pdf', amlText), null);
});

console.log('\n=== I2 — Bug 1: single source of truth (computeMissingIntakeItems) ===');
check("Katherine's 5-of-8 refinance → gov ID + property tax + payout missing", () => {
  // received: loan_application(form, not intake-required), pnw(form), income_proof(T4),
  // appraisal, credit_report. Missing intake docs: government_id, property_tax, mortgage_statement.
  const classifications = ['loan_application', 'pnw_statement', 'income_proof', 'appraisal', 'credit_report'];
  const missing = computeMissingIntakeItems({ classifications, isPurchase: false, exitStrategy: 'sale at maturity' });
  assert.deepStrictEqual(missing, ['government_id', 'property_tax', 'mortgage_statement'], JSON.stringify(missing));
});
check('NOA satisfies income_proof (synonym-aware)', () => {
  const classifications = ['government_id', 'appraisal', 'property_tax', 'mortgage_statement', 'noa', 'credit_report'];
  const missing = computeMissingIntakeItems({ classifications, isPurchase: false, exitStrategy: 'refi' });
  assert.deepStrictEqual(missing, [], JSON.stringify(missing));
});
check('null exit strategy is surfaced as a missing item', () => {
  const classifications = ['government_id', 'appraisal', 'property_tax', 'mortgage_statement', 'income_proof', 'credit_report'];
  const missing = computeMissingIntakeItems({ classifications, isPurchase: false, exitStrategy: null });
  assert.deepStrictEqual(missing, ['exit_strategy'], JSON.stringify(missing));
});

console.log('\n=== I3 — Bug 1: honesty guard strips overclaim + communicates missing ===');
const KATHERINE_WELCOME = `<p>Hi Loretta! I'm Vienna, the lead underwriter at Private Mortgage Link.</p><p>I received the loan application, personal net worth statement, T4, property appraisal, and credit bureau — everything looks complete for Katherine's refinance. We'll get this into review and be in touch soon!</p><p>Vienna<br>Private Mortgage Link</p>`;
const COMPLETENESS_RE = /everything(?:\s+else)?\s+(?:looks|seems|is|appears)\s+(?:complete|in order|all set|good)|have everything we need|(?:file|package|application|submission)\s+(?:is|looks|appears)\s+complete|you'?re all set|good to go|ready for review|nothing (?:further|else)\s+(?:is\s+)?needed/i;

check('Katherine welcome: completeness claim is stripped', () => {
  const r = ai.enforceMissingDocsHonesty(KATHERINE_WELCOME, ['government_id', 'property_tax', 'mortgage_statement'], { borrowerFirstName: 'Katherine' });
  assert.ok(!COMPLETENESS_RE.test(r.swept), 'overclaim survived: ' + r.swept);
});
check('Katherine welcome: all 3 missing items are communicated', () => {
  const r = ai.enforceMissingDocsHonesty(KATHERINE_WELCOME, ['government_id', 'property_tax', 'mortgage_statement'], { borrowerFirstName: 'Katherine' });
  const lc = r.swept.toLowerCase();
  assert.ok(/government[\s-]?issued id/.test(lc), 'gov ID not communicated');
  assert.ok(/property tax/.test(lc), 'property tax not communicated');
  assert.ok(/payout/.test(lc), 'payout not communicated');
});
check('Katherine welcome: doc-receipt acknowledgment is PRESERVED', () => {
  const r = ai.enforceMissingDocsHonesty(KATHERINE_WELCOME, ['government_id', 'property_tax', 'mortgage_statement'], { borrowerFirstName: 'Katherine' });
  assert.ok(/I received the loan application/i.test(r.swept), 'receipt ack lost: ' + r.swept);
});
check('dedupe: item Claude already asked for is not double-injected', () => {
  const html = `<p>Hi! I received the appraisal — could you also send a Property Tax Assessment? Everything else looks complete!</p><p>Vienna<br>Private Mortgage Link</p>`;
  const r = ai.enforceMissingDocsHonesty(html, ['property_tax', 'government_id'], {});
  assert.ok(!COMPLETENESS_RE.test(r.swept), 'overclaim survived');
  const taxCount = (r.swept.match(/property tax/gi) || []).length;
  assert.strictEqual(taxCount, 1, `property tax mentioned ${taxCount}x (expected 1 — no double-ask)`);
  assert.ok(/government[\s-]?issued id/i.test(r.swept), 'un-asked gov ID should be injected');
});

console.log('\n=== I4 — Bug 1: no-op when nothing is missing (legit complete path) ===');
check('empty missing set → guard is a strict no-op', () => {
  const html = `<p>Hi Lee! I believe we have everything we need to send the file for review. Thanks!</p><p>Vienna<br>Private Mortgage Link</p>`;
  const r = ai.enforceMissingDocsHonesty(html, [], {});
  assert.strictEqual(r.swept, html, 'guard mutated the legit-complete reply');
  assert.strictEqual(r.sweptAny, false);
  assert.strictEqual(r.injectedAny, false);
});

console.log('\n' + (failures === 0
  ? '✅ ALL ROUND-9 INVARIANTS HOLD'
  : `❌ ${failures} INVARIANT(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
