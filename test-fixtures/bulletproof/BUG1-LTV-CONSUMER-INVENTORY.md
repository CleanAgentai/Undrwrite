# Vienna LTV-consumption surface — complete inventory (Bug 1 grep-audit, 2026-05-28)

Durable documentation of every place Vienna reads an LTV figure, the source it
uses (LLM `extracted_data.ltv_percent` vs JS-canonical), and the Bug-1 routing
decision. Produced during the gate-hygiene fix (Finding 1a).

## Background

Two LTV sources exist in Vienna:
- **LLM `extracted_data.ltv_percent`** — the LLM is *prompted* (ai.js:256) to store only a broker-STATED LTV or null, but empirically computes it **additively** for refinances (existing + new / market), mislabeling combined leverage as standalone.
- **JS-canonical** — `computeStandaloneLtv` (new helper) = requested/market; `computeCombinedLtv` (R11-B-3) = refinance-aware combined. Deterministic. The Snapshot (R9-B) already uses canonical for display.

**Finding 1a** = decision GATES consuming the LLM value instead of canonical. **Finding 1b** = `transaction_type` empty on terse "Refi" → R11-B-3 carve-out doesn't fire → `computeCombinedLtv` goes additive (separate; Franco product-design question).

## DECISION GATES (the bug-surface) — all routed to canonical or already-canonical

| Site | Function | Before | After |
|---|---|---|---|
| webhook.js:104 | `shouldSkipIntakeFormsForDeferredState` | `dealSummary.ltv_percent > 80` | `canonicalHighLtv` param (fallback LLM) |
| webhook.js:135 | `computeIntakeAskedItems` | `ltv_percent > 80` | `canonicalHighLtv` param |
| webhook.js:420 | `computeWillReview` | `summary.ltv_percent` | `standaloneLtv` param (canonical) |
| webhook.js:480 | `computeStillMissingForReview` | `summary.ltv_percent > 80` | `highLtv` param (canonical) |
| webhook.js:3097 | initial escalation `shouldEscalateOnAnyLtv` | `initialLtv` (LLM) | `_r1InitialStandaloneLtv` (canonical) |
| webhook.js:3899 | active escalation `shouldEscalateOnAnyLtv` | `ltv` (LLM) | `_r1ActiveStandaloneLtv` (canonical) |
| **ai.js:1913** | **R10-C-1 collateral-ask band classification** | — | **ALREADY canonical** (`computeStandaloneLtv`+`computeCombinedLtv` inline) — Finding 1a N/A |

Callers threaded with isolated canonical builds (doc-state-at-moment correctness; see deferred-residual docblocks): initial intake (sites 104/135), active site 480 (L3705), R5-D re-intake (L3613).

## PRELIM DISPLAYS — routed to canonical for Snapshot coherence

| Site | Path | After |
|---|---|---|
| webhook.js:3146 | initial prelim subject | `_r1InitialStandaloneLtv` |
| webhook.js:4026 | active willReview prelim subject | `_r1ActiveStandaloneLtv` |
| webhook.js:4034 | active prelim-all-docs-in subject | `_r1ActiveStandaloneLtv` |

## DISPLAY RESIDUALS — still LLM/persisted; routing DEFERRED to a display-coherence pass (rationale below)

These are display-only (no decision impact). Deferred because: (1) the substantive bug-surface is the decision gates (above), all fixed; (2) each needs an additional isolated canonical build in its sub-branch; (3) re-framed as gate-hygiene, not an emergency. Documented so a future display-coherence pass has the complete list.

| Site | What | Source | Note |
|---|---|---|---|
| webhook.js:3510 | under_review-update prelim subject | `reviewLtv` (LLM) | prelim display; route to canonical in review branch |
| webhook.js:3504 | escalation-update email | `reviewLtv` (LLM) | escalation display — should show DRIVING figure (combined) |
| webhook.js:3293 | site-7 escalation email (post-collateral-decline) | `existingDeal.ltv` | escalation display; persisted deal.ltv column |
| ai.js:3854 | broker-facing "at approximately X%" descriptor | `dealSummary.ltv_percent` | broker display |
| ai.js:4043 | LTV line in a summary/prompt block | `dealSummary.ltv_percent` | display/prompt |
| cron/dailySummary.js:490 | daily admin summary | `deal.ltv` | cron display (persisted column) |

**Escalation-display nuance (for the deferred pass):** escalation emails (3504, 3293) should cite the figure that DROVE escalation (canonical combined when `cmbHit`), so the admin sees WHY it escalated — not the standalone. For refinances standalone==combined; only diverges for 2nd-mortgage-add.

## NOT consumers (no action)

- ai.js:241/256/2544/4136 — prompt text instructing the LLM on `ltv_percent`.
- ai.js:2579 — assigns the LLM's `ltv_percent` to `result.ltvPercent` (the source).
- ai.js:2350/3235 — prompt LTV instructions (3235 = R9-B canonical-override directive, already correct).
- webhook.js:3018/2995/3424 — logging / object fields (harmless).

## Persisted `deal.ltv` column — flagged for the deferred pass

`existingDeal.ltv` / `deal.ltv` (webhook 3293, cron 490) is a persisted column. Its write-source should be audited (if written from LLM `ltv_percent`, the persisted value carries the additive error into the cron summary + escalation email). Part of the display-coherence deferred pass.
