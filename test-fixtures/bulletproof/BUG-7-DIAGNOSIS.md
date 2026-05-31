# Bug-7 Diagnosis — `awaiting_collateral` continuation candidates (B07 / C06 / F14)

**Date:** 2026-05-31 · **Staging:** 8de2dad · **Status:** diagnosis only, NO fix applied.

## TL;DR
Three bucket-(d) routing-divergence candidates from the final verification re-run
(B07, C06, F14 — all threaded followups to a deal in `awaiting_collateral`) were
isolated end-to-end with **direct Supabase reads** (not harness capture) plus the
disposition/route each followup actually took. **Only ONE is a genuine Vienna bug.**

| Scenario | Followup | Verdict | Root |
|---|---|---|---|
| **B07** | broker offers additional collateral | **NOT a bug** | Harness capture-read-ordering (DB is correct) |
| **C06** | admin manual-exception override | **NOT a Vienna bug** | Fixture admin From-address mismatch |
| **F14** | broker corrects purchase→refi | **GENUINE — Bug-7** | Correction intercepted by collateral-reply parser in the `awaiting_collateral` branch |

Root-cause classification: **NOT one root across three.** Three distinct causes; one
genuine Vienna bug (F14), one fixture defect (C06), one harness-capture artifact (B07).
The over-scoping discipline holds again — 3 candidates → 1 narrow genuine fix.

---

## B07 — NOT a bug (harness capture-read-ordering)
**Followup (event[1], broker):** "Marcus Webb can pledge a second property … appraised $385,000 … brings combined LTV well below 70%."
- `parseCollateralReply` → **`yes`** (correct).
- Broker-path `awaiting_collateral` handler (webhook.js:3558-3566): on `yes`, persists
  `status='active'` + `collateral_offered=true`, falls through to active handling.
- **Direct Supabase read: `dbStatus=active`, `collateral_offered=true`.** ✓ Vienna processed it correctly.
- Harness `finalDealState` captured `awaiting_collateral` — **stale read** (same capture-read-ordering
  class as E05: capture reads around the in-flight status update). The "no broker reply" is the
  legitimate Group-L silence (deal proceeded; admin gets the prelim, broker isn't sent a redundant reply).

**Disposition:** No Vienna fix. Reinforces the **E05 harness-capture extension item**
(capture must wait for status-stable / re-read terminal state). B07's `expected.json` (`active`)
matches the DB — spec is correct.

## C06 — NOT a Vienna bug (fixture admin-address mismatch)
**Followup (event[1], "admin"):** "Manual exception approved — proceed without collateral. DSCR override. Treat as standard prelim path."
- Fixture `event[1].From = admin@privatemortgagelink.com`.
- Staging `config.adminEmail (ADMIN_EMAIL) = franco@privatemortgagelink.com`.
- **Addresses don't match** → Vienna doesn't recognize the sender as admin → routes through the
  **broker** path (3545), not the admin path. `parseCollateralReply("proceed without collateral")` → **`no`**
  → `sendEscalationToAdmin` → "ACTION REQUIRED: LTV Over 80%" + `status=ltv_escalated`.
- **Direct Supabase read: `dbStatus=ltv_escalated`** (confirms broker-path 'no' route).
- The **Q9 admin-override path IS correctly implemented** (webhook.js:2495 `FRANCO-PREDICTED-Q9`:
  admin `approved` on `awaiting_collateral` → `active` + `collateral_override_at` audit). It simply
  never fires because the fixture's sender isn't the configured admin.

**Disposition:** Fixture fix — change C06 `event[1].postmark.From` to `franco@privatemortgagelink.com`
(the configured `ADMIN_EMAIL`), then it exercises the real Q9 path. No Vienna code change.

## F14 — GENUINE Bug-7 (correction intercepted in the `awaiting_collateral` branch)
**Followup (event[1], broker):** "Correction — this is actually a refinance, not a purchase. Borrower owns the property; refinancing existing first with TD Canada Trust (balance $285k per attached payout statement)."
- Deal is in `awaiting_collateral` (event[0] purchase, standalone LTV 89.6% > 80).
- Broker-path `awaiting_collateral` handler (webhook.js:3545) routes **every** broker reply through
  `parseCollateralReply` (yes/no/ambiguous). The correction contains no collateral language →
  classified **`ambiguous`** → stays `awaiting_collateral`, re-asks for collateral.
- **Direct Supabase read: `dbStatus=awaiting_collateral`, `collateral_offered=false`** — and the
  transaction-type correction (purchase→refi, TD $285k payout) **was never applied**. The deal is
  stuck in the collateral hold while the broker has actually reframed the underwriting.
- `expected.json` workflow = `active` ("Standard refi after correction"). With refi + payout the Q1
  carve-out would resolve the LTV picture → the deal should exit the hold. It does not.

**Root cause:** the `awaiting_collateral` broker-reply branch is **collateral-only** — it has no
pre-check for "is this reply a correction (or other material intent) rather than a collateral
disposition?" So any non-collateral broker reply while in the hold is funneled into
yes/no/ambiguous and the actual intent is lost.

### Sized fix proposal (Bug-7)
- **Complexity:** single-function, contained to the `awaiting_collateral` broker-reply branch
  (webhook.js:~3545). Add a **correction-intent pre-check** ahead of `parseCollateralReply`: if the
  reply carries a material correction (transaction_type / loan / value / position — reuse the existing
  R10-G `broker_correction` canonical-correction detection at webhook.js:~1402-1445, or a small
  `parseCorrectionIntent`), route it through correction-processing (recompute canonical from the
  correction, re-evaluate the LTV/escalation gate → exit the hold if the corrected picture resolves),
  instead of the collateral parse.
- **Risk surface:** moderate-low. Must NOT regress the collateral yes/no/ambiguous path for genuine
  collateral replies (a true collateral offer must still hit `parseCollateralReply`). The pre-check
  must be conservative (only divert on a confidently-detected material correction). No new DB columns;
  reuses existing correction machinery + the active-branch LTV recompute.
- **Naming:** **Bug-7** (per Porter — Bug-6 was the E05 status-transition candidate, ruled out as a
  harness artifact; lineage preserved). Confirmed Vienna bug count would go 5 → 6 (Bug-1..5 + Bug-7).

### Harness scope for the Bug-7 fix
- Unit: `parseCorrectionIntent`/the pre-check returns correction=true on F14's event[1] text and
  correction=false on B07's genuine collateral offer (no false-divert).
- Scenario: F14 isolated → after event[1], `dbStatus=active` (correction applied, hold exited),
  transaction_type=refinance; B07 isolated → still `dbStatus=active` via the collateral path (no regression).
- Negative: a plain "yes/no/I can add a second property" collateral reply still routes to
  `parseCollateralReply` unchanged.

---

## Decisions teed up for Porter
1. **Bug-7 (F14):** ship-now (single-point fix + harness, bundle deploy) vs defer-document
   (record here + POST-CLOSURE-FOLLOWUP-ITEMS.md, close program).
2. **C06:** fixture From-address fix (`admin@` → `franco@`) — trivially correct; recommend doing it.
3. **B07:** no Vienna work; folds into the E05 harness-capture extension item.
