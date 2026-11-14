The updated findings for module C (extraction, error correction, changes to facts) are below, ready to save as `docs/patent/research/findings-C-extraction-correction.md`. I didn't modify anything in the repo. I re-ran A06, A08 and A34 offline against current HEAD (425715d), with no `.env` read and no network calls.

---

# Findings C: Deal-fact extraction, error detection and correction, and changes to facts (modules 4–6)

**Codebase:** `~/Undrwrite` at HEAD `425715d`. This replaces the version written against `edae488`.

**Commits since the baseline that matter here:**
- `d6ec8c7` (P1 fact snapshots; F9 Q10 on all five material fields)
- `27ee664` and `eb0b8d3` (F8: new correction phrasings, balance corrections, payout-filter follow-up, P2 estimate labelling)
- `15d30f3` (identity clash: email-derived names are weak evidence)
- `340d33b` (F3/F4/F5: LTV gates on follow-ups, decline-only first email)
- `43d45a8` (P4: thresholds moved to one config file)
- `4313090` (F11/F12: four unused AI functions removed; collateral re-ask fixed)

**How the examples were run.** Everything ran offline with node v22 against the real source modules. Evidence is in `/private/tmp/claude-501/-Users-porterstanley-Library-Application-Support-Claude-scratch-workspaces-3dfe8119-a86a-491d-890d-322ef822ea1c-7724e3a7-6a40-4951-b3c3-8cd7049f140e-scratch-2026-11-14-d1d3a7/29a33592-3068-4ffc-9cc1-2caef66da59d/scratchpad/v2/`:
- `stub2.js` stubs `src/config` and every npm package except `pdf-parse` and `pdf-lib`.
- PDF text is built the same way production builds it: `pdf-parse` text plus `src/lib/pdfFormExtract.js`. The baseline used Python `pdftotext`/`pypdf`; this run uses the production libraries.
- `run2.js` replays each scenario's `events.json`. It calls the real exported `buildThreadFacts`, `evaluateFollowUpLtvGates` and `q10DetectMaterialChanges` from `webhook.js`, with the database reads replaced by in-memory lists.
- `demo2.js` holds the focused unit demonstrations.
- Outputs are `A06.out`, `A08.out`, `A34.out` and `demo2.out`.

---

## Answers to the attorney's questions

**1. What is the input?**
- **Broker email:** each inbound email's plain text and subject.
- **Documents:** for each document, `{file_name, classification, text}`.
  - The text is the `pdf-parse` text layer plus AcroForm field values and `[Page N annotation]` lines from `pdf-lib` (`deals.js:458-506`, `pdfFormExtract.js`).
  - It is stored in `documents.extracted_data.text`. A parse that fails three times is stored as `extraction_failed`, not as empty text (`deals.js:510-518, 567-573`).
  - Classification is mainly by filename, with a content cross-check (`deals.js:90, 167`).
- **Thread history:** the gates that work on the whole thread read every stored inbound email for the deal, in order (`webhook.js:2235, 4744`). Fact-snapshot rows are excluded from conversation queries (`deals.js:396, 719`).

**2. How is error in that input detected and corrected?** Nothing re-reads or self-corrects document text. Instead, six deterministic mechanisms exist:

- **(a) Cross-source discrepancy engine.**
  - `computeDiscrepancySet` (`discrepancy-engine.js:136`) groups each field's values by normalised value, using per-field tolerances (`:59-99`): market value ±5%, balance ±1%, everything else exact.
  - Balance and payout are compared only within the same lender (`:39, 140-152`).
  - Discrepancies the broker can see (`filterBrokerFacing`, `:178`, which excludes the five money fields) produce a clarification request. They also hold the admin preliminary review ("prelim") through `shouldHoldPrelimForDiscrepancy` (`webhook.js:416`).
- **(b) Source-precedence filters** (`discrepancy-engine.js:975, 1069, 1124, 1153`). These pick which source's value is shown and used. Section 5 has the details, including F8.
- **(c) Explicit broker corrections** (`parseBrokerCorrections`, `canonical-fields.js:1081`). The correction becomes the top-ranked value for its field (section 6).
- **(d) Sanity bounds:**
  - A loan-application amount must be between $5k and $2M (`canonical-fields.js:898`).
  - A loan-application amount more than 30% away from the broker's stated figure is dropped from the map (`:2081-2101`).
  - An absurd money suffix falls back to the base figure (`:182`).
  - Broker-asserted corrections are capped below $100M (`:1124, 1152`).
- **(e) Admin callouts** in the prelim: postal-code discrepancy, lender mismatch, filename-vs-content mismatch, and the new "LTV is an estimate" callout (`webhook.js:1486, 1510, 1525, 1540`; P2 `eb0b8d3`).
- **(f) Identity clash** (`ai.isIdentityClashByAbsence`, `ai.js:686`). If a document names a borrower the broker never mentioned, normal processing stops and a minimal identity question goes out.
  - **New in `15d30f3`:** a name read from an email address is weak evidence. It counts as a clash only if no part of it relates to a word the broker wrote (`ai.js:701-709`).

**3. How are facts extracted?**
- Deterministic regular expressions anchored on known labels, per document type and over the broker's prose.
- `extractCanonicalFields` (`canonical-fields.js:1727-2165`) assembles them. `extractCanonicalFieldsAggregated` (`discrepancy-engine.js:1340`) does the same across the whole thread.
- No LLM is involved in canonical extraction.
- Separately, an LLM writes a free-form `deals.extracted_data` summary (`ai.js:354-369`, saved at `webhook.js:3681`). Some checks still read it (section 4).

**4. What makes the autonomous decisions?**
- **Pure JavaScript over the canonical map:**
  - `computeStandaloneLtv` (`discrepancy-engine.js:536`) and `computeCombinedLtv` (`:341`)
  - `shouldEscalateOnAnyLtv` (`:567`): over 80% escalates
  - `shouldAutoDeclineOver90` (`:626`) together with `isCombinedLtvResolved` (`:613`): over 90% auto-declines
  - `shouldEscalateOnIncompleteCanonical` (`:596`)
  - `computeLtvBand` (`:667`)
  - `shouldHoldPrelimForDiscrepancy` (`webhook.js:416`)
  - **New:** `evaluateFollowUpLtvGates` (`webhook.js:2190`), F3
- All thresholds now come from `src/config/thresholds.js` (80 / 90 / 75; P4 `43d45a8`).
- **Where the LLM's `ltv_percent` is still used:** only as a fallback when canonical standalone LTV can't be computed (`webhook.js:447, 3659, 3764, 4734, 4750`). Since P2 that fallback is logged and labelled "(est.)" (`webhook.js:1486, 1591`).
- **Checks that still read the LLM summary:** the exit-strategy check (`webhook.js:4760`), completeness, and the `unresolved_discrepancy` term of the prelim hold.
- **Q10 no longer reads the LLM summary** (F9, see 6.4).

**5. Is there a structured dataset, and how is it managed?**
- **Yes: the canonical map.**
  - Each field maps to an ordered array of evidence tuples, and index 0 is the winning value (section 3).
  - It is rebuilt from source every turn, then filtered the same way at every place that uses it.
- **New since the baseline: it is now persisted** as an append-only history of "fact snapshots" (P1, `d6ec8c7`).
  - Each snapshot holds the whole filtered map plus a compact five-field `facts` record, stored as `messages` rows with `direction='system'` (`deals.js:335-351`).
  - Snapshots are written at intake, when the prelim goes out, and on any inbound email that changes the facts (`webhook.js:3693, 1602, 4285, 4316, 4751`).
- **The snapshots are a record, not an input.** Every decision still rebuilds the map from emails and documents. The snapshots serve as the comparison baseline for Q10 and Path B, and as an audit trail.

**6. How is a change in a deal fact handled?**
- **Explicit corrections:** `parseBrokerCorrections` now covers five fields. F8 added the phrasings "updating / revised / actual / now" and the existing first-mortgage balance.
- **Thread rule:** the newest correction per field wins across the thread.
- **Precedence:** a correction outranks documents for every field. A balance correction is the one exception: it can display, escalate and re-notify, but cannot by itself make the deal eligible for auto-decline.
- **Follow-up gates:** F3 runs the auto-decline and incomplete-data gates on follow-up emails over the whole thread's facts.
- **Admin re-notification:** F9 compares the newly rebuilt five-field facts with the snapshot taken at the last prelim and re-notifies the admin with only what changed.

---

## 1. Purpose
- **Module 4:** turn unstructured broker emails and documents into one structured, source-tagged set of deal facts.
- **Module 5:** detect conflicts and errors between sources, choose the authoritative value, and hold or route the deal.
- **Module 6:** let facts change over a multi-email thread (corrections, late documents) while keeping a history, and re-evaluate decisions and notify the admin when a material fact changes.

## 2. Inputs (current code)

| Input | Where |
|---|---|
| Inbound email `TextBody` and subject | `webhook.js` (inbound handler); stored through `saveMessage` |
| Document text (pdf-parse plus pdf-lib form and annotation text) | `deals.js:458-506`; `pdfFormExtract.js` |
| Parse-failure flag | `deals.js:510-518, 567-573` |
| Document classification | `deals.js:90` (`classifyDocument`); content cross-check at `:167` |
| Thread (all inbound emails, in order) | `getMessages`, excluding `system` rows (`deals.js:396`) |
| Stored fact snapshots | `getFactSnapshots` (`deals.js:345`) |

## 3. Processing and data structure

### 3.1 The canonical map (`canonical-fields.js:1729-1782`)
There are 17 fields. The baseline counted 15; `subject_property_city` and `subject_property_occupancy` are the additions.
- **Property:** address, postal code, city, province, market value, assessment value
- **Loan:** requested loan amount
- **Existing first mortgage:** lender, balance, payout total
- **Borrower:** primary borrower full name
- **Structure:** mortgage position, purpose, transaction type, occupancy

Each value is an ordered array of tuples:

```
{ value,
  source,            // file name, or a label: email_body | email_subject_or_body | broker_correction |
                     // broker_initial_intent | province_inferred_from_postal |
                     // mortgage_position_inferred_from_existing_balance |
                     // defaulted_from_purchase_absence | defaulted_purchase_signal
  classification?,   // document class or one of the labels above; drives every filter
  lender_canonical?, // balance and payout only; separates comparisons by lender
  rawPhrase?,        // the broker text that produced a correction or intent tuple
  payoutConfirmed?, refinanceConfident?   // transaction_type only
}
```

Tuples carry no document id, timestamp or confidence score. Time order is preserved only by snapshot `created_at`.

### 3.2 Order of assembly in `extractCanonicalFields`
1. Values from the email body and subject are pushed first (`:1789-1807`). On the thread-wide path these are already resolved, newest email winning (`discrepancy-engine.js:1352-1373`).
2. Per-document extractors run (`:1810-1906`):
   - mortgage statement: address, postal, lender, balance and payout by lender
   - property tax: address, postal, assessment, name
   - appraisal: address, postal, market value
   - credit report: lender, balance, name
   - AML/PEP: name only
   - loan application: loan amount, purpose, position, occupancy
   - personal net worth (PNW) statement: lender, balance
3. Province is inferred from postal code or city if not already known (`:1925-1937`).
4. Broker corrections are moved to the front of their field (`unshift`, `:1978-1986`).
5. Broker initial intent goes after any correction for the intent fields (loan amount, purpose, transaction type). For other fields it is appended after the documents (`:1987-2008`).
6. Mortgage position is derived from a non-zero existing balance, unless the broker corrected it or the refinance carve-out applies (`:2037-2050, 2156-2159`).
7. A loan-application amount more than 30% away from the broker's figure is removed (`:2081-2101`).
8. Transaction type is defaulted (refinance unless there is a purchase signal), and every transaction-type tuple is tagged with `payoutConfirmed` and `refinanceConfident` (`:2112-2143`).

### 3.3 Per-field precedence

**Construction order** (index 0 wins) is set in `extractCanonicalFields`. **Consumer filters** (`discrepancy-engine.js`) are always composed in the same order at every place that uses the map: prelim (`webhook.js:1371`), `buildThreadFacts` (`:2242`).

| Field | Effective precedence |
|---|---|
| `requested_loan_amount` (intent) | broker correction > broker initial intent > loan application > email body. The filter keeps **only** the top class (`:1069-1103`). A loan-application value more than 30% off the broker's figure is removed at construction. |
| `purpose` (intent) | broker correction > initial intent > loan application / AML / PEP > email body (`:1153-1180`) |
| `transaction_type` (intent) | broker correction > initial intent > default. Not filtered; index 0 is used. |
| `mortgage_position` (objective) | broker correction > loan application > derived-from-balance > email (`:1124-1147`) |
| `existing_first_mortgage_lender` | only mortgage-statement tuples survive (`:1050`) |
| `existing_first_mortgage_balance` | If a statement is on file: statement tuples **plus `broker_correction` tuples** (F8, `eb0b8d3`, `:1051-1055`). Otherwise all tuples, with the lender cleared. Since the correction was moved to the front at construction, it is index 0. |
| `subject_property_market_value`, address, postal code | **Not filtered.** The email-body value is pushed first and so is index 0 whenever the broker states it (open issue, section 9). |

**Intent resolver.** `resolveCanonicalIntentValue` (`canonical-fields.js:2175`) picks the loan amount or purpose by class: correction > intent > loan application > AML/PEP > email.

### 3.4 Thread aggregation (`discrepancy-engine.js:1340-1393`)
For each inbound email in order:
1. Strip the quoted reply chain (`stripQuotedReplyChain`, `:1320`: a Gmail "On … wrote:" header, otherwise lines starting with `>`).
2. Extract from the remaining body; for the plain email fields the newest non-empty value wins.

Then:
- Initial intent is parsed from the **first** email only.
- Corrections are parsed from emails **2..n**, with the latest correction per field winning (`:1379-1387`).
- Payout and purchase language is detected over all stripped broker bodies (`brokerBodyText`).

## 4. Outputs
- **The map itself and `discrepancy_set`** (`runDiscrepancyDetection`, `:1236`; `runDiscrepancyDetectionAggregated`, `:1401`). Both short-circuit on commercial deals or an identity clash, and clear the existing-mortgage fields when two or more borrowers' credit bureaus are present.
- **Code-built Deal Snapshot rows** (`renderDealSnapshot`, `:680`) and the broker-facing discrepancy section (`:190`).
- **Gate decisions** (section 1, Q4).
- **New:** persisted snapshots of `{trigger, facts, map}` (P1) and Q10 notices that list only the changed fields (`webhook.js:1660-1669`).

## 5. Error detection and correction (module 5): current details

### 5.1 Discrepancy engine
`computeDiscrepancySet` (`:136`) and `valuesEqual` (`:64`) work as described in Q2(a).
- **Purpose:** compared by exact string (`:93-94`), so a difference only in capitalisation is still a discrepancy (open).
- **Borrower name:** first and last name tokens are compared after normalisation (`:84-89`).

### 5.2 Filters, including F8
`filterCanonicalLenderForPayoutOnly` (`:975-1057`).
- **Before F8:** when a mortgage statement was on file, every non-statement balance tuple was dropped. That included the broker's correction (live A34 replay, recorded in `eb0b8d3`).
- **Now:** `broker_correction` tuples survive.
- **Demonstrated** (`demo2.out`): input [correction 222,500; credit report 318,000; statement 225,000] produces output [correction 222,500; statement 225,000].

### 5.3 `isCombinedLtvResolved` and the broker-only balance rule (`:613-624`)
Combined LTV is decline-eligible only when:
- the payout status is resolved (refinance with `payoutConfirmed`, or an explicit second mortgage, or a broker correction to position 2nd), **and**
- the first balance tuple is **not** a `broker_correction` (F8, `27ee664`).

Demonstrated on an explicit second mortgage ($150k requested, $500k value):

| Balance input | Combined LTV | Resolved | Auto-decline | Escalate |
|---|---|---|---|---|
| Statement balance $320k | 94% | true | **yes** | yes |
| Broker correction $320k (statement $250k) | 94% | **false** | **no** | yes |

### 5.4 Identity clash (`ai.js:686-724`)
- **Labelled document names:** a clash if the first or last token is missing from the broker's subject or body. This is unchanged.
- **Names read from email addresses (new, `15d30f3`):** a clash only when no token is present in, contains, or is contained in a broker word of three or more letters. The result is tagged `source:'personal_email'`.

Demonstrated:

| Document contains | Broker wrote | Result |
|---|---|---|
| `mchen.yyc@` | "Michael Chen" | no clash |
| `john.smith@` | "Anna Bergstrom" | clash (personal_email) |
| Labelled "Borrower Name: John Smith" | "Anna Bergstrom" | clash |

`isIdentityClash` (`ai.js:603`) is still exported but has no production caller (open).

### 5.5 Gates that use thread-wide facts versus one email (F3, `340d33b`)
- **Uses the whole thread:**
  - `evaluateFollowUpLtvGates` (`webhook.js:2190`) runs on the thread-wide map (`:4744-4750`) and drives the follow-up auto-decline (`:4843`; if the admin already approved, an admin alert instead) and the incomplete-data escalation into the collateral hold (`:4753, 4897`).
  - F4 decides on decline before the welcome email is sent, so a declined first email gets only the decline (`:3652-3676`).
- **Still uses only the current email:** the over-80% escalation gate on follow-ups (`:4724-4740`) and the broker-facing discrepancy detections (`:3480, 4092, 4560`). This is now a narrower gap than before (section 9).

## 6. Changes to facts (module 6)

### 6.1 `parseBrokerCorrections` (`canonical-fields.js:1081-1258`)
- **Guards that apply to the whole message:**
  - A hedge word anywhere in the message (I think / maybe / approximately / around / about …, `:1090`) suppresses **all** corrections in it.
  - A question shape (`:1097`) does the same.
- **Loan amount:** the original eight patterns plus four F8 patterns (`:1118-1121`), all requiring a `$` right after the cue. The F8 phrasings are "updating/updated/revised/new loan amount", "revised amount", "actual loan amount is / should be", and "loan amount is now / changed to".
- **New field, existing first-mortgage balance** (F8, `:1141-1158`): "current / existing / actual / correct / updated (first) mortgage balance is …", "mortgage balance is actually / should be / is now …", and "correct / updated / actual balance: …".
- **Unchanged:** purpose, mortgage position, transaction type.

**Demonstrated** (`demo2.out`):

| Recognised | Not recognised |
|---|---|
| "Updating loan amount: $345,000" → 345000 | "…now around $345,000" (hedge) |
| "actual loan amount is $290,000" → 290000 | the same sentence ending in "?" (question) |
| "Revised amount: $410,000" | "Confirming $345,000 is final" |
| "The loan amount is now $305,000" | "Updating loan amount to 345k" (no `$`) |
| "Current first mortgage balance is $222,500 not $225,000" → balance 222500 | "the existing balance is $222,500" |
| "Correct balance: $199,000" | "Updating loan amount: $345,000. Let me know about timing." (the word "about" anywhere suppresses it) |
| "mortgage balance should be $300,000" | |

### 6.2 Thread aggregation
Covered in 3.4.
- When a deal is in `awaiting_collateral`, a reply that contains a recognised correction (now including balance) goes to correction processing instead of the LLM `parseCollateralReply` (`webhook.js:4019-4025`).
- That check runs on the unstripped body.

### 6.3 Fact snapshots (P1, `d6ec8c7`)
**`buildThreadFacts(deal)`** (`webhook.js:2234-2261`):
1. Builds the thread-wide map from every inbound email plus all documents.
2. Applies the four-filter chain the prelim uses.
3. Produces a compact `facts` record:
   - `loan_amount_requested`: the intent resolver's pick
   - `property_value`: index 0 of market value
   - `existing_mortgage_balance`: index 0 of balance
   - `property_address`: the normalised postal code, or else the normalised street
   - `loan_type`: `"<transaction type>[ / <position>]"`

**`recordFactSnapshot(deal, trigger, {onlyIfChanged})`** (`:2264-2277`):
- Calls `saveFactSnapshot`, which inserts a `messages` row: `direction:'system'`, `subject:'[fact-snapshot] <trigger>'`, `body: JSON {trigger, facts, map}` (`deals.js:338-344`).
- With `onlyIfChanged`, it skips the write when `facts` equals the latest snapshot.
- On error it logs and carries on.
- There was no schema change.

**Triggers:** `intake` (`webhook.js:3693`), `prelim` (`:1602`, after each prelim send including updated prelims), and `inbound` (`:4285, 4316, 4751`).

### 6.4 Q10 re-notification (F9, `d6ec8c7`)
- **Prior facts:** `q10PriorFacts` (`webhook.js:2281`) returns the **last `prelim` snapshot's facts**. It falls back to scraping the prelim HTML (`q10ParsePriorFromPrelim`, `:1649`) only for deals whose prelim predates snapshots.
- **Comparison:** `q10DetectMaterialChanges(prior, now)` (`:1621-1639`) compares all five fields (`Q10_MATERIAL_FIELDS`, `:1614`) as trimmed strings.
  - A field that is null on either side is not counted as a change.
  - A prior balance of 0 is ignored.
- **Where it fires:**
  - For a text-only reply on an `under_review` deal, it sends the change-only `[UPDATED] Prelim correction` notice (`:4282-4297`).
  - For a reply with documents, Path B re-sends the full updated prelim only when a material field changed (`:4315-4325`).
- Address and transaction type / position changes can now fire. Before F9 only three figures could.

### 6.5 Re-evaluation on change
- Every turn rebuilds the maps. The follow-up decline and incomplete-data gates use the thread-wide map (F3).
- An admin's earlier approval or override turns an over-90% follow-up into an admin alert, not a decline (`:2191, 4844`).

## 7. AI use in this module
- **No AI** in canonical extraction, the discrepancy engine, filters, corrections, snapshots or Q10.
- **LLM used for:**
  - the `deals.extracted_data` summary (exit strategy, borrower name, `ltv_percent` fallback, `unresolved_discrepancy`, `identity_clash`)
  - `parseCollateralReply` for collateral replies that aren't corrections
  - the prose of broker and admin emails, with code-built Snapshot rows and discrepancy bullets placed into it
- **Removed (F11, `4313090`):** four unused AI functions: `classifyImage`, `updateDealSummary`, `generateInfoRequestEmail`, `generateDocReviewNotification`.

## 8. Worked examples (current code, production PDF text pipeline)

**A06: loan amount corrected mid-thread** (intake $310k, then "Updating loan amount: $345,000", then "Confirming $345,000 is final")
- **After the intake email**, filtered map:
  - address 1142 Tory Road NW and postal T6R2K8 (statement and appraisal)
  - province AB, inferred from the postal code
  - market value 650k (email body first, then appraisal)
  - loan **310k** (loan application only; the email copy is dropped by the filter)
  - lender RBC, balance 225k and payout 226.5k (statement)
  - transaction type refinance (default, `refinanceConfident:true`)
  - LTV 47.7%
  - facts = `{loan_amount_requested:310000, property_value:650000, existing_mortgage_balance:225000, property_address:"T6R2K8", loan_type:"refinance"}`
- **After the correction email:**
  - `parseBrokerCorrections` returns `{requested_loan_amount, 345000, "Updating loan amount: $345,000"}`.
  - The thread-wide raw map has loan amount = [correction 345k, email 345k, loan application 310k].
  - The raw discrepancy set contains loan amount 345k vs 310k. It isn't shown to the broker because money fields are excluded.
  - The filtered map has loan amount = [correction 345k] only. Standalone LTV is 53.1%.
  - facts.loan_amount_requested = **345000**.
  - Q10 against the prelim snapshot: `[{requested loan amount: 310000 → 345000}]`.
  - **FIXED** (`27ee664`). The baseline result was 310k, which matched staging results-4.
- **After the confirmation email:**
  - It is not itself a recognised correction, but the earlier one still stands, so the facts stay 345k.
  - The escalation gate that reads only the current email sees 310k on this turn (47.7%). That's harmless here but shows the remaining gap.
  - Q10 compares with the **prelim** snapshot again and reports the same change again (section 9).

**A08: loan amount corrected; loan application more than 30% off** (loan application $115k, then "actual loan amount is $290,000")
- **Intake:** loan 115k (loan application), value 850k (appraisal), BMO balance 410k. Standalone 13.5%. Combined 61.8%: added together, because requested 115k is less than the 410k existing balance, so the refinance carve-out doesn't apply.
- **Correction:** recognised (290k). The loan-application tuple of 115k is **removed at construction** (60% off), so the raw and filtered maps hold only the correction.
  - The same email also produced a `transaction_type` correction "refinance" from the phrase "mortgage refinance".
  - Standalone 34.1%. Combined (290 + 410) / 850 = **82.4%**, which is over 80, so the deal escalates. Resolved is false, so there is no decline.
  - Q10: loan amount 115000 → 290000.
  - **FIXED** (`27ee664`).

**A34: balance corrected over the statement** ("Current first mortgage balance is $222,500 not $225,000")
- **Intake:** loan 280k (loan application), value 650k, RBC balance 225k, position "1st" from the email, refinance. LTV 43.1%. facts.loan_type = "refinance / 1st".
- **Correction:** recognised. The thread-wide raw map and the filtered map both have balance = [correction 222.5k, statement 225k]. Keeping the correction is the F8 follow-up, `eb0b8d3`.
  - facts.existing_mortgage_balance = **222500**. Q10: balance 225000 → 222500.
  - No discrepancy is raised because the correction has no lender and so isn't compared with the RBC statement (`:140-152`).
  - Combined LTV is unchanged at 43.1% because the refinance carve-out treats the existing balance as paid out.
  - In that case the code-built Snapshot shows "Combined LTV ($0 + $280,000) / $650,000". It has **no balance row** (`discrepancy-engine.js:768-797`), so 222,500 reaches the admin only through the Q10 notice and the stored facts.
  - **FIXED** at the fact level (`27ee664`, `eb0b8d3`).
  - The staging grader for A34 reads `extracted_data.existing_mortgage_balance`, which is the LLM's value. A live re-run could still be graded as failing for that reason. There is no post-fix full-matrix results file in the repo.

## 9. Gaps from the baseline: status

| Baseline gap | Status |
|---|---|
| A06 "Updating loan amount" not recognised (prelim showed 310k) | **FIXED** `27ee664` |
| A08 "actual loan amount is …" not recognised | **FIXED** `27ee664` |
| A34 balance correction not supported | **FIXED** `27ee664` (parser) and `eb0b8d3` (survives the payout filter) |
| Broker balance correction could drive auto-decline | Never possible before; now explicitly blocked by `isCombinedLtvResolved` (`27ee664`) |
| "The canonical map is never persisted" | **FIXED in part** `d6ec8c7`: snapshots are persisted. Decisions still rebuild from source by design. |
| Q10 compared the LLM summary with three figures scraped from the prelim; only three fields could fire | **FIXED** `d6ec8c7`: code-built facts vs the prelim snapshot, five fields |
| Escalation and decline checks used only the current email | **FIXED in part** `340d33b`: follow-up auto-decline and incomplete-data gates use the whole thread. **Still open:** the over-80% follow-up escalation (`webhook.js:4724`) and the broker-facing discrepancy runs (`:3480, 4092, 4560`). |
| Quoted ">" lines read as facts on the single-email path | **Open** (single-email path is not quote-stripped; the correction check at `:4019` isn't either) |
| Broker prose market value outranks the appraisal at index 0 | **Open** (`canonical-fields.js:1795`; A06 facts.property_value comes from the email body) |
| Purpose compared by exact string | **Open** (`discrepancy-engine.js:93-94`) |
| ".pdf" not stripped in discrepancy bullets ("the MortgageStatement Chen pdf") | **Open** (`discrepancy-engine.js:879`: dots replaced before the `.pdf` strip) |
| `isIdentityClash` unused | **Open** (export only) |
| Email-derived names cause false identity clashes (live: "Mchen Yyc") | **FIXED** `15d30f3` |
| Exit strategy and completeness read the LLM summary | **Open**. The LLM LTV fallback is now labelled as an estimate (P2 `eb0b8d3`). |
| Comments calling some fields "display-only" are stale | **Open** (`canonical-fields.js:1733-1734, 1745`) |

**New issues found in this review:**
1. **Repeated Q10 notices.** The comparison is always against the last *prelim* snapshot, and nothing checks `_q10_admin_renotified_at`. Every later text-only reply on an `under_review` deal re-sends the same change notice until a new prelim goes out. A06's third email shows this offline; it was not confirmed live.
2. **Hedge guard covers the whole message.** Any "about", "around" or "maybe" anywhere in the email drops every correction in it.
3. **Corrections can come from narrative text.** A08's "adding mortgage refinance too" became a `transaction_type` correction.
4. **Q10 false positive from wording.** `loan_type` is compared as a string, so a position appearing for the first time in broker prose ("refinance" becoming "refinance / 1st") would count as a material change.
5. **`buildThreadFacts` skips three guards.** It calls `extractCanonicalFieldsAggregated` directly, without the commercial, identity-clash and joint-borrower guards that the prelim's `runDiscrepancyDetectionAggregated` applies. On joint-borrower deals, the snapshot facts can include existing-mortgage figures that the prelim clears.
6. **Stale comments.**
   - `webhook.js:1604-1605` still says "no clobber-prone snapshot".
   - The F8 balance block in `canonical-fields.js:1135` sits under a "Purpose correction patterns" comment.

## 10. Technical problems solved, with commits
- **Corrections lost to filters that prefer documents** → correction tuples outrank documents and survive the filters: `27ee664`, `eb0b8d3`.
- **Broker-asserted figures driving an irreversible decision** → the broker-only balance can escalate but never auto-decline: `27ee664`.
- **No persisted history of facts / Q10 comparing an LLM summary with scraped HTML** → code-built snapshots and a structured comparison: `d6ec8c7`.
- **First-email-only decline and incomplete-data gates** → follow-up gates on the whole thread; decline-only first email: `340d33b`.
- **False identity clashes from email addresses** → weak-evidence rule: `15d30f3`.
- **Thresholds scattered across files** → one config: `43d45a8`.
- **Unlabelled model LTV fallback** → estimate callout and "(est.)" subject: `eb0b8d3`.
- **Earlier history:** `4667b70`, `2944eeb`, `65aa30f`, `0188951`, `4ce2aec`, `4ad23f1`, `54c45e6`, `a5c032c`.

## 11. Open questions for counsel or engineering
1. Should Q10 compare against the last *notified* facts (prelim or Q10 notice) instead of the last prelim, to avoid repeated notices?
2. Should the over-80% follow-up escalation also move to the thread-wide map, to match the F3 decline gate?
3. Should `buildThreadFacts` reuse `runDiscrepancyDetectionAggregated` so that snapshots and the prelim never disagree?
4. For claims: is the snapshot store (an append-only log in a general messages table, flagged by a `system` direction, holding `{trigger, facts, map}`) described as "a persisted canonical fact history", while making clear that decisions are recomputed from source rather than read from it?
5. Should the corrected balance appear in the Snapshot even when the refinance carve-out makes it irrelevant to LTV?

---

**Summary of changes from the baseline**
1. The baseline's "never persisted" claim is replaced: P1 fact snapshots (`buildThreadFacts` / `recordFactSnapshot`, stored as `messages` rows with `direction='system'`) are documented with current line refs.
2. Q10 is rewritten for F9: it compares code-built facts with the prelim snapshot across five fields, and the HTML scrape is now only a fallback.
3. `parseBrokerCorrections` is documented with the F8 loan-amount phrasings and the new balance field, with a recognised / not-recognised table.
4. The F8 change to `filterCanonicalLenderForPayoutOnly` (broker balance corrections survive) and the `isCombinedLtvResolved` broker-only-balance rule are documented, with a demonstration (94% combined: declines on statement data, escalates only on a broker figure).
5. The identity-clash weak-evidence rule for email-derived names is added, with three demonstrations.
6. F3 thread-wide follow-up gates and the F4 decline-only first email are added; the single-email gap is narrowed but still open for over-80% escalation.
7. A06, A08 and A34 were re-run with production `pdf-parse`/`pdf-lib` text: 345k, 290k and 222,500 are now in the facts, and Q10 fires for each.
8. Every `file:line` reference was refreshed to HEAD `425715d`; the map is now 17 fields and a per-field precedence table was added.
9. The gap table marks six items FIXED or FIXED in part (with commits) and keeps the rest open.
10. Six new issues are recorded: repeated Q10 notices, the whole-message hedge guard, a correction read from narrative text, a `loan_type` string false positive, `buildThreadFacts` skipping three guards, and no balance row in the Snapshot for payout refinances.