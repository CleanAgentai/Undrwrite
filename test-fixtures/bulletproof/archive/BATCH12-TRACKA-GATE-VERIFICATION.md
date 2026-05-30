> **ARCHIVED 2026-05-30 — superseded by PHASE-8-METHODOLOGY.md §a/§b (Bug-3 surfacing + Discipline-2). Preserved for evidence lineage; not load-bearing.**

# BATCH 12 — Track A: Discipline-2 gate verification (2026-05-29)

Empirical test of the Discipline-2 thesis ("unobserved ≠ verified — making gates
observable might surface hidden bugs") against the 12 newly-observable `GATE_INFERENCE`
entries, using the BATCH-8 dataset (bulletproof-fullmatrix-results-2.json) + offline
reasoning + two cheap single-turn deployed-code probes (E06, E07).

**VERDICT: Discipline-2 VINDICATED.** Making `combined_ltv_computed` observable surfaced
a real, previously-invisible deterministic loan-amount extraction gap (see §FLAGGED).

## Per-gate classification

| Gate | Scen | BATCH-8 | Classification | Root |
|---|---|---|---|---|
| loan_app_annotations_sanitized | A07 | inf=T/exp=T pass | **FIRED-CORRECTLY** | verified observable+correct |
| loan_app_annotations_sanitized | F11 | inf=F/exp=F pass | **NOT-FIRED-CORRECTLY** (negative case) | verified |
| awaiting_collateral_initially_activated | C06 | inf=T/exp=T pass | **FIRED-CORRECTLY** | durable collateral-ask email signal |
| mortgage_statement_missing | E18 | inf=T/exp=T pass | **FIRED-CORRECTLY** | refi payout requested |
| mortgage_statement_missing | F17 | inf=T/exp=T pass | **FIRED-CORRECTLY** | verified |
| mortgage_statement_required | E06 | inf=T/exp=F fail | **NOT-A-BUG (stale dataset)** | RESOLVED-on-deployed — see §E06 |
| property_value_missing | A16 | inf=F/exp=T fail | **GATE-OBSERVABILITY-LIMIT** | no-prelim → Snapshot surface absent |
| doc_package_incomplete | E19 | inf=F/exp=T fail | **GATE-OBSERVABILITY-LIMIT** | no-prelim → [MISSING] surface absent |
| collateral_offered | B07 | inf=F/exp=T fail | **PRE-PHASE-1-THREADING ARTIFACT** | multi-turn(2); re-verify BATCH-13 |
| broker_clarification_question_detected | E24 | inf=F/exp=T fail | **PRE-PHASE-1-THREADING ARTIFACT** | multi-turn(2); re-verify BATCH-13 |
| canonical_map_complete_after_t4 | E25 | inf=F/exp=T fail | **PRE-PHASE-1-THREADING ARTIFACT** | multi-turn(4); re-verify BATCH-13 |
| mortgage_statement_now_required | F14 | inf=F/exp=T fail | **PRE-PHASE-1-THREADING ARTIFACT** | multi-turn(2) correction; BATCH-13 |
| combined_ltv_computed | E07 | skip+inf=F | **GENUINE-CANDIDATE → BATCH-14** | loan-amount extraction gap — see §FLAGGED |
| combined_ltv_computed | F04 | skip+inf=F | spec-form (numeric) + same extraction dep | + elevated_ltv_band=R4-RESIDUAL-1 (known) |
| combined_ltv_computed | F13 | skip+inf=F | spec-form (numeric "0.729") + extraction dep | Track-B form fix |
| province_inferred | F23 | skip+inf=F | **SPEC-EXPECTATION-FORM** | + elevated_ltv_band=R4-RESIDUAL-1 (known) |

## Discipline-2 tally
- **FIRED/NOT-FIRED CORRECTLY (verified observable + correct): 5** — loan_app_annotations_sanitized (A07 pos, F11 neg), awaiting_collateral_initially_activated (C06), mortgage_statement_missing (E18, F17).
- **NOT-A-BUG, stale dataset: 1** — mortgage_statement_required (E06).
- **Gate-observability-limit (surface absent without a prelim; Track-B re-scope): 2** — property_value_missing (A16), doc_package_incomplete (E19).
- **Pre-Phase-1-threading artifact (re-verify BATCH-13 with threading): 4** — collateral_offered (B07), broker_clarification_question_detected (E24), canonical_map_complete_after_t4 (E25), mortgage_statement_now_required (F14).
- **Spec-expectation-form, non-boolean (Track-B verification-surface): 4** — combined_ltv_computed (E07/F04/F13 assert numeric LTV; province_inferred F23 asserts "NB"). The observable gate is boolean (row/inference present); the LTV/province *value* must be verified on the rendered Snapshot row, not the gate.
- **GENUINE-CANDIDATE → BATCH-14 fix-cycle: 1** — combined_ltv_computed via loan-amount extraction gap (E07).

## §E06 — mortgage_statement_required NOT-A-BUG (probe evidence)
BATCH-8 showed inf=true/exp=false (payout statement requested on a PURCHASE). Probe on
deployed code (78efbbc): is_purchase=**true**, 65% LTV, prelim fired clean, **neither**
outbound contains "current mortgage payout statement" (broker doc-ask correctly takes the
purchase branch at ai.js:2247 which omits it; prelim clean). Gate correctly does NOT fire
now. The BATCH-8 value is **stale** (pre-deployed-Franco-9 purchase detection).
→ results-2.json is a stale snapshot on multiple axes; Track-A "fails" must be re-confirmed
against deployed code (this probe is the template). BATCH-13's fresh run will show E06 green.

## §FLAGGED — GENUINE-CANDIDATE for BATCH-14: canonical loan-amount extraction gap
**Surfaced to Porter 2026-05-29 (resists exhaust-known-roots).**

E07 probe (deployed code): Mortgage Position "2nd" ✓, existing balance $380k ✓, prelim
SUBJECT computed "69% LTV" (= expected combined 0.694, read by the LLM from the email's
literal "Combined LTV: 69%"), BUT the Snapshot renders **Loan Amount Requested: TBD**,
**LTV: TBD**, and **no Combined LTV row**. Root: `requested_loan_amount` resolved to null
because the canonical loan-amount regex (canonical-fields.js:480) matches only
`Loan Amount [Requested]` / `Mortgage Amount` / `Requested Loan` / `requesting $X` — and
E07's email states **"New 2nd mortgage request: $120,000"**, which matches none. The
Combined LTV row is absent purely *downstream* of the null loan amount (computeCombinedLtv
needs the new-2nd amount). Reproduced offline:
- `"New 2nd mortgage request: $120,000"` → null
- `"New second mortgage: $120,000"` → null
- `"Loan amount requested: $120,000"` → 120000 ✓
- `"Requesting $120,000…"` → 120000 ✓

This is the **latent-robustness Finding-1a / Bug-2 family** (deterministic money extraction).
**Blast radius (reality-checked, not raw heuristic):** the email phrasings the regex misses,
present in the fixture corpus, are:
- bare `"Loan $X"` shorthand (no "Amount" keyword): **E13, E23, E28, E29, F03, F06**
- `"Nth mortgage request: $X"`: **E07, E08**
- word-order `"$Xk loan"` / `"$Xk requested"`: **A24, F07, F14**

Real *rendered* impact bites only when NO document supplies the amount as canonical fallback
(E07 confirmed renders TBD; the "Loan $X" scenarios mostly attach a loan_application doc that
MAY backfill — unconfirmed per-scenario). A SECONDARY same-family gap also surfaced: property
value via `"appraised $X"` lowercase prose (no "at"/"Value") is missed (E07 PV only rendered
because the appraisal doc supplied it).

**FORK for Porter (Track-B 2nd-mortgage/combined-LTV category is blocked on this):**
- (a) **Vienna-side hardening (Bug-3)** — widen the loan-amount regex to cover `"Loan $X"`,
  `"Nth mortgage request: $X"`, word-order variants (and `"appraised $X"` for PV). Sibling to
  Bug 2; per narrow-corpus discipline (canonical-fields.js:476) needs Porter ratification.
- (b) **Fixture-side** — if these phrasings are deemed unnatural fixture-authoring artifacts,
  reword the affected fixtures to a recognized phrasing (cheap; like the premature-prelim
  family). Lower stakes but reduces corpus realism.

Recommendation: lean (a) for `"Loan $X"` (the most common real broker shorthand) + the
`"Nth mortgage request"` family; (b) is defensible only if Porter judges these unrealistic.
Either way → BATCH-14 fix-cycle (do NOT fix in BATCH-12).
