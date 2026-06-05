# VIENNA (Undrwrite) — Engineering Hard-Problem Record, System Architecture & Open-Source Bill of Materials
## Comprehensive technical submission prepared for IP counsel

---

### 0. Document control & verification provenance

| Field | Value |
|---|---|
| Subject system | **Vienna** — autonomous mortgage-underwriting email agent for Private Mortgage Link (PML) |
| Codebase / remote | `CleanAgentai/Undrwrite` (package name `undrwrite-backend`) |
| Git state verified at | `HEAD = 421c659`, branch `main` |
| Verification date | 2026-06-05 |
| Verification method | Direct code/git inspection + a 7-agent automated code-and-git audit (each engineering claim confirmed against current `file:line` and against commit history via `git show`); dependency BOM generated from `package-lock.json` (lockfileVersion 3) covering all 217 resolved packages |
| Proprietary code size | **15,373 LOC** of first-party JavaScript in `src/` |
| Stack | Node.js (CommonJS) · Express 5 · Supabase (Postgres + Storage) · Postmark (email) · Anthropic Claude (LLM) · Render (hosting) |

**Reading note on accuracy.** Figures that originate from an in-session diagnostic (rather than a
committed artifact) are explicitly labeled "(diagnostic)". Where an earlier informal draft of this
material contained errors, the correct fact is stated and the error noted, so counsel has a clean
record.

> **Counsel note — manifest hygiene (REMEDIATED 2026-06-05).** The root `package.json` had declared
> `"license": "ISC"` and did **not** set `"private": true` — unintentional `npm init` defaults that,
> for proprietary software, could be construed as an inadvertent open-source grant. This has been
> corrected: the manifest now declares `"license": "UNLICENSED"` and `"private": true` (npm's standard
> proprietary markers), and carries a proprietary `description`. No prior published/distributed
> artifact is known to have carried the `ISC` declaration; counsel should confirm none was published
> to a public registry.

---

### 1. Executive summary

Vienna is an autonomous agent that receives mortgage broker submissions by email, reads the attached
documents, reconciles the facts across sources, computes underwriting figures, drafts and sends the
preliminary review and all downstream correspondence, and manages the deal's multi-turn lifecycle to
completion — with a human (the PML principal) approving the credit decision.

The defensible intellectual property is **the first-party logic** (~15.4K LOC), concentrated in four
modules: `services/ai.js` (4,649 LOC), `routes/webhook.js` (4,540 LOC — the dispatch/state machine),
`services/canonical-fields.js` (2,173 LOC — deterministic extraction), and
`services/discrepancy-engine.js` (1,423 LOC — multi-source reconciliation). The open-source
dependencies (Part D) are thin, permissively-licensed transport/parse plumbing; the wrappers around
them are 6–8 lines each, and none encodes any underwriting, extraction, or decision logic.

The hardest problems in the build all share one shape: a naïve approach worked on clean inputs and
failed on the **messy, contradictory, real-world** inputs brokers actually send (half-filled PDF
forms, mislabeled files, numeric street names, conflicting lender names, payout conventions). The
recurring engineering answer — and the core of the IP — is a disciplined separation between
**deterministic, auditable computation of decision-driving facts** and **probabilistic LLM
generation of prose**, with contradictions *surfaced for human resolution rather than silently
resolved or allowed to corrupt the decision*.

---

## PART A — ENGINEERING HARD-PROBLEM CATALOG

Each entry follows: **Initial state → What we tried → Why it failed → What works now → Why it is an
advantage / why it works.** All `file:line` and commit references are verified at `HEAD 421c659`.

---

### A.1 — Reading *filled* PDF forms without hallucinating (the foundational extraction problem)

**Initial state.** Broker PDFs (loan applications, appraisals) were sent to the Claude vision model
directly. Worked on clean, digitally-typeset documents.

**What we tried / why it failed.** Real brokers send **AcroForm PDFs** (Adobe fillable forms) and
PDFs marked up in Preview/Adobe. The filled values live in **form metadata and annotations, not the
rendered text layer**. `pdf-parse` returns only the blank template labels ("Primary Borrower", "Date
of Birth") — identical for a blank and a filled form. Vienna therefore either saw "empty" forms or
the vision model **hallucinated** plausible loan numbers that then **conflicted with the broker's
email**. This produced the "blank-form hallucination" — initially mis-diagnosed and patched with a
gate (commit `d365013`), then correctly **reverted** (`9f204e1`) once root-caused as a
source-divergence problem rather than a hallucination to be suppressed.

**What works now.** A content-shape router instead of filename trust (`src/lib/pdf.js`):
- `isFormLikeText()` detects template-only text (>70% short lines, no `$` amounts, no paragraphs) and
  routes those documents to base64 **vision** rather than trusting the empty text layer.
- A **second, deterministic extractor** (`src/lib/pdfFormExtract.js`, via `pdf-lib`) reads the hidden
  **AcroForm field values and annotation `Contents`** that `pdf-parse` cannot see; the two are
  combined in `src/services/deals.js`.
- A "dual-path" mode sends both extracted text and the base64 image for high-value documents.
- A standing verification discipline: **verify against the broker's real submission, not a synthetic
  fixture** (`scripts/trace-deal-extraction.js`, commit `f486980`) — created precisely because a
  synthetic fixture passed while the real document still failed.

**Advantage / why it works.** Brokers do not send clean data. Vienna reads the data layer most
pipelines silently lose, routes each document by its **actual content shape and hidden layers**
rather than its name, and **refuses to fabricate** when data is genuinely absent. That is the
difference between a demo and a system a lender will trust with a file.

---

### A.2 — The deterministic / LLM boundary: the canonical-fields + discrepancy engine (the central architectural arc)

This is the problem that runs through the entire R6→R11 history and is the heart of the IP.

**Initial state.** The LLM extracted *and computed* the deal facts for the preliminary review (LTV,
balances, mortgage position, lender, address, province).

**What we tried / why it failed.** Probabilistic drift on numbers that must be exact and auditable:
- **LTV disagreed with itself** — the same submission produced LTV **72.8% vs 60.7%** (Marcus) and
  **62.4% vs 61.8%** (Derek) between the LLM's reading and the correct computed value (commit
  `299abc6`, R9-B).
- The existing lender **hallucinated as "Scotiabank"** in narrative prose when the payout statement
  said otherwise (`f0e9617`, R9-D).
- Mortgage position **self-contradicted** between the Snapshot and the Risk Factors section
  (`c1793e6`, R10-E).
- Province rendered "TBD/TBD" on valid addresses (`01b991a`, R10-D).

For a lender these are not cosmetic — a wrong LTV is a wrong decision.

**What works now.** A deterministic extraction + reconciliation engine:
- `src/services/canonical-fields.js` (2,173 LOC) deterministically extracts each field from every
  source (email body, appraisal, payout statement, tax bill, credit bureau, loan application) and
  tags each value with its source.
- `src/services/discrepancy-engine.js` (1,423 LOC) reconciles values across sources under an explicit
  **source-hierarchy**, computes LTV / combined-LTV in plain JavaScript, and **renders the Deal
  Snapshot deterministically** (not via the LLM).
- Where the LLM narrative must be steered, the canonical value is injected into the prompt as a
  `DETERMINISTIC — USE THIS` override (the "R6-α" pattern, e.g. R9-B subject-line + narrative LTV
  override; R9-D lender override); admin-facing risk callouts are **JS-injected**, not LLM-generated.

**Advantage / why it works.** Every decision-driving number is **auditable and reproducible** —
traceable to a named source document — and cross-source disagreements are *surfaced* rather than
silently averaged or invented. The LLM is confined to prose. This clean split between deterministic
computation and probabilistic generation is the system's defining architectural property and the
basis of its trustworthiness for underwriting.

---

### A.3 — Refinance combined-LTV: compute correctly, flag contradictions, never cross-wire them ("Option C", commit `a621a20`)

**Initial state.** Combined LTV = `(existing 1st balance + new loan) ÷ value`. On a refinance where
the existing mortgage is paid out — existing $400k, new $408k, value $680k — the additive figure is
**118.8%**, meaningless for the post-closing deal and sufficient to auto-decline a clean **60%**
refinance. (Additive path: `discrepancy-engine.js:337-343`.)

**Attempt 1 — collapse combined→standalone whenever labeled "refinance."** Unsafe: a broker can be
wrong about the payout (two existing mortgages; wrong lender), feeding a wrong LTV into a real
decision.

**Attempt 2 — strict lender-match verification** (carve-out fires only if broker-stated payout lender
matches the mortgage-statement lender). **Failed as too conservative on noisy submissions.** Empirical
anchor — Franco deal `5d1479ea`: existing $318k sourced from the **credit report** (no mortgage
statement attached) → lender match could not anchor → carve-out did not fire → combined computed
additively to **106.8%** → a clean 60% refinance risked a false >90% auto-decline.
(`discrepancy-engine.js:399-408`.)

**What works now (Option C).** Two **independent** outputs from the same input:
1. **Decision math** computes the carve-out per the broker's **stated transaction intent** when intent
   is clear, guarded by a payout-capability check (`requested ≥ existing`) —
   `discrepancy-engine.js:437-442`.
2. **Any lender contradiction is surfaced separately** as an admin-only review flag —
   `computeExistingLenderRefinanceMismatch` (`discrepancy-engine.js:470-495`) →
   `injectExistingLenderMismatchCallout` (`ai.js:859-879`), wired **non-blocking** at
   `webhook.js:1520-1534`. Callout text (`ai.js:867`): *"the refinance LTV is computed on the stated
   payout (new loan ÷ value); confirm which existing mortgage is being refinanced."*

The identical principle is mirrored in mortgage-position inference (`canonical-fields.js:1495-1520`).

**Advantage / why it works.** Clean refinances proceed correctly even when sources disagree or are
missing; contradictions never silently corrupt the decision math and never kill a good deal — they
route to a human while the math reflects reality. This *"resolve correctly; flag the disagreement
separately; never cross-wire a contradiction into the decision number"* is a distinct, reusable
pattern.

---

### A.4 — Exactly one preliminary review: defeating a display-artifact false positive (commit `e2019d1`)

**Initial state.** The early-prelim gate fires as soon as canonical state can compute LTV and ≥1
reviewable document is attached, surfacing still-missing items as `[MISSING]` markers (deliberate
early visibility), and re-evaluates on later turns.

**Attempt — re-fire an `[UPDATED]` prelim on any post-prelim canonical change.** Produced **duplicate**
prelims on routine document-completion turns: a near-identical `[UPDATED]` minutes later, same
numbers, no new information.

**Root-cause failure (empirically Laura Chen deal `9da89a81`).** *[Correction to an earlier draft that
attributed this to Daniel Kim `875af304`: the `0→350000` existing-balance false positive was the
Laura Chen `9da89a81` deal, captured in the production Render log at 02:21:30. Daniel Kim `875af304`
was the earlier doc-only double-prelim fixed under commit `699029a`, now a regression test.]* On
turn 1 a BMO payout statement populated `existing_first_mortgage_balance` from null to **$350,000**.
`q10DetectMaterialChanges` (`webhook.js:1625-1646`) compared against the prior prelim, but its prior
value came from `q10ParsePriorFromPrelim` (`webhook.js:1653-1664`) parsing the **"Combined LTV"
display line**, which renders **$0** for paid-off refinances (the R11-A display convention). Prior
parsed as `0`, current was `$350k`, the detector read a fictitious **"0 → 350000" material change**,
and fired `[UPDATED]`. The "0" was a **rendered-display artifact**, not canonical truth.

**What works now (two parts).** (1) `webhook.js:1642` treats a prior `existing_mortgage_balance === 0`
as *"not yet known"* — a `0 → value` population by an arriving document is information becoming
available, not a correction. (2) `webhook.js:3844-3868` suppresses `[UPDATED]` on doc-only completion
turns, re-notifying only on a genuine change among the five material fields (`Q10_MATERIAL_FIELDS`,
`webhook.js:1618-1624`: loan amount, property value, existing balance, property address, loan type).
Verified by 13 assertions in `scripts/verify-pathb-prelim-refire.js`; the admin material-correction
delta-notice path is preserved.

**Advantage / why it works.** Exactly one prelim when a deal first becomes reviewable; an `[UPDATED]`
only when something materially changes (a $372k→$400k loan correction still fires). The reusable
lesson now encoded system-wide: **state discriminators must compare canonical-to-canonical, never
rendered-display-to-canonical** — display values carry presentation conventions (the paid-off `$0`)
that are not the underlying truth.

---

### A.5 — Address extraction on Canadian grid-numbered streets (commit `e2019d1`, `canonical-fields.js:230`)

**Initial state.** `ADDR_LINE_RE` required the street-name token to begin with a letter (`[A-Za-z]`).
Correct for named streets ("412 Windermere Close SW", "1142 Tory Road NW").

**Why it failed.** Western-Canadian grid addresses use **numeric** street names: "4412 116 Street NW"
is house 4412 on 116th Street. The regex skipped "4412 116", anchored the house-number capture on
"116", and emitted **"116 street nw"** — the real house number dropped. Surfaced on Laura Chen deal
`9da89a81`; also affected the firm's own signature address ("10446 122 Street NW") and any
Edmonton/Calgary/Regina/Saskatoon grid address. *(Diagnostic: an in-session DB scan found 2 of 30
recent deals affected (~6.7%); this is a directional diagnostic, not a committed metric.)*

**What works now ("Pattern B").** Two edits to `ADDR_LINE_RE` (`canonical-fields.js:230`): separator
`\s+`→`[\s-]+` (spaced **and** hyphenated forms); an **optional pre-suffix numeric token**
`(?:\d{1,4}\s+)?` so a numeric street name before the suffix is captured rather than mistaken for the
house number; alpha-token quantifier narrowed `{0,6}`→`{0,5}` to absorb that slot, bounded so a
unit/range number cannot leak into the house number. **Precise normalized output (verified):** because
extraction concatenates `m[1] + ' ' + m[2]` and `normalizeAddress` (`canonical-fields.js:206-215`)
lowercases and collapses whitespace, the hyphen form `"4412-116 Street NW"` normalizes to
**`"4412 116 street nw"`** (hyphen→space) — *not* "4412-116 Street NW" as an earlier draft stated.
Regression containment (verified): `ADDR_LINE_RE` feeds **only** the Snapshot address row and
cross-source address-discrepancy grouping (`discrepancy-engine.js:693`); the misattached-document
check (Group JJJJ) uses the LLM `property_address`, not this regex, and was unaffected. Committed
coverage: an OLD-vs-NEW address-corpus diff (10/10 unchanged); named-street and unit-number regression
cases tabulated in `SCOPE-FRANCO-SCENARIO2.md`.

**Advantage / why it works.** Correct capture across both named and grid-numbered conventions —
necessary for a product operating in Western Canada — without regressing the common case.

---

### A.6 — Document classification when the filename lies about the content (commit `3afdd45`)

**Initial state.** `classifyDocument` (`deals.js:34-98`) is filename-priority — a sound default
(brokers usually name files honestly).

**Failure.** Daniel Kim's `Credit_Bureau_Daniel_Kim.pdf` was byte-identical to his
`PNW_Statement_Daniel_Kim.pdf` (a mislabeled Personal Net Worth Statement). Filename-priority
classified it `credit_report`; the content held no credit data; the prelim then asserted **both**
"[RECEIVED] Credit_Bureau (credit_report)" and "No credit reports provided" — a **silent
contradiction**.

**Attempt — invert to content-first classification.** Rejected: content classification has its own
failure modes (poor OCR, image-heavy PDFs → false negatives on honestly-named files).

**What works now — a cross-check, not an inversion** (`deals.js:99-107`, `ai.js:897-918`).
`classifyByContent` was factored out (`deals.js:15-33`) and runs **independently**;
`detectClassificationMismatch` flags only when content reads **confidently** as a *different* specific
type (ambiguous `'other'` never flags); `injectClassificationMismatchCallout` surfaces it on the
prelim, wired at `webhook.js:1535-1548`. Filename classification still drives downstream, preserving
the common case. Verified: 13 assertions pass; a refactor-equivalence test proves filename-priority is
unchanged (`classifyDocument(neutralName, text) === classifyByContent(text)`); the callout is
idempotent (no duplication on `[UPDATED]` re-renders). *[Precision: the in-script fixture scan covers
the first 12 scenarios (`.slice(0,12)`), flagging 0; the broader "0 regressions across the suite"
result is from the separate full bulletproof run.]*

**Advantage / why it works.** Mislabeled or mis-uploaded files become **explicit, actionable signals**
instead of silent contradictions — generically across the document taxonomy — while preserving
common-case efficiency. A layered-defense pattern at the extraction tier.

---

### A.7 — Completion handoff aligned to the *actual* business workflow (R10-I repudiated; commit `3cbd82b`, origin `db6471a`)

**Initial state.** On AML/PEP receipt after approval, the broker's closing email was
`composeBrokerLenderPackageEmail` — a full Deal Snapshot + computed LTV + *"feel free to copy this into
your lender outreach"* + the document ZIP. Built (R10-I, `db6471a`) for an **earlier** client request
(Scenarios 6+7) for a broker-forwardable lender package.

**Why it failed.** Round-8 Scenario-2 feedback clarified the real workflow: **PML handles lender
outreach, not the broker.** The premise was wrong; the framing reflected a workflow misunderstanding.

**What works now (`3cbd82b`).** Reverted the broker closing to `generateCompletionEmail`
(`ai.js:2813-2828`), a deterministic fixed-language template **deliberately preserved** in code:
*"The file is now complete and submitted. Please direct any further questions to Franco at
franco@privatemortgagelink.com."* Removed the broker ZIP (`webhook.js:1907`, attachments now `[]`);
admin retains it. Updated the admin `[File Complete]` wording (`webhook.js:1799-1801`). Documented
R10-I as repudiated (`ai.js:919-931`); `composeBrokerLenderPackageEmail` is **retained, not deleted**
(`ai.js:991-1018`, still exported). Verified end-to-end on a fresh staging deal (runtime ID
`1aa7d5e1`, cloned from the `9da89a81` shape): broker = fixed language only; admin = new wording **with**
ZIP; sequencing admin→broker; both Postmark-delivered to the correct addresses.

**Advantage / why it works.** Communications match the real PML process. For the IP narrative, this
was **product evolution, not engineering error** — R10-I correctly implemented an earlier stated
requirement — and the system's feature-*preservation* discipline (revert to a deliberately-retained
prior template rather than delete-and-rewrite) let the direction change land cleanly in one commit.

---

### A.8 — Gate consistency across a multi-turn, thread-accumulated deal

**Initial state.** Deals are multi-turn; each event re-enters processing. The early-prelim gate exists
on the **initial-submission** branch (condition `webhook.js:3415`; prelim fires in the `else` ~`:3440`)
and the same logical decision recurs on **follow-up turns** via `computeWillReview` (`webhook.js:419`)
and its sibling `computeStillMissingForReview` (`webhook.js:471`), explicitly annotated *"Sibling
helper to computeWillReview"* (`webhook.js:461-463`).

**Failure mode.** A fix to one call site is incomplete if the same logical decision is also made at a
paired site that wasn't touched.

**What works now / design.** The two are a **matched pair** with one load-bearing invariant gated
**identically** on both branches — the unresolved-discrepancy hold ("QQQQ", via
`shouldHoldPrelimForDiscrepancy` at `webhook.js:3424` and `:4288`) — and one **intentional, documented
asymmetry**: the initial gate fires *without* exit-strategy (surfacing it as `[MISSING]`, a deliberate
S7.1/S9.1 relaxation) while `computeWillReview` *requires* exit-strategy on the active branch. *(So the
gates are a coordinated pair with a shared discrepancy invariant and one intentional asymmetry — more
precise than "identical".)* A prior defect (`ad49b10`, an orphaned `ltv` reference at the active-branch
site) confirms the pair must keep signature consistency.

**Advantage / why it works.** Multi-turn handling is consistent where it must be (the discrepancy-hold
invariant) and intentionally differentiated where early visibility is valuable — load-bearing for the
thread-accumulated-state model to behave predictably however a deal's documents arrive.

---

### A.9 — Deal deduplication at the create boundary (commits `fd469f5` R9-F, `d6f3b80` R9-F′)

**Initial state.** Every inbound email created a deal row.

**Why it failed.** A **77% duplicate rate** — replies and multi-document submissions spawned new
deals, and broker-persona or system senders ("Franco Maione", "Postmark Team", "King of Dates Corp")
polluted the deals table as fake borrowers.

**What works now.** Pre-create **intake classification** `classifyIntakeBorrower` (`webhook.js:564`,
applied at both deal-create paths, `webhook.js:2747` and `:2903`) filters non-deal entries; and
identity-based dedup `findExistingDealForBorrower` (`deals.js:149`) maps a conversation to one
existing deal before a new row is created.

**Advantage / why it works.** A clean, trustworthy system of record — everything downstream (chase
cadence, daily summaries, re-notification dedup) depends on the deal ledger being accurate. Identity
is resolved *before* a row exists, so a conversation maps to exactly one deal.

---

### A.10 — Broker-facing output hygiene: greeting/name resolution + post-generation sweeps (commits `90379ad` R8-B, `513e0da`/`51839f5` R10-A/B, `e08ca96`)

**Initial state.** Greetings and openers were LLM-generated and drew the recipient name from the email
From-header.

**Why it failed.** Recurring, cross-scenario output defects: a "Perfect!" opener appeared in
broker-facing prose (**10 production hits across 9 deals over 3 months**); welcome-email greetings
mis-resolved when the From-header carried a proxy/test name instead of the broker's body signature
(Round-6 Donna Blackwood / Jerome Osei silent-drops, decline-greeting "Hi there!" instead of "Hi
Victoria!").

**What works now.** Deterministic **post-generation sweeps** layered after generation —
`enforceNoRoutingLeak` (`ai.js:1704`) then `stripPerfectOpener` (`ai.js:1752`) (structural cascade
composition); a **body-aware classifier + body-prose name extractor** (R10-A/B) that prefers the
broker's body-signature name over the From-header; acknowledgment-on-reject so submissions are never
silently dropped.

**Advantage / why it works.** Broker-facing correspondence is consistent and correctly addressed
regardless of LLM phrasing variance or proxy From-headers — the deterministic sweep guarantees a
property the probabilistic generator cannot.

---

### A.11 — Scheduled jobs that actually fire: module-load pollution (commit `f97db21` R9-E)

**Initial state.** The daily-summary / chase-cadence cron was started at module-load time.

**Why it failed.** Starting the scheduler on `require` coupled it to module-load order and let
test-vs-production data pollution cross the boundary — manifesting as a "Sunday cron not firing"
root cause.

**What works now.** An explicit `startCron()` **factory** (`src/cron/dailySummary.js:561`), invoked
deliberately by `src/index.js` only in the production `app.listen` path — decoupling scheduler startup
from module-load and isolating test from prod.

**Advantage / why it works.** Reliable scheduled execution (chase reminders, daily admin digest,
stall-escalation) with a clean test/prod boundary — the background cadence the product depends on
runs predictably.

---

### A.12 — Verifying a non-deterministic, asynchronous email agent: the "Bulletproof" harness (Phases 1–8) — *itself a methodology asset*

**Initial state.** How do you regression-test an agent that is LLM-driven (non-deterministic),
asynchronous (email round-trips), and stateful (Supabase + Postmark)?

**Why naïve testing failed.** Checks **raced the pipeline** — a prelim that generated at ~69s was
scored as "silence" by a ~40s check (a recurring false-negative); and synthetic fixtures passed while
real submissions failed (the genesis of the verify-against-real-submission discipline, A.1).

**What works now.** A purpose-built harness (`test-fixtures/bulletproof/`, **125 scenarios**):
synthetic document generation (`pdfSynth.js`), conversation/email synthesis (`conversationSynth.js`,
`emailSynth.js`), **poll-for-stable** inter-event waiting (advance only when the outbound count stops
changing, not on a fixed sleep), Supabase-by-deal-id outbound correlation (`supabasePull.js`,
`replay.js`), `+tag` email subaddressing for correlation, a render-surface assertion engine
(`assertEngine.js`), and PII scrubbing (`piiScrubber.js`). Layered with the real-submission gate
(`scripts/trace-deal-extraction.js`).

**Advantage / why it works.** A **regression net for a probabilistic system** — it allows shipping
changes to a *live* agent with empirical before/after evidence (as demonstrated across the most recent
two-bundle release, fully verified on deployed code). The harness models the agent's actual
async/stateful behavior rather than assuming synchronous determinism. This verification methodology is
itself a distinct, defensible asset.

---

## PART B — SYSTEM ARCHITECTURE (orientation for counsel)

**End-to-end flow.**
1. **Ingress** — Postmark parses an inbound broker email and POSTs it to Vienna's Express webhook
   (`src/routes/webhook.js`).
2. **Document extraction** — attachments are persisted to Supabase Storage; text is extracted by
   `pdf-parse` and, for fillable/marked-up PDFs, the hidden fields/annotations by `pdf-lib`
   (`src/lib/pdfFormExtract.js`); the content-shape router (`src/lib/pdf.js`) decides text vs. vision.
3. **Classification** — `src/services/deals.js` classifies each document (filename-priority +
   independent content cross-check).
4. **Canonicalization & reconciliation** — `src/services/canonical-fields.js` extracts each field per
   source; `src/services/discrepancy-engine.js` reconciles under source-hierarchy and computes
   LTV/combined-LTV deterministically.
5. **Reasoning & drafting** — `src/services/ai.js` calls Claude (via `src/lib/claude.js`) for
   document understanding and prose, with deterministic values injected as overrides and JS-injected
   admin callouts.
6. **Dispatch / state machine** — `src/routes/webhook.js` runs the multi-turn lifecycle (gates,
   prelim firing, `[UPDATED]` suppression, escalation, completion handoff, dedup) and persists state to
   Supabase.
7. **Egress** — `src/services/email.js` (via `src/lib/postmark.js`) sends prelims, clarifications,
   escalations, declines, completion closings, and admin notices.
8. **Background cadence** — `src/cron/dailySummary.js` (via `node-cron`) runs chase reminders, the
   daily admin digest, and stall-escalation.

**Module size (proprietary `src/`, 15,373 LOC total):** `services/ai.js` 4,649 · `routes/webhook.js`
4,540 · `services/canonical-fields.js` 2,173 · `services/discrepancy-engine.js` 1,423 ·
`cron/dailySummary.js` 638 · `services/deals.js` 757 · `services/email.js` 172 ·
`services/borrower-qualification.js` 155 · `lib/dealType.js` 152 · `lib/pdf.js` 94 ·
`lib/pdfFormExtract.js` 80 · `services/corporate-entities.js` 84 · `services/registered-owner.js` 72 ·
`lib/greeting.js` 64 · plus thin OSS wrappers (`lib/claude.js` 8, `lib/supabase.js` 6,
`lib/postmark.js` 6).

---

## PART C — DISTILLED NOVEL / DEFENSIBLE PATTERNS

1. **Deterministic-decision / probabilistic-prose separation** — decision-driving figures are computed
   in auditable JS over canonical sources; the LLM is confined to narrative, steered by
   `DETERMINISTIC — USE THIS` prompt overrides (A.2).
2. **Resolve-correctly / flag-separately / never-cross-wire** — contradictions are surfaced for human
   resolution without corrupting the decision math (A.3).
3. **Canonical-to-canonical state discrimination** — never compare rendered-display values against
   canonical truth (A.4).
4. **Hidden-data-layer document ingestion** — read AcroForm fields + annotations, route by content
   shape, never fabricate when data is absent (A.1).
5. **Independent cross-check verification at the extraction tier** — filename-priority for throughput +
   content cross-check for a specific failure mode, surfacing mismatches (A.6).
6. **Deterministic post-generation sweeps** — guarantee broker-facing output properties the
   probabilistic generator cannot (A.10).
7. **Feature-preservation discipline** — repudiated features are retained-not-deleted, enabling clean,
   one-commit reversals when product direction changes (A.7).
8. **Async/stateful agent verification methodology** — poll-for-stable + render-surface assertions +
   real-submission gating (A.12).

---

## PART D — OPEN-SOURCE BILL OF MATERIALS (authoritative)

**Source & method.** Generated from `package-lock.json` (lockfileVersion 3), which records an SPDX
license identifier for **all 217** resolved packages (9 direct runtime + 1 dev + 207 transitive). The
identifiers below are the lockfile-recorded SPDX values. *Recommended evidentiary attachment for the
definitive file:* a `license-checker --json` / SPDX SBOM export against an installed `node_modules`
(not present locally at audit time) to attach full license texts and copyright notices; the identifier
set will match this report.

### D.1 — Direct runtime dependencies

| Package | Version | License | Purpose | Verified usage (file) |
|---|---|---|---|---|
| `@anthropic-ai/sdk` | 0.73.0 | MIT | Anthropic/Claude client — the reasoning engine | `src/lib/claude.js` → `src/services/ai.js` (document understanding, narrative, classification) |
| `@supabase/supabase-js` | 2.95.3 | MIT | Postgres + Storage client (system of record) | `src/lib/supabase.js` → `src/services/deals.js` (`deals`/`messages`/`documents` + storage bucket) |
| `express` | 5.2.1 | MIT | HTTP server / routing | `src/index.js`, `src/routes/*` (Postmark inbound webhook, cron routes; `express.Router()`); body parsing via Express 5 built-in middleware |
| `postmark` | 4.0.5 | MIT | Transactional email (in + out) | `src/lib/postmark.js` → `src/services/email.js` (prelims, closings, admin notices, declines, chases) |
| `pdf-parse` | 1.1.1 | MIT | PDF static-text-layer extraction | `src/services/deals.js` (intake first-pass text) |
| `pdf-lib` | 1.17.1 | MIT | PDF AcroForm fields + annotation reading | `src/lib/pdfFormExtract.js`; used **in tandem** with `pdf-parse` in `deals.js` to recover filled-form data |
| `archiver` | 7.0.1 | MIT | ZIP creation | `src/services/deals.js` (`downloadDocsAsZip` → admin `[File Complete]` package) |
| `node-cron` | 4.2.1 | ISC | In-process job scheduler | `src/cron/dailySummary.js` (daily digest, chase cadence, stall-escalation) |
| `dotenv` | 17.2.3 | BSD-2-Clause | `.env` config loader | `src/config/index.js` (API keys, admin email, service IDs) |

### D.2 — Development-only dependency

| Package | Version | License | Purpose | Usage |
|---|---|---|---|---|
| `nodemon` | 3.1.11 | MIT | Hot-reload during local dev | `npm run dev` only; not in application code |

### D.3 — Full transitive license landscape (all 217 packages)

| SPDX license | Count | Class | Obligations (summary) | Notable packages |
|---|---|---|---|---|
| MIT | 175 | Permissive | Retain copyright + license notice | (majority of the tree) |
| ISC | 21 | Permissive | Retain copyright + license notice | `node-cron`, `glob`, `semver`, `lru-cache`, `inherits`, `once`, `wrappy` |
| Apache-2.0 | 11 | Permissive + explicit patent grant | Retain notices; preserve `NOTICE` if present; state changes | `crc-32`, `readdir-glob`, `text-decoder`, `b4a`, the `bare-*` runtime shims |
| BlueOak-1.0.0 | 4 | Permissive (OSI-approved 2023) + patent grant | Retain notice | `minipass`, `path-scurry`, `jackspeak`, `package-json-from-dist` |
| BSD-3-Clause | 2 | Permissive | Retain notice; no-endorsement clause | `ieee754`, `qs` |
| 0BSD | 2 | Public-domain-equivalent | **None** (not even attribution) | `tslib` (×2) |
| BSD-2-Clause | 1 | Permissive | Retain notice | `dotenv` |
| (MIT AND Zlib) | 1 | Permissive | Retain notice | `pako` |

**Copyleft / reciprocal scan: ZERO.** No GPL, AGPL, LGPL, SSPL, MPL, EUPL, CDDL, EPL, or CPAL package
appears anywhere in the 217-package tree. Every license is permissive or public-domain-equivalent.
None imposes source-disclosure, share-alike, or network-use obligations on Vienna's proprietary code.
The only obligations are notice/attribution retention (and, for Apache-2.0, preserving any `NOTICE`
file and stating modifications). `0BSD` (tslib) imposes no obligation at all.

### D.4 — Packages erroneously attributed to Vienna in a prior draft — CONFIRMED ABSENT

Verified absent from `package.json` **and** not `require`d anywhere in `src/`:
`body-parser`, `cors`, `tesseract.js`, `pino`, `uuid`, `date-fns`, `lodash`, `jest`, `mocha`,
`eslint`, `prettier`, `pdfjs-dist`. (Body parsing → Express 5 built-in middleware; **no OCR library**
— scanned/image PDFs route to the Anthropic vision model; **no separate logging/UUID/date/utility
library** — Node built-ins and the LLM/deterministic engines cover those roles.)

### D.5 — External hosted services (commercial; not bundled OSS — listed for completeness)

| Service | Role | Nature |
|---|---|---|
| Anthropic API (Claude) | LLM reasoning behind `@anthropic-ai/sdk` | Proprietary SaaS |
| Supabase (hosted) | Managed Postgres + Storage behind the client | Managed SaaS (OSS core is Apache-2.0; Vienna consumes the hosted product) |
| Postmark | Inbound email parsing + outbound delivery | Proprietary SaaS |
| Render | Build/deploy/host + logs + cron worker | Proprietary SaaS (auto-deploys from `main`) |

---

## PART E — IP POSTURE & RECOMMENDATIONS

1. **The proprietary value is the first-party code.** ~15.4K LOC of original logic — the canonical
   extraction engine, multi-source discrepancy reconciliation, the dispatch/state machine,
   deterministic Snapshot rendering, the eight distilled patterns (Part C), and the Bulletproof
   verification methodology — none of which is derived from or encoded in any open-source dependency.
2. **The open-source surface is thin, permissive, and swappable.** Nine direct libraries handle
   transport (HTTP, email), byte-level parsing (PDF, ZIP), DB/LLM client access, scheduling, and
   config. All 217 packages are permissively licensed; **zero copyleft**; obligations are limited to
   notice/attribution retention (Apache-2.0 adds patent grant + NOTICE handling; 0BSD imposes none).
3. **Manifest hygiene (DONE 2026-06-05).** Root `package.json` now declares `"license": "UNLICENSED"`,
   `"private": true`, and a proprietary `description` (was `ISC` / no `private`). Counsel to confirm
   no prior public-registry publication carried the old `ISC` declaration.
4. **Evidentiary attachment (included).** A machine-readable SBOM is generated alongside this
   document: `sbom/vienna-sbom.json` (all 217 packages: name, version, SPDX license, scope, resolved
   URL, integrity hash) and `sbom/vienna-licenses.csv`, both derived from `package-lock.json` and
   offline-reproducible. To attach **full license texts/copyright notices**, run `npm ci` then
   `npx license-checker --json` (or CycloneDX) in a networked environment — identifiers will match
   Part D / the SBOM. See `sbom/README.md`.
5. **Confidentiality.** This document references proprietary architecture, file paths, and deal
   identifiers; handle under attorney-client privilege.

---

## PART F — VERIFICATION LEDGER (commit & symbol index)

| Claim area | Primary commit(s) | Key symbols / locations |
|---|---|---|
| PDF hidden-layer extraction | `f486980`; `d365013`→`9f204e1` (revert) | `lib/pdf.js` (`isFormLikeText`, `buildContentBlocks`), `lib/pdfFormExtract.js` |
| Deterministic canonical engine | `299abc6` (R9-B), `f0e9617` (R9-D), `c1793e6` (R10-E), `01b991a` (R10-D) | `canonical-fields.js`, `discrepancy-engine.js` |
| Refinance LTV "Option C" | `a621a20` | `discrepancy-engine.js:437-442`, `:470-495`; `ai.js:859-879`; `webhook.js:1520-1534` |
| Single prelim / Q10 | `e2019d1`; prior `699029a` | `webhook.js:1625-1646`, `:1642`, `:1653-1664`, `:3844-3868` |
| Address grid-street regex | `e2019d1` | `canonical-fields.js:230`, `:206-215` |
| Classification cross-check | `3afdd45` | `deals.js:15-33`, `:99-107`; `ai.js:897-918`; `webhook.js:1535-1548` |
| Completion handoff workflow | `3cbd82b`; origin `db6471a` | `ai.js:2813-2828`, `:919-931`, `:991-1018`; `webhook.js:1799-1801`, `:1907` |
| Multi-turn gate pair | initial `webhook.js:3415`; `ad49b10` (defect) | `webhook.js:419`, `:471`, `:461-463`, `:3424`, `:4288` |
| Deal dedup at create boundary | `fd469f5` (R9-F), `d6f3b80` (R9-F′) | `webhook.js:564`; `deals.js:149` |
| Output hygiene sweeps / greeting | `90379ad` (R8-B), `513e0da`/`51839f5` (R10-A/B), `e08ca96` | `ai.js:1704`, `:1752`; `lib/greeting.js` |
| Cron factory | `f97db21` (R9-E) | `cron/dailySummary.js:561`; `index.js` |
| Bulletproof harness | Phases 1–8 (multiple) | `test-fixtures/bulletproof/` (125 scenarios; `lib/` engines) |

*All `file:line` and commit references verified at git `HEAD = 421c659` on 2026-06-05.
Dependency identifiers verified from `package-lock.json` (217 packages; zero copyleft).*
