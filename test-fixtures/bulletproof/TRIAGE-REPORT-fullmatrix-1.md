# Bulletproof Matrix Triage Report

Generated: 2026-05-28T03:14:32.236Z
Source: bulletproof-fullmatrix-results-1.json

## 1. Executive Summary

| Metric | Value |
|---|---|
| Total scenarios | 89 |
| fail | 73 |
| inference_unknown_present | 6 |
| pass | 10 |
| Architecture-amendment-candidates | 7 |
| Placeholder-pending | 0 |
| Cumulative budget estimate | $22.25 |

## 2. By Group

| Group | Total | Pass | Fail | Error | Placeholder | Arch-Amend |
|---|---|---|---|---|---|---|
| A | 31 | 0 | 30 | 0 | 0 | 0 |
| B | 10 | 3 | 7 | 0 | 0 | 0 |
| C | 5 | 1 | 4 | 0 | 0 | 0 |
| D | 9 | 2 | 7 | 0 | 0 | 0 |
| E | 18 | 3 | 11 | 0 | 0 | 0 |
| F | 16 | 1 | 14 | 0 | 0 | 0 |

## 3. By Severity

Per architectural risk #4 — architecture-amendment-candidates separated from bug-fixes.

### ACCEPTANCE-BLOCKING (26 scenarios)

- **A01**: 2 fail / 5 total
- **A04**: 3 fail / 5 total
- **A06**: 2 fail / 4 total
- **A08**: 3 fail / 5 total
- **A13**: 2 fail / 4 total
- **A15**: 1 fail / 5 total
- **A18**: 2 fail / 4 total
- **A24**: 2 fail / 4 total
- **A25**: 2 fail / 4 total
- **A28**: 2 fail / 4 total
- **A34**: 2 fail / 4 total
- **A36**: 2 fail / 4 total
- **A37**: 2 fail / 4 total
- **A38**: 2 fail / 4 total
- **A40**: 3 fail / 5 total
- **B01**: 3 fail / 7 total
- **B03**: 3 fail / 4 total
- **B05**: 3 fail / 5 total
- **C02**: 2 fail / 4 total
- **E22**: 1 fail / 4 total
- **E26**: 2 fail / 4 total
- **F01**: 3 fail / 6 total
- **F05**: 2 fail / 4 total
- **F09**: 2 fail / 7 total
- **F14**: 2 fail / 4 total
- **F22**: 2 fail / 4 total

### CORRECTNESS (16 scenarios)

- **A05**: 2 fail / 6 total
- **A22** [arch-amendment-candidate]: 2 fail / 5 total
- **A32**: 2 fail / 4 total
- **B07**: 2 fail / 4 total
- **B10**: 3 fail / 6 total
- **C01**: 1 fail / 2 total
- **C04**: 1 fail / 4 total
- **C06**: 3 fail / 6 total
- **D03**: 1 fail / 5 total
- **D04** [arch-amendment-candidate]: 2 fail / 5 total
- **D05**: 1 fail / 3 total
- **E03**: 2 fail / 6 total
- **F06** [arch-amendment-candidate]: 2 fail / 4 total
- **F10**: 3 fail / 5 total
- **F17**: 3 fail / 7 total
- **F20**: 1 fail / 5 total

### COSMETIC (37 scenarios)

- **A02**: 1 fail / 4 total
- **A03**: 2 fail / 5 total
- **A07**: 1 fail / 5 total
- **A14**: 1 fail / 4 total
- **A16**: 0 fail / 5 total
- **A19**: 1 fail / 4 total
- **A20**: 1 fail / 4 total
- **A21**: 1 fail / 5 total
- **A26**: 3 fail / 6 total
- **A29**: 1 fail / 4 total
- **A30**: 2 fail / 4 total
- **A33**: 1 fail / 4 total
- **A35**: 1 fail / 4 total
- **B08**: 1 fail / 4 total
- **B09**: 1 fail / 4 total
- **D01**: 2 fail / 7 total
- **D06**: 1 fail / 3 total
- **D07**: 1 fail / 2 total
- **D10**: 1 fail / 2 total
- **E06**: 0 fail / 5 total
- **E07**: 1 fail / 8 total
- **E11**: 2 fail / 5 total
- **E15**: 3 fail / 5 total
- **E16** [arch-amendment-candidate]: 1 fail / 6 total
- **E17**: 1 fail / 5 total
- **E18**: 0 fail / 5 total
- **E19**: 0 fail / 4 total
- **E24**: 0 fail / 4 total
- **E25** [arch-amendment-candidate]: 2 fail / 6 total
- **E28** [arch-amendment-candidate]: 1 fail / 5 total
- **E29** [arch-amendment-candidate]: 1 fail / 5 total
- **F07**: 3 fail / 5 total
- **F11**: 1 fail / 4 total
- **F15**: 2 fail / 4 total
- **F16**: 2 fail / 4 total
- **F21**: 1 fail / 5 total
- **F23**: 0 fail / 5 total

## 4. Architectural Family Attribution (failure distribution)

- F1: 66 failures attributed
- F2: 3 failures attributed
- F3: 0 failures attributed
- F4: 0 failures attributed
- other: 4 failures attributed

## 5. Architecture-Amendment Candidates Surfaced

Per Q-R3 two-factor detection (no Vienna mapping AND no gate-inference entry). Different Phase 6 treatment: requires Phase 1 matrix amendment before fix-cycle.

- **A22**
  - Field `postal_code_tuples`: Field 'postal_code_tuples' has no Vienna mapping; flagged as architecture-amendment-candidate per Q-R3 two-factor check
- **D04**
  - Field `postal_code_tuples`: Field 'postal_code_tuples' has no Vienna mapping; flagged as architecture-amendment-candidate per Q-R3 two-factor check
- **E16**
  - Field `credit_score`: Field 'credit_score' has no Vienna mapping; flagged as architecture-amendment-candidate per Q-R3 two-factor check
- **E25**
  - Field `credit_score`: Field 'credit_score' has no Vienna mapping; flagged as architecture-amendment-candidate per Q-R3 two-factor check
- **E28**
  - Field `province`: Field 'province' has no Vienna mapping; flagged as architecture-amendment-candidate per Q-R3 two-factor check
- **E29**
  - Field `province`: Field 'province' has no Vienna mapping; flagged as architecture-amendment-candidate per Q-R3 two-factor check
- **F06**
  - Field `postal_code_tuples`: Field 'postal_code_tuples' has no Vienna mapping; flagged as architecture-amendment-candidate per Q-R3 two-factor check

## 6. Layer 3 Placeholder-Pending Scenarios

Rerun after Phase 4.5 decisions land (0 scenarios).


## 7. Phase 6 Fix-Cycle Recommended Ordering

Priority: acceptance-blocking → correctness → cosmetic. Within each, F-family attribution and architecture-amendment-candidates flagged.

1. **A01** (acceptance-blocking) — 2 failures
2. **A04** (acceptance-blocking) — 3 failures
3. **A06** (acceptance-blocking) — 2 failures
4. **A08** (acceptance-blocking) — 3 failures
5. **A13** (acceptance-blocking) — 2 failures
6. **A15** (acceptance-blocking) — 1 failures
7. **A18** (acceptance-blocking) — 2 failures
8. **A24** (acceptance-blocking) — 2 failures
9. **A25** (acceptance-blocking) — 2 failures
10. **A28** (acceptance-blocking) — 2 failures
11. **A34** (acceptance-blocking) — 2 failures
12. **A36** (acceptance-blocking) — 2 failures
13. **A37** (acceptance-blocking) — 2 failures
14. **A38** (acceptance-blocking) — 2 failures
15. **A40** (acceptance-blocking) — 3 failures
16. **B01** (acceptance-blocking) — 3 failures
17. **B03** (acceptance-blocking) — 3 failures
18. **B05** (acceptance-blocking) — 3 failures
19. **C02** (acceptance-blocking) — 2 failures
20. **E22** (acceptance-blocking) — 1 failures
21. **E26** (acceptance-blocking) — 2 failures
22. **F01** (acceptance-blocking) — 3 failures
23. **F05** (acceptance-blocking) — 2 failures
24. **F09** (acceptance-blocking) — 2 failures
25. **F14** (acceptance-blocking) — 2 failures
26. **F22** (acceptance-blocking) — 2 failures
27. **A05** (correctness) — 2 failures
28. **A22** (correctness) [ARCH-AMENDMENT] — 2 failures
29. **A32** (correctness) — 2 failures
30. **B07** (correctness) — 2 failures
31. **B10** (correctness) — 3 failures
32. **C01** (correctness) — 1 failures
33. **C04** (correctness) — 1 failures
34. **C06** (correctness) — 3 failures
35. **D03** (correctness) — 1 failures
36. **D04** (correctness) [ARCH-AMENDMENT] — 2 failures
37. **D05** (correctness) — 1 failures
38. **E03** (correctness) — 2 failures
39. **F06** (correctness) [ARCH-AMENDMENT] — 2 failures
40. **F10** (correctness) — 3 failures
41. **F17** (correctness) — 3 failures
42. **F20** (correctness) — 1 failures
43. **A02** (cosmetic) — 1 failures
44. **A03** (cosmetic) — 2 failures
45. **A07** (cosmetic) — 1 failures
46. **A14** (cosmetic) — 1 failures
47. **A16** (cosmetic) — 0 failures
48. **A19** (cosmetic) — 1 failures
49. **A20** (cosmetic) — 1 failures
50. **A21** (cosmetic) — 1 failures
51. **A26** (cosmetic) — 3 failures
52. **A29** (cosmetic) — 1 failures
53. **A30** (cosmetic) — 2 failures
54. **A33** (cosmetic) — 1 failures
55. **A35** (cosmetic) — 1 failures
56. **B08** (cosmetic) — 1 failures
57. **B09** (cosmetic) — 1 failures
58. **D01** (cosmetic) — 2 failures
59. **D06** (cosmetic) — 1 failures
60. **D07** (cosmetic) — 1 failures
61. **D10** (cosmetic) — 1 failures
62. **E06** (cosmetic) — 0 failures
63. **E07** (cosmetic) — 1 failures
64. **E11** (cosmetic) — 2 failures
65. **E15** (cosmetic) — 3 failures
66. **E16** (cosmetic) [ARCH-AMENDMENT] — 1 failures
67. **E17** (cosmetic) — 1 failures
68. **E18** (cosmetic) — 0 failures
69. **E19** (cosmetic) — 0 failures
70. **E24** (cosmetic) — 0 failures
71. **E25** (cosmetic) [ARCH-AMENDMENT] — 2 failures
72. **E28** (cosmetic) [ARCH-AMENDMENT] — 1 failures
73. **E29** (cosmetic) [ARCH-AMENDMENT] — 1 failures
74. **F07** (cosmetic) — 3 failures
75. **F11** (cosmetic) — 1 failures
76. **F15** (cosmetic) — 2 failures
77. **F16** (cosmetic) — 2 failures
78. **F21** (cosmetic) — 1 failures
79. **F23** (cosmetic) — 0 failures

---

## 8. ROOT-CAUSE CLUSTER ANALYSIS (Sub-phase 5.4 — the load-bearing section)

The mechanical per-scenario breakdown above OVERSTATES distinct-bug count. Failure-detail clustering reveals **73 fails collapse to ~6 root-cause clusters**, dominated by ONE spec-assumption error accounting for 64% of failures.

### CLUSTER-1 — preliminary_review_admin non-fire (47 scenarios = 64% of all failures) — SPEC-ASSUMPTION, NOT BUG

- **Symptom**: 47 scenarios expected `preliminary_review_admin` fire=true; Vienna did not fire.
- **Split**: 24 multi-event (active-branch) + 23 single-event (initial-submission).
- **Root cause (empirically confirmed)**: 46/47 scenarios contain NO exit_strategy language in broker text. Vienna's discipline:
  - Single-event: welcome email asks broker for exit_strategy clarification → `welcomeEmailIsAskingClarification`=true → `_b2HoldInitial`=true → prelim held (webhook.js:3093-3100).
  - Multi-event: active-branch `computeWillReview` requires `hasExitStrategy`=true (webhook.js:408-413) → held.
- **This is INTENTIONAL Vienna behavior** — the Kevin Tran production case (webhook.js:420-427) hardened exactly this: don't over-promise prelim while exit_strategy is pending.
- **Disposition**: SPEC/FIXTURE revision, NOT Vienna fix. Two options for Phase 6:
  - (a) Add exit_strategy language to broker intake fixtures → prelim fires (tests the positive path).
  - (b) Revise expected.json to predict prelim-held + broker_facing clarification fires (tests Vienna's actual hold discipline).
- **Leverage**: resolving this ONE cluster collapses ~47 of 73 failures. **Highest-priority Phase 6 item.**
- **Recommended**: hybrid — scenarios whose INTENT is prelim-dispatch testing (B04/D02-shaped) get exit_strategy added (option a); scenarios whose intent is canonical-field extraction (Group A) get expected revised to not assert prelim at all (option b) — prelim firing is orthogonal to their F1 assertion focus.

### CLUSTER-2 — F1.LA broker_correction tier-resolution (13 requested_loan_amount + portion of 23 wrong_value) — EMERGENT-FIND-A

- **Symptom**: `requested_loan_amount` (13×) + `transaction_type` (4×) + others retain loan_app/doc value instead of broker_correction tier value.
- **Disposition pending**: Vienna persistence vs request-time-semantic question. Either (a) Vienna's extracted_data stores raw source value + correction-tier resolution is request-time-only (→ assertion must check request-time render, not persisted store), or (b) genuine F1.LA implementation gap. **Needs one targeted probe** (inspect a corrected deal's extracted_data + outbound render side-by-side).

### CLUSTER-3 — extraction-gap / undefined (19 fields) — normalize-map vs genuine-gap

- **Fields**: mortgage_position (7), existing_mortgage_lender (6), transaction_type (4 — overlaps CLUSTER-2), annual_income (3), borrower contact fields (3).
- **Disposition pending**: these may be normalize-map key mismatches (Vienna persists under different key) OR genuine non-extraction. **Needs normalize-map verification probe** before classifying as Vienna bug.

### CLUSTER-4 — gate-firing gaps (17 gate failures) — EMERGENT-FIND-B + C

- discrepancyHold (6), elevated_ltv_band (5), postal_code_discrepancy_detected (3), file_hosting_link_detected (3), vienna_paused_per_deal (1).
- elevated_ltv_band: confirmed isolated to 75-80% band (D03 + E03 + F-series); adjacent bands pass cleanly.
- discrepancyHold: B-series discrepancy detection not firing admin_discrepancy_notification.
- **Disposition**: mix of real gate-implementation questions + GATE_INFERENCE observation-method gaps. Phase 5.4 triage per-gate.

### CLUSTER-5 — workflow transitions (4 scenarios)

- B03/B07/C06: expected=active, actual=awaiting_collateral (LTV-band edge — Vienna escalating at boundary the spec didn't expect).
- C01: expected=admin_handoff, actual=active (admin_controlled flag not set for FromName="Admin" intake shape — EMERGENT-FIND-D).

### CLUSTER-6 — fixture-doc precision (2 close-misses) — COSMETIC

- A13 property_value 4.8% off, A34 first_mortgage_balance 1.1% off. Fixture-doc value vs spec rounding. Trivial fixture fix.

### CLUSTER-7 — machinery completeness (6 inference_unknown + 7 arch-amendment-candidate)

- 6 inference_unknown_present (E06/E18/E19/E24/F23 + one): gates with no GATE_INFERENCE entry — need table entries OR alternate assertion strategy.
- 7 architecture-amendment-candidates (A22 postal-tuples, D04 postal, + 5 others): normalize-map two-factor flagged. Per Q-R3, require Phase 1 matrix-amendment consideration before fix.

### Severity RE-INTERPRETATION (correcting the mechanical classifier)

The auto-classifier marked 26 "acceptance-blocking" by detecting broker_correction in rationale strings. But most of those scenarios' PRIMARY failure is CLUSTER-1 (prelim non-fire, a spec issue) with CLUSTER-2 (tier-resolution) secondary. **True acceptance-blocking count is much lower** — pending CLUSTER-2 disposition (if request-time-semantic, those aren't bugs either). Honest severity picture:

- **Genuinely acceptance-blocking**: CLUSTER-2 IF it's a real persistence bug (unknown until probe) — at most ~13 scenarios, possibly 0.
- **Spec/fixture revision** (not Vienna bugs): CLUSTER-1 (47) + CLUSTER-6 (2) + part of CLUSTER-5 (B03/B07/C06 LTV-band) + EMERGENT-FIND-E.
- **Real correctness questions**: CLUSTER-4 (17 gate) + CLUSTER-3 (19 extraction, pending normalize-map check) + C01.
- **Machinery**: CLUSTER-7 (13).

---

## 9. DIAGNOSTIC PROBE RESULTS (Sub-phase 5.5 — pre-fix bug-surface determination)

Two probes run per Q-5.5-1 to determine true Vienna-bug surface before sequencing fixes. **Both resolve toward NOT-A-BUG. The combined CLUSTER-2 + CLUSTER-3 surface (~30 fails) is a verification-surface mismatch, not Vienna defects.**

### CLUSTER-2 probe — broker_correction tier-resolution → NOT A BUG, NO LATENT RISK

Empirical (A01 raw-state probe, deal f4c3a541): broker corrects loan_amount $260k→$295k.
- **(a) Persisted** `extracted_data.loan_amount_requested` = **$260k** (raw intake snapshot).
- **(b) Render** uses request-time canonical_map resolution: `cFields.resolveCanonicalIntentValue(_bFilteredCanonicalMap, 'requested_loan_amount')` with broker_correction > broker_initial_intent > docs (webhook.js:1340-1349), injected via `canonicalCorrectionsOverride` into leadSummary + deterministic JS Snapshot → **$295k**.

**Architecture**: `extracted_data` is a RAW pre-canonical intake snapshot, NOT the canonical store. Canonical resolution is **request-time** via `extractCanonicalFields`/`extractCanonicalFieldsAggregated` (discrepancy-engine.js:912,1067), rebuilt from messages+docs each request.

**Latent-risk check (Porter's critical question)**: ZERO direct reads of `extracted_data.loan_amount_requested`/`requested_loan_amount` for decisions or render anywhere in src/. The lender-package composer (R10-I, webhook.js:1683-1697) — named specifically — rebuilds canonical_map request-time via `runDiscrepancyDetectionAggregated(inboundMessages, docs)` + renders deterministic Snapshot; its only extracted_data read is `d?.extracted_data?.text` (per-document OCR text, the correct canonical-extraction INPUT). **No consumer reads the deal-level persisted canonical figures directly. No latent risk.** Consistent with R11 Stage 1.5 harnesses (render correctness) passing.

**Disposition**: matrix asserted the WRONG verification surface (persisted extracted_data vs request-time canonical_map / rendered Snapshot). MATRIX-DESIGN amendment, not Vienna fix.

### CLUSTER-3 probe — extraction-gap undefined → SPLIT, mostly NOT A BUG

A01 persisted extracted_data keys inspected (full dump). Findings:
- **mortgage_position**: NOT in extracted_data. Resolved request-time in canonical-fields.js:278-298 (canonical_map). Matrix wrong layer. NOT a gap.
- **existing_mortgage_lender**: Vienna's field is **`existing_first_mortgage_lender`** (name mismatch), resolved request-time canonical-fields.js:434-638 from PNW statement / filename / header lender. Lender "Royal Bank of Canada" present in `summary` prose. Matrix wrong layer + wrong key. NOT a gap.
- **transaction_type**: shape-transform (loan_type + is_purchase) present + handled by normalize-map; 4 fails are shape-transform edge cases → minor normalize-map refinement.
- **annual_income**: `income_details: null` when no income doc attached — EXPECTED (no income source). Minor spec revision (don't assert when no income doc).

**Disposition**: mortgage_position + existing_mortgage_lender = same MATRIX-DESIGN amendment as CLUSTER-2 (assert render surface / request-time canonical_map, not extracted_data). transaction_type + annual_income = minor normalize-map/spec refinements. NOT Vienna bugs.

### REVISED TRUE BUG-SURFACE

| Cluster | Count | Disposition |
|---|---|---|
| CLUSTER-1 | 47 | spec-assumption (Vienna-correct, exit_strategy-gating intended) — NOT bugs |
| CLUSTER-2 | ~13 | verification-surface mismatch (request-time-semantic, no latent risk) — NOT bugs |
| CLUSTER-3 | ~19 | mostly verification-surface (mortgage_position/lender) + minor refinements — NOT bugs |
| CLUSTER-6 | 2 | fixture-doc precision — NOT bugs |
| CLUSTER-7 | 13 | machinery (GATE_INFERENCE/normalize-map/arch-amendment) — NOT Vienna bugs |
| **CLUSTER-4** | **17** | **gate-firing — THE genuine-bug investigation surface** |
| **CLUSTER-5** | **4** | **workflow transitions — genuine questions** |

**~60 of 73 failures are matrix-design / spec-assumption, NOT Vienna defects. Genuine Vienna-behavior investigation surface ≤21 (CLUSTER-4 + CLUSTER-5), itself likely a mix of GATE_INFERENCE observation-method gaps + real bugs.**

### CRITICAL MATRIX-DESIGN IMPLICATION + DEPENDENCY

For canonical-resolution fields (loan_amount, purpose, mortgage_position, lender), the matrix must assert on the **render surface** (deterministic Snapshot in outbound) or reconstruct request-time canonical_map — NOT persisted extracted_data. This creates a **dependency**: render-surface verification needs the prelim/lead-summary to fire, which CLUSTER-1 (exit_strategy gating) currently blocks. **CLUSTER-1 fixture resolution (add exit_strategy to canonical-field scenarios) is a PREREQUISITE for CLUSTER-2/3 render-surface verification.** Phase 6 sequencing must account for this.

### 16th CARRY-FORWARD — probes sharpen the persistence-layer theme

"Vienna persists a RAW pre-canonical intake snapshot in extracted_data; the canonical store is REQUEST-TIME (canonical_map rebuilt from messages+docs each request, applying R10-G source-hierarchy). Verification must observe canonical figures via the render surface (deterministic Snapshot) or by reconstructing canonical_map — NEVER via persisted extracted_data, which is pre-resolution." This is now distinct enough from the empirical-behavior-validation theme to likely warrant being its OWN carry-forward (verification-surface-selection discipline) vs a sub-case. Lean: TWO carry-forwards. Defer final split to Phase 8.
