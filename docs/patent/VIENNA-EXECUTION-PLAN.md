# Vienna: execution plan (fix first, then document)

Prepared 2026-11-14. This follows on from `VIENNA-PATENT-PLAN.md`.

**Ground rules**
- We own every technical and product call. Nothing waits on anyone outside the team.
- **All existing logic stays.** Every gate, rule (Q1–Q11), guard and Bug-N fix remains. The fixes close gaps and make the current behavior apply consistently. Nothing is redesigned or removed, apart from code that is already dead.
- We fix first, freeze a tagged commit, then describe exactly that commit to the attorney.

---

## 1. What we're fixing

I checked every item below against the code at HEAD `edae488` and give the file:line for each. They were found by reading the code; Phase 2 confirms each one by running it.

| # | Problem | Evidence |
|---|---|---|
| F1 | After admin approval or the Q9 override, the next broker email puts a high-LTV deal back into `awaiting_collateral` | `webhook.js:4480` `willGoToCollateralCheck` doesn't check `prelim_approved_at`. `collateral_override_at` is written but never read. |
| F2 | Admin SEND does nothing on Q9 override drafts | The override sets the deal `active` (`2670`), but the draft check at `2408-2412` only accepts `active` + `approval_completed` |
| F3 | The >90% auto-decline (Q2) and the incomplete-data escalation (Bug-4) only run on a deal's first email | Called only at `3520` and `3531`. Follow-up emails only run `shouldEscalateOnAnyLtv` (`4476`). |
| F4 | A >90% deal's broker gets a welcome email, then a decline | The welcome is queued at `3418`, before the gate block. The decline goes out at `3573`. |
| F5 | The auto-decline emails (Q2, Q7) skip the routing-leak and opener cleanup | They are generated, then sent directly (`3572`, Q7 path) |
| F6 | Some outbound emails are saved without a Message-ID, or not saved at all, so replies to them can't be matched to their deal. An admin reply to an alert is treated as a new referral. | `3189`, `3209`, `3574`; admin alerts are never saved |
| F7 | The inbound webhook has no authentication, and duplicate filtering is in memory only | `src/index.js` has no auth; `processedMessages` Set (`2152`); inbound IDs are never stored |
| F8 | Some broker correction wordings aren't recognized, and the existing balance can't be corrected | `parseBrokerCorrections`. Recorded staging results: A06 (expected $345k, got $310k), A08, A34 |
| F9 | Q10 re-notification was designed for 5 fields but can only fire for 3. It compares the AI summary against figures scraped from the prelim HTML. | `Q10_MATERIAL_FIELDS` (5 fields) vs `q10ParsePriorFromPrelim` (3 money fields), `webhook.js:1653-1700` |
| F10 | The lender-package checklist counts a balance statement as the payout statement, but the completion gate doesn't | `ai.js:95-118` vs `dealType.js:93-100` |
| F11 | Four AI functions are never called, and several comments are wrong | `classifyImage`, `updateDealSummary`, `generateInfoRequestEmail`, `generateDocReviewNotification`; comments at `2398`, `2472`, `1906` |
| F12 | A branch can never run: the collateral re-ask checks `awaiting_collateral` inside the `active` branch | `webhook.js:4364`, `4620` |
| F13 | The sender denylist matches substrings, not domains. An Anthropic marketing email from `@email.anthropic.com` became a deal and got a reply. Found in live data during Phase 0. | `webhook.js:2182-2197`; live deal `0283bf88` |
| F14 | The "Ready to Close" lender package skips the Q3/Q4 roster, Q5 corporate and Q11 owner logic, and the AI writes its Deal Snapshot. Found in Phase 0. | `buildCompletionLenderPackage` `webhook.js:1777` vs the prelim at `1374-1426` |
| T1 | 14 of the 41 existing harnesses fail on HEAD, and all of them are stale tests (see PHASE-0-REPORT.md) | `docs/patent/baseline/` |

**Product improvements, all built on logic we already have:**

| # | Improvement | Why |
|---|---|---|
| P1 | **Save the structured fact record (canonical map) at each decision point.** Store it when a prelim goes out, and on every inbound email that changes it. | This is what Q10 should compare against, rather than scraped HTML. It also gives a per-field audit trail of what changed, when, and from which source. It reuses `extractCanonicalFieldsAggregated` unchanged. |
| P2 | **When a gate falls back to the AI's LTV because code couldn't compute one, say so** on the admin prelim ("LTV estimated — canonical inputs incomplete") and in the logs | The fallback logic stays. It just becomes visible to the underwriter instead of silent. |
| P3 | **Q6: send one "[Stalled]" alert to the admin when a deal hits the reminder cap** | The comment at `dailySummary.js:30` already describes "escalate-to-admin". Today the deal only appears in the daily summary. |
| P4 | **Make the thresholds (80 / 90 / 75) named constants in one module**, with the current values unchanged | They are currently repeated as literals across `discrepancy-engine.js` and `webhook.js`. |

**Product calls, made by us:**
- **F3, after approval:** if a follow-up pushes LTV above 90% on a deal the admin has already approved, alert the admin; don't auto-decline the deal they approved. Before approval, follow-ups get the same Q2 auto-decline and Bug-4 escalation as the first email.
- **F8, existing-balance corrections:** a broker can correct the balance. The corrected value updates the record, the discrepancy check and the LTV, and **can trigger an escalation, but can never trigger an auto-decline on its own.** This keeps the existing rule that balances stated only in broker prose are never trusted to drive a decline (Bug-3-EXT-2).
- **F9, Q10 fields:** all 5 fields the code already lists: loan amount, property value, existing balance, property address, and transaction type / mortgage position. The comparison is between saved snapshots of the fact record (P1).
- **The auto-decline emails** still go out automatically, as now. F5 adds the cleanup step only.
- **AI-derived routing flags** (`identity_clash`, `exit_strategy`, `is_purchase`, `unresolved_discrepancy`) stay as they are. The document describes them accurately.

---

## 2. Live system

Vienna has a single deployment, `undrwrite.onrender.com`, with one Render service and one Supabase project. Every push to `main` deploys to the system that's in use. So:
- Back up the database before each deploy, and deploy during low-traffic hours (evening, Edmonton time).
- Rollback is redeploying the previous commit through the Render API. `RENDER_API_KEY` is already in `.env`.
- Phase 0 measures real traffic from the database (read-only), so we know what's live and which deals each fix touches.

---

## 3. Phases

### Phase 0: Setup (DONE, see PHASE-0-REPORT.md)

1. Move this session into `~/Undrwrite` and create the branch `vienna-hardening-2026-11`.
2. Commit the work already sitting there: the modified `IP-SUBMISSION-ENGINEERING-AND-OSS.md` and three untracked replay scripts.
3. Run `npm install`.
4. Take a fresh database snapshot, using the same export format as the 05-19 backup. This is the baseline and the restore point.
5. Profile traffic, read-only: deals created since June, statuses, and real senders vs Franco's test addresses. Find any deals currently sitting in the states F1/F2/F3 affect, because they will need to be corrected after the deploy.
6. Run all 41 existing harnesses on HEAD and record the baseline, so any later failure is clearly new.

### Phase 1: Fixes and improvements

Every item follows the repo's established pattern:
1. Write a deterministic harness in `scripts/` that reproduces the problem, and confirm it **fails**.
2. Make the smallest fix.
3. Confirm the harness passes, and re-run the harnesses for that area.
4. Make one commit per item, with the root cause and the revert path in the message, so each item can be reverted on its own.

| Order | Item | Approach | Harness |
|---|---|---|---|
| 0 | **T1** Stale harnesses | Rewrite source-grep checks as behaviour checks, move deleted-deal checks onto saved fixtures, retire checks for removed features with a note | `run-harnesses.js` passes 41/41 |
| 1 | **P4** Thresholds | Extract the constants first, so every later fix uses them | Existing LTV harnesses pass unchanged |
| 2 | **F2** Q9 SEND | Include a pending Q9 draft (an `active` deal with `draft_action` set and `collateral_override_at` set) in the draft check. Audit every place `draft_action` is set or cleared, so a stale draft can never match. | Override → preview → SEND sends the email; REJECT and CONDITIONS drafts do the same |
| 3 | **F1** Approval loop | Add the `prelim_approved_at` / `collateral_override_at` check to `willGoToCollateralCheck`, following the same pattern as `computeWillReview` | An approved deal receiving a broker document stays `active` and keeps collecting documents |
| 4 | **F3** Gates on follow-ups | In the active branch, compute the thread-aggregated fact record and run Q2 + Bug-4, with the post-approval rule from §1 | A correction pushes LTV to 92%: rejected before approval, admin alert after approval. Bug-4 and Bug-7 harnesses still pass. |
| 5 | **F4** Welcome then decline | Evaluate Q2 before the welcome email is queued, so a deal being declined only gets the decline | A first email over 90% produces exactly one broker email |
| 6 | **F5** Clean up auto-declines | Run the Q2/Q7 decline emails through `sweepBrokerFacingDraft` | Extend the routing-leak harness |
| 7 | **F6** Message-IDs | Save the `MessageID` on `3189`, `3209` and `3574`. Save every admin alert, with its ID, against its deal. | An admin reply to `[Auto-Decline]` / `[Potential Duplicate]` routes to that deal, not to the referral path |
| 8 | **F7** Webhook auth + idempotency | Add a Basic-auth check behind `INBOUND_WEBHOOK_AUTH`, off when unset. Store each inbound `MessageID` in `messages.external_message_id` and skip duplicates against the database (`findByMessageId` already filters to outbound, so this is safe). | Bad credentials get 401, good ones get 200; the same message delivered twice is processed once |
| 9 | **P1** Save the fact record | Add a migration: a `canonical_snapshots` table (`deal_id`, `trigger`, `canonical_map` JSONB, `created_at`), written at prelim send and on inbound emails that change the record. Apply it in the Supabase SQL editor, the same way the earlier migrations in `src/migrations/` were applied. | A snapshot is written; a second email adds a row only when something changed |
| 10 | **F9** Q10 on canonical snapshots | Compare the current record against the snapshot taken at prelim send, across all 5 fields. Keep the existing "prior 0 means not yet known" guard. | One test per field, plus the doc-only completion turn: no notice |
| 11 | **F8** Correction wording | Add patterns for "updating / updated / revised / actual / should be / correct figure is" + field, guarded against false positives the same way as the existing ones. Add `existing_first_mortgage_balance` as a correctable field, following the §1 decline rule. | Fixtures A06, A08 and A34 now give the expected values; FP-guard cases and all existing correction harnesses pass |
| 12 | **P2** Show the LTV fallback | When the canonical LTV is null and the AI's figure is used, flag it in the Snapshot callout and the log | Fallback deal shows the callout; canonical deal shows none |
| 13 | **P3** Stalled alert | One `[Stalled]` email to the admin when a deal hits `MAX_REMINDERS`, saved with its ID and sent only once | Cap reached: one alert, never repeated |
| 14 | **F10** Checklist | The lender-package checklist uses the `dealType.js` satisfaction rules | A balance statement alone shows "Not on file" for payout |
| 15a | **F13** Denylist by domain | Parse the sender's domain and match listed domains exactly or as a parent domain; keep per-address entries | `@email.anthropic.com`, `@fyi.postmarkapp.com` and `noreply@` are blocked; `franco@vimarealty.com` and normal brokers pass |
| 15b | **F14** Lender package parity | Build the same roster, corporate and Q11 inputs as the prelim, and replace the AI-written Snapshot with `renderDealSnapshot` (prepend it like the prelim does) | Lender package for a joint/corporate fixture contains the code-built Snapshot rows and roster |
| 15 | **F11 / F12** Hygiene | Remove the 4 dead AI functions and the unreachable branches, and correct the wrong comments | `node --check` + full harness sweep |

### Phase 2: Verification and deploy

1. **Deterministic:** all 41 existing harnesses plus about 15 new ones must pass, compared against the Phase 0 baseline.
2. **Deploy:** take a backup, deploy in the evening window, then watch the Render logs through the first live inbound emails.
3. **Fix up affected deals:** correct any live deals Phase 0 found stuck in F1/F2/F3 states. Write a script that shows the changes before applying them, and log each correction.
4. **Deployed replay:** run Franco's 15 scenarios end to end against the live service, using the Round-9 replay scripts. Our own team checks each output.
5. **Regression subset:** about 30 scenarios from the 125-scenario suite, covering the touched areas (A-series corrections, B07/C06/F14 collateral, E05 decline, Q9/Q10). Run the full 125 (about $31 of API usage, about 3.4 hours) only if the subset shows anything unexpected.
6. **Freeze:** tag the commit `vienna-patent-baseline`. The attorney document describes exactly this commit.

### Phase 3: Attorney document

1. **Regenerate the real outputs** from the frozen commit: a preliminary review and a "[File Complete] — Ready to Close" lender package, from a replayed scenario (Ethan Broussard or Sandra Whitfield).
2. **Refresh the research files** in `research/` against the frozen commit, covering line numbers and the "how it works" for every area changed.
3. **Diagrams (7)**, as vector files exported to PDF and PNG:
   - whole system M1–M12
   - document routing
   - building the fact record and its snapshots
   - gate decision tree
   - state machine
   - "AI writes, code enforces"
   - admin approval loop
4. **Twelve module sections**, each answering the attorney's questions in their order: purpose, input, how it works, output, AI (model, configuration, what it can and can't influence, the checks on it), errors and correction, changes to facts, problem solved, evidence.
5. **Appendices:**
   - A: every Claude call
   - B: one deal traced through every module
   - C: test evidence, and bug history including this round
   - D: corrections to the June documents
6. **Accuracy pass:** an independent reviewer checks every claim against the frozen code.
7. Internal review (Brandon, Porter), then send to the attorney with a short note that this supersedes the June documents.

---

## 4. How we work

Each phase, then each item in it, goes through the same loop: **plan the implementation → implement → verify live → check it off → next item.**

The main risk is a regression on the live system. It's controlled by the backup and rollback, one revertible commit per item, harnesses that fail before each fix and pass after it, and the deployed replay of all 15 scenarios.
