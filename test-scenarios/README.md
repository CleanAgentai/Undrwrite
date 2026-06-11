# Vienna — Scenario Test & Verification Log

Living record of Franco's end-to-end test scenarios. We go through each one, reproduce
the reported behaviour, fix every bug deterministically, and verify — offline on the real
documents first, then on the deployed staging service — until **every single bug is squashed**.

One markdown file per scenario. Real test documents live on the Desktop under
`~/Desktop/UndrWrite Testing/Scenario N docs/`.

## Status legend

| Mark | Meaning |
|------|---------|
| 🔴 | Bug reported / reproduced, not yet fixed |
| 🟡 | Fix implemented + verified **offline** (deterministic / real-doc), deployed replay pending |
| 🟢 | Fixed **and** verified on the deployed staging service (real render surface) |
| ⚪️ | Expected behaviour confirmed working (no bug) |

## Verification layers (in order of trust)

1. **Deterministic harness** — `scripts/round9-missing-docs-honesty-harness.js` (pins invariants forever).
2. **Real-document classification** — run the actual classifier/missing-docs logic over Franco's
   real PDFs (`/tmp/scenario1-real-docs.js` pattern). Pipeline-faithful for the deterministic layers.
3. **Deployed replay** — push to staging, send the real inbound, inspect the actual welcome email +
   admin preliminary review render surfaces. The only fully trustworthy layer (OBS-39: offline LLM
   runs have twice "passed" then failed on deploy).

## Scenarios

| # | Name | Tests | Status |
|---|------|-------|--------|
| 1 | [Katherine Morrison](scenario-01-katherine-morrison.md) | New broker email — intro behaviour, 5-of-8 docs | 🟢 3 bugs fixed + deployed-verified (19/19) |
