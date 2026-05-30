#!/usr/bin/env node
// BUG-4 harness — canonical-incompleteness escalation guard (deterministic; the
// production transient is rarer than any repetition probe, so THIS is the verification
// surface, not empirical "always escalates").
const de = require('../src/services/discrepancy-engine');
const fs = require('fs');
const g = de.shouldEscalateOnIncompleteCanonical;
let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };

console.log('[1] POSITIVE — F03 transient pattern → escalate');
ok('mortgage_statement + combined null + no payout + loan → escalate',
   g({ hasMortgageStatement: true, combinedLtv: null, payoutConfirmed: false, hasLoanAmount: true }) === true);

console.log('[2] NEGATIVES — no over-escalation');
ok('clean first-mortgage (no mortgage_statement) → no guard', g({ hasMortgageStatement: false, combinedLtv: null, payoutConfirmed: false, hasLoanAmount: true }) === false);
ok('payout-confirmed refi (carve-out null is legit) → no guard', g({ hasMortgageStatement: true, combinedLtv: null, payoutConfirmed: true, hasLoanAmount: true }) === false);
ok('combined computed cleanly (non-null) → no guard', g({ hasMortgageStatement: true, combinedLtv: 116, payoutConfirmed: false, hasLoanAmount: true }) === false);
ok('combined computed cleanly low (65) → no guard', g({ hasMortgageStatement: true, combinedLtv: 65, payoutConfirmed: false, hasLoanAmount: true }) === false);
ok('no loan amount (null not from incompleteness) → no guard', g({ hasMortgageStatement: true, combinedLtv: null, payoutConfirmed: false, hasLoanAmount: false }) === false);
ok('empty input → no guard', g({}) === false);

console.log('[3] REGRESSION — guard composes with (does not replace) normal escalation');
// normal escalation (combined 116 > 80) handled by shouldEscalateOnAnyLtv, unaffected by the guard
ok('shouldEscalateOnAnyLtv still fires on combined>80 (dominant F03 path)', de.shouldEscalateOnAnyLtv({ standaloneLtv: 65, combinedLtv: 116 }) === true);
ok('guard does NOT fire when combined is the clean 116 (escalation handled normally)', g({ hasMortgageStatement: true, combinedLtv: 116, payoutConfirmed: false, hasLoanAmount: true }) === false);

console.log('[4] A33 IS DISTINCT — guard correctly does NOT catch it (surfaced separately)');
// A33: existing balance from loan_app, NO mortgage_statement (statement "pending"); transient
// is a PRELIM-RENDER omission of the loan_app balance, NOT the combined-LTV escalation gate.
ok('A33 pattern (no mortgage_statement, not an escalation) → guard does NOT fire', g({ hasMortgageStatement: false, combinedLtv: null, payoutConfirmed: false, hasLoanAmount: true }) === false);

console.log('[5] source invariants — wired into the intake gate');
const wh = fs.readFileSync('src/routes/webhook.js', 'utf8');
ok('_bug4IncompleteCanonical computed via shouldEscalateOnIncompleteCanonical', /_bug4IncompleteCanonical = dEngine\.shouldEscalateOnIncompleteCanonical\(/.test(wh));
ok('composed OR into the escalation branch', /else if \(_r1InitialShouldEscalate \|\| _bug4IncompleteCanonical\)/.test(wh));
ok('gated on mortgage_statement classification', /hasMortgageStatement: initialClassifications\.includes\('mortgage_statement'\)/.test(wh));
ok('payoutConfirmed from transaction_type tuple', /payoutConfirmed: \(_r1InitialCanonicalMap\.transaction_type \|\| \[\]\)\.some\(t => t && t\.payoutConfirmed === true\)/.test(wh));

console.log(`\n[bug4-canonical-incompleteness-guard] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
