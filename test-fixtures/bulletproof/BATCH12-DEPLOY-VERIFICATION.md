# BATCH 12 bundle — deploy + post-deploy sanity check (2026-05-29)

**Deployed:** origin/main 53f5773, Render LIVE @ 2026-05-29T18:10:00Z. One bundle =
BATCH-12 (Track A/B + harness machinery + LIST-C surgical) + Bug-3 + Q5 render-plumbing
+ Q8 detection-broadening. No Franco heads-up (code deploy + tiny sanity check, not the
BATCH-13 full run).

## 4-scenario sanity check (live deploy)
| Scenario | Feature | Result |
|---|---|---|
| **E07** | Bug-3 | ✅ **PASS** — loan now **$120,000** (was TBD); Mortgage Position 2nd; **Combined-LTV row renders**: "69.4% — (Scotiabank $380,000 + $120,000) / $720,000". Full E07 chain fixed end-to-end. |
| **E11** | Q8 | ✅ **PASS** — "Joint Applicants: Marcus Webb, Patricia Webb (2 borrowers)" + "Qualification basis: combined across 2 borrowers". Name-conjunction broadening live. |
| **A01** | Q10 | ✅ **PASS** — "[UPDATED] Prelim correction" still fires; broker_correction integrity preserved through the bundle. |
| **F03** | Q5 | ⚠️ See below — F03 now escalates (correct per Q1); Q5 Snapshot-row live-fire blocked. |

## F03 — escalation is CORRECT (Bug-3 × Q1 compose), NOT a regression
Pre-bundle F03 fired a prelim at "65% LTV"; post-bundle it escalates to awaiting_collateral
(no prelim). Investigated:
- Bug-3 now correctly extracts `loan $585k` → $585,000 (Pattern B). PV from email = null
  (no PV phrasing; appraisal doc = $900k). Existing first mortgage = $460k (BMO).
- F03 is "Corporate refi … loan $585k" with **no explicit payout language** → Q1's R11-B-3
  payout carve-out (refinance + lender-match + explicit-payout) does NOT fire → the system
  computes **combined** LTV (460+585)/900 = 116% → escalates for clarification.
- This is exactly Q1's ratified rule (e8975be: terse refi without explicit payout escalates;
  Finding-1b family). Pre-Bug-3 the loan was null so combined-LTV couldn't compute → the
  escalation was MASKED → a misleading 65% prelim. **Bug-3 surfaced correct Q1 behavior.**
- F03 is correctly in the HELD set; its escalation is right. Adding explicit BMO payout
  language to a clone removed the escalation (carve-out fired) — confirming the mechanism.

## Q5 — Snapshot-row fix deployed; end-to-end live-fire DEFERRED (→ BATCH 14)
The Snapshot-row render-plumbing fix (d4bd476) is root-caused + unit-verified (9/9, incl.
the render check + both source invariants confirming it's live) + deployed. But the
end-to-end corporate-prelim live-fire is **blocked**: corporate refis escalate (Q1, no
prelim); corporate non-refis stay at intake doc-ask. Four synthetic attempts (corp purchase,
corp purchase+docs, corp refi+payout) never reached a prelim within the poll window.
**Two findings for BATCH 14:**
1. **Q5-DOC-ASK-SECOND-SURFACE** — the accountant-financials doc-ask (ai.js:2826) self-computes
   from `dealSummary?.borrower_name` ONLY (no `deal.borrower_name` fallback; webhook does not
   thread `corporateDocAsk`). So for corporate deals where dealSummary.borrower_name is empty,
   the doc-ask ALSO doesn't render (same root as the Snapshot-row bug, different surface). Fix:
   thread the webhook's (fixed) `_q5Corporate.docAskLines` into generateDocumentRequestEmail,
   or add the borrower-identity fallback in ai.js.
2. **CORPORATE-DEAL-PRELIM-FLOW** — corporate deals rarely reach a prelim (refi→escalate;
   non-refi→doc-ask pending accountant financials, which #1 currently suppresses). So the Q5
   Snapshot row rarely renders in practice. BATCH-14 needs a corporate scenario that fires a
   prelim (non-escalating, doc-complete incl. accountant financials) to live-fire the row.

## Cleanup
0 bulletproof-tagged deals remaining (every probe + temp-fixture run self-cleaned; temp
fixture dir removed).
