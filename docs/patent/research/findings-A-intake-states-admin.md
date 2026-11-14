# Findings A: email intake, sender classification, deal correlation, deal state machine, admin loop

**Code version:** HEAD of branch `vienna-hardening-2026-11` (latest commit `425715d`). This updates the earlier version written against `edae488`. Every line reference below was checked against the current code. Nothing was changed and nothing was run.

**Scope:** module 1 (intake and sender classification), module 2 (deal correlation and threading), module 8 (deal state machine and reply routing), module 11 (the admin/underwriter loop).

**How to read the claims:**
- Behaviour described here comes from reading the code.
- When a commit message reports a test result (for example "Harness f7 8/8"), that is the commit author's claim. I did not reproduce it.
- **[NEW]** marks something added or found since `edae488`.
- **FIXED (commit)** and **STILL OPEN** mark the status of each item from the earlier version.

---

# Summary

**What changed in this area since `edae488`:**

1. **Choice of email provider, and a new way to match replies** (`000df09`, `de1bf44`, `5cca716`)
   - A new file, `src/lib/mailer.js`, sends mail through either Postmark (the default) or Resend.
   - Resend's mail server replaces any Message-ID Vienna sets. So in Resend mode each outbound email gets a Reply-To address with a code built in: `local+<uuid>@domain`.
   - A new route, `POST /webhook/resend` (in `src/lib/resendInbound.js`), receives incoming Resend mail. It checks the webhook signature, fetches the email body, attachments and raw headers, and turns the code in the address back into an In-Reply-To header. The existing matching then works unchanged.
2. **Intake hardening**
   - **Login on the inbound route:** optional Basic auth on `POST /webhook/inbound` (`INBOUND_WEBHOOK_AUTH`, `5bfcdd6`).
   - **Duplicate check that survives a restart:** incoming Message-IDs are now saved, and a duplicate is looked up in the database (`5bfcdd6`).
   - **Sender blocklist matches whole addresses:** `isIgnoredSender` replaces the old substring match, and mailer-daemon, postmaster and donotreply are added (`fff4237`).
   - **Admin replies to Vienna's own alerts:** these are now ignored instead of being treated as referrals (`fff4237`).
3. **Correlation**
   - The link-only holding reply, the admin link handoff, the admin-controlled forward, the over-90% auto-decline and its admin alert are all saved with Message-IDs now (`fff4237`, `340d33b`).
   - So replies to them now match back to the deal.
4. **State machine**
   - **No collateral loop after approval:** `shouldHoldForCollateral` stops an approved or overridden deal from going back into the collateral hold (`8034934`).
   - **Q9 override is reachable and sendable:** `isDraftAwaitingAdmin` makes the Q9 drafts sendable (`8034934`). `sendCollateralHoldNotice` gives the admin an email they can reply APPROVED to (`340d33b`).
   - **Gates on follow-ups:** `evaluateFollowUpLtvGates` runs the over-90% decline and the incomplete-data check on follow-up emails (`340d33b`).
   - **One email when declined:** a first email that will be auto-declined gets only the decline, with no welcome (`340d33b`).
   - **Collateral re-ask fixed:** the dedicated re-ask that could never run now fires, using a marker for ambiguous replies (`4313090`).
   - **Failed-intake cleanup:** it no longer deletes a deal once the welcome has been queued (`9a68074`).
5. **Admin loop:** the two wrong comments were corrected (`4313090`). Q9 drafts are sendable. The admin now gets emails during the collateral hold, so the override path can actually be used.

**Still open from the earlier version:**
- `isAdmin` is still a substring match on an unauthenticated From address.
- Both webhook authentication checks do nothing if their secret isn't set.
- The two completion paths still differ: the admin-approved path has no [File Complete] notice, zip or lender package.
- Classifier answers are still mapped by substring, so "NOT APPROVED" counts as approved.
- `generateAdminResponseEmail` still labels admin messages `[BROKER]`.
- The REPLACE "byte-for-byte" comment is still untrue.
- Under `under_review` with a draft pending, an incomplete file still triggers `preliminary-update`.
- There is still no admin command to reopen a deal, override an identity clash, or lift `admin_controlled`.
- The three separate sources for the admin's first name are unchanged.

**New problems visible in the current code** (found by reading, not running):
- **(a) A Q9 *conditions* draft sent while the deal is still `awaiting_collateral` stamps `prelim_approved_at`.** Through F1 and F3, that later turns off both the collateral hold and the over-90% auto-decline for the deal.
- **(b) New admin-only alerts are treated as part of the broker conversation.** The newly saved alerts ([On hold — awaiting collateral], [Admin-controlled deal], [Stalled], [LTV over 90% after approval]) and their preview replies don't match `isAdminFacingSubject`. So they count as broker-thread outbounds in the reply headers, and they appear as "OUTBOUND from Vienna" in the history given to the LLM.
- **(c) The model's LTV estimate can trigger an auto-decline.** On first emails and now on follow-ups, the over-90% decline still accepts the model's `ltv_percent` when Vienna can't compute the LTV itself. That decline goes to the broker with no admin preview.
- **(d) Vienna's own address may not be blocked.** The self-entry in the blocklist fails if `EMAIL_FROM` is written as `Name <addr>`.
- **(e) The post-approval >90% alert has no once-per-deal guard.**
- **(f) A failure in the Resend adapter, or a failed welcome send, is only logged.**

**A correction to the earlier version's summary:** it said the identity-clash check "relies on the LLM's identity_clash flag alone". That was already wrong at `edae488`. A deterministic check, `isIdentityClashByAbsence` (`ai.js:686`, called at `ai.js:2515`), can set `identity_clash=true` before any LLM call. `15d30f3` narrowed it so that names read from an email address are weak evidence.

---

# Full findings

## 0. Map of `src/routes/webhook.js` (5,105 lines)

**Routes** (mounted at `routes/index.js:7`):
- `POST /webhook/inbound`, at `webhook.js:5025`: `requireInboundAuth` (5015-5024), then `handleInbound`. **[NEW]**
- `POST /webhook/resend`, at `webhook.js:5030-5045` **[NEW]**:
  - Checks the signature (5031-5034). A failure returns 401.
  - Returns 200 (5035).
  - Ignores events whose type isn't `email.received` (5036).
  - Builds a Postmark-style payload with `toPostmarkPayload` (5038), then calls `handleInbound` with a stub response (5041). An error is only logged (5043).
- Both routes are always mounted, whatever `EMAIL_PROVIDER` is set to.
- `src/index.js:10` keeps `req.rawBody` for the signature check. The JSON size limit is 50 MB.

**Helpers before the handler:**

| Lines | Helper |
|---|---|
| 41 | `processedMessages` Set |
| 53-56 | `ADMIN_FIRST_NAME` |
| 60 | `isUnreliableName` |
| 73 | `firstNameMatchesAdmin` |
| 101 | `shouldSkipIntakeFormsForDeferredState` |
| 131 | `computeIntakeAskedItems` |
| 164 | `eligibleDocsForGate` |
| 193 | `labelMessagesForLeadSummary` |
| 241 | `brokerRepliedSinceLastViennaOutbound` |
| 271 | `buildPreviewThreadChain` |
| 309 | `buildBrokerThreadInputs` |
| 416 | `shouldHoldPrelimForDiscrepancy` |
| 443 | `computeWillReview` |
| 495 | `computeStillMissingForReview` |
| 583-686 | `classifyIntakeBorrower` |
| 701-743 | `sendDuplicateAlertToAdmin` |
| 761-779 | `sendBrokerAcknowledgmentOnReject` |
| 831 | `isPostApprovalAmlPepPending` |
| 863-896 | `extractDeclineReason` |
| 959 | `computeCompletionDispatch` |
| 969-1007 | `normalizeSenderName` |
| 1022 | `textToHtml` |
| 1039-1097 | `sendEscalationToAdmin` (sets `ltv_escalated` at 1095) |
| 1147 | `computeAdminBanner` |
| 1207 / 1271 | Canonical LTV and lender resolvers |
| 1288-1607 | `sendPreliminaryReviewToAdmin` (sets `under_review` at 1603; P1 snapshot at 1602) |
| 1661 | `sendAdminMaterialCorrectionNotice` |
| 1742-1801 | `buildReviewSnapshotParts` **[NEW, F14]** |
| 1803-1860 | `buildCompletionLenderPackage` |
| 1862-2073 | `sendCompletionHandoff` (2 s wait at 1974; sets `completed` at 2071) |
| 2109 | `decideReviewDispatch` |
| 2171-2182 | `sendCollateralHoldNotice` **[NEW]** |
| 2190-2204 | `evaluateFollowUpLtvGates` **[NEW]** |
| 2212-2225 | `isIgnoredSender` **[NEW]** |
| 2228-2229 | `SYSTEM_ALERT_SUBJECT_RE` / `isReplyToSystemAlert` **[NEW]** |
| 2234-2261 | `buildThreadFacts` **[NEW]** |
| 2264-2277 | `recordFactSnapshot` **[NEW]** |
| 2281-2286 | `q10PriorFacts` **[NEW]** |
| 2290-2297 | `sweepBrokerFacing` **[NEW]** |
| 2304-2325 | `sendAutoDecline` **[NEW]** (sets `rejected` at 2320) |
| 2334-2339 | `isDraftAwaitingAdmin` **[NEW]** |
| 2344-2347 | `shouldHoldForCollateral` **[NEW]** |

**`handleInbound` (2349-5011), in the order it runs:**

| Lines | Stage |
|---|---|
| 2351 | Return 200 |
| 2358 | `parseInboundEmail` |
| 2371-2374 | Database duplicate check **[NEW]** |
| 2375-2383 | In-memory duplicate check |
| 2403-2423 | Sender blocklist (`isIgnoredSender`) |
| 2433-2439 | Advisory "looks like a broker" check (logs only) |
| 2441-2462 | Thread correlation |
| 2467 | `isAdmin` |
| 2483-2509 | `admin_controlled` pause |
| 2511-3044 | Admin reply on a matched deal: draft review 2632-2780, decisions by status 2784-3042 |
| 3051-3054 | Admin reply to a system alert with no matching deal → ignored **[NEW]** |
| 3056-3238 | Admin email with no thread → referral |
| 3240-3911 | New deal |
| 3913-5005 | Existing deal: identity 3942 → collateral 4005 → `ltv_escalated`/`under_review` 4060-4343 → `active` 4344-5002 → other statuses 5003 |
| 5008-5010 | Outer catch (log only) |

---

## Module 1 — Email intake and sender classification

**Purpose:** Take an inbound email from either provider and turn it into one common payload. Then:
- authenticate the webhook, when that is configured
- drop duplicates, machine mail and internal mail
- tell the admin apart from outside senders
- filter out non-deal senders before a deal record is created

**Inputs:**
- **Postmark JSON:** From, FromName, To, Subject, TextBody, HtmlBody, Attachments (base64), MessageID, Headers, Date.
- **[NEW] Resend `email.received` event:** metadata only. The adapter then fetches:
  - the body: `GET /emails/receiving/{id}`
  - the attachments: `GET /emails/receiving/{id}/attachments`, then each `download_url`
  - the raw RFC 822 message, for its headers

  (`resendInbound.js:62-104`)
- **Config** (`src/config/index.js`):
  - `ADMIN_EMAIL` (11)
  - `INBOUND_WEBHOOK_AUTH` (13)
  - `EMAIL_PROVIDER` (3, 15)
  - `EMAIL_FROM`, falling back to `POSTMARK_SENDER_EMAIL` (6, 16, 27)
  - `EMAIL_REPLY_TO` (19)
  - `MESSAGE_ID_DOMAIN`: for Resend it defaults to the domain of `EMAIL_FROM`, with any angle brackets parsed out; otherwise `mtasv.net` (21)
  - `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` (30-31)

  These names are listed in `.env.example`. I didn't read `.env`, so whether each one is actually set in production is unknown.

**Processing:**

1. **Webhook authentication [NEW]**
   - **Postmark route:** `requireInboundAuth` (`webhook.js:5015-5024`) decodes the `Authorization: Basic` header and compares it to `INBOUND_WEBHOOK_AUTH` with `crypto.timingSafeEqual`, after a length check. A mismatch returns 401.
     - **It does nothing if the variable isn't set** (5017).
     - Commit: `5bfcdd6`.
   - **Resend route:** `verifySignature` (`resendInbound.js:24-35`) is a Svix-style HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${rawBody}`, keyed with the base64-decoded `whsec_` secret. It rejects timestamps more than 300 s off, and compares in constant time against each `v1,` signature.
     - **It returns `true` if `RESEND_WEBHOOK_SECRET` isn't set** (26).
     - Commit: `000df09`.
2. **Converting Resend mail to the common format [NEW]** (`resendInbound.js:62-104`)
   - **From:** split into address and display name by `parseAddress` (38-41).
   - **Body:** `TextBody` is `email.text`, or `htmlToText(email.html)` if there is no plain text (54-60).
   - **MessageID:** Resend's receiving id (100).
   - **Headers:** only In-Reply-To, References and Message-ID are carried over from the raw headers (77-80).
   - **Reply code:** if `mailer.threadTokenFrom` finds a `+<uuid>@` code in To, `received_for` or Cc (74), it creates an In-Reply-To of `<uuid@MESSAGE_ID_DOMAIN>` (76). That replaces any raw In-Reply-To (79).
3. **Respond first:** the 200 goes out before any processing (2351; on the Resend route, 5035). So neither provider retries an email that fails during processing.
4. **Parse:** `parseInboundEmail` (`email.js:145-164`) is unchanged.
   - In-Reply-To is trimmed. References is split on whitespace.
   - Only `TextBody` is used downstream.
5. **Duplicate check [CHANGED]** — runs in two stages:
   - **(a) Database (2371-2374, new):** `dealsService.inboundAlreadyProcessed(messageId)` (`deals.js:354-364`) runs `SELECT id FROM messages WHERE direction='inbound' AND external_message_id=$1 LIMIT 1`. A lookup error is logged and treated as "not a duplicate", so the check fails open.
   - **(b) In memory (2375-2383):** the existing Set with a one-hour TTL.
   - **Why the database check works now:** all five places that save an inbound message now store `email.messageId`:
     - 2487 (admin-controlled pause)
     - 2513 (admin reply)
     - 3162 (referral)
     - 3386 (new deal)
     - 3918 (existing deal)

     Commit: `5bfcdd6`.
6. **Blocklist [CHANGED]** (2403-2423)
   - **Entries:**
     - `support@postmarkapp.com`, `noreply@`, `no-reply@`
     - `@anthropic.com`
     - **new:** `mailer-daemon@`, `postmaster@`, `donotreply@`, `do-not-reply@`
     - `@fyi.postmarkapp.com`, `@fsagent.com`
     - `gabriela@`, `brandon@` and `admin@vimarealty.com`
     - Vienna's own sending address, from `config.postmark.senderEmail`, which is now `EMAIL_FROM` (2418)
   - **How `isIgnoredSender` matches** (2212-2225): it takes the address out of `Name <addr>` and lowercases it. Then:
     - an entry starting with `@` matches that domain or any subdomain of it
     - an entry ending with `@` matches the exact local part
     - anything else must equal the full address
   - Commit: `fff4237` (F13).
   - `franco@vimarealty.com` is still deliberately allowed through (comment 2397-2402).
7. **Advisory broker check** (2433-2439). It looks for attachments, OR `Lic. #` in the body, OR a broker keyword in the subject. It only logs.
8. **`isAdmin`** is `email.from.toLowerCase().includes(ADMIN_EMAIL)` (2467). This is unchanged: a substring match on the From header, which nothing authenticates.
9. **Routing:**
   - admin + matching deal → admin loop (2511)
   - admin + no match + subject matches `isReplyToSystemAlert` → ignored (3051, **new**)
   - admin + no match → referral (3056)
   - non-admin + no match → new deal (3240)
   - non-admin + match → follow-up (3913), unless `admin_controlled` is set (2483)
10. **[NEW] The system-alert guard**
    - `SYSTEM_ALERT_SUBJECT_RE` (2228) matches any number of `Re:`/`Fwd:` prefixes followed by one of: `[Intake Filter]`, `[Out of Scope]`, `[Potential Duplicate]`, `[Auto-Decline]`, `[Admin-controlled deal]`, `[On hold — awaiting collateral]`, `[Stalled]`, `[LTV over N% after approval]`.
    - A second regex (2229) matches `New-client dispatch failed` and `Referral dispatch failed`.
    - `Referral missing email —` (3092) is deliberately *not* matched, because that alert asks the admin to reply with the address.
    - Commit: `fff4237` (F6).
11. **`classifyIntakeBorrower`** (583-686) is unchanged. It is called at 3108 (referral) and 3260 (new deal), and the first rule that matches wins:
    - An empty name → accept.
    - First name equals the admin's and there is no broker name → `reject:admin-as-borrower`, unless `parseBrokerFirstName(body)` finds a broker introducing themselves (`513e0da`).
    - The name matches a system-sender pattern → `reject:system-sender`.
    - The name has an organisation suffix and no human name → `reject:no-human-name`, unless the body names a broker.

    On any reject, the admin gets an `[Intake Filter]` alert (3134 / 3291). The two non-system reject types also send the sender a fixed acknowledgment (`sendBrokerAcknowledgmentOnReject`, 761-779; called at 3150 / 3307). No deal is created.
12. **`parseBrokerFirstName`** (`ai.js:1533`) is deterministic. It tries `parseBrokerFirstNameFromBodyProse` (`ai.js:1503`) first, then `parseBrokerFirstNameFromSignature` (`ai.js:1576`). The validator rejects "franco" (`ai.js:1474`).
13. **`selectGreetingFirstName`** (`greeting.js:44-58`) is unchanged. It compares against a hard-coded `ADMIN_FIRST_NAME = 'Franco'` (`greeting.js:31`).
14. **`normalizeSenderName`** (969-1007) is unchanged. It is called after each extraction (3575, 4031, 4083, 4181, 4481, 4664). The narrower `firstNameMatchesAdmin` check runs before the LLM (3473, 4409).
15. **`detectFileHostingLinksInBody`** (`linkDetector.js:77`) is unchanged and is called at 3399. It detects links only and never fetches them.
16. **Scrubbing at send time** (`email.js:23-71`)
    - The rules are unchanged: `stripAdminGreeting` and `stripAdminSignature` for any recipient who isn't the admin.
    - Sending now goes through `mailer.send` (`email.js:93, 121`) instead of the Postmark client.
    - `From` is now `config.email.from` (84, 113).
17. **`adminReply.js` subject regexes** are unchanged:
    - `ADMIN_REPLY_SUBJECT_RE` at line 66
    - `ADMIN_FACING_SUBJECT_RE` at line 82

    Neither covers the new bracketed admin-alert subjects (see open questions).

**Outputs:** one of:
- a 401
- a silent drop
- an ignored admin alert reply
- an admin alert, with an optional broker acknowledgment
- a normalized email passed to a branch

**AI use:**
- Intake is deterministic, except on the referral branch. The model everywhere is `claude-sonnet-4-6`, called through `callClaude` (`ai.js:38-51`): one user message, no system prompt or temperature, and up to 3 retries on HTTP 429 only.
- **`parseReferralEmail`** (`ai.js:4842`, 512 tokens) returns JSON `{referred_name, referred_email, sender_type, deal_details, notes}`.
  - **Checks:** a leading code fence is stripped, then `JSON.parse`.
  - **Fallback:** if `referred_email` is null, `regexExtractReferralEmail` (`ai.js:4904-4919`) takes the first address that isn't the admin's, Vienna's (`config.postmark.senderEmail`), or a system prefix.
  - **What its output decides:** who receives the welcome (3180), and the new deal's `email`, `borrower_name` and `sender_type` (3155, 3191-3200).
  - **Checks it skips:** referrals don't go through the duplicate check or the non-Canadian check.
- **`generateReferralWelcomeEmail`** (`ai.js:4922`, 512 tokens) only has its fence stripped (`ai.js:4968`). There is no routing-leak sweep.
  - It is sent with both PDF forms and CCs the admin (3180-3188).
  - It is saved with its Message-ID (3189).
  - `referred_by: 'Franco Maione'` is still hard-coded (3198).

**Errors and correction:**
- **Duplicates:** the database check now catches redeliveries of any email whose inbound row was saved, including after a restart (`5bfcdd6`).
  - **Gap:** emails dropped before a deal exists are never saved: intake filter, duplicate, non-Canadian, system-alert reply, blocklist. Those still rely on the in-memory Set.
- **Admin alerts on failure:** only the referral branch (ZZZ, 3212-3235) and the new-deal branch (FFFF, 3869-3910) alert the admin on failure. Everything else, including any Resend adapter failure (5042-5044), is only logged.
- **[NEW] FFFF teardown (`9a68074`):**
  - `welcomeQueued` (declared at 3256) is set to true just before the welcome is queued (3668).
  - If a later step fails, the catch keeps the deal (3875-3877) and the admin alert says the broker was welcomed (3894-3896).
  - Otherwise the half-built deal is deleted (3878-3884).
- **`sendEmailDelayed`** (`email.js:103-128`) is still fire-and-forget (`setTimeout` with 0 ms), and a send failure is only logged. So if the *welcome* send itself fails, the deal is kept (`welcomeQueued` is already true), the broker gets nothing, and nobody is alerted.

**Technical problems solved:**
- Earlier fixes, unchanged: junk-deal blocklist `caf885a`; "Hi Franco" layers `66c8d2a` / `58066a6` / `6b5657c` / `ffa24d3`; signature scrub `904c068`; intake classifier `fd469f5` / `513e0da`; link detection `86605a9`.
- **[NEW] Spoofed or forged inbound POSTs:** optional Basic auth (`5bfcdd6`) and Svix signature check (`000df09`).
- **[NEW] Duplicate processing after a restart or redelivery:** saved inbound IDs plus a database lookup (`5bfcdd6`).
- **[NEW] Substring blocklist mistakes:**
  - `@email.anthropic.com` slipped past `@anthropic.com`, and a marketing email became a deal.
  - Bounces weren't in the address list.

  Both fixed by matching on the parsed address and on domains (`fff4237`).
- **[NEW] Admin replies to Vienna's own alerts were parsed as referrals.** These could create a deal and email whatever address the model pulled out (`fff4237`).
- **[NEW] Dependence on Postmark (account-owner dependency):** sending can now switch providers, and the Resend inbound adapter feeds the same handler unchanged (`000df09`).

**Open questions:**
- **Authentication can still be bypassed if the secrets aren't set.**
  - Both checks do nothing when their environment variable is missing.
  - `/webhook/inbound` stays mounted even when the provider is Resend.
  - Even with authentication on, `isAdmin` trusts an unauthenticated From header: there is no SPF/DKIM check, and Resend's verdicts aren't consulted.
  - **STILL OPEN** (partly addressed by `5bfcdd6` / `000df09`).
- **Substring blocklist.** **FIXED** (`fff4237`).
- **mailer-daemon missing from the address blocklist.** **FIXED** (`fff4237`, line 2407).
- **[NEW] Vienna's own address may not be blocked.**
  - The self-entry pushed at 2418 is the raw `EMAIL_FROM` string. If that is written as `Vienna <vienna@domain>` (which `de1bf44` explicitly supports), the entry has no leading or trailing `@`, so `isIgnoredSender` compares the whole string to a bare address and never matches.
  - The `EMAIL_REPLY_TO` receiving address isn't in the list at all.
  - The same bracketed-value issue affects the self-exclusion in `regexExtractReferralEmail` (`ai.js:4912`).
- **The admin's first name has three separate sources.** **STILL OPEN:**
  - the `ADMIN_EMAIL` local part (`webhook.js:53-56`)
  - `'Franco'` (`greeting.js:31`)
  - `'franco'` (`ai.js:1474`)
- **[NEW] Thread code location is loose.** The Resend adapter takes the first `+<uuid>@` code from To, `received_for` *or Cc* (`resendInbound.js:74`). Nothing checks that the code came from Vienna's own Reply-To domain.

---

## Module 2 — Deal correlation and threading

**Purpose:** Decide whether an email continues an existing deal or starts a new one, prevent duplicate deals, and set reply headers on outbound mail so that later replies can be matched.

**Processing:**

1. **In-Reply-To** (2443-2448)
   - `findByMessageId` (`deals.js:366-388`) strips `<>` and everything from `@` onward.
   - It then looks in `messages` for `external_message_id = cleaned` with **`direction='outbound'`**, limit 1, and loads that deal.
2. **References fallback** (2450-2458): each id is tried in header order, one query per id.
3. **No match means a new deal** (2459-2462). `findActiveByEmail` (`deals.js:192`) and `getAllMessageIdsForThread` (`deals.js:438`) are still never called from `src/`.
4. **[NEW] Resend reply codes** (`000df09` → `5cca716`)
   - **Why:** Resend's mail server (SES) replaces Vienna's Message-ID. The commit reports seeing this live: the id arrived as `<…@email.amazonses.com>`. So a reply's In-Reply-To can never match a stored id.
   - **On send:** `sendViaResend` (`mailer.js:38-62`) creates a `crypto.randomUUID()`. It sets `reply_to = replyToWithToken(EMAIL_REPLY_TO, uuid)` (`mailer.js:21, 53`), which turns `local@d` into `local+uuid@d`. It returns `{ MessageID: uuid }`.
   - **Storage:** every caller saves that uuid as `messages.external_message_id`, the same as Postmark's bare uuid (`mailer.js:10`).
   - **On receive:** the adapter turns the code back into `In-Reply-To: <uuid@MESSAGE_ID_DOMAIN>` (`resendInbound.js:74-76`), and step 1 matches it.
   - **Without `EMAIL_REPLY_TO`:** in Resend mode, no reply code is added and replies cannot be matched.
5. **[NEW] `mailer.messageIdHeader`** (`mailer.js:18`) replaces the four hard-coded `@mtasv.net` suffixes. It is used at:
   - 2038 (completion handoff)
   - 2577 (admin preview)
   - 2651 (`executeDraft`)
   - `dailySummary.js:279`
6. **Duplicate check before creating a deal** (broker path only, 3328-3337). Unchanged:
   - `cFields.extractFromEmailBody` pulls an address.
   - `findExistingDealForBorrower` (`deals.js:231-243`) loads all deals with the same email.
   - `decideExistingDealMatch` (`deals.js:854-897`) checks open deals before closed ones and skips closed deals more than 90 days old (`TEMPORAL_CARVEOUT_DAYS`, `deals.js:804`). If either side has no address, it moves on.
   - `propertyFuzzyMatch` (`deals.js:835-848`) uses `canonicalizeProperty` (`deals.js:811-827`): postal-code prefix (FSA) plus street number, or street number plus 3 street words.
   - On a match, `sendDuplicateAlertToAdmin` (701-743) runs and the function returns. The sender gets nothing.
7. **Outbound threading**
   - **Admin previews** (2577-2590): In-Reply-To is set to the admin's message. References come from `buildPreviewThreadChain`, which combines Vienna's saved outbound IDs, the admin's References and the admin's ID.
   - **Broker sends** (`executeDraft` 2647-2668, completion handoff 2036-2045): use `buildBrokerThreadInputs` (309-320), which drops messages where `isAdminFacingSubject` matches.
8. **[NEW] Outbounds now saved with Message-IDs** (`fff4237`, `340d33b`, `eb0b8d3`):

   | Outbound | Where saved |
   |---|---|
   | Admin-controlled forward | 2507 |
   | Link-only holding reply | 3425 |
   | Admin link handoff | 3444 |
   | Auto-decline to broker | 2319 |
   | `[Auto-Decline]` admin alert | 2324 |
   | `[On hold — awaiting collateral]` notice | 2181 |
   | `[LTV over 90% after approval]` alert | 4863 |
   | `[Stalled]` alert | `dailySummary.js:64` |

9. **[NEW] Fact snapshots** (`d6ec8c7`) are saved as `messages` rows with `direction='system'`, through `saveFactSnapshot` (`deals.js:338`). `getMessages` and `getRecentMessages` exclude them (`deals.js:396, 719`). Correlation and duplicate lookups filter on `outbound` / `inbound`, so snapshots can't collide with them.

**AI use:** None. Correlation is fully deterministic.

**Errors:** A "no rows" result (PGRST116) returns null (`deals.js:381`). Other database errors go to the outer catch and are only logged. `inboundAlreadyProcessed` fails open (`deals.js:362`).

**Technical problems solved:**
- Earlier fixes still apply: Message-ID normalization; References anchored in the database (`ba6a856`); the broker-only slice for reply headers (`0fd3c4f`); the cross-status duplicate check (`d6f3b80`).
- **[NEW] Reply matching under a mail server that rewrites Message-IDs:** a token carried in the Reply-To address is turned back into a synthetic In-Reply-To at intake, so the existing outbound-ID lookup works unchanged for both providers (`5cca716`).
- **[NEW] Replies to the holding reply, the decline and admin alerts now match the deal** (`fff4237`, `340d33b`).

**Open questions:**
- **Outbounds saved without a Message-ID:**
  - **FIXED** for the link-only holding reply, the admin link handoff, the admin-controlled forward, the over-90% decline and the [Auto-Decline] alert (`fff4237`, `340d33b`).
  - **STILL unsaved**, all at points where no deal exists, except as noted:
    - `[Potential Duplicate]` (735) — a deal *does* exist, but the alert isn't saved on it
    - `[Intake Filter]` (3134, 3291)
    - `[Out of Scope]` (3367)
    - the **non-Canadian decline to the broker** (3361)
    - the broker acknowledgment on reject (771)
    - ZZZ/FFFF alerts (3225, 3900), including the FFFF alert when the deal was *kept*
    - `Referral missing email` (3090)
  - Admin replies to these are now ignored (by the guard) rather than turned into referrals. But a broker replying to the non-Canadian decline or the reject acknowledgment still starts a new submission.
- **Replies that only reference the broker's own earlier email still don't match.** Inbound IDs are saved now, but `findByMessageId` only searches outbound rows (`deals.js:377`). Also, the saved inbound id is the provider's id (Postmark MessageID or Resend email id), not the RFC Message-ID the broker's mail client would cite. **STILL OPEN.**
- **The duplicate check doesn't run for referrals,** and it needs regex to find an address in the body. **STILL OPEN.**
- **A legitimate new email about the same property is blocked with no reply to the broker.** **STILL OPEN.**
- **[NEW] Outbound threading under Resend (inferred from the commit's finding, not tested).** In Resend mode, the In-Reply-To/References headers Vienna puts on outbound mail point at `<uuid@MESSAGE_ID_DOMAIN>` ids that never existed on the wire, because SES rewrote them. So the broker's and admin's mail clients can only group Vienna's emails by subject. Correlation on Vienna's side is unaffected.
- **[NEW] Admin alerts treated as broker conversation.** `buildBrokerThreadInputs` keeps every message whose subject doesn't match `isAdminFacingSubject` (310). None of the new bracketed admin-alert subjects match it, and neither do their `Re: …` preview replies:
  - `[On hold — awaiting collateral]`
  - `[Admin-controlled deal]`
  - `[Stalled]`
  - `[LTV over 90% after approval]`
  - `[Auto-Decline]`

  So an admin-only alert or a Q9 preview can become the broker-facing `latestMessageId` (In-Reply-To) or appear in References on `executeDraft`, completion or reminder sends. This affects headers only; no alert text goes to the broker.

---

## Module 8 — Deal state machine and reply routing

**Schema:**
- **Unchanged:** `src/migrations` only adds `intake_asked_items`, `prelim_approved_at`, `admin_controlled`, `aml_pep_requested_at` and `daily_summaries`. `status` is free text.
- **[NEW]**
  - `collateral_override_at/by` and `collateral_offered` live inside `extracted_data` (JSON).
  - `_ambiguousCollateralReply` is a flag kept only in memory, never saved.
  - Fact snapshots use `direction='system'` rows, with no schema change (`d6ec8c7`).

**Status values and where they are set:**

| Status | Set at |
|---|---|
| `active` | `deals.js:249`; `webhook.js` 2685, 2891, 3193, 3684, 3972, 4042 |
| `awaiting_identity_confirmation` | 3799 |
| `awaiting_collateral` | 3832, 4895 |
| `ltv_escalated` | 1095 |
| `under_review` | 1603, 5000 (FINAL REVIEW path, marked as unreachable) |
| `rejected` | 2320 (`sendAutoDecline`), 2688 |
| `completed` | 2071, 2716 |

- The earlier `active` write at 4621 was removed (F12, `4313090`).
- `admin_controlled` is set only at 3404, and nothing clears it (**STILL OPEN**).

**Thresholds [NEW]** (`43d45a8`): `src/config/thresholds.js`:
- `LTV_ESCALATION_PCT = 80`
- `LTV_AUTO_DECLINE_PCT = 90`
- `LTV_ELEVATED_BAND_PCT = 75`

Comparisons are strict. The values are unchanged.
- **Residual hard-coded literals:**
  - The escalation subject `ACTION REQUIRED: LTV Over 80%` (1086).
  - `discrepancy-engine.js` uses its own `AUTO_DECLINE_LTV_THRESHOLD_PCT` inside `shouldAutoDeclineOver90` (`discrepancy-engine.js:626-634`). I didn't check whether that constant reads `thresholds.js`.

**New deal** (status `active`):

1. **Before any welcome is sent:**
   - The early exits: intake filter, duplicate, non-Canadian (3346-3376), link-only (3399-3447).
   - Then `processInitialEmail` (3529) and the exit-strategy backfill from the loan application (3576-3590).
2. **[NEW] F4 pre-decision** (3655-3664). It computes `_f4WillAutoDecline` from:
   - the canonical map built from this email plus the saved docs
   - the model's `ltv_percent` as a fallback (3659)
   - `!identity_clash`

   If the deal will be auto-declined, the welcome is skipped (3666-3667). Otherwise `welcomeQueued = true` and the welcome is queued (3668-3680).
3. Status `active` is saved with the summary (3683-3690). The intake fact snapshot is recorded (3693).
4. **The gate chain** (3796-3863), in order:
   1. **`identity_clash`** → `awaiting_identity_confirmation` (3797-3799). There is no admin email.
   2. **`_q2AutoDecline.decline`** (3774) → `sendAutoDecline` (3814-3818). It:
      - writes the decline with the LLM and runs the broker-facing sweep (F5)
      - sends it to the broker with no admin preview
      - saves it with its Message-ID
      - sets status `rejected`
      - sends the admin an `[Auto-Decline]` alert, also saved with its Message-ID
   3. **Escalation** (standalone or combined LTV over the threshold, OR the BUG-4 incomplete-data check) → `awaiting_collateral` (3832) **plus `sendCollateralHoldNotice`** (3833, **new**). The notice is an admin FYI that says "reply APPROVED… DECLINE with a reason". It is sent only once per deal (2177).
   4. **Standalone LTV ≤ 80 and a reviewable doc** → if `shouldHoldPrelimForDiscrepancy` says hold, the deal stays `active`. Otherwise `sendPreliminaryReviewToAdmin` (3859).

**Existing deal.** The message is saved with its id and `reminder_count` is reset (3918-3921). Attachments are saved (3923-3927). Then the handlers run in a fixed order:

- **Identity** (3942-4002), using `parseIdentityClarification`. Unchanged:
  - `resolved` → `active`, `identity_clash=false`, `was_in_identity_clash=true`, and `borrower_name` if a name was extracted (3965-3977).
  - `unresolved` → `active` in memory only, so the active handler asks again.
- **Collateral** (4005-4058):
  - `parseBrokerCorrections` runs first. If it finds a correction, the status becomes `active` in memory (4019-4022).
  - Otherwise `parseCollateralReply`:
    - `no` → `sendEscalationToAdmin` (status becomes `ltv_escalated`), nothing to the broker, return.
    - `yes` → `active` + `collateral_offered=true` saved.
    - `ambiguous` → `active` in memory **and `_ambiguousCollateralReply = true`** (4055, F12).
- **`ltv_escalated` / `under_review`** (4060-4343): `generateBrokerResponse`, then `decideReviewDispatch` (2109-2132). The logic is unchanged:
  - **`under_review` with a complete file:**
    - draft pending → `noop`
    - no new docs → `text-only-noop`
    - `prelim_approved_at` set → `completion-handoff`
    - otherwise → `preliminary-update`
  - **`ltv_escalated`** → `escalation-update`.
  - **`under_review` with an incomplete file:**
    - no new docs → `text-only-noop`
    - otherwise → `preliminary-update`
  - **[CHANGED] Q10 and Path B now compare structured facts.** They diff code-built thread facts (`buildThreadFacts`, 2234-2261) against the snapshot saved when the preliminary review went out (`q10PriorFacts`, 2281-2286). If that snapshot doesn't exist, they fall back to parsing the review email's HTML. This applies to all five material fields (4283-4286, 4316-4317; `d6ec8c7`).
- **Active** (4344-5002):
  - The post-clash intake template still applies (4381-4474).
  - Otherwise `generateBrokerResponse` (4592) runs with **`ltv_admin_cleared`** (4482, F1). That flag tells the prompt not to bring up the LTV threshold or collateral again.
  - **The R10-C-1 dedicated re-ask** now fires when `_ambiguousCollateralReply` is set and no collateral has been offered (4623-4630, F12).
  - **The gates:**
    - **The single-email canonical map** (4725-4738) gives `_r1ActiveLtvShouldEscalate`.
    - **[NEW] F3 gates** (4743-4750):
      - `_f3Map` is `extractCanonicalFieldsAggregated` over every inbound email plus all docs.
      - `evaluateFollowUpLtvGates` (2190-2204) returns `autoDecline` (over 90%), `incompleteEscalate` (BUG-4, suppressed once the admin has cleared the deal) and `adminCleared`. `adminCleared` is `prelim_approved_at || collateral_override_at`.
    - **`willGoToCollateralCheck`** = `shouldHoldForCollateral` (2344-2347, called at 4752). It requires `(escalate OR incompleteEscalate)`, `status === 'active'`, no collateral offered, no identity clash, **and not `adminCleared`** (F1).
    - **`willReview`** (`computeWillReview`, 443-460) is unchanged. It requires `!prelim_approved_at`.
    - **`computeCompletionDispatch`** (959-967) is unchanged.
    - **[NEW] F3 dispatch** (4847-4868), when `autoDecline.decline` is true and there is no identity clash:
      - If `adminCleared`: the admin gets a saved `[LTV over 90% after approval]` alert, and the reply continues as normal.
      - Otherwise: `sendAutoDecline(… turn: 'follow-up email')` runs, and the function returns, so Vienna's conversational reply is not sent.
    - **Collateral hold** → `awaiting_collateral` (4895) plus `sendCollateralHoldNotice` (4897).
    - **`willReview` / `preliminary-all-docs-in`** → preliminary review (4903, 4912).
    - **Otherwise:** the conversation continues. The status re-write that could never run was removed (F12).
    - **`completion-handoff`** → `sendCompletionHandoff` (4925-4933).
- **Other statuses** (`completed`, `rejected`) → nothing happens (5003-5004).

**AI use** (model `claude-sonnet-4-6`):
- **`parseCollateralReply`** (`ai.js:4415-4494`, 20 tokens). Unchanged.
  - `stripQuotedText` runs first. Ten anchored "no" regexes answer without the LLM.
  - Answer mapping: contains YES → yes; contains NO and not NOT → no; anything else → ambiguous. An error gives ambiguous.
  - **What the output can do:** trigger the silent escalation to the admin, set `collateral_offered`, or (new) set the marker that replaces Vienna's reply with the dedicated collateral re-ask.
- **`parseIdentityClarification`** (`ai.js:4640-4706`, 80 tokens).
  - Three regex shortcuts run first (`IDENTITY_FAST_RESOLVE_PATTERNS`, `ai.js:461-465`).
  - **The extracted name is still never checked against the two conflicting names.** It is written straight into `borrower_name` (3973-3976). **STILL OPEN.**
- **`identity_clash` sources (corrected):**
  - **Deterministic:** `isIdentityClashByAbsence` (`ai.js:686`, used at `ai.js:2515`). If it fires, the LLM's summary isn't used at all.
  - **The LLM's flag otherwise.**
  - `15d30f3` treats names derived from an email address as weak evidence. They only cause a clash if no part of the name relates to a word the broker wrote.
- **`generateBrokerResponse` / `processInitialEmail`** write the broker-facing text and the summary JSON. **What the LLM values still feed:**
  - **LTV fallback via `??`:**
    - 3659 (F4)
    - 3764 (first-email gates)
    - 4669 (`ltv`)
    - 4734 (active escalation)
    - 2194 (**new**, F3 auto-decline)

    P2 now logs whenever an estimate is used (3765, 4735), and labels the preliminary review "(est.)" (1585-1593).
  - **Flags read directly by gates:** the LLM's `identity_clash`, `exit_strategy`, `misattached_documents`, `unresolved_discrepancy`.
  - **`ltv_admin_cleared`** is *input* to the prompt (4482). It doesn't decide any gate.

**Errors and correction:**
- Classifiers still default to holding the deal.
- Status changes made only in memory avoid saving a state that hasn't been confirmed.
- `collateral_offered` and (new) `collateral_override_at` / `prelim_approved_at` prevent the collateral loop.
- Fact-snapshot failures are logged and skipped (2273-2276; `deals.js:343`).

**Technical problems solved:**
- Earlier fixes still apply: `ecb2eca`, `be193aa`, `54c45e6`, canonical LTV for gates, `7e10c04` / `699029a`, the discrepancy hold, FFFF `7de8c8e`.
- **[NEW] Collateral loop after approval or override** → `shouldHoldForCollateral` plus the `ltv_admin_cleared` prompt flag (`8034934`).
- **[NEW] The over-90% decline and incomplete-data check only ran on the first email** → `evaluateFollowUpLtvGates` over facts gathered from the whole thread (`340d33b`).
- **[NEW] Welcome followed by a decline** → the Q2 decision is made before the welcome (`340d33b`).
- **[NEW] Declines skipped the routing-leak sweep** → `sweepBrokerFacing` in `sendAutoDecline` and the Q7 decline (`340d33b`, 3356-3360).
- **[NEW] The admin got no email during the collateral hold** (so Q9 couldn't be reached) → `sendCollateralHoldNotice` (`340d33b`).
- **[NEW] The collateral re-ask couldn't run** → the ambiguous-reply marker (`4313090`).
- **[NEW] Material-change detection used the model's summary against three figures scraped from HTML** → code-built fact snapshots (`d6ec8c7`).
- **[NEW] Cleanup after a failed intake deleted deals whose broker had already been welcomed** → the `welcomeQueued` guard (`9a68074`).
- **[NEW] An identity clash was caused by a name read from an email address** → weak-evidence rule (`15d30f3`).

**Inconsistencies (from the earlier version, with current status):**

1. **The R10-C-1 check sat inside the `active` branch and could never run.** **FIXED** (`4313090`): it now checks `_ambiguousCollateralReply` (4623).
2. **A status check at the old line 4620 could never be true.** **FIXED** (`4313090`): removed (4914-4916).
3. **Approved or overridden high-LTV deals went back into `awaiting_collateral`.** **FIXED** (`8034934`): `shouldHoldForCollateral` (2344-2347). `collateral_override_at` is now read at 2191, 2338, 2345 and 4482.
4. **An over-90% deal got a welcome and then a decline.** **FIXED** (`340d33b`): 3655-3681.
5. **A non-Canadian property never becomes `rejected`**, because no deal row is created (3346-3376). **STILL TRUE** (by design).
6. **A deal only reaches `ltv_escalated` after the broker says "no" to the collateral question.** **STILL TRUE** (4027-4034).
7. **Under `under_review` with a draft pending, a broker reply with new docs on an incomplete file still gives `preliminary-update`.** Only the complete-file case checks `draft_email` (2115). **STILL OPEN.**

**New problems found in the current code** (by reading, not running):

- **N1. A Q9 *conditions* draft stamps `prelim_approved_at` while the deal is still on collateral hold.**
  - `isDraftAwaitingAdmin` accepts `awaiting_collateral` drafts (2336). `executeDraft`'s conditions branch stamps `prelim_approved_at` and leaves the status as it is (2737-2743).
  - After that, `adminCleared` is true. So `shouldHoldForCollateral` no longer holds the deal, and `evaluateFollowUpLtvGates` sends the admin an alert instead of auto-declining.
  - The result: once a "yes" or ambiguous collateral reply moves the deal to `active`, it can proceed to completion even though the admin never gave an APPROVED answer.
- **N2. The model's LTV estimate can trigger an auto-decline.**
  - `shouldAutoDeclineOver90` (`discrepancy-engine.js:626-634`) treats any finite `standaloneLtv` above 90 as a decline.
  - When Vienna can't compute the LTV, the value passed in is the model's `ltv_percent` (3659, 3764, 2194).
  - That decline goes to the broker with no admin preview. The admin alert says "(canonical LTV…)" (2322), which is wrong in that case.
- **N3. The escalation and the decline use different data.** The escalation decision uses the single-email map (4725-4738). The F3 decline and the figures in the hold notice use the map aggregated over the whole thread (4743-4750, 4897). So the hold notice can show different LTV figures from the ones that caused the hold.
- **N4. The post-approval >90% alert repeats.** `[LTV over 90% after approval]` (4848-4854) has no once-per-deal guard, so every follow-up that stays over 90% re-alerts the admin.
- **N5. A stale draft can be sent by mistake.** Drafts are only cleared by `executeDraft`. If a Q9 draft is pending and the broker's "no" moves the deal to `ltv_escalated` (1095), the admin's next reply to the escalation enters the draft-review branch. A SEND there sends the stale Q9 draft.

---

## Module 11 — Underwriter (admin) loop

**Processing:**

1. **The admin message is saved, now with its id** (2513).
   - There is still no separate audit table. The audit trail is the `messages` rows plus these fields:
     - `prelim_approved_at`, `conditions_sent_at`, `aml_pep_requested_at`
     - `extracted_data.collateral_override_at/by` (now read: 2191, 2338, 2345, 4482)
     - `_q10_admin_renotified_*`
   - **[NEW]** The `direction='system'` fact snapshots add an append-only record of the deal's facts at intake, at the preliminary review, and on each change.
2. **Is a draft under review?** `isDraftAwaitingAdmin` (2334-2339, used at 2632), **[NEW, F2 `8034934`]**. It returns true when `draft_action` is set and one of these holds:
   - the status is `ltv_escalated`, `under_review` or **`awaiting_collateral`**
   - the status is `active` and `draft_action === 'approval_completed'`
   - the status is `active` and **`collateral_override_at` is set**
3. **`parseDraftReply`** (`ai.js:4353-4412`). Unchanged:
   - `stripQuotedText` (`ai.js:4243-4273`) runs first.
   - REPLACE is decided by `isFullAlternativeDraft` (`ai.js:4336-4351`): at least 50 words, at least 2 paragraphs, and a first line that starts with a greeting.
   - Otherwise the LLM (20 tokens) answers SEND or EDIT. An error gives EDIT.
4. **What each answer does:**
   - **SEND** → `executeDraft` (2637-2746):
     - Reply headers come from the broker-only thread inputs and `mailer.messageIdHeader`.
     - The subject is "Re: <first broker subject>".
     - The email goes out through `sendEmailDelayed` and is saved with its id (2670-2681).
     - Then, by `draft_action`:
       - `approval_doc_request` → `active` (2685)
       - `rejection` → `rejected` (2688)
       - `approval_completed` → `completed` (2716)
       - otherwise (conditions) → status unchanged, and `conditions_sent_at` and `prelim_approved_at` are stamped if empty (2737-2743)
   - **REPLACE** → `textToHtml`, then preview again (2763-2764).
   - **EDIT** → `reviseEmailWithEdits` and `sweepBrokerFacingDraft`, then preview again (2772-2777).
5. **First reply (no draft pending):** `parseAdminReply` (`ai.js:4276-4334`).
   - Regex shortcuts first. Approval: approved / yes / go ahead / proceed / accepted. Rejection: reject / decline / deny / pass / kill.
   - Then the LLM (20 tokens) answers APPROVED, REJECTED or CONDITIONS. Answers are mapped by substring. An error gives conditions.
   - **`ltv_escalated`** (2784-2869):
     - approved → stamp `prelim_approved_at`, write a post-approval doc request (with AML/PEP consolidated into it), stamp `aml_pep_requested_at`, preview as `approval_doc_request`
     - rejected → `extractDeclineReason` + `generateRejectionEmail`, preview as `rejection`
     - conditions → `generateAdminResponseEmail`, preview as `conditions`
   - **`awaiting_collateral`** (Q9, 2870-2930):
     - approved → `active` + `collateral_override_at/by` + `prelim_approved_at` if empty (2885-2897), then a doc-request preview (2914)
     - rejected / conditions → preview, with the status staying `awaiting_collateral`. **These are now sendable** (F2).
   - **[NEW] The admin's way in.** `sendCollateralHoldNotice` (2171-2182) gives the admin a saved `[On hold — awaiting collateral]` email. A reply to it matches the deal and reaches this branch (`340d33b`).
   - **`under_review`** (2931-3039):
     - approved with every completion requirement on file → `generateCompletionEmail` (a fixed template), preview as `approval_completed` (2964-2969)
     - approved with docs still missing → doc request (2970-3020)
     - rejected / conditions → as above
   - **Any other status** → nothing happens (3040-3042). This now includes admin replies to the saved [Stalled], [Admin-controlled deal] and [LTV over 90% after approval] alerts on `active` deals.
6. **`saveDraftAndPreview`** (2553-2603) saves `draft_*` and emails the admin the preview. It is threaded with `mailer.messageIdHeader` and saved with its id (2601).
7. **`sweepBrokerFacingDraft`** (2538-2548) applies `enforceNoRoutingLeak` (`ai.js:2081`) and `stripPerfectOpener` (`ai.js:2144`) to every LLM draft in this loop. Admin REPLACE text is excluded.
   - **[NEW]** `sweepBrokerFacing` (2290-2297) applies the same sweep to the autonomous declines (2312-2316, 3356-3360).
8. **`extractDeclineReason`** (863-896) is unchanged.
9. **Referral** (3056-3238) is unchanged apart from the system-alert guard before it (3051) and the inbound id being saved (3162). `referred_by: 'Franco Maione'` is still hard-coded (3198).
10. **Automatic completion** (`sendCompletionHandoff`, 1862-2073):
    - The admin gets [File Complete] or [Conditions Fulfilled], with a zip and a lender package.
    - **[NEW] F14 (`4495b7e`):** the lender package now uses the same code-built Snapshot, roster and corporate detection as the preliminary review (`buildReviewSnapshotParts`, 1742-1801, called at 1843-1846; prepended at 1861).
    - **[NEW] F10:** its checklist follows the completion rules.
    - After the 2 s wait (1974), the closing goes to the broker. It is built by `generateCompletionEmail`, a template that is swept at 2027-2034. Then status becomes `completed` (2071).
    - **Related fix:** `32bc746` stopped the FILE STATUS banner enforcement from deleting the code-built Snapshot from the preliminary review.

**AI functions in this loop** (all `claude-sonnet-4-6`):

| Function | Tokens | What it may influence | Deterministic checks |
|---|---|---|---|
| `parseAdminReply` (`ai.js:4276`) | 20 | Picks which draft gets written. The Q9 "approved" answer changes status and override fields **immediately**, before any preview | Regex shortcuts first; substring mapping; an error gives conditions |
| `parseDraftReply` (`ai.js:4353`) | 20 | Only whether the *stored* draft ships | REPLACE decided by fixed rule; an error gives EDIT |
| `reviseEmailWithEdits` (`ai.js:4709`) | 1024 | Draft text only | Fence strip, sweep, preview again |
| `generateAdminResponseEmail` (`ai.js:4766`) | 512 | Draft text only | Sweep, preview again |
| `generateRejectionEmail` (`ai.js:3329`) | 512 (`ai.js:3364`) | In this loop: draft text, previewed. In auto-declines: **sent to the broker with no preview** | Since `340d33b`, auto-declines are swept |
| `generateCompletionEmail` (`ai.js:3425`) | — | Not an LLM call (fixed template) | — |

**Errors:**
- Classifiers fail toward not sending.
- `executeDraft` still advances the status before its fire-and-forget send finishes (2670-2716). If the send fails, the email is lost and only a log line records it.

**Technical problems solved:**
- Earlier fixes still apply: `9410859`, `2cd3ec8`, `861e5e2`, `9f19ef4`, `ba6a856`, `6c4cf54`, `167ab37` → `e4796b0`, `31b05cf`, the AML/PEP consolidation, and conditions-path completion.
- **[NEW] Q9 override drafts couldn't be sent** (`8034934`).
- **[NEW] The Q9 override had no email for the admin to reply to** (`340d33b`).
- **[NEW] Admin replies to alerts created phantom referrals** (`fff4237`).
- **[NEW] The lender package's Snapshot was written by the model and could differ from the preliminary review** (`4495b7e`).

**Inconsistencies (from the earlier version, with current status):**

1. **Q9 override drafts couldn't be sent via SEND, and the path was hard to reach.** **FIXED** (`8034934` `isDraftAwaitingAdmin`; `340d33b` hold notice). See N1 above for the side effect this introduced.
2. **Wrong comments.**
   - **FIXED** (`4313090`): the "SOLE setter" comment (now 2622-2624) and the "unreachable" comment (now 2691-2693).
   - **STILL OPEN:**
     - The comment block below at 2701-2715 still describes the branch as "defense-in-depth… theoretically reachable".
     - The 2627-2631 note says the guard admits `active` "ONLY when draft_action === 'approval_completed'". `isDraftAwaitingAdmin` now also admits `active` with `collateral_override_at`.
     - **Functional gap:** the `approval_completed` path through `executeDraft` still skips the [File Complete] notice, zip and lender package that only `sendCompletionHandoff` sends.
3. **`generateAdminResponseEmail` labels every inbound message `[BROKER]`** (`ai.js:4789`). **STILL OPEN.**
4. **The REPLACE "byte-for-byte" claim** (comment 2757-2759) **is still untrue.** Quote stripping, `textToHtml` and the send-time scrubs can all change the text.
5. **Classifier answers are mapped by substring.** "NOT APPROVED" would map to approved (`ai.js` `parseAdminReply` mapping, after the LLM call). **STILL OPEN.**
6. **Admin replies to unsaved alerts became referrals.** **FIXED** (`fff4237`): saved alert IDs, plus the guard (2228-2229, 3051-3054).
   - **Remaining gap:** the guard is based on the subject. An alert reply whose subject was edited, or forwarded with an unrecognized prefix, would still be parsed as a referral.
7. **No admin command to reopen a deal, override an identity clash, or lift `admin_controlled`.** **STILL OPEN.** There is also still no admin email during `awaiting_identity_confirmation`.

**New problems found in the current code:**

- **N1:** the Q9 conditions draft stamps `prelim_approved_at` (see Module 8).
- **N5:** a stale draft can be sent after the deal's status changes (see Module 8).
- **N6. The admin's replies to the new alerts are mislabeled in history.**
  - Admin replies to `[On hold — awaiting collateral]` (and the other new bracketed alerts) don't match `isAdminReplySubject`.
  - So `labelMessagesForLeadSummary` (193-204) labels them `INBOUND from <broker>`.
  - The alerts themselves are labelled `OUTBOUND from Vienna` in the history given to `generateBrokerResponse` (4487).
  - Internal alert text (for example "reply APPROVED to override") therefore reaches the LLM that writes broker-facing replies. The routing-leak sweep runs on its output (4631-4645), but nothing restricts what goes in.

---

## Where `vienna-ip-specification.md` (§II–III, §V) is contradicted by current code

| Spec | Claim | Current code |
|---|---|---|
| II.2, III.1 | `POST /webhook` | `/webhook/inbound` (Postmark, optional Basic auth) **and** `/webhook/resend` (Svix-signed) |
| II.1/II.2/III.2 | OCR | No OCR. (`classifyImage` was removed in `4313090`; images aren't classified by an LLM in this area) |
| II.2 | Matching by In-Reply-To | Also by References, against outbound IDs only. In Resend mode, In-Reply-To is *rebuilt* from a code in the Reply-To address |
| II.3 | Non-Canadian → `rejected` | No deal row (3346-3376) |
| II.3/III.7 | Override → `active`, then the deal proceeds | Now true (`8034934`, `340d33b`). But see N1: a *conditions* reply on hold also stamps approval |
| II.3 | List of transitions | Missing: admin decision + SEND → `active`/`rejected`/`completed`; auto-completion; follow-up auto-decline (F3); `admin_controlled` |
| III.1 | mailer-daemon/no-reply classification | Now an address-level blocklist (2403-2423) plus a display-name check on first contact |
| III.1 | Otherwise a new deal is created | Intake filter, duplicate check and non-Canadian decline exit with no deal. Admin email with no thread → referral, unless it's a reply to a system alert (3051) |
| III.4 | Gates don't consume LLM numbers | LLM LTV is a fallback at 2194, 3659, 3764, 4669, 4734 and **can trigger an auto-decline** (N2). LLM `identity_clash` (when the deterministic check misses), `exit_strategy`, `misattached_documents` and `unresolved_discrepancy` feed gates. LLM classifiers decide dispositions |
| III.7 | Admin override by email | Now reachable through the `[On hold — awaiting collateral]` notice (2171-2182) |
| V.2 | Lines ~3290–3385 | The gate block is now 3755-3863. The welcome is skipped if the deal will be auto-declined (3655-3681) |
| V.3 | Q9 at `webhook.js:2495` | Q9 is at 2870-2930 |
| V.3 | Updated review "where material" | `ltv_escalated` always re-sends. `under_review` now uses fact snapshots for material changes |
| V.4 | Waits for state to stabilize | Not in production: only the 2 s wait at 1974. The 120 s "stability window" (`973d13a`) is in the test replay harness (`test-fixtures/bulletproof/lib/replay.js`). There is no per-deal lock |
| V.5 | Graceful degradation | 200 is sent first on both routes, so providers never retry. Only the referral and new-deal branches alert the admin. A Resend adapter failure is only logged. Duplicate redelivery is now caught durably for saved emails |

---

# What changed since `edae488` (10 lines)

1. A new transport layer (`mailer.js`) supports Postmark or Resend. In Resend mode, replies are matched through a code in the Reply-To address, because SES rewrites Message-IDs (`000df09`/`de1bf44`/`5cca716`).
2. There is a new route, `POST /webhook/resend`, with a Svix signature check and an adapter (`resendInbound.js`) that rebuilds the Postmark-style payload. Both webhook checks do nothing if their secret isn't set.
3. `/webhook/inbound` gets optional Basic auth. Inbound Message-IDs are saved at all five places that save an inbound message, and duplicates are now caught in the database (`5bfcdd6`).
4. The sender blocklist now matches the parsed address, with domain and local-part rules, and adds mailer-daemon, postmaster and donotreply. Admin replies to Vienna's alerts are no longer turned into referrals (`fff4237`).
5. The link-only holding reply, link handoff, admin-controlled forward, auto-decline and its alert, the hold notice, [Stalled] and the post-approval alert are now saved with Message-IDs, so replies match the deal.
6. FIXED: the collateral loop after approval (F1); Q9 drafts that SEND couldn't send (F2); the over-90% decline and incomplete-data check missing on follow-ups (F3); welcome followed by a decline (F4); unswept declines (F5); the R10-C-1 re-ask and status check that could never run (F12); the stale comments (F12).
7. A failed intake no longer deletes a deal whose broker was welcomed (`9a68074`). Names read from an email address are weak evidence for an identity clash (`15d30f3`). Correction: an identity clash was never decided by the LLM alone.
8. Fact snapshots (`direction='system'`) now drive Q10 and Path B across all five material fields. The lender package uses the preliminary review's code-built Snapshot (F14). The banner regex no longer deletes Snapshot rows.
9. Still open: `isAdmin` is a substring match on an unauthenticated From; the two completion paths differ; substring classifier mapping; the `[BROKER]` labelling; the REPLACE "byte-for-byte" comment; the pending-draft gap under `under_review`; no reopen or unlock commands; three sources for the admin's name.
10. New risks found by reading the code: a Q9 conditions SEND stamps approval (N1); the model's LTV estimate can trigger an auto-decline (N2); escalation and decline use different data (N3); a repeating post-approval alert (N4); a stale draft can be sent after a status change (N5); admin-alert rows treated as broker conversation (N6 and Module 2); the self-blocklist failing on a bracketed `EMAIL_FROM`.