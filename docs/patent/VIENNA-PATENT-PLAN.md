# Vienna: plan for the patent attorney's flow diagram and technical description

Prepared 2026-11-14. Everything here comes from the current code (`~/Undrwrite`, HEAD `edae488`, 2026-06-22, which matches `origin/main`), the production data snapshot, and the test history. The full evidence, with file:line references, is in `research/`.

---

## 1. What the attorney is asking for

They want two things:
1. **A software flow diagram** covering everything Vienna does from start to finish.
2. **One written section per box in that diagram**, each answering: purpose, input, how it works, output, whether AI is used (which model and how it was trained or set up), what happens when the input is wrong, how decisions are made, what structured data gets filled in and how it's managed, how changed facts are handled, and the technical problem solved and how.

Their criticism of what they already have: it says *what* Vienna does but not *how*. Plain English and bullet points are fine. They don't need source code.

---

## 2. What we have to work with

| Source | What it shows |
|---|---|
| Code: 16.8k lines, 340 commits, 2026-03-02 → 06-22 | The real behavior. Four agents read every module end to end. |
| Production snapshot (`backups/vienna-snapshot-2026-05-19…json`) | 100 deals, 762 emails (277 in, 485 out), 483 documents across 12 document types, 69 deals with an LTV calculated. Median of 6 emails per deal, max 17. Final statuses: 51 active, 31 under review, 10 completed, 6 rejected, 2 escalated. Nearly all senders are Franco's test addresses, so this is mostly test traffic. |
| Franco's 15 end-to-end scenarios (`~/Desktop/ServiceAgent/UndrWrite Testing`) | Real test documents. All 15 passed on the deployed staging server as of 06-12. Nine bugs fixed along the way. |
| Synthetic regression suite, 125 scenarios (`test-fixtures/bulletproof`) | Final run on 05-31: 102 of 125 routed correctly, up from 76. The 7 bugs found here each have their own fix commit and their own test. |
| Real outputs (`UndrWrite Testing/lenderreadysubmissionpackage`) | A preliminary review PDF that matches current code. The "File Complete" PDF does **not** match current code and has to be regenerated. |
| Offline extraction runs (`research/extraction-runs/`) | Real fixtures run through the actual extraction code, showing the exact structured data it produces. |

**A real deal we can use as the worked example (Ethan Broussard, snapshot):**
- The broker emails a 2nd-mortgage request with 10 PDFs attached.
- Vienna types each document: payout statement, PNW, application, appraisal, T4, credit bureau, AML, property tax, ID, PEP.
- It computes combined LTV as ($74,000 + $261,000) ÷ $560,000 = **59.8%**.
- It sends a welcome email to the broker and an "ACTION REQUIRED: PRELIMINARY Review — 59.8% LTV" email to Franco.
- Franco and Vienna exchange draft previews and SEND replies; the review goes out again as an "[UPDATED]" version.
- Franco approves, Vienna sends the "COMPLETE Review", and the deal reaches `completed` after 17 emails in 17 minutes.
- Two of the PDFs (T4 and AML) had **no extractable text**, so only Claude could read them.

---

## 3. Corrections to what the attorneys already have

They have both earlier documents: `vienna-ip-specification.md` and the 10-page Engineering Record. Several claims in them are **wrong** about the current code. The new document has to be accurate and should say plainly that it supersedes the earlier ones. **Franco and the attorney need to be told this directly. It is the most important finding of this review.**

| Earlier claim | What the code actually does |
|---|---|
| "OCR for images and scanned documents" | There is no OCR. Scanned PDFs, filled-in forms and images go to Claude as files, and Claude reads them visually. Nothing from that reading is saved. |
| "Gates never consume language-model values" (central claim, IV(a)) | Gates prefer code-computed LTV, but **fall back to the AI's LTV** when code can't compute one (`webhook.js:3511, 4475`). Several AI-produced fields also route deals: `identity_clash`, `exit_strategy`, `is_purchase`, `unresolved_discrepancy`, `misattached_documents`. Five AI classifiers decide what an admin or broker reply means. |
| "The canonical map persists and accumulates across the thread" (IV(d)) | It is **never stored**. It is rebuilt from scratch on every email, from saved messages and saved document text. The only stored fact record is the AI summary in `deals.extracted_data`. |
| "State-stability barrier before gate evaluation" | Does not exist in production. The "settle window" is in the test replay harness only. |
| Dual-path refinance carve-out (IV(h)) | Replaced by "Option C" (`a621a20`): a single condition, and the lender match is now only a label. |
| Brokers can correct the lender | They can't. Corrections are parsed for loan amount, purpose, mortgage position and transaction type only. |
| Q3 joint income is aggregated by code | Code builds the list of borrowers. **The AI does the adding up**, inside the narrative. |
| Q6: escalate to Franco after 4 reminders | No escalation is sent. The deal just appears in the daily summary. |
| Q10 re-notifies Franco on material changes to 5 fields | Only 3 can trigger it: loan amount, appraised value and existing balance. It compares against the AI summary, not the code-built facts. |
| Q11 checks who is the registered owner "by proximity" | The code explicitly has no proximity fallback. |
| Non-Canadian property means status `rejected` | No deal record is created at all. |
| Endpoint `POST /webhook` | `POST /webhook/inbound` |
| All line numbers | Stale throughout. |

---

## 4. Code problems found along the way (separate from the documents)

None of these have been run against a live deal. They come from reading the code. We need to decide whether to **fix them before describing the system, or describe it as it is**.

1. **Approved high-LTV deals can loop.** After Franco approves or overrides, the next broker email puts the deal back into `awaiting_collateral` (`webhook.js:4480` ignores the approval).
2. **The Q9 override draft can't be sent.** When Franco replies SEND, the draft-review check at `2408` misses it.
3. **The >90% auto-decline and the "incomplete data" escalation only run on a deal's first email.** Later emails re-check only the 80% threshold.
4. **A broker with a >90% deal gets two emails:** the collateral-ask welcome, then the decline.
5. **Only some broker correction wordings are recognized.** "Updating loan amount: $345,000" doesn't register, and the old $310k stays (test A06). Balance corrections aren't supported at all (test A34).
6. **The inbound webhook has no authentication.** "Is this from Franco" is a substring match on the From address. Postmark gets a 200 before any processing, so failed emails are never retried. Duplicate emails are only caught by an in-memory check that is lost on restart.
7. **Some outbound emails are saved without their Message-ID.** If Franco replies to an alert, that reply is treated as a new referral.
8. **Two auto-decline emails are written by AI and sent without Franco seeing them first**: >90% LTV and non-Canadian property. They also skip the cleanup that removes internal-routing language.
9. **Four AI functions are never called:** `classifyImage`, `updateDealSummary`, `generateInfoRequestEmail`, `generateDocReviewNotification`.
10. **The lender-package checklist and the completion requirement disagree** on whether a balance statement counts as a payout statement.

---

## 5. Building blocks of the document (12 modules)

For each module we answer the attorney's questions in the same order. The "Hard problem solved" lines are the material most likely to matter for patentability. Each one points to real evidence: a commit, a test, or a real deal.

### M1. Email intake and sender classification
- **Input:** a Postmark JSON webhook (sender, subject, body, threading headers, attachments as base64).
- **How it works:**
  - Drop duplicates by Message-ID.
  - Drop system and internal senders on a denylist.
  - Decide whether the sender is Franco.
  - A rule-based filter rejects non-deal senders: mailer-daemons, emails with only a company name, and Franco-as-borrower collisions. Anything rejected gets an alert to Franco.
  - Recognize the broker's name from their self-introduction or email signature.
  - Detect links to Dropbox, Drive and similar file-sharing sites and hand those deals to Franco.
- **AI:** none, except for referrals, where `parseReferralEmail` returns JSON with a regex fallback.
- **Hard problems solved:** "Hi Franco" greetings leaking to brokers, fixed in 4 layers (`66c8d2a`, `58066a6`, `6b5657c`, `ffa24d3`). Junk deals created from marketing emails (`caf885a`, `fd469f5`, `513e0da`).

### M2. Deal matching (continuation)
- **How it works:**
  - Match the inbound `In-Reply-To`, then `References`, against Vienna's own saved outbound Message-IDs.
  - If nothing matches, it's a new deal.
  - Check for a duplicate deal by sender, plus a fuzzy property match: postal-code prefix plus street number, a 90-day window, and if either address is missing, assume it's a different deal.
  - Outgoing emails are threaded separately for Franco and for the broker, so the two conversations never mix.
- **AI:** none.
- **Hard problems solved:** 89 of 95 resubmissions created duplicate deals (`d6f3b80`). Franco's mail client truncated References (`ba6a856`).

### M3. Document intake and processing (the attorney's first named module)
- **Input:** each attachment (PDF, PNG/JPEG/GIF/WebP; anything else is stored but never read).
- **How it works:**
  1. Store the original in Supabase Storage.
  2. Extract the text layer with pdf-parse, retrying up to 3 times with a fresh module load because pdf-parse fails on valid PDFs (about 37.5% of files) due to a global-state bug.
  3. Separately pull filled-in form-field values and annotations with pdf-lib.
  4. Type the document: 23 filename rules first, then 16 content rules as a fallback. Flag it when the filename and the content disagree.
  5. When documents go to Claude, choose how to send each one:
     - Usable text (200+ characters, not form-like): send the text.
     - "Form-like" text (more than 70% short lines, no dollar amounts, no long lines): send the actual file.
     - Scanned or empty text: send the actual file.
     - Application, summary and appraisal files: send both text and file.
  6. Keep AML/PEP compliance forms out of the material Claude analyses for the deal.
- **Output:** a `documents` row per file: name, type, storage path, one of 24 classifications, and `extracted_data` that is either `{text}` or `{extraction_failed…}`.
- **AI:** Claude Sonnet 4.6 reads the file-mode documents directly. It is not trained. There is no OCR.
- **Errors:** retry plus an explicit failure flag; a fallback to sending the file; a mismatch callout on Franco's review.
- **Hard problems solved:**
  - Filled forms looked blank to text extraction, and the AI then invented numbers (`e4f6b89`; Engineering Record A.1).
  - pdf-parse corrupting its own state (`2f882f9`).
  - Misclassifications: T4 typed as NOA (`625d3fb`), government ID typed as AML (`d65be32`), borrower "Noah" typed as an NOA, balance statement accepted as a payout statement (`f318f29`), a credit-named file that was really a PNW (`3afdd45`).
- **Gap to state honestly:** the preliminary review and lender package only see stored text, so scanned documents add nothing beyond their name and type.

### M4. Deal-fact extraction into a structured record (the attorney's second named module)
- **Input:** the broker's email text (with quoted replies stripped) plus each document's text and type.
- **How it works:**
  - Rule-based extractors per document type, keyed on known labels: mortgage statement, appraisal, property tax, credit bureau, PNW, loan application (amount, occupancy, exit strategy, purpose, position), AML/PEP.
  - Broker-email patterns, each guarded against false positives: "$850k", "2nd mortgage request: $120,000", "behind existing 1st", "appraised $X".
  - Normalizers for money (k/m suffixes with a sanity cap), postal code, address, and lender synonyms.
  - Province inferred from the postal code; mortgage position inferred from the existing balance; refinance as the default when there's no sign of a purchase.
- **Structured record (the "canonical map"):** 15 fields. Each field holds an *ordered list* of `{value, source, classification, lender_canonical?, rawPhrase?, payoutConfirmed?, refinanceConfident?}`. Precedence rules decide which source wins for each field (`resolveCanonicalIntentValue`, the `filterCanonical*` functions):
  - a broker correction beats the broker's original statement, which beats documents, for *intent* fields (loan amount, purpose)
  - documents beat the broker for *objective* fields (mortgage position)
- **Managed how:** rebuilt from scratch on every email, never stored (see §3).
- **AI:** none in extraction. Loan-application text is cleaned before it goes to the AI so the AI can't contradict the code-extracted figures (`sanitizeLoanAppDocTextForLLM`).
- **Hard problems solved:**
  - Bug-2: "$850k" read as 850 (`2238952`).
  - Bug-3 and its two extensions: missed broker shorthand (`d76e02b`, `b427906`, `f6bb964`).
  - Appraisal value on the line after its label (`e519684`).
  - Loan purpose picked up from AML/PEP forms (`0fb1bd0`).
  - First measured accuracy: 0 false positives and 0 misses on a 58-deal set (`4667b70`).
- **Worked example:** the real canonical map produced for test A06 (in `research/extraction-runs/A06.out`).

### M5. Checking sources against each other (the attorney's "error correction" question)
- **How it works:**
  - Group the values for each field by source and compare them with per-field tolerances. Any disagreement goes into a discrepancy set.
  - Disagreements in broker-facing fields go back to the broker as a clarification question, and Franco's preliminary review is **held**. Only structured discrepancies cause a hold, never AI wording (`4ad23f1`).
  - Admin callouts for mismatches in lender, postal code and document type.
  - Identity clash: the borrower named in the email is missing from the documents.
  - Sanity bounds: application amount must be $5k–$2M; an application amount more than 30% off the broker's figure is suppressed.
- **Hard problems solved:** a refinance mis-read as a decline because the lender sources conflicted; fixed by flagging the contradiction rather than cross-wiring it into the decision (`a621a20`). Payout-vs-balance materiality reconciliation (`f464741`).

### M6. When a fact changes
- **How it works:**
  - The newest value from each email wins.
  - `parseBrokerCorrections` recognizes certain phrasings for 4 fields. It ignores hedged statements ("maybe", "around") and questions. A recognized correction goes to the front of its field's list.
  - Because the record is rebuilt each time, the gates re-run on every email.
  - Q10: if loan amount, value or existing balance changed after the preliminary review went out, Franco is notified again.
  - Bug-7: a correction that arrives while Vienna is waiting on a collateral answer is detected and routed correctly (`54c45e6`).
- **To state honestly:** limited phrasing coverage (tests A06, A08, A34); Q10's scope; the gate inputs only look at the current email.

### M7. Decision gates (the attorney's "how are autonomous decisions made")
- **Formulas:**
  - Standalone LTV = loan ÷ value.
  - Combined LTV = (existing + loan) ÷ value, except under the Q1 refinance carve-out (refinance and (payout confirmed or confidently a refinance) and loan ≥ existing balance), where the existing balance is treated as paid out.
- **Thresholds**, hard-coded: escalate above 80%; auto-decline above 90%, using combined LTV only once payout is resolved; flag 75–80% as elevated.
- **Incomplete-data guard (Bug-4):** if a mortgage statement is on file, the loan amount is known, combined LTV can't be computed, and payout isn't confirmed, the deal escalates instead of passing.
- **Rules Q1–Q11:** each with its detector and its effect (table in `research/findings-D`).
- **Order the gates run in:** identity clash, then auto-decline, then escalate, then preliminary review.
- **Hard problems solved:** Bug-1, where the AI's LTV was additive for refinances (a 56% deal read as 103%) and gates were moved onto the code-computed figure (`d749b1e`). Bug-4 (`988badd`). The Q1 rule refinement from a measured 33% escalation rate (`915193c`).

### M8. Deal states and reply routing
- **Seven statuses:** `active`, `under_review`, `awaiting_collateral`, `ltv_escalated`, `awaiting_identity_confirmation`, `rejected`, `completed`, plus an `admin_controlled` flag.
- **Routing:** a different handler for replies in each status. Each AI classifier tries regex shortcuts first and falls back to "do nothing" if it fails.
- Full diagram of every transition and its trigger.

### M9. Document checklist and reminders
- **Checklist:** separate required-document lists for refinances and purchases, decided by the AI's `is_purchase` with a rule-based fallback. Some documents count for others (an NOA counts as income proof). AML/PEP are only requested after approval.
- **Reminders:** a cron job at 9 PM Edmonton time once there's been 2 days of silence. At most 4 reminders. A database lock (claim-then-rollback) guarantees no duplicates. The daily summary is locked to one per date.
- **Hard problems solved:** 9 duplicate reminders at 9 PM (`78c84d2`); duplicate daily summaries (`5ebf2be`, `f97db21`).

### M10. Writing outgoing emails, with checks on the AI
- **Pattern:** the AI writes the prose, then code removes forbidden content and **inserts the parts that must be right**:
  - the Deal Snapshot table
  - the discrepancy section
  - the FILE STATUS banner
  - the "I'll still need…" list of missing documents
  - the LTV, postal, lender and classification callouts
  - the Documents Included list
  - the lender checklist
  - the greeting
- Some emails use no AI at all: completion, link handoff, alerts.
- **Hard problems solved:** the "everything looks complete" overclaim (`625d3fb`); internal-routing language leaking to brokers (31 patterns); Documents Included repeated 2–3 times (`d407074`); leaked code fences (`73f395d`).

### M11. Franco's approval loop
- Draft, then preview to Franco, then SEND / edit / replace. Approve, reject or conditions. The Q9 override. The rule that tells a full replacement email apart from edit instructions (≥50 words, 2 paragraphs, starts with a greeting). Unlimited edit rounds.
- **Hard problems solved:** Franco's full rewrite was sent as Vienna's original (`9410859`); an instruction followed by text was sent word for word (`2cd3ec8`).

### M12. Assembling the deal package
- **Preliminary review to Franco:**
  - code: subject line, banner, Snapshot, callouts, documents list, zip
  - AI: sections 2–8 of the narrative, using the code's figures
- **Completion:** "[File Complete] — Ready to Close" lender package (`generateLeadSummary` in lender-package mode), a fixed 10-row checklist, a zip of all documents, and a fixed closing email to the broker.
- **To do:** regenerate the real example with current code (`85ea4cc`, `b32774d`).

### Appendices
- **A.** Table of every Claude call (22 sites, 18 in use): purpose, input, output, token limit, whether it can affect a decision. Already compiled in `research/findings-D`.
- **B.** The Ethan Broussard deal traced through every module.
- **C.** Test evidence: the 125-scenario suite, Franco's 15 scenarios, the 7 bugs found and fixed.
- **D.** Errata against the earlier documents (§3).

---

## 6. Diagrams

| # | Diagram | Notes |
|---|---|---|
| 1 | Whole system, one page (M1–M12) | Boxes numbered to match the sections |
| 2 | Document routing | Decision tree: text / form / scanned / image, then text vs file to Claude |
| 3 | Building the structured record | Sources feed per-field lists, precedence decides, discrepancy check |
| 4 | Gate decision tree | The LTV formulas and the gate order, with exact thresholds |
| 5 | Deal state machine | Every status, transition and trigger |
| 6 | AI writes, code enforces | What the AI writes, what code removes or inserts |
| 7 | Franco's approval loop | Draft, preview, SEND / EDIT / REPLACE |

---

## 7. What is probably patentable (for the attorney to judge, not legal advice)

The evidence best supports these four as candidates:
1. **AI writes, code enforces.** A hybrid where the language model writes and reads, while decision-critical figures and content are computed by rule-based code and inserted into the model's output, overriding it.
2. **A fact record that tracks where each value came from**, assembled from email prose and typed documents with field-specific precedence. Cross-source disagreements hold the review and route a question to the right person.
3. **Choosing how to send each document to the model** by testing its text layer: text-only, file, or both, plus form-field extraction.
4. **An email-thread state machine** where state-specific reply handlers use regex shortcuts first and fail-safe defaults when the AI can't decide.

The attorney will have their own view. Our job is to describe all four accurately, including where AI values can still influence a decision.

---

## 8. Decisions (resolved 2026-11-14)

We fix first, keep all existing logic, and make every product call ourselves. Franco funds the work and doesn't approve it. The final decisions are in `VIENNA-EXECUTION-PLAN.md` §1. The original open questions are kept below for the record.

1. **Fix first or describe as is?** For the §4 code problems: fix the serious ones (1–3 and 6) first and then describe the fixed system, or describe the current system with its known limits.
2. **Telling the attorney about the errors in the earlier documents:** a short cover note from you or Franco, or an errata appendix in the new document?
3. **Is staging = production?** Production may be the same commit or something else. And is Vienna live with real brokers today, or still in Franco's testing?
4. **Format and who reviews:** whether Brandon reviews before Franco sees it.
