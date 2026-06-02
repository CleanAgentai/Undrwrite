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
