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

---

## OBS-12 — Loan Term field repudiation
**Surfaced by:** Jennifer Okafor Bug 2 (commit `35a34ed`)
**Severity:** resolved (shipped); methodology note

Pre-removal, `requested_loan_term_months` was a structured canonical field with two extractor
patterns (email-body + AcroForm Page-1 annotation), a Snapshot row, and TBD-suppression logic.
Per Franco's direction it was removed comprehensively: lenders set the loan term post-approval,
so it drives no underwriting decision and shouldn't be in the system. Natural-language mentions of
loan duration in narrative prompt sections were left untouched. The DB column (if persisted) is
left in place unused — no migration.

**Pattern:** feature-repudiation when a structured field doesn't drive decisions — same shape as
the R10-I broker-package repudiation. Features added for completeness rather than necessity can be
removed cleanly once the underlying workflow assumption clarifies.

**Methodology note:** worth scanning other structured canonical fields for "added because the
document has the field, not because it drives a decision" candidates. Lighter canonical = less
maintenance debt, fewer edge cases.

**Disposition:** resolved; structured-field audit deferred to next maintenance pass.

---

## OBS-13 — Title-case render-layer formatting (canonical-vs-render boundary)
**Surfaced by:** Jennifer Okafor Bug 3 (commit `35a34ed`)
**Severity:** resolved (shipped); methodology note

The Snapshot Property Address row rendered the lowercased canonical value (lowercased by
`normalizeAddress` for internal cross-source comparison). Added `renderAddress()` — a render-layer
helper that title-cases for display (directionals NW/NE/SW/SE and province codes stay uppercase;
postal tokens uppercase; numbers/numeric street names preserved), wired via a `format:'address'`
on `renderSnapshotRow`. Canonical value stays lowercased for internal use; only display changes.

**Pattern:** canonical-vs-render boundary discipline — canonical stores the comparison-normalized
form; the render layer applies audience-appropriate formatting.

**Methodology note:** worth scanning other Snapshot rows for similar canonical-vs-render formatting
gaps — borrower names, brokerage names, and lender names may have normalization-vs-display
mismatches.

**Disposition:** resolved; render-formatting scan deferred to next maintenance pass.

---

## OBS-14 — Existing-balance canonical conservatism documented
**Surfaced by:** Jennifer Okafor extra investigation (commit `35a34ed`)
**Severity:** resolved (documentation only; behavior unchanged)

The Snapshot's "Existing 1st Mortgage Balance: TBD" (despite `extracted_data.existing_mortgage_balance`
being populated) is deliberate, not a bug: the canonical field is populated only from
document-confirmed sources (credit-bureau tradelines / payout statement); a broker-stated or
LLM-extracted value is intentionally NOT accepted for this adverse figure (it drives the refinance
carve-out / combined-LTV decision, which per Q1 conservatism requires document confirmation). The
"TBD" is the deliberate visible-incompleteness signal. A clarifying comment was added at the render
site so future engineers (and future sessions) don't mistake it for a defect.

**Pattern:** document deliberate architectural decisions at the failure-surface where someone might
mistake them for bugs.

**Methodology note:** this is the SECOND time this engagement that deliberate architecture was
mistaken for a bug (first: the loan_purpose corrections-block gotcha, banked in
project_thomas_bergqvist_round8.md). Worth a systematic pass: where else might intentional behavior
be misread as a defect by a future investigator?

**Disposition:** resolved (documented); intentional-behavior-documentation pass deferred to next
maintenance pass.

## OBS-15 — Appraisal classifier discrimination tightening
**Surfaced by:** Robert Grantham Round-8 Scenario-2 Bug 1 (deal `55b3a48c`)
**Severity:** resolved (fix deployed in this commit)

Pre-fix, the `classifyByContent` appraisal pattern (`deals.js`) matched a bare `appraised value`
substring, so a loan application carrying an incidental "Appraised Value: $X" field in its
mortgage-request section content-classified as `appraisal` — producing a FALSE filename-vs-content
mismatch callout on a genuine loan application. Post-fix the appraisal pattern requires a STRUCTURAL
signal (appraisal report header / appraiser / certification / comparable sales / USPAP / valuation
methodology / opinion-of-value), and the `loan_application` pattern was loosened (`\s+` crosses the
line-broken `MORTGAGE LOAN\nAPPLICATION` title) as defense-in-depth.

**Pattern:** innovation IV(c) (inclusion-pattern + discrimination-signal) extended to the
content-CLASSIFICATION layer, not just field extraction. The classifier needs both an inclusion
pattern AND discriminating signals; a bare substring without discrimination over-matches.

**Methodology note:** THIRD instance of the FP-guard lesson in recent rounds (after Daniel Kim and
Jennifer Okafor, both at the field-extraction layer). Worth a systematic scan of the other
`classifyByContent` branches for bare-substring patterns that should carry discrimination
requirements (e.g. `mortgage balance`, `current balance` → could over-match; `resume` keywords).

**Disposition:** resolved (fixed). Follow-up scan of sibling classifier branches deferred.

## OBS-16 — AML/PEP FINTRAC framing correction
**Surfaced by:** Robert Grantham Round-8 Scenario-2 Bug 2 (deal `55b3a48c`)
**Severity:** resolved (fix deployed in this commit)

Pre-fix the post-approval AML/PEP doc-request prompt encoded a `broker compliance, required`
parenthetical on each form line (`ai.js` complianceDocs + the Group KKKK conversational block),
which the LLM faithfully paraphrased into the factually-wrong "These are broker compliance
requirements." AML/PEP are FINTRAC compliance requirements (lender obligations under the Proceeds of
Crime / Terrorist Financing Act, collected through the broker on the borrower's behalf). Post-fix
all three sites encode the accurate framing.

**Pattern:** prompt-level product-knowledge accuracy. The AI faithfully paraphrases prompt framing —
when output is factually wrong about a regulatory/product-domain claim, the prompt's
product-knowledge encoding is usually the actual source, not an AI-behavior issue.

**Methodology note:** when AI output is factually wrong about a regulatory or product-domain claim,
check the prompt's product-knowledge encoding BEFORE assuming a model-behavior problem. The exact
wrong phrase often appears nowhere in code (it's a paraphrase) — trace to the framing the prompt
fed the model.

**Disposition:** resolved (fixed).

## OBS-17 — Routing-leak orphan cleanup (deferred debt retired)
**Surfaced by:** Robert Grantham Round-8 Scenario-2 Bug 3 (deal `55b3a48c`)
**Severity:** resolved (fix deployed in this commit)

Pre-fix the routing-leak sweeps (`ROUTING_LEAK_PATTERNS`) deliberately prioritized leak removal over
grammatical cleanliness and left artifact shards — bare-period paragraphs, doubled terminators, and
stranded temporal-clause fragments (e.g. "Once we have these." / ".once we've completed our review.")
— which the codebase EXPLICITLY tolerated ("minor visual artifact … future cleanup pass can
collapse"; "minor grammar artifact accepted"). Franco's report ("Once we have these.") was one
instance of this class. Post-fix a single conservative `cleanupSweepArtifacts` post-pass
(`ai.js`, gated on `sweptAny`) retires the whole class: it removes orphaned temporal clauses
(sentence-initial via a comma/pronoun main-clause guard; stranded via the lowercase-after-period
signature — both noun/verb-agnostic), collapses doubled/stranded terminators, and drops empty/
bare-terminator paragraphs. The sweep PATTERNS themselves are unchanged.

**Pattern:** deferred maintenance debt retired under verification rigor. The codebase's own
"future cleanup pass can collapse" comment WAS the retirement signal; handling instances one at a
time across future Franco rounds would compound the debt.

**Methodology note:** when codebase comments explicitly defer cleanup as future work, those notes are
durable maintenance-debt signals. A periodic pass to retire such debt under stable verification
conditions (here: 16-run live-generation variance + deterministic positive/negative cases) prevents
the debt from compounding into recurring per-round reports. Design the retirement to be agnostic to
the leaf-shape (object/verb) the debt manifests as — enumerating tails over-couples (the R10-H-d
comment's own warning).

**Disposition:** resolved (fixed).

## OBS-18 — Annotation-gating is a systemic extractor pattern (third instance)
**Surfaced by:** Michael Thornton Round-8 Scenario-2 Bug 1 (deal `8c024006`)
**Severity:** resolved for loan_amount; broader audit deferred

Thornton's `requested_loan_amount` ($88,600) was TBD because `extractFromLoanApplication` matched
ONLY a `[Page 1 annotation]`-prefixed line — those markers appear on scanned/broker-filled forms,
not the DIGITAL plain-text PML template. This is the THIRD instance of the same class: Thomas
Bergqvist loan_term, Jennifer Okafor loan_term (which led to the field's removal), now Thornton
loan_amount. Fixed by adding a plain-text fallback alongside the annotation pattern.

**Pattern:** a new field extractor should support BOTH annotation and plain-text formats from the
start; an annotation-only regex silently misses the digital template.

**Methodology note (deferred maintenance pass):** audit ALL canonical extractors for
annotation-gating and add plain-text fallbacks systematically, rather than one field per Franco
round. Candidates: any extractor whose regex contains `\[Page\s+\d+\s+annotation\]`.

**Disposition:** loan_amount fixed (commit `d52df3c`). Systematic audit deferred.

## OBS-19 — sweptAny gate was an unsound optimization (architectural correction)
**Surfaced by:** Michael Thornton Round-8 Scenario-2 Bug 2 (deal `8c024006`)
**Severity:** resolved (commit `d52df3c`)

`cleanupSweepArtifacts` was gated on `sweptAny` (a routing-leak sweep having fired), on the
assumption that orphan shards only arise FROM sweeps. Empirically the LLM emits bare orphan
fragments on its own ("Once I receive these..") with NO co-firing routing-leak phrase →
`sweptAny=false` → cleanup skipped → orphan survived. Fixed by running the orphan matchers
unconditionally (FP-safe by construction) while keeping the punctuation/whitespace tidy-up gated
on orphan-removed-or-sweep-fired (and the period-collapse made ellipsis-safe) so leak-free bodies
stay byte-identical.

**Pattern:** when a cleanup pass is gated on co-occurring activity, verify the failure mode
actually co-occurs with the gate condition. Here the orphan (failure) did NOT require a sweep
(gate), so the gate created a coverage gap. The Grantham fix (ec505f2) closed the
sweep-co-occurring case; this closes the standalone case.

**Disposition:** resolved (fixed).

## OBS-20 — LLM masking canonical extraction failures (architectural debt)
**Surfaced by:** Michael Thornton Round-8 Scenario-2 Bug 1 investigation (deal `8c024006`)
**Severity:** NOT fixed this round — methodology debt, broad audit candidate

Thornton's appraised value displayed correctly ($380,000) but the investigation found the
deterministic appraisal path contributed nothing on the stored deal (the appraisal doc's
`extracted_data` was NULL; the property_tax fallback captured the prior-year $355,000). The
$380,000 came from the LLM narrative — i.e. the LLM silently filled in where canonical extraction
failed. Innovation IV(a) (canonical drives, AI supportive) degrades INVISIBLY when the LLM
substitutes for a missing canonical value: a visible TBD would have surfaced the extraction gap;
the LLM substitution hid it.

**Pattern:** "LLM masking canonical misses." A field that LOOKS populated may be LLM-sourced over a
silent canonical failure. Visible TBD can be architecturally healthier than silent LLM
substitution for canonical-owned figures.

**Methodology note (deferred):** audit broadly for fields where the LLM can substitute for a
missing canonical value; consider an explicit canonical-vs-AI provenance indicator in the Snapshot
so silent substitution is visible. NOT in scope this round (not Franco-flagged).

**Disposition:** open — methodology debt.

## OBS-21 — Conservatism documented in a comment but not code-enforced (fragile-by-omission)
**Surfaced by:** Michael Thornton Round-8 Scenario-2 Bug 1 (existing-balance source correction)
**Severity:** NOT fixed this round — maintenance pass candidate

The OBS-14 existing-balance conservatism ("don't accept broker-stated values for this adverse
figure") is documented only at the render-site comment (discrepancy-engine.js ~774-784) — NOT
enforced by code-level source-classification filtering at the consumers. `computeCombinedLtv` reads
`existing_first_mortgage_balance[0].value` with NO classification filter (line 341/346); the render
also reads the raw array. The principle is preserved ONLY by what is NOT in the source list — which
is why adding `loan_application` as a source (this round's original spec) would have SILENTLY
violated it. Caught pre-implementation; the source addition was dropped (format-fixes-only).

**Pattern:** an architectural principle preserved by OMISSION (a value simply isn't pushed) rather
than by ACTIVE ENFORCEMENT (a consumer-side filter) is fragile — the next source addition silently
breaks it with no failing test.

**Methodology note (deferred):** add explicit source-classification filtering at
`computeCombinedLtv` and other adverse-decision consumers so the conservatism is enforced, not
implicit.

**Disposition:** open — maintenance pass candidate.

## OBS-22 — Feature-preservation enabling clean direction changes (Bug 4 case study)
**Surfaced by:** Michael Thornton Round-8 Scenario-2 Bug 4 (deal `8c024006`)
**Severity:** resolved (commit `d52df3c`)

Franco wanted an admin-side submission-ready lender package. Rather than rebuild, Bug 4 reused
`generateEscalationNotification` (which already produced a lender-forward-safe paragraph summary
covering 6 of 8 required sections) via a new `mode` parameter. The R10-I
`composeBrokerLenderPackageEmail` — repudiated for broker-side delivery two rounds ago but RETAINED
in code per Porter's "don't aggressively delete" call — was also available; it informed the gap
analysis even though the escalation function was the closer fit.

**Pattern:** when a feature is repudiated for cause but the underlying capability is architecturally
sound, retain the implementation rather than deleting. Future direction changes become wiring/param
changes, not rebuilds. Second instance this engagement (first: existing-balance canonical
conservatism enabling the Jennifer/Thornton render decisions).

**Disposition:** resolved (fixed).

## OBS-23 — Canonical-at-source for cross-surface fields (broker_name)
**Surfaced by:** Ryan Callahan Round-8 Scenario-4 Bug 1 (deal `1011e4e4`)
**Severity:** resolved (commit `d6c5dbf`)

`broker_name` drives multiple consumer surfaces (greetings, prelim/escalation "Broker:" field,
`[INBOUND from …]` labels, completion greeting). The prior R8-A fix correctly identified the
principle — signature parse beats email metadata — but applied it at the GREETING consumers
(`effectiveGreetingFirstName`) rather than at the canonical field. The field itself stayed
populated from `senderName` in the bypass paths (and from the LLM on the normal path), so
admin-facing consumers that read `broker_name` inherited the wrong value. Fixed by populating the
canonical `broker_name` from a deterministic signature parse (`resolveCanonicalBrokerName` =
`parseBrokerFullIdentity || fallback`) at the SOURCE — both bypass dealSummaries + a post-LLM
guard — so every consumer is correct without per-site wiring.

**Pattern:** when a canonical value drives multiple surfaces, fix at the SOURCE (canonical
population), not at each consumer. Per-consumer patching creates patch-recurrence risk as new
consumers are added (exactly how the escalation surface escaped the greeting-only R8-A fix).

**Methodology note:** when a recurring pattern surfaces ("Hi Franco!" → now the escalation Broker
field), check whether the prior fix was applied at the consumer or the source. Audit other
canonical fields (borrower_name, property_address, lender) for at-source vs at-consumer patch
patterns where a deterministic extractor feeds only some consumers.

**Disposition:** resolved (fixed). **Known consequence (Patricia Simmons, 2026-06-09):** widening
`broker_name` to the full firm identity activated a latent wrong-argument bug in a consumer
(`isCommercialSubmission` via `runDiscrepancyDetectionAggregated`) — see OBS-31. The cascade does
NOT mean OBS-23 was wrong; OBS-23 (canonical-at-source) was the correct architecture. The cascade
was a pre-existing latent consumer bug that the content-widening surfaced, and it was fixed at the
consumer (`2f25730`), not by reverting OBS-23.

## OBS-24 — Internal routing identifiers in user-facing narratives (hardcoded variant)
**Surfaced by:** Ryan Callahan Round-8 Scenario-4 Bug 2 (deal `1011e4e4`)
**Severity:** resolved (commit `d6c5dbf`)

`key_risks_or_notes` (admin-facing escalation narrative) was hardcoded with the internal routing
identifier "via R10-C-1 dedicated-generator bypass" (ai.js). It surfaced verbatim in the
escalation's Key Risks section. Rewritten to plain language modeled on the clean S15 sibling.

**Pattern:** engineer-facing identifiers (routing codes, function names, design-rationale refs)
belong in code comments / logs, NEVER in fields that surface to users. This is the HARDCODED
variant of the same class as Grantham's FINTRAC framing (which was an LLM paraphrase of
prompt-encoded language) — both are internal language reaching user surfaces, via different
mechanisms (direct string vs prompt-then-paraphrase).

**Methodology note:** audit hardcoded narrative/summary string assignments (`key_risks_or_notes`,
`summary`, any admin/broker-facing field literal) for engineer-facing language. A grep for
`R[0-9]+-[A-Z]` inside string assignments is a cheap detector.

**Disposition:** resolved (fixed). The R10-C-1 string was the only such leak (grep-confirmed).

## OBS-25 — Completion-email greeting uses raw split() instead of selectGreetingFirstName
**Surfaced by:** Ryan Callahan Round-8 Scenario-4 broker-name consumer audit (deal `1011e4e4`)
**Severity:** NOT fixed this round — common case resolved; residual edge banked

`generateCompletionEmail` derives its greeting first name via `broker_name.split(/\s+/)[0]`
(ai.js ~2924) rather than the `selectGreetingFirstName` helper every other broker-facing email
uses. With the OBS-23 canonical fix, `broker_name` is now correct, so the common case greets
correctly ("Hi Brandon,"). BUT the raw `split()` lacks `selectGreetingFirstName`'s anti-Franco
collision guard: in the rare case where signature parsing fails entirely and `broker_name` falls
back to `senderName` (the proxy "Franco Maione"), the completion greeting would read "Hi Franco,"
— the exact recurring bug class — whereas `selectGreetingFirstName` would fall back to generic
"Hi there,".

**Pattern:** a single consumer using a bespoke extraction (`split()`) instead of the shared,
guard-equipped helper is a latent recurrence of an already-fixed bug class.

**Methodology note (deferred):** route the completion-email greeting through
`selectGreetingFirstName` (pass `greetingFirstName` from the completion-handoff caller, mirroring
the doc-request/rejection/broker-response paths). Small change; deferred to keep the Ryan commit
scoped to the two reported bugs.

**Disposition:** open — future maintenance. Real signed broker emails parse correctly, so this
only manifests on a fully-unsigned submission.

## OBS-26 — Embedded-content extraction pattern (third instance)
**Surfaced by:** Patricia Simmons Bugs 1+2 (deal `2ccbb9d9`)
**Severity:** resolved (commit `a37baef`)

Information embedded in a larger document (the loan application) doesn't flow into a structured
determination because the canonical extractors were designed around document-PRESENCE, not
content-WITHIN-document. Patricia's exit strategy was in loan-app "SECTION 5 — EXIT STRATEGY", the
prelim narrative quoted it, yet the completeness gate (which checks the structured
`dealSummary.exit_strategy`) asked for it and marked it [MISSING]. Third instance: Thornton
occupancy_type (loan-app embedded), Patricia exit_strategy (loan-app Section 5), and the earlier
loan_term issue (resolved by removal). Fixed with `extractExitStrategyFromLoanApplication` +
a webhook backfill of the structured field.

**Pattern:** when a required structured field's content typically lives EMBEDDED in a larger
document, it needs both a content extractor AND wiring into the determination that consumes it —
not just a document-presence check.

**Methodology note (deferred):** scan loan applications systematically for other embedded-content
fields (income narrative, exit strategy, ownership/occupancy, declarations) that feed structured
determinations, and ensure each has an extractor + backfill.

**Disposition:** resolved (fixed).

## OBS-27 — extractPropertyRegion / address-block format coverage
**Surfaced by:** Patricia Simmons Bug 3 (deal `2ccbb9d9`)
**Severity:** resolved (commit `a37baef`)

`extractFromEmailBody`'s property-block match required markdown-bold `*Property:*`; Patricia's
PLAIN `"- Property: 48 Woodpark Circle SW, Calgary, AB …\n   - Loan Requested:"` (no asterisks,
indented-bullet continuation) yielded no block → city/province TBD. `deriveCityProvince` itself
was fine. Fixed by routing the block through `extractPropertyRegion`, whose line-pattern now also
terminates on an indented bullet / labeled field.

**Pattern:** a regex built against ONE broker-prose format (bold `*Property:*`) silently fails on
an adjacent format (plain `Property:` + bullets). When extracting from broker prose, anticipate
format variance: bold vs plain, bulleted vs unbulleted, line-wrapped vs single-line. NOT a
long-standing gap — 4/5 corpus deals (bold) always worked; Patricia is the plain-format outlier
(Franco's "persistent" framing was a misdiagnosis).

**Disposition:** resolved (fixed).

## OBS-28 — Fallback purpose capture: line-wrapping in prose fields
**Surfaced by:** Patricia Simmons Bug 4 (deal `2ccbb9d9`)
**Severity:** resolved (commit `a37baef`)

The fallback purpose capture `/[^.\n]{3,80}/` excluded newlines, so it truncated at the wrap when
the broker's "Purpose:" value line-WRAPPED (`"…maturing September\n   2026; also …"`). The R10-G
override then pinned the truncated canonical value into the prelim Loan Purpose. Fixed by
capturing the first line plus soft-wrapped continuation lines (excluding the next bullet/labeled
field) and collapsing the wrap; cap raised 100→250.

**Pattern:** newline-excluding captures (`[^.\n]`) are appropriate for label/value fields but
INAPPROPRIATE for prose content that can span wrapped lines. Prose-content captures should
anticipate line-wrapping (continuation-aware multi-line capture), while still stopping at the next
labeled field / bullet / sentence break.

**Disposition:** resolved (fixed).

## OBS-29 — Empirical regression-hypothesis refutation discipline
**Surfaced by:** Patricia Simmons Bug 4 (deal `2ccbb9d9`)
**Severity:** methodology (no code artifact)

Bug 4 was framed as a probable regression from commit `67ae33a` (the Thomas maturity-trim). An
empirical trace REFUTED it: Patricia's purpose went through the fallback path, not the
Loan-Request-line path where the trim lives; the truncation was a pre-existing newline limitation.
Had the hypothesis been accepted on its face, the trim might have been weakened or reverted —
breaking Thomas's case — to "fix" an unrelated bug.

**Pattern:** when a recent commit is SUSPECTED of regression, trace the actual failing code path
before scoping. A hypothesis-only response risks unnecessary changes or false reverts. Surface-and-
verify discipline applies to regression hypotheses as much as to bug reports. (Counterpart: when a
trace CONFIRMS a recent commit caused a regression — e.g. the sweptAny coverage gap — fix it.)

**Disposition:** banked methodology.

## OBS-30 — Offline extractor verification doesn't validate the full consumer chain
**Surfaced by:** Patricia Simmons round — Bugs 1 & 3 deployed-staging failures (deal `2ccbb9d9`)
**Severity:** methodology (recurrence of OBS-10 at a different layer)

Bugs 1 and 3 were verified offline at the EXTRACTOR level (correct canonical values) but failed
END-TO-END on deployed code. Bug 1: the post-hoc backfill couldn't un-ask the LLM's welcome email,
which was generated BEFORE the backfill and under a prompt rule (EXIT STRATEGY RULE) that forbade
reading exit strategy from documents. Bug 3: the extractor produced the correct canonical city
offline, yet the live prelim rendered TBD via a consumer path whose runtime behavior diverged from
every offline replication (still under investigation via deployed instrumentation).

**Pattern:** extracting correctly is NECESSARY but NOT SUFFICIENT. The consumer chain — LLM prompts
that read the structured field, and render paths that consume the canonical value through
aggregation/filtering — must be verified end-to-end before declaring an extractor/canonical-
population fix complete. This is OBS-10 (offline tests bypassing pipeline stages) recurring at the
consumer-chain layer.

**Methodology principle:** before declaring an extractor or canonical-population fix complete,
exercise the FULL consumer chain offline. For the changed field, ask:
- Does any LLM prompt consume it? WHEN is the prompt constructed relative to when the extraction
  runs? (A post-hoc population can't repair an already-generated LLM output.)
- Does any render path consume it through aggregation/filtering that might lose or never receive
  the value?
- Is there a timing/sequence dependency between extraction and consumption?
When offline reasoning is exhausted and deployed behavior still diverges, deployed runtime
instrumentation (a temporary trace log) is the correct next step — not more speculation.

**Disposition:** banked methodology. Bug 1 corrective landed (`796d233`) + deterministic backstop
(`7938bf9`); Bug 3 root cause FOUND via the deployed instrumentation and fixed (`2f25730`) — see
OBS-31 for the cascade root cause the instrumentation uncovered.

## OBS-31 — Canonical-field semantic change cascade regression
**Surfaced by:** Patricia Simmons round Bug 3 — unexplained deployed-vs-offline divergence (deal `2ccbb9d9`)
**Severity:** resolved (commit `2f25730`) — was a LIVE production regression

Bug 3's deployed prelim rendered City/Province TBD while EVERY offline replication of the extractor,
the aggregation path, and the filter chain produced the correct city. Deployed runtime
instrumentation (5 iterations) traced the divergence to an OBS-23 CASCADE: the OBS-23 fix made
`broker_name` carry the full firm identity (`"Olivia Hartmann, Ridgeview Mortgage Corp, Lic. #MB445789"`).
`runDiscrepancyDetectionAggregated` (webhook.js ~1320) was called with `leadSummaryBrokerName` as its
`borrowerName` argument — a pre-existing MIS-NAMED ARGUMENT that lay latent because `broker_name` used
to be a bare personal name. When `broker_name`'s content WIDENED to include firm names containing
Corp/Inc/Ltd/LLC suffixes, `isCommercialSubmission`'s corp-suffix check (canonical-fields.js:251)
activated → `commercial=true` → the function short-circuited returning `canonical_map: {}` → the Deal
Snapshot's canonical rows (City/Province and others) rendered TBD.

**Blast radius:** every deal since the OBS-23 deploy whose broker firm contained a corp suffix
(Corp/Corporation/Inc/Incorporated/Ltd/Limited/LLC/LLP/LP/GP) false-flagged as commercial → empty
canonical_map → degraded Snapshot. Pre-OBS-23 the path "worked" only because `broker_name` was a bare
personal name. The fix passes the actual borrower name (`dealSummary.borrower_name || deal.borrower_name`)
to the `borrowerName` argument; the corp-suffix check itself was NOT weakened (corporate BORROWERS still
flag commercial — verified).

**Pattern:** widening a canonical field's content SEMANTIC can activate latent wrong-argument bugs in
consumers. The original mis-naming was harmless while the content was narrow (a bare name); widening the
content (personal name → full firm identity) surfaced the latent bug. This is the inverse-direction
companion to OBS-23: OBS-23 fixed the at-source population correctly; this is the downstream consumer
that the correct fix's wider content tripped.

**Methodology:** when changing a canonical field's content semantic, audit ALL consumers of that field
for content-sensitive logic — not only consumers that explicitly reference the field, but also consumers
that receive it via MIS-NAMED arguments, type-coerced parameters, or implicit passing. Procedure:
(1) grep the field name and inspect every reference; (2) grep consumer functions that take similar-named
arguments (e.g. a `borrowerName` parameter) and verify each call site passes the CORRECT field, not a
different party's value. Mis-named arguments are a class of latent bugs that activate when content
semantics shift. Specifically: a function taking a `borrowerName` argument should receive an actual
borrower name at every call site — never a broker name or other party.

**Methodology (verification):** this is also the concrete payoff of OBS-30 — offline extractor
correctness was necessary but not sufficient; only deployed runtime instrumentation revealed the
consumer-chain divergence. When offline reasoning is exhausted and deployed behavior still diverges,
instrument the deployed path.

**Disposition:** resolved (fixed `2f25730`, diagnostics removed in same commit; deploy-verified —
Corp-firm broker shape now renders City Calgary / AB).

## OBS-32 — Deterministic outbound guard for canonical-known fields (canonical-vs-AI at dispatch)
**Surfaced by:** Patricia Simmons Bug 1 — residual LLM variance after the prompt override (deal `2ccbb9d9`)
**Severity:** resolved (commit `7938bf9`)

The Bug 1 prompt-level OVERRIDE (`canonicalExitStrategyContext`, `796d233`) told the LLM not to ask for
the exit strategy when canonical already had it — but prompt instructions are LLM-PROBABILISTIC (~1/4
deployed runs still asked, despite 3/3 offline). The fix adds a DETERMINISTIC post-generation strip
(`stripCanonicalKnownAsk_ExitStrategy`) that runs every generation regardless of LLM output: when JS
canonical authority knows the field, any residual ask for it is removed from the outbound before dispatch.

**Pattern:** "canonical knows X → no AI-generated outbound should ask for X" is an outbound-layer
instance of the canonical-vs-AI discipline (innovation IV(a)). A prompt instruction is the first line
(suppresses most variance); a deterministic post-gen strip is the backstop (closes the residual). This
mirrors the established strip-and-inject idiom (discrepancy section, Deal Snapshot) where JS owns the
authoritative content and the LLM's variant output is normalized at the boundary.

**Methodology note (deferred generalization):** the strip is scoped to `exit_strategy` (the one reported
field). The same shape applies to any canonical-known field the LLM might still request (loan amount,
property value, lender, occupancy). To extend, parameterize the noun phrase; keep the conservative
"noun-phrase + request-cue" gate so declarative mentions are never stripped. Deferred until a second
field actually exhibits the variance (avoid speculative breadth).

**Disposition:** resolved (fixed). Verified 9/9 unit cases + 10/10 real-LLM Patricia generations (post-strip ask=0).

## OBS-33 — Audience-appropriate communication in prompts (the second axis after accuracy)
**Surfaced by:** Kevin Tran AML/PEP request — Franco flagged condescension (deal `2e31da9d`)
**Severity:** resolved (held commit, not pushed)

The post-approval AML/PEP request read: "AML form (Anti-Money Laundering) / PEP form (Politically
Exposed Person) … These are FINTRAC compliance forms that you can collect on Kevin's behalf." The
acronym expansions were LITERAL in the prompt (Group KKKK ai.js ~2511-2512 + complianceDocs ~3323);
the FINTRAC explanation sentence was the LLM paraphrasing that same framing. Brokers are licensed
mortgage professionals who handle AML/PEP routinely — defining the acronyms and explaining FINTRAC
reads as condescending. Fixed: both sites now emit BARE LABELS ("AML Form", "PEP Form"); the
ec505f2/OBS-16 accuracy framing (FINTRAC, NOT "broker compliance") is preserved INTERNAL-ONLY with
an explicit do-not-explain directive (option b — keep the accuracy guard, suppress the output).

**Pattern:** prompts should encode the AUDIENCE's expertise level. Professional audiences don't need
basic domain terminology explained. Default to bare labels/references for professional readers;
expand only when reader expertise is unclear or the term is genuinely unusual. This is the SECOND
AXIS of prompt-encoded product-knowledge quality, distinct from OBS-16's first axis: OBS-16 fixed
whether the content was factually CORRECT (FINTRAC vs "broker compliance"); OBS-33 fixes whether the
content's level of detail MATCHES READER EXPECTATIONS. Both are prompt-quality categories — accuracy
and audience-fit — worth checking together when reviewing broker/admin-facing prompt output.

**Methodology — negative constraints alone are probabilistic; pair with a positive exemplar.**
First pass used only prohibitions ("do NOT expand acronyms / mention FINTRAC / say compliance
forms"). Acronym + FINTRAC leaks dropped to zero, but a soft category descriptor ("the final
compliance forms") still surfaced ~25% (2/8) in the conversational path. Adding a POSITIVE template
("Phrase it plainly, e.g. 'The last two items I need are the AML Form and PEP Form.'") drove it to
0/20. When a prompt instruction must suppress a natural-language tendency, a concrete positive
exemplar is higher-leverage than stacking negative constraints.

**Audience-scan findings:**
- `generateInfoRequestEmail` (ai.js ~3450) listed `PNW Statement Form (Personal Net Worth)` to the
  broker — same expand-acronym-for-a-pro pattern. FIXED in the same commit (Porter-approved): now
  bare `PNW Statement Form`. (The PNW prompt-instruction sites ai.js ~2345-2346 keep "(Personal Net
  Worth)" as INTERNAL context only — their output example is already bare, so no change needed.)
  IMPORTANT: `generateInfoRequestEmail` is marked UNUSED (ai.js:3438 — "No webhook or cron consumer
  as of 2026-05-05"), so this expansion never reached a live broker and the path is NOT
  staging-replayable. The fix is code-hygiene / correctness-when-wired, verified offline only (5/5
  bare). The live broker-facing over-explanation was AML/PEP only.
- `DOC_DISPLAY_NAMES` uses `AML Report` / `PEP Report` (already bare, no expansion) — but "Report"
  vs the "Form" wording is a minor cross-surface consistency nit. DELIBERATELY LEFT ALONE
  (Porter call): not user-impacting, and changing it would require a broader audit of all
  DOC_DISPLAY_NAMES consumers (admin [MISSING] lists, prelim, lead summary, LLL broker fallback)
  before touching shared labels. Banked here for visibility only.

**Disposition:** resolved — both AML/PEP producing sites + the PNW expansion. Verified: 0/20
over-explanation across both AML/PEP generators; KKKK forced-ask 10/10; non-AML/PEP paths 0/6 leak
(audience rule scoped). Deploy-verification on push.

## OBS-34 — Verification-surface integrity: bulletproof is a TRIAGE suite, not a release gate
**Surfaced by:** Margaret Chen Layer B scoping (pdf-parse reliability investigation, 2026-06-10)
**Severity:** methodology / engagement-context correction (resolved by reframe)

**Discovery:** the bulletproof suite has NEVER passed clean. Committed historical full-matrix
results show it failing 118 (05-28) → 114 (05-29) → 101 (05-31) → 67 → 65 (today, post-Layer-A) —
i.e. 65-failing is the BEST it has ever been, trending down as Vienna improved. The committed
`TRIAGE-REPORT-fullmatrix-1.md` + `BULLETPROOF-PROGRAM-CLOSEOUT` (commit b1027bc) explicitly frame it
as a PER-ASSERTION TRIAGE suite: failures are dispositioned individually as Vienna-defect vs
harness-artifact vs spec-question (e.g. "capture-ordering artifacts, not Vienna defects";
CLUSTER-2+3 "NOT-A-BUG"). The high failure count is BY DESIGN — strict assertions surface
divergences for human review, not a binary pass/fail gate.

**Correction to prior framing:** earlier rounds' "verified clean on bulletproof" / "126 fixtures
pass" claims could NOT have referred to a green suite (it was never green). They were either
shorthand for "no NEW failures vs the prior known baseline" or a misunderstanding. We don't have
access to what prior Claude Code sessions meant; we DO have the committed history showing it was
never green. The validity of fixes verified by OTHER means (staging replay, direct empirical) is
unaffected — only the rigor-CLAIM wording needs correcting.

**Going-forward verification discipline:**
- DIRECT EMPIRICAL verification is the reliable signal — staging replay against real-shape deals,
  multi-run variance, regression sanity on the corpus. This is what actually confirmed Layer A
  (Margaret keystone: prelim now sends), Kevin AML/PEP (4/4 bare labels), and prior staging-verified
  rounds.
- Bulletproof = a REFERENCE/triage surface: good for spotting spec-vs-runtime divergences and
  NET-regressions (more pass→fail than the prior baseline), NOT a release gate.
- Report wording: say "direct empirical verification confirmed [specific behavior] on deployed
  code", NOT "bulletproof passed clean."

**Pattern (methodology):** a verification surface has a DESIGNED PURPOSE that isn't always
self-evident from running it. A failing suite is not always a regression signal — some suites
surface divergences for human triage rather than gate releases. When a surface's behavior conflicts
with expectations, AUDIT THE SURFACE'S DOCUMENTED PURPOSE before treating its output as a signal.
Here the committed history (TRIAGE-REPORT, PROGRAM-CLOSEOUT) made the purpose explicit; the
assumption that "all fixtures green" was the target was never grounded in the surface's design.

**Disposition:** resolved by reframe (Porter decision: adopt triage-suite framing; do NOT reconcile
the 65 to green). Layers C (BUG-4/Sandra-prelim) and D (Bug 2) proceed via direct empirical
verification, no bulletproof dependency. Related: [[project_bulletproof_phase6_integration]].

## OBS-35 — cleanupSweepArtifacts em-dash over-strip (pre-existing, banked)
**Surfaced by:** Layer D Bug 2 unit testing (Margaret Chen round, 2026-06-10)
**Severity:** pre-existing bug — BANKED for a future maintenance pass, NOT fixed (out of scope)

`cleanupSweepArtifacts` (the unconditional post-sweep pass in `enforceNoRoutingLeak`) strips a
legitimate em-dash CONTINUATION: "Thanks for sending these over — I'll be in touch shortly with an
update." → "Thanks for sending these over —." It removes the trailing clause and leaves a stranded
em-dash + period. Confirmed PRE-EXISTING (identical output with and without the Bug 2 / C3-b1
change — diffed against baseline), so it is independent of the Layer D fix.

**Likely cause:** the cleanup matches a routing-leak-shaped phrase after the em-dash and strips it,
without recognizing the "<text> — <clause>" continuation structure, leaving the em-dash orphaned.

**Methodology:** orphan-cleanup patterns should detect em-dash continuations and either preserve the
em-dash structure or remove the dash cleanly when its trailing clause goes. Same class as the
Grantham-round orphan-shard issue (Bug 3 — routing-leak sweep leaving artifact fragments); the
cleanup-pass discipline needs continued refinement as new shapes surface.

**Disposition:** banked for a future maintenance pass under stable verification conditions; not
blocking. Do NOT fix opportunistically — it needs its own scoped FP-safety review.

## OBS-36 — Reliable extraction surfaces latent false-positive discrepancies (Layer A consequence)
**Surfaced by:** Sandra Whitfield Layer C (Margaret Chen round, 2026-06-10)
**Severity:** resolved (held commit — Layer C fixes a+b)

After Layer A made document text extraction reliable (pdf-parse retry), Sandra's property-tax doc —
previously EMPTY (silent pdf-parse failure) — now extracts. Its owner-name extractor over-captured
the next line's label ("Sandra Mae Whitfield\nMailing Address"); the borrower-name discrepancy
comparison (first+last token) saw last token "address" ≠ "whitfield" → a PHANTOM cross-source
discrepancy → R5-B-2 `shouldHoldPrelimForDiscrepancy` held the prelim → deal stuck `active`, no
prelim. The original deal prelim'd ONLY because the property-tax doc was empty (no name → no
conflict).

**Pattern:** improving an upstream signal (extraction reliability) can SURFACE latent downstream
bugs (over-capturing field extractors that previously never ran). The net effect of Layer A is
strongly positive (Margaret fixed; 9/10 deals' silent degradation resolved), but it changes the
input distribution to every downstream consumer — so a fix that increases coverage should be
followed by a sweep for consumers that were previously shielded by the missing data. Mini-blast-
radius: ANY doc with an over-capturing extractor can now manufacture false discrepancies.

**Fix (Layer C, this round):** (a) property-tax owner-name extractor uses `[ \t]+` (not `\s+`) to
stop the name at the line boundary (canonical-fields.js ~L1018 — matching the convention already on
the "Full Name" extractor ~L705); (b) defense-in-depth name normalization at the COMPARISON layer
(`tokenizeNameForCompare` → first non-empty line + trailing-label strip; comparison-only, canonical
storage unchanged) so future over-captures can't manufacture phantom name discrepancies.

**Disposition:** resolved (held commit). Verified offline: Sandra 0 broker-facing discrepancies;
genuine name conflicts still fire; property-tax names extract clean (Sandra/Patricia). Deploy +
Sandra prelim-fires replay after Porter push approval.

## OBS-37 — Document source classification: compliance vs substantive
**Surfaced by:** Sandra Whitfield residual (Margaret Chen round, 2026-06-10)
**Severity:** resolved (held commit)

After the Layer C name-fix, Sandra STILL intermittently (~30-40%) failed to produce a prelim. Root
cause: the substantive-analysis LLM (processInitialEmail → buildContentBlocks) was fed the AML/PEP
form CONTENT, read the FINTRAC form's "Source of Funds" FIELD LABEL as a competing loan-PURPOSE
value, and emitted a phantom discrepancy ("email says debt consolidation but AML/PEP show Source of
Funds") → `unresolved_discrepancy=true` + a clarification ask → R5-B-2 `shouldHoldPrelimForDiscrepancy`
held the prelim. Intermittent because the LLM only noticed the label ~1/3 of runs.

**Pattern:** documents have CATEGORICAL purposes that should constrain which fields they source.
Compliance documents (AML, PEP, FINTRAC forms, identity attestations) exist to satisfy regulatory
requirements about identity and source-of-funds; they are NOT a source for SUBSTANTIVE deal-intent
fields (loan_purpose, loan_amount, property_value). Substantive fields come from the broker email
body, loan application, mortgage statement, credit bureau, appraisal, property tax assessment, and
PNW statement. Source classification matters.

**Fix (deterministic, not prompt-probabilistic):** `excludeComplianceForSubstantive` filters AML/PEP
out of the buildContentBlocks document context at the three dealSummary producers (processInitialEmail,
generateBrokerResponse, updateDealSummary) and out of generateLeadSummary's docSections. Identity
verification is UNAFFECTED — it reads savedDocs directly JS-side (isIdentityClashByAbsence /
extractBorrowerFromDocText / canonical extraction), not through the LLM document context; AML/PEP
RECEIVED-status still surfaces via the classification-based documents-included section. So compliance
docs remain in scope for compliance/identity flows and are removed ONLY from substantive-field
analysis.

**Connection to OBS-21 (fragile-by-omission):** the prior reliance was conservatism-by-omission —
"compliance docs happen not to carry substantive fields, so the LLM won't mis-read them." That
omission-based assumption broke the moment a compliance form's FIELD LABEL ("Source of Funds") looked
like a substantive value. Like OBS-21, the fix replaces an omission-based assumption with ACTIVE
source-list filtering. Conservatism must be code-enforced, not assumed.

**Recursive OBS-36 instance (second in this round):** Layer A's extraction-reliability fix made the
AML/PEP forms extract (previously empty → invisible), which surfaced this latent mis-read — the
SECOND recursive "reliability surfaces latent dependent issues" instance in one round (the first was
Sandra's name over-capture → Layer C). Lesson: each foundational reliability improvement can surface
MULTIPLE layers of latent issues; budget verification iteratively rather than assuming one pass
suffices.

**Field-scope line (encoded):** compliance docs ARE legitimate sources for IDENTITY-related fields
(borrower name — handled JS-side), but NOT for substantive deal-intent fields. The exclusion is
scoped to the substantive-analysis LLM context, not to identity verification.

**Disposition:** content-exclusion landed (cd98ef0) but proved NECESSARY-BUT-INSUFFICIENT — deployed
Sandra still confabulated the "Source of Funds" discrepancy (~17-80%) because the filename metadata
(attachmentNote) still exposed the AML/PEP forms. Completed by the filename exclusion (see OBS-37b).
NOTE: the offline "0/10" cd98ef0 figure was a lucky sample — the true offline rate was ~30-50%
(the offline harness IS faithful to deployed). After OBS-37b, the Source-of-Funds confabulation is
gone (0/10), but a SEPARATE genuine residual remains (existing-balance email-vs-payout difference,
~50%) — that is a Franco product-direction question (materiality of expected accrued-interest
differences), not a code bug; pending his call.

## OBS-37b — Source classification applies to ALL representations the LLM sees (filename metadata)
**Surfaced by:** Sandra Whitfield residual, test-phase (Margaret Chen round, 2026-06-10)
**Severity:** resolved (this commit) — refinement of OBS-37

Source classification discipline applies to ALL representations the LLM sees, NOT just content.
Filename metadata is itself a context signal that triggers training-data recall — the LLM saw the
AML/PEP filenames in `attachmentNote`, recalled domain knowledge ("AML forms have a Source-of-Funds
field"), and CONFABULATED a discrepancy claim ungrounded in actual content (even mis-attributing
"Source of Funds" to the loan application, which has no such field). OBS-37's content-only exclusion
was insufficient; the fix excludes filenames alongside content. Empirically: content-only =
~30-50% confabulation; content + filename = 0% Source-of-Funds.

**Methodology principle:** when excluding a source category from LLM context, audit ALL
representations of the source — content, filenames, lists, counts, references — and exclude
consistently. Partial exclusion creates the CONFABULATION failure mode: the model knows the source
exists (from any partial signal) and invents details about it (from training data) without grounding
in actual content. This generalizes beyond compliance docs to ANY source-category exclusion: the
exclusion must be comprehensive across signal surfaces. A refinement of the LLM-context-construction
discipline, distinct from (but related to) OBS-37's source classification.

**Acknowledged behavior change:** the broker welcome's file count/list now reflects substantive docs
only (AML/PEP omitted). AML/PEP RECEIVED-status still surfaces in the admin prelim's
classification-based documents-included section (admin-facing, not LLM-context).

**Disposition:** resolved (this commit). Verified: 0/10 Source-of-Funds confabulation (was ~30-50%);
genuine discrepancies still detected; Margaret/Patricia/Grantham smoke clean. The residual
existing-balance clarification (~50%) is a SEPARATE genuine matter pending Franco's product call.
