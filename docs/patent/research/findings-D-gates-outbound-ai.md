# Findings D: Decision gates, outbound generation and AI use (refreshed)

Refs are to current HEAD (`425715d`). This file updates the baseline written against `edae488`. I made no changes to files, no network or API calls, and did not read `.env`. Line numbers are `file:line` in `/Users/porterstanley/Undrwrite/src/...`.

Commits in scope since baseline: `43d45a8` (P4), `8034934` (F1+F2), `340d33b` (F3+F4+F5+Q9 reachability), `fff4237` (F6+F13), `5bfcdd6` (F7), `d6ec8c7` (P1+F9), `27ee664` and `eb0b8d3` (F8, P2, P3), `4495b7e` (F10+F14), `4313090` (F11+F12), `32bc746` (banner regex), `15d30f3` (identity clash from email-derived names), `9a68074` (intake teardown), plus the transport commits `000df09`, `de1bf44` and `5cca716`.

---

## Summary

- **AI model and setup:** one model, the literal `'claude-sonnet-4-6'`, at **18** `callClaude` sites, all in `services/ai.js`. F11 (`4313090`) removed the 4 dead functions: `classifyImage`, `updateDealSummary`, `generateInfoRequestEmail`, `generateDocReviewNotification`.
  - Every call sends one `user` message. No `system`, `temperature`, `top_p`, `tools` or `stop_sequences` are passed.
  - The SDK client is `lib/claude.js` (`@anthropic-ai/sdk ^0.73.0`).
- **No training or retrieval:** there is no fine-tuning, embeddings, vector store, RAG or retrieval. Checked with grep and against `package.json` dependencies (anthropic SDK, supabase, archiver, dotenv, express, node-cron, pdf-lib, pdf-parse, postmark). Configuration is long inline prompts plus deterministic JS before and after each call.
- **Retries:** `callClaude` (`ai.js:38-52`) is unchanged. It makes up to 3 attempts, retries only on HTTP 429, and waits 30s then 60s.
- **Thresholds are now centralised (P4, `43d45a8`):**
  - `config/thresholds.js`: `LTV_ESCALATION_PCT 80`, `LTV_AUTO_DECLINE_PCT 90`, `LTV_ELEVATED_BAND_PCT 75`. Values are unchanged.
  - Every gate and band in `discrepancy-engine.js`, and every code-built message in `webhook.js`, reads them.
  - **Not covered:** the model prompts and some strings code builds in `ai.js` still hard-code 80/75. See section 8.
- **Q2 and BUG-4 now also run on follow-ups (F3):** `evaluateFollowUpLtvGates` (`webhook.js:2190`) runs them on facts aggregated across the thread.
  - Before admin approval, a follow-up over 90% gets the decline instead of Vienna's reply.
  - After approval (or a Q9 override), it gets an admin alert and no decline.
- **A >90% first email now gets only the decline (F4):** the collateral welcome is suppressed (`webhook.js:3652-3680`). The baseline's "two emails" finding is FIXED.
- **Auto-declines are now swept (F5):** the Q2 and Q7 decline emails go through `sweepBrokerFacing` (routing-leak patterns plus the "Perfect"-opener strip). They are still sent without admin preview.
- **No collateral loop after approval (F1):**
  - `shouldHoldForCollateral` (`webhook.js:2344`) never re-holds a deal once `prelim_approved_at` or `collateral_override_at` is set.
  - The reply prompt receives `ltv_admin_cleared` so the model stops raising the threshold.
- **Q6, Q9 and Q10 changes:**
  - **Q6 (P3):** a one-time `[Stalled]` admin alert now fires at the reminder cap.
  - **Q9:** now reachable through the `[On hold — awaiting collateral]` notice the admin can reply to.
  - **Q10 (F9):** now diffs fact snapshots built by code from the thread across all 5 material fields, not the model's summary.
- **The model still reaches dispositions:**
  - Its `ltv_percent` is the gate fallback when canonical LTV can't be computed. This is now logged, and labelled "estimate" on the admin prelim (P2).
  - Model JSON flags still route deals.
  - The four short classifiers still change status when their regex fast-path misses.
  - `parseReferralEmail` still creates deals.
  - Q10 no longer depends on the model.

---

## 1. Purpose

This module covers:
- **Module 7:** the deterministic decision gates that decide each deal's disposition (auto-decline, collateral hold or escalation, preliminary review, completion), and the Q1–Q11 lender rules layered on them.
- **Module 10:** how outbound email is generated, with the model writing prose and code inserting or overriding the authoritative content.

## 2. Inputs

**Canonical map**
- Built by `canonical-fields.js` `extractCanonicalFields(body, docs, {emailSubject})`. Each field is a ranked tuple list, and `[0]` is the winner.
- Follow-up gates (F3), fact snapshots (P1) and Q10 use `extractCanonicalFieldsAggregated(inboundMessages, docs)` over the whole thread (newest wins).
- **Q1 tags** on `transaction_type` tuples:
  - `payoutConfirmed` is a match on `PAYOUT_LANGUAGE_RE` (`canonical-fields.js:1705`).
  - With no extracted type, the default is refinance unless a purchase signal exists (`:2121-2128`).
  - `refinanceConfident` is false when the text is ambiguous between refinance and purchase, or mentions a second mortgage or "existing stays in place" (`:2130-2147`).
- **Broker corrections:** `parseBrokerCorrections` (`canonical-fields.js:1081`).
  - F8 added "updating / revised / actual / now" loan-amount phrasing (`:1115`) and existing-balance corrections (`:1140`).
  - F8 follow-up: the balance correction now survives the statement-only payout filter.

**Model output**
- `processInitialEmail` returns `dealSummary` (JSON).
- `generateBrokerResponse` returns `updated_summary`, `ltv_percent`, `ownership_type` and the form booleans (JSON).
- The four classifier labels.

**Deal row**
- `status`, `prelim_approved_at`, `extracted_data.collateral_override_at`, `collateral_offered`, `identity_clash`, `draft_action`, `reminder_count`.

**Documents**
- Classified by regex (`deals.js`).
- Sent to the model as text, base64 `document` or `image` blocks (`lib/pdf.js:29-92`).
- AML/PEP documents are excluded from the analysis calls (`ai.js:24-35`, used at `:2634` and `:2822`).

## 3. Processing

### 3.1 Gate formulas (`services/discrepancy-engine.js`; `TH = require('../config/thresholds')` at `:26`)

| Function | Formula / logic | Missing inputs |
|---|---|---|
| `computeStandaloneLtv` `:536-544` | `toFixed1(requested/market*100)` | Returns `null` if either value is absent, non-finite, or market ≤ 0. Callers then fall back to the model's `ltv_percent`. P2: that fallback is now logged (`webhook.js:3765`, `:4734`). |
| `computeCombinedLtv` `:341-480` | Refinance carve-out `:459-464`: if a `transaction_type` is refinance AND (`payoutConfirmed` OR `refinanceConfident`) AND `requested >= existing`, return the standalone figure. The label (`refinance-paid-out`, `-implicit-payout` or `-stated-lender-unconfirmed`) only records which case applied. Otherwise return `(existing+requested)/market`, rounded to 1 decimal. | `null` if there is no balance, or the loan or value is missing (`:345-351`). |
| `isCombinedLtvResolved` `:613-624` | `(refinance && payoutConfirmed) OR transaction_type=2nd_mortgage OR a broker correction says 2nd`, **AND NOT** `balanceBrokerOnly`. F8 (`27ee664`): a balance that only the broker asserts can escalate but can never auto-decline. | False. |
| `shouldEscalateOnAnyLtv` `:567-575` | `std > TH.LTV_ESCALATION_PCT OR cmb > COMBINED_…(=TH.LTV_ESCALATION_PCT)`, strict. | Non-finite values are ignored. |
| `shouldEscalateOnIncompleteCanonical` (BUG-4) `:596-598` | Mortgage statement on file AND combined is null AND payout not confirmed AND loan present. | False. |
| `shouldAutoDeclineOver90` `:626-634` | `std > TH.LTV_AUTO_DECLINE_PCT`, or `combinedResolved && cmb > TH.LTV_AUTO_DECLINE_PCT`. Strict, so 90.0 does not decline. Returns `{decline, basis}`. | No decline. |
| `computeLtvBand` `:667-678` | `max(std, cmb)`: above `TH.LTV_ESCALATION_PCT` is `over_80`; `TH.LTV_ELEVATED_BAND_PCT` or more is `elevated_75_80`; otherwise `standard`. | `standard`. |
| `computeExistingLenderRefinanceMismatch` `:492-517` | Lender named in the refinance phrase is not among the document lenders. | Admin callout only. |

**Smaller inconsistencies (still open):**
- The Deal Snapshot LTV row is `Math.round` integer, and **falls back to the assessment value** when there is no market value (`discrepancy-engine.js:745-751`). The gates use market value only, to 1 decimal.
- The Schedule-A comment (`:637-666`) still says "≥80 → rejection".

### 3.2 Gate order: first email (new client; `routes/webhook.js` `handleInbound` `:2349`)

**Before any deal logic, on every message:**
1. Inbound Basic auth runs first (`requireInboundAuth` `:5015`, mounted `:5025`; F7). It is a no-op when `INBOUND_WEBHOOK_AUTH` is unset.
2. Durable dedup via `inboundAlreadyProcessed` (`:2371`, F7), then the in-memory set.
3. F13 sender denylist on the parsed address (`isIgnoredSender` `:2212`, applied `:2420`).
4. Thread match on In-Reply-To, then References (`:2442-2462`).
5. `isAdmin` is still a **substring** match of `ADMIN_EMAIL` on the From header (`:2467`).
6. If the admin replies to a system alert that has no matching deal, the reply is ignored (`isReplyToSystemAlert` `:2229`, `:3051`; F6).

**New-client path:**
1. Intake rejection, then the cross-status duplicate check (`:3312-3337`).
2. **Q7** non-Canadian property (`:3339-3380`): the decline is now `sweepBrokerFacing`'d (F5, `:3356`). Admin alert; no deal is created.
3. Deal created. A link-only submission gets a holding reply and an admin handoff (`:3396-3450`).
4. `processInitialEmail` (`:3529`).
5. Intake forms are skipped when the canonical `shouldEscalateOnAnyLtv` fires (`:3612`).
6. Discrepancy strip-and-inject plus the routing and opener sweeps (`:3545-3570`); the missing-docs honesty guard (`:3637-3650`).
7. **F4** (`:3652-3680`):
   - `_f4WillAutoDecline` is computed: no `identity_clash`, and `shouldAutoDeclineOver90` on the canonical map from this email and saved docs, with the model LTV as fallback.
   - If true, the welcome is **not sent**.
   - Otherwise `welcomeQueued = true` and the welcome is queued with `sendEmailDelayed`.
8. Status is set to `active`, with the model's `ltv` persisted (`:3683-3690`). A `recordFactSnapshot(deal,'intake')` is taken (`:3693`; P1).
9. Gate inputs are recomputed on the same map (`:3752-3790`): `_r1InitialStandaloneLtv` (canonical, else model; P2 log `:3765`), `_r1InitialShouldEscalate`, `_q2AutoDecline`, `_bug4IncompleteCanonical`.
10. The disposition is the first match below (`:3792-3860`):
    1. `identity_clash` → `awaiting_identity_confirmation`.
    2. Q2 decline → `sendAutoDecline` (`:3814`; helper `:2304`): swept, model-written decline sent, status `rejected`, `[Auto-Decline]` admin alert, both saved with Message-IDs.
    3. Escalate or BUG-4 → `awaiting_collateral`, plus `sendCollateralHoldNotice` (`:3833`; helper `:2171`).
    4. Standalone ≤ `TH.LTV_ESCALATION_PCT` with a reviewable doc → `sendPreliminaryReviewToAdmin` → `under_review`.
11. On error (`:3862-3910`):
    - The scaffold deal is deleted **only if the welcome was not queued**. Otherwise the deal is kept and the admin is told the broker was already welcomed (`9a68074`).

### 3.3 Gate order: follow-ups (existing deal, broker sender)

**`awaiting_identity_confirmation`** (`:3942`)
- `parseIdentityClarification`. "Resolved" sets `active` and may overwrite `borrower_name`.

**`awaiting_collateral`** (`:4000-4030`)
- BUG-7: `parseBrokerCorrections` first. A correction routes the reply, in memory only, to the active branch.
- Otherwise `parseCollateralReply` decides:
  - "no" → `sendEscalationToAdmin(existingDeal.ltv)` → `ltv_escalated`. Nothing goes to the broker.
  - "yes" → `active` plus `collateral_offered`.
  - "ambiguous" → `_ambiguousCollateralReply = true` and on to the active branch. There, F12 (`:4622-4628`) replaces the reply with `generateHighLtvCollateralAsk`; before F12 that re-ask could never fire.

**`ltv_escalated` / `under_review`** (`decideReviewDispatch` `:2109`, dispatched `:4225`)
- Text-only path: **Q10** (`:4283-4300`).
- Doc-bearing path: **Path B** (`:4314-4322`). Both now diff `q10PriorFacts` (the prelim snapshot) against `recordFactSnapshot(...,'inbound',{onlyIfChanged:true})` (F9).
- LTV is still not re-gated in this branch.

**`active`** (including deals flipped here in memory):
1. `summaryIn.ltv_admin_cleared = prelim_approved_at || collateral_override_at` goes into the `generateBrokerResponse` prompt (`:4479-4483`; F1).
2. `ltv = result.ltvPercent ?? existingDeal.ltv` (model) (`:4669`).
3. Escalation input: `_r1ActiveCanonicalMap` = **this email** plus all docs (`:4722-4738`). Standalone is canonical, else model (P2 log `:4734`).
4. **F3** (`:4742-4750`): `_f3Map = extractCanonicalFieldsAggregated(all inbound, docs)`, then `evaluateFollowUpLtvGates` (`:2190-2205`). It returns `{adminCleared, standaloneLtv, combinedLtv, combinedResolved, autoDecline, incompleteEscalate}`. `incompleteEscalate` is suppressed when `adminCleared`.
5. `recordFactSnapshot(...,'inbound',{onlyIfChanged:true})` (`:4751`).
6. `willGoToCollateralCheck = shouldHoldForCollateral({ltvShouldEscalate: _r1ActiveLtvShouldEscalate || _f3Gates.incompleteEscalate, …})` (`:4752`).
   - The helper (`:2344-2347`) requires status `active`, not `collateralOffered`, no unresolved identity clash, and **not adminCleared** (F1).
7. `computeWillReview` (`:443-458`) and `computeCompletionDispatch` (`:959`), unchanged.
8. **F3 disposition** (`:4842-4860`), when there is no unresolved identity clash and `autoDecline.decline`:
   - **adminCleared:** `[LTV over 90% after approval]` admin alert, saved with its Message-ID. No decline; the flow continues.
   - **otherwise:** `sendAutoDecline(turn:'follow-up email')` and `return`. The conversational reply is never sent, so there is one broker email.
9. Then: the conversational reply (unless a HITL review fires), followed by the collateral hold (`awaiting_collateral` plus `sendCollateralHoldNotice`, `:4891-4897`), the prelim, or the completion handoff.

### 3.4 Admin replies (existing deal)
- **`isDraftAwaitingAdmin`** (`:2334-2340`; F2) now also covers:
  - drafts on `awaiting_collateral` (Q9 reject/conditions);
  - `active` deals with a `collateral_override_at` draft (the Q9 approve doc-request).
  - So admin SEND now executes them, where before F2 it fell through.
- **`parseDraftReply`** → SEND / EDIT / REPLACE (`:2634`). `executeDraft` sets `active`, `rejected` or `completed` (`:2685-2716`).
- **`ltv_escalated`:** `parseAdminReply` (`:2785`).
- **Q9 on `awaiting_collateral`** (`:2870-2930`): approve → `active` plus `collateral_override_at/by`, and stamps `prelim_approved_at` if absent. The doc-request draft is swept and previewed.
- **`under_review`** (`:2931-3040`).
- **Referral** (no thread match, not a system-alert reply; `:3056-3200`).

### 3.5 Domain rules Q1–Q11: current state

| Rule | Current state | Change since baseline |
|---|---|---|
| Q1 payout carve-out | As in section 3.1. Lender match is a label only; refinance is the default. | F8: a broker-only balance is never decline-eligible. |
| Q2 >90% auto-decline | First email (`:3800`) **and follow-ups before approval** (F3). After approval: admin alert. The decline is model-written, swept and sent directly. | **FIXED** first-email-only (F3, `340d33b`). **FIXED** double email (F4). **FIXED** decline not swept (F5). |
| Q3 joint aggregation | `buildQualificationRoster` builds the roster and an aggregation directive. **The model still does the income/debt summation** (`borrower-qualification.js:3-11`). No gate uses it. | F14 (`4495b7e`): `buildReviewSnapshotParts` (`webhook.js:1742`) is shared by the prelim and the lender package, so both use the same roster and Snapshot. |
| Q4 cosigner | Priority order unchanged. Clarification appears on the admin Snapshot only (`discrepancy-engine.js:827`). `resolvedRoles: {}` (`webhook.js:1760`). | Still open (no broker clarification loop). |
| Q5 corporate | Detection unchanged. The accountant-financials ask is injected into the doc-request **prompt** (`ai.js:3598-3612`). Nothing checks the email afterwards. | F14: the lender package now uses the same corporate detection. Post-check still open. |
| Q6 chase cadence | Cron `0 21 * * *` Edmonton, ≥2 days of silence, 20h guard, `MAX_REMINDERS=4` (`cron/dailySummary.js:28-31`). At the cap, `sendStalledAlertOnce` (`:55-73`, called `:95`) sends one `[Stalled]` admin alert per deal, saved with its Message-ID. No status change. | **FIXED** missing escalation (P3, `eb0b8d3`). |
| Q7 non-Canadian | `detectNonCanadianProperty` (`canonical-fields.js:341`). US signals only; lets the deal through when unsure; new-client path only. | Decline now swept (F5). Otherwise open. |
| Q8 joint detection | `detectJointMultiBorrower` `:1192`, `detectJointFromNames` `:1222`. | Unchanged. |
| Q9 admin override | `awaiting_collateral` approve → `active` plus override stamps. Now **reachable**: `sendCollateralHoldNotice` gives the admin a once-per-deal `[On hold — awaiting collateral]` email with a Message-ID to reply APPROVED/DECLINE to. Drafts are sendable (F2). | **FIXED** reachability (`340d33b`) and draft send (`8034934`). Still relies on the From-header substring match and possibly the model classifier. |
| Q10 material change | `Q10_MATERIAL_FIELDS` (`webhook.js:1614-1620`): loan, value, existing balance, property (normalised postal code, else address), loan type (transaction type / position). The prior value is the `prelim` fact snapshot (`q10PriorFacts` `:2282`); prelims that predate snapshots fall back to parsing the HTML. The current value is `buildThreadFacts` (`:2234`), all code. | **FIXED** model-summary dependence and 3/5-field gap (F9, `d6ec8c7`). |
| Q11 registered owner | Explicit assertion regexes, no proximity fallback (`registered-owner.js:59`). | Unchanged; the spec's "by proximity" claim is still wrong. |

## 4. Outputs

**Deal status:** `active`, `awaiting_identity_confirmation`, `awaiting_collateral`, `ltv_escalated`, `under_review`, `rejected` or `completed`.

**Audit fields:** `collateral_override_at/by`, `prelim_approved_at`, `_q10_admin_renotified_at/_fields`.

**Fact snapshots (P1):**
- Stored as `messages` rows with `direction:'system'` (`deals.saveFactSnapshot` / `getFactSnapshots`). No schema change.
- Triggers: `intake`, `prelim` (`webhook.js:1602`) and `inbound` (when changed).

**Broker emails:**
- welcome, reply, collateral ask, identity ask, decline, doc request, completion, reminder, referral welcome.

**Admin emails:**
- prelim, `[UPDATED]` prelim, escalation, completion handoff with lender package, daily summary;
- alerts: `[Auto-Decline]`, `[On hold — awaiting collateral]`, `[Stalled]`, `[LTV over 90% after approval]`, `[UPDATED] Prelim correction`, intake, duplicate and Q7 alerts.
- Every alert is saved with its Message-ID so replies thread back (F6). The subjects are listed in `SYSTEM_ALERT_SUBJECT_RE` (`:2228`).

## 5. AI use: what the model writes and what code inserts

### 5.1 Generation pattern
- **`processInitialEmail`** (`ai.js:2467`) has two code-only bypasses before the model call:
  1. `isIdentityClashByAbsence` (`:686`) → `generateIdentityClashMinimalAsk`, with a summary built by code. `15d30f3` change: a name derived only from an email address is weak evidence. It clashes only when no token relates to a word of 3+ letters the broker wrote (`:699-707`).
  2. `computeLtvBand==='over_80'` → `generateHighLtvCollateralAsk`, with a summary built by code. `fff4237` added `extractBorrowerLabelFallback` (`:660`) for the borrower name; it is display only.
  - Otherwise one call returns `---EMAIL---` plus `---SUMMARY---` JSON. Code then:
    - overrides `broker_name` with the signature parse (`resolveCanonicalBrokerName` `:1574`, applied `:2793`);
    - strips any residual exit-strategy ask (`stripCanonicalKnownAsk_ExitStrategy` `:809`).
- **`generateBrokerResponse`** (`ai.js:2818`) returns `---EMAIL---` plus `---ANALYSIS---` JSON (`:3297-3320`).
  - F1: when `existingSummary.ltv_admin_cleared` is set, the prompt says "LTV ALREADY CLEARED BY UNDERWRITING" and disables the HIGH LTV block (`:3088-3090`).
- **Fully deterministic outbounds (no model):**
  - `generateCompletionEmail` (`ai.js:3425`);
  - the link-handoff acknowledgement and holding reply;
  - every admin alert listed in section 4;
  - the Q10 notice (`webhook.js:1662`);
  - `buildLenderPackageChecklist` (`ai.js:98`). F10: a balance statement no longer ticks "Mortgage Payout Statement", and purchases list the purchase contract.

### 5.2 Guards applied after the model writes

| Guard (ai.js line) | What it does | Applied at |
|---|---|---|
| `stripHtmlFence` `:60` | Removes a leaked ```` ```html ```` fence | 10 HTML generators (`:3417, 3547, 3768, 3841, 4222, 4542, 4633, 4758, 4834, 4968`) |
| `stripVienna_DiscrepancyContent` `:895` + `injectDiscrepancySection` `:913` | Removes the model's discrepancy prose; inserts the section built by code | `webhook.js:3545`, `:4139`, `:4633` |
| `stripVienna_DealSnapshot` `:932` + `prependDealSnapshot` `:939` | Replaces the model's Snapshot with the code-built one | Prelim `webhook.js:1452`; **lender package `:1855` (F14)** |
| `injectLtvEstimateCallout` `:979` (**P2**) | "LTV is an estimate" callout when canonical LTV can't be computed | Prelim `webhook.js:1485-1487`. The subject also becomes `~X% LTV (est.)` (`:1592-1593`). |
| `injectElevatedLtvBandCallout` `:989`, postal `:1068`, existing-lender `:1129`, classification `:1167` | Admin risk callouts | Prelim `webhook.js:1489-1540` |
| `stripAndInjectDocumentsIncluded` `:1357` | Documents Included section built by code | Prelim `webhook.js:1552` |
| `enforceNoRoutingLeak` `:2081` (31 patterns, `ROUTING_LEAK_PATTERNS` `:1747-1987`) + `cleanupSweepArtifacts` `:2061` | Replaces internal-routing and over-claim phrasing | Welcome `webhook.js:3556`; replies `:4145`, `:4639`; R5-D intake `:4424`; admin drafts (`sweepBrokerFacingDraft` `:2538`); completion `:2026`; **auto-declines via `sweepBrokerFacing` `:2290` (F5: `:2312`, `:3356`)** |
| `stripPerfectOpener` `:2144` | Rewrites "Perfect"-style openers | Same places as above |
| `enforceMissingDocsHonesty` `:2288` | Strips "everything looks complete" claims; injects "I'll still need …" from the missing list computed by code | `webhook.js:3645`, `:4173`, `:4657` |
| `stripAdminClosing` `:2350` | Removes broker-style sign-offs from admin email | Prelim `webhook.js:1446`; lender package `:1858` |
| `enforceReviewBanner` `:2387` (regex `:2384`) | Replaces the model's FILE STATUS paragraph with the code banner | Prelim `webhook.js:1581`. **Regex FIXED (`32bc746`):** the old pattern started at the first `<p>` and ran to FILE STATUS, deleting every Snapshot row and callout in between. It now matches a single paragraph. |
| `buildForbiddenOpenersBlock` `:2447` | Prompt-side ban on non-sequitur openers, switched on by a code signal | Doc request, broker response |
| Combined-LTV callout | Prepended to the model's escalation email | `webhook.js:1066-1070` |
| Lender package (F14) | `generateLeadSummary(noSnapshot, roster directive)`, then code Snapshot, then deterministic checklist (`ai.js:4226`) | `buildCompletionLenderPackage` `webhook.js:1803` |

**Still not covered by the sweeps:**
- cron reminders (`generateFollowUpReminder`: fence strip only);
- referral welcomes (`webhook.js:3172`: no sweep).

The Q2/Q7 declines are **now covered** (F5).

## 6. Errors and correction

- **Generators** rethrow errors.
- **Classifiers** return conservative defaults:
  - `parseAdminReply` → conditions;
  - `parseDraftReply` → edit;
  - `parseCollateralReply` → ambiguous;
  - `parseIdentityClarification` → unresolved.
  - `parseReferralEmail` **rethrows**. Its regex fallback (`regexExtractReferralEmail`) only fills a missing `referred_email`.
- **JSON parse failure** on the SUMMARY or ANALYSIS block throws.
  - On the new-client path, the FFFF handler deletes the scaffold deal **only if the welcome hasn't been queued**; otherwise it keeps the deal and alerts the admin (`9a68074`).
  - The Q7 and link-only paths return before deal creation or teardown.
- **`recordFactSnapshot`** swallows its own errors and returns `null` (`webhook.js:2264-2277`). Q10 then sees no change.
- **Alerts and notices:**
  - `sendCollateralHoldNotice` and the `[Stalled]` alert are once per deal, checked by subject on outbound messages.
  - `sendStalledAlertOnce` catches its own errors.
- **Deploy hygiene (`4313090`):** `scripts/deploy.sh` deploys only a clean `git archive HEAD` and refuses on a dirty tree. The F11 first pass had shipped a broken `DOC_DISPLAY_NAMES` export.

## 7. Technical problems solved since baseline (with commits)

| Problem | Fix | Commit |
|---|---|---|
| Thresholds were literals scattered across gate and message code | `config/thresholds.js`, read by the engine and `webhook.js` | `43d45a8` (P4) |
| Q9 override drafts never executed on admin SEND | `isDraftAwaitingAdmin` extended | `8034934` (F2) |
| Admin-approved deal re-entered the collateral hold on the next follow-up | `shouldHoldForCollateral` adminCleared check; `ltv_admin_cleared` prompt signal | `8034934` (F1) |
| Q2 and BUG-4 ran only on the first email | `evaluateFollowUpLtvGates` on aggregated thread facts; decline before approval, alert after | `340d33b` (F3) |
| A >90% broker received the collateral welcome and then the decline | Q2 decision made before the welcome send | `340d33b` (F4) |
| Auto-declines skipped the broker-facing sweep | `sweepBrokerFacing` applied in `sendAutoDecline` and Q7 | `340d33b` (F5) |
| Q9 was unreachable (the admin had no email to reply to) | `sendCollateralHoldNotice` | `340d33b` |
| Replies to alerts and holding emails didn't thread, or were parsed as referrals; substring denylist | Message-IDs saved; `isReplyToSystemAlert`; `isIgnoredSender` | `fff4237` (F6/F13) |
| Unauthenticated inbound webhook; in-memory-only dedup | Basic auth; durable dedup on stored inbound Message-IDs | `5bfcdd6` (F7) |
| Q10 used the model's summary and 3 of 5 fields | Fact snapshots plus a code diff over all 5 fields | `d6ec8c7` (P1/F9) |
| Broker correction wordings were missed; a broker-only balance could auto-decline | Patterns added; `balanceBrokerOnly` | `27ee664`, `eb0b8d3` (F8) |
| The model's LTV estimate was shown as fact | Estimate callout and subject label; fallback logged | `eb0b8d3` (P2) |
| Q6 had no escalation at the cap | `[Stalled]` alert | `eb0b8d3` (P3) |
| Lender checklist and package diverged from the prelim | Shared `buildReviewSnapshotParts`; checklist follows completion rules | `4495b7e` (F10/F14) |
| Dead AI code; unreachable collateral re-ask | 4 functions removed; `_ambiguousCollateralReply` marker | `4313090` (F11/F12) |
| Banner regex deleted the Snapshot | Single-paragraph regex | `32bc746` |
| Email-address-derived name caused false identity clashes | Weak-evidence rule | `15d30f3` |
| Teardown deleted deals whose broker was already welcomed | `welcomeQueued` guard | `9a68074` |
| Resend overwrites Message-ID, breaking threading | Reply-To thread token | `5cca716` |

## 8. Open questions and baseline contradictions: status

**Baseline items**

- **Thresholds hard-coded:** **FIXED** for gates, bands and webhook messages (P4). **Still open** in `ai.js`:
  - prompt text "80%" at `:225-240`, `:3043`, `:3090-3095`, `:3490`, `:4600`;
  - the strings code builds: `:2625` (high-LTV summary "exceeds the 80% threshold") and `:996-997` (elevated-band callout "75-80%").
  - Changing a value in `thresholds.js` would desynchronise what the model says from what the gates do.
  - The "calibration pending" comment remains (`discrepancy-engine.js:561`).
- **4 dead model functions:** **FIXED** (`4313090`).
- **Q2 and BUG-4 on follow-ups:** **FIXED** (F3).
- **Double email for a >90% deal:** **FIXED** (F4).
- **Declines unswept:** **FIXED** (F5).
- **Q6 had no escalation:** **FIXED** (P3). There is still no status change.
- **Q10 compared against the model's summary, 3 fields:** **FIXED** (F9).
- **Q9 reachability:** **FIXED**.
- **Admin From-header substring match** (`webhook.js:2467`): **still open**.
  - F7 authenticates the webhook caller, not the sender.
  - The Resend route verifies the svix signature, not the sender's identity.
- **Model LTV used as gate fallback** (`webhook.js:3764`, `:4733`, `:2196`, `:447`, `:111`, `:142`): **still open**. It is now logged and labelled on the prelim (P2).
- **Model flags still route deals:** `identity_clash`, `unresolved_discrepancy`, `exit_strategy`, `collateral_offered`, `is_purchase`. **Still open.**
- **IV(h) stale spec:** still stale. The code is unchanged.
- **Q3/Q4/Q5/Q7/Q11 spec gaps:** still open as listed in section 3.5.
- **Snapshot LTV rounding and assessment fallback vs gate LTV:** still open.

**New observations to verify**

1. **Different inputs for escalation and Q2/BUG-4 on follow-ups.** The >80 escalation reads a map built from the **current email** plus docs (`webhook.js:4722`). Q2 and BUG-4 read the **thread-aggregated** map (`:4745`). A figure stated only in an earlier email can therefore count for decline but not for escalation, or the other way round.
2. **Repeated alerts.** Neither `[LTV over 90% after approval]` (`:4845`) nor Q10 has a once-only guard.
   - Every later follow-up that is still over 90 re-alerts.
   - Q10's prior is always the last *prelim* snapshot, so later text-only turns carrying the same corrected value would re-notify. Not verified live.
3. **Model LTV in escalation.** The collateral "no" path escalates with `existingDeal.ltv`, the model's value persisted at intake (`:4019`). The escalation email's headline LTV is model-derived; the Combined-LTV callout comes from code.
4. **Transient status before decline.** On the F4 path, status is written `active` (`:3683`) before `sendAutoDecline` sets `rejected`. This is a brief window, not an outcome.
5. **Stale comment.** `ai.js:3327` still reads "Generate rejection email to broker (LTV > 95%)".

---

## 9. Claude API call inventory (18 sites, all `services/ai.js`)

Every call goes through `callClaude` (`:38-52`; 429-only retry, 3 attempts), uses `model:'claude-sonnet-4-6'`, sends one `user` message, and passes no system prompt, temperature, tools or stop sequences.

| # | Function (def / call line) | Purpose | Inputs | max_tokens | Output | Consumed by | Can influence disposition or gate? | Deterministic constraint |
|---|---|---|---|---|---|---|---|---|
| 1 | `processInitialEmail` 2467 / 2763 | First-email welcome plus deal extraction | Prompt, email text, PDF/image/text blocks (AML/PEP excluded), canonical exit-strategy and greeting hints | 3072 | `---EMAIL---` HTML + `---SUMMARY---` JSON | `webhook.js:3529` (new client), `:4411` (R5-D post-identity intake) | **Yes**: `identity_clash` → status; `ltv_percent` → gate fallback and persisted `deal.ltv`; `exit_strategy` → `computeWillReview`; `is_purchase` → required docs | Code-only bypasses for identity clash and over_80; `broker_name` overridden; exit-ask strip; discrepancy inject; sweeps; honesty guard; canonical LTV preferred; F4 decides decline before the welcome |
| 2 | `generateBrokerResponse` 2818 / 3290 | Conversational reply plus updated analysis | Prompt, blocks, history, existing summary (+ `ltv_admin_cleared`), canonical fields prompt, missing list | 3072 | `---EMAIL---` HTML + `---ANALYSIS---` JSON | `webhook.js:4126` (review), `:4592` (active) | **Yes**: `ltv_percent` fallback; `unresolved_discrepancy` → willReview; `collateral_offered` → skips the hold; `exit_strategy`; `identity_clash` (no longer Q10) | Canonical LTV preferred; F1 adminCleared; F3 gates on code facts; the decline replaces the reply; F12 collateral-ask replacement; sweeps, discrepancy inject, honesty guard |
| 3 | `generateRejectionEmail` 3329 / 3362 | Decline prose | Summary, decline reason (code-supplied for Q2/Q7), greeting | 512 | HTML | `sendAutoDecline` `webhook.js:2312`; Q7 `:3356`; admin drafts `:2863`, `:2924`, `:3033` | No (the decision is already made by code or the admin) | Fence strip; `sweepBrokerFacing` (F5) or `sweepBrokerFacingDraft`; admin preview for drafts only |
| 4 | `generateEscalationNotification` 3450 / 3541 | Admin escalation email (LTV over threshold) | Summary, labelled messages, document text | 2048 | HTML | `sendEscalationToAdmin` `webhook.js:1063` | No | Fence strip; Combined-LTV callout built by code is prepended |
| 5 | `generateDocumentRequestEmail` 3580 / 3669 | Post-approval doc request | Summary, ownership, docs on file, history, Q5 corporate ask, forbidden-openers block | 1024 | HTML | Admin approval paths `webhook.js:2829`, `:2905` (Q9), `:3003` | No | Fence strip; `sweepBrokerFacingDraft`; admin preview before send |
| 6 | `generateFollowUpReminder` 3779 / 3788 | Broker chase reminder | Summary, days silent, reminder number, missing docs | 512 | HTML | `cron/dailySummary.js:222` | No | Fence strip only; cadence and cap are code |
| 7 | `generateLeadSummary` 3880 / 4063 | Admin prelim narrative / lender package | Summary, docs, missing list, messages, canonical LTV/lender/corrections overrides, Q3 roster directive, `noSnapshot` / `lenderPackage` | 4096 | HTML | Prelim `webhook.js:1429`; lender package `:1840`; legacy FINAL REVIEW `:4972` (stated unreachable) | No gate. Writes the Q3 aggregation narrative | Snapshot replaced; LTV estimate, band, postal, lender and classification callouts; Documents Included; admin-closing strip; banner enforced; subject LTV from code; deterministic checklist |
| 8 | `parseAdminReply` 4276 / 4290 | Classify admin reply: approved / rejected / conditions | Admin reply text (quotes stripped) | 20 | One word | `webhook.js:2785`, `:2880` (Q9), `:2932` | **Yes**: approve/reject/Q9 override → status | Regex fast-path for single words; any failure → conditions; reject and conditions become drafts for preview |
| 9 | `parseDraftReply` 4353 / 4376 | SEND vs EDIT on a draft preview | Admin reply text | 20 | One word | `webhook.js:2634` | **Yes**: SEND → `executeDraft` status change | `isFullAlternativeDraft` (≥50 words and 2+ paragraphs) → REPLACE without the model; failure → edit |
| 10 | `parseCollateralReply` 4415 / 4443 | Broker yes/no/ambiguous on collateral | Broker reply text | 20 | One word | `webhook.js:4025` | **Yes**: "no" → `ltv_escalated`; "yes" → `active` + `collateral_offered` | BUG-7 correction check runs first; regex "no" fast-path; failure → ambiguous; the active branch still re-gates |
| 11 | `generateIdentityClashMinimalAsk` 4497 / 4509 | Minimal identity question | Body name, document name, sender, greeting | 256 | HTML | `ai.js:2534` (code bypass) | No (the clash is detected by code) | Fence strip; summary built by code |
| 12 | `generateHighLtvCollateralAsk` 4590 / 4601 | Collateral question | Summary, greeting | 320 | HTML | `ai.js:2628` (bypass); `webhook.js:4625` (F12 re-ask) | No (the band is computed by code) | Fence strip; sweeps on the active path; `computeLtvBand` selects it |
| 13 | `parseIdentityClarification` 4640 / 4657 | Resolved/unresolved plus confirmed name | Broker reply, summary | 80 | Label + name | `webhook.js:3944` | **Yes**: status → `active`; may overwrite `borrower_name` | Regex "X is correct" fast-path; failure → unresolved |
| 14 | `reviseEmailWithEdits` 4709 / 4711 | Apply admin edit instructions to a draft | Draft, instructions, summary | 1024 | HTML | `webhook.js:2772` | No | Fence strip; `sweepBrokerFacingDraft`; re-previewed |
| 15 | `generateAdminResponseEmail` 4766 / 4768 | Turn admin conditions/notes into a broker email | Summary, admin notes, history | 512 | HTML | `webhook.js:2867`, `:2928`, `:3037` | No | Fence strip; `sweepBrokerFacingDraft`; admin preview |
| 16 | `parseReferralEmail` 4842 / 4844 | Extract the referred party from an admin email | Admin email text | 512 | JSON | `webhook.js:3069` | **Yes**: creates a deal | System-alert replies filtered first (F6); regex fills a missing email; parse failure throws |
| 17 | `generateReferralWelcomeEmail` 4922 / 4926 | Welcome to a referred party | Referral data | 512 | HTML | `webhook.js:3172` | No | Fence strip only (no sweep) |
| 18 | `generateDailySummary` 4976 / 4978 | Daily admin operations digest | Summary JSON (deals, reminders) | 8192 | HTML | `cron/dailySummary.js:539` | No | Fence strip; failure handled in cron |

**What the model influences, by kind:**
- **Directly:** #8, #9, #10, #13 and #16 change status or create deals.
- **Indirectly:** #1 and #2, through extracted fields and the LTV fallback.
- **Never:** the auto-decline basis, the band, the hold, Q10 and Q6 are computed by code. The model only supplies the fallback standalone LTV when canonical extraction can't compute one.

## 10. Email transport (`lib/mailer.js`, `lib/resendInbound.js`)

- **One interface:** `send()` takes and returns Postmark-shaped data, so `services/email.js` callers don't depend on the provider.
- **Provider choice:** `config.email.provider` comes from `EMAIL_PROVIDER` (`config/index.js:15`).
  - **Postmark (default):** Message-IDs are `<uuid@mtasv.net>`, and replies thread on In-Reply-To.
  - **Resend:** Resend's MTA (SES) overwrites any custom Message-ID (verified live, `5cca716`). So `sendViaResend` generates a uuid, puts it in **Reply-To** as `EMAIL_REPLY_TO local+<uuid>@domain` (`replyToWithToken`), and returns `{MessageID: uuid}`, which is stored as `messages.external_message_id`.
- **Inbound (`POST /webhook/resend`, `webhook.js:5030`):**
  - `resendInbound` verifies the svix signature.
  - It extracts the token from To / `received_for` / Cc (`threadTokenFrom`), synthesises `In-Reply-To: <token@MESSAGE_ID_DOMAIN>`, rebuilds a Postmark-shaped payload and calls the same `handleInbound`. `findByMessageId` then threads it unchanged.
  - `messageIdHeader()` (`mailer.js:18`) builds RFC Message-IDs from stored bare ids.
  - `MESSAGE_ID_DOMAIN` defaults from the bracketed `EMAIL_FROM` (`de1bf44`).
- **Postmark route:** `/webhook/inbound` is protected by optional Basic auth (F7).

---

**Summary of changes from the baseline**
1. Call-site count is now 18, not 22. The 4 dead functions were removed (F11), and every line ref in the inventory was refreshed.
2. Thresholds now come from `config/thresholds.js` (P4). Prompt and `ai.js` literals still hard-code 80/75, which is flagged as open.
3. Follow-ups now run Q2 and BUG-4 through `evaluateFollowUpLtvGates` (F3): a decline before approval, an admin alert after. The "first email only" contradiction is marked FIXED.
4. A >90% first email now gets only the decline (F4), and the Q2/Q7 declines are swept (F5). The two-email and unswept-decline findings are FIXED.
5. `shouldHoldForCollateral` and the `ltv_admin_cleared` prompt signal (F1), plus the draft-send fix (F2), are documented.
6. Q6 now sends a `[Stalled]` alert (P3), Q9 is reachable through the on-hold notice, and Q10 now runs on fact snapshots across all 5 fields (P1/F9).
7. New guards added: the P2 estimate callout and `(est.)` subject; the banner regex fix (`32bc746`); the shared lender-package Snapshot (F14); the F12 collateral re-ask.
8. Error handling now covers the `welcomeQueued` teardown guard (`9a68074`) and snapshot failure tolerance. Inbound auth, dedup, the denylist and alert threading (F6/F7/F13) were added.
9. Added the email transport section: Postmark or Resend, with the Reply-To thread token used because Resend overwrites Message-ID.
10. New open observations: escalation and Q2/BUG-4 read different maps (current email vs whole thread); the post-approval and Q10 alerts can repeat; the Snapshot LTV falls back to the assessment value; the escalation uses the model LTV; a stale "95%" comment remains.