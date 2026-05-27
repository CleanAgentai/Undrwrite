# Production-Sample Shape-Reference Audit Log

## Phase 3 sample-pull DEFERRED — Option B (2026-05-27)

Phase 3 production-corpus sample-pull program was deferred per PII-handling posture review. Regex-based PII scrubbing on free-text broker emails is structurally insufficient for safe storage of real broker/borrower data. The bulletproof matrix proceeds on synthetic-only Batches 2-4 fixtures; production-corpus replay (if needed) is deferred to Phase 5+ pending synthetic-bias evidence.

**Status:**
- `lib/piiScrubber.js` retained in tree with closure-condition docblock listing M1-M5 extensions required before any production-sample storage path can be safe
- `lib/supabasePull.js` retained in tree with DO NOT USE FOR SAMPLE STORAGE header; usable only for live-query operational debugging
- `scripts/bulletproof-pull-samples.js` deleted (the storage path that caused the leak)
- No production samples currently stored in `samples/` directory

**Closure condition for revival:** if Phase 5 triage surfaces material synthetic-bias gap requiring production-sample storage, return to Phase 3 with: extend `lib/piiScrubber.js` per M1-M5, build caller-supplied nameList from one-time corpus inspection, add reviewer-confirm-no-pii gate to any pull script, then retry.

## Empirical anchor — first live-pull escalation (2026-05-27)

First live pull of 5 production samples surfaced PII leak categories not caught by the regex-based scrubber baseline. Samples were deleted from disk immediately upon leak discovery.

PII leak categories observed (all NOT caught by baseline scrubber):
1. Person names (borrower names, broker names, internal team names)
2. Company names (broker firms)
3. License numbers (broker Lic. #MB###### pattern)
4. Property street addresses (street number + street name + city)
5. Angle-bracketed phone variants `<(NNN)+NNN-NNNN>`
6. Identifying URLs (broker calendly/facebook/personal-website URLs)

PII categories caught correctly by baseline scrubber:
- Standard phone numbers (NNN-NNN-NNNN format)
- Email addresses
- Postal codes (Canadian FSA+LDU)
- Dollar amounts ≥$1,000
- SIN-like 9-digit numbers

**Methodology learning pinned to this escalation:** Infrastructure-contract-honoring discipline — when a helper has documented limitations encoded in its docblock (e.g., baseline piiScrubber.js: "names are harder than regex-detectable patterns — proper-noun detection requires NER or hand-flagging. The scrubber accepts an explicit nameList argument"), downstream consumers must honor the contract — either provide the required input OR raise an explicit error on missing input. Silent degradation is the bug. Candidate carry-forward designation deferred to Phase 5 triage.

## Patterns informing synthesis (from prior R10/R11 work observation, no stored samples)

The following patterns were established during R10/R11 cycle work via direct observation of Franco's corpus + Marcus Webb retest fixtures. Documented here for traceability without storing raw production samples:

- **Broker email signoff:** Franco's signature block follows a `LENDING & INVESTMENT SPECIALIST / address / phone / cell / email` template. Pattern captured in `lib/shapes.js` BROKERS.franco.signoff.
- **Document filename conventions:** `LoanApplication_{LastName}.pdf`, `Appraisal_{LastName}_{Subject}.pdf`, `NOA_{LastName}_{Year}.pdf`, `MortgageStatement_{LastName}.pdf`. Filename-driven classifier in `deals.js classifyDocument` keys off these patterns.
- **Broker intake phrasing:** "Submitting a [transaction-type] opportunity for [borrower]" / "Property: [address]" / "Loan amount requested: [amount]" / "LTV: approximately [pct]%". Captured in fixture intake emails.
- **Multi-turn correction phrasing:** "Quick correction —" / "the [doc-type] has an outdated number" / "Please use [corrected-value] for the underwriting". Captured in correction events.
