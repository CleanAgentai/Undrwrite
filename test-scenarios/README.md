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
| 3 | Michael Thornton | Conversational opener → docs (2-turn) | 🟢 deployed |
| 4 | Ryan Callahan | LTV >80% escalation / collateral ask | 🟢 deployed |
| 5 | Margaret Chen | Prelim ≤80% (appraisal absent from folder) | 🟢 deployed |
| 6 | Kevin Tran | Draft review: Franco approves → send | 🟢 deployed (full approve→draft→send→broker) |
| 7 | Daniel Hartley | Draft review: Franco edits | 🟢 deployed (edits incorporated into draft) |
| 8 | Sandra Fletcher | Franco rejects → polite rejection | 🟢 deployed (regen docs): prelim → DECLINE → SEND → broker rejection + status rejected |
| 9 | James Okafor | Franco conditions → fulfil → handoff | 🟡 conditions request → broker dispatches + names AML/PEP; **auto-handoff after fulfilment does not fire** (open) |
| 10 | Helen MacGregor | Referral broker, CC admin | 🟢 deployed (body) · CC/attach not body-checkable |
| 11 | Sophie Larsson | Referral borrower, plain language + forms | 🟢 deployed |
| 12 | Noah MacKenzie | Follow-up reminders (cron day 2/3) | 🟢 deployed (regen): partial submission → requests missing items, no false position/PNW mismatch; reminder cron verified offline |
| 13 | Daily Summary | Automated nightly summary (cron) | 🟢 all 5 sections incl. Automated Reminders; idempotent send, non-deal filter |
| 14 | Lena Park | Data discrepancy (credit-score mismatch) | 🟢 deployed (regen): catches 631/619 vs 748/752, holds, resolves to ONE prelim |
| 15 | Anna Bergstrom | Broker own app + identity clash | 🟢 deployed (regen Grace docs): catches Anna/Grace clash, holds for identity, resolves |

### Scenarios 14 & 15 — Vienna is correct; the Desktop test data doesn't match the scenario intent
Verified against the **real** AcroForm annotations of the Desktop PDFs:
- **S14 (Lena):** the loan app annotates as a **2nd mortgage** (`Second Mortgage`, `$78,000`,
  `10.75%`, `12 months`, "Kitchen and bathroom renovation") while the broker email says "1st".
  Vienna **correctly catches that real 1st-vs-2nd discrepancy** and holds the prelim. The
  *intended* credit-score discrepancy (631/619 vs 748/752) is **not present in the extractable
  content** — those figures are in neither the pdf-parse text nor the AcroForm annotations — so
  it can't be exercised with this file.
- **S15 (Anna):** the loan app annotates as **Anna Bergstrom** (`anna.bergstrom@ucalgary.ca`),
  NOT Grace Paulson — so there is **no identity clash** in this data, and Vienna correctly
  proceeds with Anna (also catching the same real 1st-vs-2nd position discrepancy). Franco's own
  `vimarealty` run showed borrower "Grace Marie Paulson", so his copy of the S15 docs differs
  from the Desktop copy.

### Test-data issue blocking S8 / S9 / S12 / S14 / S15 — loan apps generated as "2nd Mortgage"
`scripts/scan-positions.js` (reads the AcroForm annotations of every loan app) shows **5 of 12**
loan apps annotate as a **Second Mortgage** while their scenario/email says "1st":

```
   1st/none  S1 S2 S3 S4 S5 S6 S7   (clean — these scenarios run end-to-end)
   ⚠️ 2nd     S8 S9 S12 S14 S15      (email says 1st → Vienna correctly holds for clarification)
```

Because Vienna (correctly) flags the email-vs-loanapp 1st/2nd conflict and holds the deal for
clarification, the prelim never fires — so the **reject (S8) / conditions (S9) / reminders (S12)**
flows can't be reached with this data. **Fix: regenerate those 5 loan apps as "First Mortgage"**
(or set the broker emails to "2nd") and the flows will proceed. No Vienna change needed — verified
by S6/S7 (clean loan apps) running the full admin pipeline successfully.

**Action for Franco/Porter:** regenerate the S14 loan app with the 631/619 credit scores in a
readable field (and as a 1st mortgage), and the S15 loan app with Grace Paulson's identity, to
exercise the intended tests. The discrepancy + identity engines themselves are working
(demonstrated by the correct 1st-vs-2nd catch). No Vienna code change warranted here.
