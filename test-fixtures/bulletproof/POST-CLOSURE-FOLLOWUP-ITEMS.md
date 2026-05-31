# Post-Closure Follow-Up Items

Items surfaced during the bulletproof program that are **out of scope** for the
program's verification charter (Vienna decision-correctness on the 124/125 synthetic
matrix) but are worth tracking as future product-resilience work. None of these is a
Vienna decision-logic defect; none blocks program closeout.

---

## FOLLOWUP-1 — Graceful degradation when the AI backend is unavailable

**Status:** OPEN (future work; not a Bug-N, not a Franco-rule)

**What:** When Vienna's Anthropic API calls fail (credit exhaustion, rate-limit/429,
provider outage, key/billing error), the webhook handler creates the deal record
(`status` is set on the initial insert, which needs no AI) and then the downstream
AI-dependent pipeline — canonical extraction, prelim/Snapshot render, outbound email
generation, `messages` persistence — **aborts on the thrown API error**. The result is an
**orphan deal**: `extracted_data` empty, no `messages` rows, no outbound email to the
broker, and **no admin alert**. There is orphan-scaffold cleanup, but no *graceful
degradation* and no *operator notification*.

**Empirical demonstration (2026-05-30):** During the final verification re-run, the
staging Anthropic account exhausted its credit balance. Staging logs showed repeated
`invalid_request_error: "Your credit balance is too low to access the Anthropic API."`
Every scenario in the credit-starved run created a deal (`status` captured, routing
actually *correct* — 97/125 matched expected) but produced **0 outbound in 123/125 and
0 Snapshots**. The credit-starved dataset is archived at
`archive/results-4-CREDIT-STARVED-INVALID.json` as operational evidence. Credits were
restored (Franco added credits + enabled auto-reload) and the re-run was redone clean.

**Why it matters:** In production this is a **silent failure mode**. A real broker email
during an AI-backend outage would create a deal and then go unanswered, with nothing
surfaced to an operator. The deal looks "active" in the DB but Vienna never actually
processed it.

**Candidate remediations (not yet scoped):**
- Wrap the AI pipeline so a backend failure marks the deal `needs_attention` (or a
  dedicated `processing_failed` state) instead of leaving a silently-orphaned `active` deal.
- Emit an **admin alert** (email/log/dashboard) on AI-backend failure so an operator
  knows processing stalled.
- Optional: a retry/queue so transient failures (429, brief outage) self-heal once the
  backend recovers — auto-reload billing (now enabled) covers the credit case but not
  rate-limit or outage cases.

**Cross-references:** PHASE-8-METHODOLOGY.md §d (operational-debt-closure — credit
incident note); PHASE8-CARRY-FORWARDS.md (consolidated carry-forward index).

---

## FOLLOWUP-2 — Replay-harness rate-pressure under sustained large runs

**Status:** OPEN (test-infrastructure hardening; not a Vienna concern)

**What:** Stacking multiple full-matrix runs (each ~125 scenarios, ~$31 of model spend)
back-to-back in one window drives sustained Anthropic API load. On 2026-05-30 this
contributed to draining the staging credit balance and surfaced intermittent 429s. The
harness has no inter-run throttle or pre-flight credit/billing check.

**Candidate remediations:**
- A cheap **pre-flight check** before launching a full run: single-scenario probe that
  confirms extraction + outbound + Snapshot and scans recent logs for credit/429 errors.
  (This was done manually as the A01 pre-flight on the post-restore re-run; could be
  folded into `batch15-fullmatrix-run.js` as an automatic gate.)
- Optional inter-scenario delay / concurrency ceiling to ease provider rate-pressure on
  very large sweeps.

---

## FOLLOWUP-3 — Harness deal-status capture-read-ordering

**Status:** OPEN (test-infrastructure hardening; not a Vienna concern)

**What:** The replay harness's `finalDealState` capture (`test-fixtures/bulletproof/lib/replay.js`,
final-state re-fetch after `pollForStableOutbound`) can read `deal.status` **around an in-flight
finalization update** — capturing a transient/pre-finalization status rather than the terminal
persisted value. The deal record in Supabase is correct; only the capture is stale.

**Empirical demonstration (2026-05-31, Bug-7 diagnosis):** Two scenarios in the final
verification re-run looked like routing divergences but were capture artifacts, confirmed by
**direct Supabase reads**:
- **E05** (92% refi): harness captured `active`; persisted `deal.status` = `rejected` (Q2
  auto-decline), stable at 0/15/30s. Vienna behaved correctly.
- **B07** (collateral-offered exit): harness captured `awaiting_collateral`; persisted
  `deal.status` = `active`, `collateral_offered=true`. Vienna behaved correctly.

Both scenarios' `expected.json` now carry a HARNESS-CAPTURE NOTE; the spec values match the
persisted truth (E05→`rejected`, B07→`active`).

**Why it matters:** capture-ordering artifacts **mimic real Vienna routing bugs** and cost
investigation time at every full re-run. The diagnosis discipline ("read the persisted DB value
before classifying as Vienna behavior") catches them, but the harness should not produce them.

**Candidate remediations:**
- Final-state capture should **poll-for-status-stable** (read `deal.status` repeatedly until it
  is unchanged across N reads / M seconds) before recording — mirroring the existing
  `pollForStableOutbound` pattern for outbound counts.
- Or re-fetch `deal.status` once more after a short settle delay following the
  outbound-stable conclusion.

**Code location:** `test-fixtures/bulletproof/lib/replay.js` final-state capture (the
`finalDealState` re-fetch after the final `pollForStableOutbound`).

---

## FOLLOWUP-4 — Correction-acknowledgment outbound (F14-shape silent re-escalation)

**Status:** OPEN (UX-layer; not a routing defect)

**What:** When a broker correction is processed from `awaiting_collateral` (Bug-7 routing) and
the deal **re-escalates** because the gate inputs still aren't fully resolved (e.g. F14: refi
correction applied, but property value still null → Bug-4 re-escalates at 89.6%), **no outbound
acknowledges the correction**. The broker sees the original collateral-ask and then silence —
nothing confirming the correction was received or that the deal is now classified differently.

**Why it matters:** Bug-7 fixes the *routing* (the correction is recognized + applied via R10-G,
no longer mis-classified as a collateral disposition) — verified via staging logs. But the
broker-facing experience is unchanged (silent). This is architecturally separate from the
routing fix.

**Candidate remediation:** an acknowledgment outbound on awaiting_collateral correction-processed
cases — e.g. *"We received your correction; the deal is now classified as a refinance. We still
need [missing info, e.g. property value] to proceed."* UX-layer addition; composes on top of the
Bug-7 routing without changing it.

---

## FOLLOWUP-5 — Admin-reply replay capability (C06)

**Status:** OPEN (test-infrastructure; not a Vienna concern)

**What:** The replay machinery tags **every** event's From header with `+runTag` subaddressing
for deal correlation (`test-fixtures/bulletproof/lib/replay.js:165`, `tagBrokerEmail`). For an
ADMIN event this breaks Vienna's admin-email match: `franco@privatemortgagelink.com` →
`franco+bulletproof-C06-RUNID@privatemortgagelink.com` ≠ `config.adminEmail`. Combined with
subject-pattern-based admin-reply detection (`isAdminReplySubject`), the replay routes admin
emails through the **broker** path, so **admin-reply flows (Q9 admin-override) cannot be
exercised end-to-end** via the harness.

**Demonstration:** C06 (admin manual-exception override on an awaiting_collateral deal) → the
tagged `franco+…` sender is not recognized as admin → broker path → `parseCollateralReply='no'` →
`ltv_escalated`, instead of the Q9 path (→ `active` + `collateral_override_at`). Q9 is correctly
implemented (webhook.js:2495 FRANCO-PREDICTED-Q9); the harness can't replay it. **The unit
harness IS the verification ceiling for admin-reply behavior.**

**Candidate remediation:** preserve original admin emails in the replay (or a deterministic
tag-bypass for `From` addresses matching `ADMIN_EMAIL`'s local-part), so admin-reply scenarios
run end-to-end. C06 is the canonical case requiring this.

---

## FOLLOWUP-6 — Kill-process-verification operational discipline

**Status:** OPEN (operator discipline; process note)

**What:** During the BATCH-15 final re-run setup, a `kill <pid>` on a `nohup`-launched node
batch hit the subshell, not the reparented node child — the leaner run survived and ran to
67/125 (~2h / ~$17 of model spend) before dying, **unpersisted**. The kill was assumed effective
(`kill -0` reported the subshell gone) but the actual worker kept running.

**Why it matters:** wasted compute + a confusing background state. The lesson: **verify a kill by
checking the actual worker (`pgrep -f <script>`), not just `kill -0 <pid>`** on the launch pid;
and prefer the harness's tracked background mechanism over bare `nohup &` for long runs so the
process is addressable.

**Candidate remediation:** wrap long batch runs in a launcher that records and kills the real
worker PID, or use the harness `run_in_background` tracking (addressable + auto-notified).
