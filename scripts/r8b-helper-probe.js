// R8-B helper probe — sanity-check stripPerfectOpener against the 10
// production corpus shapes + over-fire negatives.
const { stripPerfectOpener } = require('../src/services/ai');

const cases = [
  // ─── Shape A (greeting-prefixed, 6/10) ───
  { label: 'Shape A — Nadia S15 (Hi there + em-dash)',
    input: '<p>Hi there! Perfect — thank you for the clarification! I\'ve received Anna Bergstrom\'s documents.</p>',
    expectedContains: '<p>Hi there! Thank you for the clarification!',
    expectedNotContains: 'Perfect' },
  { label: 'Shape A — Lena Park (Hi name + comma)',
    input: '<p>Hi Jason! Perfect, thank you for clarifying the credit scores — 748/752 is much better.</p>',
    expectedContains: '<p>Hi Jason! Thank you for clarifying',
    expectedNotContains: 'Perfect' },
  { label: 'Shape A — Derek Olsen (Hi name + em-dash)',
    input: '<p>Hi Jason! Perfect — thanks for confirming the approval! I\'ve received all the documentation.</p>',
    expectedContains: '<p>Hi Jason! Thanks for confirming the approval!',
    expectedNotContains: 'Perfect' },
  { label: 'Shape A — Grace Paulson (Hi name + comma)',
    input: '<p>Hi Jason! Perfect, thanks for that clarification! You\'re absolutely right.</p>',
    expectedContains: '<p>Hi Jason! Thanks for that clarification!',
    expectedNotContains: 'Perfect' },
  { label: 'Shape A — Mateen / d9d4b218 (Hi name + exclamation)',
    input: '<p>Hi Jason! Perfect! Thank you for sending over the T4s, appraisal, payout statement.</p>',
    expectedContains: '<p>Hi Jason! Thank you for sending over',
    expectedNotContains: 'Perfect' },
  { label: 'Shape A — Joe and Lori Smith (Hi Franco + comma)',
    input: '<p>Hi Franco! Perfect, thank you for the detailed information and the completed forms!</p>',
    expectedContains: '<p>Hi Franco! Thank you for the detailed information',
    expectedNotContains: 'Perfect' },

  // ─── Shape B1 (bare with capitalized name, 3/10) ───
  { label: 'Shape B1 — Mateen / cd376914 (Perfect, Franco — admin-collision)',
    input: '<p>Perfect, Franco! Thank you for submitting all the documentation. I\'ve reviewed everything.</p>',
    // Franco-as-name routes through anti-collision → "Hi there!" fallback
    expectedContains: '<p>Hi there! Thank you for submitting',
    expectedNotContains: 'Perfect' },
  { label: 'Shape B1 — Mateen / 5fbc221d (Perfect, Jason — clean rewrite)',
    input: '<p>Perfect, Jason! I\'ve received the driver\'s licenses for both Mateen and Kochay.</p>',
    expectedContains: '<p>Hi Jason! I\'ve received the driver\'s licenses',
    expectedNotContains: 'Perfect' },
  { label: 'Shape B1 — Mateen / 5fbc221d alt (Perfect, Jason + Thanks)',
    input: '<p>Perfect, Jason! Thanks for sending the correct appraisal — I\'ve received the appraisal for 874 Rideau Cres NW.</p>',
    expectedContains: '<p>Hi Jason! Thanks for sending the correct appraisal',
    expectedNotContains: 'Perfect' },

  // ─── Shape B2 (bare without capitalized name, 1/10) ───
  { label: 'Shape B2 — Norris Yu (Perfect, thanks Franco)',
    input: '<p>Perfect, thanks Franco! Looking forward to receiving those items tomorrow.</p>',
    // B1 doesn't match (lowercase "thanks") → B2 strip-no-rewrite
    expectedContains: '<p>Thanks Franco! Looking forward',
    expectedNotContains: 'Perfect' },

  // ─── OVER-FIRE PROTECTION negatives ───
  { label: 'Negative — sentence-internal "Perfect" (adjective)',
    input: '<p>Hi Jason! The appraisal value of $695,000 is perfect for this LTV range.</p>',
    expectedContains: 'perfect for this LTV range',
    expectedNotContains: 'CHANGED' },
  { label: 'Negative — "Perfect" in second paragraph (out of scope)',
    input: '<p>Hi Jason! Thanks for sending those over.</p><p>Perfect timing on these — we have everything we need.</p>',
    expectedContains: '<p>Perfect timing on these',
    expectedNotContains: 'CHANGED' },
  { label: 'Negative — no opener Perfect at all',
    input: '<p>Hi Jason! Thanks for the quick reply. We\'ll review and get back to you.</p>',
    expectedContains: '<p>Hi Jason! Thanks for the quick reply',
    expectedNotContains: 'CHANGED' },
  { label: 'Negative — empty input',
    input: '',
    expectedContains: '',
    expectedNotContains: 'X' },
  { label: 'Negative — null input',
    input: null,
    expectedContains: null,
    expectedNotContains: 'X' },
];

let fails = 0;
for (const c of cases) {
  const result = stripPerfectOpener(c.input);
  const out = result.swept;
  const sweptAny = result.sweptAny;
  let pass = true;
  let reason = '';
  if (c.expectedContains !== null && out !== null && !String(out).includes(c.expectedContains)) {
    pass = false;
    reason = `missing expected="${c.expectedContains}"`;
  }
  if (c.expectedNotContains && out && String(out).includes(c.expectedNotContains)) {
    pass = false;
    reason += (reason ? '; ' : '') + `contains forbidden="${c.expectedNotContains}"`;
  }
  if (!pass) fails++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'} [${c.label}] sweptAny=${sweptAny}`);
  if (!pass) {
    console.log(`    INPUT:  ${JSON.stringify(c.input)?.slice(0, 200)}`);
    console.log(`    OUTPUT: ${JSON.stringify(out)?.slice(0, 200)}`);
    console.log(`    REASON: ${reason}`);
  }
}
console.log(`\n${fails === 0 ? 'all pass' : fails + ' fails'}`);
process.exit(fails);
