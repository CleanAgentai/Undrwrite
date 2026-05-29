# BATCH 13 — full faithful 125-scenario re-run (2026-05-29)

Staging: **53f5773** (Path-2 bundle: Bug1/2 + Franco-9 + BATCH-7 fixtures + Q10 + Bug-3 +
Q5-render-plumbing + Q8-extension). Dataset: `bulletproof-fullmatrix-results-3.json`
(superset of results-2.json — adds per-scenario raw-render capture). NO triage / NO
fix-cycles — this is the clean dataset BATCH-14 consumes.

## Run health
- **125/125 complete, 0 ERRORS** (machinery clean — vs BATCH-8 which also had 0 errors).
- **Cleanup: 125/125 auto-cleaned (100%), 0 sweep residual.** Major win vs BATCH-8's
  54-deal leak — the BATCH-11 Phase-1 threading + Phase-4 runTag-email sweep hardening
  is validated at scale.
- Duration **12,935s ≈ 3.59h** (longer than BATCH-8's ~2h — the BATCH-11 poll-for-stable
  windows are the cost). Cost **~$31.25** (BATCH-8 parity).

## Status: 9 PASS / 116 non-pass (114 fail + 1 placeholder C07 + 1 inference_unknown E17)
Non-pass is EXPECTED — the matrix's expected.json mostly predates the (held) LIST-C updates;
BATCH-13 produces the clean signal to do them. The meaningful read is the TRANSITIONS:
- **FAIL→PASS (6, BATCH-12 fix wins):** A01, A13 (broker_correction mechanism + Q10),
  A03 (transaction_type casing), B09 (Q10), **E01** (Bug-3 "$X against $Y" — confirms the
  9b "premature-prelim" diagnosis was WRONG; it was the extraction gap), F17.
- **PASS→PASS (3):** A29, E18, F18.
- **PASS→FAIL (1 — flagged):** **A33** — expects "410,000" (existing 1st-mortgage balance
  from the loan_app fallback) in the prelim; didn't surface this run. NOT a Bug-3 effect
  (loan $525k extracts via the formal label, unchanged). Hypothesis: premature-prelim-before-docs
  (the loan_app balance wasn't available at the premature prelim — timing-sensitive). →
  BATCH-13-NEW-FINDING; isolate in BATCH-14, don't call genuine yet.

## HEADLINE — Bug-3 × Q1 compose: 15 NEW escalations
awaiting_collateral: **BATCH-8 = 30 → BATCH-13 = 41** (+11 net; 15 newly escalate, 4 no longer).
**Newly escalating (active→awaiting_collateral): A06 A17 D06 D08 E02 E03 E28 E29 F01 F06 F07
F12 F14 F23 F24.** Mechanism: Bug-3 now extracts the loan amount from broker shorthand
("Loan $X", "$X against $Y", etc.) → for a refi WITHOUT explicit payout language, Q1's
R11-B-3 carve-out correctly does not fire → combined LTV (existing + new) computes → exceeds
80% → escalates for clarification (Finding-1b family). Pre-Bug-3 the null loan MASKED this.
**This is CORRECT per the ratified Q1 rule** — but the SCALE (41/125 = 33% now escalate,
+15 from this compose) is a **Franco product-design question**: is escalating one-third of
deals for "no explicit payout language" the intended conservatism, or too aggressive for
clean refis? (F03 sanity-check predicted this; BATCH-13 shows it is matrix-wide.) → surface
to Franco; do NOT triage in BATCH-13.

## Per-feature live-fire tallies (step 5c/5d)
### Bug-3 (5d) — loan/value extraction
- **WINS (loan extracts + Combined-LTV row renders):** E01 (260k, 70%, now PASS), E07
  (120k, 69.4%), E13 (280k, 77.7%). The "$X against $Y", "Nth mortgage request", and bare
  "Loan $X" patterns all confirmed live.
- **Extracted but escalated (loan drove the Q1 escalation):** the 15 newly-escalating set.
- **Still TBD in the canonical Snapshot (held → BATCH-14):** F04 (ed.loan=185k but snap=TBD),
  F13 (ed.loan=145k but snap=TBD) — their specific 2nd-mortgage phrasing isn't covered by
  the Bug-3 patterns; canonical loan-render gap persists.
### Q10 (5c) — broker_correction re-notify: CONFIRMED
- **4 scenarios fire the [UPDATED] correction notice:** A01 ✓ (PASS), A13 ✓ (PASS), C07
  (placeholder), B09. The broker_correction verification-surface mechanism (0c826b9)
  classifies A01/A13 correctly. A34 correctly does NOT fire (no prelim at intake → not a
  post-prelim correction — as documented).
### Q8 (5c) — joint-via-name: PARTIAL
- **E11 ✓** renders "Joint Applicants: Marcus Webb, Patricia Webb (2 borrowers)". E12 (no
  prelim, active) + F12 (escalated) don't reach a prelim → row not observable. 1/3 confirmed;
  the other 2 blocked by the same no-prelim flow issue as Q5.
### Q5 (5c) — corporate row: 0/2 (CORPORATE-DEAL-PRELIM-FLOW confirmed matrix-wide)
- **0 corporate scenarios rendered the row** — F03 (active, no prelim) + E14 (escalated)
  both never reach a prelim. Confirms the BATCH-12 sanity prediction: corporate deals rarely
  reach a prelim. Q5's Snapshot-row fix remains deployed + unit-verified but NOT live-confirmed.

## Specific-scenario tracking (step 6)
| Scenario | BATCH-13 | Read |
|---|---|---|
| **A14** | awaiting_collateral (escalates per Q1) | spec update UNBLOCKED → expect escalation (Finding-1b genuine). |
| **A14P** | active, loan 460k, value 815k, 56.4% (payout carve-out fires) | renders correctly. |
| **F03** | active, ed.loan=null, NO prelim | **NON-DETERMINISTIC** vs the sanity check (which escalated) — the Bug-3×Q1 escalation is timing-sensitive (did the loan extract before the prelim/escalation decision?). → BATCH-14 isolate. |
| **E07 + Bug-3 set** | E01/E07/E13 ✓ extract+render; F04/F13 still TBD; A24/E23/E08 extract-but-no-prelim | per-pattern: "Loan $X"/"$X against $Y"/"Nth mortgage" all work; 2nd-mortgage-correction phrasings (F04/F13) still gap. |
| **E11/E12/F12 (Q8)** | E11 ✓ row; E12/F12 no prelim | broadening works where a prelim fires. |
| **A01/A13/C07/A34 (broker_corr)** | A01/A13 PASS, C07 Q10-fires, A34 correct-no-fire | mechanism validated. |
| **Corporate (F03/E14)** | 0 reach prelim | CORPORATE-DEAL-PRELIM-FLOW. |

## BATCH-14 scope refinement (what the dataset shows)
1. **Q1-ESCALATION-SCALE** → Franco product-design question (15 new + 41 total escalations;
   is refi-without-explicit-payout escalation too aggressive?). Gates the LIST-C cat-1 bulk update.
2. **F03 non-deterministic escalation** (timing-sensitive Bug-3×Q1) → isolate.
3. **A33 premature-prelim flip** → isolate (loan_app-balance timing).
4. **F04/F13 canonical loan-render gap** (Bug-3 patterns don't cover their 2nd-mortgage phrasing) → still held.
5. **Q5/Q8 corporate/joint PRELIM-FLOW** — deals don't reach prelims → Q5/Q8 live-fire blocked;
   needs the flow fix or purpose-built non-escalating doc-complete scenarios.
6. **LIST-C bulk now unblocked** for the cleanly-resolved sets (broker_correction A01/A13 pass;
   E01/E07/E13 combined-LTV; A14 escalation) — pending the cat-1 scale ratification (#1).
