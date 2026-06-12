# Vienna — Scenario Test & Verification Log

Living record of Franco's end-to-end test scenarios. We go through each one, reproduce
the reported behaviour, fix every bug deterministically, and verify — offline on the real
documents first, then on the deployed staging service — until **every single bug is squashed**.

One markdown file per scenario. Real test documents live on the Desktop under
`~/Desktop/UndrWrite Testing/Scenario N docs/`.

## Status legend

| Mark | Meaning |
|------|---------|
| 🔴 | Bug reported / reproduced, not yet fixed |
| 🟡 | Fix implemented + verified **offline** (deterministic / real-doc), deployed replay pending |
| 🟢 | Fixed **and** verified on the deployed staging service (real render surface) |
| ⚪️ | Expected behaviour confirmed working (no bug) |

## Verification layers (in order of trust)

1. **Deterministic harness** — `scripts/round9-missing-docs-honesty-harness.js` (pins invariants forever).
2. **Real-document classification** — run the actual classifier/missing-docs logic over Franco's
   real PDFs (`/tmp/scenario1-real-docs.js` pattern). Pipeline-faithful for the deterministic layers.
3. **Deployed replay** — push to staging, send the real inbound, inspect the actual welcome email +
   admin preliminary review render surfaces. The only fully trustworthy layer (OBS-39: offline LLM
   runs have twice "passed" then failed on deploy).

## Round-9 bugs fixed (deterministic, harness-pinned, deployed)

| # | Bug | Fix | Commit |
|---|-----|-----|--------|
| 1 | Broker "everything looks complete" with docs missing | LLM removed from authoring completeness verdict — single source of truth + `enforceMissingDocsHonesty` guard at 3 call sites | `625d3fb` |
| 2 | T4 misclassified as NOA | drop `canada revenue` token + positive T4 content rule | `625d3fb` |
| 3 | Gov ID misclassified as AML form | positive `government_id` rule + compliance-mismatch suppression | `d65be32` |
| 4 | PNW/LoanApp form templates → false "reads as Mortgage Balance" + T4 for "Noah" → NOA | skip mismatch on form-like text; guard `noa` filename token | `ba5684a` |
| 5 | Appraisal market_value not extracted → clean sub-80 refi escalates to awaiting_collateral | add `APPRAISED/FINAL/ESTIMATED MARKET VALUE` patterns (value-on-next-line) | `e519684` |

Corpus sweep: `scripts/scenario-corpus-classify.js` (all 14 folders, 0 real mismatches).
Multi-scenario deployed harness: `scripts/replay-scenarios-2to15.js <id>`.

## Scenarios

| # | Name | Tests | Status |
|---|------|-------|--------|
| 1 | [Katherine Morrison](scenario-01-katherine-morrison.md) | New broker email — intro, 5-of-8 docs | 🟢 deployed-verified (19/19) |
| 2 | Sandra Whitfield | New broker, complete file → prelim | 🟢 deployed (Bug 5 fix) |
| 3 | Michael Thornton | Conversational opener → docs (2-turn) | ⬜ pending |
| 4 | Ryan Callahan | LTV >80% escalation / collateral ask | 🟢 deployed |
| 5 | Margaret Chen | Prelim ≤80% (appraisal absent from folder) | 🟢 deployed |
| 6 | Kevin Tran | Draft review: Franco approves → send | ⬜ pending (admin-reply flow) |
| 7 | Daniel Hartley | Draft review: Franco edits | ⬜ pending (admin-reply flow) |
| 8 | Sandra Fletcher | Franco rejects → polite rejection | ⬜ pending (admin-reply flow) |
| 9 | James Okafor | Franco conditions → fulfil → handoff | ⬜ pending (admin-reply flow) |
| 10 | Helen MacGregor | Referral broker, CC admin | ⬜ pending |
| 11 | Sophie Larsson | Referral borrower, plain language + forms | ⬜ pending |
| 12 | Noah MacKenzie | Follow-up reminders (cron day 2/3) | ⬜ pending (cron) · classifier Bug 4 fixed |
| 13 | Daily Summary | Automated nightly summary (cron) | ⬜ pending (cron) |
| 14 | Lena Park | Data discrepancy (credit-score mismatch) | 🟠 form-extraction gap found (see below) |
| 15 | Anna Bergstrom | Broker own app + identity clash | ⬜ pending (classifier clean) |

### Open finding — Scenario 14 (and form-template extraction generally)
Lena's loan application is a **flattened PDF**: neither pdf-parse (labels only) nor AcroForm
extraction recovers the filled values — only the LLM (base64) can read them. Consequences:
1. The deterministic discrepancy engine misreads the "Mortgage Type: First Second" label as
   position **2nd** → a **false** mortgage-position discrepancy vs the email's "1st".
2. The **intended** credit-score discrepancy (loan app 631/619 vs bureau 748/752) **cannot be
   caught deterministically** — the loan-app figures aren't in the extractable text.
This is the next fix to scope (suppress canonical field extraction from form-template text, or
route form-value discrepancies through the LLM). Affects any scenario relying on filled loan-app
values for a deterministic cross-check.
