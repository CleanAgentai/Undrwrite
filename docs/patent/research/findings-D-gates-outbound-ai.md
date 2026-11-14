The findings file was not written: the harness refused the Write ("Subagents should return findings as text"). So the summary comes first, and the full findings follow because they would otherwise be lost. Everything was read-only. I made no API calls and did not read `.env`. Refs are to HEAD `edae488`.

## Summary

- **AI model and setup:** there is one model, the literal `'claude-sonnet-4-6'`, at 22 `callClaude` sites, all in `src/services/ai.js`. Every call is a single `user` message. No `system` prompt, `temperature`, `top_p`, tools or stop sequences are ever passed, so API defaults apply.
- **No training of any kind:** there is no fine-tuning, embeddings, vector store, RAG or retrieval (checked with grep and against `package.json` dependencies). Configuration is purely long inline prompts plus deterministic JS before and after each call.
- **Retries:** `callClaude` (`ai.js:38-52`) makes up to 3 attempts and retries only on HTTP 429, waiting 30s then 60s. Anything else is rethrown.
- **Dead code:** 4 of the 22 calls are unreachable: `classifyImage`, `updateDealSummary`, `generateInfoRequestEmail`, `generateDocReviewNotification`. Document classification is regex (`deals.js:90-145`).
- **Thresholds are hard-coded, not configured:** 80 for escalation (`discrepancy-engine.js:564,567`), 90 for auto-decline (`:606`), and 75/80 for the LTV band (`:670-671`). They also appear as literals in `webhook.js`. `src/config/index.js` holds only env keys.
- **The model does reach dispositions, despite the spec's claim that it doesn't:**
  - The model's `ltv_percent` is used as the standalone LTV whenever code can't compute it (`webhook.js:3511`, `:4475`).
  - Fields the model emits route deals: `identity_clash`, `unresolved_discrepancy`, `misattached_documents`, `exit_strategy`, `is_purchase`, `collateral_offered`.
  - Short model classifiers change deal status when their regex fast-path misses: `parseAdminReply`, `parseDraftReply`, `parseCollateralReply`, `parseIdentityClarification`.
  - `parseReferralEmail` creates deals.
  - Q10 compares the model's `updated_summary` against the last prelim.
- **The >90% auto-decline and the incomplete-data escalation (BUG-4) run only on a deal's first email.** The later active branch re-checks only `shouldEscalateOnAnyLtv`. This contradicts IV(g)'s claim that the IV(e) guard "still governs" after a broker correction.
- **The spec's IV(h) "dual-path" description is stale.** The refinance carve-out is now a single condition: `(payoutConfirmed || refinanceConfident) && requested >= existing`. Lender match is only a label now. Transaction type defaults to refinance when there is no purchase signal.
- **Outbound pattern:** the model writes the prose. Code then strips forbidden content and inserts the authoritative parts: discrepancy section, Deal Snapshot, FILE STATUS banner, missing-docs ask, LTV/postal/lender/classification callouts, documents section, lender checklist and greeting. Some outbounds involve no model at all.
- **The two auto-decline emails (>90% and non-Canadian) are model-written, sent without admin preview, and skip the phrase and opener checks.**
- **A >90% deal's broker gets two emails:** a collateral-question welcome, then the decline (`webhook.js:3418`, `:3573`; acknowledged in the comment at `:3558`).
- **Q6:** when reminders run out, the code just stops reminding. There is no status change or escalation email.

## 1. Decision gates (`src/services/discrepancy-engine.js`)

All gates read the "canonical map" from `canonical-fields.js` `extractCanonicalFields`. Index `[0]` of each field is the winning source.

| Function | Formula / logic | Missing inputs |
|---|---|---|
| `computeStandaloneLtv` `:535-543` | `toFixed1(requested/market*100)` | Returns `null` if either value is absent, non-finite, or market ≤ 0. Callers then fall back to the model's `ltv_percent`. |
| `computeCombinedLtv` `:340-476` | Refinance carve-out `:458-463`: if a `transaction_type` is refinance AND (`payoutConfirmed` OR `refinanceConfident`) AND `requested >= existing`, return `requested/market`. `existing` is set to 0 and labelled `refinance-paid-out`, `-implicit-payout` or `-stated-lender-unconfirmed`. Otherwise return `(existing+requested)/market`, rounded to 1 decimal. | `null` if there is no existing balance, or the loan or value is missing (`:344-350`). |
| `isCombinedLtvResolved` `:612-619` | True if a refinance has `payoutConfirmed`, or `transaction_type` is `2nd_mortgage`, or a broker correction says 2nd/second. `refinanceConfident` alone does not count. | False. |
| `shouldEscalateOnAnyLtv` `:566-574` | `std > 80 OR cmb > 80`, strict. | Non-finite values are ignored; both null gives false. |
| `shouldEscalateOnIncompleteCanonical` `:595-597` | Mortgage statement on file AND combined is null AND payout not confirmed AND loan present. | Defaults to false. |
| `shouldAutoDeclineOver90` `:621-629` | `std > 90`, or `combinedResolved && cmb > 90`. Strict, so 90.0 does not decline. | No decline. |
| `computeLtvBand` `:662-673` | `max(std, cmb)`: above 80 is `over_80`; 75 or more is `elevated_75_80`; otherwise `standard`. | Defaults to `standard`. |
| `computeExistingLenderRefinanceMismatch` `:491-516` | Flags when the lender named in the refinance phrase is not among the document lenders. | Admin callout only. |

**How the Q1 tags are set** (`canonical-fields.js:2078-2119`):
- `payoutConfirmed` is a regex match (`PAYOUT_LANGUAGE_RE`, `:1677`) over the broker body plus all document text.
- If no transaction type was extracted, it defaults to refinance unless a purchase signal exists (`:2093-2101`).
- `refinanceConfident` is false only when the text is ambiguous between refinance and purchase, or mentions a 2nd mortgage or "existing stays in place".

**Smaller inconsistencies:**
- The Snapshot shows LTV as an integer (`Math.round`, `:745`), while the gates use one decimal.
- The Schedule-A comment says "≥80 → rejection", but the code places 80.0 exactly in the 75–80 band.

## 2. Where `webhook.js` decides a deal's fate, in order

The inbound handler is `router.post('/inbound')` at `:2133`.

**Every message:**
1. Message-ID dedup, sender denylist, then thread matching (`:2153-2240`).
2. `isAdmin` (`:2244`) is a **substring** match of `ADMIN_EMAIL` on the From header, with no sender-authentication check.
3. If the deal is `admin_controlled` and the sender isn't the admin, the message is forwarded to the admin only (`:2260`).

**Admin replies on an existing deal:**
1. If a draft is pending, `parseDraftReply` decides SEND or EDIT. SEND runs `executeDraft`, which sets status: doc request → `active`, rejection → `rejected`, completion → `completed` (`:2408-2558`, `:2465-2524`).
2. On `ltv_escalated`, `parseAdminReply` picks approve / reject / conditions, and the result becomes a draft for admin preview (`:2563-2648`).
3. **Q9:** on `awaiting_collateral`, an approval sets status `active`, records `collateral_override_at/by`, and stamps `prelim_approved_at` (`:2649-2693`).
4. On `under_review`: approval with all docs in produces a completion draft; approval with docs missing produces a doc-request draft; rejection produces a rejection draft (`:2710-2818`).

**Admin email with no matching thread:** treated as a referral. `parseReferralEmail` (model JSON) parses it, a deal is created, and a model-written welcome is sent (`:2826-3005`).

**New client:**
1. Intake rejection (`:3027`), then cross-status duplicate check (`:3095`).
2. **Q7** non-Canadian property: the model writes a decline that is sent directly, the admin is alerted, and no deal is created (`:3113-3142`).
3. Deal created; a link-only submission is handed to the admin (`:3165`).
4. `processInitialEmail` runs.
5. Intake forms are skipped when `shouldEscalateOnAnyLtv` fires (`:3375-3391`).
6. The missing-docs honesty guard runs, the welcome is sent, and status is set to `active` with the model's `ltv` persisted (`:3402-3438`).
7. The final disposition is the first match below (`:3538-3623`):
   1. `identity_clash` (set by code or by the model) → `awaiting_identity_confirmation`.
   2. Q2 auto-decline → status `rejected`, with a model-written decline sent and the admin alerted.
   3. Escalate or BUG-4 → `awaiting_collateral`.
   4. LTV ≤ 80 with a reviewable doc, and no structured discrepancy hold (`:413-438`) → prelim sent → `under_review` (`:1642`).
8. Any error deletes the scaffold deal and alerts the admin (`:3624-3665`).

**Existing deal, broker reply:**
1. **Identity confirmation:** `parseIdentityClarification`. "Resolved" sets `active` and may overwrite `borrower_name` with the model-extracted name (`:3696-3748`).
2. **Awaiting collateral:** BUG-7 `parseBrokerCorrections` runs first; a correction routes the reply to the active branch. Otherwise `parseCollateralReply` decides (`:3773-3807`):
   - "no" → `sendEscalationToAdmin` → `ltv_escalated`, nothing sent to the broker.
   - "yes" → `active` plus `collateral_offered`, which then bypasses the LTV re-check.
3. **`ltv_escalated` / `under_review`:** `decideReviewDispatch` (`:2075-2130`) dispatches. Q10 runs on the text-only path (`:4022`); a Path B material-change check runs on the prelim-update path (`:4063`). LTV is not re-checked.
4. **`active`:**
   - `std = canonical ?? model ltv` (`:4475`).
   - Collateral check: escalate AND status is active AND not `collateral_offered` AND not `identity_clash` (`:4480`).
   - `computeWillReview` (`:440-456`) requires LTV ≤ 80, a reviewable doc, `exit_strategy`, no identity clash, no prior approval, and no `unresolved_discrepancy` (a model flag).
   - `computeCompletionDispatch` (`:956-964`) leads to a prelim or the completion handoff.

## 3. Domain rules Q1–Q11

- **Q1 (refinance/payout carve-out):** as described in section 1.
- **Q2 (>90% auto-decline):** first email only. The decline is model-written and sent directly.
- **Q3 (joint aggregation):** `buildQualificationRoster` (`borrower-qualification.js:66`) builds a roster and an aggregation instruction string. That string goes into the `generateLeadSummary` prompt (`webhook.js:1486`). **The model does the income/debt summation** (`borrower-qualification.js:3-11`). No gate uses the result.
- **Q4 (cosigner):** priority order is guarantor > co-applicant > ambiguous "cosigner" (treated as guarantor-only and flagged) > default co-applicant, using text within 90 characters of the name (`:28-57`). The clarification appears only on the admin Snapshot (`discrepancy-engine.js:822`). `resolvedRoles` is always `{}` (`webhook.js:1394`), so no broker clarification loop is wired.
- **Q5 (corporate borrower):** detected by entity suffix, plus other entity names with a linkage word within 60 characters (`corporate-entities.js:21-82`). The accountant-financials ask is inserted into the **model prompt** for the post-approval doc request (`ai.js:3546-3557`, `:3653-3662`). Nothing checks afterwards that the ask made it into the email.
- **Q6 (chase cadence):** cron runs at `0 21 * * *` America/Edmonton, after 2 or more days of silence, with a 20-hour resend guard and `MAX_REMINDERS=4` (`dailySummary.js:25-30`). At the maximum the deal is skipped (`:70-74`) and only listed in the model-written daily summary.
- **Q7 (non-Canadian property):** looks only at the property region of the email for US ZIP+4, US state + 5-digit ZIP, or ", USA/United States" (`canonical-fields.js:305-349`). If no property region is found it lets the deal through. It runs on the new-client path only.
- **Q8 (joint detection):** two or more credit-bureau documents with different names, or a "First Last and First Last" pattern, with role words disqualifying a match (`discrepancy-engine.js:1185-1227`).
- **Q9 (admin override):** see section 2. It relies on the admin From-header substring match and on `parseAdminReply`, which may be the model.
- **Q10 (material-change re-notification):** compares the model's `updated_summary` against figures parsed from the last PRELIMINARY email. That parser extracts only loan amount, appraised value and existing balance (`webhook.js:1688-1698`), so address, mortgage position and transaction-type changes are never detected.
- **Q11 (registered owner):** explicit owner-assertion regexes only, with no proximity fallback (`registered-owner.js:58-61`). If there is a single owner, non-owner applicants become guarantor-only (`borrower-qualification.js:115-124`). No deal status changes.

## 4. Outbound pattern: what the model writes, what code inserts

- **`processInitialEmail` (`ai.js:2414`) has two code-only bypasses before the model call:**
  - An identity clash detected by code (`isIdentityClashByAbsence`) goes to `generateIdentityClashMinimalAsk`, with a code-built summary.
  - `computeLtvBand === 'over_80'` goes to `generateHighLtvCollateralAsk`, with a code-built summary.
  - Otherwise one model call returns `---EMAIL---` plus `---SUMMARY---` JSON. Code then overrides `broker_name` from the email signature and strips any exit-strategy ask.
- **`generateBrokerResponse` (`ai.js:3234`)** returns `---EMAIL---` plus `---ANALYSIS---` JSON.
- **Fully deterministic outbounds:** `generateCompletionEmail` (`ai.js:3369`), the link-handoff acknowledgement, admin alerts, the Q10 notice, and `buildLenderPackageChecklist` (`ai.js:95-118`).
- **What code inserts or overrides after the model writes:**

| Guard | What it does | Where it runs |
|---|---|---|
| `stripHtmlFence` `:60` | Removes leaked ```html fences | Every HTML generator |
| `stripVienna_DiscrepancyContent` + `injectDiscrepancySection` `:861-887` | Removes the model's discrepancy prose; inserts the code-built section | `webhook.js:3310`, `:3890`, `:4374` |
| `stripVienna_DealSnapshot` + `prependDealSnapshot` `:898-914` | Replaces the model's snapshot with the code-built one | Prelim `:1498` |
| `injectElevatedLtvBandCallout` `:940`, postal `:1019`, lender `:1080`, classification `:1118` | Admin risk callouts | Prelim `:1531-1584` |
| `stripAndInjectDocumentsIncluded` `:1308` | Code-built Documents Included section | Prelim |
| `enforceNoRoutingLeak` (31 patterns, `:1698`) + `cleanupSweepArtifacts` `:2012` | Replaces internal-routing and over-claim phrasing | Broker emails and admin-path drafts (`sweepBrokerFacingDraft`, `webhook.js:2314`) |
| `stripPerfectOpener` `:2095` | Rewrites "Perfect" openers | Same places |
| `enforceMissingDocsHonesty` `:2239` | Strips "everything looks complete" claims; injects "I'll still need …" from the code-computed missing list | `webhook.js:3410`, `:3924`, `:4398` |
| `stripAdminClosing` `:2301` | Removes broker-style sign-offs from admin email | Prelim |
| `enforceReviewBanner` `:2334` | Replaces the model's FILE STATUS with the code banner | Prelim `:1623` |
| `buildForbiddenOpenersBlock` `:2394` | Prompt-side ban on non-sequitur openers, switched on by a code signal | Doc request, broker response |
| Combined-LTV callout | Prepended to the model's escalation email | `webhook.js:1061` |

**Not covered by these guards:** the Q2/Q7 decline emails, cron reminders (fence strip only), and referral welcomes.

**Error behaviour:**
- Generators rethrow errors.
- The classifiers return conservative defaults on failure: admin reply → conditions, draft reply → edit, collateral → ambiguous, identity → unresolved.
- A JSON parse failure on the SUMMARY or ANALYSIS block throws. On the new-client path that deletes the deal and alerts the admin.

## 5. Claude call inventory

Every call is `claude-sonnet-4-6`, one `user` message, no system prompt, default temperature.

| # | Function (ai.js line) | max_tokens | Inputs | Output | Affects disposition? |
|---|---|---|---|---|---|
| 1 | `processInitialEmail` 2709 | 3072 | text, PDF and image blocks plus prompt | HTML + JSON | **Yes**: `identity_clash`, LTV fallback, misattached docs, `is_purchase`, `exit_strategy` |
| 2 | `generateBrokerResponse` 3234 | 3072 | blocks, history, summary | HTML + JSON | **Yes**: LTV fallback, `unresolved_discrepancy`, `collateral_offered`, `exit_strategy`; Q10 diff |
| 3 | `generateRejectionEmail` 3306 | 512 | text | HTML | No (decision already made) |
| 4 | `generateEscalationNotification` 3485 | 2048 | text and document text | HTML | No |
| 5 | `generateDocumentRequestEmail` 3613 | 1024 | text | HTML | No |
| 6 | `generateInfoRequestEmail` 3740 | 512 | text | HTML | Dead code |
| 7 | `generateFollowUpReminder` 3790 | 512 | text | HTML | No |
| 8 | `classifyImage` 3853 | 50 | image | label | Dead code |
| 9 | `generateLeadSummary` 4109 | 4096 | text, document text, code overrides | HTML | No gate; does the Q3 aggregation as narrative |
| 10 | `parseAdminReply` 4336 | 20 | text | label | **Yes**: approve / reject / Q9 |
| 11 | `parseDraftReply` 4422 | 20 | text | label | **Yes**: SEND triggers the status change |
| 12 | `parseCollateralReply` 4489 | 20 | text | label | **Yes**: escalates or re-activates |
| 13 | `generateIdentityClashMinimalAsk` 4555 | 256 | text | HTML | No |
| 14 | `generateHighLtvCollateralAsk` 4647 | 320 | text | HTML | No |
| 15 | `parseIdentityClarification` 4703 | 80 | text | label + name | **Yes**: status and borrower name |
| 16 | `reviseEmailWithEdits` 4757 | 1024 | text | HTML | No |
| 17 | `generateAdminResponseEmail` 4814 | 512 | text | HTML | No |
| 18 | `updateDealSummary` 4949 | 2048 | blocks | JSON | Dead code |
| 19 | `generateDocReviewNotification` 4976 | 2048 | text | HTML | Dead code |
| 20 | `parseReferralEmail` 5036 | 512 | text | JSON | **Yes**: creates a deal |
| 21 | `generateReferralWelcomeEmail` 5118 | 512 | text | HTML | No |
| 22 | `generateDailySummary` 5170 | 8192 | JSON | HTML | No |

How documents are sent to the model (`src/lib/pdf.js:29-92`):
- Extracted text is sent as a text block when it is long enough and not form-like.
- Form-like, scanned and "dual-path" PDFs are sent as base64 `document` blocks.
- Images are sent as base64 `image` blocks.
- AML/PEP documents are excluded from these substantive-analysis calls (`ai.js:24-35`).

## 6. Where `vienna-ip-specification.md` is contradicted by code or stale

- **III.4:**
  - It omits the routing classifiers (calls 10–12, 15, 20).
  - "Decision gates do not consume LLM numeric values" is false in the fallbacks: `webhook.js:3511`, `:4475`, `:444`, `:108`, `:139`, `:503`.
  - Non-numeric model fields also gate routing.
- **III.5:** line numbers are stale. The correct ones are `:535`, `:340`, `:566`, `:621`. Q2 and BUG-4 run on the first email only.
- **III.6:** "figures … not re-derived by the model" is only partly true. The escalation email and the prelim narrative are written by the model from model-extracted data. Canonical values are only suggested to the model in the prompt.
- **IV(e):** refs stale (`:595`, `webhook.js:3531`, `:3582`). There is no call in the active branch.
- **IV(f):** the TBD row lives in `discrepancy-engine.js:765-791`, not in `webhook.js`.
- **IV(g):** refs stale (`webhook.js:3759-3808`; `parseBrokerCorrections` is at `canonical-fields.js:1081`). After a correction, only `shouldEscalateOnAnyLtv` re-runs, not the IV(e) guard or Q2.
- **IV(h):** contradicted. The two-branch carve-out it quotes was replaced by Option C (commit `a621a20`, comments `:415-457`). It is now one condition plus the `requested >= existing` guard, and lender match is no longer required. The spec's "roll back by removing the added branch" no longer describes the code.
- **IV(i):** partly accurate. Q2, Q7, Q9 and Q10 are inline in `webhook.js`, and Q6 is a constant in the cron file.
- **VI, rule by rule:**
  - **Q1:** the lender no longer has to be identified, and refinance is the default (see section 1); refs stale.
  - **Q2:** refs stale; first email only; the broker also gets the collateral-ask email first.
  - **Q3:** the model, not code, does the summation.
  - **Q4:** there is no broker clarification; the message appears on the admin Snapshot only.
  - **Q5:** the doc ask goes into the model prompt and is not inserted by code.
  - **Q6:** there is no escalation after the last reminder; the deal is only listed in the daily summary.
  - **Q7:** US-only signals, lets the deal through when unsure, new-client path only.
  - **Q9:** refs stale; relies on the From-header substring match and possibly the model classifier.
  - **Q10:** compares against the model's summary, not canonical state; only 3 of the 5 fields are actually compared.
  - **Q11:** the spec says "by proximity", but the code explicitly has no proximity fallback.

**Commits worth citing:** `d749b1e` (gates moved to canonical LTV), `a621a20` (Option C), `8b65776` (Q2), `9794d61` (Q7), `54c45e6` (BUG-7), `a5c032c` (Q10), `94acb72` (Q11), `21ccbe4` (Q6), `15a99c1` (Cluster E sweep), `693331d` (Cluster B strip/inject), `625d3fb` (completeness honesty guard), `73f395d` (fence strip), `85ea4cc` (deterministic lender checklist).

**Open questions:**
- Should the thresholds be configurable? Code comments mark them "calibration pending".
- Should the 4 dead model functions be removed?
- Should Q2 and BUG-4 also run on follow-up turns?
- Is the From-header substring match strong enough for admin authority?