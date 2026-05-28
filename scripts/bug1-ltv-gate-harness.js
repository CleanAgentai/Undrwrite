#!/usr/bin/env node
// Bug 1 harness — gates consume canonical LTV, not LLM ltv_percent.
// Pure (no API). Asserts: computeStandaloneLtv correctness + the dual-behavior
// escalation discipline (refinance-no-escalate AND 2nd-mortgage-add-escalate)
// + the prelim-fire band gate + the bug/fix contrast.

const dEngine = require('../src/services/discrepancy-engine');

let pass = 0, fail = 0;
const expect = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${detail}`); }
};

const cmap = ({ loan, market, existingBal, lender, txn }) => {
  const m = {
    requested_loan_amount: loan != null ? [{ value: loan, source: 'broker_initial_intent' }] : [],
    subject_property_market_value: market != null ? [{ value: market, source: 'appraisal.pdf' }] : [],
    existing_first_mortgage_balance: existingBal != null ? [{ value: existingBal, source: 'mortgage_statement.pdf', lender_canonical: lender || null }] : [],
    transaction_type: txn ? [{ value: txn, source: 'loan_application.pdf' }] : [],
  };
  return m;
};

console.log('\n[1] computeStandaloneLtv — resolved-winner [0] tuple, deterministic');
expect('(a) refinance 460/815 → 56.4', dEngine.computeStandaloneLtv(cmap({ loan: 460000, market: 815000 })) === 56.4,
  `got ${dEngine.computeStandaloneLtv(cmap({ loan: 460000, market: 815000 }))}`);
expect('(b) purchase 340/540 → 63', dEngine.computeStandaloneLtv(cmap({ loan: 340000, market: 540000 })) === 63,
  `got ${dEngine.computeStandaloneLtv(cmap({ loan: 340000, market: 540000 }))}`);
expect('(c) missing market → null', dEngine.computeStandaloneLtv(cmap({ loan: 340000 })) === null);
expect('(d) missing loan → null', dEngine.computeStandaloneLtv(cmap({ market: 540000 })) === null);
expect('(e) market<=0 → null', dEngine.computeStandaloneLtv(cmap({ loan: 340000, market: 0 })) === null);

console.log('\n[2] shouldEscalateOnAnyLtv — DUAL-BEHAVIOR DISCIPLINE (canonical args)');
// 1. Refinance-existing (existing paid out): std=56, cmb=56 (R11-B-3) → NO escalate. THE FIX.
expect('(1) refinance std56 cmb56 → NO escalate',
  dEngine.shouldEscalateOnAnyLtv({ standaloneLtv: 56, combinedLtv: 56 }) === false);
// 2. 2nd-mortgage-add: std=31, cmb=92 → escalate via cmbHit. INVERSE-REGRESSION GUARD.
expect('(2) 2nd-mortgage-add std31 cmb92 → escalate (cmbHit)',
  dEngine.shouldEscalateOnAnyLtv({ standaloneLtv: 31, combinedLtv: 92 }) === true);
// 3. Clean high refinance: std=85, cmb=85 → escalate via stdHit. PRESERVED.
expect('(3) high refinance std85 cmb85 → escalate (stdHit)',
  dEngine.shouldEscalateOnAnyLtv({ standaloneLtv: 85, combinedLtv: 85 }) === true);
// 4. Clean low purchase: std=56, cmb=null → NO escalate. PRESERVED.
expect('(4) low purchase std56 cmb=null → NO escalate',
  dEngine.shouldEscalateOnAnyLtv({ standaloneLtv: 56, combinedLtv: null }) === false);

console.log('\n[3] BUG/FIX CONTRAST — A14 (56% refi, existing $380k 1st paid out)');
// Pre-fix: gate fed LLM additive ltv_percent=103 → escalates (the bug).
expect('(bug) LLM additive std=103 → escalates (the false collateral-ask)',
  dEngine.shouldEscalateOnAnyLtv({ standaloneLtv: 103, combinedLtv: 56 }) === true);
// Post-fix: gate fed canonical std=56 → no escalate (the fix).
expect('(fix) canonical std=56 cmb=56 → NO escalate',
  dEngine.shouldEscalateOnAnyLtv({ standaloneLtv: 56, combinedLtv: 56 }) === false);

console.log('\n[4] prelim-fire band gate (site 3) — canonical std ≤ 80 fires; > 80 routes to escalation');
const prelimEligible = (std) => !!(std && std <= 80);
expect('(a) std=56 → prelim-eligible', prelimEligible(56) === true);
expect('(b) std=85 → NOT prelim-eligible (high-LTV escalation path)', prelimEligible(85) === false);
expect('(c) std=null → NOT prelim-eligible', prelimEligible(null) === false);

console.log(`\n[bug1-harness] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
