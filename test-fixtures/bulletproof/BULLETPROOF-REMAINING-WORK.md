# Bulletproof — Remaining Work (consolidated 2026-05-30)

Staging LIVE on `792775c`. Consolidated by status. Methodology + carry-forwards:
PHASE-8-METHODOLOGY.md. Decisions ledger: DECISIONS-NEEDED.md.

---

## OPEN — gated on Franco's clustered-text response (4)

1. **Track 4 — Q1-escalation cat-1 LIST-C bulk.** The 41/125 awaiting_collateral scenarios
   (15 newly escalating from Bug-3 × Q1 composition; BATCH-13). Bulk expected.json update to
   workflow=awaiting_collateral + collateral-ask is HELD on Franco's **Q1-escalation-rate
   disposition** (is escalating ~1/3 of deals for "no explicit payout language" intended, or
   too aggressive?). Newly-escalating set: A06 A17 D06 D08 E02 E03 E28 E29 F01 F06 F07 F12 F14
   F23 F24. Expected outcome: spec-aligned (not bugs) → Bug-N count unchanged.
2. **C01 — admin-intake disposition.** Should Vienna set `admin_controlled=true` when
   `FromName="Admin"` sends the initial intake? The one product-design item never in Franco-9.
3. **Q8-detection-extension keep-or-revert.** FRANCO-PREDICTED-Q8-EXTENSION (`75d91e2`) broadened
   joint detection to the name-conjunction; revertible if Franco prefers credit-bureau-doc-
   confirmation-only. Pairs with the original Q8 (`b20b7cd`).
4. **A33 part (b) — canonical loan_app existing-balance extraction.** BUG-5 (`792775c`) fixed
   A33's silent-omission (deterministic "Existing 1st Mortgage Balance: TBD" row, 3/3). The $410k
   VALUE is canonical-absent (extractFromLoanApplication doesn't extract existing-balance).
   Adding it upgrades the row TBD→$410k BUT flips A33 active→Q1-escalation (refi, no confirmed
   payout → combined 110%). **Entangled with item 1** — unblocks once Q1-rate is ratified.

---

## POST-CLOSURE (1)

5. **Final full-matrix verification re-run** (post-Track-4). Confirms: the 41-escalation set is
   spec-aligned (eval=PASS, not bugs); Q9 admin-override (C06) + any remaining multi-turn
   features live-fire-verify on the clean dataset; final Bug-N tally; cleanup 100% holds. This is
   the closure batch's single deploy + re-run event.

---

## COMPLETED (with commit + final disposition)

### Confirmed Vienna bugs (defense-in-depth / extraction)
- **Bug-1** gate-input hygiene — `d749b1e` (Phase 6). Gates consume canonical LTV.
- **Bug-2** magnitude-suffix money — `2238952` (Phase 6). Centralized normalizeMoney + sanity bound.
- **Bug-3** broker-shorthand extraction — `d76e02b`; **EXT** `b427906` (2nd-mortgage + Pattern-A FP).
- **Bug-4** escalation-gate canonical-incompleteness guard — `988badd`.
- **Bug-5** prelim-render existing-balance determinism — `792775c`.

### Franco-9 + follow-ups (all shipped + live)
- Q1 `e8975be`, Q2 `8b65776`, Q3 `6a67e59`, Q4 `a35947a`, Q5 `1255199`, Q6 `21ccbe4`,
  Q7 `9794d61`, Q8 `b20b7cd`, Q9 `f1e944e`, Q10 `a5c032c`.
- **Q5 render-plumbing** `d4bd476` + **Q5 doc-ask second-surface** `2734032` (audit consolidated
  3 same-root borrower-identity sites).
- **Q8 detection broadening** `75d91e2` (name-conjunction; keep/revert = OPEN item 3).

### LIST-C (per-update Franco-rule justification)
- Verification-surface broker_correction mechanism `0c826b9`; Q10-renotify A01/A13/C07 `14989bc`.
- E07 combined-LTV `abef24f`; A14 escalation `c4c3d3c`; F04/F13 combined-LTV `6481363`.
- A03 casing + F23 province-form `2b3ba10`. (A34 held — no prelim → correct.)

### Operational debt — CLOSED (re-measured at full scale)
- **Cleanup-correlation:** BATCH-8 ~43% leak → BATCH-13/14 **100% auto-cleaned, 0 residual**.
  Phase-1 threading `db0ccb6` (correction-as-second-deal eliminated) + Phase-4 runTag-email
  sweep `ca8d948`.
- **Multi-turn replay threading + poll-for-stable** — `db0ccb6`.

### Verification ceilings — DOCUMENTED (not defects)
- Q5 corporate-row + Q8 joint-via-name on escalating flow shapes — VERIFICATION-CEILING-Q5-Q8-
  FLOW-GATED.md (`5e76b71`). Unit-harness is the ceiling for flow-gated subsets; E11 is the Q8
  end-to-end confirmation.

### Discipline-1 reclassifications — CONFIRMED
- E01/E07 were the Bug-3 extraction gap, NOT premature-prelim (the 9b diagnosis, corrected by
  BATCH-13 empirical isolation).

---

## CARRY-FORWARDS

Consolidated index in **PHASE-8-METHODOLOGY.md §f** (source detail: PHASE8-CARRY-FORWARDS.md).
