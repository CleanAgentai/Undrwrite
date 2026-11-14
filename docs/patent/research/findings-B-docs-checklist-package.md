# Findings B (refreshed): document intake, checklist and chase cadence, deal-package assembly

I couldn't write to the repo because this was a read-only task, so the full updated findings are below. No files were changed. All paths are relative to `~/Undrwrite`, at HEAD `425715d` (2026-11-14). The baseline was written against `edae488` (2026-06-22). I read every commit in `edae488..HEAD` (25 commits). Of these, `4313090` (F11/F12), `4495b7e` (F10/F14), `eb0b8d3` (P2/P3), `32bc746` (banner regex), `d6ec8c7` (P1/F9), `000df09`/`5bfcdd6` (Resend adapter and inbound dedup), `43d45a8` (P4 thresholds) and `9a68074` (intake teardown) touch these modules. The rest are test tooling, or changes outside this scope that I checked and found irrelevant.

## Summary

**Key findings (for the attorney):**

- **There is still no OCR.** No OCR library is installed or called (`package.json:16-26`: only pdf-parse 1.1.1 and pdf-lib). Scanned or short-text PDFs and photos are sent to Claude as base64 so the model reads them itself (`src/lib/pdf.js:66-86`).
  - Images never get stored text (`src/services/deals.js:465`, `:567-575`).
  - The prelim and lender-package writer, `generateLeadSummary`, reads only stored text (`src/services/ai.js:3924-3927`). So scanned documents and photos add nothing to those narratives except their filename and type.
- **`classifyImage` no longer exists.** It was removed in F11 (`4313090`) together with `updateDealSummary`, `generateInfoRequestEmail` and `generateDocReviewNotification`, none of which had callers.
  - Images that match no filename rule are still classed as `government_id` in plain code (`deals.js:551-555`).
  - `buildContentBlocks` now has only two callers: `ai.js:2634` (intake) and `:2822` (broker reply). The third one was inside the removed `updateDealSummary`.
- **The lender package's Deal Snapshot is now built in code (F14, `4495b7e`).**
  - `buildReviewSnapshotParts` (`src/routes/webhook.js:1742-1801`) builds the qualification roster (Q3/Q4/Q11), corporate detection (Q5) and `renderDealSnapshot` once, for both the prelim and `buildCompletionLenderPackage`.
  - The package now calls `generateLeadSummary` with `noSnapshot:true` and puts the code-built Snapshot in front of Claude's text (`webhook.js:1836-1855`).
  - The baseline's "Claude writes the lender-package Snapshot" is no longer true.
- **The lender checklist now follows the completion rules (F10, `4495b7e`).**
  - A balance statement no longer ticks "Mortgage Payout Statement". It is shown as "✗ Not on file (balance statement received: …; a payout statement is still required)".
  - Purchases show a "Purchase Contract" row instead of the payout row. `isPurchase` comes from `isPurchaseFromSummary(dealSummary)` (`ai.js:98-127`, `:4226`).
- **When the LTV is an estimate, the prelim now says so (P2, `eb0b8d3`).** If code cannot compute the LTV from the deal's facts, the prelim gets an "LTV is an estimate" callout and a `~X% LTV (est.)` subject (`webhook.js:1485-1488`, `:1591-1593`; `ai.js:977-987`). The gates' fallback to the model's LTV is also logged (`webhook.js:3765`, `:4735`).
- **Banner enforcement no longer deletes the Snapshot (`32bc746`).** `REVIEW_BANNER_PARAGRAPH_RE` used to start matching at the first `<p>` in the summary. When Claude's FILE STATUS line came after the code-built Snapshot, it deleted every Snapshot row and callout in between. It now matches a single paragraph (`ai.js:2384`).
- **Escalation after 4 reminders now exists (P3, `eb0b8d3`).** `sendStalledAlertOnce` (`src/cron/dailySummary.js:55-71`) sends one `[Stalled]` admin email per deal when the reminder cap is reached, and saves it with its Message-ID.
  - The once-per-deal check is check-then-send, with no database claim.
  - The alert's Message-ID is not filtered out of broker threading (see Module 9 open questions).
- **Fact snapshots are recorded at prelim (P1, `d6ec8c7`).**
  - `recordFactSnapshot(deal,'prelim')` runs after the prelim is sent (`webhook.js:1602`). It is also recorded at intake (`:3693`) and when an inbound email changes the facts (`:4285`, `:4316`, `:4751`).
  - Storage is `messages` rows with `direction:'system'` (`deals.js:338-350`). These rows are kept out of conversation queries (`deals.js:396`, `:719`).
  - Caveat: the snapshot is rebuilt with `extractCanonicalFieldsAggregated` (`webhook.js:2234-2261`), not the prelim's `runDiscrepancyDetectionAggregated`. On commercial or identity-clash deals the prelim Snapshot shows an empty map (TBD rows), while the "prelim" snapshot records extracted values. So it is not strictly "the facts the admin reviewed".
- **Two gate inputs still come from Claude.** Claude's `is_purchase` picks the checklist (`src/lib/dealType.js:38`), and the lender checklist rows now depend on it too. Completion also needs Claude's `exit_strategy` (`webhook.js:964`).
- **Inbound attachments can now arrive from Resend as well as Postmark (`000df09`).** `src/lib/resendInbound.js:82-88` downloads each attachment and rebuilds the same `{Name, Content, ContentType}` shape. Duplicate webhook deliveries are dropped before any attachment is saved (`webhook.js:2371`; `5bfcdd6`).

**Baseline issues still open:**
- Filename traps:
  - "Pamela" matches `aml`, "Pepper" matches `pep`, and `cv` matches anywhere.
  - "Corporate_Financial_Statements" becomes `financial_statement`.
- The daily-summary file still has its own copies of the requirement lists.
- The down-payment comment (`webhook.js:1295-1297`) still doesn't match the purchase list.
- No length limit on document text sent to Claude, and no size limit on base64 PDFs.
- HEIC/HEIF, DOCX and XLSX are stored but never read by Claude.
- Reminders still go out nightly once 2 days have passed, and admin replies still reset the silence clock.
- The manual trigger only sends reminders unless it runs at 21:00 Edmonton time.

**New stale comments:**
- `webhook.js:1729-1736` still says the roster/Snapshot machinery "is NOT replicated" in the lender package, which F14 contradicts.
- `ai.js:59` still mentions the removed `generateDocReviewNotification`.

## Full findings

The full findings follow, per module.

### Shared facts

- Libraries (`package.json:17-25`): `@anthropic-ai/sdk ^0.73.0`, `pdf-parse ^1.1.1`, `pdf-lib ^1.17.1`, `archiver ^7.0.1`, `node-cron ^4.2.1`, `postmark ^4.0.5`.
  - Resend is reached with plain `fetch` (`src/lib/mailer.js`, `src/lib/resendInbound.js`); there is no Resend package.
  - Unchanged since baseline.
- All Claude calls go through `callClaude` (`ai.js:38-52`). It retries only on HTTP 429, at most 3 attempts, waiting `min(30×attempt, 90)` seconds. Any other error is thrown immediately.
- The model is hard-coded as `claude-sonnet-4-6` at each call site. No temperature is set.
- `stripHtmlFence` (`ai.js:60-69`) removes a leaked code fence from every HTML email the model returns.
- Outbound mail goes through `mailer.send` (provider chosen by `EMAIL_PROVIDER`, Postmark by default; `src/services/email.js:84-93`; `000df09`).
- Thread headers use `mailer.messageIdHeader` instead of a hard-coded `@mtasv.net` suffix (`dailySummary.js:279`, `webhook.js:2041`).
- LTV thresholds of 80 (escalate), 90 (auto-decline) and 75 (elevated band) now live in `src/config/thresholds.js`. Every gate, band and message reads them (`43d45a8`); the values are unchanged.

---

### Module 3 — Document intake and processing

**Purpose:** Store each attachment, extract its text, give it a type by fixed rules, and pass it to Claude in the cheapest form Claude can still read. Also catch link-only submissions and keep AML/PEP forms out of the deal analysis.

**Inputs:**
- Attachment objects `{Name, Content (base64), ContentType}` from `emailService.parseInboundEmail` (`src/services/email.js:145-162`, `attachments: payload.Attachments || []`). They come from either:
  - Postmark: `POST /webhook/inbound`, with optional Basic auth `INBOUND_WEBHOOK_AUTH` (`webhook.js:5013-5025`; `5bfcdd6`)
  - Resend: `POST /webhook/resend` (`webhook.js:5030`). The adapter fetches each attachment's `download_url` and passes Resend's `content_type` through unchanged (`resendInbound.js:82-88`).
- Saved at `webhook.js:3168` (admin referral), `:3455` (new deal) and `:3927` (existing deal).
- The email `textBody` is used for link detection.
- An inbound email whose Message-ID is already stored is dropped before processing, so its attachments are not saved twice (`webhook.js:2371`, `deals.js:354-364`; `5bfcdd6`).

**Processing:**

1. **Saving attachments — `saveAttachments` (`deals.js:651-664`).** Handles attachments one at a time. A failure is logged and that file is skipped; the rest still save. There is no file-type filter.
2. **`saveDocument` (`deals.js:451-583`):**
   - Decodes the base64 and cleans the filename: any character outside `[a-zA-Z0-9._-]` becomes `_`. Storage path is `${dealId}/${Date.now()}-${safeName}` (`:452-455`).
   - **PDFs only.** The test is an exact match on ContentType `application/pdf` (`:465`).
     - pdf-parse, up to 3 attempts. Attempt 1 uses the cached module; attempts 2 and 3 call `freshPdfParse()` (`:15-20`), which deletes every `require.cache` entry containing "pdf-parse" and loads it again. 50 ms pause between attempts. The loop stops at the first attempt that doesn't throw (`:477-495`).
     - pdf-lib `extractFormValues` runs separately; its errors are caught (`:496-501`).
     - `combined = (baseText + formText).trim()`. Three outcomes: text found; `extractionFailed` (empty text and pdf-parse still threw after 3 attempts); or genuinely empty (`:502-520`).
   - Non-PDF files get no text extraction.
   - Uploads the original bytes to Supabase Storage bucket `documents` with `upsert:false`. An upload error is thrown (`:524-532`).
   - Maps the MIME type to a short extension (`:535-548`).
   - Classifies with `classifyDocument`. If the result is `other` and the file is in `IMAGE_TYPES` (jpeg, jpg, png, gif, webp, heic, heif; `:22`), it becomes `government_id` (`:551-555`).
   - Inserts the `documents` row (`:558-579`).
3. **`extractFormValues` (`src/lib/pdfFormExtract.js`, unchanged).**
   - `PDFDocument.load(buffer, {ignoreEncryption:true})`; returns `''` if loading fails.
   - Form fields: text fields give their text; checkboxes give "Yes"/"No"; radio groups, dropdowns and option lists give their selection. Each becomes a `name: value` line.
   - Per page, it reads each annotation's `/Contents` with `decodeText()` and writes `[Page N annotation] …`.
   - Returns `"\n\n=== Form fields and annotations (extracted via pdf-lib) ===\n…"`, or `''` if nothing was found.
4. **`buildContentBlocks` (`pdf.js:29-92`, unchanged).** Matches each attachment to its saved row by filename (`:34`). For PDFs:
   - Text of at least 200 characters (`MIN_TEXT_LENGTH`, `:1`) that is not form-like → sent as a text block.
     - "Dual path": if the filename matches `/application|summary|appraisal/` (`:22-25`), the PDF is also sent as base64. Exception: appraisals with 50,000 or more characters of text skip the base64 copy (`:45-58`).
   - Form-like text → base64 only (`:59-65`).
   - Otherwise (no text, under 200 characters, or failed extraction) → base64 only (`:66-73`).
   - Images: only png, jpeg, gif and webp become base64 image blocks (`:78-86`). Everything else is skipped (`:88`).
5. **`isFormLikeText` (`pdf.js:5-19`).**
   - No non-blank lines → form-like.
   - Otherwise form-like only if all three hold: more than 70% of lines are under 40 characters, there is no `$` amount (`/\$[\d,]+/`), and no line is longer than 120 characters.
6. **Compliance exclusion (`ai.js:24-35`).** `excludeComplianceForSubstantive` removes AML/PEP files before `buildContentBlocks` at its two callers (`ai.js:2634`, `:2822`), and from the filename note (`:2641`). `generateLeadSummary` filters them out of its text (`ai.js:3924-3927`).
7. **`classifyDocument` — filename first, first match wins (`deals.js:90-145`, unchanged):**

   | # | Filename pattern (line) | Class |
   |---|---|---|
   | 1 | `application\|loan.?app` (`:95`) | loan_application |
   | 2 | `pnw\|personal.?net.?worth\|net.?worth` (`:96`) | pnw_statement |
   | 3 | `appraisal` (`:97`) | appraisal |
   | 4 | `credit.?bureau\|credit.?report\|credit.?check\|credit.?score\|\bcb\b\|beacon\|fico` (`:98`) | credit_report |
   | 5 | guarded `noa` `(?:^\|[^a-z])noa(?![a-z])`, or `notice.?of.?assessment` (`:103`) | noa |
   | 6 | `aml\|anti.?money` (`:104`) | aml |
   | 7 | `pep\|politically.?exposed` (`:105`) | pep |
   | 8 | `intake\|checklist\|borrower.?intake` (`:106`) | intake_form |
   | 9 | `passport\|driver.?licen\|license\|gov.*(id\|identification)` (`:107`) | government_id |
   | 10 | `income\|pay.?stub\|employment.?letter\|t4\|t1` (`:108`) | income_proof |
   | 11 | `bank.?statement\|financial.?statement` (`:109`) | financial_statement |
   | 12 | `title.?search\|title.?report` (`:110`) | title_search |
   | 13 | `insurance` (`:111`) | insurance |
   | 14 | `tax.?bill\|property.?tax` (`:112`) | property_tax |
   | 15 | `survey` (`:113`) | survey |
   | 16 | `environmental` (`:114`) | environmental |
   | 17 | `mortgage.?balance\|balance.?statement.*mortgage\|current.?balance.*mortgage` (`:123`) | mortgage_balance_statement |
   | 18 | `payout.?statement\|payout.?letter\|mortgage.?payout\|discharge.?statement\|mortgage.?discharge\|mortgage.?statement\|current.?mortgage` (`:124`) | mortgage_statement; changed to mortgage_balance_statement if the text has a balance phrase but no payoff/penalty/interest-to-date/validity/discharge phrase (`:129-133`) |
   | 19 | `corporate.?financial\|corp.?financ` (`:136`) | corporate_financials |
   | 20 | `t1.?general\|tax.?return` (`:137`) | tax_return |
   | 21 | `resume\|cv\|experience` (`:138`) | borrower_resume |
   | 22 | `purchase.?contract\|purchase.?agreement\|agreement.?of.?purchase\|aps\b\|sale.?agreement` (`:139`) | purchase_contract |
   | 23 | `down.?payment\|deposit.?proof\|proof.?of.?down` (`:140`) | down_payment_proof |
   | — | no match | `classifyByContent` (`:144`) |

8. **`classifyByContent` — content rules in order (`deals.js:31-88`, unchanged):**
   1. PNW (`:34`)
   2. Loan application, which also needs "loan amount" or "mortgage" (`:39`)
   3. Appraisal, structural markers only (`:45`)
   4. Credit report (`:46`)
   5. PNW / "personal statement of affairs" (`:55`)
   6. T4 / "statement of remuneration paid" / box 14 → income_proof (`:68`)
   7. NOA (`:69`)
   8. Government ID markers (`:78`)
   9. AML / FINTRAC (`:79`)
   10. PEP (`:80`)
   11. Payout markers → mortgage_statement (`:81`)
   12. Balance phrases → mortgage_balance_statement (`:82`)
   13. Corporate financials, also needing a corporate suffix (`:83`)
   14. Tax return (`:84`)
   15. Resume (`:85`)
   16. Purchase contract (`:86`)
   17. Otherwise → other (`:87`)
9. **`detectClassificationMismatch` (`deals.js:167-188`).**
   - Returns null if the text is form-like, or if either the filename type or the content type is AML/PEP.
   - Flags `{fileName, fileClass, contentClass}` when the content type is specific and differs from the filename type.
   - The filename type is kept for all downstream use. The flag only drives a callout in the admin prelim (`webhook.js:1533-1542`, `ai.js:1162-1200`), tagged with a `data-marker` so re-renders don't duplicate it.
10. **No model-based image classification.** `classifyImage` was deleted in F11 (`4313090`; the export of `DOC_DISPLAY_NAMES` was briefly lost in that removal and restored in the same commit). Image classes come only from filename rules, content rules (always `other` for images, since they have no text) and the image → `government_id` default.
11. **`detectFileHostingLinksInBody` (`src/lib/linkDetector.js:77-91`, unchanged).**
    - Cuts the email at the signature delimiter `\n--\s*\n`.
    - Tests 10 patterns in order (`:37-75`): Dropbox ×2, Google Drive/Docs, OneDrive ×2, SharePoint, WeTransfer ×2, Box, iCloud Drive. Returns the first match. It never fetches the link.
    - Consumer (`webhook.js:3399-3449`): when there are zero attachments and a link is found, it sets `admin_controlled=true`, sends the broker a fixed acknowledgement, sends the admin an "ACTION REQUIRED: Link-only submission" notice, and returns.
    - Both outbound emails are now saved with their Message-IDs, so replies thread back to the deal (`:3424`, `:3445`; F6, `fff4237`).

**Outputs:** A `documents` row `{deal_id, file_name, file_type, storage_path, classification, extracted_data}` (`deals.js:558-579`). `extracted_data` takes one of three shapes:
- `{text}` — pdf-parse text plus any pdf-lib form-field/annotation text
- `{text:null, extraction_failed:true, extraction_error, extraction_attempts}`
- `null` — an image-only PDF or any non-PDF

No structured fields are stored per document.

**AI use:** None at classification time; the only model-based classifier was removed. Claude reads the documents through `buildContentBlocks` during intake (`processInitialEmail`) and broker-reply (`generateBrokerResponse`) prompts.

**Errors and correction:**
- pdf-parse retry with module reload, and the `extraction_failed` flag.
- pdf-lib errors are swallowed.
- Upload or insert failures skip that file.
- Failed or empty extraction falls back to base64 so Claude can still read it.
- Mislabelled files get the mismatch callout.
- Duplicate inbound deliveries are dropped (`5bfcdd6`).
- If new-client intake fails, `deleteDeal` (`deals.js:685-710`) removes stored files and document rows, unless the welcome email has already gone out. In that case the deal and its documents are kept and the admin is alerted (`webhook.js:3875-3900`; `9a68074`).

**Technical problems solved:**
1. pdf-parse global-state corruption on valid PDFs, about 37.5% of documents (`deals.js:7-20`, `:466-520`; `2f882f9`).
2. Filled AcroForms looking blank (`pdfFormExtract.js`; `e4f6b89`), on top of the form-like routing to base64.
3. Balance statement accepted as a payout statement (`deals.js:115-135`; `f318f29`).
4. Loan application title split across a line break, read as an appraisal (`deals.js:35-45`).
5. T4 read as NOA (`:56-69`; `625d3fb`).
6. Borrower name "Noah" matching `noa` (`:99-103`).
7. Government ID read as AML (`:70-79`, `:159-183`; `d65be32`).
8. PNW read as a balance statement (`:47-55`, `:168-176`).
9. Credit-named file that was really a PNW (`:147-158`; `3afdd45`).
10. AML/PEP form labels read as loan purpose (`ai.js:8-35`).
11. Link-only submissions (`linkDetector.js`; `86605a9`), with replies now threaded back (`fff4237`).
12. *New:* the same inbound email processed and saved twice on webhook re-delivery (`5bfcdd6`).
13. *New:* a failed intake deleting the documents of a broker who had already been welcomed (`9a68074`).
14. *New:* dead model-based image classifier removed (`4313090`).

**Open questions:**
- **Still open:** no OCR; images and scanned PDFs add nothing to the prelim or lender-package text.
- **Still open:** the image → `government_id` default may catch inline logos or signature images.
- **Still open:** HEIC/HEIF, `image/jpg`, DOC/DOCX and XLSX are stored but never sent to Claude (`pdf.js:78`, `:88`).
- **Still open:** unguarded filename traps (`aml`, `pep`, `cv`, `application`, financial-statement ordering).
- **Still open:** the PNW rule appears twice (`deals.js:34` and `:55`).
- **Still open:** matching saved rows by filename (`pdf.js:34`) breaks for duplicate names.
- **Still open:** no size or page guard before sending base64 to Claude, and no length limit on document text.
- **Resolved in code:** `classifyImage` is dead code — removed in `4313090`.
- **New:** PDF detection is an exact match on `application/pdf` (`deals.js:465`, `pdf.js:37`). The Resend adapter passes the provider's `content_type` through unchanged. A PDF labelled `application/octet-stream` would get no text extraction and would be skipped by `buildContentBlocks`. I didn't verify what Resend actually sends.

---

### Module 9 — Required-documents checklist and chase cadence

**Purpose:** Work out which documents are required and which are still missing, chase the broker with reminders that list them, alert the admin once the chase is exhausted, and send the admin a daily summary without duplicates.

**Inputs:**
- `deals` rows: `status`, `extracted_data`, `reminder_count`, `intake_asked_items`, `prelim_approved_at`, `email`
- document classifications
- messages (system fact-snapshot rows are excluded from `getMessages`, `deals.js:396`, and from `getRecentMessages`, `:719`)
- the env vars `REMINDER_TESTING_MODE` and `CRON_SECRET`

**Processing:**

1. **`isPurchaseFromSummary` (`dealType.js:36-60`, unchanged).**
   - Claude's `is_purchase` boolean wins if present (`:38`; prompt at `ai.js:356`, `:374-388`).
   - Otherwise it looks at the purpose text, with property nouns home/house/condo/townhouse/townhome/duplex/residential/property (`:34`). It returns true for "<noun> purchase", "purchase of" + up to 4 words + noun, "purchase price", or "down payment"; else false.
2. **Requirement lists (`dealType.js:105-121`, unchanged).**
   - Refinance: government_id, appraisal, property_tax, mortgage_statement, income_proof, credit_report.
   - Purchase: government_id, appraisal, property_tax, income_proof, credit_report, purchase_contract.
   - After approval: aml, pep (`:113`). Completion requires both lists (`:118-121`).
3. **Synonyms (`dealType.js:93-100`).** An NOA satisfies income_proof. A balance statement deliberately does **not** satisfy the payout-statement requirement.
4. **`computeMissingIntakeItems` (`dealType.js:150-155`).** Required minus satisfied, plus `exit_strategy` if empty. Used at `webhook.js:522`, `:1308`, `:3639` and `:4166`.
5. **Gates that use the checklist:**
   - AML/PEP are added to the broker document request only for a broker sender, and only if intake is complete or the deal is post-approval (`ai.js:3658-3667`).
   - `computeCompletionDispatch` (`webhook.js:959-967`) needs status `active`, no holds, every required document including AML/PEP, and an exit strategy. It returns `completion-handoff` if approved, else `preliminary-all-docs-in`.
   - `computeAdminBanner` (`webhook.js:1147-1175`), in order: clarification pending → PRELIMINARY — BROKER CLARIFICATION PENDING; anything missing → PRELIMINARY REVIEW — AWAITING APPROVAL; not yet approved → the same; else COMPLETE — Ready for Review.
   - **New (F10):** the lender-package checklist now uses the same payout-vs-balance and purchase rules (see Module 12).
6. **`intake_asked_items`.** A snapshot of what was asked at intake, computed by `computeIntakeAskedItems` (`webhook.js:131`) and stored at `:3712-3728`. Storing it is best-effort.
7. **`runFollowUpReminders` (`dailySummary.js:73-327`).** Production settings: wait 2 days, 20-hour resend guard, cron `0 21 * * *`, maximum 4 reminders (`:27-31`), timezone America/Edmonton (`:37`). Testing mode uses 1 hour, 30 minutes and every 30 minutes.
   1. Picks deals in status active, awaiting_collateral or awaiting_identity_confirmation (`:82-86`).
   2. **New (P3):** a deal at 4 or more reminders is skipped, after `sendStalledAlertOnce(deal, reminderCount)` runs (`:93-97`). See step 9.
   3. Skips deals with no inbound message, or with under 2 days since the last inbound (`:99-103`).
   4. Skips if the last outbound message was under 20 hours ago (`:106-114`).
   5. `claimReminderSlot`: a conditional UPDATE so only one worker can take each reminder number (`:127-131`; `deals.js:289-305`).
   6. Builds the missing list from the intake snapshot, or from its own inline copies of the lists (`:138-168`).
   7. If nothing is missing, sends nothing, keeps the incremented count, and logs it as suppressed (`:171-206`).
   8. Picks the greeting name in code (`:208-220`).
   9. Calls `generateFollowUpReminder` (`ai.js:3779-3846`): Claude, 512 max tokens (`:3790`). The prompt asks for the outstanding items as a bullet list of display names (`:3828`), a tone that grows firmer by reminder number and never says the file is closing, banned openers, and "Franco is never the recipient".
   10. Threads only on broker-facing messages, using `mailer.messageIdHeader` (`:255-288`).
   11. Sends and saves (`:289-300`). If the send fails, `releaseReminderSlot` rolls the count back, but only if no other worker has changed it (`:309-325`; `deals.js:307-317`).
   12. Any broker reply to an existing deal resets `reminder_count` to 0 (`webhook.js:3919-3921`).
8. **`runDailySummary` (`dailySummary.js:436-582`).**
   1. Sends reminders first (`:444`).
   2. Continues only if Edmonton time is exactly 21:00 (`shouldFireDailySummaryNow`, `:363-370`; gate at `:452-458`).
   3. `claimDailySummarySlot` inserts a row keyed by the Edmonton date (`edmontonDateKey`, `:377`), which is unique; error 23505 means another worker already sent it (`deals.js:744-760`).
   4. Excludes admin replies from "emails received" (`:492`).
   5. Puts each deal in exactly one section, in priority order: escalated → stale (3+ days) → at max reminders → other (`computeDealClassification`, `:413-434`).
   6. `generateDailySummary` (`ai.js:4976-5030`): Claude, 8192 max tokens (`:4983`), fixed 6 sections; code strips fences and html/head/body/doctype tags (`:5021-5023`).
   7. Sends to the admin and records sent or failed (`dailySummary.js:539-575`; `deals.js:764-780`).
9. **New — `sendStalledAlertOnce` (`dailySummary.js:55-71`; P3, `eb0b8d3`).**
   - Reads `getMessages(deal.id)` and returns early if any outbound subject starts with `[Stalled]`.
   - Otherwise sends a plain-text email to the admin:
     - subject `[Stalled] <borrower> — no broker reply after N reminders`
     - body: borrower, broker email, status, the time of the last inbound message, deal id
   - Saves it as an outbound message with its Message-ID, so admin replies thread back to the deal.
   - Errors are caught and logged; it is retried on the next cron tick.
   - The borrower name comes from `deal.extracted_data?.borrower_name || deal.borrower_name`.
   - `[Stalled]` is listed in `SYSTEM_ALERT_SUBJECT_RE` (`webhook.js:2228`).
10. **Scheduling and manual trigger.** `startCron` (`dailySummary.js:626-641`) registers the job once and is called from `src/index.js` after the server starts. `POST /cron/run-daily` (`src/routes/cron.js:10-27`) needs the `X-Cron-Secret` header: 500 if no secret is configured, 403 if it doesn't match, otherwise 202 and then it runs.

**Outputs:** Reminder emails, the updated `reminder_count`, the one-time `[Stalled]` admin alert, the daily summary email, a `daily_summaries` row, and missing-item lists.

**AI use:**
- Claude writes prose only: reminders and the daily summary.
- Code decides who gets a reminder, what is listed, the reminder number, the threading, the summary sections, and the whole Stalled alert.
- Claude's `is_purchase` and `exit_strategy` drive the checklist.
- Nothing checks afterwards that the reminder actually listed every item.

**Errors and correction:**
- Atomic claim with rollback, and the 20-hour guard.
- Per-deal try/catch.
- Summary rows stay "pending" if a worker crashes.
- An outer catch logs any other failure.
- Stalled-alert failures are swallowed and retried on the next tick.

**Technical problems solved:**
1. Nine duplicate reminders sent at 9 PM (`78c84d2`).
2. Duplicate daily summaries (`5ebf2be`).
3. Two summaries 30 minutes apart in testing mode (`dailySummary.js:446-458`).
4. Test runs taking the production slot (`f97db21`).
5. Wrong date in the header (UTC instead of Edmonton) (`:37-48`).
6. Reminders listing items Vienna never asked for (`:150-168`).
7. Brokers chased while only admin approval was outstanding (`:171-206`).
8. Broken reminder threads (`:255-288`).
9. "Equipment purchase" read as a property purchase (`dealType.js:1-29`).
10. Broker reply and admin prelim disagreeing on what was missing (`625d3fb`).
11. AML/PEP requested too early (`dealType.js:62-89`).
12. Daily summary cut off at about one row (`ai.js:4979-4983`).
13. *New:* no admin escalation once the chase cadence was exhausted (`eb0b8d3`).

**Open questions:**
- **Still open:** reminders go out nightly once 2 days have passed.
- **Fixed by `eb0b8d3` (P3):** "No escalation email after 4 reminders." New caveats:
  - The once-per-deal guard is check-then-send with no database claim. Two workers running at the same time could both send. The reminder path needed `claimReminderSlot` for exactly this reason.
  - It is once per deal for the deal's whole life. If the broker replies (count resets to 0) and the deal stalls again, there is no second alert.
  - Suppressed reminders still increment `reminder_count` (`:171-206`). A deal waiting only on the admin can therefore reach 4 and trigger an alert saying "no reply from the broker", though the broker owes nothing.
  - "Last broker message" is the last inbound message of any kind, so it can be an admin reply.
  - **Threading risk:** `ADMIN_FACING_SUBJECT_RE` (`src/lib/adminReply.js:82`) does not include `[Stalled]`. The saved alert, with its Message-ID, therefore counts as broker-facing in the reminder threading (`dailySummary.js:256`, `:280`) and in `buildBrokerThreadInputs` (`webhook.js:309-320`). A later broker-facing email could carry `In-Reply-To` set to the admin alert's Message-ID, the same kind of thread break R7-B fixed.
  - An admin reply ("Re: [Stalled] …") isn't matched by `ADMIN_REPLY_SUBJECT_RE` (`adminReply.js:66`), so the daily summary counts it as a broker email.
  - I didn't verify how the webhook routes such a reply.
- **Still open:** admin replies reset the silence clock (`getLastInboundMessage`, `deals.js:404-416`, doesn't filter admin replies).
- **Still open:** deals with no inbound message are never chased.
- **Still open:** duplicate requirement lists in the daily-summary file, with an outdated TODO (`dailySummary.js:145-146`, `:164-166`).
- **Still open:** the down-payment comment at `webhook.js:1295-1297` doesn't match the purchase list.
- **Still open:** the manual trigger only sends reminders outside 21:00.

---

### Module 12 — Deal-package assembly

**Prelim (`sendPreliminaryReviewToAdmin`, `webhook.js:1288-1607`):**

1. Loads documents and classifications and computes `missingDocs` with `computeMissingIntakeItems` (`:1291-1312`).
2. Labels messages so admin replies show as from the admin (`:1319`).
3. Builds the canonical map with `runDiscrepancyDetectionAggregated` (`:1347-1352`) and four source filters (`:1370-1376`).
4. **F14:** calls `buildReviewSnapshotParts` (`:1383-1386`; helper at `:1742-1801`). It returns the roster (Q3/Q4/Q11 registered-owner detection), corporate detection (Q5), and the code-built Snapshot HTML from `dEngine.renderDealSnapshot`.
5. Computes the LTV, lender and broker-correction overrides (`:1388-1410`) and cleans loan-application text (`:1428`).
6. Calls `generateLeadSummary` with `noSnapshot:true` and the roster's aggregation directive (`:1429-1442`; function at `ai.js:3880-4231`). Claude, 4096 max tokens (`:4065`).
   - The override blocks come first (`ai.js:3945-4060`).
   - Then sections 2-8, with purpose quoted verbatim and Deal Rating as GREAT / OKAY / WEAK BUT WORKABLE (`:4148`).
   - Section 9 (`:4158`); the internal-only `<hr>` separator; section 10 (the email conversation, `:4169`); and the APPROVED/DECLINE block.
   - Rules: no tables (`:4077`); flag each discrepancy separately, with an allowance for hedged estimates (`:4211`); no sign-off (`:4215`).
   - Only non-compliance document text (`:3924-3927`) and the messages are sent.
7. Cleans up Claude's output in this order:
   1. strip any closing sign-off (`webhook.js:1446`)
   2. strip any Claude Snapshot and insert the code-built one (`:1452-1453`). `prependDealSnapshot` puts it right after a leading `<p><strong>FILE STATUS…</strong>…</p>` if there is one, else at the top (`ai.js:939-948`).
   3. **P2:** if `computeCanonicalLtvForReview` returns null and the model's `ltv` is present, `injectLtvEstimateCallout` (`ai.js:977-987`) inserts a `data-marker="p2-ltv-estimate"` paragraph right after the Snapshot block. It reads "LTV is an estimate: … ~X% is the AI's reading … verify before relying on it". Re-renders don't duplicate it (`webhook.js:1485-1488`).
   4. callouts for the elevated 75-80% LTV band, conflicting postal codes, lender mismatch, and filename/content mismatch (`:1489-1542`)
   5. remove every "Documents Included" block Claude wrote (pattern with the global flag, `ai.js:1355`) and insert the code-built `renderDocumentsIncludedSection` (`ai.js:1306`) before the first `<hr>` (`ai.js:1357-1395`; `webhook.js:1552`)
8. Attaches `<Borrower>_Documents.zip` with all stored documents (`webhook.js:1556-1565`).
9. Banner: `computeAdminBanner` (`:1576`), then `enforceReviewBanner` (`:1581`; `ai.js:2387-2407`). The fix in `32bc746` makes `REVIEW_BANNER_PARAGRAPH_RE` match one paragraph only: `/<p>(?:(?!<\/?p[\s>])[\s\S])*?FILE STATUS[\s\S]*?<\/p>/i` (`ai.js:2384`). If nothing matches, the banner is added at the top.
10. Subject: `[UPDATED] ` (optional) + `ACTION REQUIRED: <status> Review — <borrower> — <code-computed LTV>% LTV`. When the LTV can't be computed in code, the model's figure is shown as `~<ltv>% LTV (est.)` (`:1590-1593`).
11. Sends and saves the outbound message (`:1594-1601`).
12. **P1:** runs `recordFactSnapshot(deal,'prelim')` (`:1602`). It rebuilds the facts from the thread (`buildThreadFacts`, `:2234-2261`) and appends a `messages` row with `direction:'system'`, subject `[fact-snapshot] prelim`, and body JSON `{trigger, facts, map}` (`deals.js:338-344`). Failures are caught (`webhook.js:2264-2277`). Q10/F9 later compares the current facts against this snapshot to decide whether to re-notify the admin. Deals from before this change fall back to parsing the prelim email (`:2281-2286`).
13. Sets status to `under_review` (`:1603`).

**Completion (`sendCompletionHandoff`, `webhook.js:1862-2073`; triggered from `:4231` and `:4930`):**

1. Builds `<Borrower>_Complete_Documents.zip` with every document, AML/PEP included. A failure is caught and the flow continues without it (`:1899-1919`).
2. `buildCompletionLenderPackage` (`:1803-1860`):
   - Recomputes the canonical map, filters and LTV/lender/correction overrides.
   - **F14:** calls `buildReviewSnapshotParts` (`:1836-1839`), then `generateLeadSummary` with `lenderPackage:true`, `noSnapshot:true` and the roster directive (`:1840-1854`).
   - Strips any Claude Snapshot, adds the code-built one (`:1855`), and strips any sign-off (`:1858`).
   - In lender-package mode Claude writes no internal sections. It starts with "FILE STATUS: COMPLETE — Ready to Close", writes sections 2-8 ("the Deal Snapshot is inserted by code"), and ends with a "Submitting Broker" section taken from the broker's signature, with "do NOT invent" instructions (`ai.js:4216`). Code then appends `buildLenderPackageChecklist` (`ai.js:4226`).
   - The package gets no `enforceReviewBanner` and no P2 estimate callout.
   - A package failure is caught and the admin notice is sent without it (`webhook.js:1946-1954`).
3. **`buildLenderPackageChecklist` (`ai.js:98-127`; F10).** Always 10 rows:
   1. Loan Application
   2. Credit Bureau
   3. an income row labelled from the actual file by `labelIncomeDocument` (`:75-86`), preferring a T4, else any income proof, else an NOA
   4. Appraisal
   5. PNW Statement
   6. for purchases, **Purchase Contract**; otherwise **Mortgage Payout Statement**, which accepts `mortgage_statement` only
   7. Property Tax Assessment
   8. Government ID
   9. AML Form
   10. PEP Form

   - When only a balance statement is on file, the payout row reads "✗ Not on file (balance statement received: <file>; a payout statement is still required)".
   - Each other row says "✓ Received (<file>)" or "✗ Not on file".
   - `isPurchase` comes from `isPurchaseFromSummary(dealSummary)`, which uses Claude's `is_purchase` first.
4. Admin notice: `[File Complete] <borrower> — Ready to Close` (or `[Conditions Fulfilled] <borrower> — File Complete`). Fixed lead text (`:1925-1944`), then "Lender Submission Package — copy and paste below for forwarding:" and the package (`:1950`), with the zip attached (`:1956-1963`).
5. Waits 2 seconds (`:1974`).
6. Broker closing: `generateCompletionEmail` (`ai.js:3425-3441`) is a fixed template with no Claude call: "The file is now complete and submitted. Please direct any further questions to Franco at …". It still passes through the cleanup checks (`webhook.js:2020-2034`), is threaded into the broker's conversation (`:2035-2059`), and has no attachments.
7. Sets status to `completed` (`:2071`).

**Zip — `downloadDocsAsZip` (`deals.js:608-648`):** archiver at compression level 5, built in memory. Each file is downloaded from storage and added under its original filename; failed downloads are skipped. Returns base64.

**`composeBrokerLenderPackageEmail` (`ai.js:1261-1304`):** retained but abandoned, with no callers. It assumed the broker would forward a package to lenders, but PML does the lender outreach (`ai.js:1194`). F11 didn't remove it. `generateEscalationNotification`'s `mode:'completion'` branch (`ai.js:3450-3550`) is also no longer called with that mode.

**Prelim PDF mapped to the code:**

| PDF piece | Produced by | Code or Claude |
|---|---|---|
| Subject line, incl. `(est.)` | `webhook.js:1590-1593` | Code |
| Banner | `computeAdminBanner` (`webhook.js:1147`) + `enforceReviewBanner` (`ai.js:2387`) | Code |
| Deal Snapshot, incl. "(computed)" and "TBD" | `buildReviewSnapshotParts` → `renderDealSnapshot` (`discrepancy-engine.js:680`, LTV rows `:751`/`:753`, ownership `:851`) | Code |
| LTV-estimate callout | `injectLtvEstimateCallout` (`ai.js:979`) | Code |
| Risk callouts (LTV band, postal code, lender, classification) | `webhook.js:1489-1542` | Code |
| Sections 2-8 | `generateLeadSummary` | Claude |
| "Outstanding [MISSING]" list in Deal Rating | Claude's own text, not removed by cleanup | Claude |
| Documents Included | `renderDocumentsIncludedSection` (`ai.js:1306`) | Code |
| Email conversation | Claude renders the labels code supplied | Claude, code labels |
| Zip attachment | `webhook.js:1556-1565` + `deals.js:608-648` | Code |

**File Complete PDF mapped to the code:** the example PDF predates `85ea4cc`/`b32774d` and now also predates F10/F14. It shows:
- a generic income row and no PEP row
- a Claude-written Snapshot
- a payout row that a balance statement would satisfy

None of those match current code. These pieces still match current code:
- the lead lines (`webhook.js:1928-1930`)
- the "copy and paste" header (`:1950`)
- the zip name (`:1905`)
- the Submitting Broker section (`ai.js:4216`)

**Technical problems solved:**
1. Claude dropping documents from the list (`a232454`).
2. "Documents Included" appearing two or three times (`d407074`).
3. COMPLETE banner on the first review (`webhook.js:1147-1175`).
4. Subject LTV disagreeing with the Snapshot (`:1583-1593`).
5. Wrong current lender ("Scotiabank") (`ai.js` R9-D override block).
6. Broker's correction overridden by document values (R10-G block).
7. Generic income label and missing PEP row (`85ea4cc`).
8. Completion package too thin (`b32774d`).
9. Broker package based on the wrong workflow (`webhook.js:2006-2019`).
10. Broker sign-off leaking into admin documents (`:1446-1450`, `:1858`).
11. Tables breaking when pasted into lender emails (`ai.js:4077`).
12. *New:* lender checklist ticking a balance statement as the payout statement, and the purchase contract missing for purchases (`4495b7e`, F10).
13. *New:* lender-package Snapshot written by Claude, without the roster and corporate checks (`4495b7e`, F14).
14. *New:* the model's LTV shown as if computed when code couldn't compute it (`eb0b8d3`, P2).
15. *New:* banner enforcement deleting the code-built Snapshot rows and callouts (`32bc746`).
16. *New:* no record of which facts were in front of the admin at prelim, so material-change re-notification had to parse HTML (`d6ec8c7`, P1/F9).

**Open questions:**
- **Fixed by `4313090` (F11 comment correction):** the out-of-date comment that completion uses `generateEscalationNotification`. The R11-B comment now reads correctly (`webhook.js:1943-1946`). **New stale comment:** `webhook.js:1729-1736` still says the roster/Snapshot machinery "is NOT replicated", which F14 contradicts.
- **Fixed by `4495b7e` (F14):** Claude wrote the lender-package Snapshot.
- **Fixed by `4495b7e` (F10):** the checklist counted a balance statement as the payout statement.
- **Still open:** AML/PEP and all stored files go into both zips.
- **Still open:** no limit on document text length.
- **Still open:** Claude's leftover "[MISSING]" list can disagree with the code-built one.
- **Still open:** the example PDF is outdated, now more so (F10/F14).
- **New:** the lender package has no LTV-estimate callout. If the LTV can't be computed in code, the lender-facing narrative carries Claude's LTV unflagged. Its FILE STATUS line is also not enforced by code.
- **New:** the lender checklist's purchase/refinance row depends on Claude's `is_purchase`. Loan Application and PNW rows can show "Not on file" in a file the completion gate treats as complete, because those two aren't in the completion requirements.
- **New:** the P1 "prelim" fact snapshot is rebuilt with `extractCanonicalFieldsAggregated`. It skips the commercial/identity-clash empty-map path that the prelim's `runDiscrepancyDetectionAggregated` takes, so on those deals the snapshot can hold figures the admin's Snapshot showed as TBD. It is recorded after the send, and a failure is only logged.
- **New:** `REVIEW_BANNER_PARAGRAPH_RE` only matches a plain `<p>`. A FILE STATUS line inside `<p class=…>` or a heading would not be replaced, giving two banners.

---

### Spec claims (sections II, III, V) contradicted by the code

1. **II.1** says text is extracted "from PDFs and images". Only PDFs get text extraction (`deals.js:465`).
2. **II.2** says "PDF text / OCR". There is no OCR.
3. **III.2** says "OCR for image attachments and scanned documents". There is no OCR; the model reads them directly, nothing is stored, and the lead summary ignores them.
4. **III.2** describes classification without the actual method:
   - filename-first rules
   - the image → `government_id` default
   - the flag-only cross-check
   - the 24 classes
   - the payout/balance split
   - the AML/PEP exclusion
   - there is no model-based classification at all (`classifyImage` was removed in `4313090`)
5. **III.1 / II.2** never mention the link-only handoff branch (`webhook.js:3399-3449`).
6. **III.4** says gates don't use model-derived numbers. True, but the checklist, the completion gate and now the lender-checklist rows use the model-derived `is_purchase` and `exit_strategy`. When the LTV can't be computed in code, the LTV gates also fall back to the model's `ltv_percent`; this is now logged (P2).
7. **III.6** says the figures and structure are canonical, not model-derived. Still overstated:
   - several outbound emails are fixed code templates, not Claude
   - section 2-8 figures such as net worth and credit scores are derived by the model
   - the spec omits the code-built pieces that carry the weight
   
   Since F14, the lender-package Snapshot is also code-built, so this claim is now more accurate than at baseline.
8. **III.6** leaves out reminders, the daily summary, the `[Stalled]` escalation, the File Complete package and fact snapshots.
9. **V.1** leaves out `pdf.js`, `pdfFormExtract.js`, `linkDetector.js`, `dealType.js`, `dailySummary.js`, `cron.js`, `resendInbound.js`/`mailer.js`, and `deals.js`'s classification, zip, locking and fact-snapshot storage. Its "document interpretation" can no longer refer to `classifyImage`, which has been deleted.
10. **V.5** says AI is confined to interpretation and narrative. Partly contradicted (see item 6). It also omits the concrete error handling:
    - pdf-parse retry
    - 429-only retry for Claude
    - catch-and-continue for the zip, the package, fact snapshots and the Stalled alert
    - the atomic claims with rollback
    - inbound dedup
11. **V.4**'s "waits for state to stabilize" doesn't appear anywhere in these modules. The only delay is the fixed 2 seconds before the broker closing email (`webhook.js:1974`), which controls delivery order. The "120s stability window" in `973d13a` belongs to the replay test harness, not production code.

---

## What changed vs. the baseline

1. Rebased to HEAD `425715d`. All `deals.js` refs after line 332 moved about +32 (saveDocument now `:451-583`, zip `:608-648`). `webhook.js` and `ai.js` refs were re-pinned throughout. `pdf.js`, `pdfFormExtract.js`, `linkDetector.js` and `dealType.js` are unchanged.
2. `classifyImage` changed from "dead code" to "removed (F11 `4313090`)". `buildContentBlocks` now has 2 callers, not 3.
3. Inputs now cover the Resend inbound adapter, Postmark Basic auth, and inbound Message-ID dedup (`000df09`, `5bfcdd6`). Failed-intake teardown now keeps the deals of brokers already welcomed (`9a68074`).
4. Module 9: the "no escalation email" open question is marked fixed by P3 `sendStalledAlertOnce` (`eb0b8d3`), with new caveats: no atomic claim, once per lifetime, can fire on suppressed reminders, and `[Stalled]` is missing from `ADMIN_FACING_SUBJECT_RE`, a threading risk.
5. Module 12: F14 `buildReviewSnapshotParts` is shared by the prelim and the lender package. "Claude writes the lender Snapshot" is marked fixed (`4495b7e`).
6. F10 checklist rules are documented (payout vs balance wording, `isPurchase` → Purchase Contract row). The balance-statement open question is marked fixed.
7. P2 is added: `injectLtvEstimateCallout` plus the `~X% LTV (est.)` subject and the gate-fallback logging. New open question: the lender package has no estimate callout.
8. The `REVIEW_BANNER_PARAGRAPH_RE` single-paragraph fix (`32bc746`) is documented, with the remaining plain-`<p>`-only limitation.
9. P1 fact snapshots at prelim, intake and on change are documented (`d6ec8c7`), including that they are built differently from the prelim's map on commercial and identity-clash deals.
10. The stale-comment open question is marked fixed (`4313090`). New stale comments are flagged (`webhook.js:1729-1736`, `ai.js:59`). The example File Complete PDF is now further from current code. The spec-claims section is updated to match.