The scratchpad file wasn't written: the subagent runtime refused the write (subagents can't create report files). The full findings are below instead, so the caller can save them. Everything was read from the current code (HEAD `edae488`), and nothing was changed.

# Summary (under 600 words)

**The most important findings:**

1. **Intake has no authentication and drops duplicates only per process.** `POST /webhook/inbound` returns 200 before doing any work (`webhook.js:2135`), so Postmark never retries a failed email. Duplicate deliveries are caught by an in-memory `Set` that lives for one hour in one process (`37`, `2152-2161`). Inbound Message-IDs are never saved to the database. The admin check is a substring match on the From address (`2244`), and nothing verifies who sent the webhook.

2. **Deal matching only uses Vienna's own outbound Message-IDs.** The code checks In-Reply-To first, then each References id (`2218-2235`, `deals.js:335-357`). Nothing matches on the sender's address: `findActiveByEmail` and `getAllMessageIdsForThread` are never called. Several outbounds are saved without their Message-ID:
   - the link-only holding reply and the admin handoff (`3189`, `3209`)
   - the over-90% auto-decline (`3574`)
   - every admin alert

   So a broker reply to the link-only holding email skips the `admin_controlled` pause, and an admin reply to an alert is treated as a **referral**.

3. **Duplicate deals are blocked by deterministic rules, not AI** (`deals.js:771-863`). It looks at every deal with the same sender address and compares properties by postal-code prefix plus street number (or street number plus street words). Closed deals older than 90 days are skipped. If either side has no address, it creates a new deal anyway. It runs only on the broker new-deal path, not on referrals.

4. **State machine.** There are 7 status values; `admin_controlled` is a separate on/off flag, not a status, and nothing in code ever clears it. The order of checks for a new deal is: identity clash → over-90% auto-decline → over-80% LTV or incomplete figures, which holds the deal for a collateral question → preliminary review to admin.
   - The identity-clash check relies on the LLM's `identity_clash` flag alone.
   - The welcome email is sent before these checks run, so an over-90% deal gets both a welcome and a decline.

5. **Bugs that are visible from reading the code** (none of these has been run):
   - **Dead code in the active branch.** The dedicated collateral-question generator at `4364` is guarded by `status === 'awaiting_collateral'`, but it sits inside the `active` branch, so it never runs. The status check at `4620` can't be true either.
   - **Approved high-LTV deals can loop back into the collateral hold.** After admin approval (`2466`) or the Q9 override (`2670`), the gate at `4480` sends the deal back to `awaiting_collateral`. It doesn't check `prelim_approved_at`, and nothing ever reads `collateral_override_at/by`.
   - **Admin SEND seems to do nothing on Q9 override drafts.** The draft-review check (`2408-2412`) doesn't accept `active` + `approval_doc_request`. For Q9 rejection or conditions drafts, the SEND reply gets re-classified as a new admin decision.
   - **Stale comments.** One says `executeDraft` is the only place that sets `completed`, and another says its `approval_completed` branch is unreachable. Both are wrong: `under_review` + admin approval with all docs on file reaches it. That gives two different completion paths, and only `sendCompletionHandoff` sends the [File Complete] notice, zip and lender package.

6. **AI limits.** Every call uses `claude-sonnet-4-6` as a single user message, with no temperature, system prompt or structured output, and retries only on HTTP 429.
   - Each classifier (admin intent, draft SEND/EDIT, collateral answer, identity answer) checks regex shortcuts first. On error it falls back to an outcome that doesn't move the deal forward or send anything. Labels are mapped by substring match.
   - Whether an admin reply is a full replacement draft is decided by a fixed rule (≥50 words, ≥2 paragraphs, starts with a greeting), not the LLM.
   - Every LLM-written email in the admin loop needs an admin preview and SEND. The exceptions are the auto-decline emails (over-90% and non-Canadian), which go straight to the broker with no preview and no routing-leak sweep, and the completion closing, which is a fixed template.
   - `parseIdentityClarification` can overwrite `borrower_name` with any name, with no check that it is one of the two conflicting names.

**Where `vienna-ip-specification.md` §II–III and §V is wrong:**
- The endpoint is `/webhook/inbound`, not `/webhook`.
- There is no OCR anywhere.
- A non-Canadian property creates no deal record, so it never gets status `rejected`.
- Mailer-daemon/no-reply senders are only caught by display name, and only on first-contact mail.
- The §V.4 "waits for outbound state to stabilize" doesn't exist in production code; the settle window is only in the test-replay harness.
- Line references are stale: the gate block is now at 3502-3623, and Q9 is at 2649-2709, not 2495.
- The claim that gates never use LLM values is overstated: LLM LTV is a fallback, and LLM flags drive the identity, exit-strategy and misattached-doc gates.

---

# Full findings

## 0. Top-level map of `src/routes/webhook.js` (4,760 lines)

**Route:** `POST /webhook/inbound` (`routes/index.js:7` + `webhook.js:2133`). There is no authentication: `src/index.js:9-18` only parses JSON (50 MB limit) and logs.

**Helpers (lines 1–2131):**
- `processedMessages` Set (37)
- `ADMIN_FIRST_NAME` / `isUnreliableName` / `firstNameMatchesAdmin` (50-74). The admin's first name is taken from the part of `ADMIN_EMAIL` before the @, which is currently `franco`.
- `shouldSkipIntakeFormsForDeferredState` (98)
- `computeIntakeAskedItems` (128)
- `eligibleDocsForGate` (161)
- `labelMessagesForLeadSummary` (190)
- `brokerRepliedSinceLastViennaOutbound` (238)
- `buildPreviewThreadChain` (268)
- `buildBrokerThreadInputs` (306)
- `shouldHoldPrelimForDiscrepancy` (413)
- `computeWillReview` (440)
- `computeStillMissingForReview` (492)
- `classifyIntakeBorrower` (580-683)
- `sendDuplicateAlertToAdmin` (698)
- `sendBrokerAcknowledgmentOnReject` (758)
- `isPostApprovalAmlPepPending` (828)
- `extractDeclineReason` (860)
- `computeCompletionDispatch` (956)
- `normalizeSenderName` (966)
- `textToHtml` (1018)
- `sendEscalationToAdmin` (1036-1094; **sets `ltv_escalated`** at 1092)
- `computeAdminBanner` (1144)
- canonical LTV/lender resolvers (1204-1283)
- `sendPreliminaryReviewToAdmin` (1285-1646; **sets `under_review`** at 1642)
- Q10 material-change helpers (1653-1709)
- `buildCompletionLenderPackage` (1777)
- `sendCompletionHandoff` (1827-2038; **sets `completed`** at 2036)
- `decideReviewDispatch` (2074-2130)

**Handler, in execution order:**

| Lines | Stage |
|---|---|
| 2135 | Return 200 |
| 2142 | Normalize the payload |
| 2152-2161 | Duplicate check |
| 2181-2200 | Sender denylist |
| 2210-2216 | "Looks like a broker" check (logs only) |
| 2218-2239 | Thread correlation |
| 2243 | `isAdmin` |
| 2260-2285 | `admin_controlled` pause |
| 2287-2823 | Admin reply on a matched deal: draft review 2408-2559, status handlers 2563-2821 |
| 2826-3008 | Admin email with no thread → referral |
| 3010-3666 | New deal |
| 3667-4712 | Existing deal: identity 3696 → collateral 3759 → `under_review`/`ltv_escalated` 3811-4091 → `active` 4092-4708 → other statuses do nothing 4709 |
| 4714 | Outer catch (log only) |

## Module 1 — Email intake and sender classification

**Purpose:** Normalize the Postmark POST, drop duplicates, machine mail and internal mail, tell admin apart from external senders, and filter out non-deal senders before a deal row exists.

**Inputs:**
- Postmark JSON: From, FromName, To, Subject, TextBody, HtmlBody, Attachments (base64), MessageID, Headers, Date
- `ADMIN_EMAIL` and `POSTMARK_SENDER_EMAIL` (`src/config/index.js:6,9`)

**Processing:**
1. The 200 response goes out first (2135).
2. `parseInboundEmail` (`email.js:145-164`) pulls In-Reply-To (trimmed) and References (split on whitespace). Only `TextBody` is used downstream.
3. Duplicate check: an in-memory Set of Postmark MessageIDs with a one-hour TTL (2152-2161). This has been there since the initial commit `5d29a3b`.
4. Denylist: a case-insensitive *substring* match of From against `support@postmarkapp.com`, `noreply@`, `no-reply@`, `@anthropic.com`, `@mail.anthropic.com`, `@fyi.postmarkapp.com`, `@fsagent.com`, three named VIMA staff addresses, and Vienna's own sender address. A match is dropped silently.
   - `franco@vimarealty.com` is deliberately allowed through because it is used as a broker test address (comment 2175-2180; commit `caf885a`).
5. Advisory broker check (2210-2216): attachments, OR "Lic. #" in the body, OR a broker keyword in the subject. It only logs.
6. `isAdmin` = the From address contains `ADMIN_EMAIL` (substring match, 2244).
7. Routing:
   - admin + thread match → admin loop
   - admin + no match → referral
   - non-admin + no match → new deal
   - non-admin + match → follow-up, unless `admin_controlled`
8. `classifyIntakeBorrower` (580-683) is a deterministic filter, and the first rule that matches wins. Its input is FromName on the new-deal path and the LLM's `referred_name` on the referral path. Rules in order:
   - Empty name → accept (fail-open).
   - First name equals the admin's first name and there is no broker name → `reject:admin-as-borrower`. The exception: if `parseBrokerFirstName(body)` finds a broker introducing themselves in the body, accept (R10-A, `513e0da`).
   - The name matches a system-sender pattern (`postmark team`, `mailer-daemon`, `noreply`, `do-not-reply`, `support team`, `notifications`) → `reject:system-sender`.
   - The name has an organisation suffix (Corp, Inc, LLC, Owners, Holdings…) with no "Firstname Lastname" before it → `reject:no-human-name`, unless the body names a broker.

   On any reject, the admin gets an `[Intake Filter]` alert. For the two non-system reject types, the sender also gets a fixed acknowledgment email (758-776). No deal is created.
9. `parseBrokerFirstName` (`ai.js:1393-1530`) is deterministic. It tries self-introductions in the body ("My name is X from…", "I'm X with…", "This is X from…"), then the signature. The validator rejects company lines, more than 5 tokens, first tokens that aren't Title-case, honorifics and role words, greetings, filler words, and "franco".
10. `selectGreetingFirstName` (`greeting.js:44-58`) picks `broker_name` (or `borrower_name` when the sender is a borrower), falling back to `sender_name`. The result has to look like a Title-case name. It returns null when the name is "Franco", which the caller turns into "Hi there!".
11. `normalizeSenderName` (966-1004) runs after each LLM extraction. If the LLM's name is empty, "Unknown" or the admin's name, it substitutes the Postmark display name. If the display name also collides with the admin, it sets `name_collides_with_admin` instead. The check before calling the LLM uses the narrower `firstNameMatchesAdmin` (`66c8d2a`).
12. `detectFileHostingLinksInBody` (`linkDetector.js:77-91`) cuts the body at the signature delimiter, then tries 10 ordered regexes (Dropbox, db.tt, Google Drive/Docs, 1drv.ms, OneDrive, SharePoint, WeTransfer, we.tl, Box, iCloud). It never fetches the link.
13. Scrubbing at send time (`email.js:23-100`). For any recipient that is not the admin:
    - `stripAdminGreeting` rewrites "Hi/Hello/Hey/Dear Franco…" to "Hi there!".
    - `stripAdminSignature` cuts at `\n-- \n` or `<p>-- </p>` and deletes six literal markers of the admin's personal details.
14. `adminReply.js` subject regexes:
    - `isAdminReplySubject` needs at least one "Re:" before ACTION REQUIRED, FINAL REVIEW, [Conditions Fulfilled], [File Complete] or [Broker Update].
    - `isAdminFacingSubject` allows zero or more "Re:" and also matches "Daily Summary".

    They are used to label admin messages in prompts and to keep them out of broker threading.

**Outputs:** A silent drop, an admin alert (with an optional broker acknowledgment), or a normalized email passed on to a branch.

**AI use:**
- Most of intake is deterministic. The exception is referrals:
  - `parseReferralEmail` (`ai.js:5034-5090`, 512 tokens) returns JSON `{referred_name, referred_email, sender_type, deal_details, notes}`. It has a strict rule to set `deal_details` to null unless the admin gave something substantive.
  - Checks on its output: a leading code fence is stripped, then `JSON.parse` (an error is caught by the referral branch's alert). If `referred_email` is null, a regex fallback takes the first email address that isn't the admin's, Vienna's, or a system mailbox (5096-5111).
  - The output decides who gets the welcome email, plus the deal's email address, `borrower_name` and `sender_type`.
  - Referrals skip the duplicate check and the non-Canadian check.
- `generateReferralWelcomeEmail` (512 tokens) only has its code fence stripped, with no routing-leak sweep. The welcome is sent with both PDF forms and CCs the admin (2946-2958).

**Errors and correction:**
- The duplicate check is per process and lost on restart, and inbound IDs are never stored. Every inbound `saveMessage` call omits the external ID (2264, 2289, 3152, 3672).
- Only the referral branch (ZZZ, `4302ed5`) and the new-deal branch (FFFF, `7de8c8e`) alert the admin on failure, with the Postmark MessageID. All other failures are only `console.error`'d.
- `sendEmailDelayed` is fire-and-forget (`setTimeout` with 0 ms delay). A send failure is only logged.

**Technical problems solved:**
- Junk deals from marketing and internal senders → denylist (`caf885a`).
- "Hi Franco" greetings sent to brokers, fixed in layers:
  - the collision check before the LLM (`66c8d2a`)
  - the From-header rescue (`58066a6`)
  - the greeting helper (`6b5657c`)
  - the send-time scrub (`ffa24d3`; deal 9db03a27 is cited)
- Admin's personal details leaking to a broker → signature scrub (`904c068`; deal 9aa136aa).
- Non-deal entries polluting the deals table → intake classifier (`fd469f5`), then the body-signal override plus acknowledgment (`513e0da`).
- Links sent instead of attachments → detection only, plus a handoff to the admin (`86605a9`).

**Open questions:**
- No authentication: anyone who can POST can spoof the admin.
- Substring matching drops any address containing `@fsagent.com`, `noreply@`, etc., with no alert.
- mailer-daemon is not in the address denylist. A bounce that threads to a Vienna email is processed as a broker reply.
- The admin's first name has three separate sources that only agree while the admin address starts with `franco`: the `ADMIN_EMAIL` local part in webhook.js, `'Franco'` hard-coded in greeting.js, and `'franco'` hard-coded in ai.js.

## Module 2 — Deal correlation

**Purpose:** Decide between continuing an existing deal and starting a new one, and prevent duplicate deals.

**Processing:**
1. **In-Reply-To.** `findByMessageId` (`deals.js:335-357`) strips `<>` and everything from the `@`, then queries `messages` for a match on `external_message_id` with `direction='outbound'`, limit 1, and loads that deal.
2. **References fallback.** Each References id is tried in header order, one database query per id (2227-2235).
3. **No match means a new deal**, "even if broker has other active deals" (2236). `findActiveByEmail` (192) and `getAllMessageIdsForThread` (406) are not called anywhere in `src/`.
4. **Duplicate check before creating** (broker path only, 3095-3104):
   - `cFields.extractFromEmailBody` pulls the property address with regex.
   - `findExistingDealForBorrower` loads all deals with the same email, newest first, then runs the pure function `decideExistingDealMatch` (821-863):
     - Open deals are checked before closed ones (`completed`/`rejected`).
     - Closed deals whose `updated_at` is more than 90 days old are skipped (`TEMPORAL_CARVEOUT_DAYS`, 771).
     - If either side has no property address, that candidate is skipped (fail-open).
     - `propertyFuzzyMatch` (802-814) uses `canonicalizeProperty` (778-794): lowercase, remove `,` and `.`, collapse whitespace, take the postal-code prefix (FSA) with regex `\b([a-z]\d[a-z])\s*(\d[a-z]\d)?\b`, take the street number if the first token is all digits, and the next 3 words.
     - Match rule: if both have a postal prefix, the prefix AND street number must be equal. Otherwise, the street number AND the 3 street words must be equal.
   - On a match: `sendDuplicateAlertToAdmin` is sent and the function returns. **No reply goes to the sender.**
5. **Outbound threading**, which is what makes later correlation possible:
   - Admin previews set In-Reply-To to the admin's message and References to all of Vienna's outbound IDs on the deal + the admin's References + the admin's ID, de-duplicated. Bare IDs get `@mtasv.net` appended (2353-2366; Group YYY `ba6a856`).
   - Broker sends use `buildBrokerThreadInputs`: they drop messages with admin-facing subjects, use broker-side outbound IDs, and reuse "Re: <first broker subject>" (Group LLLL `0fd3c4f`).

**AI use:** None.

**Errors:** "No rows" (PGRST116) returns null. Other database errors go to the outer catch and are only logged.

**Technical problems solved:**
- Mismatched Message-ID formats → normalization.
- The admin's mail client truncating References → the chain is anchored on IDs stored in the database.
- Admin-side IDs leaking into broker threads → the broker-only slice.
- Duplicates on resubmission ("89 of 95", comment `deals.js:751-754`) → R9-F' (`d6f3b80`).

**Open questions:**
- **These outbounds are saved without a Message-ID:** the link-only acknowledgment (3189), the admin link handoff (3209) and the over-90% decline (3574). These are not saved at all: the [Admin-controlled deal] forward (2278), [Intake Filter], [Potential Duplicate], [Out of Scope], [Auto-Decline], and the ZZZ/FFFF alerts. Consequences:
  - A broker replying to the link-only acknowledgment skips the `admin_controlled` pause and is processed as a new submission.
  - An admin replying to any of these alerts is processed as a referral.
- Because inbound IDs aren't stored, a reply that only references the broker's own earlier message won't correlate.
- The duplicate check doesn't run for referrals, and only catches cases where regex can pull an address from the body.
- A legitimate new email (not a reply) about the same property is blocked, and the broker gets no acknowledgment.

## Module 8 — Deal state machine and reply routing

**Schema:** `src/migrations` only adds `intake_asked_items` (JSONB), `prelim_approved_at`, `admin_controlled` (boolean, default false), `aml_pep_requested_at`, and the `daily_summaries` table. The base schema and `status`, `draft_*`, `conditions_sent_at` and `reminder_count` have no migration in the repo. `status` is free text, with no enum or CHECK visible.

**Status values and where they are set:**

| Status | Set at |
|---|---|
| `active` | `deals.js:249`; 2466, 2670, 2963, 3432, 3726, 3796, 4621 |
| `awaiting_identity_confirmation` | 3545 |
| `awaiting_collateral` | 3595, 4599 |
| `ltv_escalated` | 1092 |
| `under_review` | 1642, 4706 |
| `rejected` | 2469, 3575 |
| `completed` | 2036, 2495 |

`admin_controlled` is a boolean set only at 3170, and nothing clears it.

**New deal** (status `active`; the welcome email is queued unconditionally at 3418). Gate chain in order:
1. `identity_clash` → `awaiting_identity_confirmation` (3538-3545).
2. `shouldAutoDeclineOver90`: canonical standalone LTV always counts; combined LTV counts only once the payout status is resolved. Result: an LLM-written decline is sent to the broker with no admin preview, status becomes `rejected`, and the admin gets an alert (3546-3581).
3. Escalation, if canonical standalone or combined LTV is over the threshold OR `shouldEscalateOnIncompleteCanonical` fires → `awaiting_collateral`, with no admin email (3582-3595).
4. Canonical standalone LTV ≤ 80 AND one of `income_proof`/`noa`/`appraisal` on file (after removing docs the LLM flagged as misattached), and no structured discrepancy hold → preliminary review sent, status `under_review` (3596-3622).
5. Otherwise the deal stays `active`.

Exits before a deal is created: intake filter, duplicate, non-Canadian (an LLM decline plus an admin alert, 3113-3142). Exit after creation: link-only submission → `admin_controlled`, fixed acknowledgment, admin handoff (3165-3214).

**Existing deal.** The message is saved and `reminder_count` reset to 0 (3672-3675). Then the handlers run in a fixed order. A handler can change the status in memory so the next one runs.
- **Identity** (3696-3748), using `parseIdentityClarification`:
  - `resolved` → database `active`, `identity_clash=false`, `was_in_identity_clash=true`, and `borrower_name` if a name was extracted.
  - `unresolved` → status changed to `active` in memory only, so the active handler sends a re-ask.
- **Collateral** (3759-3809):
  - First, `cFields.parseBrokerCorrections` (deterministic). If it finds a correction → status `active` in memory and the classifier is skipped (BUG-7, `54c45e6`).
  - Otherwise `parseCollateralReply`:
    - `no` → `sendEscalationToAdmin` (status `ltv_escalated`), no reply to the broker, return.
    - `yes` → database `active` + `collateral_offered=true`.
    - `ambiguous` → status `active` in memory; the active gate writes `awaiting_collateral` again.
- **`ltv_escalated` / `under_review`** (3811-4091): `generateBrokerResponse` refreshes the summary, LTV, ownership type and form flags; the status itself isn't changed. Then `decideReviewDispatch` (2074-2130) picks one action:
  - **`under_review` with a complete file** (all completion docs plus an exit strategy):
    - a draft is pending → `noop`
    - no new attachments → `text-only-noop`
    - `prelim_approved_at` is set → `completion-handoff`
    - otherwise → `preliminary-update`
  - **`ltv_escalated`** → `escalation-update`, which always sends an [UPDATED] escalation.
  - **`under_review` with an incomplete file:**
    - no attachments → `text-only-noop`
    - otherwise → `preliminary-update`

  What each action does:
  - `text-only-noop` sends Vienna's reply to the broker. It also sends the admin a Q10 notice if a material figure changed compared with the last preliminary review, which is parsed back out of the stored preliminary-review HTML (4022-4046).
  - `preliminary-update` re-sends the review only when a material figure changed (Path B, `699029a`).
  - Every other action holds back Vienna's broker reply.
- **Active** (4092-4708):
  - If the deal was once in an identity clash and the broker's own loan application and PNW forms aren't both present (checked by filename regex), `processInitialEmail` is re-run as an intake template and the handler returns (4129-4223).
  - Otherwise `generateBrokerResponse` runs, then the sweeps, then the summary is saved (4416). Gates:
    - `willGoToCollateralCheck` (4480): canonical LTV escalation AND `active` AND not `collateral_offered` AND no identity clash → `awaiting_collateral`. Vienna's reply is still sent.
    - `willReview` (440-456): LTV ≤ 80, `active`, a reviewable doc, an exit strategy, no clash, no `prelim_approved_at`, no LLM `unresolved_discrepancy`, and no structured discrepancy hold → preliminary review.
    - `computeCompletionDispatch` (956-964) → `completion-handoff` (if approved) or `preliminary-all-docs-in`. The `final-review` path is marked as unreachable.
- **`completed` / `rejected`:** the message is saved and nothing else happens (4709).

**AI use:**
- `parseCollateralReply` (`ai.js:4461-4517`, 20 tokens):
  - Prompt: YES (real-estate collateral offered), NO (declined), or AMBIGUOUS (unclear, or a non-real-estate asset). "When in doubt, AMBIGUOUS."
  - Checks: `stripQuotedText` runs first; 10 anchored regexes return `no` without calling the LLM; the answer is mapped as YES → yes, contains NO but not NOT → no, anything else → ambiguous; an error gives ambiguous.
  - The output can trigger the silent escalation to the admin or move the deal to `active`.
- `parseIdentityClarification` (`ai.js:4686-4752`, 80 tokens):
  - Format: `RESOLVED: <name>`, `RESOLVED: (no name extracted)`, or `UNRESOLVED`.
  - Three regex shortcuts (`ai.js:450-454`) run first.
  - **The extracted name is never checked against the two conflicting names.**
  - An error gives unresolved.
- `generateBrokerResponse` and `processInitialEmail` (3072 tokens each) write the broker-facing text and the summary JSON.
  - The gates use canonical LTV. The LLM's `ltv_percent` is only a fallback, via `??` (3511, 4475).
  - The LLM's `identity_clash`, `exit_strategy`, `misattached_documents` and `unresolved_discrepancy` still feed gates directly.
  - Exit strategy is backfilled deterministically from the loan application (3348-3357).

**Errors and correction:** Classifiers default to keeping the deal on hold. Status changes made only in memory avoid saving a state that hasn't been confirmed. Saving `collateral_offered` prevents a loop.

**Technical problems solved:**
- Sequential holding states for high LTV (`ecb2eca`) and identity clash (`be193aa`).
- A correction sent during the collateral hold was misread as a collateral answer (`54c45e6`).
- The LLM added mortgages together on refinances (a 56% refi showed as 103%) → canonical LTV for gates (comment 3505).
- Duplicate or wrong-type preliminary reviews → `hasNewDocsThisTurn` (`7e10c04`) and Path B (`699029a`).
- A clarification ask going out alongside a preliminary review → a hold based on structured discrepancies only (413-438).
- Leftover scaffold deals after an LLM failure → FFFF teardown (`7de8c8e`).

**Inconsistencies:**
1. `4364`: the R10-C-1 check `status === 'awaiting_collateral'` is inside the `active` branch, so it's dead code and `generateHighLtvCollateralAsk` is never called from there. The collateral re-ask depends on the prompt block in `generateBrokerResponse`, which is keyed on the LLM's `ltv_percent`.
2. `4620`: this check can never be true.
3. **Approved or overridden high-LTV deals go back into `awaiting_collateral`** on the next broker email. Line 4480 ignores `prelim_approved_at`, and `collateral_override_at/by` are never read.
4. An over-90% deal gets a welcome email (3418) and then a decline (3573).
5. A non-Canadian property never becomes `rejected`, because no deal row is created.
6. A deal only reaches `ltv_escalated` after the broker says "no" to the collateral question.
7. Under `under_review` with a draft pending, a broker reply with new docs on an incomplete file still triggers `preliminary-update`; only the complete-file case checks `draft_email` (2083).

## Module 11 — Underwriter (admin) loop

**Processing:**
1. The admin message is saved (2289). There is no separate audit table. The audit trail is the `messages` rows plus these fields:
   - `prelim_approved_at`, `conditions_sent_at`, `aml_pep_requested_at`
   - `extracted_data.collateral_override_at/by`
   - `_q10_admin_renotified_at/_fields`
2. **Is a draft under review?** (2408-2412): `draft_action` is set AND the status is `ltv_escalated` or `under_review`, OR `approval_completed` with status `active` (`167ab37`).
3. `parseDraftReply` (`ai.js:4399-4448`):
   - `stripQuotedText` (4289-4319) cuts at "On … wrote:", a `--` line, "---Original/Forwarded", "Sent from my…", or an Outlook header block, and drops `>` lines.
   - **REPLACE is decided by a fixed rule:** at least 50 words, at least 2 paragraphs, and a first line that starts with hi/hello/dear/good morning/hey (4382-4397; `9410859`, `2cd3ec8`).
   - Otherwise the LLM (20 tokens) answers SEND or EDIT, with "When in doubt, EDIT". An error gives EDIT.
4. What each answer does:
   - **SEND** → `executeDraft` (2418-2525): broker-thread headers; the subject is "Re: <first broker subject>"; `sendEmailDelayed`. Then, depending on `draft_action`:
     - `approval_doc_request` → status `active`
     - `rejection` → `rejected`
     - `approval_completed` → `completed`
     - conditions → status unchanged; stamp `conditions_sent_at` and `prelim_approved_at` if empty

     The draft is cleared in every case.
   - **REPLACE** → `textToHtml`, then preview again (`9f19ef4`).
   - **EDIT** → `reviseEmailWithEdits` + sweep, then preview again. Edit cycles are unlimited (`861e5e2`).
5. **First reply (no draft pending):** `parseAdminReply` (4322-4373) first tries regex shortcuts (approved/yes/go ahead/proceed or reject/decline/deny/pass/kill), then the LLM (20 tokens): APPROVED, REJECTED or CONDITIONS. Substring mapping; an error gives conditions.
   - **`ltv_escalated`** (2563-2648):
     - approved → stamp `prelim_approved_at`, write a post-approval doc request (AML/PEP included in the same request), stamp `aml_pep_requested_at`, preview with `approval_doc_request`
     - rejected → `extractDeclineReason` + `generateRejectionEmail`, preview with `rejection`
     - conditions → `generateAdminResponseEmail`, preview with `conditions`
   - **`awaiting_collateral`** (2649-2709, `f1e944e`):
     - approved → database `active` + `collateral_override_at/by` + `prelim_approved_at`, then a doc-request preview
     - rejected / conditions → same as `ltv_escalated`
   - **`under_review`** (2710-2818):
     - approved, with every completion requirement on file → `generateCompletionEmail` (fixed template), preview with `approval_completed`
     - approved, with docs still missing → doc request
     - rejected / conditions → same as above
   - **Any other status** → nothing happens.
6. `saveDraftAndPreview` (2329-2379) saves `draft_*` and emails the admin a preview ("Reply SEND to confirm, or reply with your edits"), threaded and saved with its Message-ID.
7. `sweepBrokerFacingDraft` (2314-2324) runs `enforceNoRoutingLeak` (regex rewrites such as "Franco reviewed" → "our underwriting team reviewed", plus cleanup) and then `stripPerfectOpener`. It applies to every LLM draft. Admin REPLACE text is deliberately excluded (`225092c`).
8. `extractDeclineReason` (860-893):
   - "DECLINE/REJECT — text" → the text
   - a looser "DECLINE text" form → the text
   - a bare "Decline." → null
   - anything else → the whole message, so the reason is never silently dropped (`31b05cf`)
9. **Referral:** create the deal → send the welcome with forms, CC the admin → set `referred_by='Franco Maione'` (hard-coded, 2968).
10. **Automatic completion:** `sendCompletionHandoff` (1827-2038) runs once `prelim_approved_at` is set and all docs are in.
    - The admin gets [File Complete] or [Conditions Fulfilled], with a zip of the docs and an LLM lender package. A failure in either is tolerated.
    - After a 2 s wait (1939), the fixed closing goes to the broker (`ai.js:3369-3385`), and the status becomes `completed`.
    - The admin's SEND step for this email was removed in `e4796b0`.

**AI functions in this loop:**

| Function | Tokens | Notes |
|---|---|---|
| `parseAdminReply` | 20 | Its output only produces drafts, except the Q9 override, which changes status immediately |
| `parseDraftReply` | 20 | Can only ship the stored draft; errors give EDIT |
| `reviseEmailWithEdits` (`ai.js:4755-4809`) | 1024 | Bans: certain openers, Franco as recipient, invented phone numbers (calendar link only), approval language, internal-routing phrases. Output is fence-stripped, swept, and previewed again |
| `generateAdminResponseEmail` (`ai.js:4812-4885`) | 512 | Same constraints; must list missing items by name |
| `generateRejectionEmail` (`ai.js:3273-3366`) | 512 | Must include the admin's reason. The auto-decline paths send it **with no preview and no sweep** |
| `generateCompletionEmail` | — | Not an LLM call |

**Errors:** Classifiers fail toward not shipping. `executeDraft` advances the status before its fire-and-forget send finishes, so if the send fails the email is lost and only a log line records it.

**Technical problems solved:**
- The admin's full rewrite was shipped as Vienna's original (Bug 9.9; `9410859`).
- An instruction followed by text was sent verbatim (`2cd3ec8`).
- EDIT and REPLACE skipped the preview (`861e5e2`, `9f19ef4`).
- Admin preview threads fragmented (`ba6a856`).
- Admin replies were attributed to the broker in history (`6c4cf54`).
- The close-out SEND got stranded (`167ab37` → `e4796b0`).
- The decline reason was omitted (`31b05cf`).
- Brokers got two separate document requests (the `aml_pep_requested_at` migration).
- Approvals that went through the conditions path never completed (comment 2505-2515).

**Inconsistencies:**
1. **Q9 override drafts look like SEND can't send them.** The status is `active` with `approval_doc_request`, which fails the check at 2408-2412, so SEND falls through to "no escalation action taken". For Q9 rejection or conditions drafts, SEND is re-read by `parseAdminReply` as a new decision. The admin also gets no email during `awaiting_collateral`, so this path is hard to reach in the first place.
2. Wrong comments:
   - 2398 says `executeDraft` is the "SOLE setter" of completed; `sendCompletionHandoff` also sets it (2036).
   - 2472 says the `approval_completed` branch is unreachable, but it is reachable via `under_review` approval with all docs. That path skips the [File Complete] notice, zip and lender package.
3. `generateAdminResponseEmail` labels every inbound message `[BROKER]`, admin replies included (`ai.js:4835`).
4. The REPLACE "byte-for-byte" promise (2536) isn't true. Quote stripping, `textToHtml` and the send-time scrubs can all change the text.
5. Substring mapping of the classifier answers ("NOT APPROVED" would map to approved). The 20-token limit makes this unlikely but doesn't rule it out.
6. Admin replies to alerts that weren't saved become referrals: the LLM may create a deal and email whatever address it extracts.
7. The admin has no command to reopen a deal, override an identity clash, or lift `admin_controlled`.

## Where `vienna-ip-specification.md` (§II–III, §V) is contradicted

| Spec | Claim | Code |
|---|---|---|
| II.2, III.1 | `POST /webhook` | `/webhook/inbound` |
| II.1/II.2/III.2 | OCR for images and scanned docs | No OCR. pdf-parse + AcroForm only; images only get a 50-token LLM classification (`ai.js:3851`) |
| II.2 | Matching by In-Reply-To | Also by References, against outbound IDs only |
| II.3 | Non-Canadian → `rejected` | No deal row (3113-3142) |
| II.3/III.7 | Override → `active`, deal then proceeds | The draft appears unsendable via SEND; the deal can go back to `awaiting_collateral` (4480); the override fields are never read |
| II.3 | List of transitions | Missing: admin decision + SEND → `active`/`rejected`/`completed`; auto-completion with no admin step. `admin_controlled` isn't mentioned |
| III.1 | Sender classification includes mailer-daemon/no-reply | Address denylist is a substring list without mailer-daemon; display-name check on first contact only |
| III.1 | Otherwise a new deal is created | Intake filter, duplicate check and non-Canadian decline all exit with no deal; an admin email with no thread becomes a referral |
| III.4 | Gates don't consume LLM numbers | LLM LTV is a fallback (3511, 4475); LLM `identity_clash`, `exit_strategy`, `misattached_documents`, `unresolved_discrepancy` feed gates; LLM classifiers decide dispositions |
| III.7 | Admin override by email | Only works if the admin's reply threads to the deal; the admin gets no email while the deal is on hold |
| V.2 | Lines ~3290–3385; "otherwise toward prelim" | 3502-3623. The preliminary review needs a reviewable doc and no discrepancy; the welcome is always sent first |
| V.3 | Q9 at `webhook.js:2495` | 2495 is `executeDraft`'s `completed` line; Q9 is 2649-2709 |
| V.3 | Updated review "where material" | `ltv_escalated` always re-sends |
| V.4 | Waits for state to stabilize | No such wait in production. Only the 2 s wait in `sendCompletionHandoff` (1939) and a 50 ms pdf retry. "Settle window" exists only in the test harness. There's no per-deal lock, and emails are processed concurrently |
| V.5 | General graceful-degradation statement | Actual behavior: 200 is sent first, so Postmark never retries; only the referral and new-deal branches alert the admin; everything else is only logged |