# Bulletproof — Operational Debt / Remaining Work

## Infra debt (non-blocking)

### Batch-replay cleanup correlation unreliable at scale
`scripts/bulletproof-replay-batch.js` cleans each scenario's synthetic deal via
`cleanupRun(runTag, {dealId})` after evaluate. In the BATCH 8 sequential 125-run,
this LEAKED ~54 of 125 deals (manual sweep required to restore staging hygiene).
Before the next 100+ scenario run (likely rerun-until-clean iterations), HARDEN the
correlation logic so cleanup is automatic — candidate causes: dealId not always
captured from runScenario; multi-event scenarios creating deals under alternate
correlation; runTag subaddressing mismatch. Not blocking; real infra debt.
