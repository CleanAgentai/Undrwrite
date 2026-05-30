> **ARCHIVED 2026-05-30 — superseded by PHASE-8-METHODOLOGY.md §c (cluster-triage→confirmation arc). Preserved for evidence lineage; not load-bearing.**

# BATCH 9 — Discipline-1 confirm/refute + (d)-candidate isolation (2026-05-29)

Classification only — NO fix-cycles. Dataset: bulletproof-fullmatrix-results-2.json.
Discipline: default = "explained by an addressed root or known artifact" until proven
otherwise (over-scoping + Bug-1→Finding-1b lessons). No GENUINE-INDEPENDENT-FINDING
without exhausting other explanations.

## KEY ROOT discovered (explains the largest cluster)
fullmatrix-1 CLUSTER-2 already proved broker_correction resolution is REQUEST-TIME-
CORRECT (A01 probe deal f4c3a541: $260k→$295k renders $295k at the render surface) and
that render-surface verification REQUIRES the prelim to fire. BATCH-7's exit_strategy
broad-add now fires the prelim AT INTAKE (turn 1) — BEFORE the broker_correction (turn 2)
— so the assertEngine reads the premature intake prelim (shows the pre-correction value).
→ **EXIT_STRATEGY-PREMATURE-PRELIM fixture-sequencing interaction (BATCH-7-introduced),
NOT a Vienna bug.** Fix is fixture-side (exit_strategy on the correction turn, or capture
post-correction). Affects every multi-turn broker-correction scenario.

## PHASE A — (b) set (12)
| Scenario | Actual | Classification |
|---|---|---|
| A13 | property_value renders intake 700k not correction 735k | EXIT_STRATEGY-PREMATURE-PRELIM (not bug; corrections present in fixture; fullmatrix-1 proved resolution correct) |
| A34 | balance renders 225k not correction 222.5k; discrepancyHold fired on 1.1% delta | PREMATURE-PRELIM + discrepancyHold-inference-noise (prelim suppressed → gate infer mis-reads); defer-9b |
| B01 | prelim suppressed (no Snapshot) — discrepancyHold-ACTIVE-major | **CONFIRM-CLEAR** — discrepancyHold fires correctly on the major discrepancy; canonical-read fails are stale-spec |
| B02 | escalated awaiting_collateral; discrepancyHold inferred=true on clean deal | DEFER-9B — Franco-9 escalation (stale-spec) masks; discrepancyHold gate infer (hasNotif && !prelim) likely false-fires when escalation suppresses prelim |
| B03 | prelim suppressed; discrepancyHold inferred=true (minor 3.6% delta) | DEFER-9B — same gate-inference-under-escalation noise |
| B07 | escalated awaiting_collateral; collateral_offered inferred=false | RECLASSIFY → Franco-9 escalation stale-spec + Discipline-2 (collateral_offered gate) |
| C06 | escalated; awaiting_collateral_after_admin_override inference_unknown | RECLASSIFY → Discipline-2 known-unobservable gate (red flag #2) + stale-spec escalation |
| D03 | escalated (high_ltv=true); elevated_ltv_band=false | **CONFIRM** entanglement real — elevated band masked by Q1 additive escalation; stale-spec |
| F06 | postal_code_discrepancy callout absent; prelim suppressed | DEFER-9B — postal callout vs prelim-suppression |
| F08 | awaiting_collateral ✓; lender "Caisse Desjardins" undefined; qc_french unobservable | RECLASSIFY → R11-B-2 lender-extraction known-gap + Discipline-2 unobservable gate |
| F19 | workflow expected admin_handoff, actual active | RECLASSIFY → the STILL-OPEN C01 admin-handoff routing disposition (product-design, not a bug) |
| F23 | active ✓ (prelim fired); elevated_ltv_band callout absent | **CONFIRM** entanglement real — R4-RESIDUAL-1 elevated-band gap (pre-existing, also seen F04 Bug1/2 integration); not a regression |

## PHASE B — parked-4 state-LTV hypothesis: **REFUTED**
None of A01/A03/A14P/A26's mismatches are state-LTV-rendered-artifacts. They are
heterogeneous → individual isolation (Phase C):
- A01 → broker-correction PREMATURE-PRELIM (not state-LTV)
- A03 → transaction_type casing "Purchase"/"purchase" (LIST-C)
- A14P → requested_loan_amount + property_value NULL (null-loan-amount cluster)
- A26 → mortgage_position wording "2nd"/"2nd mortgage" (LIST-C) + lender undefined (R11-B-2 gap)
The Phase-8 carry-forward ("harmless-for-gate ≠ harmless-for-rendered") still stands as a
principle, but state-LTV is NOT the cause of these 4 mismatches.

## PHASE C — (d) individual (12)
| Scenario | Mismatch | Classification |
|---|---|---|
| A01 | loan_amount 260k not 295k | EXIT_STRATEGY-PREMATURE-PRELIM (not bug) |
| A03 | transaction_type "Purchase" vs "purchase" | LIST-C-MIS-BUCKETED (casing → bucket a) |
| A14P | loan_amount + property_value NULL | DEFER-9B null-loan-amount cluster (likely premature-prelim before docs) |
| A20 | subject_property_address missing | DEFER-9B (address render vs regen) |
| A26 | position "2nd" vs "2nd mortgage" + lender undefined | LIST-C (wording) + R11-B-2 lender-gap |
| A27 | position null vs expected "1st mortgage" | LIST-C-MIS-BUCKETED — ambiguous-no-signal correctly yields null; spec was wrong |
| A28 | transaction_type refinance→**purchase** | **GENUINE-CANDIDATE** (Q1 purchase-detector false-positive?) defer-9b |
| C07 | multi-correction renders 280k not final 295k | EXIT_STRATEGY-PREMATURE-PRELIM (not bug) |
| E01 | loan_amount NULL | DEFER-9B null-loan-amount cluster |
| E02 | loan_amount NULL | DEFER-9B null-loan-amount cluster |
| F01 | position "2nd" wording + elevated_ltv_band=false | LIST-C (wording) + CONFIRM elevated_ltv_band entanglement (= F23/D03) |
| F02 | transaction_type purchase→**null** + joint borrower_name not both rendered | **GENUINE-CANDIDATE** (Q1 purchase missed + Q3/Q8 joint render) defer-9b |

## FINAL TALLY
- **(b) CONFIRM-CLEAR / CONFIRM-entanglement-real:** B01 (discrepancyHold-active), D03 + F23 (elevated_ltv_band / R4-RESIDUAL-1 pre-existing) = **3**
- **(b) explained-by-known-root (reclassify):** A13, A34, B07, C06, F08, F19 = 6
- **(b) defer-9b cheap-probe:** B02, B03, F06 = 3
- **(b) REFUTE-as-new-bug: 0**
- **(d) GENUINE-INDEPENDENT-FINDING candidates (NOT confirmed; fix-cycle in a later batch):** **A28, F02** (Q1 transaction_type interaction) = **2**
- **(d) explained (fixture-interaction / LIST-C / entanglement):** A01, A03, A26, A27, C07, F01 = 6
- **(d) defer-9b cheap-probe:** A14P, A20, E01, E02 (null-loan-amount + address) = 4

**Net: 0 confirmed genuine bugs. 2 genuine-candidates (A28/F02). 7 defer-9b cheap probes.
Largest cluster (broker-correction) explained as a BATCH-7 fixture-sequencing interaction.**

## BATCH 9b — deferred cheap probes (no fix-cycles)
1. null-loan-amount (A14P/E01/E02): re-run 1, inspect extracted_data + rendered Snapshot — confirm premature-prelim-before-docs vs genuine extraction gap.
2. A28/F02 transaction_type: read intake textBody — does Q1's detectPurchaseSignal mis-fire (A28) / miss (F02)?
3. discrepancyHold-under-escalation (B02/B03): confirm the gate infer() false-fires when escalation suppresses prelim (Discipline-2 gate-inference refinement).
4. F06 postal, A20 address: render vs regen.

---

# BATCH 9b — cheap-probe refinements (2026-05-29)

**NET RESULT: 0 confirmed genuine Vienna bugs.** Every BATCH-9 candidate resolved to a
known root via probes (no fix-cycles). ~$1 (3 isolated runs + offline canonical checks).

## PROBE 1 — premature-prelim: EMPIRICALLY CONFIRMED (load-bearing)
A01 isolated run, ordered outbound:
- Turn-1 prelim Snapshot = **$260,000** (intake value; prelim fires at intake because
  BATCH-7 exit_strategy is now present).
- Separate outbound = **$295,000** (correction processed CORRECTLY).
- assertEngine.findSnapshotEmail picks the FIRST Snapshot (turn-1 premature, $260k).
→ EXIT_STRATEGY-PREMATURE-PRELIM confirmed. The 6 BATCH-9 "explained-by-known-root"
classifications (A01/A13/A34/C07 + A28 correction) are now EMPIRICALLY-CONFIRMED-EXPLANATIONS.
Carry-forward grounded. NEW operational note: A01's correction landed as a SECOND deal in
replay (dedup/replay artifact, not Vienna-logic; correction value still resolves to $295k).

## PROBE 2 — A28 / F02: VERIFICATION-SURFACE-MISMATCH (not bugs)
Offline canonical (real aggregated extraction) is CORRECT for both:
- A28 → transaction_type=refinance (broker_correction) ✓ matches expected.
- F02 → transaction_type=purchase (defaulted_purchase_signal) ✓ matches expected.
The Batch-8 "actual" read extracted_data (raw pre-canonical: A28 turn-1 "buying"=purchase;
F02 Claude-raw null) for a CANONICAL request-time field. → matrix-design amendment: assert
transaction_type via canonical/render, NOT extracted_data (same as fullmatrix-1 CLUSTER-2/3).
→ LIST-C / harness-fix, NOT a Vienna fix. **0 genuine bugs from the 2 candidates.**

## PROBE 3 — null-loan-amount: NOT bugs
- E01/E02: loan amount empty-from-email (offline) → DOC-sourced → premature-prelim-before-docs
  (prelim fires at intake before doc upload → doc field null at render). Same root as Probe 1.
- A14P: canonical email loan=$460k ✓; isolated run renders $460k+$815k CORRECTLY → the Batch-8
  null was a TRANSIENT batch-capture-timing artifact, not persistent.

## PROBE 4 — B02/B03/F06: NOT bugs
- B02/B03: Batch-8 shows escalation (awaiting_collateral) → prelim suppressed →
  discrepancyHold "not fired" is correct; gate infer() (hasNotif && !hasPrelim) mis-reads
  suppression → HARNESS-MISREAD-OF-SUPPRESSION-STATE (Discipline-2 gate-inference refinement).
- F06: postal empty-from-email → cross-doc postal discrepancy needs DOCS → premature-prelim-
  before-docs (no docs processed → no discrepancy detected). Same root.

## PROBE 5 — A20: NOT a bug
Address empty-from-email (loan $280k present) → DOC-sourced address → premature-prelim-before-docs.

## UNIFYING ROOTS (all BATCH-9 candidates, 0 Vienna bugs)
1. **EXIT_STRATEGY-PREMATURE-PRELIM** (dominant) — BATCH-7 exit_strategy fires prelim at
   intake, before turn-2 corrections AND before doc-processing → captured render misses
   post-intake data. Fix: FIXTURE-SIDE (exit_strategy timing / capture post-stable-state).
2. **VERIFICATION-SURFACE-MISMATCH** — extracted_data vs canonical/render for transaction_type
   (+ the broader canonical-field render-surface rule). Fix: HARNESS/matrix-design.
3. **HARNESS-MISREAD-OF-SUPPRESSION-STATE** — gate infer() under Franco-9 escalation. Fix: harness.
4. **BATCH-CAPTURE-TIMING-TRANSIENT** (A14P) — poll-for-stable timing in batch context.
5. **Known pre-existing residuals** — elevated_ltv_band/R4-RESIDUAL-1; R11-B-2 lender-gap.
6. **LIST-C casing/wording** — A03/A26/A27/F01.

## FINAL TALLY (BATCH 9 + 9b)
- Entanglement (b): CONFIRM-CLEAR ×3 (B01, D03, F23); explained-by-known-root ×6 (now
  empirically confirmed); 0 refute-as-bug.
- (d): 0 genuine bugs (A28/F02 → verification-surface; null-cluster → premature-prelim/transient;
  rest → LIST-C/known-residual).
- **CONFIRMED GENUINE VIENNA BUGS REQUIRING FIX-CYCLES: 0.**
- Fix work ahead is FIXTURE-SIDE (premature-prelim) + HARNESS-SIDE (verification-surface,
  suppression-state) + LIST-C spec updates — NOT Vienna code.
