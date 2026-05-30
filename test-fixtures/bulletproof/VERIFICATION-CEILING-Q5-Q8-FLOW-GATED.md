# Verification ceiling — Q5/Q8 prelim-flow-gated features (BATCH 14 Track 3)

**Classification: INTENTIONAL (correct Franco-9 design) — NOT a Vienna defect, NOT a
closure gap.** This is a documentation finding about a verification ceiling, per the
BATCH-13 live-fire tallies (Q5 0/2, Q8 1/3).

## The principle
Features that surface on a **rendered prelim** (the admin Deal Snapshot) are verifiable
end-to-end ONLY when the scenario actually reaches a prelim. Scenarios that correctly
**gate before the prelim** (high-LTV escalation, collateral-ask, doc-incompleteness) never
render the Snapshot — so a prelim-only feature row is unobservable on those flow shapes.
For those subsets, **the unit harness IS the verification ceiling.** This is not a missing
verification surface to synthesize; it is correct gating.

## Q5 — corporate Snapshot row + accountant-financials doc-ask
- **0/2 corporate scenarios reach a prelim** (BATCH-13). F03 + E14 both correctly
  **escalate** to awaiting_collateral (high combined LTV: existing 1st + new / value, with
  no explicit payout language → Q1's carve-out correctly doesn't fire → combined > threshold).
- Corporate refis with an existing first mortgage are the dominant corporate shape, and they
  escalate by design. A corporate deal renders the Q5 row only if it (a) has no high combined
  LTV (e.g., a corporate purchase or a payout-confirmed refi) AND (b) is doc-complete.
- **Verification ceiling:** Q5's corporate-row render-plumbing fix (d4bd476) is unit-verified
  (franco-q5-render-plumbing 9/9, incl. the renderDealSnapshot row-render check); its
  end-to-end render is NOT reachable on the escalating subset (≈ most corporate deals).
  Honest status: **unit-verified, end-to-end-blocked-by-correct-gating.**
- Secondary: Q5-DOC-ASK-SECOND-SURFACE (ai.js:2826 self-computes from dealSummary.borrower_name
  only) remains a BATCH-14+ item, independent of this flow ceiling.

## Q8 — joint-applicants Snapshot row
- **E11 is the canonical end-to-end confirmation** — it reaches a prelim and the row renders:
  "Joint Applicants: Marcus Webb, Patricia Webb (2 borrowers)". The name-conjunction
  broadening (75d91e2) is therefore live-fire-CONFIRMED.
- E12 / F12 correctly don't render the row because they gate before the prelim: **F12**
  escalates (78% LTV); **E12** is in a high-LTV collateral-ask state (markers.collateral_ask=true).
  The row is a prelim-only surface, so its absence on these is correct.
- **Verification ceiling:** Q8 is end-to-end-confirmed (E11); the escalating/collateral joint
  subset is unit-harness-verified only — correct, not a defect.

## Why this is not a defect
The prelim-trigger gating (escalation, collateral-ask, doc-completeness) is the ratified
Franco-9 behavior. A corporate or joint deal that escalates SHOULD escalate; forcing it to a
prelim to observe a row would be wrong. The reachability gap is the correct consequence of
correct gating. Synthesizing an unreachable test surface (or relaxing the gate to make the
row observable) would corrupt the behavior to satisfy a verification convenience — the
anti-pattern this program explicitly avoids.

## Net
- Q8: end-to-end CONFIRMED (E11) + unit-verified on the gated subset. Closed.
- Q5: render-plumbing unit-verified; end-to-end deferred to a non-escalating doc-complete
  corporate scenario if/when one exists (none in the current matrix). The verification
  ceiling is documented, not a gap to force-close.
