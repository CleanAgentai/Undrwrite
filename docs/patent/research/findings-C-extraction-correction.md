I couldn't write `findings-C-extraction-correction.md`: the harness refused the Write call because subagents must return findings as text. The full findings are below. Nothing in the repo was modified. All runs were offline: I stubbed the npm dependencies (`node_modules` isn't installed) and `src/config`, so no `.env` was read and no network call was made.

**Evidence scripts** (all in `/private/tmp/claude-501/-Users-porterstanley-Library-Application-Support-Claude-scratch-workspaces-3dfe8119-a86a-491d-890d-322ef822ea1c-7724e3a7-6a40-4951-b3c3-8cd7049f140e-scratch-2026-11-14-d1d3a7/29a33592-3068-4ffc-9cc1-2caef66da59d/scratchpad/`):
- `stub.js` loads the modules offline.
- `pdftext.py` extracts PDF text. It uses `pdftotext`/`pypdf` instead of production's `pdf-parse`/`pdf-lib`, so whitespace may differ slightly.
- `run-scenario.js` and `demo.js` run the real extraction and discrepancy code.
- Outputs are in `ex/*.out` (A06, A08, A15, A22, A28, A34, and `chen.out`).

## Answers to the attorney's questions
- **Input:** the raw Postmark `TextBody` and subject (`email.js:156`), plus each document's `{file_name, classification, text}`. The text comes from `documents.extracted_data.text`, written by `deals.js:519-540`: pdf-parse text plus `[Page N annotation]` lines from `pdfFormExtract.js:65`. Classification is mostly by filename (`deals.js:90`).
- **Errors in that input:** the extraction module does not re-read or self-correct document text. What exists instead:
  - **Cross-source discrepancy detection** (`discrepancy-engine.js:135`). For the fields shown to the broker, it asks the broker and holds the admin preliminary review ("prelim") (`webhook.js:413-438`).
  - **Source-precedence filters** (`discrepancy-engine.js:970-1180`).
  - **Sanity bounds:** loan-application amount must be $5k–$2M (`canonical-fields.js:891`); a loan-application amount more than 30% off the broker's figure is suppressed (`:2054`); oversized money suffixes are capped (`:182`).
  - **Admin callouts** for filename-vs-content mismatch (`deals.js:167`), postal-code mismatch, and lender mismatch (`webhook.js:1536-1584`).
  - **Visible parse failures:** a failed parse is flagged `extraction_failed`, not stored as empty (`deals.js:478`).
  - A missed value just produces no tuple and shows as "TBD".
- **How facts are extracted:** deterministic regular expressions anchored on known labels, per document type and over broker prose. No LLM is involved. `extractCanonicalFields` at `canonical-fields.js:1699-2139` assembles them.
- **Who makes decisions:** pure JavaScript functions over the canonical map: `computeStandaloneLtv` (`discrepancy-engine.js:535`), `computeCombinedLtv` (`:340`), `shouldEscalateOnAnyLtv`, `shouldAutoDeclineOver90`, `shouldEscalateOnIncompleteCanonical`, and `shouldHoldPrelimForDiscrepancy` (`webhook.js:413`).
  - The LLM's `ltv_percent` is used only when the canonical map can't compute LTV (`webhook.js:3510, 4478`).
  - The exit-strategy, completeness and Q10 checks still read the LLM summary.
- **The structured dataset:** the "canonical map". Each field name maps to an ordered array of tuples:
  `{value, source (file name or a label like email_body / broker_correction / broker_initial_intent / province_inferred_from_postal / mortgage_position_inferred_from_existing_balance / defaulted_from_purchase_absence), classification?, lender_canonical? (balance and payout only), rawPhrase?, payoutConfirmed?, refinanceConfident?}`
  - There are 15 fields (`canonical-fields.js:1701-1754`).
  - Tuples carry no document id, timestamp or confidence score.
  - **It is never persisted.** It is rebuilt every turn from stored messages and document text. The only persisted fact store is the LLM-produced `deals.extracted_data` (`ai.js:326-357`).
- **When a fact changes:**
  - Across the thread, the newest non-empty value from each email wins after reply-quote stripping (`discrepancy-engine.js:1313-1387`).
  - `parseBrokerCorrections` (`canonical-fields.js:1081`) handles only four fields: loan amount, purpose, mortgage position, transaction type. A correction is moved to the front of its field (`:1950`) and the filters keep only it.
  - There are message-wide hedge and question guards (`:1089`, `:1095`).
  - The checks re-run every turn because the map is rebuilt.
  - Q10 re-notification (`webhook.js:1648-1712, 4022-4047`) compares the LLM summary against values regex-parsed from the last prelim email. Only loan amount, appraised value and existing balance can actually fire.

## Examples run with real fixtures
- **A06 (thread):**
  - The intake email plus three PDFs produces a map with these sources: address and postal from the mortgage statement and appraisal; province inferred from the postal code; market value 650k from the email and the appraisal; loan 310k from the email and the loan application; lender RBC, balance 225k and payout 226.5k from the statement; transaction type defaulted to refinance. LTV is 47.7%.
  - The broker's later "Updating loan amount: $345,000" is not a recognized correction phrase. The filter that drops email values when a loan application is on file then removes it, so the prelim shows **$310,000**.
  - This matches the recorded staging result in `bulletproof-fullmatrix-results-4.json` (expected 345000, actual 310000).
- **A34:** the balance correction isn't supported (expected 222,500, actual 225,000 in the same results file).
- **A08:** "actual loan amount is $290,000" is not recognized.
- **A22:** a real postal mismatch (V5R5T7 vs V5R5T8) is asked of the broker. The rendered text says "the MortgageStatement Chen pdf" because `discrepancy-engine.js:872` replaces the dot before trying to strip `.pdf`.
- **David Chen PDF** (real loan application, plus a broker email I constructed):
  - Loan amount 80k and purpose come from the page annotations.
  - "Owner Occupied" is derived from the form's printed label "(Including Primary Residence)", not from a filled-in value.
  - The exit-strategy annotation and the existing RBC $210k balance are not extracted, so combined LTV is null (true combined is about 78%).
  - A purpose that differs only in capitalisation is raised as a discrepancy to the broker and would hold the prelim (exact string comparison, `discrepancy-engine.js:94`).
  - The quoted line "> Appraised at $999,000" in the reply became the market value on the per-turn path.

## Other gaps found
- The checks that drive escalation (`webhook.js:3502, 4288, 4303, 4466`) use only the current email, with no quote stripping and no filters.
- The admin prelim aggregates the whole thread with filters (`webhook.js:1344`), so the two can disagree.
- When present, the broker's prose market value is the first market-value tuple, so the LTV checks read it ahead of the appraisal's value.
- `computeDiscrepancySet` compares every field, so comments calling some fields "display-only" are stale.
- `isIdentityClash` is exported but has no production call site; only `isIdentityClashByAbsence` is used (`ai.js:663`).

## Stale or contradicted claims in `vienna-ip-specification.md`
- **III.3:** `resolveCanonicalIntentValue` is at `:2147`, not `:1971`. The field names `property_value` and `borrower_name` don't exist. "Documents outrank prose for objective fields" is false for market value, address and postal code as the checks read them.
- **III.7:** there is no lender correction. `parseBrokerCorrections` is at `:1081`, not `:990`. There is nothing persisted to "fold into".
- **IV(a):** line references are stale (`:535` and `:340`; `webhook.js:3502` and `:4466`). "The canonical map is the single source of truth for everything a gate reads" is overstated.
- **IV(c):** `loanPatterns` is at `:520`. "refi at 83% LTV" is not a supported pattern. The claim that property value is "document-sourced only by design" is contradicted: it is extracted from prose (`canonical-fields.js:569-584`, pushed first at `:1766`). The cited notes at `:1513` and `:1726` don't exist.
- **IV(d):** "the canonical map persists" is false. The checks don't accumulate across the thread. The "state-stability barrier" isn't in `src/`; the "settle window" in commit `edae488` is a test-replay change.
- **IV(g):** the code is at `webhook.js:3762-3776`, not `:3545`. The behaviour is otherwise accurate, but correction phrasings the parser doesn't recognise still go to the LLM `parseCollateralReply`.

Supporting git history: `4667b70` (the first canonical-fields commit; it records 0 false positives / 0 misses on a 58-deal corpus), `2944eeb` (the precedence rules), `65aa30f` (thread aggregation), `0188951` and `4ce2aec` (refinance handling), `4ad23f1` (only structured discrepancies hold the prelim), `54c45e6` (correction routing out of `awaiting_collateral`), `a5c032c` (Q10).