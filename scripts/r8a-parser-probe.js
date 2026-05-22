// R8-A parser probe — verify parseBrokerFirstNameFromSignature on Nadia +
// Eric body shapes after inline-separator + pipe-strip hardening.
const { parseBrokerFirstNameFromSignature } = require('../src/services/ai');

const cases = [
  {
    label: 'Nadia Petrov (inline `--` + pipe-delimited sig on Lic. line)',
    body: `Hi, I'm Nadia Petrov with Eastview Mortgage Group, Lic. #MB440996. I have a client looking for a $92,000 second mortgage on her property in Calgary NW.

Nadia Petrov | Eastview Mortgage Group | Lic. #MB440996 -- Franco Maione Founder at VIMA Real Broker Mobile (780) 975-3339`,
    expected: 'Nadia',
  },
  {
    label: 'Eric Johansson (RFC-standard `\\n-- \\n` sig delim)',
    body: `Hi Vienna, I'm Eric Johansson with Northpoint Mortgage Partners (Lic. #MB994652).

Eric Johansson
Lic. #MB994652
--
Franco Maione
Founder at VIMA Real Broker`,
    expected: 'Eric',
  },
  {
    // Pre-existing parser limitation, NOT an R8-A regression — name-on-N-2
    // shape (broker name two lines above Lic.#, firm directly above). The
    // first regex captures "Pinnacle West Mortgage" (line immediately
    // preceding Lic.#). Outside R8-A scope (Nadia inline-sep / pipe + Eric
    // RFC-standard). Documenting baseline for future widening if Franco
    // surfaces a Tyler-shape production fixture.
    label: 'Name-on-N-2 shape (pre-existing limitation, not R8-A scope)',
    body: `Hi, this is Tyler Ross with Pinnacle West Mortgage. I'd like to submit a second mortgage.

Best,
Tyler Ross
Pinnacle West Mortgage
Lic. #MB112934
--
Franco Maione`,
    expected: 'Pinnacle',  // baseline: parser returns firm line, not broker name
  },
  {
    label: 'Franco-direct (admin himself, no broker sig) — anti-collision',
    body: `Hi Vienna, please find attached.

Franco Maione
Lic. #MB000000
--
Franco Maione`,
    expected: null,  // anti-collision: Franco rejected
  },
  {
    label: 'No license number at all',
    body: `Hi Vienna, I'm Jane Doe, just inquiring.`,
    expected: null,
  },
];

let fails = 0;
for (const c of cases) {
  const got = parseBrokerFirstNameFromSignature(c.body);
  const status = got === c.expected ? 'PASS' : 'FAIL';
  if (status === 'FAIL') fails++;
  console.log(`  ${status} [${c.label}]: got ${JSON.stringify(got)}, expected ${JSON.stringify(c.expected)}`);
}
console.log(`\n${fails === 0 ? 'all pass' : fails + ' fails'}`);
process.exit(fails);
