# Post-Closure Follow-Up Items

Out-of-scope observations surfaced during bug investigations, captured here as
candidates for a future maintenance pass. None of these block any closed item;
each was explicitly scoped OUT of the work that surfaced it.

---

## OBS-1 — Existing-balance intake-extraction timing
**Surfaced by:** Bug 3b staging replay (commit `2320c8c`)
**Severity:** low (no functional impact observed)

On the Bug 3b replay scenario (filled RBC mortgage statement attached at intake),
the `mortgage_statement`-sourced `existing_first_mortgage_balance` populated at
**turn 1 rather than turn 0**. The offline deterministic-engine trace extracted the
$225k balance at turn 0; the live staging run did not surface it until turn 1,
where it appeared as a `0 → 225000` correction delta.

**Impact:** zero effect on position resolution (stayed `1st` throughout) or
combined-LTV-for-refinance (the R11-A carve-out correctly treats the existing 1st
as paid-off, so combined LTV stays 60%). It is a small intake-extraction timing
quirk worth understanding — why the same filled statement extracts at turn 0
offline but turn 1 on staging.

**Disposition:** out-of-scope for Bug 3b; candidate for next maintenance pass.

---

## OBS-2 — Double admin re-notification on consecutive bare confirmation turns
**Surfaced by:** Bug 3b staging replay (commit `2320c8c`)
**Severity:** low (admin-noise only)

On the two bare confirmation turns of the Bug 3b replay, OUT 3 and OUT 4 fired
**identical** `existing balance 0 → 225000` material-change re-notification emails
to the admin — one per confirmation turn — for the same underlying field change.

**Likely fix:** guard the material-change re-notification to suppress when the
field state has not changed since the last notification (deduplicate on
consecutive identical deltas).

**Disposition:** out-of-scope for Bug 3b; small fix for next maintenance pass.

---

## OBS-3 — Active-deal admin-DECLINE greetings still read From-header broker_name
**Surfaced by:** Fix 2 (decline-email greeting, commit `e08ca96`)
**Severity:** low (greeting personalization only)

Fix 2 threaded the body-signature broker name (`parseBrokerFirstName(email.textBody)`)
into the **initial-submission** auto-decline greeting (webhook.js ~3362) — the path
Franco actually hit ("Hi there!" → "Hi Victoria!"). The **active-deal admin-DECLINE**
paths (webhook.js ~2482 / ~2543 / ~2652, where an admin replies "DECLINE" on an
existing deal) still resolve the greeting from `selectGreetingFirstName(existingDeal.
extracted_data)`, i.e. the stored `broker_name`. When that stored value carries the
From-header / proxy name (e.g. Franco testing via his own address → "Franco Maione"),
those declines would still fall back to a generic greeting. The triggering message on
those paths is the **admin's** reply (no broker body in scope), so the body-signature
threading used in Fix 2 doesn't directly apply.

**Likely fix (deeper, extraction-layer):** prefer the broker's body-signature name
over the From header at `broker_name` EXTRACTION time (processInitialEmail), so the
stored `broker_name` is correct for every downstream consumer (all decline/escalation/
follow-up greetings), not just the path threaded tonight. Anti-collision against the
admin first name is retained.

**Disposition:** out of scope for tonight (the body-signature threading covers the path
Franco is testing); deeper extraction-layer fix for a future maintenance pass.

---

## OBS-4 — E20 fixture expected.json: assert the new classification-mismatch callout
**Surfaced by:** Bug 2 (classification cross-check, commit `3afdd45`)
**Severity:** low (methodology / test-asserts-old-behavior cleanup)

`E20-doc-set-wrong/mortgage_statement_mislabeled.pdf` intentionally tests a mislabeled
document (loan-application content under a mortgage filename). Pre-Bug-2-fix, the
fixture's `expected.json` asserted Vienna's behavior on the silent-contradiction path.
Post-fix, Vienna now correctly surfaces the mismatch via the classification-mismatch
admin callout (the one fixture out of 363 docs that — correctly — flags). The fixture's
`expected.json` should be updated to assert the new callout content.

**Disposition:** methodology work (test-asserts-old-behavior cleanup), not a product bug
— defer to the next bulletproof-fixture maintenance pass.

---

## OBS-5 — Bug 3 (placeholder in [UPDATED] prelim) — resolved-by-Path-B, empirically constrained
**Surfaced by:** Bug 3 reproduction check + Phase 1 confirmation replay (2026-06-03)
**Severity:** resolved (no action needed; documentation only)

Franco's Bug 3 was a placeholder string ("[Full preliminary review content with deal
snapshot, borrower overview, …]") in the [UPDATED] prelim body (deal 875af304 turn-1).
Root cause: the [UPDATED] full-prelim re-render passes the prior prelim into
generateLeadSummary's conversation history; on a DOC-ONLY turn (no material field
change) the LLM had no salient new content and abbreviated the prior prelim into a
placeholder instead of re-rendering. EMPIRICALLY CONSTRAINED to the doc-only [UPDATED]
path: a Phase 1 confirmation replay of a MATERIAL-change [UPDATED] (loan $372k→$400k +
doc, deal cc0618f8) rendered FULL content with no placeholder. Path B (commit 699029a)
suppresses the doc-only [UPDATED] re-fire entirely, so the only path that produced the
placeholder no longer fires. Bug 3 closes as resolved-by-Path-B. No code change.

**Residual (very low risk, not currently reachable):** if a future change re-enables a
doc-only [UPDATED] re-fire, the placeholder shortcut could recur. The two-layer fix
(strip prior prelim from the re-render's LLM context + a deterministic post-gen
placeholder guard) remains the scope if that ever surfaces.

**Disposition:** closed; documentation only.
