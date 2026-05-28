#!/usr/bin/env node
// FRANCO-Q7 unit harness — non-Canadian SUBJECT-PROPERTY auto-decline detector.
// Asserts conservative, PROPERTY-SCOPED detection: declines on strong US signals
// in the property region; does NOT decline on Canadian properties, on a
// US-resident borrower with a Canadian property (the key false-positive guard),
// or when no property region is present (fail-open).

const cf = require('../src/services/canonical-fields');
let pass = 0, fail = 0;
const ok = (label, cond) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}`); };
const oos = (body) => cf.detectNonCanadianProperty(body).outOfScope;

console.log('\n[1] positive — non-Canadian property declines');
ok('bold block, FL state+ZIP', oos('*Borrower:* Jane Doe *Property:* 500 Ocean Dr, Miami, FL 33139*'));
ok('fallback line, NY state+ZIP', oos('Property: 123 Main St, Buffalo, NY 14201\nLTV 60%'));
ok('ZIP+4 format', oos('*Property:* 88 Beacon St, Boston, MA 02108-1234*'));
ok('country line (USA)', oos('Property: 742 Evergreen Terrace, Springfield, USA\n'));

console.log('\n[2] negative — Canadian properties process normally');
ok('AB w/ postal', !oos('*Property:* 1142 Tory Road NW, Edmonton, AB T6R 3K2*'));
ok('Calgary, city only no postal', !oos('Property: 412 Coach Side Crescent SW, Calgary'));
ok('ON Ontario (not a US state) w/ Canadian postal', !oos('*Property:* 50 King St W, Toronto, ON M5X 1A9*'));
ok('Canadian addr w/ 5-digit STREET number (not state+ZIP)', !oos('*Property:* 12345 66 Street NW, Edmonton, AB T5X 1A1*'));

console.log('\n[3] CRITICAL false-positive guard — US borrower, CANADIAN property');
ok('US-resident borrower line does NOT trigger (property is Canadian)',
   !oos('*Borrower:* John Smith (currently resides at 50 Main St, Buffalo, NY 14201) *Property:* 1142 Tory Road NW, Edmonton, AB T6R 3K2*'));
ok('US signal in prose BEFORE property block does NOT trigger',
   !oos('The borrower also owns a place in Miami FL 33139.\n*Property:* 1142 Tory Road NW, Edmonton, AB T6R 3K2*'));

console.log('\n[4] fail-open — no property region → do not decline');
ok('no property anchor → process', !oos('Hi Franco, refi for Marcus Webb, loan $260k, please advise.'));
ok('empty body → process', !oos(''));

console.log('\n[5] signal string is populated on decline');
const sig = cf.detectNonCanadianProperty('*Property:* 500 Ocean Dr, Miami, FL 33139*');
ok('signal present + descriptive', sig.outOfScope === true && typeof sig.signal === 'string' && /FL 33139/.test(sig.signal));

console.log(`\n[franco-q7-harness] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
