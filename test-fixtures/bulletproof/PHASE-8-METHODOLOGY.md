# Phase 8 — Bulletproof Program Methodology Writeup

**Status: FINAL (2026-05-31).** Program complete. All Franco clustered-text items
dispositioned, the final verification re-run + Bug-7/Bug-3-EXT-2 fix-cycle landed and
deploy-verified, all `PENDING` markers replaced with closure content. Final tallies:
**7 confirmed Vienna bugs** (Bug-1…Bug-5 + Bug-7; Bug-6 is the lineage-preserved
ruled-out E05 harness-capture candidate), **11 Franco product rules** (Q1…Q11),
**6 over-scoping confirmations** (~15:1 aggregate). Empirically settled as of staging
`fb19a3f` (2026-05-31).

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

### Bug-3-EXTENSION-2 — private-2nd-mortgage extraction (BATCH 15, commit `f6bb964`)
- **Surfacing:** the BATCH-15 final-re-run bucket-(d) probe — E09 (private 2nd mortgage) reached
  `active` while its deterministic FRANCO-Q2 combined-LTV gate stayed silent; the LLM safety-net
  declined the deal. Investigation: E09's realistic private-lender phrasing escaped canonical
  extraction (`Private 2nd request: $425,000` lacks the word "mortgage" Bug-3 A requires;
  `2nd mortgage` numeric-ordinal prose missed by the spelled-out-only position fallback).
- **Fix (BOUNDED, Option A):** two strict-superset extensions — loan label `Private Nth [mortgage]
  [request]: $X` (lowest-priority alternation, FP-guarded on `private`+ordinal+`$`) and
  numeric-ordinal position prose (behind/existing reference guard). Harness `bug3-ext2` 21/21.
- **Deliberately NOT extended:** broker-prose `existing_first_mortgage_balance`. Architectural
  conservatism — broker-stated existing balances are UNTRUSTED for a decision-driving auto-decline
  (document-verified only, same as PV-from-loan-app). E09's combined-decline correctly DEFERS to a
  doc-verified balance; the LLM safety net handles the broker-prose case.
- **Positive side-effect (observed in Phase-5 spot-check):** E09 moved from
  "LLM-saved-via-decline-while-the-deterministic-gate-stayed-silent" to "deterministic gate
  correctly escalates (94.7% combined) matching its ORIGINAL spec `awaiting_collateral`." Closing
  the extraction gap produced behavior-correctness alignment, not just safety-net redundancy —
  the Bug-3 family's load-bearing contribution: surfacing extraction gaps closes the
  LLM-dependency-on-safety-net failure mode by enabling correct deterministic firing.

### Bug-7 — correction-intent routing from awaiting_collateral (BATCH 15, commit `54c45e6`)
- **Surfacing:** the BATCH-15 bucket-(d) diagnosis (3 candidates B07/C06/F14 → 1 genuine).
  In `awaiting_collateral`, the broker-reply branch routed EVERY reply through `parseCollateralReply`
  (yes/no/ambiguous), so a broker CORRECTION (F14 purchase→refi) was mis-classified and LOST —
  Vienna stayed re-asking for collateral. Continuation works from active/under_review (A01) but not
  `awaiting_collateral`.
- **Fix (COMPOSED against existing machinery):** (1) strict-superset extension to the R10-G classifier
  `parseBrokerCorrections` — optional "actually" in the transaction_type patterns (F14 "this is
  actually a refinance"); (2) a correction-intent PRE-CHECK in the `awaiting_collateral` branch that
  reuses `parseBrokerCorrections` (not duplicated) and routes a detected correction to the active
  branch, where R10-G applies it + the LTV/escalation gate re-evaluates. Genuine collateral replies
  fall through unchanged. Harness `bug7` 12/12; verified firing via staging logs.
- **Bug-7 + Bug-4 compose correctly (F14):** the correction routes (transaction_type→refinance), then
  the deal CORRECTLY re-escalates because Bug-4's canonical-incompleteness guard fires on still-null
  property value (89.6%, no value to recompute). F14's original spec `active` was optimistic — a
  correction that doesn't resolve the gate inputs correctly re-triggers the gate. Spec realigned to
  `awaiting_collateral`.
- **Build-time scope expansion (honest record):** the diagnosis sized Bug-7 as a "single-function
  pre-check." Building it revealed parseBrokerCorrections did not detect F14's "actually"-phrasing
  (needed the classifier extension) and that the fix must route to the active branch's R10-G + gate
  re-eval rather than apply the correction inline (the correction email alone lacks accumulated
  canonical — value/loan live in event[0]). Final shape composes against existing R10-G + the
  active-branch recompute infrastructure — sibling discipline to Q11's composition against existing
  roster integration. **Demonstrates the architecture's compositional health:** late-stage
  defense-in-depth fixes leverage already-built infrastructure rather than introducing new patterns.

### The layer progression
`Bug-1 gate-INPUT → Bug-2 PARSE → Bug-3 EXTRACTION (+ Bug-3-EXT/EXT-2 widenings) → Bug-4
escalation-GATE state → Bug-5 prelim-RENDER state → Bug-7 continuation-state routing`. The
correction-intent routing (Bug-7) sits at the multi-turn CONTINUATION layer — a state-machine
transition gap, the deepest layer surfaced, reachable only once every prior layer's observability
was in place. Bugs surfaced at increasingly-specific layers precisely because each
prior layer's observability had to be in place first: you cannot see an escalation-gate
incompleteness (Bug-4) until the extraction that feeds the gate works (Bug-3), and you cannot
see a parse gap (Bug-2) until the gate consumes the right input (Bug-1). Bug-4 and Bug-5 are the
same symptom class (canonical-state-incompleteness) at two different layers — separate gates,
separate Bug-N, by design.

### Revert paths (each Bug-N is independently revertible)
The Bug-N namespace was chosen for clean revert lineage. Each bug is a **single discrete commit**
(d749b1e / 2238952 / d76e02b + b427906 / 988badd / 792775c / f6bb964 [Bug-3-EXT-2] / 54c45e6 [Bug-7])
with its **own dedicated harness** — reverting any one Bug-N restores the prior behavior without
touching the others, and its harness is the regression gate confirming the revert. The
defense-in-depth bugs (1, 4, 5) revert to a *less-conservative* prior state (the asymmetric-risk
direction is additive); the extraction bugs (2, 3, 3-EXT, 3-EXT-2) revert to *narrower* matching
(strict-superset widening, so a revert is a strict subset); Bug-7 reverts to the prior
collateral-only awaiting_collateral handling (its classifier extension + pre-check are additive).
No Bug-N entangles another's revert. **Lineage note:** Bug-6 is intentionally PRESERVED as a
ruled-out slot — it was the E05 status-transition candidate, dismissed as a harness capture-ordering
artifact (persisted status was correctly `rejected`); keeping the number records the honest
discovery sequence (Bug-7 is the next *genuine* bug).

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
- **Build-time stop-and-surface:** diagnose-then-build sometimes reveals complexity the diagnosis
  couldn't see; STOP and surface the scope-expansion rather than push through with under-scoped
  code. *Canonical:* BATCH-15 — Bug-3-EXT-2's architectural fork (broker-prose existing-balance =
  matrix-wide risk vs doc-sourced conservatism) and Bug-7's scope-expansion (single-function
  pre-check → classifier extension + active-branch R10-G routing) were both surfaced mid-build
  for a decision, not silently absorbed.
- **Harness-capture vs Vienna-behavior distinction:** capture-ordering / harness-mechanism
  artifacts MIMIC real Vienna bugs; read the persisted DB value (or trace the harness path)
  before classifying as Vienna behavior. *Canonical:* E05 (persisted `rejected`, captured
  `active`) + B07 (persisted `active`+collateral_offered, captured `awaiting_collateral`) +
  C06 (replay From-tagging breaks admin match → admin email mis-routed as broker). Three of the
  nine BATCH-15 bucket-(d) candidates were this class — none a Vienna defect.
- **Architectural conservatism as a Discipline-2 refinement:** "make gates observable" does NOT
  mean "every gate must fire on every scenario." A gate that correctly does NOT fire (because its
  inputs require verification absent in the scenario) is valid behavior; verify the not-firing is
  *principled* (conservatism) not *accidental* (regex gap). *Canonical:* E09 — the Q2 combined
  auto-decline correctly defers to a doc-verified existing balance; the LLM safety net handles the
  broker-prose case. Observable-AND-correctly-not-firing.
- **Reuse existing infrastructure for late-stage fixes:** mature-architecture fixes should compose
  against already-built machinery, not introduce new patterns — a signal of compositional health.
  *Canonical:* Bug-7 composes against R10-G `parseBrokerCorrections` + the active-branch recompute;
  Q11 composes against the existing qualification-roster integration.

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
- BATCH-15: final verification re-run (results-4) → bucket-(d) probe of 9 routing-divergence
  candidates → **Bug-7** (correction-intent routing from awaiting_collateral) + **Bug-3-EXT-2**
  (private-2nd extraction). The other 7 candidates dissolved: F25 known-residual, F02 batch-timing
  artifact, A16/F19 defensible-or-spec-stale, E05/B07 harness-capture-ordering, C06 fixture+harness
  limitation. The diagnose-before-classify discipline (direct DB reads, staging-log traces) held:
  9 candidates → 1 genuine new Vienna bug (+ 1 extraction widening).

**The arc as a narrative, not a date list:** the program's first six batches (8→9→9b→11)
*tightened the net* — re-running, classifying, and proving that every cluster mismatch reduced to
a known root. That sustained 0-bug result was not a dead end; it was the prerequisite. Each
"explained-away" mismatch removed a hiding place, and the machinery built to explain them
(observable gates, threaded multi-turn replay, the verification-surface mechanism) is exactly
what made the *real* bugs visible. The moment observability crossed a threshold — BATCH-12's
gate-observation work — the first genuine independent bug (Bug-3) fell out immediately; the
clean dataset it enabled (BATCH-13) exposed the composition effect; and the repeated-isolation
discipline that dataset demanded (BATCH-14) surfaced the two canonical-incompleteness transients
(Bug-4, Bug-5); and the final verification re-run (BATCH-15) surfaced the deepest layer — the
continuation-state routing gap (Bug-7) — plus an extraction widening (Bug-3-EXT-2). The
cluster-triage's job was to *exhaust the entanglements so the residue was real* — and across the
whole program the residue was exactly **seven bugs**, surfaced at progressively deeper layers as
observability accumulated.

**Final tally — confirmed Vienna bugs (7):** Bug-1, Bug-2 (Phase 6) + Bug-3/3-EXT/3-EXT-2, Bug-4,
Bug-5, **Bug-7** (Discipline-1/2-surfaced across BATCH-12→15). **NOT** the dozens of cluster-triage
hypotheses — those were entanglements, exactly as predicted. Bug-6 is the lineage-preserved
ruled-out slot (E05 harness-capture candidate). Track-4 (the 41-escalation set) resolved as
spec-aligned (not bugs) once Q1-rate was ratified — the held bulk dissolved (§g 5th confirmation).

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
- **Harness deal-status capture-ordering (BATCH-15, FOLLOWUP-3):** the `finalDealState` re-fetch
  can read `deal.status` around an in-flight finalization update, capturing a transient. E05
  (persisted `rejected`, captured `active`) + B07 (persisted `active`+collateral_offered, captured
  `awaiting_collateral`) were both this — confirmed via direct Supabase reads (stable at 0/15/30s).
  The fix is a harness extension (poll-for-status-stable before recording, mirroring
  `pollForStableOutbound`); deal-state reads should wait for status-stable, not capture around the
  finalization write. Logged for follow-up engagement (not a Vienna defect).
- **Replay admin-reply From-tagging (BATCH-15, C06, FOLLOWUP-5):** the replay tags every event's
  From with `+runTag` (`replay.js:165`) for deal correlation; for an ADMIN event this breaks
  Vienna's `ADMIN_EMAIL` match (`franco@…` → `franco+bulletproof-C06-RUNID@…`), so the admin
  override is routed through the broker path. Q9 admin-override is correctly implemented; the
  replay machinery cannot exercise admin-reply flows. The unit harness IS the verification ceiling
  for admin-reply behavior. Follow-up: tag-bypass for `ADMIN_EMAIL` local-part in the replay.
- **AI-backend-unavailable (BATCH-15 credit incident, FOLLOWUP-1):** during the final re-run the
  staging Anthropic account exhausted its credit balance; the AI pipeline 402-failed → 0 outbound
  captured in 123/125, deal records created but `extracted_data` empty. NOT a Vienna/code/harness
  defect (routing was actually MORE correct: 97/125). Credits restored (+ auto-reload); the run was
  redone clean. Surfaced a production-resilience gap (silent orphan-deal on AI failure — FOLLOWUP-1)
  and a kill-process-verification operational lesson (FOLLOWUP-6: a `kill` on the launch pid missed
  the reparented worker — verify via `pgrep`). The credit-starved dataset is archived as evidence.

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
- **Q9 admin-override (C06, BATCH-15):** the replay tags admin From with `+runTag`, so admin-reply
  flows route through the broker path and cannot run end-to-end via the harness (FOLLOWUP-5). Q9 is
  correctly implemented (webhook.js:2495); the **unit harness IS the ceiling** for admin-reply
  behavior until the replay gains an admin tag-bypass.
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
| Multi-turn | Continuation routing is state-specific — a correction must be recognized per-state | Bug-7 awaiting_collateral routing `54c45e6` |
| Render vs gate | Harmless-for-gate ≠ harmless-for-rendered | state-LTV / Snapshot capture |
| Build discipline | Stop-and-surface scope-expansion at build time, don't push under-scoped | Bug-3-EXT-2 fork / Bug-7 expansion |
| Harness vs Vienna | Read persisted DB / trace harness path before classifying as Vienna behavior | E05/B07 capture-ordering, C06 From-tagging |
| Discipline-2 refinement | Observable-AND-correctly-not-firing is valid; verify principled vs accidental | E09 conservative existing-balance |
| Compositional health | Late-stage fixes compose against existing infrastructure, not new patterns | Bug-7 ↔ R10-G, Q11 ↔ roster |
| Operational | Verify a kill hit the real worker (`pgrep`), not just the launch pid | BATCH-15 partial-run waste |

---

## g) The over-scoping discipline — six empirical confirmations

The ratio between raw-flagged count and genuine-need is the empirical methodology baseline. The
**delta** (raw − genuine) is the work the over-scoping discipline *prevented* — edits that, had
they been made mechanically, would have churned correct fixtures or matched buggy code:

| Confirmation | Raw flagged | Genuine need | Delta avoided | Ratio | Batch |
|---|---|---|---|---|---|
| Q1 terse-refi rewrite | 107 | "a few" (~5) | ~102 | ~20:1 | BATCH 5 |
| Annotation-fidelity | 17 | 1 (A03) | 16 | 17:1 | BATCH 7 |
| B3 sequencing | 1 | 0 | 1 | — (all noise) | BATCH 7 |
| LIST-C stale-spec | ~85 | ~10 | ~75 | ~8.5:1 | BATCH 12 |
| Track-4 dissolution | 41 | 0 | 41 | — (all spec-aligned) | closure |
| BATCH-15 bucket-(d) | 9 | 1 (Bug-7) | 8 | ~9:1 | BATCH 15 |

Across the six, **~260 raw-flagged → ~17 genuine** (≈15:1 aggregate). The delta is not "work
saved" in a convenience sense — each avoided edit was a *correctness hazard* (a fixture churned
to match a transient, or a test relaxed toward buggy code). The discipline's value is the
false-edit risk it removed. The two closing confirmations sharpen the pattern at both extremes:
**Track-4 (41→0)** — an entire held bulk dissolved to zero genuine bugs once Franco's Q1-rate
refinement landed (the 41 escalating refis were spec-aligned, never bugs); **BATCH-15 (9→1)** —
nine routing-divergence candidates in the final re-run reduced to a single genuine new bug, the
rest dissolving to harness artifacts (3), defensible-or-stale specs (2), a fixture issue (1), a
batch-timing artifact (1), and a known residual (1). At every scale — 107, 85, 41, 9 — the
genuine work decomposed far below the raw count.

**Lesson:** at every scale where bulk-editing is contemplated, the genuine work decomposes far
below the raw count. Per-category grep against actual ENCODED behavior + the rule fingerprint
BEFORE bulk-editing. Never bulk-edit to hit a count target.

---

## CLOSURE — Franco's clustered-text answers (2026-05-30)

All three product-design items dispositioned. The closure items themselves were a rule REFINEMENT,
an already-correct routing, and a NEW product rule — none a bug (the bug count moved at the final
re-run, not here). The subsequent **final verification re-run (BATCH-15)** then surfaced the last
two findings, bringing the confirmed Vienna **bug count to 7** (Bug-1…Bug-5 + Bug-7; Bug-6 = the
ruled-out E05 harness-capture candidate).

- **Q1-escalation-rate → FRANCO-Q1-RULE-REFINEMENT (`915193c`).** Franco: "refinance and pay-out
  the existing mortgage are definitionally the same thing." A confident refinance + lender match
  now fires the carve-out without explicit payout language → the ~41/125 escalating set (confident
  refis, standalone ≤80) routes back to active. The held Track-4 bulk thus **largely dissolved** —
  the original active specs were restored, not bulk-rewritten (the over-scoping discipline §g, one
  more time: the "85→~10→~0 net new" trajectory). A14 reverted active. This is the canonical
  example of the **rules-get-refined-by-deeper-conversation** carry-forward: surfacing the measured
  33% rate to the client, in plain language, produced the sharper rule. Dual-path preservation
  (payoutConfirmed branch kept as defense-in-depth; refinanceConfident branch added).
- **C01 → FRANCO-C01-ADMIN-INTAKE-AS-BROKER-SUBMITTED (`bec178f`).** "Already-correct is a valid
  outcome": investigation found the code already processed admin-intake normally
  (admin_controlled set only on link-submission); only the C01 spec was stale. Spec update +
  no-pause source invariant, no routing change.
- **Q8-detection-extension → KEEP (`75d91e2`, Franco-ratified).** No revert.
- **Q11 — FRANCO-Q11-REGISTERED-PROPERTY-OWNER-RULE (`94acb72`).** New (11th) Franco product rule:
  registered owners must be on the application; a non-owner applicant on a single-owner deal is a
  guarantor (Q11 supersedes Q4's ambiguous default). Detector + roster integration, 12/12.
- **A33 part-(b) — DEFERRED-DOCUMENTED.** Canonical loan_app existing-balance extraction conflicts
  with documented conservatism + carries broad combined-LTV risk for marginal benefit; BUG-5's
  deterministic visible-TBD already prevents the silent-omission failure mode. Asymmetric-risk:
  declined. (DECISIONS-NEEDED.md.)

### Franco-rule lineage (now 11)
Q1–Q10 (Franco-9 + Q10) + **Q11** (registered-owner). Q1 carries the only post-ratification
**refinement** (Q1-RULE-REFINEMENT) — the lineage records both the original rule and its sharper
re-articulation, per the spec-refinement-at-the-rule-layer discipline.

### BATCH-15 — the final verification re-run (COMPLETE, 2026-05-31)
The final full-matrix re-run on the closure bundle ran twice. The first run was **invalidated** by
an Anthropic credit exhaustion mid-run (AI pipeline 402-failed; archived as evidence — FOLLOWUP-1).
After credits were restored (+ auto-reload), the **valid re-run** (`results-4.json`, staging
`8de2dad`) completed: 125 scenarios, capture healthy (0 zero-outbound, 100% cleanup, 3.42h),
routing-correct 102/125 (up from baseline 76 — the Q1 refinement confirmed working). The
bucket-(d) probe of 9 routing-divergence candidates was isolated diagnose-before-classify:

- **F25** known narrative-fab residual; **F02** batch-timing artifact (isolation matched expected);
  **A16/F19** defensible-or-spec-stale; **E05/B07** harness capture-ordering (persisted DB correct —
  §d, FOLLOWUP-3); **C06** fixture sender + replay From-tagging (Q9 correct, not replayable —
  FOLLOWUP-5); **F14** → the one genuine new bug (**Bug-7**).
- Bug-3-EXT-2 closed the E09 extraction gap (positive side-effect: E09 now escalates correctly).

Fix-cycle: Bug-7 + Bug-3-EXT-2 + C06 fixture + E05/B07 spec-realign committed, bundled, deployed
(`fb19a3f`), and Phase-5 targeted spot-checks confirmed: Bug-7 firing (staging-log-verified),
B07/F08/A01 unregressed, E09 escalates, 0 leaked. The 41-set routes to active (carve-out) except
genuinely-high-standalone refis + 2nd-mortgages (F08 85% escalates), as predicted.

**Program-complete.** Confirmed Vienna bug tally: **7** (Bug-1…Bug-5 + Bug-7; Bug-6 ruled-out).
Franco product rules: **11** (Q1…Q11). Five+ POST-CLOSURE follow-up items logged
(POST-CLOSURE-FOLLOWUP-ITEMS.md) — all UX / test-infrastructure / operational, none a Vienna
decision-logic defect. Strict-zero on Vienna correctness: hit.
