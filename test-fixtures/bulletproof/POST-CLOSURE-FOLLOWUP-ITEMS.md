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
