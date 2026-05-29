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
