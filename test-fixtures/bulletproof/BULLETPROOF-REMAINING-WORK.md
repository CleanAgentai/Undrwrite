# Bulletproof — Operational Debt / Remaining Work

## BATCH 14 — EXPANDED FIX-CYCLE SCOPE (set during BATCH 12, 2026-05-29)
The closure batch is bigger than originally projected — but bounded and concrete:
1. **Bug-3** — canonical money-extraction robustness (5 broker-shorthand patterns). Full
   spec + per-pattern harness in BUG3-SCOPE.md. ~11 affected scenarios.
2. **Q5 corporate Snapshot row not rendering** (BATCH-12 finding) — trace the render-time
   borrower_name plumbing into detectCorporateEntities; F03 probe = clean repro.
3. **Q8 joint-applicants row not rendering for joint-via-name deals** (BATCH-12 finding) —
   broaden the joint feed beyond detectJointMultiBorrower's 2+-credit-report requirement
   (or a Franco disposition on the definition of "joint"). E11/E12/F12 = repros.
4. **HELD LIST-C cat 1 (Q1 escalation) + cat 2 (Q2 decline)** — re-verify against the clean
   BATCH-13 dataset (post-Bug-3, post-Finding-1b), then apply spec updates. See DECISIONS-NEEDED.md.
5. **HELD combined-LTV / 2nd-mortgage spec updates** — unblock after Bug-3 (E07/E08/A24/E13/
   E23/E28/E29/F03/F06/F07/F14 + F04/F13).
6. **A14-specific** — re-classify after Bug-3 (word-order intake) + Finding-1b resolution.
7. **E01/E02 re-probe** — confirm whether the 9b "premature-prelim" diagnosis was actually the
   Bug-3 "$X against $Y" extraction gap (BUG3-SCOPE.md flag).
8. **Q9 admin-override (C06)** — BATCH-13 live-fire before writing the spec.
9. **Q5-DOC-ASK-SECOND-SURFACE** (BATCH-12 deploy finding) — the accountant-financials
   doc-ask (ai.js:2826) self-computes from dealSummary.borrower_name only (no deal.borrower_name
   fallback; webhook doesn't thread corporateDocAsk) → also fails for corporate deals where
   dealSummary.borrower_name is empty. Same root as the (fixed) Snapshot-row bug, different
   surface. See BATCH12-DEPLOY-VERIFICATION.md.
10. **CORPORATE-DEAL-PRELIM-FLOW + Q5 end-to-end live-fire** — corporate deals rarely reach a
    prelim (refi→escalate per Q1; non-refi→doc-ask). Need a non-escalating doc-complete corporate
    scenario to live-fire the Q5 Snapshot row (deferred from BATCH-12; the fix is deployed +
    unit-verified, end-to-end live-fire pending).
11. Plus any new surfaces BATCH-13's clean full re-run reveals.

Meta: Q5/Q8 (and Q9) shipped in the Franco-9 bundle with unit harnesses only; BATCH-12
live-fire probes showed Q5/Q8 don't surface end-to-end. BATCH-13's full re-run should
live-fire-verify ALL Franco-9 rendering features, not just the deterministic logic.

---

## Infra debt (non-blocking)

### Batch-replay cleanup correlation unreliable at scale
`scripts/bulletproof-replay-batch.js` cleans each scenario's synthetic deal via
`cleanupRun(runTag, {dealId})` after evaluate. In the BATCH 8 sequential 125-run,
this LEAKED ~54 of 125 deals (manual sweep required to restore staging hygiene).
Before the next 100+ scenario run (likely rerun-until-clean iterations), HARDEN the
correlation logic so cleanup is automatic — candidate causes: dealId not always
captured from runScenario; multi-event scenarios creating deals under alternate
correlation; runTag subaddressing mismatch. Not blocking; real infra debt.
