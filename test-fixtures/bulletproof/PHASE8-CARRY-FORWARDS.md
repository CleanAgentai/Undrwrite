# Phase-8 Carry-Forwards (banked as they accumulate; not deferred to the Phase-8 writeup)

## Verification-surface-selection (three tiers)
PRIMARY = rendered output (what Vienna shows admin/broker — non-circular, observable).
SECONDARY = persisted writes (extracted_data; confirms persistence, NOT resolution logic).
AVOID = invoking system logic at test time (canonical_map reconstruction, computeCombinedLtv,
etc. — using the system to verify the system). The "mildly circular" warning resolves into
this distinction: reading a persisted write ≠ invoking resolution logic.

## Absent rendered surface is information
Some verification expectations have no rendered surface to target — e.g., a post-prelim
broker correction had no re-rendered Snapshot. When the surface is genuinely absent, that's
information about Vienna's behavior. Two responses: (a) intended behavior → assertions target
what Vienna DOES produce (the ack outbound, persisted state); (b) product gap → route as a
Franco-disposition. Q2→Q10 (post-prelim correction re-notification) is the canonical example:
the absent admin re-render WAS a gap; Franco answered YES → Q10 implementation. Don't
synthesize a verification surface for behavior that doesn't exist.

## Unit-correct ≠ live-firing — AND verify the code is deployed to the env the spot-check hits
A feature can have all unit assertions green and still not fire end-to-end. BUT the
end-to-end spot-check only means something if it runs against the DEPLOYED code. The Q10 arc
is the canonical example: Phase-5 spot-checked Q10 against staging and concluded "live hook
doesn't fire" — but staging was running the pre-BATCH-11 commit; Q10 (webhook.js) was committed
LOCALLY and UNPUSHED. The Render log trace then proved the correction DID reach the text-only-noop
branch where Q10 is hooked (dispatch logged, C.5 ack fired) — the hook was correct; the code
simply wasn't there. LESSON: (a) include a "fires on the canonical scenario end-to-end" spot-check
per feature; (b) before concluding a live-fire gap, CONFIRM the code-under-test is deployed to the
environment the spot-check hits (check origin vs HEAD vs the live deploy commit). A "doesn't fire"
against undeployed code is a deploy-state artifact, not a code bug. Distinguish replay/harness-side
changes (run locally, active immediately) from Vienna-code changes (need a deploy to be live).

## Late-arriving Franco answers fold in with Franco-9 discipline
A product-design answer arriving mid-Phase-6 folds into the implementation queue with the
same discipline as the original Franco-9: own commit, own harness, own revert path, distinct
FRANCO-Q[N] tag. Q10 is the canonical example of mid-Phase-6 follow-up routing.

## (earlier, banked in memory) — recorded here for the Phase-8 writeup
- Static classification heuristics systematically OVER-COUNT — reality-check the hit-list
  before bulk edits (Q1 terse-refi 107→few; annotation 17→1; B3 1→0).
- Harmless-for-gate ≠ harmless-for-rendered: deterministic gates consuming canonical sources
  can still differ in LLM-narrative/rendered surfaces.
- A broad fixture change (exit_strategy add) can shift WHICH turn's render gets captured in
  multi-turn scenarios — verify capture timing after fixture-sequencing changes. (Empirically
  confirmed: BATCH-11 Phase-1 A01 — premature intake prelim captured instead of post-correction.)
- Redesign within the existing architecture rather than retrofit the architecture to the design
  (Option B vs A on Q3/Q4 income/debt-as-narrative).
- Spec refinement (update tests to the corrected explicit spec) vs test fudging (relax tests to
  match buggy code) — tie each update to a ratified rule (r11b Q1 refinement; LIST-C at matrix scale).
- Vienna's continuation is purely thread-based (In-Reply-To/References → findByMessageId);
  multi-turn replay MUST thread subsequent events or every reply spawns a new deal (BATCH-11 Phase 1).

## Ratified rules get REFINED by deeper client conversation — receive it gracefully (Franco closure, 2026-05-30)
Franco's Q1 answer in BATCH-13 ("require explicit payout language") was empirically scaled to 33%
escalation, surfaced to him as a product-design question; his refined answer ("refinance and payout
are definitionally the same thing") is a SHARPER articulation of his actual underwriting view — not
a reversal. The spec-refinement discipline applies at the RULE layer too: the original ratification
wasn't wrong, it was incomplete; the refinement is the client's clearer expression. Mechanics:
apply the DUAL-PATH preservation discipline — preserve the original branch (payoutConfirmed) as
defense-in-depth, ADD the refined branch (refinanceConfident) rather than replacing — so no test
coverage is lost and the original behavior remains reachable. Also: empirical SCALE (the 33% rate)
is what prompted the sharper articulation — surfacing the measured rate to the client, in plain
language, is what produced the better rule. (Canonical: FRANCO-Q1-RULE-REFINEMENT `915193c`.)

## "Already-correct" is a valid investigation outcome (Franco closure, 2026-05-30)
C01: Franco's answer ("process admin-intake as broker-submitted") turned out to be ALREADY the
deployed behavior — admin_controlled was set only on the link-submission path, never on admin
intake. The disciplined output was a SPEC update + a no-pause source-invariant + honest commit
documentation that no routing change was needed — NOT a manufactured code change to look like work.
Investigate-first can correctly conclude "the code already does this; the stale artifact was the
spec." Don't manufacture a fix to match an expectation of a code commit.

## Same-root bugs surface across MULTIPLE call sites — audit them ALL (BATCH 14, 2026-05-30)
Q5-render-plumbing (d4bd476) fixed 2 Snapshot call sites; the doc-ask (3rd) was missed until
BATCH-12's live-fire probe, and an audit then surfaced 2 MORE (Q3/Q4 roster primaryName). Lesson:
when applying a same-root fix, audit ALL call sites of the affected source field (here: borrower_name
reads) IN the commit — not just the call sites the symptom surfaced through. d4bd476's narrow scope was
correct given what was visible, but the audit step would have caught the third+ surfaces. (Q5-DOC-ASK-
SECOND-SURFACE-FIX consolidated 3 sites.)

## Defense-in-depth spans ARCHITECTURAL LAYERS (BATCH 14, 2026-05-30)
Canonical-state-incompleteness manifests at different layers: BUG-4 guards the escalation-GATE layer
(combined null → escalate); BUG-5 the prelim-RENDER layer (existing balance had no deterministic
surface — appeared only in the LLM narrative / carve-out-suppressed combined row → A33's rare omission;
fix = render it deterministically, value-or-TBD). Same symptom class, different points → separate
Bug-N gates, each at its layer. Also: investigate-first beats the upstream fix-shape menu — Option A
(poll-for-stable) was a HARNESS concept that couldn't fix production; the probe redirected to the
render-layer determinism fix (Option B-shaped) that actually addresses production.

## Discipline-1 applies RECURSIVELY — even to upstream direction (BATCH 14, 2026-05-29)
F03's initial "4/5 race condition" framing (from the Track-2 addendum) was refuted by deeper
isolation: ~85% natural escalation rate, saveAttachments awaited, docs parse deterministically.
The addendum's race-architecture options were all built on an incomplete picture. Lesson: even
directives from outside the immediate investigator get evidence-tested by the next probe. The
investigator's job includes refuting upstream classifications when the data contradicts them.

## Verification criteria can be FALSELY-VALIDATING (BATCH 14, 2026-05-29)
When the bug is rarer than the verification probe count, repetition passes by chance regardless
of any fix. F03's ~15% transient → 5 "all escalate" probes pass ~98% of the time with or without
a fix. Design criteria that DETERMINISTICALLY distinguish fixed-from-unfixed: for rare transients,
unit-harness the bug CLASS (canonical-state-incompleteness) rather than reproduce the trigger.
The pure-function harness is the verification; production-transient elimination is a defense-in-
depth claim, not empirically provable. (BUG-4 is the canonical example.)

## Defense-in-depth on incomplete state — ASYMMETRIC-RISK (BATCH 14, 2026-05-29)
When the upstream cause isn't cheaply pinnable, harden against the SYMPTOM CLASS not the trigger
(Bug-1, Bug-4). Asymmetric-risk reasoning: silent-fall-through-to-active on incomplete canonical
state = underwriting-dangerous (approval path on an unevaluated deal); escalate-on-incomplete =
recoverable (broker clarifies, deal proceeds). The conservative direction is durably correct even
if the trigger is later root-caused. Don't conflate distinct manifestations: BUG-4 catches F03's
escalation-gate incompleteness but NOT A33's prelim-render incompleteness (no mortgage_statement,
different surface) — surface distinct triggers separately.

## Verification ceiling can be a FLOW-ARCHITECTURE finding, not a defect (BATCH 14, 2026-05-29)
Some features render only on prelim (Q5 corporate-row, Q8 joint-row); some scenarios correctly
gate before prelim (corporate/joint high-LTV escalation, collateral-ask). The end-to-end
reachability gap is correct Franco-9 design, not a missing verification. The unit harness IS the
ceiling for flow-gated subsets — document honestly rather than synthesize unreachable test
surfaces or relax gates for verification convenience.

## Operational discipline validated AT SCALE (BATCH 13, 2026-05-29)
BATCH-13 cleanup hit 100% (125/125 auto-cleaned, 0 sweep residual) vs BATCH-8's ~43%
(54-deal leak). The cleanup-correlation hardening (Phase-1 threading db0ccb6 + Phase-4
runTag-email sweep ca8d948) is CLOSED — a methodology accomplishment, not just project
completion. Lesson: an infra-debt item is only "closed" when re-measured at full scale.

## Discipline-1 reclassification is HEALTHY (BATCH 13, 2026-05-29)
Empirical isolation has now reclassified TWO BATCH-9b findings: E01 was the Bug-3 extraction
gap ("$X against $Y"), NOT premature-prelim-before-docs; E07 was the extraction gap, not just
a rendering issue. The investigation discipline's value is NOT being right first — it's being
CORRECTABLE by later evidence. A classification banked with a re-verification trigger (the
BUG3-SCOPE E01/E02 flag) is stronger than one asserted as final.

## Bug × Q-rule COMPOSITION is a matrix-scale product-design question (BATCH 13, 2026-05-29)
F03's sanity check predicted matrix-wide behavior; BATCH-13's 41/125 (33%) escalation rate
confirmed it (Bug-3 extracting loan amounts × Q1's payout-carve-out → mass refi escalation).
Composed rule effects need EMPIRICAL SCALE MEASUREMENT before production confidence, even when
each individual rule is unit-verified. A rule correct in isolation can be too aggressive in
composition at scale — only the full clean re-run surfaces the rate.

## Live-fire beats unit-green AT BUNDLE SCALE (BATCH 12, 2026-05-29) — confirmed 3×
Empirically confirmed three times in BATCH 12: (1) Q10 hook-routing investigation → the
"gap" was deploy state, not code; (2) Q5 Snapshot render gap (unit-green, doesn't render);
(3) Q8 detection narrowness (unit-green, doesn't fire for joint-via-name). Pattern: unit-correct
features shipped in bulk bundles need PER-FEATURE live-fire spot-checks on the canonical
scenario before "ready." The "bundle scale" qualifier matters — single-feature unit-correct →
spot-check is light overhead; bundle-of-9 unit-correct → per-feature spot-check is
methodology-critical, because each feature has INDEPENDENT live-fire failure modes.

## Raw failure counts ≠ update needs (BATCH 12 Track B, 2026-05-29)
The over-scoping discipline (banked Batch 5/7) SCALES: at every scale where bulk-editing is
contemplated, the genuine work decomposes far below the raw count. Empirical baseline:
Q1 terse-refi 107→few, annotation 17→1, B3 1→0, LIST-C 85→~10 — consistently ~10:1 over-count
by raw-failure metric. Lesson: per-category grep against actual ENCODED behavior + the
Franco-rule fingerprint BEFORE bulk-editing. Never bulk-edit to hit a count target. In BATCH-12
the BATCH-8 raw-fail buckets dissolved into: Bug-3 extraction (held, value-correct), premature-
prelim (no-op, value-correct), harness-temporal chase (no-op), already-aligned specs (E30/A12/
E11/C06), and entangled escalation/decline (held to clean re-run) — leaving a small surgical set.

## Live-fire beats unit-green, AGAIN (BATCH 12 Track B, 2026-05-29)
The "unit-correct ≠ live-firing" carry-forward earned its keep at bundle scale: Q5 (corporate
Snapshot row) and Q8 (joint-applicants row) both shipped in the Franco-9 bundle with GREEN unit
harnesses, yet BATCH-12 deployed-code probes showed NEITHER surfaces end-to-end (Q5: render-time
borrower_name plumbing; Q8: detectJointMultiBorrower needs 2+ credit reports, fixtures express
joint via name-string). Lesson: a unit harness over a pure function does NOT verify the
end-to-end plumbing that feeds it. Every rendering feature needs a live-fire probe before its
expected.json is written — and a feature bundle shipped unit-only should be live-fire-swept as
a class (BATCH-13). The probe step's stated secondary purpose (production confirmation of
unit-only-shipped features) is where these surfaced.

## Discipline-2 thesis VINDICATED (BATCH 12 Track A, 2026-05-29)
Making previously-unobservable gates observable surfaced exactly one genuine bug that the
prior verification surface was blind to (Bug-3, loan-amount extraction gap on realistic
broker shorthand — "Loan $X", "Nth mortgage request: $X", "$X against $Y"). The 12-gate
observability work was the discipline pre-requisite that made the bug SURFACEABLE; without
it, the bug would have remained latent until production user impact. The pattern
"unobserved ≠ verified" is not paranoid — it's load-bearing risk management. The 11:1 ratio
(12 newly-observable gates → 1 genuine bug) is the empirical baseline for the value of
observability investment. Corollary surfaced same-run: a STALE result dataset (BATCH-8
results-2.json predates Phase-1 threading AND Bug-3) cannot drive confident bulk spec
updates for extraction/LTV-dependent assertions — those must be re-confirmed against
deployed code (cheap probe) or a clean re-run, else "updating expected.json to match the
actual" silently becomes test-fudging against buggy extraction.

---
## LEDGER — Q10 / BATCH 11 closure (2026-05-29)
Q10 DEPLOYED (origin/main + Render live = 1e35817 @ 2026-05-29T16:26:59Z) and END-TO-END
VERIFIED on A01: admin re-notification "[UPDATED] Prelim correction — Marcus Webb: requested
loan amount" fired to Franco with delta "260000 → 295000"; audit _q10_admin_renotified_at set;
broker-facing C.5 ack ($295k) preserved (Q10 additive). Non-material false-positive guard:
unit-verified (21/21); clean post-prelim-non-material PRODUCTION probe deferred to BATCH 13
(A38 reached 'active' not prelim, so didn't exercise the branch). BATCH 11 COMPLETE: Phases
1-4 + Q10 implemented, unit-verified, deployed, Q10 end-to-end-verified.

---
## Discipline-2 REFINEMENT — observable-AND-correctly-not-firing (BATCH 15, 2026-05-31)
Discipline-2 "make gates observable" does NOT mean "every gate must fire on every scenario."
Some gates correctly DON'T fire when their inputs require document verification not present in
the scenario. Observable-AND-correctly-not-firing is valid behavior; the discipline is to
verify the not-firing is **principled** (architectural conservatism) rather than **accidental**
(regex gap). E09 is the canonical example: the deterministic FRANCO-Q2 >90% combined-LTV
auto-decline correctly does NOT fire because the existing-first-mortgage balance is broker-PROSE-
stated, and broker-prose existing balances are intentionally UNTRUSTED for a decision-driving
auto-decline (document-verified only — same conservatism as PV-from-loan-app). The LLM safety-net
layer declines the deal; broker outcome is correct. This refines the Bug-3 family scoping:
**extend extraction where the field's broker-prose source is trusted (loan amount, position);
do NOT extend where architectural conservatism applies (existing-balance for auto-decline).**
Bug-3-EXT-2 added the trusted-source fields (Private-Nth loan label, numeric-ordinal position)
and deliberately did NOT add broker-prose existing-first — the gate's not-firing on E09 is the
architecture working as designed, not a defense-in-depth gap.
