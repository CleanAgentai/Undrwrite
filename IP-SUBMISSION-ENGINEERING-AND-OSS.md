# Vienna (Undrwrite) — Engineering Record and Open-Source Bill of Materials
## Technical submission for IP counsel

---

### Document control

| Field | Value |
|---|---|
| Subject system | Vienna — autonomous mortgage-underwriting email agent for Private Mortgage Link (PML) |
| Codebase | Undrwrite (Vienna); package name `undrwrite-backend` |
| Date | 2026-06-05 |
| Stack | Node.js · Express 5 · Supabase (Postgres + Storage) · Postmark (email) · Anthropic Claude (language model) · Render (hosting) |

---

### Executive summary

Vienna is an autonomous agent that receives mortgage broker submissions by email, reads the attached
documents, reconciles the facts across sources, computes the underwriting figures, drafts and sends the
preliminary review and all follow-up correspondence, and manages the deal through its multi-turn
lifecycle to completion. A person — the PML principal — approves the credit decision.

The defensible intellectual property is the first-party code: roughly 15,400 lines, concentrated in
four modules — `services/ai.js` (4,649 lines), `routes/webhook.js` (4,540 lines, the dispatch and
state machine), `services/canonical-fields.js` (2,173 lines, deterministic extraction), and
`services/discrepancy-engine.js` (1,423 lines, multi-source reconciliation). The open-source
dependencies (Part D) are thin transport and parsing libraries; the wrappers around them are six to
eight lines each, and none of them contains any underwriting, extraction, or decision logic.

The hardest problems in the build share one shape. A simple approach worked on clean inputs and failed
on the messy, contradictory inputs brokers actually send: half-filled PDF forms, mislabeled files,
numeric street names, conflicting lender names, varying payout conventions. The recurring answer, and
the core of the intellectual property, is a clear separation between deterministic, auditable
computation of the facts that drive a decision and the language model's generation of the prose around
them — with contradictions surfaced for a person to resolve rather than silently resolved or allowed to
corrupt the decision.

---

## Part A — Engineering problems solved

Each entry describes the initial approach, why it failed, what works now, and why it matters. Commit
hashes and exact code locations for every item are listed in Part F.

---

### A.1 — Reading filled PDF forms without fabricating data

**Initial approach.** Broker PDFs (loan applications, appraisals) were sent directly to the Claude
vision model. This worked on clean, digitally typeset documents.

**Why it failed.** Brokers routinely send fillable Adobe forms and PDFs marked up in Preview or Adobe.
The values they type live in the form's metadata and annotations, not in the rendered text layer. The
text extractor returns only the blank template labels — "Primary Borrower," "Date of Birth" — which are
identical for a blank form and a filled one. As a result, Vienna either saw an empty form or the vision
model supplied plausible loan numbers that then conflicted with the broker's email. An early fix added
a gate to suppress this; it was reverted once the real cause was understood — conflicting data across
sources, not a fabrication to be suppressed.

**What works now.** A content-shape router decides how to read each document instead of trusting its
filename. A heuristic detects template-only text (mostly short lines, no dollar amounts, no paragraphs)
and routes those documents to the vision model rather than trusting the empty text layer. A second,
deterministic extractor reads the hidden form-field values and annotations that the text extractor
cannot see, and the two readings are combined. High-value documents are sent both as text and as an
image. A standing rule reinforces this: verify against the broker's real submission, not a synthetic
test fixture — adopted after a fixture passed while the real document still failed.

**Why it matters.** Brokers do not send clean data. Vienna reads the data layer that most pipelines
silently lose, routes each document by what it actually contains rather than by its name, and declines
to invent values when data is genuinely absent.

---

### A.2 — Separating deterministic computation from language-model prose

**Initial approach.** The language model both extracted and computed the deal facts for the preliminary
review — loan-to-value, balances, mortgage position, lender, address, province.

**Why it failed.** The model produced inconsistent results on figures that must be exact and auditable.
The same submission produced two different loan-to-value figures (72.8% versus 60.7%, and in another
deal 62.4% versus 61.8%) between the model's reading and the correct computed value. The existing
lender appeared as "Scotiabank" in prose when the payout statement said otherwise. Mortgage position
contradicted itself between the snapshot and the risk-factors section. Province rendered as "TBD / TBD"
on valid addresses. For a lender these are not cosmetic; a wrong loan-to-value is a wrong decision.

**What works now.** A deterministic extraction-and-reconciliation engine reads each field from every
source — email body, appraisal, payout statement, tax bill, credit bureau, loan application — and
records which source each value came from. It reconciles the values across sources under an explicit
priority order, computes the loan-to-value figures in plain code, and renders the deal snapshot
deterministically rather than through the model. Where the model's prose must be steered, the computed
value is injected into the prompt as a fixed instruction, and risk notes are inserted by code rather
than generated by the model.

**Why it matters.** Every number that drives a decision is auditable and reproducible, traceable to a
named source document, and disagreements between sources are surfaced rather than silently averaged or
invented. The model is confined to prose. This separation is the system's defining property and the
basis of its reliability for underwriting.

---

### A.3 — Refinance loan-to-value: compute correctly, flag contradictions separately (commit `a621a20`)

**Initial approach.** Combined loan-to-value on a refinance is the existing first-mortgage balance plus
the new loan, divided by the property value. When the existing mortgage is being paid out — for
example, existing $400k, new loan $408k, value $680k — the additive figure is 118.8%. That number is
meaningless for the deal that exists after closing, and it is high enough to auto-decline a clean 60%
refinance.

**First attempt.** Collapse the combined figure to the standalone figure whenever the deal is labeled a
refinance. This was unsafe: a broker can be wrong about the payout — two existing mortgages with only
one being paid out, or the wrong lender — which would feed a wrong loan-to-value into a real decision.

**Second attempt.** Fire the carve-out only when the broker's stated payout lender matches the lender on
the mortgage-statement document. This was too conservative on noisy submissions. In one deal, the
existing $318k balance came from the credit report (no mortgage statement was attached), so the lender
match could not anchor, the carve-out did not fire, and the combined figure computed additively to
106.8% — putting a clean 60% refinance at risk of a false decline.

**What works now.** The same input produces two independent outputs. The decision math computes the
carve-out from the broker's stated transaction intent when that intent is clear, guarded by a check
that the requested loan is at least the existing balance. Separately, any lender contradiction is
surfaced as a review flag for the principal — "the refinance LTV is computed on the stated payout (new
loan ÷ value); confirm which existing mortgage is being refinanced" — and is not used to block the
deal. The same principle is applied to mortgage-position inference.

**Why it matters.** Clean refinances proceed correctly even when sources disagree or are missing, and
contradictions never silently corrupt the math or kill a good deal — they go to a person while the math
reflects reality. Resolve correctly, flag the disagreement separately, and never let a contradiction
drive the decision number.

---

### A.4 — Sending exactly one preliminary review (commit `e2019d1`)

**Initial approach.** The preliminary-review gate fires as soon as the system can compute loan-to-value
and at least one reviewable document is attached, listing still-missing items as "[MISSING]" markers so
the underwriter has early visibility. It re-evaluates on later turns.

**Why it failed.** Re-firing an updated review on any change after the first review produced duplicate
reviews on routine document-completion turns — a near-identical second review minutes later, with the
same numbers and no new information.

**Root cause.** On the second turn of one deal, a payout statement populated the existing
first-mortgage balance from empty to $350,000. The change detector compared against the prior review,
but it read the prior balance from the "Combined LTV" display line, which shows $0 for a paid-off
refinance. The prior value therefore parsed as 0, the current value was $350,000, and the detector
treated this as a material change and re-fired. The 0 was an artifact of how the figure is displayed,
not the underlying data.

**What works now.** Two changes: a prior balance of 0 is treated as "not yet known," so a move from 0 to
a real value when a document arrives is new information rather than a correction; and the updated review
is suppressed on document-only completion turns, re-firing only when one of five material fields
actually changes — loan amount, property value, existing balance, property address, or loan type. The
separate admin correction-notice path is unaffected.

**Why it matters.** The underwriter gets exactly one review when a deal first becomes reviewable, and an
updated one only when something material changes (a loan correction from $372k to $400k still fires).
The general lesson, now applied throughout the system: compare underlying data to underlying data, never
a displayed value to underlying data.

---

### A.5 — Address extraction on numbered streets (commit `e2019d1`)

**Initial approach.** The address pattern required the street-name token to begin with a letter. This is
correct for named streets such as "412 Windermere Close SW" or "1142 Tory Road NW."

**Why it failed.** Western-Canadian grid addresses use numeric street names: "4412 116 Street NW" is
house 4412 on 116th Street. Because the street name had to begin with a letter, the pattern skipped
"4412 116," took "116" as the house number, and produced "116 street nw" — dropping the real house
number. This affected the principal's own address ("10446 122 Street NW") and would affect any grid
address in Edmonton, Calgary, Regina, or Saskatoon. A spot check found this pattern in 2 of 30 recent
deals.

**What works now.** The pattern was changed so the separator accepts a space or a hyphen, a numeric
street name immediately before the street suffix is captured rather than skipped, and a unit or range
number cannot leak into the house number. The extracted value is lowercased and whitespace-collapsed,
so "4412-116 Street NW" normalizes to "4412 116 street nw." The change feeds only the snapshot address
row and the cross-source address comparison; the document-mismatch check uses the model's extracted
address and was unaffected. Regression testing confirmed that every named-street address in the test
corpus was unchanged.

**Why it matters.** Correct address capture for both named and numbered streets — necessary for a
product operating in Western Canada — without regressing the common case.

---

### A.6 — Document classification when the filename does not match the content (commit `3afdd45`)

**Initial approach.** The classifier reads the filename first, which is the right default because
brokers usually name files honestly.

**Why it failed.** In one submission, a file submitted under a credit-bureau name was byte-identical to
the borrower's personal-net-worth-statement file. The filename classified it as a credit report, but the
content held no credit data, so the review stated both "credit report received" and "no credit reports
provided" — a contradiction with no flag.

**Rejected approach.** Inverting to content-first classification was rejected, because content
classification has its own failure modes — poor OCR, image-only PDFs — that would mislabel honestly
named files.

**What works now.** A cross-check rather than an inversion. Content classification runs independently
and raises a flag only when the content reads confidently as a different, specific type; an ambiguous
result never flags. The mismatch is then surfaced on the review. Filename classification still drives
everything downstream, so the common case is unchanged, and the flag is written once even when a review
is re-rendered.

**Why it matters.** A mislabeled or mis-uploaded file becomes an explicit, actionable flag instead of a
silent contradiction in the underwriting summary — across the whole document taxonomy, and without
slowing the common case.

---

### A.7 — Aligning the completion handoff to the real business workflow (commit `3cbd82b`)

**Initial approach.** When the final compliance forms arrived after approval, the broker's closing email
was a full deal snapshot with the computed loan-to-value and the line "feel free to copy this into your
lender outreach," plus the document package as a ZIP attachment. This was built for an earlier stated
requirement — give the broker a package to forward to lenders.

**Why it failed.** Later client feedback clarified the actual workflow: PML handles lender outreach, not
the broker. The premise behind the broker package was wrong.

**What works now.** The broker closing reverted to a fixed-language template that had been kept in the
code for exactly this purpose: "The file is now complete and submitted. Please direct any further
questions to Franco at franco@privatemortgagelink.com." Nothing else — no snapshot, no figures. The ZIP
was removed from the broker email; the admin still receives it. The admin completion notice was
reworded. The earlier broker-package function was marked superseded but kept in the codebase rather than
deleted. The change was verified end-to-end on a fresh staging deal: the broker received the fixed
language only; the admin received the new wording with the ZIP; the admin notice preceded the broker
email; both were delivered to the correct addresses.

**Why it matters.** The correspondence now matches PML's real process, and the broker is not told to do
work PML performs. Because the prior template had been kept rather than deleted, the change in direction
landed cleanly in a single commit.

---

### A.8 — Removing duplicate deals at creation (commits `fd469f5`, `d6f3b80`)

**Initial approach.** Every inbound email created a new deal record.

**Why it failed.** This produced a 77% duplicate rate: replies and multi-document submissions each
spawned new deals, and admin-side addresses, automated system senders (such as transactional-email
service notifications), and corporate-entity test entries appeared in the deals table as fake borrowers.

**What works now.** Before a deal is created, an intake classifier filters out non-deal senders, and an
identity match maps a continuing conversation to the existing deal instead of creating a new one.

**Why it matters.** The deal ledger stays accurate, which everything downstream depends on — chase
reminders, daily summaries, and de-duplicated notifications. A conversation maps to exactly one deal.

---

### A.9 — Consistent, correctly addressed broker emails (commits `90379ad`, `513e0da`, `51839f5`, `e08ca96`)

**Initial approach.** Greetings and openers were generated by the model, and the recipient's name was
taken from the email's From header.

**Why it failed.** Two recurring defects appeared across many deals: a "Perfect!" opener showed up in
broker-facing prose (10 times across 9 deals over three months), and greetings were mis-addressed when
the From header carried a proxy or test name rather than the broker's signature — including a generic
"Hi there!" in place of the broker's name.

**What works now.** Two deterministic clean-up passes run after the model generates text, and a
body-aware classifier prefers the broker's name from the email body over the From header. Submissions
that cannot be processed are acknowledged rather than dropped.

**Why it matters.** Broker correspondence is consistent and correctly addressed regardless of how the
model phrases things or what the From header contains — a guarantee the deterministic clean-up provides
that the model alone cannot.

---

## Part B — System architecture

The processing pipeline, in order:

| Step | Stage | What happens |
|---|---|---|
| 1 | Ingress | Postmark parses an inbound broker email and posts it to Vienna's webhook (`src/routes/webhook.js`). |
| 2 | Document extraction | Attachments are saved to Supabase Storage; text is read by `pdf-parse`, and the hidden fields and annotations of fillable PDFs by `pdf-lib` (`src/lib/pdfFormExtract.js`); the content-shape router (`src/lib/pdf.js`) chooses text or vision. |
| 3 | Classification | `src/services/deals.js` classifies each document — filename first, with an independent content cross-check. |
| 4 | Reconciliation | `src/services/canonical-fields.js` extracts each field per source; `src/services/discrepancy-engine.js` reconciles them and computes the loan-to-value figures. |
| 5 | Reasoning and drafting | `src/services/ai.js` calls Claude (via `src/lib/claude.js`) for understanding and prose, with computed values injected as fixed instructions and risk notes inserted by code. |
| 6 | Dispatch and state | `src/routes/webhook.js` runs the multi-turn lifecycle — gating, review firing, update suppression, escalation, completion handoff, de-duplication — and saves state to Supabase. |
| 7 | Egress | `src/services/email.js` (via `src/lib/postmark.js`) sends reviews, clarifications, escalations, declines, completion emails, and admin notices. |
| 8 | Background jobs | `src/cron/dailySummary.js` (via `node-cron`) runs chase reminders, the daily summary, and stalled-deal escalation. |

Module sizes (first-party code, 15,373 lines total):

| Module | Lines | Role |
|---|---|---|
| `services/ai.js` | 4,649 | Model calls, prose, injected overrides |
| `routes/webhook.js` | 4,540 | Dispatch and state machine |
| `services/canonical-fields.js` | 2,173 | Deterministic field extraction |
| `services/discrepancy-engine.js` | 1,423 | Multi-source reconciliation and snapshot rendering |
| `services/deals.js` | 757 | Document persistence and classification |
| `cron/dailySummary.js` | 638 | Scheduled jobs |
| `services/email.js` | 172 | Outbound email |
| `services/borrower-qualification.js` | 155 | Borrower qualification |
| `lib/dealType.js` | 152 | Deal-type logic |
| `lib/pdf.js` | 94 | Content-shape routing |
| `services/corporate-entities.js` | 84 | Corporate-entity detection |
| `lib/pdfFormExtract.js` | 80 | Form-field and annotation extraction |
| `services/registered-owner.js` | 72 | Registered-owner detection |
| `lib/greeting.js` | 64 | Greeting and name resolution |
| Open-source wrappers | 20 | `lib/claude.js` (8), `lib/supabase.js` (6), `lib/postmark.js` (6) |

---

## Part C — Reusable design patterns

1. Separate deterministic decision-making from model-generated prose. The figures that drive a decision
   are computed in auditable code; the model only writes the surrounding language (A.2).
2. Resolve correctly, flag separately, never cross-wire. Contradictions are surfaced for a person without
   being allowed to corrupt the decision math (A.3).
3. Compare underlying data to underlying data. Never compare a displayed value against the underlying
   data (A.4).
4. Read the hidden data layer. Extract form fields and annotations, route by content rather than
   filename, and never fabricate when data is absent (A.1).
5. Cross-check at the extraction tier. Keep filename classification for speed, and add an independent
   content check to catch a specific failure mode (A.6).
6. Clean up deterministically after generation. Guarantee output properties the model alone cannot (A.9).
7. Preserve superseded features rather than delete them, so a change in product direction can be reversed
   cleanly (A.7).

---

## Part D — Open-source bill of materials

Generated from `package-lock.json` (lockfile version 3), which records a license identifier for all 217
resolved packages: 9 direct runtime dependencies, 1 development dependency, and 207 transitive
dependencies.

### D.1 — Direct runtime dependencies

| Package | Version | License | Purpose | Where it is used |
|---|---|---|---|---|
| `@anthropic-ai/sdk` | 0.73.0 | MIT | Claude client — the reasoning engine | `src/lib/claude.js` → `src/services/ai.js` (document understanding, prose, classification) |
| `@supabase/supabase-js` | 2.95.3 | MIT | Postgres and storage client (system of record) | `src/lib/supabase.js` → `src/services/deals.js` (deals, messages, documents, and the storage bucket) |
| `express` | 5.2.1 | MIT | HTTP server and routing | `src/index.js`, `src/routes/*` (the Postmark webhook and cron routes); body parsing uses Express 5's built-in middleware |
| `postmark` | 4.0.5 | MIT | Inbound and outbound email | `src/lib/postmark.js` → `src/services/email.js` (reviews, closings, admin notices, declines, chases) |
| `pdf-parse` | 1.1.1 | MIT | PDF text-layer extraction | `src/services/deals.js` (first-pass text at intake) |
| `pdf-lib` | 1.17.1 | MIT | Reads PDF form fields and annotations | `src/lib/pdfFormExtract.js`, used together with `pdf-parse` in `deals.js` to recover filled-form data |
| `archiver` | 7.0.1 | MIT | ZIP creation | `src/services/deals.js` (the document package attached to the admin completion notice) |
| `node-cron` | 4.2.1 | ISC | In-process job scheduler | `src/cron/dailySummary.js` (daily summary, chase cadence, stalled-deal escalation) |
| `dotenv` | 17.2.3 | BSD-2-Clause | Loads configuration from a `.env` file | `src/config/index.js` (API keys, admin email, service IDs) |

### D.2 — Development-only dependency

| Package | Version | License | Purpose | Usage |
|---|---|---|---|---|
| `nodemon` | 3.1.11 | MIT | Auto-restart during local development | `npm run dev` only; not used in application code |

### D.3 — Full license landscape (all 217 packages)

| License | Count | Class | Obligations | Notable packages |
|---|---|---|---|---|
| MIT | 175 | Permissive | Retain the copyright and license notice | the majority of the tree |
| ISC | 21 | Permissive | Retain the copyright and license notice | `node-cron`, `glob`, `semver`, `lru-cache`, `inherits` |
| Apache-2.0 | 11 | Permissive, with a patent grant | Retain notices, preserve any NOTICE file, state changes | `crc-32`, `readdir-glob`, `text-decoder`, and the `bare-*` runtime shims |
| BlueOak-1.0.0 | 4 | Permissive (OSI-approved, with a patent grant) | Retain the notice | `minipass`, `path-scurry`, `jackspeak`, `package-json-from-dist` |
| BSD-3-Clause | 2 | Permissive | Retain the notice; no-endorsement clause | `ieee754`, `qs` |
| 0BSD | 2 | Public-domain-equivalent | None (not even attribution) | `tslib` |
| BSD-2-Clause | 1 | Permissive | Retain the notice | `dotenv` |
| MIT AND Zlib | 1 | Permissive | Retain the notice | `pako` |

Copyleft scan: zero. No GPL, AGPL, LGPL, SSPL, MPL, EUPL, CDDL, EPL, or CPAL package appears anywhere in
the 217-package tree. Every license is permissive or public-domain-equivalent. None imposes
source-disclosure, share-alike, or network-use obligations on Vienna's proprietary code. The only
obligations are to retain notices and attribution (Apache-2.0 adds a patent grant and a NOTICE-file
requirement; 0BSD requires nothing at all).

### D.4 — External hosted services

These are commercial services Vienna calls, not bundled open source; listed for completeness.

| Service | Role | Nature |
|---|---|---|
| Anthropic API (Claude) | The language model behind `@anthropic-ai/sdk` | Commercial service |
| Supabase (hosted) | Managed Postgres and storage behind the client | Managed service (its open-source core is Apache-2.0; Vienna uses the hosted product) |
| Postmark | Inbound email parsing and outbound delivery | Commercial service |
| Render | Build, deploy, hosting, logs, and the cron worker | Commercial service |

---

## Part E — IP posture and recommendations

1. The defensible value is the first-party code: the extraction engine, the multi-source reconciliation,
   the dispatch and state machine, deterministic snapshot rendering, and the seven patterns in Part C —
   none of it derived from or contained in any open-source dependency.
2. The open-source surface is thin and permissively licensed. Nine direct libraries handle HTTP, email,
   PDF and ZIP parsing, database and model access, scheduling, and configuration. All 217 packages are
   permissively licensed, with no copyleft; the only obligations are to retain notices and attribution.
3. Manifest hygiene (completed 2026-06-05). The root `package.json` now declares `"license": "UNLICENSED"`,
   sets `"private": true`, and carries a proprietary description; it previously declared `ISC` with no
   `private` flag. Counsel should confirm no earlier version was published to a public registry under the
   `ISC` declaration.
4. Evidentiary attachment. A machine-readable bill of materials accompanies this document —
   `sbom/vienna-sbom.json` (all 217 packages with name, version, license, scope, and integrity hash) and
   `sbom/vienna-licenses.csv`, both generated from `package-lock.json`. To attach full license texts, run
   `npm ci` and then `npx license-checker --json` in a networked environment; the identifiers will match
   Part D. See `sbom/README.md`.
5. Confidentiality. This document describes proprietary architecture and should be handled under
   attorney-client privilege.

---

## Part F — Commit and code-location index

| Topic | Commit(s) | Key locations |
|---|---|---|
| PDF hidden-layer extraction | `f486980`; `d365013` and its revert `9f204e1` | `lib/pdf.js`, `lib/pdfFormExtract.js` |
| Deterministic canonical engine | `299abc6`, `f0e9617`, `c1793e6`, `01b991a` | `canonical-fields.js`, `discrepancy-engine.js` |
| Refinance loan-to-value | `a621a20` | `discrepancy-engine.js:437-442`, `:470-495`; `ai.js:859-879`; `webhook.js:1520-1534` |
| Single preliminary review | `e2019d1`; earlier `699029a` | `webhook.js:1625-1646`, `:1642`, `:1653-1664`, `:3844-3868` |
| Numbered-street address pattern | `e2019d1` | `canonical-fields.js:230`, `:206-215` |
| Classification cross-check | `3afdd45` | `deals.js:15-33`, `:99-107`; `ai.js:897-918`; `webhook.js:1535-1548` |
| Completion handoff | `3cbd82b`; earlier `db6471a` | `ai.js:2813-2828`, `:919-931`, `:991-1018`; `webhook.js:1799-1801`, `:1907` |
| Deal de-duplication | `fd469f5`, `d6f3b80` | `webhook.js:564`; `deals.js:149` |
| Broker email clean-up | `90379ad`, `513e0da`, `51839f5`, `e08ca96` | `ai.js:1704`, `:1752`; `lib/greeting.js` |

Dependency identifiers are taken from `package-lock.json` (217 packages; no copyleft).
