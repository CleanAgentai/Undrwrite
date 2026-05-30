# Q2-ordering audit — BATCH-13 escalating scenarios (2026-05-30)

**Question:** Bug-3 + Bug-3-EXT now extract loan amounts that previously surfaced as null →
canonical **standalone** LTV is computable on more scenarios than BATCH-8. Q2's rule (canonical
standalone >90% → auto-decline) must fire BEFORE Q1's escalation gate. Did any of the 41
BATCH-13 escalating (awaiting_collateral) scenarios actually have standalone >90% — meaning Q2
should have DECLINED them, not Q1 escalated?

**Method:** for each escalating scenario, canonical standalone LTV = requested_loan_amount /
property_value (email extraction via Bug-3/EXT `extractFromEmailBody`, falling back to the
fixture generate.js ground-truth loanAmount/propertyValue). Classify: ≤90 (Q1-escalation
correct) / >90 + escalated (Q2-ordering misfire) / null (separate extraction gap).

## RESULT — 0 Q2-ordering misfires (audit CLOSED, Q2 gate ordering CONFIRMED CORRECT)

- **Q2-ordering-misfire candidates (standalone >90, escalated not declined): 0**
- **Q1-escalation correct (standalone ≤90): 41 / 41**
- **Uncomputable (separate gap): 0**

All 41 escalations are driven by **combined** LTV (existing 1st + new / value), NOT standalone —
exactly Q1's "refi/2nd without confirmed payout → escalate for clarification" routing. Standalone
LTVs range 43–85%, all under Q2's 90% decline threshold. Q2 correctly did not fire on any.

### Standalone LTV per escalating scenario (all ≤90)
| Standalone band | Scenarios |
|---|---|
| 80–85% (highest) | F08 85%, B07/C06/D01/E04 83%, B06/F02 82% |
| 75–79% | D03/E03/F01/F12/F23 78% |
| 60–65% | A11/A15/A17/A19/A22/A23?/A25/A30/B02/D02/D09?/E02/E14/F24 (~62–65%) |
| 43–59% | A02/A06/A14/A21/A41/C03/D05/D06/D08/E15/E28/E29/F06/F07/F14 (~43–59%) |

(Full per-scenario loan/value/standalone in the audit script output; representative banding shown.)

## Exhaust-known-roots (per discipline, even at 0 findings)
The 0-misfire result is not assumed — it was empirically computed. The escalations are
combined-LTV-driven by construction (2nd mortgages have low standalone but high combined;
refis-without-payout compute combined = existing + new). The Q2 gate (webhook.js intake gate)
fires BEFORE the Q1/Fix-7 escalation branch and uses canonical standalone (always) + combined
only when payout-resolved (`shouldAutoDeclineOver90`, isCombinedLtvResolved gate). Since no
scenario's standalone exceeds 90, Q2's decline branch was correctly skipped on all 41.

## Conclusion
**Q2 gate ordering is correct.** Bug-3/EXT's improved loan-amount extraction did NOT surface any
standalone-LTV that Q2 should have declined ahead of Q1 escalation. No Bug-6 candidate. Audit
closed. The 41 escalations are spec-aligned per Q1 (pending Franco's Q1-escalation-rate
disposition on whether 41/125 is the intended conservatism — a product-design question, not a
gate-ordering bug).
