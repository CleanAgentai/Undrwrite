#!/usr/bin/env node
// BUG-3-EXTENSION-2 harness (BATCH 15) — bounded private-2nd-mortgage extraction.
// Two extensions to canonical-fields.js:
//   (G) requested_loan_amount: "Private Nth [mortgage] [request]: $X"
//   (position) numeric-ordinal prose "2nd mortgage" (strict superset; behind/existing FP guard)
// Per Option A: existing_first_mortgage_balance broker-prose extraction is NOT added
// (architectural conservatism — doc-verified only).
const cF = require('../src/services/canonical-fields');

const loan = (t) => { const m = cF.extractCanonicalFields(t, [], { emailSubject: '' }); const a = (m.requested_loan_amount || []).map(x => x.value); return a.length ? a[0] : null; };
const pos = (t, subj = '') => { const m = cF.extractCanonicalFields(t, [], { emailSubject: subj }); const a = (m.mortgage_position || []).map(x => x.value); return a.length ? a[0] : null; };
const pv = (t) => { const m = cF.extractCanonicalFields(t, [], { emailSubject: '' }); const a = (m.subject_property_market_value || []).map(x => x.value); return a.length ? a[0] : null; };
const f1 = (t) => { const m = cF.extractCanonicalFields(t, [], { emailSubject: '' }); const a = (m.existing_first_mortgage_balance || []).map(x => x.value); return a.length ? a[0] : null; };

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}  got=${got} want=${want}`);
  ok ? pass++ : fail++;
};

console.log('— POSITIVE: loan "Private Nth ...: $X" —');
check('Private 2nd request: $425,000', loan('Private 2nd request: $425,000'), 425000);
check('Private 2nd: $425,000', loan('Private 2nd: $425,000'), 425000);
check('Private second mortgage request: $300,000', loan('Private second mortgage request: $300,000'), 300000);
check('Private 1st request: $500,000', loan('Private 1st request: $500,000'), 500000);

console.log('— POSITIVE: numeric-ordinal position prose —');
check('Private 2nd mortgage submission', pos('Private 2nd mortgage submission for Sarah Chen'), '2nd');
check('2nd mortgage on the property', pos('Placing a 2nd mortgage on the property'), '2nd');
check('3rd mortgage (own, behind comes after)', pos('This is a 3rd mortgage behind two existing charges'), '3rd'); // "behind" follows the ordinal-mtg → own position
check('3rd mortgage (own)', pos('This is a 3rd mortgage request'), '3rd');

console.log('— NEGATIVE: loan FP guards (no ordinal / no $) —');
check('private information request: $5,000 (no ordinal)', loan('Please send a private information request: $5,000 estimate'), null);
check('Private 2nd opinion (no $)', loan('Private 2nd opinion will be needed'), null);

console.log('— NEGATIVE: position behind/existing reference guard —');
check('2nd mtg behind existing 1st → 2nd (own wins)', pos('A 2nd mortgage behind the existing 1st mortgage'), '2nd');
check('only "existing 1st mortgage" reference → null', pos('Refinancing behind the existing 1st mortgage charge'), null);

console.log('— REGRESSION: existing behavior preserved —');
check('subject "Second Mortgage —"', pos('borrower details', 'Second Mortgage — Sarah'), '2nd');
check('spelled-out "first mortgage for"', pos('first mortgage for the purchase'), '1st');
check('Bug-3 A "New 2nd mortgage request: $120,000"', loan('New 2nd mortgage request: $120,000'), 120000);
check('Bug-3-EXT F "$185k behind existing RBC 1st"', loan('Placing $185k behind existing RBC 1st'), 185000);
check('formal "Loan Amount Requested: $250,000"', loan('Loan Amount Requested: $250,000'), 250000);

console.log('— E09 full-intake (Option A: loan+position extract; existing-first stays null) —');
const E09 = `Private 2nd mortgage submission for Sarah Chen. Bank declined the refi (DSCR issue); placing with private.\nProperty: 4421 Kingsway, Vancouver, BC V5R 5T7, appraised $850k.\nExisting 1st: Royal Bank of Canada, $380k.\nPrivate 2nd request: $425,000 (combined LTV 95%).`;
check('E09 loan', loan(E09), 425000);
check('E09 position', pos(E09), '2nd');
check('E09 property value', pv(E09), 850000);
check('E09 existing-first NOT extracted (Option A conservatism)', f1(E09), null);

console.log(`\nBUG-3-EXT-2 harness: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
