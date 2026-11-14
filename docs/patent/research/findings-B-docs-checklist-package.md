I couldn't save the findings file: the write tool refused, saying subagents must return findings as text. So the full findings are below, starting with the summary. Nothing in the repo was changed. All paths are relative to `~/Undrwrite`, HEAD `edae488` (2026-06-22).

## Summary

**Key findings (for the attorney):**

- **There is no OCR.** No OCR library is installed or called; the only PDF libraries are pdf-parse 1.1.1 and pdf-lib. Scanned or short-text PDFs and photos are sent to Claude as base64 so the model reads them itself (`src/lib/pdf.js:66-86`).
  - Images never get stored text (`src/services/deals.js:433`, `:538-542`).
  - The prelim and lender-package writer, `generateLeadSummary`, reads only stored text (`src/services/ai.js:3970-3973`). So scanned documents and photos add nothing to those narratives except their filename and type.
  - This contradicts spec II.1, II.2 and III.2.
- **The "[File Complete] — Ready to Close" example PDF is not what current code produces.** It shows a generic "Income Proof (T4 / NOA)" row and no PEP row. Those are exactly the defects fixed in commit `85ea4cc` (deterministic checklist) and `b32774d` (completion switched to `generateLeadSummary` in `lenderPackage` mode), both committed after the PDF was generated. The attorney needs an example regenerated with current code.
- **The prelim PDF does match current code.** The banner, Deal Snapshot, "Documents Included" list, subject line and zip are built in plain code. Sections 2-8 are written by Claude, with prompt blocks pinning LTV, lender, and loan amount/purpose. One duplicate "[MISSING]" list written by Claude inside Deal Rating survives cleanup.
- **`ai.classifyImage` is dead code.** It has never been called anywhere in git history. Images that match no filename rule are simply classed as `government_id` (`deals.js:520`). Inline signature logos might therefore satisfy the ID requirement; I didn't verify this against live payloads.
- **Two gate inputs come from Claude.** Which document checklist applies depends on Claude's `is_purchase` field (`src/lib/dealType.js:38`). Completion also needs Claude's `exit_strategy` (`webhook.js:961`). Spec III.4 and V.5 ("gates don't consume LLM values") overstate the separation.
- **Reminders actually go out on consecutive nights**, not every 2 days. Silence is measured from the broker's last message, and the resend guard is only 20 hours. The "escalate to admin" after 4 reminders is only a listing in the daily summary; no email is sent. Admin replies, which are stored as inbound messages, reset the silence clock.
- **Concurrency locks:**
  - Reminders use a conditional UPDATE on `reminder_count`, rolled back if the send fails (`deals.js:289-317`; commit `78c84d2`).
  - The daily summary uses a unique Edmonton-date row (Postgres error 23505 means another worker won), a 21:00-only gate, and a `startCron()` factory that stopped test runs taking the production slot (commit `f97db21`).
- **pdf-parse fix:** pdf-parse corrupts its own global state on valid PDFs (about 37.5% of documents). The fix retries 3 times, reloading the module on retries, and records `extraction_failed` instead of storing silently empty text (`deals.js:7-20`, `:436-488`; commit `2f882f9`).
- **Stored record per document:** `file_name`, `file_type`, `storage_path`, `classification` (one of 24 classes), and `extracted_data`. `extracted_data` takes one of three shapes:
  - `{text}` — pdf-parse text plus any pdf-lib form-field/annotation text
  - `{text:null, extraction_failed, extraction_error, extraction_attempts}`
  - `null` — an image-only PDF or any non-PDF

  No structured fields are stored per document.

**Other inconsistencies:**
- Filename rules still have traps like the "Noah" one: "Pamela" matches `aml`, "Pepper" matches `pep`, `cv` matches anywhere, and "Corporate_Financial_Statements" becomes `financial_statement`.
- The daily-summary file keeps its own copies of the requirement lists instead of using `dealType.js`.
- A comment says purchase deals need down-payment proof; the purchase list doesn't include it.
- The comment at `webhook.js:1906-1910` still says completion uses `generateEscalationNotification`.
- The lender package's Deal Snapshot is written by Claude, unlike the prelim's.
- No length limit on document text sent to Claude, and no size limit on base64 PDFs.
- HEIC/HEIF, DOCX and XLSX are stored but never read by Claude.
- The manual `/cron/run-daily` trigger only sends reminders unless it runs at 21:00 Edmonton time.

## Full findings

The full findings follow, per module.

### Shared facts

- Libraries (`package.json:17-24`): `@anthropic-ai/sdk ^0.73.0`, `pdf-parse ^1.1.1`, `pdf-lib ^1.17.1`, `archiver ^7.0.1`, `node-cron ^4.2.1`.
- All Claude calls go through `callClaude` (`src/services/ai.js:38-52`). It retries only on HTTP 429, at most 3 attempts, waiting `min(30×attempt, 90)` seconds. Any other error is thrown immediately.
- The model is hard-coded as `claude-sonnet-4-6` at each call site. No temperature is set.
- `stripHtmlFence` (`ai.js:54-69`) removes a leaked ```html fence from every HTML email the model returns.

---

### Module 3 — Document intake and processing

**Purpose:** Store each attachment, extract its text, give it a type by fixed rules, and pass it to Claude in the cheapest form Claude can still read. Also catch link-only submissions and keep AML/PEP forms out of the deal analysis.

**Inputs:** Postmark attachment objects `{Name, Content (base64), ContentType}` from `webhook.js:2938` (referral), `:3220` (new deal) and `:3681` (existing deal), plus the email `textBody` for link detection.

**Processing:**

1. **Saving attachments — `saveAttachments` (`deals.js:619-632`).** Handles attachments one at a time. A failure is logged and that file is skipped; the rest still save. There is no file-type filter.
2. **`saveDocument` (`deals.js:419-549`):**
   - Decodes the base64 and cleans the filename: any character outside `[a-zA-Z0-9._-]` becomes `_`. Storage path is `${dealId}/${Date.now()}-${safeName}` (`:420-423`).
   - **PDFs only (`:433`):**
     - pdf-parse, up to 3 attempts. Attempt 1 uses the cached module; attempts 2 and 3 call `freshPdfParse()` (`:15-20`), which deletes every `require.cache` entry containing "pdf-parse" and loads it again. 50 ms pause between attempts. The loop stops at the first attempt that doesn't throw (`:445-463`).
     - pdf-lib `extractFormValues` runs separately; its errors are caught (`:465-469`).
     - `combined = (baseText + formText).trim()`. Three outcomes: text found; `extractionFailed` (empty text and pdf-parse still threw after 3 attempts); or genuinely empty (`:470-488`).
   - Non-PDF files get no text extraction.
   - Uploads the original bytes to Supabase Storage bucket `documents` with `upsert:false`. An upload error is thrown (`:492-499`).
   - Maps the MIME type to a short extension (`:503-516`).
   - Classifies with `classifyDocument` (`:519`). If the result is `other` and the file is an image, it becomes `government_id` (`:520-523`).
   - Inserts the `documents` row (`:526-545`).
3. **`extractFormValues` (`src/lib/pdfFormExtract.js:8-78`):**
   - `PDFDocument.load(buffer, {ignoreEncryption:true})`; returns `''` if loading fails.
   - Form fields: text fields give their text; checkboxes give "Yes"/"No"; radio groups, dropdowns and option lists give their selection. Each becomes a `name: value` line.
   - Per page, it reads each annotation's `/Contents` with `decodeText()` and writes `[Page N annotation] …`.
   - Returns `"\n\n=== Form fields and annotations (extracted via pdf-lib) ===\n…"`, or `''` if nothing was found.
4. **`buildContentBlocks` (`src/lib/pdf.js:29-92`).** Matches each attachment to its saved row by filename (`:34`). For PDFs:
   - Text of at least 200 characters (`MIN_TEXT_LENGTH`) that is not form-like → sent as a text block.
     - "Dual path": if the filename matches `/application|summary|appraisal/`, the PDF is also sent as base64. Exception: appraisals with 50,000 or more characters of text skip the base64 copy (`:46-58`).
   - Form-like text → base64 only (`:59-65`).
   - Otherwise (no text, under 200 characters, or failed extraction) → base64 only (`:66-73`).
   - Images: only png, jpeg, gif and webp become base64 image blocks (`:78-86`). Everything else is skipped (`:88`).
5. **`isFormLikeText` (`pdf.js:5-19`).**
   - No non-blank lines → form-like.
   - Otherwise form-like only if all three hold: more than 70% of lines are under 40 characters, there is no `$` amount (`/\$[\d,]+/`), and no line is longer than 120 characters.
6. **Compliance exclusion (`ai.js:24-35`).** Removes AML/PEP files before `buildContentBlocks` in `ai.js:2580`, `:2768` and `:4895`, and from the `generateLeadSummary` text (`:3970-3973`).
7. **`classifyDocument` — filename first, first match wins (`deals.js:90-145`):**

   | # | Filename pattern | Class |
   |---|---|---|
   | 1 | `application\|loan.?app` | loan_application |
   | 2 | `pnw\|personal.?net.?worth\|net.?worth` | pnw_statement |
   | 3 | `appraisal` | appraisal |
   | 4 | `credit.?(bureau\|report\|check\|score)\|\bcb\b\|beacon\|fico` | credit_report |
   | 5 | guarded `noa`, or `notice.?of.?assessment` | noa |
   | 6 | `aml\|anti.?money` | aml |
   | 7 | `pep\|politically.?exposed` | pep |
   | 8 | `intake\|checklist` | intake_form |
   | 9 | `passport\|driver.?licen\|license\|gov.*(id\|identification)` | government_id |
   | 10 | `income\|pay.?stub\|employment.?letter\|t4\|t1` | income_proof |
   | 11 | `bank.?statement\|financial.?statement` | financial_statement |
   | 12 | `title.?search\|title.?report` | title_search |
   | 13 | `insurance` | insurance |
   | 14 | `tax.?bill\|property.?tax` | property_tax |
   | 15 | `survey` | survey |
   | 16 | `environmental` | environmental |
   | 17 | `mortgage.?balance\|…` | mortgage_balance_statement |
   | 18 | `payout\|discharge\|mortgage.?statement\|current.?mortgage` | mortgage_statement; changed to mortgage_balance_statement if the text has a balance phrase but no payoff/penalty/interest-to-date/validity/discharge phrase (`:124-135`) |
   | 19 | `corporate.?financial\|corp.?financ` | corporate_financials |
   | 20 | `t1.?general\|tax.?return` | tax_return |
   | 21 | `resume\|cv\|experience` | borrower_resume |
   | 22 | `purchase.?contract\|…\|aps\b\|sale.?agreement` | purchase_contract |
   | 23 | `down.?payment\|deposit.?proof\|proof.?of.?down` | down_payment_proof |
   | — | no match | `classifyByContent` |

8. **`classifyByContent` — content rules in order (`deals.js:31-88`):**
   1. PNW (`:34`)
   2. Loan application, which also needs "loan amount" or "mortgage" (`:39`)
   3. Appraisal, structural markers only (`:45`)
   4. Credit report (`:46`)
   5. PNW / "personal statement of affairs" (`:55`)
   6. T4 / "statement of remuneration paid" / "box 14" → income_proof (`:68`)
   7. NOA (`:69`)
   8. Government ID markers (`:78`)
   9. AML / FINTRAC (`:79`)
   10. "Politically exposed person" → PEP (`:80`)
   11. Payout markers → mortgage_statement (`:81`)
   12. Balance phrases → mortgage_balance_statement (`:82`)
   13. Corporate financials, also needing a corporate suffix (`:83`)
   14. Tax return (`:84`)
   15. Resume (`:85`)
   16. Purchase contract (`:86`)
   17. Otherwise → other
9. **`detectClassificationMismatch` (`deals.js:167-188`).**
   - Returns null if the text is form-like, or if either the filename type or the content type is AML/PEP.
   - Flags `{fileName, fileClass, contentClass}` when the content type is specific and differs from the filename type.
   - The filename type is kept for all downstream use. The flag only drives a callout in the admin prelim (`webhook.js:1578-1584`, `ai.js:1118-1137`), tagged with a `data-marker` so re-renders don't duplicate it.
10. **`classifyImage` (`ai.js:3851-3890`).** Claude call, 50 max tokens. The reply is checked against an allowed list, and anything else, or any error, becomes `'other'`. It is never called.
11. **`detectFileHostingLinksInBody` (`src/lib/linkDetector.js:77-91`).**
    - Cuts the email at the signature delimiter `\n--\s*\n`.
    - Tests 10 patterns in order (`:37-75`): Dropbox ×2, Google Drive/Docs, OneDrive ×2, SharePoint, WeTransfer ×2, Box, iCloud Drive. Returns the first match. It never fetches the link.
    - Consumer (`webhook.js:3165-3214`): when there are zero attachments and a link is found, it sets `admin_controlled=true`, sends the broker a fixed acknowledgement, sends the admin a "Link-only submission" notice, and stops.

**Outputs:** A `documents` row `{deal_id, file_name, file_type, storage_path, classification, extracted_data}` (`deals.js:526-545`). `extracted_data` has one of the three shapes given in the summary.

**AI use:** None at classification time. Claude reads the documents through `buildContentBlocks` during intake and summary-update prompts.

**Errors and correction:** pdf-parse retry with module reload and `extraction_failed` flag. pdf-lib errors are swallowed. Upload or insert failures skip that file. Failed or empty extraction falls back to base64 so Claude can still read it. Mislabelled files get the mismatch callout.

**Technical problems solved:**
1. pdf-parse global-state corruption (`deals.js:7-14`, `:436-444`; commit `2f882f9`).
2. Filled AcroForms looking blank (`pdfFormExtract.js:3-6`; commit `e4f6b89`), on top of the form-like routing to base64.
3. Balance statement accepted as a payout statement (`deals.js:115-135`; commit `f318f29`).
4. Loan application title split across a line break, read as an appraisal (`deals.js:35-45`).
5. T4 read as NOA (`:56-69`; commit `625d3fb`).
6. Borrower name "Noah" matching `noa` (`:99-103`).
7. Government ID read as AML (`:70-79`, `:159-183`; commit `d65be32`).
8. PNW read as a balance statement (`:47-55`, `:168-176`).
9. Credit-named file that was really a PNW (`:147-158`; commit `3afdd45`).
10. AML/PEP form labels read as loan purpose (`ai.js:8-35`).
11. Link-only submissions (`linkDetector.js:1-35`; commit `86605a9`).

**Open questions:**
- No OCR; images and scanned PDFs add nothing to prelim text.
- Image → `government_id` default may catch inline logos.
- HEIC/HEIF/`image/jpg`/DOCX/DOC/XLSX are never read by Claude.
- Unguarded filename traps (`aml`, `pep`, `cv`, `application`, financial-statement ordering).
- The PNW rule appears twice (`:34` and `:55`).
- Matching saved rows by filename breaks for duplicate names.
- No size or page guard before sending base64 to Claude.

---

### Module 9 — Required-documents checklist and chase cadence

**Purpose:** Work out which documents are required and which are still missing, chase the broker with reminders that list them, and send the admin a daily summary without duplicates.

**Inputs:** `deals` rows (`status`, `extracted_data`, `reminder_count`, `intake_asked_items`, `prelim_approved_at`), document classifications, messages, and the env vars `REMINDER_TESTING_MODE` and `CRON_SECRET`.

**Processing:**

1. **`isPurchaseFromSummary` (`dealType.js:36-60`).**
   - Claude's `is_purchase` boolean wins if present (`:38`; prompt at `ai.js:345`, `:363-376`).
   - Otherwise it looks at the purpose text, with property nouns home/house/condo/townhouse/townhome/duplex/residential/property. It returns true for "<noun> purchase", "purchase of" + up to 4 words + noun, "purchase price", or "down payment"; else false.
2. **Requirement lists (`dealType.js:105-121`).**
   - Refinance: government_id, appraisal, property_tax, mortgage_statement, income_proof, credit_report.
   - Purchase: government_id, appraisal, property_tax, income_proof, credit_report, purchase_contract.
   - After approval: aml, pep. Completion requires both lists.
3. **Synonyms (`dealType.js:93-100`).** An NOA satisfies income_proof. A balance statement deliberately does **not** satisfy the payout-statement requirement.
4. **`computeMissingIntakeItems` (`dealType.js:150-155`).** Required minus satisfied, plus `exit_strategy` if empty. Used by `webhook.js:519`, `:1305`, `:3404` and `:3917`.
5. **Gates that use the checklist:**
   - AML/PEP are added to the broker document request only for a broker sender, and only if intake is complete or the deal is approved (`ai.js:3602-3611`).
   - `computeCompletionDispatch` (`webhook.js:956-964`) needs status `active`, no holds, every required document including AML/PEP, and an exit strategy. It returns "completion handoff" if approved, else "preliminary, all docs in".
   - `computeAdminBanner` (`webhook.js:1144-1172`), in order: clarification pending → PRELIMINARY — BROKER CLARIFICATION PENDING; anything missing → PRELIMINARY REVIEW; not yet approved → PRELIMINARY REVIEW; else COMPLETE.
6. **`intake_asked_items`.** A snapshot of what was asked at intake (`webhook.js:128ff`, stored at `:3459-3473`). Storing it is best-effort.
7. **`runFollowUpReminders` (`src/cron/dailySummary.js:51-304`).** Production settings: wait 2 days, 20-hour resend guard, cron `0 21 * * *`, maximum 4 reminders, timezone America/Edmonton. Testing mode uses 1 hour, 30 minutes and every 30 minutes.
   1. Picks deals in status active, awaiting_collateral or awaiting_identity_confirmation.
   2. Skips deals already at 4 reminders, with no inbound message, or with under 2 days since the last inbound.
   3. Skips if the last outbound message was under 20 hours ago.
   4. `claimReminderSlot`: a conditional UPDATE so only one worker can take each reminder number (`deals.js:289-299`).
   5. Builds the missing list from the intake snapshot, or from its own inline copies of the lists (`:116-146`).
   6. If nothing is missing, sends nothing, keeps the count, and logs it as suppressed (`:171-183`).
   7. Picks the greeting name in code (`:193-198`).
   8. Calls `generateFollowUpReminder` (`ai.js:3781-3848`): Claude, 512 max tokens. The prompt has the list of display names in bullets, a tone that grows firmer from reminder 1 to 4 and never says the file is closing, banned openers, and "Franco is never the recipient".
   9. Threads only on broker-facing messages, with `@mtasv.net` added to message IDs (`:232-264`).
   10. Sends and saves. If the send fails, `releaseReminderSlot` rolls the count back, but only if no other worker has changed it (`:291-298`, `deals.js:307-317`).
   11. Any broker reply to an existing deal resets `reminder_count` to 0 (`webhook.js:3671-3675`).
8. **`runDailySummary` (`dailySummary.js:413-558`).**
   1. Sends reminders first.
   2. Continues only if Edmonton time is exactly 21:00 (`:340-347`).
   3. `claimDailySummarySlot` inserts a row keyed by the Edmonton date, which is unique; error 23505 means another worker already sent it (`deals.js:711-726`; migration `2026-05-21-daily-summaries.sql`).
   4. Excludes admin replies from "emails received" (`:468-470`).
   5. Puts each deal in exactly one section, in priority order: escalated → stale (3+ days) → at max reminders → other (`:391-411`).
   6. `generateDailySummary` (`ai.js:5168-5221`): Claude, 8192 max tokens, fixed 6 sections; code strips fences and html/head/body/doctype tags.
   7. Sends to the admin and records sent or failed (`deals.js:730-745`).
9. **Scheduling and manual trigger.** `startCron` (`:603-617`) registers the job once and is called from `src/index.js` after the server starts. `POST /cron/run-daily` (`src/routes/cron.js:10-27`) needs the `X-Cron-Secret` header: 500 if no secret is configured, 403 if it doesn't match, otherwise 202 and then it runs.

**Outputs:** Reminder emails, the updated `reminder_count`, the daily summary email, a `daily_summaries` row, and missing-item lists.

**AI use:** The two Claude calls write prose only. Who gets a reminder, what is listed, the reminder number, the threading and the summary sections are all decided in code. Claude's `is_purchase` and `exit_strategy` drive the checklist. Nothing checks afterwards that the reminder actually listed every item.

**Errors and correction:** Atomic claim with rollback, the 20-hour guard, per-deal try/catch, summary rows that stay "pending" if a worker crashes, and an outer catch that logs.

**Technical problems solved:**
1. Nine duplicate reminders sent at 9 PM (commit `78c84d2`).
2. Duplicate daily summaries (commit `5ebf2be`).
3. Two summaries 30 minutes apart in testing mode (`:332-347`).
4. Test runs taking the production slot (commit `f97db21`).
5. Wrong date in the header (UTC instead of Edmonton) (`:38-48`).
6. Reminders listing items Vienna never asked for (`:127-146`).
7. Brokers chased while only admin approval was outstanding (`:148-183`).
8. Broken reminder threads (`:207-264`).
9. "Equipment purchase" read as a property purchase (`dealType.js:1-29`).
10. Broker reply and admin prelim disagreeing on what was missing (commit `625d3fb`).
11. AML/PEP requested too early (`dealType.js:62-89`).
12. Daily summary cut off at about one row (`ai.js:5172-5175`).

**Open questions:**
- Effective cadence is nightly once 2 days have passed.
- No escalation email after 4 reminders.
- Admin replies reset the silence clock.
- Deals with no inbound message are never chased.
- Duplicate requirement lists in the daily-summary file, with an outdated TODO (`:122-123`).
- Down-payment comment at `webhook.js:1292-1294` doesn't match the purchase list.
- The manual trigger only sends reminders outside 21:00.

---

### Module 12 — Deal-package assembly

**Prelim (`sendPreliminaryReviewToAdmin`, `webhook.js:1285-1646`):**

1. Loads documents and classifications and computes `missingDocs` (`:1288-1309`).
2. Labels messages so admin replies show as from the admin (`:1316`).
3. Builds the canonical map with four source filters (`:1333-1373`), then roster, corporate and registered-owner checks (`:1374-1416`), then the code-built Deal Snapshot via `renderDealSnapshot` (`:1417-1426`).
4. Computes the LTV, lender and broker-correction overrides (`:1434-1456`) and cleans loan-application text (`:1474`).
5. Calls `generateLeadSummary` with `noSnapshot` (`ai.js:3926-4277`): Claude, 4096 max tokens. The override blocks come first (`:3993-4107`). Then sections 2-8, with purpose quoted verbatim from `dealSummary.purpose` and Deal Rating as GREAT / OKAY / WEAK BUT WORKABLE; section 9; an internal-only separator; section 10 (the email conversation); and an APPROVED/DECLINE block. Rules: no tables, flag each discrepancy separately with a 10% allowance for hedged estimates, always flag purpose mismatches. Only non-compliance document text and the messages are sent.
6. Cleans up Claude's output in this order:
   1. strip any closing sign-off
   2. strip any Claude snapshot and put the code-built Snapshot first
   3. callouts for 75-80% LTV, conflicting postal codes, lender mismatch, and filename/content mismatch
   4. remove every "Documents Included" block Claude wrote (pattern with the global flag) and insert the code-built one before the first `<hr>` (`ai.js:1257-1336`)
   5. enforce the banner (`ai.js:2334-2352`)
7. Attaches `<Borrower>_Documents.zip` (`:1598-1607`).
8. Subject `ACTION REQUIRED: <status> Review — <borrower> — <canonical LTV>% LTV`. Sends, saves, and sets status to `under_review`.

**Completion (`sendCompletionHandoff`, `webhook.js:1827-2038`; triggered from `:3982` and `:4636`):**

1. Builds `<Borrower>_Complete_Documents.zip` with every document, AML/PEP included. A failure is caught and the flow continues without it (`:1864-1884`).
2. `buildCompletionLenderPackage` (`:1777-1825`) recomputes the same overrides and calls `generateLeadSummary` with `lenderPackage:true`. That mode:
   - has no internal sections
   - starts with "FILE STATUS: COMPLETE — Ready to Close"
   - ends with a "Submitting Broker" section taken from the broker's signature, with "don't invent" instructions (`ai.js:4262`)
   - **does not use `noSnapshot`, so Claude writes the Snapshot here**
   - is followed by `buildLenderPackageChecklist` (`ai.js:95-118`)

   The checklist always has 10 rows: Loan Application; Credit Bureau; an income row labelled from the actual file by `labelIncomeDocument` (`:75-86`), e.g. "T4 (2025)"; Appraisal; PNW; Mortgage Payout (payout or balance statement); Property Tax; Government ID; AML; PEP. Each row says Received with the filename, or Not on file. A package failure is caught (`:1911-1919`).
3. Admin notice: `[File Complete] <borrower> — Ready to Close` (or `[Conditions Fulfilled]`). Fixed lead text, then the package, with the zip attached (`:1890-1928`).
4. Waits 2 seconds.
5. Broker closing: `generateCompletionEmail` (`ai.js:3369-3385`) is a fixed template with no Claude call: "The file is now complete and submitted…". It still passes through the cleanup checks, is threaded into the broker's conversation, and has no attachments.
6. Sets status to `completed`.

**Zip — `downloadDocsAsZip` (`deals.js:576-616`):** archiver at compression level 5, built in memory. Each file is downloaded from storage and added under its original filename; failed downloads are skipped. Returns base64.

**`composeBrokerLenderPackageEmail` (`ai.js:1212-1240`):** retained but abandoned. It assumed the broker would forward a package to lenders, but PML does the lender outreach (`ai.js:1142-1153`).

**Prelim PDF mapped to the code:**

| PDF piece | Produced by | Code or Claude |
|---|---|---|
| Subject line | `webhook.js:1633` | Code |
| Banner | `computeAdminBanner` (`webhook.js:1149`) + `enforceReviewBanner` | Code |
| Deal Snapshot, including "(computed)" and "TBD" | `discrepancy-engine.js:746`, `:790`, `:846` | Code |
| Sections 2-8 | `generateLeadSummary` | Claude |
| "Outstanding [MISSING]" list in Deal Rating | Claude's own text, not removed by cleanup | Claude |
| Documents Included | `renderDocumentsIncludedSection` | Code |
| Email conversation | Claude renders the labels code supplied | Claude, code labels |
| Zip attachment | `webhook.js:1598-1607` + `deals.js:576-616` | Code |

**File Complete PDF mapped to the code:** produced by the old completion path, not current code (commits `85ea4cc` and `b32774d` came after it). These pieces still match current code:
- the lead lines (`webhook.js:1895`, `:1904`)
- the "copy and paste" header (`:1915`)
- the zip name (`:1870`)
- the Submitting Broker section (now required by the prompt)

**Technical problems solved:**
1. Claude dropping documents from the list (commit `a232454`).
2. "Documents Included" appearing two or three times (commit `d407074`).
3. COMPLETE banner on the first review (`webhook.js:1120-1172`).
4. Subject LTV disagreeing with the Snapshot (`:1625-1632`).
5. Wrong current lender ("Scotiabank") (`ai.js:4024-4045`).
6. Broker's correction overridden by document values (`:4047-4107`).
7. Generic income label and missing PEP row (commit `85ea4cc`).
8. Completion package too thin (commit `b32774d`).
9. Broker package based on the wrong workflow (`webhook.js:1972-1984`).
10. Broker sign-off leaking into admin documents (`:1489-1496`).
11. Tables breaking when pasted into lender emails (`ai.js:4123`).

**Open questions:**
- Out-of-date comment at `webhook.js:1906-1910`.
- Claude writes the lender-package Snapshot.
- AML/PEP and all stored files go into the zip.
- No limit on document text length.
- The leftover "[MISSING]" list Claude writes can disagree with the code-built one.
- The checklist counts a balance statement as the payout statement, though the completion gate requires a real one.
- The example PDF is outdated.

---

### Spec claims (sections II, III, V) contradicted by the code

1. **II.1** says text is extracted "from PDFs and images". Only PDFs get text extraction (`deals.js:433`).
2. **II.2** says "PDF text / OCR". There is no OCR.
3. **III.2** says "OCR for image attachments and scanned documents". There is no OCR; the model reads them directly, nothing is stored, and the lead summary ignores them.
4. **III.2** describes classification without the actual method: filename-first rules, the image → government_id default, the flag-only cross-check, the 24 classes, the payout/balance split and the AML/PEP exclusion.
5. **III.1 / II.2** never mention the link-only handoff branch (`webhook.js:3165-3214`).
6. **III.4** says gates don't use model-derived numbers. True, but the checklist and completion gates use model-derived `is_purchase` and `exit_strategy`.
7. **III.6** says the figures and structure are canonical, not model-derived. Overstated:
   - several outbound emails are fixed code templates, not Claude
   - sections 2-8 figures such as net worth and credit scores are derived by the model
   - the lender-package Snapshot is written by Claude
   - the spec omits the code-built pieces that actually carry the weight
8. **III.6** leaves out reminders, the daily summary and the File Complete package.
9. **V.1** leaves out `pdf.js`, `pdfFormExtract.js`, `linkDetector.js`, `dealType.js`, `dailySummary.js`, `cron.js`, and `deals.js`'s classification, zip and locking. Its "document interpretation" refers in part to `classifyImage`, which is never called.
10. **V.5** says AI is confined to interpretation and narrative. Partly contradicted (see item 6). It also omits the concrete error handling: pdf-parse retry, 429-only retry for Claude, catch-and-continue for zip and package, and the atomic claims with rollback.
11. **V.4**'s "waits for state to stabilize" doesn't appear anywhere in these modules. The only delay is the fixed 2 seconds before the broker closing email, which controls delivery order. Another module owner should verify the claim.