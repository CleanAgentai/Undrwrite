# Phase 8 — Bulletproof Program Methodology Writeup

**Status: ~70% finalized (DRAFT).** Sections marked `PENDING FRANCO CLOSURE` await
Franco's clustered-text answers (Q1-escalation-rate, C01, Q8-detection keep/revert) +
the final Track-4 LIST-C bulk + the post-closure verification re-run. Everything else is
empirically settled as of staging `792775c` (2026-05-30).

The Bulletproof program hardened Vienna (Claude-driven mortgage-underwriting email agent for
Private Mortgage Link) via a synthetic 124/125-scenario test matrix. This writeup is the
durable methodology asset: what we found, how we found it, and the disciplines that made the
finding trustworthy.

---

## a) Bug-N lineage — the architectural-layer narrative

The confirmed Vienna bugs surfaced at **progressively more specific layers** as observability
scaled. Each is a defense-in-depth gate or an extraction/render correction at a distinct point
in the pipeline. The progression is the methodology story: early bugs were broad
(gate-input hygiene, money parsing); later ones required the harness to be observable enough
to see them at all (Discipline-2), then required matrix-scale + repeated isolation to
distinguish a real bug from a rare transient.

### Bug-1 — gate-input hygiene (commit `d749b1e`)
- **Surfacing:** Phase 6 integration. The LLM `dealSummary.ltv_percent` is computed
  *additively* for refinances (existing + new), so a clean 56% refi was read as "103% LTV"
  and wrongly routed to high-LTV deferral.
- **Root:** decision gates consumed the LLM's narrative LTV instead of the deterministic
  canonical standalone/combined LTV.
- **Fix shape:** gates consume the **canonical** LTV (computeStandaloneLtv / computeCombinedLtv),
  with the LLM value only as a fallback when canonical can't compute. *Defense-in-depth on
  gate INPUTS.*
- **Harness:** Bug-1 14/14. **Deploy:** verified (A14 escalates per Franco, not declined).

### Bug-2 — magnitude-suffix money extraction (commit `2238952`)
- **Surfacing:** Phase 6. Broker shorthand "$850k" / "$1.2m" parsed as 850 / 1.2.
- **Root:** the money regex captured digits but dropped the magnitude suffix.
- **Fix shape:** centralized `normalizeMoney` captures k/K/m/M/MM/"thousand"/"million" + a
  **no-silent-guess sanity bound** (absurd multiplied result → fall back to the base, flagged-
  inferred, never silently drives a gate). *Centralized parse + sanity bound.*
- **Harness:** Bug-2 33/33. **Deploy:** A02 "appraised $850k" → 850000 end-to-end.

### Bug-3 + EXTENSION — broker-shorthand loan/value extraction (commits `d76e02b`, `b427906`)
- **Surfacing:** **Discipline-2** — BATCH-12 Track-A made `combined_ltv_computed` observable;
  E07 ("New 2nd mortgage request: $120,000") rendered "Loan: TBD" + no Combined-LTV row. The
  observability work surfaced an extraction gap the harness was previously blind to.
- **Root:** the canonical loan-amount regex required the literal "Amount" keyword (or
  "requesting $X"); a large class of realistic broker shorthand was missed.
- **Fix shape (Bug-3):** 5 $-anchored patterns — bare "Loan $X", "Nth mortgage request: $X",
  "$X loan/requested/for-financing", "appraised $X" (PV), "$X against $Y". **EXTENSION**
  (BATCH-14): 2nd-mortgage "$X behind existing 1st" / "($X) behind" / "on $Y property", PLUS a
  latent **Pattern-A FP fix** (bare "first mortgage $X" matched the *existing* balance — now
  requires the new-loan signal "new"/"request"). Narrow-corpus discipline: every pattern
  $-anchored adjacent to its cue.
- **Harness:** Bug-3 33/33 (positives + 7 FP-guards + regression). **Deploy:** F04 185k/78.5%,
  F13 145k/72.9%, E07 120k/69.4% — combined rows render.
- **Composition note:** Bug-3 × Q1 → 15 new escalations at matrix scale (see §c).

### Bug-4 — escalation-GATE canonical-incompleteness guard (commit `988badd`)
- **Surfacing:** BATCH-13 F03 non-determinism (active vs escalated). Initial upstream framing
  = "doc-save race"; deeper isolation **refuted** it (saveAttachments awaited; F03 escalates
  ~85% naturally; the variance is a *rare* canonical-state-incompleteness transient).
- **Root:** when combined-LTV transiently came back null, the escalation gate fell through to
  `active` even though the deal HAD the inputs that should compute it.
- **Fix shape:** escalate (don't fall through) when `mortgage_statement on file + loan present
  + combined null + payout NOT confirmed`. *Defense-in-depth on the escalation-GATE layer.*
  Asymmetric-risk: silent-active-on-incomplete is underwriting-dangerous; escalate is
  recoverable.
- **Harness:** Bug-4 14/14 (the bug CLASS, deterministically — the transient is rarer than any
  repetition probe). **Deploy:** F03 ×3 escalate; E06/A14P NOT over-escalated.

### Bug-5 — prelim-RENDER canonical-incompleteness determinism (commit `792775c`)
- **Surfacing:** BATCH-13 A33 "missing $410k" transient (1-off under batch load; 4/4 clean
  isolated). Investigate-first: a prelim Vienna *sends* that omits the balance is a Vienna
  render issue, so poll-for-stable (a *harness* concept) couldn't fix it.
- **Root:** the Snapshot had NO deterministic existing-1st-mortgage-balance surface — for
  REFINANCES the payout carve-out suppresses the Combined-LTV row, so the balance appeared only
  in the (variable) LLM narrative.
- **Fix shape:** render "Existing 1st Mortgage Balance" deterministically when no combined row
  + an existing 1st is indicated — the canonical value, or "TBD" if incomplete (visible-
  incompleteness > silent-omission). *Defense-in-depth on the prelim-RENDER layer.*
- **Harness:** Bug-5 7/7. **Deploy:** A33 ×3 → deterministic "TBD" row (silent-omission fixed).
- **Known limit (deferred, Franco-entangled):** the $410k VALUE is canonical-absent
  (extractFromLoanApplication doesn't extract existing-balance); adding it flips A33 → Q1
  escalation → part (b) held on Franco's Q1-rate answer.

### The layer progression
`Bug-1 gate-INPUT → Bug-2 PARSE → Bug-3 EXTRACTION → Bug-4 escalation-GATE state → Bug-5
prelim-RENDER state`. Bugs surfaced at increasingly-specific layers precisely because each
prior layer's observability had to be in place first: you cannot see an escalation-gate
incompleteness (Bug-4) until the extraction that feeds the gate works (Bug-3), and you cannot
see a parse gap (Bug-2) until the gate consumes the right input (Bug-1). Bug-4 and Bug-5 are the
same symptom class (canonical-state-incompleteness) at two different layers — separate gates,
separate Bug-N, by design.

### Revert paths (each Bug-N is independently revertible)
The Bug-N namespace was chosen for clean revert lineage. Each bug is a **single discrete commit**
(d749b1e / 2238952 / d76e02b + b427906 / 988badd / 792775c) with its **own dedicated harness** —
reverting any one Bug-N restores the prior behavior without touching the others, and its harness
is the regression gate confirming the revert. The defense-in-depth bugs (1, 4, 5) revert to a
*less-conservative* prior state (the asymmetric-risk direction is additive); the extraction bugs
(2, 3) revert to *narrower* matching (strict-superset widening, so a revert is a strict subset).
No Bug-N entangles another's revert.

---

## b) Discipline catalog — each working on real evidence

- **Discipline 1 (predict → verify → claim):** never bank "fixed/clear" without empirical
  confirmation. *Canonical:* Bug-1 → Finding-1b — the entanglement claim could have masked a
  second issue; verification held it open until A14P isolation proved latent-robustness.
- **Discipline 2 (unobserved ≠ verified):** making a gate observable can surface a hidden bug.
  *Canonical:* BATCH-12 Track A — 12 gates made observable → **Bug-3** fell out (the 11:1
  observability ratio: 12 newly-observable gates → 1 genuine bug). VINDICATED.
- **Over-scoping (raw counts ≠ work):** static classification heuristics systematically
  over-count; reality-check the hit-list before bulk edits. *Canonical:* the four ~10:1
  confirmations (§g).
- **Verification-surface tiering:** PRIMARY = rendered output; SECONDARY = persisted writes;
  AVOID = invoking system logic at test time. *Canonical:* broker_correction scenarios — the
  corrected value verifies via the Q10 notice + ack (PRIMARY) / extracted_data (SECONDARY),
  NOT a Snapshot re-render Vienna never produces (mechanism commit `0c826b9`).
- **Falsely-validating criterion:** repetition can't validate a fix for a transient rarer than
  the probe count. *Canonical:* F03 ~85% escalation → "5 runs all escalate" passes ~98% by
  chance with or without Bug-4 → unit-harness the bug CLASS, not the trigger.
- **Asymmetric-risk shipping:** when the upstream cause isn't cheaply pinnable, harden against
  the symptom class in the direction whose failure is recoverable. *Canonical:* Bug-4
  (escalate-on-incomplete) + Bug-5 (visible-TBD-on-incomplete).
- **Discipline-1 applies recursively:** even upstream direction gets evidence-tested.
  *Canonical:* the F03 "doc-save race" addendum framing, refuted by the next probe.
- **Same-root bugs span multiple call sites — audit ALL:** *Canonical:* Q5 borrower-identity —
  the render-plumbing fix (`d4bd476`) caught 2 sites; the audit found 3 more (doc-ask + 2
  roster), consolidated in `2734032`.
- **Live-fire beats unit-green at bundle scale:** unit-correct features shipped in bundles need
  per-feature live-fire spot-checks. *Canonical:* Q5 + Q8 shipped unit-only in Franco-9; BATCH-12
  probes showed neither surfaced end-to-end.
- **Spec-refinement vs test-fudging:** update tests to a *corrected ratified rule*, never relax
  them to match buggy code. *Canonical:* the r11b Q1 refinement (57→58) tied to e8975be; LIST-C
  at matrix scale tied to specific Q[N]/Bug commits.

---

## c) Cluster-triage → confirmation arc

**Pre-empirical hypothesis (CLUSTER-4/5/6/7, fullmatrix-1 era):** zero new *independent* Vienna
bugs beyond the known roots — the cluster mismatches are entanglements (premature-prelim,
verification-surface, suppression-state, known residuals), not bugs.

**Empirical confirmation across batches:**
- BATCH-8: full re-run dataset (results-2.json), 0 errors, mismatches bucketed.
- BATCH-9/9b: classification — **0 confirmed genuine bugs**; every candidate resolved to a known
  root (premature-prelim dominant, verification-surface, suppression-misread, transients).
- BATCH-11: machinery + Q10; the broker_correction "render shows intake value" cluster proven a
  fixture-sequencing interaction, not a bug.
- BATCH-12: **Discipline-2 surfaced Bug-3** (the genuine finding the cluster-triage couldn't see
  because the gate was unobservable). LIST-C 85→~10 over-count.
- BATCH-13: clean matrix re-run; Bug-3 × Q1 composition surfaced at scale (41/125 escalation).
- BATCH-14: **Bug-4 + Bug-5** surfaced (canonical-state-incompleteness, two layers).

**The arc as a narrative, not a date list:** the program's first six batches (8→9→9b→11)
*tightened the net* — re-running, classifying, and proving that every cluster mismatch reduced to
a known root. That sustained 0-bug result was not a dead end; it was the prerequisite. Each
"explained-away" mismatch removed a hiding place, and the machinery built to explain them
(observable gates, threaded multi-turn replay, the verification-surface mechanism) is exactly
what made the *real* bugs visible. The moment observability crossed a threshold — BATCH-12's
gate-observation work — the first genuine independent bug (Bug-3) fell out immediately; the
clean dataset it enabled (BATCH-13) exposed the composition effect; and the repeated-isolation
discipline that dataset demanded (BATCH-14) surfaced the two canonical-incompleteness transients
(Bug-4, Bug-5). The cluster-triage's job was to *exhaust the entanglements so the residue was
real* — and the residue was exactly five bugs.

**Final tally — confirmed Vienna bugs:** Bug-1, Bug-2 (Phase 6) + Bug-3/3-EXT, Bug-4, Bug-5
(Discipline-1/2-surfaced). **NOT** the dozens of cluster-triage hypotheses — those were
entanglements, exactly as predicted. `PENDING FRANCO CLOSURE: Track-4 LIST-C bulk may confirm
the 41-escalation set as spec-aligned (not bugs) once Q1-rate is ratified; final Bug-N count
expected to stay at 5.`

**Methodology validation:** cluster-triage's diagnostic accuracy was high (the entanglement
predictions held); investigation discipline added small marginal cost relative to the
false-finding risk it prevented (a single mis-shipped "bug fix" to buggy-code-matching would
have been far costlier than the probe time).

---

## d) Operational debt closure

- **Cleanup-correlation hardening:** BATCH-8 leaked ~54/125 (≈43%) synthetic deals; root =
  corrections creating un-threaded second deals + dealId-only cleanup. Fix: Phase-1 In-Reply-To
  threading (`db0ccb6`) eliminated correction-as-second-deal + Phase-4 runTag-email sweep
  (`ca8d948`). **Verified:** BATCH-13 and every BATCH-14 run = 100% auto-cleaned, 0 sweep
  residual. Closed (re-measured at full scale).
- **Poll-for-stable + threading:** multi-turn replay now threads subsequent events
  (`db0ccb6`) — Vienna's continuation is purely thread-based, so un-threaded replays spawned a
  new deal per reply. Inter-event poll-for-stable + last-Snapshot selection.
- **assertEngine broker_correction mechanism (`0c826b9`):** harness-side verification-surface
  closure — broker_correction render fields verify via PRIMARY (Q10 notice + ack) / SECONDARY
  (extracted_data), not a non-existent Snapshot re-render. Harness 6/6; A01/A13 → eval=PASS.

---

## e) Verification-ceiling honesty

Honest ceiling documentation is part of closure, not a gap (full detail:
VERIFICATION-CEILING-Q5-Q8-FLOW-GATED.md).
- **Q5 corporate-row:** unit-verified (render plumbing `d4bd476`); end-to-end blocked because
  corporate deals correctly escalate before prelim (0/2 reach a prelim) — the unit harness is
  the ceiling for that flow shape.
- **Q8 joint-via-name:** end-to-end CONFIRMED via E11 (row renders); E12/F12 gate before prelim
  (correct) → unit-ceiling for the escalating subset.
- **A33 part (b):** known rare transient at the value layer; BUG-5 fixed the existence
  (deterministic), value-determinism deferred (Franco-entangled). Documented, not silently open.
- **Principle:** never synthesize an unreachable test surface or relax a correct gate to make a
  feature observable. Document the ceiling; the unit harness verifies the logic.

---

## f) Carry-forwards — consolidated index

Indexed by topic; each points to its canonical example. (Source detail:
PHASE8-CARRY-FORWARDS.md.)

| Topic | Carry-forward | Canonical example |
|---|---|---|
| Verification surface | 3-tier selection (PRIMARY render / SECONDARY persisted / AVOID logic-invocation) | broker_correction mechanism `0c826b9` |
| Verification surface | Absent rendered surface is information (intended-behavior vs product-gap) | Q10 (post-prelim correction re-notify) |
| Deploy discipline | Unit-correct ≠ live-firing; verify code is deployed to the env the spot-check hits | Q10 routing "gap" = deploy-state artifact |
| Over-scoping | Static heuristics OVER-COUNT — reality-check before bulk edits (~10:1) | §g four confirmations |
| Over-scoping | Raw failure counts ≠ update needs | LIST-C 85→~10 (BATCH-12) |
| Spec integrity | Spec-refinement vs test-fudging | r11b Q1 57→58 (e8975be) |
| Discipline-2 | Unobserved ≠ verified; observability surfaces hidden bugs (11:1) | Bug-3 via gate observability |
| Discipline-1 | Reclassification is healthy — correctable by later evidence | E01/E07 9b→BATCH-13 reclassify |
| Discipline-1 | Applies recursively, including to upstream direction | F03 "doc-save race" refuted |
| Live-fire | Beats unit-green at bundle scale (per-feature spot-check) | Q5/Q8 unit-only → don't surface |
| Composition | Bug × Q-rule composition is a matrix-scale product-design question | Bug-3 × Q1 → 41/125 escalation |
| Defense-in-depth | Asymmetric-risk: harden the symptom class in the recoverable direction | Bug-1, Bug-4, Bug-5 |
| Defense-in-depth | Spans architectural layers (separate Bug-N per layer) | Bug-4 gate / Bug-5 render |
| Verification rigor | Falsely-validating criterion — harness the bug CLASS for rare transients | F03 ~85% / Bug-4 14/14 |
| Same-root | Audit ALL call sites of the affected field in the fix commit | Q5 borrower-identity 5 sites |
| Verification ceiling | Can be a flow-architecture finding, not a defect | Q5/Q8 flow-gated |
| Operational | Infra-debt "closed" only when re-measured at full scale | cleanup 43%→100% |
| Architecture | Redesign within the existing architecture, not retrofit it to the design | Q3/Q4 Option B roster |
| Multi-turn | Vienna continuation is purely thread-based — replay MUST thread | Phase-1 threading `db0ccb6` |
| Render vs gate | Harmless-for-gate ≠ harmless-for-rendered | state-LTV / Snapshot capture |

---

## g) The over-scoping discipline — four empirical confirmations

The ratio between raw-flagged count and genuine-need is the empirical methodology baseline. The
**delta** (raw − genuine) is the work the over-scoping discipline *prevented* — edits that, had
they been made mechanically, would have churned correct fixtures or matched buggy code:

| Confirmation | Raw flagged | Genuine need | Delta avoided | Ratio | Batch |
|---|---|---|---|---|---|
| Q1 terse-refi rewrite | 107 | "a few" (~5) | ~102 | ~20:1 | BATCH 5 |
| Annotation-fidelity | 17 | 1 (A03) | 16 | 17:1 | BATCH 7 |
| B3 sequencing | 1 | 0 | 1 | — (all noise) | BATCH 7 |
| LIST-C stale-spec | ~85 | ~10 | ~75 | ~8.5:1 | BATCH 12 |

Across the four, **~194 raw-flagged → ~16 genuine** (≈12:1 aggregate). The delta is not "work
saved" in a convenience sense — each avoided edit was a *correctness hazard* (a fixture churned
to match a transient, or a test relaxed toward buggy code). The discipline's value is the
false-edit risk it removed, measured in the ~178 edits not made.

**Lesson:** at every scale where bulk-editing is contemplated, the genuine work decomposes far
below the raw count. Per-category grep against actual ENCODED behavior + the rule fingerprint
BEFORE bulk-editing. Never bulk-edit to hit a count target.

---

## CLOSURE-UPDATE PASS (PENDING FRANCO CLOSURE)
Adds when Franco's clustered-text answers land + Track-4 completes:
- Track-4 Q1-escalation cat-1 LIST-C bulk outcome (41 scenarios → spec-aligned, expected Bug-N
  count unchanged at 5).
- C01 admin-intake final disposition + Q8-detection keep/revert outcome.
- A33 part-(b) resolution (canonical loan_app extraction, if Q1-escalation ratified).
- Final post-Track-4 full-matrix verification re-run tally.
- Any final carry-forward additions from the closure batch.
