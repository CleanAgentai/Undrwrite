# Bug-3 scope — canonical money-extraction robustness (broker shorthand)

**Discovered:** BATCH 12 Track A (2026-05-29) via Discipline-2 — making
`combined_ltv_computed` observable surfaced a latent loan-amount extraction gap.
**Ratified:** Porter 2026-05-29 — Vienna-side hardening (fork (a)), sibling to Bug-2.
**Sequenced:** BATCH 14 fix-cycle (NOT BATCH 12).
**Narrow-corpus discipline (canonical-fields.js:476):** interpreted as careful widening —
strict-zero family expansion + sanity bounds + per-pattern harness — NOT "don't widen."
Same approach as Bug-2's k/K/m/M/MM family.

## The gap (reproduced on deployed code 78efbbc)
The canonical loan-amount regex (canonical-fields.js:480) matches only
`Loan Amount [Requested]` / `Mortgage Amount` / `Requested Loan` / `requesting $X`.
E07 states "New 2nd mortgage request: $120,000" → `requested_loan_amount=null` →
Snapshot "Loan Amount Requested: TBD" + LTV TBD + no Combined-LTV row (the combined row
is absent purely downstream of the null loan amount). The prelim *subject* showed "69% LTV"
only because the LLM read the email's literal "Combined LTV: 69%" — masking the
deterministic gap. Offline confirmation:
- `"New 2nd mortgage request: $120,000"` → null  |  `"New second mortgage: $120,000"` → null
- `"Loan amount requested: $120,000"` → 120000 ✓  |  `"Requesting $120,000…"` → 120000 ✓

## Four ratified patterns to widen (Bug-3)
1. **requested_loan_amount — "Loan $X" shorthand** (bare "Loan" + amount, no "Amount"
   keyword), WITH Bug-2's magnitude-suffix family attached (k/K/m/M/MM, "million"/"thousand").
2. **requested_loan_amount — "Nth mortgage request: $X"** family (1st/2nd/3rd mortgage —
   common broker phrasing for layered deals).
3. **requested_loan_amount — word-order variants** "$Xk loan" / "$Xk requested" / "$Xk for [purpose]".
4. **subject_property_market_value — "appraised $X"** lowercase prose (no "at"/"Value")
   — secondary same-family gap (E07 PV only rendered because the appraisal doc backfilled it).
5. **"$X against $Y" LTV-shorthand** (compact "loan against value") → loan=$X, value=$Y.
   Discovered via E01/E02 ("$260k against $650k = 40% LTV", "$552k against $850k property").
   Misses BOTH loan and value (confirmed offline). Common broker compact phrasing.

Carries forward from Bug-2: centralized `normalizeMoney`, no-silent-guess sanity bound,
broker-written-capture widening discipline — applied to all four patterns.

## Affected scenarios (reality-checked, NOT raw heuristic)
Email states the amount/value in a phrasing the current regex misses:
- `"Loan $X"` shorthand: **E13, E23, E28, E29, F03, F06** (+ F23 "Loan $331k against $425k")
- `"Nth mortgage request: $X"`: **E07, E08**
- word-order `"$Xk loan/requested"`: **A24, F07, F14**
- (2nd-mortgage combined-LTV scenarios sharing the dependency: **F04, F13**)

Real *rendered* bite only where no document backfills the amount (E07 CONFIRMED renders TBD;
the "Loan $X" scenarios mostly attach a loan_application that MAY backfill — unconfirmed
per-scenario; resolve during the Bug-3 fix-cycle).

## Per-pattern harness requirement (Bug-3 build)
Each of the 4 patterns gets a unit harness with:
- POSITIVE cases — realistic broker phrasing that SHOULD match.
- NEGATIVE cases — contexts that must NOT match (existing-loan references, hypothetical
  amounts in narrative prose, "the $X they paid last year", etc.).
Plus: baseline preservation (175 Franco + r11a/b/c + r10c + Bug1/Bug2 + Q10 21/21) and
integration verification on the ~11 affected scenarios above.

## BATCH-14 fix-cycle queue (this doc = the input)
1. Implement the 4 widened patterns in canonical-fields.js (strict-superset alternations).
2. Per-pattern harness (pos+neg).
3. Re-run the ~11 affected scenarios; confirm loan amount / PV / Combined-LTV row now render.
4. **Re-probe E01/E02** (see below) — was BATCH-9b's "premature-prelim-before-docs" diagnosis
   actually (partly) this extraction gap?
5. Then the HELD Track-B combined-LTV / 2nd-mortgage expected.json updates become unblocked.

## E01/E02 re-open flag (do NOT reclassify yet — but strong new evidence)
BATCH-9b PROBE 3 classified E01/E02 null-loan-amount as "premature-prelim-before-docs /
empty-from-email" (loan amount empty-from-email → doc-sourced → prelim fired at intake
before doc upload). **NEW EVIDENCE (BATCH-12) likely REFUTES that:** both emails DO state
the amount — E01 "$260k against $650k = 40% LTV", E02 "$552k against $850k property" — in the
`"$X against $Y"` shorthand (pattern 5) that the regex misses. So the amount was NOT
"empty-from-email"; it was present-but-unextracted (the Bug-3 gap). Per Porter's directive,
**do NOT reclassify yet** — flagged for BATCH-14 re-probe after Bug-3 ships (re-run E01/E02 and
confirm the loan amount now extracts from the email → root was the extraction gap, not
premature-prelim). Until then the 9b classification stands provisionally but is suspect.
