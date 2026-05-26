// R9-C empirical-grounding — extractFromEmailBody city/province extraction
// on Marcus + Derek production retest fixture shapes.
//
// R6-δ shipped two patterns (canonical-fields.js:319-363):
//   (1) Inline-comma WITH province: "<street-suffix>, <City>, <AB|BC|...>"
//       — Sandra S8 84feed85 "412 Windermere Close SW, Edmonton, AB T6W 0R1"
//   (2) Informal "X property at <street>" pattern: "Calgary property at ..."
//       — Patricia S5 + Kevin S6 prose
//
// Marcus retest (996a676c): "Property: 1142 Tory Road NW, Edmonton" — comma
// after suffix-direction + city, NO province. Doesn't match (1) (requires
// province group); doesn't match (2) (requires "property at" connector).
// Falls through to null → Deal Snapshot shows "City / Province: TBD".
//
// Derek retest (df33cdbf): "Property: 5519 Henwood Road SW, Calgary" —
// same shape, same fall-through to TBD.
//
// Empirical tasks:
//   (a) confirm extractFromEmailBody returns null city/province on both
//   (b) confirm Deal Snapshot would render TBD (already verified in DB)
//   (c) propose a NEW pattern: comma-after-suffix + city + NO province
//       → city populated, province null (same partial-closure as R6-δ
//       informal pattern; no city→province lookup, no over-fit beyond AB)
//   (d) cross-corpus regression check — Sandra S8 / Patricia S5 / Kevin S6
//       fixtures must still extract correctly post-extension

const cf = require('../src/services/canonical-fields');

const fixtures = [
  // ─── New R9-C shapes (currently fail) ───
  {
    label: 'Marcus retest (996a676c) — "Property: <street>, <city>" no province',
    body: `Hi,

My name is Cecilia Fontaine from Goldstream Mortgage Group (Lic. #MB446152). I'd like to submit a new file for your review.

Borrower: Marcus Webb
Property: 1142 Tory Road NW, Edmonton
Loan Request: Second mortgage for debt consolidation
Existing mortgage: RBC`,
    subject: 'New File Submission — Marcus Webb',
    expected: { city: 'Edmonton', province: null },
  },
  {
    label: 'Derek retest (df33cdbf) — same shape (Calgary, no AB)',
    body: `Hi,

My name is Mohammed Al-Farsi from Trident Mortgage Solutions (Lic. #MB557263). I'd like to submit a new file for review.

Borrower: Derek Olsen
Property: 5519 Henwood Road SW, Calgary
Loan Request: Second mortgage for debt consolidation
Existing mortgage: Scotia`,
    subject: 'New File Submission — Derek Olsen',
    expected: { city: 'Calgary', province: null },
  },

  // ─── R6-δ preserved patterns (must NOT regress) ───
  {
    label: 'R6-δ inline-comma WITH province (Sandra S8 shape)',
    body: `Hi,

*Borrower:* Sandra Fletcher *Property:* 412 Windermere Close SW, Edmonton, AB T6W 0R1
*Loan Amount Requested:* $68,000 *Mortgage Position:* 2nd`,
    subject: 'Second Mortgage — Sandra Fletcher',
    expected: { city: 'Edmonton', province: 'AB' },
  },
  {
    label: 'R6-δ informal "<City> property at <street>" (Patricia S5 / Kevin S6 shape)',
    body: `Hi, I'm submitting Patricia Simmons's file. Calgary property at 412 Coach Side Crescent SW. Loan request $75,000.`,
    subject: 'New File',
    expected: { city: 'Calgary', province: null },
  },

  // ─── Over-fire guards ───
  {
    label: 'No address → null city / province',
    body: 'Hi, I have a question about underwriting. No specific deal yet.',
    subject: 'Question',
    expected: { city: null, province: null },
  },
  {
    label: 'Street with no city → null',
    body: 'Property: 1142 Tory Road NW',
    subject: 'Submission',
    expected: { city: null, province: null },
  },
  {
    label: 'Bold-template variant of new shape — "*Property:* <street>, <city>" no province',
    body: `*Borrower:* Test Person *Property:* 555 Maple Avenue NW, Edmonton *Loan Amount Requested:* $100,000`,
    subject: 'Test',
    expected: { city: 'Edmonton', province: null },
  },
];

let fails = 0;
console.log('R9-C EMPIRICAL GROUNDING — extractFromEmailBody city/province');
console.log('═'.repeat(72));
for (const fx of fixtures) {
  const out = cf.extractFromEmailBody(fx.body, fx.subject);
  const got = { city: out.subject_property_city, province: out.subject_property_province };
  const pass = got.city === fx.expected.city && got.province === fx.expected.province;
  console.log(`\n${pass ? 'PASS' : 'FAIL'} [${fx.label}]`);
  console.log(`  got: ${JSON.stringify(got)}`);
  console.log(`  expected: ${JSON.stringify(fx.expected)}`);
  if (!pass) fails++;
}
console.log(`\n${fails === 0 ? 'all pass' : fails + ' fails — empirical confirmation of pre-R9-C gap'}`);
process.exit(fails > 0 ? 1 : 0);
