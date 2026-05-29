# Gate-Observation Map (Phase 6 Step 2 — 2026-05-28)

Purpose: convert the `inference_unknown` gates (gates a scenario `expected.json`
asserts but the assertEngine cannot evaluate, because `GATE_INFERENCE` had no
entry) into OBSERVABLE evidence patterns, so the Phase 6 step-3 post-ship pass
can actually verify them.

Scope: the ~21 `inference_unknown` instances from the ratified step-2 list
(A07, A16, B07, C06×2, E06, E07, E11, E15–E19, E24, E25, F11, F14, F17, F21, F23)
= **18 distinct gate types** (some gates span multiple scenarios; some scenarios
carry two gates). The FULL undefined-gate set is larger (~40); this map is scoped
to the ratified list only.

**Discipline 2 (standing):** an entry here makes a gate OBSERVABLE; it does NOT
confirm the gate WORKS. Every observable entry below is UNVERIFIED-EMPIRICALLY
until step 3 observes it firing correctly on a real run. Two gates already
surfaced as likely real gaps (see §3).

All anchors below were verified against current source (grep-confirmed exact
strings), not taken on faith from the investigation agents.

---

## 1. OBSERVABLE — drafted into `GATE_INFERENCE` (assertEngine.js)

12 entries added (registry 10 → 22). Each cites a verified `file:line` anchor.

| Gate | Scenario(s) | Observable evidence pattern | Anchor |
|---|---|---|---|
| `loan_app_annotations_sanitized` | A07, F11 | Snapshot "Loan Amount Requested" row populated `$N` (annotation extracted). SCOPED: in A07/F11 the annotation is the only loan-amount source. | canonical-fields.js:737; pdfFormExtract.js:8 |
| `property_value_missing` | A16 | Snapshot "Appraised Value: **TBD**" (market value + tax-assessment fallback both empty) | discrepancy-engine.js:263,562 |
| `collateral_offered` | B07 | `extracted_data.collateral_offered === true` (persisted boolean) | webhook.js:3302 |
| `awaiting_collateral_initially_activated` | C06 | collateral-ask outbound fired (durable in `outboundEmails`) OR final status `awaiting_collateral`. TIMING caveat: durable signal is the EMAIL, not final status (which a later turn may overwrite). | webhook.js:3120; ai.js:2354 |
| `combined_ltv_computed` | E07 (+F04/F13) | Snapshot "Combined LTV (incl. existing 1st):" row present (2nd-mortgage deals only) | discrepancy-engine.js:592,319 |
| `mortgage_statement_required` | E06 | outbound enumerates "Current Mortgage Payout Statement" | ai.js:2263 |
| `mortgage_statement_missing` | E18, F17 | same marker as above (missing payout → requested) | ai.js:2263; deals.js:38 |
| `mortgage_statement_now_required` | F14 | same marker; "now/transition" semantics NOT separately observable — presence confirms requirement fired (scoped to F14 where it only arises post-transition) | webhook.js:3303; ai.js:2263 |
| `doc_package_incomplete` | E19 | prelim/leadSummary renders ≥1 "[MISSING]" doc line | ai.js:949,3423 |
| `canonical_map_complete_after_t4` | E25 | status `under_review` AND prelim fired with NO "[MISSING]" lines | webhook.js:1514 |
| `province_inferred` | F23 | `extracted_data` has `province_inferred_from_(postal\|city)` tag (inference-specific), OR Snapshot "City / Province" shows a valid 2-letter province (fallback) | canonical-fields.js:1208,1215,1225 |
| `broker_clarification_question_detected` | E24 | prelim Subject "(clarification pending)" OR body banner "PRELIMINARY — BROKER CLARIFICATION PENDING" | webhook.js:1117,1118 |

**Shared-marker note:** E06 / E18 / F17 / F14 all key on the single
"Current Mortgage Payout Statement" request string — differentiated only by
deal state/timing, not by distinct text. Step-3 must verify the *timing* context
manually for F14 (post-transition) since the string alone cannot.

---

## 2. UNOBSERVABLE — left `inference_unknown` + coverage-limit + manual check

No `GATE_INFERENCE` entry added (an honest "cannot evaluate" beats a fabricated
pass/fail). Each needs a manual check at step 3.

| Gate | Scenario | Why unobservable | Manual check |
|---|---|---|---|
| `blank_loan_app_detected` | E15 | No automated blank-PDF detection in code; the prompt asks Claude to *eyeball* extracted text and name blank forms | Read Vienna's broker-facing reply for an explicit naming of the blank form(s) |
| `partial_doc_detected` | E16 | No discrete flag; "partial" is implicit (status stays `active` + non-empty `missingDocs`) | Confirm status `active` AND a later reminder enumerates still-missing docs |
| `ocr_quality_warning` | E17 | No OCR / no confidence scoring anywhere in the codebase (`pdf-parse` text-only) | Inspect whether `documents.extracted_data.text` is empty/short for the doc |
| `section_9_content_detected` | F21 | "Section 9" is a static admin-summary render section, not a detection gate | Read the leadSummary admin email "Section 9: Documents Included" block |

---

## 3. DISCIPLINE-2 RED FLAGS — gate computed but NOT surfaced (likely real gaps)

The harness was blind to these; making them observable revealed the gate produces
NO externally-visible effect. These are candidate real bugs / product-design gaps,
NOT mere coverage limits.

- **`joint_applicants_detected` (E11)** — `detectJointMultiBorrower()`
  (discrepancy-engine.js:912) IS computed and returned from
  `runDiscrepancyDetection()`, but the result is **dropped**: never persisted to
  `extracted_data`, never rendered in a Snapshot row, no email phrase, no status
  change. So joint/multi-borrower detection has no downstream effect.
  → Candidate gap. Manual check: parse credit-bureau docs for ≥2 distinct
  borrower names. Likely a **Franco product-design question** (should joint
  applicants surface in the admin Snapshot?) — fold into the step-4 disposition set.

- **`awaiting_collateral_after_admin_override` (C06)** — NO code path exists where
  an admin override re-enters / exits the `awaiting_collateral` state. Admin
  replies (APPROVED/REJECTED/CONDITIONS) apply to `ltv_escalated`/`under_review`,
  not `awaiting_collateral`. The C06 spec asserts a transition the product may not
  implement. → Candidate **spec-vs-behavior mismatch or Franco disposition**
  (does the product intend an admin collateral-override path?).

---

## 4. Post-ship empirical tally (Discipline 1 — running)

Tracks whether each predicted entanglement / gate actually clears. NOT a formality
(the Bug-1→Finding-1b lesson: entanglement claims can mask a second issue).

### Entanglement-claim confirmations
- **#1 CONFIRMED — `elevated_ltv_band` factor "pre-existing R4-RESIDUAL-1 residual"**
  (F04, 2026-05-28). The missing "75–80% elevated" band callout is a pre-existing
  gap, not a gate-fix regression. Confirmed 3 ways: Bug-1 diff doesn't touch the
  callout path; layer3 flags R4-RESIDUAL-1 `placeholder_assumed`; it was a
  pre-listed step-3 item.
- **#1 EXTENDED — CONFIRMED across the matrix (BATCH 9, 2026-05-29):** F23 (active,
  prelim fired, band callout still absent) + F01 + D03 (masked by Q1 escalation) all
  show the same `elevated_ltv_band` gap → R4-RESIDUAL-1 is a real pre-existing residual
  matrix-wide, NOT a Franco/BATCH-7 regression. CONFIRM-CLEAR (known root).
- **#2 CONFIRMED — `discrepancyHold` fires correctly on active-major** (B01, BATCH 9):
  the major loan-amount discrepancy suppresses prelim as designed; the canonical-read
  fails are stale-spec. CONFIRM-CLEAR. (B02/B03 minor-delta cases DEFER-9B — suspected
  gate-inference noise when Franco-9 escalation suppresses prelim, not a discrepancyHold bug.)
- **#3 ROOT — broker-correction "render shows intake value" cluster (A01/A13/C07/A34,
  BATCH 9):** NOT a Vienna bug. fullmatrix-1 CLUSTER-2 already proved request-time
  resolution correct ($295k at render); BATCH-7's exit_strategy broad-add now fires the
  prelim AT INTAKE before the correction turn → assertEngine reads the premature prelim.
  EXIT_STRATEGY-PREMATURE-PRELIM fixture-sequencing interaction → fixture-side fix.
- **GENUINE-CANDIDATES (BATCH 9, NOT confirmed bugs):** A28 (transaction_type
  refinance→purchase) + F02 (purchase→null) — Q1 purchase-detector interaction; deferred
  to BATCH 9b cheap probe before any fix-cycle.
- Full per-scenario classification: see BATCH9-CLASSIFICATION.md.

### Gate-observation verifications (Discipline 2 — VERIFIED BATCH 12 Track A, 2026-05-29)
Full classification + evidence: BATCH12-TRACKA-GATE-VERIFICATION.md. Method: BATCH-8
dataset + offline reasoning + 2 cheap deployed-code probes (E06, E07).
- **VERIFIED FIRED/NOT-FIRED CORRECTLY (5):** loan_app_annotations_sanitized (A07 pos /
  F11 neg), awaiting_collateral_initially_activated (C06), mortgage_statement_missing
  (E18, F17).
- **NOT-A-BUG, stale BATCH-8 value (1):** mortgage_statement_required (E06) — probed
  deployed code: purchase correctly omits the payout statement; BATCH-8 inf=true predates
  deployed Franco-9 purchase detection.
- **Gate-observability-limit (2):** property_value_missing (A16), doc_package_incomplete
  (E19) — evidence-surface (Snapshot TBD / [MISSING]) only renders in a prelim/leadSummary;
  these scenarios correctly sit at intake doc-ask (no prelim) so the surface never exists.
  → Track B re-scope (assert the doc-ask behavior instead).
- **Pre-Phase-1-threading artifact, re-verify BATCH-13 (4):** collateral_offered (B07),
  broker_clarification_question_detected (E24), canonical_map_complete_after_t4 (E25),
  mortgage_statement_now_required (F14) — all multi-turn; results-2.json predates the
  BATCH-11 Phase-1 threading fix so turn-2+ never processed.
- **Spec-expectation-form, non-boolean (4):** combined_ltv_computed (E07/F04/F13 assert a
  numeric LTV) + province_inferred (F23 asserts "NB"). Observable gate is boolean; the
  value belongs on the rendered Snapshot row. → Track B verification-surface.
- **GENUINE-CANDIDATE → BATCH-14 fix-cycle (1):** combined_ltv_computed (E07) — Discipline-2
  VINDICATED. Surfaced a real loan-amount extraction gap (canonical regex misses "New 2nd
  mortgage request: $X" + bare "Loan $X" shorthand). Surfaced to Porter 2026-05-29. See
  BATCH12-TRACKA-GATE-VERIFICATION.md §FLAGGED for blast radius + the Vienna-vs-fixture fork.
- 4 §2 unobservables: deferred to BATCH-13 manual checks (unchanged).

### §3 red flags — ROUTED AS FRANCO-DISPOSITIONS (2026-05-28, no longer pending-empirical)
Both §3 gates are product-design questions, not confirmable by observation alone —
whether they are surface GAPS (implement) or CORRECT-AS-IS (revise the spec)
depends on Franco's intent. Bundled into the Franco follow-up as questions 8 & 9
(continuing the original 7). Franco's answers convert each into either an
implementation item or a spec revision:
- `joint_applicants_detected` (E11) → Q8 (surface joint/multi-borrower in the
  admin Snapshot? default: yes / change: leave internal-only).
- `awaiting_collateral_after_admin_override` (C06) → Q9 (add an admin-override
  path out of the collateral hold? default: no / change: add it).
