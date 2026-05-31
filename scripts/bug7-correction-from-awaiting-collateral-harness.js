#!/usr/bin/env node
// BUG-7 harness (BATCH 15) — correction-intent routing from awaiting_collateral.
//
// The webhook awaiting_collateral broker-reply branch (webhook.js:~3545) now runs a
// correction-intent PRE-CHECK before parseCollateralReply, reusing the R10-G classifier
// cFields.parseBrokerCorrections (composed, not duplicated). This harness verifies the
// DETERMINISTIC decision function that gates the pre-check: does parseBrokerCorrections
// fire on correction shapes and NOT on collateral/ambiguous shapes?
//
// The full routing + active-branch R10-G application + LTV-gate re-eval is verified
// end-to-end in the Phase-5 spot-checks (F14 positive, B07 negative, A01 regression).
const cF = require('../src/services/canonical-fields');
const fs = require('fs');
const S = require('path').join(__dirname, '..', 'test-fixtures', 'bulletproof', 'scenarios');
const pick = (id) => fs.readdirSync(S).find(d => d.startsWith(id));
const ev1 = (id) => require(require('path').join(S, pick(id), 'events.json'))[1].postmark.TextBody;

let pass = 0, fail = 0;
// isCorrection = the pre-check predicate: parseBrokerCorrections(text).length > 0
const isCorrection = (t) => cF.parseBrokerCorrections(t).length > 0;
const fields = (t) => cF.parseBrokerCorrections(t).map(c => c.field).join(',');
const check = (label, got, want) => { const ok = got === want; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}  isCorrection=${got}${got ? ' ['+want+']' : ''}`); ok ? pass++ : fail++; };

console.log('— POSITIVE: correction-intent in awaiting_collateral → route to active-branch correction-processing —');
check('F14 purchase→refi ("this is actually a refinance")', isCorrection(ev1('F14')), true);
check('explicit loan correction', isCorrection('Correction — the correct amount is $415,000, not $360,000.'), true);
check('position correction', isCorrection('Actually this is a 1st mortgage (1st position), not a 2nd.'), true);
check('purpose correction', isCorrection('The correct purpose is debt consolidation, not renovation.'), true);

console.log('— NEGATIVE: genuine collateral / ambiguous replies → fall through to parseCollateralReply UNCHANGED —');
check('B07 collateral offer', isCorrection(ev1('B07')), false);
check('plain "yes I can add a 2nd property"', isCorrection('Yes, the borrower can pledge a second property as additional security.'), false);
check('ambiguous "let me check on collateral"', isCorrection('Let me check with the borrower on whether there is additional collateral.'), false);
check('plain decline "no additional collateral"', isCorrection('No, there is no additional collateral available.'), false);

console.log('— CONSERVATIVE (false-negative bias): hedged / question corrections do NOT fire —');
check('hedged "I think this is a refinance"', isCorrection('I think this is actually a refinance'), false);
check('question "is this a refinance?"', isCorrection('Wait, is this actually a refinance?'), false);

console.log('— REGRESSION: classifier still detects pre-Bug-7 correction shapes —');
check('Marcus "this is a first mortgage"', isCorrection('To confirm, this is a first mortgage (1st position).'), true);
check('"the amount should be $X"', isCorrection('The loan amount should be $250,000.'), true);

console.log('\nNOTE: routing + R10-G application + LTV gate re-eval verified end-to-end in Phase-5 spot-checks');
console.log(`BUG-7 harness: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
