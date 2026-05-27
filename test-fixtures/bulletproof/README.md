# Bulletproof Matrix Harness

Synthetic + production-replay scenario matrix that exercises Vienna's pipeline across all formalized architectural template families. Standing infrastructure for regression defense — not a one-shot effort.

## Status (Phase 2 in progress)

| Phase | Status |
|---|---|
| Phase 0 — empirical-grounding | done |
| Phase 1 — scenario matrix design (124 scenarios) | done |
| Phase 2 — fixture generation (Batch 1 of 4) | in progress |
| Phase 3 — production-corpus replay infra | not started |
| Phase 4 — expected-output spec | not started |
| Phase 4.5 — Layer 3 product-design intake (22+ items) | not started |
| Phase 5-8 — run/triage/fix/rerun/document | not started |

## Directory layout

```
test-fixtures/bulletproof/
├── README.md                    # this file
├── lib/                         # fixture-generation machinery
│   ├── shapes.js               # Franco-corpus placeholders + Postmark shape template
│   ├── emailSynth.js           # buildPostmarkPayload + resolveAttachmentRefs
│   ├── pdfSynth.js             # synthLoanApp / synthMortgageStatement / synthAppraisal / synthNOA
│   ├── conversationSynth.js    # single-turn / multi-turn / correction-sequence helpers
│   └── piiScrubber.js          # production-sample PII scrubber (shape-reference only)
├── scenarios/
│   └── {ID}-{slug}/
│       ├── scenario.json       # dimensions + family tags + bug-hint + rationale (hand-authored)
│       ├── generate.js         # synthesis script (runnable: node generate.js)
│       ├── events.json         # GENERATED — temporal array of Postmark events
│       └── documents/          # GENERATED — synthesized PDFs (text-extractable)
└── production-samples/         # scrubbed shape-reference samples from Supabase corpus
    └── shape-log.md            # audit log: which production patterns informed synthesis
```

## Machinery overview

**PII discipline:** all fixtures use Franco-corpus placeholder names/addresses/lenders from `lib/shapes.js` — Marcus Webb / Patricia Simmons / Sarah Chen / 1142 Tory Road NW / RBC / Scotia / etc. Production samples are scrubbed via `lib/piiScrubber.js` BEFORE storage; samples inform synthesis SHAPE only (broker phrasing, document layouts), never content.

**PDF synthesis:** PDFs are synthesized via `lib/pdfSynth.js`. The load-template-and-replace pattern is used (load `forms/Loan Application Form (1).pdf` as seed, append new page with text content, remove original pages) because direct pdf-lib output triggers parse errors in Vienna's `pdf-parse@1.1.1` runtime. Result: ~310KB PDFs whose text is fully extractable by Vienna's pipeline.

**Event sequencing:** scenarios are temporal arrays of Postmark inbound payloads (`events.json`). Replay harness (Phase 5) POSTs events in order with configured delays (`delayFromPreviousMs`). Multi-turn scenarios reconstruct Supabase thread state via `MessageID` references.

**Attachment refs:** `events.json` stores `documentRef: 'documents/file.pdf'` instead of inline base64 content — keeps fixtures human-readable. Replay harness calls `resolveAttachmentRefs(payload, fixtureDir)` to inline content at POST time.

## Running a scenario generator

```bash
node test-fixtures/bulletproof/scenarios/B01-discrepancyHold-active-major-loan-amount/generate.js
```

Generators are deterministic and idempotent — rerunning rewrites the events.json + documents/. Source of truth is `scenario.json` (hand-authored metadata) + `generate.js` (synthesis script); generated artifacts are committed for replay-without-regeneration.

## Scenario file format

### `scenario.json`
```json
{
  "id": "B01",
  "name": "discrepancyHold-active-major-loan-amount",
  "group": "B",
  "dimensions": { "BC": "S", "TT": "R", "LTV": "50-75", "DQ": "CL", "DS": "CM", "BW": "CR", "CV": "MC", "GE": "ON" },
  "families": ["F2.DH", "F1.LA"],
  "bugHint": "L",
  "anchor": "R10-F + R11-B-1",
  "rationale": "Plain-language description of WHAT this scenario stresses + WHY (derived from product intent + cluster anchor, never from current code behavior)",
  "notes": "Optional implementation notes"
}
```

Dimension abbreviations: see Phase 1 deliverable legend (matrix design document).
Family-tag abbreviations: F1.{field} | F2.{gate} | F3.{intake} | F4.{generator}. See Phase 1 architectural-path coverage table.

### `events.json`
Array of `{ sequenceIndex, delayFromPreviousMs, kind, postmark }`. `kind` ∈ {broker_intake, broker_correction, broker_followup, admin_handoff_reply, franco_outbound}. `postmark` is a Postmark inbound payload shape.

## Anti-circularity discipline

Per Phase 0 framing #2: `scenario.json` rationale fields describe what SHOULD happen (intent-grounded), not what Vienna currently does (code-grounded). Phase 4 `expected.json` files extend this discipline to per-field assertions. Reading current Vienna behavior to derive expected outputs is FORBIDDEN — only used post-spec to identify mismatches.

## Phase 2 batch ordering

- Batch 1 (in progress): Group B + C + D — ~27 scenarios. Simpler fixtures, gate/intake/generator-focused.
- Batch 2: Group A LA/PV/AD/PC subset — ~25 scenarios.
- Batch 3: Group A remaining + E — ~50 scenarios.
- Batch 4: Group F combined — ~25 scenarios.
