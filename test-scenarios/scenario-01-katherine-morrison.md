# Scenario 1 — New Broker Email (Katherine Morrison)

**Tests:** Vienna's introduction behaviour when a brand-new broker submits for the first time
with a partial document package (5 of 8), LTV ≤ 80%.

**Status:** 🟡 3 bugs fixed + verified offline on the real documents · deployed replay pending
**Commit:** `625d3fb` (held) + Gov-ID follow-up fix (uncommitted at time of writing)

---

## Personas

**Broker:** Loretta Sinclair, Aspen Ridge Mortgage Group, Lic. #MB334215
`loretta.sinclair@aspenridgemortgage.ca` · (403) 628-4417

**Borrower:** Katherine Anne Morrison
142 Sage Meadows Circle NW, Calgary, AB T3R 0K4
- Loan: **$295,000** · Value: **$484,000** · **LTV ≈ 61%** · 1st-mortgage refinance
- Employer: City of Calgary · Income: $88,500 · Credit: 741 / 737
- Existing 1st: **Scotiabank** ($276,200 balance)

## Inbound email

```
From:    broker test email
To:      info@privatemortgagelink.com
Subject: New Mortgage Submission — Katherine Morrison — 142 Sage Meadows Circle NW, Calgary

Hi,
My name is Loretta Sinclair, mortgage broker with Aspen Ridge Mortgage Group, Lic. #MB334215.
I'd like to submit a new application for your review.

Borrower: Katherine Anne Morrison
Property: 142 Sage Meadows Circle NW, Calgary, AB T3R 0K4
Loan Request: $295,000 (1st mortgage, refinance)
Property Value: $484,000
LTV: Approximately 61%

Documents attached:
1. Loan Application
2. Personal Net Worth Statement
3. T4 (2025 — City of Calgary)
4. Property Appraisal
5. Credit Bureau (741/737)

Loretta Sinclair
Aspen Ridge Mortgage Group | Lic. #MB334215
(403) 628-4417
```

## Documents

Folder: `~/Desktop/UndrWrite Testing/Scenario 1 docs/`

**Initial submission (5 of 8):**
- `LoanApplication_Katherine_Morrison.pdf` → `loan_application`
- `PNW_Statement_Katherine_Morrison.pdf` → `pnw_statement`
- `T4_Katherine_Morrison_2025.pdf` → `income_proof`
- `Appraisal_142_Sage_Meadows_Circle_NW_Calgary.pdf` → `appraisal`
- `Credit_Bureau_Katherine_Morrison.pdf` → `credit_report`

**Follow-up (3, sent after Vienna requests them):**
- `GovernmentID_Katherine_Morrison.pdf` → `government_id`
- `PropertyTaxAssessment_Katherine_Morrison.pdf` → `property_tax`
- `Scotiabank_Payout_Statement_Katherine_Morrison.pdf` → `mortgage_statement`

## Expected behaviour

1. Introduce Vienna to the broker and acknowledge all 5 received documents by name.
2. Identify the 3 missing docs (Government ID, Property Tax Assessment, Mortgage Payout
   Statement) and **request them in the same reply**.
3. Fire a **preliminary review to admin** (LTV 61% ≤ 80%).
4. The prelim accurately lists received + `[MISSING]` items, with a full deal summary.
5. **Never** tell the broker the file is "complete" while items are outstanding.
6. **Never** misidentify the T4 as a Notice of Assessment (or the Gov ID as an AML form).

---

## Bugs

### Bug 1 — "everything looks complete" with 3 docs missing 🟡
**Reported:** Welcome reply said *"I received the loan application, PNW, T4, appraisal, and credit
bureau — everything looks complete for Katherine's refinance. We'll get this into review…"* — while
Gov ID, Property Tax, and Payout were still outstanding. The admin prelim correctly listed all three
`[MISSING]`, so internal tracking was right; only the broker-facing narrative lied.

**Root cause:** The broker welcome path (`processInitialEmail`) had **no missing-docs awareness** —
it relied on Claude inferring completeness from the attachments, and Claude wrongly declared the file
complete. The active/review paths had a `computeStillMissingForReview` heuristic, but it was narrow
(only flagged a missing "reviewable doc" + exit strategy) and diverged from the accurate admin list.

**Fix (strategy: remove the LLM from authoring the completeness verdict — OBS-40/41):**
- `computeMissingIntakeItems` (`dealType.js`) — **single source of truth**; admin prelim and broker
  reply now call the same computation, so they can't diverge.
- `enforceMissingDocsHonesty` (`ai.js`) — deterministic guard: when JS knows items are outstanding it
  **strips every completeness claim** (keyed on state, not an enumerated phrase list) and **injects a
  de-duped "still need X/Y/Z" ask**. Strict no-op when nothing is missing.
- Wired at **all three** broker-facing paths (welcome / active / under_review), after the existing
  routing-leak + Perfect-opener sweeps.
- `computeStillMissingForReview` now returns the full intake-missing set; OOOO maps keys → broker
  phrases and drops the "cannot move forward" framing (a prelim may already have fired).
- Welcome prompt gains a DOCUMENT-STATUS SELF-CONSISTENCY block (defense-in-depth).

**Verified (offline):** real 5-of-8 package → `computeMissingIntakeItems` = `[government_id,
property_tax, mortgage_statement]` ✅ · guard strips Katherine's exact overclaim + lists all 3 +
preserves the doc-receipt ack ✅.

### Bug 2 — T4 misidentified as Notice of Assessment 🟡
**Reported:** Prelim flagged *"T4_…pdf was provided as a Proof of Income, but its content reads as a
Notice of Assessment (NOA). Please confirm the correct document."* Recurring (also hit Daniel Hartley).

**Root cause:** The NOA content classifier matched the bare token `canada revenue` — which the CRA
header on **every** genuine T4 carries (*"Canada Revenue Agency / Agence du revenu du Canada"*).

**Fix:** Drop the `canada revenue` token (genuine NOAs always carry the literal "Notice of Assessment"
title) + add positive T4 → `income_proof` detection (Statement of Remuneration Paid / Box 14) above the
NOA rule.

**Verified (offline, real PDF):** `T4_Katherine_Morrison_2025.pdf` → `income_proof`, no mismatch ✅.

### Bug 3 — Government ID misidentified as AML form 🟡 *(caught by testing on real docs — not yet reported by Franco)*
**Found:** The real `GovernmentID_Katherine_Morrison.pdf` cover text reads *"collected for AML
identification purposes pursuant to FINTRAC Anti-Money Laundering regulations."* The AML content rule
matched `FINTRAC` → content classified `aml` → a false *"reads as an AML Report"* mismatch callout would
fire on the admin prelim **when Katherine sends the Gov ID in batch 2.** Same class as Bug 2.

**Fix:**
- Positive `government_id` content detection (driver's licence / licence no / passport no /
  government-issued identification) placed **above** the AML rule.
- General net in `detectClassificationMismatch`: incidental compliance references (AML/PEP) never drive
  a "wrong document" callout (the callout is for mislabeled *substantive* docs, e.g. credit-vs-PNW).

**Verified (offline, real PDF):** `GovernmentID_Katherine_Morrison.pdf` → `government_id`, no mismatch ✅.

---

## Verification log

### Offline — real documents (deterministic layers) ✅
All 8 real PDFs classify correctly; initial 5-of-8 → missing set is exactly the 3 expected docs.

| Document | fileClass | contentClass | mismatch |
|----------|-----------|--------------|----------|
| LoanApplication | loan_application | loan_application | none |
| PNW_Statement | pnw_statement | pnw_statement | none |
| T4 (2025) | income_proof | income_proof | none ✅ (was → noa) |
| Appraisal | appraisal | appraisal | none |
| Credit_Bureau | credit_report | other | none |
| GovernmentID | government_id | government_id | none ✅ (was → aml) |
| PropertyTaxAssessment | property_tax | other | none |
| Scotiabank_Payout | mortgage_statement | mortgage_statement | none |

`computeMissingIntakeItems(initial 5)` = `[government_id, property_tax, mortgage_statement]` ✅

### Harness ✅
`node scripts/round9-missing-docs-honesty-harness.js` — **14/14 invariants hold.**

### Deployed staging replay ⏳ pending push approval
- [ ] Send the real Loretta→Katherine inbound (5 docs) to staging.
- [ ] Welcome email: acknowledges 5 received, **no completeness claim**, requests Gov ID + Property Tax + Payout.
- [ ] Admin preliminary review fires (LTV 61%); lists received + `[MISSING]` Gov ID / Property Tax / Payout.
- [ ] Prelim has **no** "T4 reads as NOA" callout.
- [ ] Send batch 2 (Gov ID, Property Tax, Payout); prelim updates with **no** "Gov ID reads as AML" callout.
- [ ] File reads as complete only once all 8 are in.
