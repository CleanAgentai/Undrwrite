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

---

## OBS-6 — Path-B-doc-completion bulletproof fixture (Fix 1 / Bundle 1)
**Surfaced by:** Franco Scenario-2 Bundle 1 (commit `e2019d1`)
**Severity:** low (regression-coverage methodology)

Fix 1 (Path B existing-balance gap) has durable regression coverage already in-repo:
`scripts/verify-pathb-prelim-refire.js` **Check 6** (the deterministic 0→value suppression
+ asymmetry guard, runs offline) and `scripts/replay-franco-s2-bundle1.js` (the staging-replay
script that confirmed deployed behavior — turn-0 prelim, turn-1 doc-only SUPPRESSED, Snapshot
address carries the house number). A full PDF-generating bulletproof *scenario* would duplicate
this verification at materially higher authoring/maintenance cost and only validates via Supabase
replay (not offline CI).

**Recommendation:** next maintenance pass — decide whether the existing regression surface
(Check 6 + replay script) is sufficient, or whether a heavyweight bulletproof fixture is warranted
for parity with other Bug-N coverage. Lean: existing surface is sufficient.

**Disposition:** out of scope for Bundle 1; methodology decision for next maintenance pass.

---

## OBS-7 — D05 + B09 fixture expected.json updates (Bundle 2 product change)
**Surfaced by:** Franco Scenario-2 Bundle 2 (commit `3cbd82b`)
**Severity:** low (test-asserts-repudiated-behavior cleanup)

Bundle 2 repudiated R10-I's broker-lender-package closing (reverted to the fixed-language
`generateCompletionEmail`). Two bulletproof fixtures encode the now-repudiated R10-I behavior:
- `scenarios/D05-broker-package-composer/expected.json` — asserts a `Snapshot`/`Deal Snapshot`
  block AND `expected_attachments.min_count: 1` on the broker closing. Post-Bundle-2 the broker
  closing is fixed-language-only with NO snapshot and NO attachment → both assertions now fail.
- `scenarios/B09-prelim-approved-broker-package/expected.json` — `must_include` asserts
  `Snapshot|Deal Snapshot|deal summary` on the broker closing (now absent). The gate still
  fires (broker still gets a closing); only the content assertion + the `broker_facing_lender_package`
  kind label are stale.

**Recommendation:** small bulletproof-fixture maintenance commit updating both `expected.json`
to assert the new fixed-language-only closing (no snapshot, no broker attachment, Franco-pointer
present). The Bundle-2 verification was NOT auto-applied to these fixtures pending Porter's call
on bundling vs. deferral.

**Disposition:** methodology debt; schedule for next bulletproof-fixture maintenance pass.

---

## OBS-8 — r10i-mini-harness.js / r10i-find.js — superseded dev scripts (Bundle 2)
**Surfaced by:** Franco Scenario-2 Bundle 2 (commit `3cbd82b`)
**Severity:** low (dead dev-script cleanup; no production impact)

`scripts/r10i-mini-harness.js` (and the `r10i-find.js` corpus grep) are the historical R10-I
acceptance harness, validating the `composeBrokerLenderPackageEmail` composer + its wiring at
`sendCompletionHandoff` (Snapshot insert, zip-to-broker, admin-text). Bundle 2 repudiated that
wiring, so these scripts now assert obsolete behavior. They are dev/acceptance scripts, NOT CI
regression gates — no production impact either way.

**Recommendation:** either delete in a cleanup commit or annotate the script headers as obsolete
(superseded by Bundle 2). Defer to maintenance pass.

**Disposition:** dead-script cleanup; next maintenance pass.

---

## OBS-9 — Loan Purpose canonical-extractor false-positive guard
**Surfaced by:** Thomas Bergqvist Bug 2 (commit `67ae33a`)
**Severity:** resolved (fix shipped); methodology note for next pass

`parseBrokerInitialIntent`'s "Loan Request" purpose capture group (`[^.\n]{3,80}`,
`canonical-fields.js:1165/1171`) was greedy: it grabbed everything after `$amount —` up to the
newline, swallowing a trailing run-on field the broker appends on the same line — e.g.
"refinancing existing TD Bank mortgage **Existing mortgage: TD Bank (matures March 2028)**". That
dirty value became the canonical `purpose` (source `broker_initial_intent`), and the R10-G
corrections override then pinned the prelim Loan Purpose to it verbatim.

**Fix (shipped):** a conservative post-capture trim that strips trailing run-on field markers —
`Existing/Current mortgage|lender|loan …` and `(matures …)` / `maturity …` clauses. Clean purposes
pass through unchanged (verified: zero purpose-extraction diff across all 125 bulletproof fixtures /
178 events).

**Methodology note:** this is innovation IV(c) (broker-prose canonical extraction with
false-positive guards) extended with a previously-missing guard for trailing run-on capture. The
post-match trailer-trim pattern is reusable; worth scanning other phrase-capturing canonical
extractors for the same greedy-capture-without-FP-guard shape in the next maintenance pass.

**Disposition:** resolved; reusable-pattern scan deferred to next maintenance pass.

---

## OBS-10 — Offline/deployed verification-path divergence
**Surfaced by:** Thomas Bergqvist Bug 2 (the incomplete first fix, commit `73b6489`)
**Severity:** methodology (process lesson)

The first Bug-2 fix (`73b6489`) pinned the Loan Purpose section in `generateLeadSummary` and passed
an offline test — but that test called `generateLeadSummary` with a manually-set, already-clean
`dealSummary.purpose`, bypassing the canonical-extraction stage. On deployed code, extraction runs
first and produced the dirty canonical value, and the fix's defer-to-corrections-block path meant it
never fired. The post-deploy staging replay caught it.

**Lesson:** an offline test must exercise the same pipeline stages the fix's correctness depends on.
When the deployed path runs an upstream stage (here, canonical extraction) that the offline test
skips, the offline result is not a valid verification. Trace which stages a fix depends on, and make
the offline test cover them — or rely on the deployed staging replay.

**Disposition:** process lesson; no code action.

---

## OBS-11 — stripAdminClosing as an architectural addition (audience symmetry)
**Surfaced by:** Thomas Bergqvist Bug 3 (commit `73b6489`)
**Severity:** resolved (fix shipped); methodology note

Pre-fix, deterministic post-generation sweeps existed for broker-facing outbounds
(`enforceNoRoutingLeak`, `stripPerfectOpener`) but there was no admin-side equivalent, so a
broker-style closing the model appended to the admin-internal prelim reached the admin document.
`stripAdminClosing` (admin-prelim path only) was added as the admin-side equivalent, completing the
layered-defense symmetry — both audiences now have a dedicated post-gen guard.

**Methodology note:** worth scanning for other audience-asymmetric defensive gaps — failure modes
where broker-facing output has a guard but admin-facing doesn't, or vice versa.

**Disposition:** resolved; asymmetry scan deferred to next maintenance pass.
