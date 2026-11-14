# Phase 0: setup and baseline (2026-11-14)

## Done
- **Branch:** `vienna-hardening-2026-11`, cut from `edae488`. That is the same commit Render last deployed.
- **Committed pending work:**
  - the June IP docs, exactly as sent to counsel
  - 4 staging replay scripts
  - the patent and execution plans, plus `research/`
- **Installed dependencies** with `npm ci`. All modules load.
- **Database snapshot** saved to `backups/vienna-snapshot-2026-11-14T14-38-19-955Z.json` with the new `scripts/snapshot-db.js` (read-only, pages through each table). Counts match the live tables exactly: deals 4, messages 24, documents 20, daily_summaries 24.
- **Harness runner** `scripts/run-harnesses.js` written. macOS has no `timeout` command, so the runner is in Node. It is the regression gate for every Phase 1 item.

## Live system state
- **Render service `Undrwrite` is SUSPENDED** (since 2026-06-30). `/health` returns 503.
  - Last live deploy: `edae488` (2026-06-23).
  - `autoDeploy: yes` from `main`, so merging to `main` deploys automatically.
- **No real broker traffic.**
  - 3 deals are Franco's tests (`vimarealty.com`, June 11–22).
  - 1 deal is spam: an Anthropic marketing email from `@email.anthropic.com` became a deal, and Vienna replied to it. This is F13 below.
- **No live deal is stuck in an F1/F2/F3 state**, so nothing needs repairing after deploy.
- The last daily summary went out on 2026-06-29.
- The Grace Paulson test deal received 4 reminders (06-14, 15, 17, 18), which matches the max-4 cadence.

## Harness baseline on `edae488`: 27 of 41 pass
Full report: `docs/patent/baseline/harness-baseline-edae488.txt`.

**All 14 failures are stale tests, not behaviour regressions.** There are three kinds:

| Kind | Harnesses | Why they fail |
|---|---|---|
| Source-text regex over code that was refactored later | `bug5-existing-balance-deterministic-row`, `franco-q5-doc-ask-second-surface`, `franco-q5-render-plumbing`, `r10a`, `r10c`, `r10f`, `r10h`, `r10i` | They pattern-match exact source text or line numbers. Checked: the behaviour still exists. For example, the BUG-5 row is at `discrepancy-engine.js:785-790`. |
| Load production deals that were deleted when the tests cleaned up | `r10b` (Donna), `r10d` (Patricia), `r10e`, `r10g` (Ethan), `r11b` (Marcus), `r11c` (Marcus) | The deal rows no longer exist in Supabase |
| Assert a removed feature | `franco-q5-*` "R10-I site 2", `r10i` (`composeBrokerLenderPackageEmail`) | The broker lender package was removed on purpose in `3cbd82b`. Its replacement led to F14 below. |

## New findings, added to Phase 1
- **F13: sender denylist matches substrings, not domains.** `'@anthropic.com'` doesn't match `@email.anthropic.com`, so marketing mail becomes deals and Vienna answers it. Fix: match on the sender's domain, so a listed domain also covers its subdomains.
- **F14: the lender package skips the deterministic deal logic.** `buildCompletionLenderPackage` (`webhook.js:1777`) doesn't build the Q3/Q4 qualification roster, the Q5 corporate detection or the Q11 registered-owner check. Its Deal Snapshot is written by the AI. The prelim builds all of these in code (`webhook.js:1374-1426`). The final "Ready to Close" package should carry the same code-built facts as the prelim.
- **T1: repair or retire the 14 stale harnesses** so the whole suite passes and can actually catch regressions.
  - Source-grep checks become behavioural checks where possible.
  - Checks that depended on deleted production deals switch to the saved fixtures.
  - Checks for removed features are deleted, with a note saying why.

## Blocker for live verification
The only deployment is suspended. Live verification needs either the service resumed, or a separate test service. See the session for the decision.
