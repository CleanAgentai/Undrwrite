# Bulletproof — Remaining Work → PROGRAM COMPLETE (2026-05-31)

Staging LIVE on `fb19a3f`. **All work items closed.** Methodology + carry-forwards:
PHASE-8-METHODOLOGY.md. Decisions ledger: DECISIONS-NEEDED.md. Follow-up engagement items
(out of charter): POST-CLOSURE-FOLLOWUP-ITEMS.md.

---

## OPEN — NONE. Program complete.

All previously-open items closed at the Franco closure + the BATCH-15 final verification re-run:
1. **Track 4 — Q1-escalation LIST-C bulk → DISSOLVED.** Franco's Q1-rate refinement (`915193c`)
   routed the 41-set back to active; the held bulk was spec-aligned, not bugs (§g 5th confirmation,
   41→0). No bulk rewrite needed.
2. **C01 — admin-intake → ALREADY-CORRECT** (`bec178f`). Code already processed admin-intake
   normally; only the spec was stale.
3. **Q8-detection-extension → KEEP** (`75d91e2`, Franco-ratified). No revert.
4. **A33 part (b) → DEFERRED-DOCUMENTED.** Broker-prose existing-balance extraction conflicts with
   documented conservatism; BUG-5's visible-TBD prevents silent omission. (Same architectural
   conservatism reaffirmed by Bug-3-EXT-2's E09 scoping — broker-prose existing-balance is untrusted
   for decision-driving gates.)
5. **Final full-matrix verification re-run → COMPLETE** (BATCH-15, `results-4.json`). Valid run on
   `8de2dad` (after a credit-starved invalid run, archived). Bucket-(d) probe (9→1) surfaced Bug-7
   + Bug-3-EXT-2; fix-cycle deployed (`fb19a3f`) + Phase-5 spot-check-verified. Cleanup 100%.

---

## COMPLETED (with commit + final disposition)

### Confirmed Vienna bugs (defense-in-depth / extraction / continuation) — 7 total
- **Bug-1** gate-input hygiene — `d749b1e` (Phase 6). Gates consume canonical LTV.
- **Bug-2** magnitude-suffix money — `2238952` (Phase 6). Centralized normalizeMoney + sanity bound.
- **Bug-3** broker-shorthand extraction — `d76e02b`; **EXT** `b427906`; **EXT-2** `f6bb964`
  (BATCH-15: private-2nd "Private Nth: $X" loan label + numeric-ordinal position).
- **Bug-4** escalation-gate canonical-incompleteness guard — `988badd`.
- **Bug-5** prelim-render existing-balance determinism — `792775c`.
- **Bug-6** — RULED OUT (lineage-preserved): E05 status-transition candidate dismissed as a harness
  capture-ordering artifact (persisted status correctly `rejected`).
- **Bug-7** correction-intent routing from awaiting_collateral — `54c45e6` (BATCH-15). Composes
  against R10-G `parseBrokerCorrections` + active-branch gate re-eval.

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
