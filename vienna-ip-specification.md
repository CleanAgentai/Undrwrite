# UndrWrite / Vienna — Technical Specification

**Private lending underwriting automation system**

Prepared for intellectual-property evaluation
System owner: Private Mortgage Link / Franco Maione
Developed under contract by Porter Stanley / CleanAgent LLC

---

> **Note on scope and audience.** This document is a technical specification of the UndrWrite/Vienna
> system as it currently exists in production. It describes the system's architecture, its designed
> functional behavior, and the specific technical innovations implemented within it. It is written for
> intellectual-property counsel who are technically literate but are not the system's engineers; it
> is intended to support identification of the patentable subset of the system. Code references take
> the form `filename.js:line`. Code excerpts are presented with simplified inline annotations for
> readability; function names and control flow reflect the production implementation.

---

## Contents

- **I. Executive Summary**
- **II. System Architecture**
- **III. Functional Specification**
- **IV. Technical Innovations**
  - IV(a). Canonical Gate-Input Discipline
  - IV(b). Layered Defensive Architecture for State-Incompleteness
  - IV(c). Broker-Prose Canonical Extraction with False-Positive-Guard Discipline
  - IV(d). Thread-Accumulated Canonical State with Field-Level Broker Corrections
  - IV(e). Escalation-Gate Canonical-Incompleteness Guard
  - IV(f). Prelim-Render Incompleteness Guard
  - IV(g). Multi-Event Correction-Intent Routing from Awaiting-State
  - IV(h). Dual-Path Defense-in-Depth Rule Architecture
  - IV(i). Product-Rule Namespace with Independent Revert Paths
- **V. Implementation Details**
- **VI. Domain Rule Implementation (Q1–Q11)**
- **VII. Differentiation from Prior Art**
- **VIII. Appendices**
  - Appendix A. Code excerpts demonstrating the Section IV innovations
  - Appendix B. State machine (textual)
  - Appendix C. Workflow (textual, intake to outbound)
  - Appendix D. Q-rule reference table

---

# I. Executive Summary

## I.1 What the system is

UndrWrite (the product) / Vienna (the underwriting agent within it) is a **private-lending
underwriting backend for the Canadian private mortgage market**. It automates the front portion of a
mortgage broker's interaction with a private lender's underwriting desk. In a private-lending
workflow, a mortgage broker submits a deal — a borrower, a property, a requested loan, and supporting
documents — to the lender by email. A human underwriter (in this deployment, Franco Maione of Private
Mortgage Link) reviews the submission, decides whether it can proceed, escalates or declines those
that cannot, and shepherds the broker through providing the documents and clarifications needed to
make a decision.

Vienna performs the structured, rules-governed portion of that work automatically. It:

1. **Receives** broker email submissions and their attachments through an inbound email gateway.
2. **Extracts** the decision-driving data of a deal — loan amount, property value, existing mortgage
   balances, transaction type, mortgage position, borrower identity — from both the broker's
   free-text email prose and the attached documents (loan applications, mortgage statements,
   appraisals), using a combination of deterministic pattern extraction and AI-assisted
   interpretation.
3. **Evaluates** a set of underwriting decision gates against that extracted data — loan-to-value
   (LTV) computation, threshold tests, transaction-structure tests, borrower-composition tests — to
   determine the disposition of the deal (proceed to review, escalate for more information, or
   decline).
4. **Generates and dispatches** the appropriate email responses — an underwriting-ready preliminary
   summary to the underwriter, a clarification or document request to the broker, an escalation
   notice, or a decline — and persists the deal's state so the conversation can continue across many
   email exchanges.

Vienna is not a chatbot and not a document classifier. It is a **stateful, multi-turn underwriting
decision system** that maintains the evolving state of a deal across an email thread, applies a body
of codified private-lending underwriting rules to that state, and produces the artifacts a human
underwriting desk produces — while reserving the genuinely discretionary human judgments for the
underwriter.

## I.2 Business context

Private mortgage lending sits outside the regulated bank/credit-union channel. Deals reach the lender
through mortgage brokers, by email, in unstructured form — a few paragraphs of prose, a handful of
PDF attachments of varying quality, often with corrections and additions arriving over subsequent
emails. The volume is mid-market: high enough that manual processing of every intake is a
material time cost, low enough that the deals are heterogeneous and resist rigid form-based intake.
The underwriting rules are specific to private lending (e.g., loan-to-value tolerances, payout
treatment of refinances, treatment of corporate and joint borrowers) and reflect the lender's own
risk posture rather than a standardized agency rulebook.

The system's value is in absorbing the repetitive, rules-governed interpretation and correspondence —
reading the deal, computing the underwriting position, asking the broker for what's missing, and
preparing the underwriter's review packet — while routing the genuine judgment calls (and anything
the rules flag as ambiguous or out-of-policy) to the human underwriter with the relevant context
assembled.

## I.3 Technical approach

Three architectural choices distinguish the system:

- **Code-native architecture, not a workflow builder.** The system is implemented as a Node/Express
  application with discrete, composable decision modules — not as a visual workflow graph in a
  no-code/low-code automation tool. Decision logic lives in version-controlled code with explicit
  control flow, which is what makes the defensive layering and the canonical/AI separation (below)
  possible.

- **AI-assisted interpretation with a strict separation between interpretation and decision.** The
  system invokes a large language model (Anthropic's Claude Sonnet) for the tasks language models are
  reliable at — understanding the natural-language context of a broker's email, interpreting document
  content, and generating fluent outbound correspondence. It does **not** allow language-model-derived
  numeric values to be consumed by the gates that decide a deal's disposition. Those gates read only
  **canonical** values produced by deterministic extractors. This separation is a central design
  principle, treated in depth in Section IV.

- **Deterministic decision gates with defensive architectural layering.** The decision logic is
  deterministic and is protected by guards implemented at multiple, independent layers of the
  processing pipeline — gate input, extraction, escalation evaluation, and outbound rendering — each
  of which independently defends against the same failure mode (incomplete or unreliable deal state)
  at its own layer. The asymmetric risk of an underwriting system — that silently proceeding on bad
  data is dangerous, while escalating for clarification is recoverable — is encoded into each layer.

## I.4 Preview of system innovations

Section IV treats the following in depth. They are previewed here so counsel can see the shape of the
technical contribution before the detailed treatment:

- **(a) Canonical Gate-Input Discipline** — decision gates consume only deterministically-resolved
  canonical values; AI-emitted values are excluded from gate inputs even when available and
  semantically correct.
- **(b) Layered Defensive Architecture for State-Incompleteness** — independent defensive guards
  distributed across four pipeline layers, each robust on its own.
- **(c) Broker-Prose Canonical Extraction with False-Positive-Guard Discipline** — deterministic
  extraction of decision fields from realistic broker email prose, with per-pattern false-positive
  guards and a principled rule about which fields may be sourced from prose versus required from
  documents.
- **(d) Thread-Accumulated Canonical State with Field-Level Broker Corrections** — a multi-event
  email thread maintains accumulating canonical deal state, updated field-by-field by subsequent
  events, with continuation by email threading and a state-stability barrier before gate evaluation.
- **(e) Escalation-Gate Canonical-Incompleteness Guard** — a composite "inputs-that-should-compute
  versus state-that-doesn't" guard that escalates rather than silently proceeding.
- **(f) Prelim-Render Incompleteness Guard** — a distinct outbound-layer guard that renders visible
  absence markers rather than silently omitting expected-but-missing fields.
- **(g) Multi-Event Correction-Intent Routing from Awaiting-State** — state-specific reply routing
  that detects correction intent ahead of the default reply handler and composes against the existing
  correction infrastructure.
- **(h) Dual-Path Defense-in-Depth Rule Architecture** — refined rules add a branch and preserve the
  prior branch; both remain active.
- **(i) Product-Rule Namespace with Independent Revert Paths** — each underwriting rule is a discrete
  module with an independent rollback path.

## I.5 System ownership

The UndrWrite/Vienna system is owned in its entirety by Private Mortgage Link / Franco Maione. It was
developed under contract by Porter Stanley / CleanAgent LLC. The underwriting rules encoded in the
system (Section VI) reflect Franco Maione's private-lending underwriting expertise.

---

# II. System Architecture

## II.1 Production stack

| Layer | Technology | Role |
|---|---|---|
| Application runtime | Node.js / Express | HTTP server, webhook reception, decision orchestration |
| Inbound/outbound email | Postmark | Receives broker email as webhook POSTs; sends Vienna's outbound email |
| State persistence | Supabase (PostgreSQL) | Deals, messages, documents, extracted canonical state |
| AI-assisted interpretation | Anthropic Claude Sonnet (API) | Natural-language interpretation of email context, document interpretation, outbound narrative generation |
| Document storage / extraction | Supabase storage + PDF/text extraction | Attachment persistence, text extraction from PDFs and images |
| Deployment | Render | Hosting and continuous deployment of the backend |

The application is a single backend service. Email is the entire external interface: brokers and the
underwriter interact with Vienna only by sending and receiving email. There is no broker-facing UI to
the underwriting engine; the email thread *is* the interface, which is what private-lending brokers
already use.

## II.2 High-level data flow

```
   Broker email (+ attachments)
            │
            ▼
   Postmark inbound webhook  ──────────────►  POST /webhook  (webhook.js)
            │
            ▼
   Email parse: sender, subject, body, In-Reply-To, attachments
            │
            ▼
   Continuation lookup: is this a NEW deal or a reply to an EXISTING deal?
            │  (existing → by In-Reply-To thread correlation)
            ▼
   Attachment processing: persist documents; extract text (PDF text / OCR)
            │
            ▼
   Canonical extraction: deterministic field extraction from email prose + documents
            │  (canonical-fields.js)   +   AI-assisted interpretation (ai.js → Claude)
            ▼
   Gate evaluation: LTV computation, threshold tests, product-rule application
            │  (discrepancy-engine.js + webhook.js gate sites)
            ▼
   Disposition: proceed / escalate / decline / await
            │
            ▼
   Outbound generation: prelim summary, decline, escalation, clarification, admin notice
            │  (ai.js narrative + webhook.js dispatch)
            ▼
   Persist deal state (status, canonical fields, messages)  ──►  Supabase
            │
            ▼
   Send outbound email  ──►  Postmark  ──►  broker and/or underwriter
```

The flow runs to completion on each inbound email. A deal accumulates state across many such runs.

## II.3 Deal state machine

A deal occupies exactly one **status** at a time, persisted in Supabase. The implemented statuses are:

| Status | Meaning |
|---|---|
| `active` | Deal is in normal processing — intake received, gathering documents/clarifications, no blocking gate fired. |
| `under_review` | A preliminary underwriting summary has been dispatched to the underwriter; the deal is in the human-review queue. |
| `awaiting_collateral` | A loan-to-value gate fired (elevated LTV) and the deal is held pending the broker offering additional collateral or the underwriter overriding. |
| `ltv_escalated` | The deal has been escalated to the underwriter for an LTV-related judgment (e.g., the broker declined to add collateral). |
| `awaiting_identity_confirmation` | A borrower-identity ambiguity was detected; the deal is held pending the broker's clarification of borrower identity. |
| `rejected` | The deal was declined (e.g., loan-to-value above the maximum policy threshold, or a property-jurisdiction decline). Terminal. |
| `completed` | The deal reached its terminal in-system end state. Terminal. |

**Representative transitions** (full enumeration in Appendix B):

- New intake → `active` (normal) → `under_review` (when enough is on file to assemble a preliminary
  review) → terminal.
- New intake with elevated LTV → `awaiting_collateral`. From `awaiting_collateral`: broker offers
  collateral → `active`; broker declines / no collateral → `ltv_escalated`; underwriter override →
  `active` (with an audit-trail entry); a broker **correction** that changes the transaction's
  underwriting character → re-evaluated against the corrected state (Section IV(g)).
- New intake with canonical LTV above the maximum policy threshold → `rejected` (with a decline email
  to the broker and an alert to the underwriter).
- New intake with non-Canadian subject property → `rejected` (jurisdiction decline).
- New intake with ambiguous borrower identity → `awaiting_identity_confirmation` → (resolved) →
  `active`.

The state machine is intentionally small and the transitions are explicit; this is what allows
reply-handling to be state-specific (Section IV(g)) and what makes each terminal and holding state a
well-defined point at which the human underwriter, the broker, or a subsequent email can act.

## II.4 Multi-event continuation model

A real private-lending deal is **not** a single email. It is a thread: an initial submission, then
follow-ups — the broker correcting a figure, attaching a missing document, reclassifying the
transaction; the underwriter approving, declining, or overriding. The system models a deal as a
sequence of email **events** against a single persisted deal record.

Continuation — deciding whether an inbound email starts a new deal or continues an existing one — is
performed by **email threading**, using the `In-Reply-To` / `References` headers of the inbound email
to correlate it to the deal whose prior outbound message it replies to. This is a deliberate design
choice over parsing the email body for a deal reference: brokers reply to Vienna's emails using their
normal mail client, which sets the threading headers automatically; they do not quote deal IDs. The
threading-based correlation is what makes the multi-event canonical accumulation and the state-stability
barrier of Section IV(d) possible.

---

# III. Functional Specification

This section describes end-to-end how the system processes a deal. The technical innovations within
these mechanisms are treated in Section IV; this section establishes the functional baseline.

## III.1 Intake processing

Inbound email arrives as a Postmark webhook POST to the application's `/webhook` endpoint
(`webhook.js`). The handler parses the Postmark payload into a normalized internal representation:
sender address and display name, subject, plain-text body, threading headers, and the attachment set.

A sender-classification step distinguishes broker email from the configured underwriter
(administrator) address and from system/automated senders (e.g., mailer-daemon, no-reply), so that
automated bounces and notifications do not enter deal processing as broker input.

The handler then performs **continuation lookup** (II.4): if the inbound email's threading headers
correlate it to an existing deal, the email is processed as a continuation event on that deal;
otherwise a new deal record is created.

## III.2 Document handling

Attachments are persisted to document storage and associated with the deal. For each document the
system extracts text: native text extraction for text-bearing PDFs, and optical character recognition
(OCR) for image attachments and scanned documents.

Documents are **classified** by type — loan application, mortgage statement, appraisal, proof of
income / notice of assessment (NOA), and others — so that downstream extraction and gating can treat
them according to their authority. For example, a property value or an existing-mortgage balance read
from a mortgage statement is authoritative in a way that a value asserted in a broker's prose is not
(Section IV(c)).

Structured field extraction runs against the document text using document-type-specific anchors —
e.g., a mortgage statement's "Outstanding Principal Balance" and "Property Address" blocks, a loan
application's requested-amount and term fields (`canonical-fields.js`, the
`extractFromMortgageStatement` and `extractFromLoanApplication` extractors).

## III.3 Canonical extraction system

The **canonical extraction system** (`canonical-fields.js`) produces the deterministic, decision-driving
representation of a deal — the **canonical map**. The canonical map holds the fields that gates
consume: `requested_loan_amount`, `subject_property_market_value` / `property_value`,
`existing_first_mortgage_balance`, `transaction_type`, `mortgage_position`, `borrower_name`,
`subject_property_address` / postal code, and the existing-mortgage lender.

Canonical extraction draws from two sources, in a defined authority order per field:

- **Broker email prose** — the free text of the broker's email (Section IV(c) details the pattern
  coverage and the false-positive guards).
- **Attached documents** — the classified, text-extracted documents (III.2).

Each extracted value carries a **source classification** indicating its provenance (broker initial
intent, broker correction, document, or derived). The authority order differs by field type: for
intent fields (loan amount, purpose), a broker correction outranks an initial broker statement, which
outranks documents; for objective fields, documents outrank prose. A broker **correction** outranks
all other sources for the field it corrects (the broker has authority to correct the record). This
source-ranked resolution is implemented in `resolveCanonicalIntentValue` (`canonical-fields.js:1971`)
and the related per-field resolvers.

## III.4 LLM-assisted interpretation

The system invokes Claude Sonnet (`ai.js`, Anthropic API) for three categories of task:

1. **Natural-language understanding of the broker's email context** — interpreting the broker's
   intent and the surrounding narrative of a submission where deterministic patterns are insufficient
   or where the context (e.g., the relationship between two named parties, the meaning of a free-form
   note) is genuinely linguistic.
2. **Document interpretation** — assistance interpreting document content beyond the anchored
   deterministic extraction.
3. **Outbound narrative generation** — composing the prose of Vienna's outbound emails: the
   preliminary review summary, decline letters, clarification requests, and document asks, in a
   consistent professional voice.

The architecturally critical point is the **boundary**: language-model output is used for
interpretation and for narrative, but the **decision gates do not consume language-model-derived
numeric values**. A gate that determines whether a deal proceeds, escalates, or declines reads the
canonical map (III.3), not the model's emitted figures — even when the model has emitted a
semantically equivalent value. This separation is innovation IV(a).

## III.5 Gate evaluation

With the canonical map assembled, the system evaluates its decision gates (`discrepancy-engine.js`
plus the gate sites in `webhook.js`):

- **LTV computation** — both **standalone** LTV (requested loan ÷ property value) and **combined**
  LTV (the additive position of the new loan over existing encumbrances ÷ property value), each
  computed from canonical values (`computeStandaloneLtv` at `discrepancy-engine.js:440`,
  `computeCombinedLtv` at `discrepancy-engine.js:319`).
- **Threshold tests** — the elevated-LTV escalation test (`shouldEscalateOnAnyLtv` at
  `discrepancy-engine.js:471`) and the maximum-LTV auto-decline test (`shouldAutoDeclineOver90` at
  `discrepancy-engine.js:526`).
- **Product-rule application** — the codified private-lending rules (Section VI), e.g., the
  refinance/payout carve-out that determines whether an existing first mortgage is treated as paid
  out (and therefore excluded from the combined position) or additive.
- **Decision routing** — based on the gate outcomes, the deal is routed to proceed (toward
  `under_review`), escalate (`awaiting_collateral` / `ltv_escalated`), or decline (`rejected`).

## III.6 Outbound generation

The system generates and dispatches the appropriate outbound artifact(s):

- **Preliminary review ("prelim") email to the underwriter** — an underwriting-ready summary of the
  deal: the canonical figures, the computed LTV position, the borrower and property, the document
  state (including explicit markers for expected-but-missing items, Section IV(f)), and any rule
  flags (corporate borrower, joint applicants). This is the packet the human underwriter reviews.
- **Decline email to the broker** — for an above-maximum-LTV deal or a jurisdiction decline, a polite
  decline stating the basis, accompanied by an alert to the underwriter.
- **Escalation / clarification emails** — when a gate fires and requires broker input (e.g., the
  elevated-LTV collateral question) or when the system needs the broker to resolve an ambiguity
  (identity, role).
- **Admin notifications** — out-of-band notices to the underwriter for material changes after a
  prelim has been sent (Section VI, Q10), and surfacing of joint-applicant and corporate-borrower
  conditions.

Outbound prose is generated with Claude Sonnet; the **figures and structured content** in the
outbound are driven by the canonical map, not re-derived by the model.

## III.7 Multi-event handling

Subsequent events on a deal are handled according to the deal's current status and the nature of the
event:

- **Broker corrections** — a correction to the transaction type ("this is actually a refinance"), a
  numeric correction ("the correct amount is $X"), a mortgage-position correction, or a lender
  correction is parsed (`parseBrokerCorrections` at `canonical-fields.js:990`) and merged field-by-field
  into the canonical map, after which gates re-evaluate (Section IV(d)).
- **Underwriter (admin) overrides** — an email from the configured underwriter address can release a
  held `awaiting_collateral` deal back to active processing, with an audit-trail entry (Section VI,
  Q9).
- **Document resubmissions** — additional documents are persisted, classified, and folded into the
  canonical map; if a deal that was held for documents now has what it needs, it advances.
- **Awaiting-state continuation routing** — a reply to a deal in a holding state (e.g.,
  `awaiting_collateral`) is routed according to its intent: a collateral answer is processed as such,
  while a correction is detected ahead of collateral processing and routed to correction handling
  (Section IV(g)).

---

# IV. Technical Innovations

This is the core of the document. Each innovation is presented with (1) the problem it addresses,
(2) the specific implementation with code references, (3) why naive approaches fail (non-obviousness),
and (4) the design rationale.

---

## IV(a). Canonical Gate-Input Discipline

### Problem statement

An AI-assisted underwriting system has, at decision time, two potential sources for a decision-driving
number such as the loan-to-value ratio: a value computed deterministically from extracted canonical
fields, and a value emitted by the language model as part of its interpretation of the deal. The
language model's value is frequently *available* and frequently *correct*. The naive and tempting
design is to consume whichever value is present. The problem is that a language model's numeric output
is **variable** — it can compute a refinance's LTV additively in one phrasing and standalone in
another; it can round, infer, or be led by the broker's own stated figure — and an underwriting
decision is **intolerant of that variance**. A deal that should escalate must escalate every time, not
most of the time.

### Specific implementation

The system enforces an architectural rule: **gates that determine deal disposition read only
deterministically-resolved canonical values.** The LTV gates do not read the model's emitted
`ltv_percent`; they compute LTV from the canonical map.

In the initial-submission gate block (`webhook.js`, ~`3290`–`3340`), the standalone and combined LTV
the gates consume are computed from the canonical map, with the language-model value used **only** as
a last-resort fallback when the canonical map cannot compute at all:

```js
// Standalone LTV the gates consume is the CANONICAL value (loan ÷ value from the
// canonical map), not the model-emitted ltv_percent. The model value is used only
// as a fallback when the canonical map lacks the loan/value tuples to compute.
const standaloneLtv = computeStandaloneLtv(canonicalMap) ?? modelLtvPercent;
const combinedLtv   = computeCombinedLtv(canonicalMap)?.combined_ltv_percent ?? null;

const shouldEscalate = shouldEscalateOnAnyLtv({ standaloneLtv, combinedLtv });
const autoDecline    = shouldAutoDeclineOver90({ standaloneLtv, combinedLtv,
                                                 combinedResolved: isCombinedLtvResolved(canonicalMap) });
```

`computeStandaloneLtv` (`discrepancy-engine.js:440`) and `computeCombinedLtv`
(`discrepancy-engine.js:319`) derive LTV purely from the canonical loan/value/existing-balance tuples.
The same discipline is applied at the active-branch re-evaluation gate
(`webhook.js`, ~`4170`–`4190`), where the re-evaluation again computes canonical standalone LTV rather
than reading the model field.

### Non-obviousness

The naive system consumes whatever value is available; because a language model reliably emits a
plausible LTV, that value is *there* and is *usually right*, so consuming it is consistent with
intuition and produces correct results in most production cases. The innovation is the **architectural refusal** to consume it
for gate input — the deliberate choice to ignore an available, usually-correct value in favor of a
deterministically-recomputed one. This is non-obvious precisely because the refused value is good
enough to pass casual scrutiny; the design recognizes that "good enough most of the time" is the wrong
standard for a decision input, and pays the cost (canonical extraction must be comprehensive enough to
compute the value itself) to get determinism.

A concrete failure of the naive approach: for a refinance where the existing first mortgage is paid
out, the correct standalone LTV is (new loan ÷ value). A language model, seeing the existing balance
in the deal, may emit an *additive* LTV (existing + new, over value) — a much higher number that would
wrongly trip an escalation or decline gate. The canonical computation applies the refinance/payout
carve-out (Section VI, Q1) deterministically and produces the correct standalone figure. Consuming the
model's additive number would mis-decide the deal; consuming the canonical number decides it
correctly, every time.

### Design rationale

Language-model variance is **acceptable in narrative output** (two equally-correct phrasings of a
clarification email are both fine) and **intolerable in decision inputs** (two different LTVs for the
same deal are not both fine). The architecture draws the line exactly there: the model is used
wherever its variance is harmless and excluded wherever its variance is dangerous. The canonical map
is the single source of truth for everything a gate reads.

---

## IV(b). Layered Defensive Architecture for State-Incompleteness

### Problem statement

The dominant failure mode of an automated underwriting system is acting on **incomplete state** — a
deal whose canonical representation is missing a value that a correct decision requires. Incomplete
state arises naturally: a document hasn't arrived yet, a figure is phrased in a way an extractor
missed, a correction is mid-flight. A single guard — typically at the input boundary — is the naive
defense, and it is insufficient, because incompleteness can be introduced or can matter at several
different points in the pipeline, and a boundary check cannot see all of them.

### Specific implementation

The system implements defensive guards at **four independent layers** of the processing pipeline, each
addressing state-incompleteness at its own layer and each correct on its own:

1. **Gate-input layer** — gates consume canonical, not model-derived, values (IV(a)). This defends
   against *unreliable* state reaching a decision.
2. **Extraction layer** — the canonical extractors apply a principled rule about which fields may be
   sourced from broker prose versus must come from documents (IV(c)), and apply per-pattern
   false-positive guards. This defends against *wrongly-confident* state being created.
3. **Escalation-evaluation layer** — a composite guard escalates when a deal *has the inputs that
   should compute a gate* but the canonical state *comes back incomplete*, rather than falling through
   to a permissive default (IV(e)). This defends against *silently-incomplete* state being treated as
   a decision to proceed.
4. **Outbound-rendering layer** — a distinct guard renders visible "to-be-determined" markers for
   expected-but-missing fields rather than silently omitting them (IV(f)). This defends against
   incomplete state being *invisible to the human reviewer*.

The layers are implemented in different modules and at different points: `discrepancy-engine.js`
(gate-input computations and the escalation-incompleteness guard), `canonical-fields.js` (extraction
discipline), and the `webhook.js` render paths (outbound incompleteness markers).

### Layer independence

Each layer functions correctly without relying on the others. The extraction discipline (layer 2)
produces a correct canonical map whether or not the escalation guard (layer 3) exists; the escalation
guard escalates an incomplete deal whether or not the render guard (layer 4) would have surfaced it;
the render guard surfaces a gap whether or not the gate-input discipline (layer 1) excluded a model
value. The result is **composite robustness through redundancy**: for the system to act on dangerous
incomplete state, multiple independent layers would all have to fail to catch it.

### Non-obviousness

Typical systems implement a single-layer defense, usually a null-check or a validation step at the
input boundary. Distributing **independent** defenses across four pipeline layers — input, extraction,
escalation, and rendering — such that each is individually sufficient against the failure mode at its
layer, is an architectural pattern, not a single feature. It is non-obvious because each layer's guard
looks redundant given the others ("if the escalation guard catches incomplete state, why also mark it
in the render?"), and the redundancy is precisely the point: the layers catch *different instances* of
the same failure mode that arise at different points, and the redundancy is what makes the composite
robust.

### Design rationale

Underwriting carries an **asymmetric risk**: the cost of silently proceeding on bad/incomplete data
(an implicit approval that should not have happened) greatly exceeds the cost of escalating for
clarification (a recoverable round-trip with the broker). The architecture spends redundancy to push
the system, at every layer, toward the recoverable direction. The same asymmetric-risk principle
recurs in IV(e) and IV(f) as the explicit rationale for those specific guards.

---

## IV(c). Broker-Prose Canonical Extraction with False-Positive-Guard Discipline

### Problem statement

The decision-driving figures of a deal are often stated only in the broker's free-text email, in
**realistic, irregular phrasing** — not in a structured form. A broker writes "Loan $450k", "New 2nd
mortgage request: $120,000", "Private 2nd request: $425,000", "appraised $850k", "$185k behind the
existing first", "refi at 83% LTV". To compute gates deterministically (IV(a)), the system must
extract these figures from prose **reliably** (high coverage of real phrasings) and **safely** (no
false matches that would inject a wrong figure into a decision). These two goals are in tension: broad
patterns over-match; narrow patterns under-cover.

### Specific implementation

Deterministic extraction in `canonical-fields.js` covers a graduated set of phrasings per field. For
the requested loan amount, the pattern set (`loanPatterns`, `canonical-fields.js:506`) includes, in
priority order:

- **Formal labels** — "Loan Amount Requested: $X", "Mortgage Amount Requested: $X", "Requested Loan: $X".
- **Informal prose** — "requesting $X".
- **Nth-mortgage request labels** — "New 2nd mortgage request: $X", "first mortgage request: $X".
- **Bare-label shorthand** — "Loan $X", "Loan: $X" (with a `$` anchor, excluding "Loan application").
- **Word-order variants** — "$X loan", "$X requested", "$X for <financing purpose>".
- **Position-relative phrasing** — "$X behind the existing 1st" (a second-mortgage's new amount).
- **Private-lender Nth-mortgage labels** — "Private 2nd request: $X", "Private 2nd: $X".

A magnitude-suffix normalizer handles "$850k", "$1.2m", "$1.2MM", and spelled-out "thousand"/"million"
across all patterns, multiplying to the canonical integer with a sanity bound. Property value is
extracted from "Appraised Value: $X", "Appraised at $X", and bare "appraised $X" prose; mortgage
position is extracted from subject-line and body phrasings including both spelled-out ("second
mortgage") and numeric-ordinal ("2nd mortgage") forms.

**False-positive guards** are attached per pattern. Examples:

- Every shorthand pattern requires a `$` anchor adjacent to its cue, so non-monetary prose ("requesting
  more information", "the loan officer", "loan application") cannot match.
- The position-relative loan pattern requires "behind <existing | first | 1st>", which admits "$185k
  behind the existing first" (a new second mortgage's amount) while excluding "$X behind on payments"
  (a delinquency reference).
- The numeric-ordinal position extractor skips occurrences that are **references to an existing
  mortgage** ("behind the existing 1st mortgage") rather than the deal's own position, taking the
  first non-reference ordinal-mortgage occurrence:

```js
// Numeric-ordinal position prose ("2nd mortgage"), fired only when the spelled-out
// form did not match. FP guard: skip occurrences that REFERENCE an existing mortgage
// ("behind the existing 1st mortgage") rather than the deal's own position; take the
// first non-reference ordinal-mortgage occurrence.
const m = [...emailBody.matchAll(/\b(behind\s+(?:the\s+)?(?:existing\s+)?|(?:the\s+)?existing\s+)?(1st|2nd|3rd)\s+mortgage\b/gi)]
            .find(x => !x[1]);   // x[1] is the "behind/existing" reference prefix; absent ⇒ own position
```

- The private-lender loan label requires the qualifier "private" + an ordinal + a `$` anchor, so a
  generic "private information request: $X" (no ordinal) cannot match.

### Architectural conservatism on field provenance

A specific and deliberate part of this innovation is the rule about **which fields may be sourced from
broker prose at all** for decision purposes. The `existing_first_mortgage_balance` and the subject
property value, when used for a decision-driving gate, are **document-sourced only by design** — the
system does **not** extract an existing-mortgage balance from broker prose for the purpose of a
combined-LTV auto-decline, even when the broker states it ("Existing 1st: $380k"). A broker's stated
existing balance is acceptable as **narrative context** but is **not trusted** as the basis for an
adverse, decision-driving computation (an auto-decline). The combined-LTV decline therefore **defers**
to a document-verified existing balance; absent the document, the deal escalates or is handled by the
narrative/safety layer rather than auto-declined on an unverified broker-stated figure. This is
documented at the extraction sites (`canonical-fields.js`, the loan-application and conservatism notes
around `:1513` and `:1726`).

### Non-obviousness

Three things compose here that are individually non-trivial and jointly novel:

1. **Comprehensive realistic-phrasing coverage** — the graduated pattern set captures the way brokers
   actually write, not a single canonical form.
2. **Per-pattern false-positive guards** — each broadening is paired with a specific guard that
   prevents the broadening from over-matching, so coverage grows without injecting wrong figures.
3. **Principled field-provenance conservatism** — the rule that *some* fields may be read from prose
   while *others* must come from documents, keyed to whether a prose-sourced value is safe to drive an
   adverse decision.

A naive regex approach achieves one of these at the expense of the others — it over-fits (broad
patterns, false matches), or under-covers (narrow patterns, missed figures), or treats all fields
uniformly (trusting broker-prose balances for declines). The discipline of *which* fields to extract
from prose versus require from documents — and *why* (the safety of driving an adverse decision from
an unverified value) — is itself an architectural decision, not a mechanical extraction detail.

### Design rationale

Extraction exists to feed the canonical map that gates consume (IV(a)); its job is therefore to be
both broad and safe. The false-positive guards are the safety mechanism that lets coverage expand
without compromising determinism. The provenance conservatism encodes the same asymmetric-risk
principle as IV(b): an unverified broker-stated figure is fine for *context* but must not be the basis
for *declining* a borrower — that decision waits for a document.

---

## IV(d). Thread-Accumulated Canonical State with Field-Level Broker Corrections

### Problem statement

A private-lending deal evolves over an email thread: the broker corrects a figure, reclassifies the
transaction, names the existing lender, attaches a document — across several emails. A naive system
either treats each email independently (losing the accumulated context of the deal) or re-derives the
whole deal from the latest email (losing everything not restated in it). Neither is acceptable: a
broker's correction email ("this is actually a refinance") does not restate the property value or the
loan amount, but those remain true. The system must **accumulate** deal state across events and let a
later event **update specific fields** without discarding the rest.

### Specific implementation

Three mechanisms compose:

1. **Continuation by email threading.** Whether an inbound email continues an existing deal is
   determined by the `In-Reply-To` / `References` threading headers correlating it to the deal whose
   prior outbound it replies to — not by parsing the body for a deal reference (II.4, III.1). This is
   robust to how brokers actually reply (normal mail-client threading, no quoted IDs).

2. **Field-level canonical accumulation.** The canonical map persists across events. A subsequent
   event's extraction is merged into the accumulated map **per field**, under the source-authority
   order (III.3): a broker correction to `transaction_type` updates that field while `requested_loan_amount`,
   `property_value`, and the rest of the established context remain. Corrections are parsed
   deterministically by `parseBrokerCorrections` (`canonical-fields.js:990`), which classifies a
   reply's correction intent across loan amount, purpose, mortgage position, and transaction type, and
   returns the corrected fields with a `broker_correction` source classification (which outranks
   prior sources for that field):

```js
// parseBrokerCorrections returns, per corrected field, a tuple tagged broker_correction.
// transaction_type corrections include the assertion forms a broker actually uses, e.g.
//   "this is a refinance" / "this is actually a refinance, not a purchase"
// guarded against hedged ("I think ...") and interrogative ("is this ...?") phrasings.
const corrections = parseBrokerCorrections(replyBody);
// → e.g. [{ field: 'transaction_type', value: 'refinance', source: 'broker_correction' }]
```

3. **Inter-event state-stability barrier.** Between events, the system waits for the deal's outbound
   state to **stabilize** before treating the deal as settled for the next gate evaluation — i.e., it
   does not evaluate a deal's gates against a half-applied event. This ensures a decision runs against
   a settled canonical state rather than a transient mid-update one.

### Non-obviousness

The combination is the novelty. Email-based workflow systems commonly thread replies; document systems
commonly merge fields; but the specific composition of **(i) thread-header continuation**, **(ii)
field-level accumulation into a persisted canonical decision-state under a source-authority order**,
and **(iii) a state-stability barrier before gate evaluation** — applied to an underwriting deal that
must hold a consistent decision-state across an arbitrary number of broker corrections and document
additions — is a specific architectural pattern not present in standard email-automation or
form-processing systems. A naive "re-derive from latest email" loses context; a naive "treat each
email independently" never accumulates; a naive "merge but evaluate immediately" can decide against a
half-applied state.

### Design rationale

The deal, not the email, is the unit of decision. The canonical map is the deal's decision-state, and
it must remain **consistent and complete** across the whole thread while remaining **correctable** at
the field level by any later event. The threading-based continuation makes the deal identifiable
without burdening the broker; the field-level merge makes corrections cheap and non-destructive; the
stability barrier makes decisions reproducible against settled state. This innovation is the
foundation that IV(g) (correction-intent routing from a holding state) composes against.

---

## IV(e). Escalation-Gate Canonical-Incompleteness Guard

### Problem statement

There is a dangerous class of deal state: one where the deal **has the inputs that should compute a
decision-driving gate**, yet the canonical computation **comes back incomplete**. Concretely: a deal
has a mortgage-statement document on file and a present loan amount — the ingredients for a combined-LTV
computation — but the combined LTV comes back null (e.g., a value didn't resolve, a transient
extraction gap). A naive system treats "no gate fired" as "proceed", and the deal silently advances to
an active/approval-track state on **incomplete underwriting information** — an implicit approval that
should not have happened. A single-field null-check does not catch this, because no single field is
obviously wrong; the danger is in the *combination* (inputs present, result absent).

### Specific implementation

A **composite** guard at the escalation-decision layer, `shouldEscalateOnIncompleteCanonical`
(`discrepancy-engine.js:500`):

```js
const shouldEscalateOnIncompleteCanonical = ({
  hasMortgageStatement = false,   // an existing-mortgage document is on file
  combinedLtv = null,             // ... yet the combined-LTV came back null
  payoutConfirmed = false,        // ... and the null is NOT the legitimate payout carve-out
  hasLoanAmount = false,          // ... and a loan amount IS present
} = {}) =>
  !!(hasMortgageStatement && combinedLtv == null && !payoutConfirmed && hasLoanAmount);
```

The guard fires when **all** of: an existing-mortgage document is on file, a loan amount is present,
the combined LTV is null, and that null is **not** the legitimate result of the refinance/payout
carve-out (Section VI, Q1) — i.e., the deal *should* have computed a combined position but didn't. At
the initial-submission gate (`webhook.js:3327`, `:3368`), this guard is composed as an **OR** with the
normal elevated-LTV escalation: either condition routes the deal to `awaiting_collateral` for
clarification rather than letting it fall through to active.

### Non-obviousness

The naive defenses both fail here. **Failing silently** (no gate fired → proceed) is the dangerous
default the guard exists to prevent. A **single-field null-check** ("if combined LTV is null, ...")
over-fires — combined LTV is *legitimately* null for a clean first-mortgage deal with no existing
encumbrance, and for a refinance whose carve-out correctly collapsed the combined position to the
standalone. The innovation is the **composite condition** that distinguishes a *dangerous* null
(inputs present, result missing, not a carve-out) from a *benign* null (no existing encumbrance, or a
legitimate carve-out). That distinction — "inputs-that-should-compute versus state-that-doesn't,
excluding the legitimate reasons the state is empty" — is the non-obvious part; it requires modeling
*why* the canonical state is incomplete, not merely *that* it is.

### Design rationale

Same asymmetric-risk principle as IV(b): an implicit approval on incomplete underwriting information is
the unacceptable failure; a clarification round-trip is the recoverable one. The guard is positioned at
the escalation-decision layer specifically so that it governs the proceed-versus-escalate fork, and it
is composed as an OR with the ordinary LTV escalation so that a deal escalates if *either* the LTV is
elevated *or* the canonical state is dangerously incomplete.

---

## IV(f). Prelim-Render Incompleteness Guard

### Problem statement

A distinct manifestation of the incomplete-state problem occurs at the **outbound rendering** layer,
when the system assembles the preliminary review packet for the human underwriter. If a field that
*should* be present (because the deal has the document that should supply it) is missing, the naive
behavior is to **silently omit** it from the rendered summary. Silent omission is dangerous in a
different way than a silent gate fall-through: the underwriter, reading the packet, may not notice that
a material field is absent — the absence is invisible. The underwriter could review and act on a packet
that looks complete but isn't.

### Specific implementation

A guard at the outbound rendering path renders an explicit, visible **"TBD"** (to-be-determined)
marker for fields that are expected-extractable-but-null, rather than omitting the row. For example,
the preliminary summary's "Existing 1st Mortgage Balance" row renders deterministically as
`Existing 1st Mortgage Balance: TBD` when the deal's profile indicates the field should resolve but the
canonical value is absent — so the gap is *on the page*, in front of the underwriter, rather than
silently missing. The guard lives at the render path (`webhook.js` prelim-assembly), distinct from the
escalation guard of IV(e).

### Non-obviousness

This is a defensive guard at a **different architectural layer** than the decision gates — the
output-rendering layer rather than the decision-evaluation layer — addressing the same underlying
incomplete-state risk but a different *consequence* of it (invisibility to the reviewer rather than an
implicit machine approval). Most systems render whatever values are present and omit the rest; the
notion that **absence is information that must be rendered** — that a missing-but-expected field should
be surfaced as a visible marker so a human notices it — is architecturally distinct from ordinary
templating. The pairing of IV(e) (escalate on dangerous incompleteness) and IV(f) (surface
incompleteness to the human even when the deal does render) is the layered-defense pattern of IV(b)
made concrete: two independent guards, at two layers, for two consequences of one failure mode.

### Design rationale

Asymmetric risk again, applied to human review: a silently-omitted field risks the underwriter acting
on incomplete information without knowing it; a visible "TBD" costs a moment of attention and prevents
that. The render guard ensures that even when a deal legitimately reaches the human's desk, the human
sees exactly what is and isn't established.

---

## IV(g). Multi-Event Correction-Intent Routing from Awaiting-State

### Problem statement

When a deal is in a **holding state** — specifically `awaiting_collateral`, where an elevated-LTV gate
has fired and the system is waiting for the broker to offer additional collateral — the natural,
default interpretation of a broker reply is "this is the broker's answer about collateral." But a
broker reply to a held deal is not always a collateral answer. The broker may instead send a
**correction** that changes the underwriting character of the deal — "this is actually a refinance,
not a purchase," with the existing lender named. A naive holding-state handler funnels **every** reply
through collateral-answer interpretation, which **mis-classifies the correction and loses it**: the
correction is read as a yes/no/ambiguous collateral response, the transaction reclassification never
takes effect, and the deal stays stuck asking for collateral on a transaction that has been reframed.

### Specific implementation

A **correction-intent pre-check** at the holding-state reply handler
(`webhook.js:3545`, the `awaiting_collateral` broker-reply branch). Before the default collateral-answer
interpretation runs, the handler tests the reply for correction intent by **reusing the existing
correction classifier** (`parseBrokerCorrections`, the same `canonical-fields.js:990` parser used for
corrections in the active flow — composed, not duplicated). If a correction is detected, the reply is
routed to correction processing (the thread-accumulated canonical update of IV(d)), and the gate
**re-evaluates** against the corrected canonical state. If no correction is detected, the reply falls
through to the default collateral-answer interpretation, unchanged:

```js
if (deal.status === 'awaiting_collateral') {
  // Correction-intent pre-check, BEFORE the default collateral-answer interpretation.
  // Reuses the existing correction classifier (composed, not duplicated).
  const corrections = parseBrokerCorrections(replyBody);
  if (corrections.length > 0) {
    // Route to the active branch's correction processing (field-level canonical
    // update via the source-authority order), then the LTV/escalation gate
    // re-evaluates against the corrected state. The deal exits the hold only if
    // the correction genuinely resolves the gate that held it.
    deal.status = 'active';     // in-memory route to correction processing
  } else {
    // No correction intent → default collateral-answer interpretation, unchanged.
    ...parseCollateralReply(replyBody)...
  }
}
```

Crucially, the routing **composes against existing infrastructure**: it does not introduce a parallel
correction-handling code path for the holding state. It reuses (i) the same correction classifier and
(ii) the same field-level canonical-correction application and gate re-evaluation that the active flow
uses — entering that infrastructure at a new point (the holding-state reply handler). After the
correction is applied, the elevated-LTV/escalation gate re-evaluates; the deal exits the hold only if
the corrected state genuinely resolves the condition that caused the hold, and the
canonical-incompleteness guard (IV(e)) still governs the case where the corrected state remains
incomplete.

### Non-obviousness

Two non-obvious elements compose:

1. **State-specific reply routing with intent detection ahead of the default handler.** The holding
   state has a default reply interpretation (collateral answer); the innovation inserts a
   **correction-intent detector before** that default, so that the same physical reply is routed
   differently depending on its *intent* rather than uniformly by the deal's *state*. A naive handler
   routes by state alone (held → collateral interpretation) and loses any reply whose intent differs
   from the state's expectation.

2. **Composition against existing handlers rather than per-state duplication.** The naive way to add
   correction handling to a new state is to duplicate the correction logic into that state's handler.
   The innovation reuses the existing correction classifier and the existing field-level
   canonical-correction + gate-re-evaluation infrastructure, entering it from the holding state. This
   is what keeps a single correction-handling implementation authoritative across all the states from
   which a correction can arrive.

### Design rationale

A correction is a correction regardless of what state the deal is in when it arrives; the deal's
holding state should not cause the system to mis-read the broker's intent. Detecting correction intent
ahead of the state-default handler, and routing it into the one existing correction pipeline, keeps the
system's interpretation of the broker faithful to the broker's intent and keeps the correction-handling
logic singular and consistent across entry points.

---

## IV(h). Dual-Path Defense-in-Depth Rule Architecture

### Problem statement

A codified underwriting rule may be **refined** over time as the lender sharpens its policy. The naive
way to refine a rule is to **replace** its condition. Replacement is risky in an underwriting system:
the prior, established behavior is discarded in favor of the new condition, and if the new condition has
an unforeseen gap, the deals the old condition correctly handled may now slip through. The system needs
rules to be able to **evolve** without **losing** the prior established behavior.

### Specific implementation

Refined rules **add a branch and preserve the prior branch**; both branches remain active, and either
firing triggers the rule's effect. The canonical example is the refinance/payout carve-out (Section VI,
Q1) in `computeCombinedLtv` (`discrepancy-engine.js:319`):

```js
// Branch 1 (original, preserved): explicit payout language + lender match → carve-out.
if (refinanceTuple && refinanceTuple.payoutConfirmed === true && refinanceLenderMatches) {
  return carveOutStandalone('refinance-paid-out');
}
// Branch 2 (refinement, added): a CONFIDENT refinance + lender match → carve-out fires
// WITHOUT requiring explicit payout language (refinance and payout are definitionally
// equivalent in private lending). The original branch above is NOT removed.
if (refinanceTuple && refinanceTuple.refinanceConfident === true && refinanceLenderMatches) {
  return carveOutStandalone('refinance-implicit-payout');
}
```

The original branch (explicit payout language) is preserved as written; the refinement (confident
refinance, no explicit payout language required) is **added** as a second branch. Either branch firing
produces the carve-out. The two branches are independently identifiable (they tag their result with a
distinct source, `refinance-paid-out` vs `refinance-implicit-payout`), which means the refinement can
be rolled back to the original behavior by removing only the added branch.

### Non-obviousness

Rule **replacement** is the obvious and common pattern. Rule **refinement-by-branch-preservation** —
where a sharpened rule *adds* a path and *keeps* the original path as defense-in-depth, both active —
is architecturally distinct. It is non-obvious because the redundancy is intentional (if the new condition
subsumes the old, why keep the old?) and the value is exactly in the non-subsumption case: the
preserved branch continues to catch the deals it always caught, so a gap in the refinement cannot
silently un-handle them. It also yields a clean, per-branch rollback that a replacement does not.

### Design rationale

In an underwriting system the cost of a regression in an established rule is high. Preserving the prior
branch makes a refinement **strictly additive** to the rule's firing set in the common case and
**recoverable** per-branch in all cases. It supports compositional rule evolution (refine by adding)
and independent rule rollback (remove the added branch) simultaneously.

---

## IV(i). Product-Rule Namespace with Independent Revert Paths

### Problem statement

A body of underwriting rules implemented as a **monolithic decision tree** is brittle: the rules are
entangled, a change to one risks others, and there is no clean way to roll a single rule back to its
prior behavior. The system needs each rule to be a discrete, independently-revertible unit.

### Specific implementation

Each codified underwriting rule (Section VI, Q1–Q11) is implemented as a **discrete, modular unit** —
a dedicated function or module composed into the decision flow, rather than a branch buried in a single
large decision tree. Supporting modules include `corporate-entities.js` (corporate-borrower detection,
Q5), `borrower-qualification.js` (joint-borrower aggregation and role classification, Q3/Q4),
`registered-owner.js` (registered-property-owner classification, Q11), with the LTV and carve-out
logic in `discrepancy-engine.js` and the routing/notification rules at composition sites in
`webhook.js`. Because each rule is a discrete unit (and, where refined, structured per IV(h) with
independently-identifiable branches), each rule has an **independent revert path**: its
prior behavior can be restored without disturbing the other rules.

### Non-obviousness

The modular, independently-revertible decomposition of a codified rule body is distinct from the
monolithic decision-tree pattern common in rule engines. It is what makes the rule body **maintainable
and evolvable** under a real lender's changing policy: rules can be added, refined (IV(h)), or rolled
back individually. The combination with IV(h) — modular rules, each refinable by branch-addition and
revertible by branch-removal — is the architectural property.

### Design rationale

A lender's underwriting policy is not static; rules are added and sharpened as the business learns. The
namespace + modular decomposition makes that evolution safe: changes are local, refinements are
additive, and rollbacks are surgical.

---

# V. Implementation Details

## V.1 Component overview (file-by-file)

| Module | Responsibility |
|---|---|
| `src/routes/webhook.js` | The orchestration core. Inbound webhook reception and email parse; sender classification; continuation lookup by threading; new-deal vs existing-deal routing; document persistence; the gate-evaluation sites (initial-submission gate block, active-branch re-evaluation gate); the state-specific reply handlers (active, under_review/ltv_escalated, awaiting_collateral, awaiting_identity_confirmation) including the correction-intent pre-check (IV(g)) and the underwriter-override path; outbound coordination and dispatch; the preliminary-review render path including the incompleteness markers (IV(f)). |
| `src/services/discrepancy-engine.js` | LTV computation (`computeStandaloneLtv`, `computeCombinedLtv`); the refinance/payout carve-out (Q1, IV(h)); the elevated-LTV escalation test (`shouldEscalateOnAnyLtv`); the maximum-LTV auto-decline test (`shouldAutoDeclineOver90`); the canonical-incompleteness escalation guard (`shouldEscalateOnIncompleteCanonical`, IV(e)); combined-LTV resolution status (`isCombinedLtvResolved`); LTV-band computation. |
| `src/services/canonical-fields.js` | Deterministic canonical extraction from broker prose and documents (IV(c)); the loan/value/position/balance/lender patterns with false-positive guards; magnitude-suffix normalization; document-type extractors (mortgage statement, loan application); the broker-correction classifier (`parseBrokerCorrections`, IV(d)/IV(g)); the source-authority resolvers (`resolveCanonicalIntentValue`). |
| `src/services/corporate-entities.js` | Corporate-borrower detection (Q5): entity-suffix and entity-name recognition, multi-entity linkage heuristics. |
| `src/services/borrower-qualification.js` | Joint-borrower roster and aggregation (Q3) and role classification (Q4): the role enumeration (primary / co-applicant / guarantor-only) and the conservative ambiguous-cosigner default. |
| `src/services/registered-owner.js` | Registered-property-owner classification (Q11): owner-signal detection, owner-name attribution, sole-owner detection. |
| `src/services/ai.js` | The Claude Sonnet interface: broker-context interpretation, document interpretation, and outbound narrative generation (prelim, decline, clarification, document-ask), plus the deterministic-input reply parsers (e.g., collateral-answer interpretation). |
| Email / persistence services | Postmark send/receive integration; Supabase deal/message/document persistence. |

## V.2 Gate-evaluation flow (initial submission)

At the initial-submission gate block (`webhook.js`, ~`3290`–`3385`), the order of evaluation encodes
the decision hierarchy:

1. Build the canonical map from the email body and the on-file documents.
2. Compute canonical standalone and combined LTV (IV(a)); compute the canonical-incompleteness
   condition (IV(e)).
3. **Identity gate first** — if borrower identity is ambiguous, route to
   `awaiting_identity_confirmation` (resolve who the borrower is before any LTV decision).
4. **Maximum-LTV auto-decline** — else if the canonical auto-decline test fires (standalone above the
   maximum threshold, or a resolved combined above it), decline: send the broker a decline email and
   the underwriter an alert; set status `rejected`.
5. **Escalation** — else if the elevated-LTV escalation test fires **or** the canonical-incompleteness
   guard fires, route to `awaiting_collateral`.
6. Otherwise proceed on the active track toward a preliminary review.

The ordering is itself part of the design: identity precedes LTV (you cannot decide a deal whose
borrower is unresolved), and the maximum-LTV decline precedes the elevated-LTV escalation (a deal above
the maximum is declined, not merely escalated).

## V.3 State-specific reply handling

Replies to an existing deal are dispatched by the deal's current status, each status having a dedicated
handler in `webhook.js`:

- **`active`** — conversational handling: re-extract, re-evaluate gates against the updated canonical
  state, advance toward review when the deal is ready, or continue gathering.
- **`under_review` / `ltv_escalated`** — the deal is in the human queue; broker replies refresh the
  deal state and, where material, drive an updated review or notification to the underwriter rather
  than a separate broker-facing decision.
- **`awaiting_collateral`** — the correction-intent pre-check (IV(g)) runs first; absent a correction,
  the collateral-answer interpretation runs (offered → active with the collateral flag; declined →
  underwriter escalation; ambiguous → re-ask).
- **`awaiting_identity_confirmation`** — resolve identity; on resolution, proceed.

The underwriter-override path (Q9) is reached when the reply is from the configured underwriter address
on an `awaiting_collateral` deal (`webhook.js:2495`).

## V.4 Event handling, threading, and state stability

Continuation is by `In-Reply-To`/`References` correlation (II.4). Between events, the system waits for
the deal's outbound state to stabilize before the next gate evaluation, so that a decision runs against
a settled canonical state and not a transient mid-update one (IV(d)). Corrections are applied
field-by-field under the source-authority order, preserving unrelated established fields.

## V.5 Error handling and graceful degradation

The decision pipeline is AI-assisted, and the system's posture toward an AI-assist failure is
conservative by the same asymmetric-risk principle that governs the gate guards: the deterministic
canonical layer and the decision gates are the authority for disposition, and the AI is confined to
interpretation and narrative. The deal record and its status are the durable state of record in
Supabase; outbound generation and notification are layered on top of that persisted state.

---

# VI. Domain Rule Implementation (Q1–Q11)

The following eleven product rules encode Franco Maione's private-lending underwriting policy as
deterministic system behavior. Each is implemented as a discrete unit (IV(i)) and, where refined,
structured per IV(h).

## Q1 — Refinance/Payout Equivalence with Dual-Path Carve-Out

**Rule.** In private lending, a refinance and a payout of the existing mortgage are definitionally the
same transaction. When the system is confident a transaction is a refinance and identifies the existing
lender, the existing first mortgage is treated as paid out — the **combined** LTV collapses to the
**standalone** LTV (the existing balance is not added to the new loan). The original branch — firing on
explicit payout language plus a lender match — is preserved as an alternative path.

**Implementation.** `computeCombinedLtv` (`discrepancy-engine.js:319`), dual-path per IV(h): Branch 1
(`:396`) fires on `payoutConfirmed === true` + lender match → `carveOutStandalone('refinance-paid-out')`;
Branch 2 (`:406`) fires on `refinanceConfident === true` + lender match →
`carveOutStandalone('refinance-implicit-payout')`. A "confident refinance" requires an unambiguous
refinance signal (not ambiguous against a purchase) and no explicit non-payout contraindication.

## Q2 — LTV Threshold Auto-Decline

**Rule.** A canonical **standalone** LTV above the maximum policy threshold (90%) auto-declines
unconditionally. A **combined** LTV above the threshold auto-declines **only when payout status is
resolved** (the carve-out fired, or there is an explicit second-mortgage/additive signal); an
**unresolved** combined position **escalates** rather than declines (so that a deal pending a payout
clarification is not declined on a not-yet-resolved additive figure).

**Implementation.** `shouldAutoDeclineOver90` (`discrepancy-engine.js:526`) takes the canonical
standalone LTV, the canonical combined LTV, and a `combinedResolved` flag
(`isCombinedLtvResolved`, `discrepancy-engine.js:517`). The decline branch at the initial gate
(`webhook.js:3342`) sends the broker a decline email (`generateRejectionEmail`, basis "the
loan-to-value ratio exceeds our maximum threshold of 90%"), alerts the underwriter, and sets status
`rejected`. The decline is evaluated **before** the escalation branch, so an above-maximum deal is
declined, not escalated.

## Q3 — Joint Borrower Income/Debt Aggregation

**Rule.** For a joint borrower deal, the household qualifying income and debt are aggregated across the
**counted** borrowers (those whose role causes them to count toward qualification).

**Implementation.** `buildQualificationRoster` (`borrower-qualification.js:66`) builds a deterministic
roster of the parties and their roles; the parties that count are identified deterministically, and an
aggregation directive drives the household income/debt computation across the counted set.

## Q4 — Cosigner Conservative Gating

**Rule.** An explicit co-applicant / co-borrower label counts the party fully toward qualification. An
**ambiguous** "cosigner" label does **not**: it defaults to **guarantor-only** (liable on default, but
not counted toward qualification) and triggers a broker clarification — the conservative default,
because counting an ambiguous party would overstate household qualification.

**Implementation.** `classifyRole` (`borrower-qualification.js:48`) over the role enumeration
(`ROLE.PRIMARY` / `CO_APPLICANT` / `GUARANTOR_ONLY`, `:16`): an explicit guarantor label →
guarantor-only; an explicit co-applicant label → co-applicant (counts); an ambiguous "cosigner" label
→ guarantor-only **with an ambiguity flag** (conservative default + clarification ask); a detected
joint borrower with no role label → counts (the Q3 default).

## Q5 — Corporate Borrower Detection and Document-Ask

**Rule.** A corporate borrower is detected and surfaced; the deal requests accountant-prepared
financial statements per detected corporate entity, and the preliminary summary flags the corporate
condition. Detection is two-tier: a reliable primary tier (corporate suffix, numbered companies) and a
best-effort multi-entity tier with a clarification fallback.

**Implementation.** `detectCorporateEntities` (`corporate-entities.js:31`): the entity-suffix
recognizer (`ENTITY_SUFFIX_RE`, `:21` — Inc/Ltd/Corp/LLC/LLP, etc.) and entity-name recognizer
(`ENTITY_NAME_RE`, `:26`) provide reliable detection; linkage heuristics (`LINKAGE_RE`, `:29`) support
best-effort multi-entity detection. The accountant-financials document-ask is injected per detected
entity, and the corporate flag is surfaced on the preliminary summary.

## Q6 — Chase Cadence

**Rule.** When awaiting broker action, the system sends up to **four** reminder follow-ups and does
**not** auto-close the deal; after the reminders are exhausted, the deal is escalated to the
underwriter rather than silently abandoned.

**Implementation.** The follow-up reminder cadence (four reminders, no auto-close, then escalation) in
the reminder path. The no-auto-close behavior is deliberate: a private-lending deal that has gone quiet
is a human-follow-up matter, not an automatic closure.

## Q7 — Property-Based Geographic Decline

**Rule.** The geographic test is **property-based, not borrower-based**: a non-Canadian **subject
property** auto-declines; a Canadian property with a non-Canadian **borrower** processes normally. The
collateral is the property, so jurisdiction is determined by the property's location.

**Implementation.** The jurisdiction decline is keyed on the subject-property location (declining a
non-Canadian property via `generateRejectionEmail`), explicitly independent of the borrower's
nationality.

## Q8 — Joint Applicant Detection

**Rule.** Joint applicants are detected either via two-or-more credit-bureau documents **or** via an
intake-stated name-conjunction pattern ("John and Jane Doe"); when detected, a joint-applicants row is
surfaced on the preliminary summary. The display detection does **not** alter the existing-mortgage
suppression behavior (joint spouses typically share one mortgage; the display union is presentation,
not a change to mortgage handling).

**Implementation.** A name-conjunction detector ("X and Y", both full names, with role-disqualifying
guards) provides display-level joint detection in addition to the document-based detection; the joint
row is surfaced on the summary when detected; the existing-mortgage suppression remains
credit-bureau-document-scoped.

## Q9 — Underwriter (Admin) Override on Awaiting-Collateral

**Rule.** An email from the configured underwriter address can **override** an `awaiting_collateral`
hold, releasing the deal to active processing with an **audit-trail entry** recording the override and
its author.

**Implementation.** The underwriter-override branch (`webhook.js:2495`): on an `awaiting_collateral`
deal, an underwriter reply classified as an approval transitions the deal to `active`, records
`collateral_override_at` / `collateral_override_by` in the deal's persisted state (`webhook.js:2522`),
and proceeds (e.g., a document-request draft). The override is gated on the sender matching the
configured underwriter address.

## Q10 — Material-Change Admin Re-Notification

**Rule.** When a broker submits a correction to a **material** underwriting field — loan amount,
property value, mortgage position, transaction type, or address — **after** the preliminary review has
already been sent to the underwriter, the system detects the material change and emits an updated
notice (`[UPDATED]`) to the underwriter with the corrected figures and the delta, plus an audit-trail
entry. A non-material correction (e.g., a name spelling) yields no re-notification.

**Implementation.** After a post-prelim broker reply, the system parses the prior material figures from
the most-recent preliminary summary (`webhook.js:3793`), detects material changes against the updated
canonical state (`q10DetectMaterialChanges`, `:3795`), and on a material change emits the
`[UPDATED] Prelim correction` notice with the per-field delta
(`sendAdminMaterialCorrectionNotice`, helper at `:1570`) and records `_q10_admin_renotified_at` /
`_q10_renotified_fields` (`:3802`). The non-material guard suppresses re-notification when no material
figure changed.

## Q11 — Registered Property Owner Rule

**Rule.** The registered property owner(s) must be on the application. When only **one** applicant
matches the registered owner and a **second** applicant is present, the second applicant is classified
as a **guarantor**. This registered-owner determination **supersedes** Q4's cosigner-ambiguity default
when it definitively determines the role (a definitive owner test outranks a role-language guess).

**Implementation.** `detectRegisteredOwners` (`registered-owner.js:52`) returns
`{ signalPresent, owners, soleOwnerExplicit }` from an owner-signal detector (`OWNER_SIGNAL_RE`, `:17`
— "registered owner", "on title", "sole owner", "holds title", "owner of record"), owner-name
attribution (`OWNER_NAME_RE`, `:45`, attributing ownership to a named party by proximity to the owner
signal within sentence bounds), a both-owners detector (`BOTH_RE`, `:19`), and a sole-owner detector
(`SOLE_RE`, `:18`). The result is fed into `buildQualificationRoster`
(`borrower-qualification.js:66`, which accepts `registeredOwners` / `registeredOwnerSignal`): on a
single registered owner with a second non-owner applicant, the non-owner is classified guarantor-only,
overriding the Q4 role-language default.

---

# VII. Differentiation from Prior Art

## VII.1 Loan Origination Systems (LOS)

Conventional loan-origination systems (e.g., the bank/credit-union LOS category) are **structured-form,
rule-engine, batch-oriented** systems: a borrower or loan officer enters data into structured fields, a
rule engine evaluates it, and the system advances the file. They are not driven by **real-time
extraction from unstructured broker email prose**, and they target the regulated, standardized-rulebook
channel rather than private lending's lender-specific policy. Vienna's differentiator is that its input
is the broker's actual email-and-attachments submission, interpreted by the canonical extraction system
(IV(c)) and AI-assist (III.4), with the lender's own policy (Section VI) encoded as deterministic gates
— there is no structured intake form; the email thread is the interface.

## VII.2 General-purpose AI document-processing services

General AI document-processing offerings perform **OCR, classification, and form-field extraction** as
a horizontal service. They extract; they do not **underwrite**. They have no concept of a
decision-gate layer, no canonical-vs-AI separation discipline (IV(a)), no
incomplete-state escalation/render guards (IV(e)/(f)), and no multi-event deal-state accumulation with
field-level corrections (IV(d)). Vienna uses document extraction as one input among several to a
**domain-specific, gated, stateful decision system**; the document extraction is a means, not the
product.

## VII.3 Email/workflow automation platforms (n8n, Zapier, Make, and similar)

Visual workflow-automation platforms implement a **workflow-builder paradigm**: a directed graph of
triggers and actions, configured rather than coded. They are well-suited to linear "when X, do Y"
automations and poorly suited to what Vienna does, for specific reasons:

- **No defensive gate-layering.** A workflow graph has no natural place for four independent
  incomplete-state guards distributed across pipeline layers (IV(b)); the graph models a happy-path
  flow, not layered defense-in-depth.
- **No canonical-vs-AI separation discipline.** A workflow that calls an AI step and uses its output
  has no architectural mechanism to refuse the AI's value at a decision while accepting it for
  narrative (IV(a)); the value is simply data on a wire.
- **Limited multi-event continuation.** Thread-accumulated canonical decision-state with field-level
  corrections and a state-stability barrier (IV(d)) is a stateful, code-level pattern, not a
  graph-of-actions; a workflow builder models a run, not an accumulating deal.

Vienna is **code-native** precisely so that these patterns are expressible: explicit control flow,
module composition, persisted accumulating state, and layered guards are properties of a coded system,
not of a configured workflow graph.

## VII.4 AI underwriting entrants

The current market includes AI-assisted underwriting and mortgage-tech entrants, generally focused on
the regulated/agency channel and on **scoring or recommendation** from structured data. The
combination that differentiates Vienna is specific: a **code-native architecture**, **AI confined to
interpretation and narrative with a hard separation from decision inputs** (IV(a)), **deterministic
decision gates protected by layered incomplete-state defenses** (IV(b)/(e)/(f)), **multi-event
thread-accumulated canonical state with field-level corrections** (IV(d)), and a **modular,
dual-path-refinable rule body** encoding a private lender's specific policy (IV(h)/(i), Section VI).
Each element exists somewhere in the broader market; their composition into a single
private-lending email-native underwriting system is the differentiated whole.

## VII.5 Why the combination is differentiated

The defensible position is not any single technique but the **architecture that holds them together**:
an email-native, code-native, stateful underwriting system that (1) extracts decision data
deterministically from real broker prose and documents with disciplined provenance, (2) reserves AI for
where its variance is harmless, (3) decides with deterministic gates protected by redundant
incomplete-state guards across four layers, (4) accumulates and corrects deal state across an arbitrary
email thread, and (5) encodes a specific private lender's evolving policy as modular, independently
revertible, dual-path-refinable rules. The strongest individual claims (counsel to assess) are likely
the **canonical/AI gate-input separation** (IV(a)), the **layered incomplete-state defense** (IV(b)
with IV(e)/(f)), the **thread-accumulated canonical state with field-level corrections** (IV(d)), and
the **correction-intent routing from a holding state composed against the existing correction pipeline**
(IV(g)).

---

# VIII. Appendices

## Appendix A — Code excerpts demonstrating the Section IV innovations

> Excerpts are presented with simplified inline annotations for readability; function names and control
> flow reflect the production implementation.

**A.1 — Canonical gate-input discipline (IV(a))** — `webhook.js`, initial gate block (~3290–3340):

```js
// Gates consume CANONICAL LTV (computed from the canonical map), with the
// model-emitted value used only as a last-resort fallback when canonical cannot compute.
const standaloneLtv = computeStandaloneLtv(canonicalMap) ?? modelLtvPercent;     // discrepancy-engine.js:440
const combined      = computeCombinedLtv(canonicalMap);                          // discrepancy-engine.js:319
const combinedLtv   = combined ? combined.combined_ltv_percent : null;

const shouldEscalate = shouldEscalateOnAnyLtv({ standaloneLtv, combinedLtv });   // discrepancy-engine.js:471
const autoDecline    = shouldAutoDeclineOver90({                                 // discrepancy-engine.js:526
  standaloneLtv, combinedLtv, combinedResolved: isCombinedLtvResolved(canonicalMap),
});
const incompleteEscalation = shouldEscalateOnIncompleteCanonical({              // discrepancy-engine.js:500
  hasMortgageStatement, combinedLtv, payoutConfirmed, hasLoanAmount,
});
```

**A.2 — Refinance/payout dual-path carve-out (IV(h), Q1)** — `discrepancy-engine.js:396–407`:

```js
if (refinanceTuple && refinanceTuple.payoutConfirmed === true && refinanceLenderMatches) {
  return carveOutStandalone('refinance-paid-out');        // Branch 1 (original, preserved)
}
if (refinanceTuple && refinanceTuple.refinanceConfident === true && refinanceLenderMatches) {
  return carveOutStandalone('refinance-implicit-payout'); // Branch 2 (refinement, added)
}
```

**A.3 — Canonical-incompleteness escalation guard (IV(e))** — `discrepancy-engine.js:500`:

```js
const shouldEscalateOnIncompleteCanonical = ({
  hasMortgageStatement = false, combinedLtv = null, payoutConfirmed = false, hasLoanAmount = false,
} = {}) => !!(hasMortgageStatement && combinedLtv == null && !payoutConfirmed && hasLoanAmount);
```

**A.4 — Correction-intent routing from awaiting-state (IV(g))** — `webhook.js:3545`:

```js
if (deal.status === 'awaiting_collateral') {
  const corrections = parseBrokerCorrections(replyBody);   // canonical-fields.js:990 (composed, not duplicated)
  if (corrections.length > 0) {
    deal.status = 'active';                                // route to the existing correction pipeline + gate re-eval
  } else {
    /* default collateral-answer interpretation, unchanged */
  }
}
```

**A.5 — Broker-prose extraction false-positive guard (IV(c))** — numeric-ordinal position, reference
guard — `canonical-fields.js`:

```js
const m = [...emailBody.matchAll(/\b(behind\s+(?:the\s+)?(?:existing\s+)?|(?:the\s+)?existing\s+)?(1st|2nd|3rd)\s+mortgage\b/gi)]
            .find(x => !x[1]);   // skip "behind/existing ..." references; take the deal's OWN position
```

**A.6 — Registered-owner classification (Q11, IV(i))** — `registered-owner.js:52`:

```js
const detectRegisteredOwners = (textSources, candidateNames = []) => {
  if (!OWNER_SIGNAL_RE.test(text)) return { signalPresent: false, owners: [], soleOwnerExplicit: false };
  if (BOTH_RE.test(text))          return { signalPresent: true,  owners: names.slice(), soleOwnerExplicit: false };
  // ... owner-name attribution by proximity within sentence bounds (OWNER_NAME_RE) ...
  const soleOwnerExplicit = SOLE_RE.test(text) || owners.length === 1;
  return { signalPresent: owners.length > 0, owners, soleOwnerExplicit };
};
```

## Appendix B — State machine (textual)

**States:** `active`, `under_review`, `awaiting_collateral`, `ltv_escalated`,
`awaiting_identity_confirmation`, `rejected` (terminal), `completed` (terminal).

**Transitions:**

- *New intake* → identity ambiguous → `awaiting_identity_confirmation`; else canonical standalone (or
  resolved combined) LTV above maximum → `rejected`; else elevated-LTV escalation OR canonical
  incompleteness → `awaiting_collateral`; else non-Canadian property → `rejected`; else → `active`.
- `awaiting_identity_confirmation` → identity resolved → `active`.
- `active` → enough on file for a preliminary review → `under_review`; → elevated-LTV gate on
  re-evaluation → `awaiting_collateral`; → above-maximum on re-evaluation → `rejected`.
- `awaiting_collateral` → collateral offered → `active`; → collateral declined / none →
  `ltv_escalated`; → **broker correction** (intent-routed, IV(g)) → re-evaluate against corrected
  state (may return to `active`, remain held, or re-decide); → **underwriter override** (Q9) →
  `active` (+ audit-trail entry).
- `ltv_escalated` / `under_review` → underwriter action and/or broker material change (Q10
  re-notification) → terminal disposition.
- `rejected`, `completed` → terminal.

## Appendix C — Workflow (textual, intake to outbound)

1. Broker email + attachments → Postmark inbound webhook → `POST /webhook`.
2. Parse sender / subject / body / threading headers / attachments; classify sender (broker vs
   underwriter vs system).
3. Continuation lookup by `In-Reply-To`/`References`: existing deal (continuation event) or new deal.
4. Persist + classify + text-extract attachments (PDF text / OCR).
5. Build/accumulate the canonical map from prose + documents (deterministic), with source-authority
   resolution; AI-assist for linguistic interpretation and narrative.
6. Evaluate gates against the canonical map: standalone/combined LTV, identity, maximum-LTV decline,
   elevated-LTV escalation, canonical-incompleteness escalation, product rules (Q1–Q11).
7. Determine disposition: proceed / escalate / decline / await / override.
8. Generate outbound (prelim to underwriter with incompleteness markers / decline / escalation /
   clarification / admin notice); figures from canonical, prose from AI.
9. Persist deal state (status, canonical fields, messages) to Supabase.
10. Dispatch outbound via Postmark to broker and/or underwriter.
11. Subsequent events repeat against the accumulating deal state, routed by the deal's current status.

## Appendix D — Q-rule reference table

| Rule | Statement (abbreviated) | Implementation site |
|---|---|---|
| Q1 | Refinance ≡ payout; confident refinance + lender match → combined collapses to standalone; original explicit-payout branch preserved (dual-path) | `discrepancy-engine.js:319` (`computeCombinedLtv`, branches `:396`/`:406`) |
| Q2 | Standalone LTV >90% auto-declines; combined >90% declines only when resolved, else escalates | `discrepancy-engine.js:526` (`shouldAutoDeclineOver90`); decline at `webhook.js:3342` |
| Q3 | Joint income/debt aggregated across counted borrowers | `borrower-qualification.js:66` (`buildQualificationRoster`) |
| Q4 | Co-applicant counts; ambiguous "cosigner" → guarantor-only + clarification | `borrower-qualification.js:48` (`classifyRole`), roles `:16` |
| Q5 | Corporate borrower detected; accountant-financials ask per entity; summary flag | `corporate-entities.js:31` (`detectCorporateEntities`) |
| Q6 | Four reminders, no auto-close, then escalate | `dailySummary.js:51` (`runFollowUpReminders`; `MAX_REMINDERS = 4` at `:30`) |
| Q7 | Property-based jurisdiction: non-Canadian property declines; non-Canadian borrower on Canadian property processes | `canonical-fields.js:324` (`detectNonCanadianProperty`); decline at `webhook.js:2952` |
| Q8 | Joint detection via 2+ bureau docs OR name-conjunction; summary joint row; suppression unchanged | `discrepancy-engine.js:1076` (`detectJointFromNames`); joint row at `:695`; document-based `detectJointMultiBorrower` at `:1046` |
| Q9 | Underwriter email overrides `awaiting_collateral` → active, with audit trail | `webhook.js:2495` (override `:2522`) |
| Q10 | Post-prelim material correction → `[UPDATED]` notice to underwriter + delta + audit | `webhook.js:3793`–`3806`, helper `:1570` |
| Q11 | Registered owner(s) must be on the application; lone owner + second applicant → guarantor; supersedes Q4 | `registered-owner.js:52` → `borrower-qualification.js:66` |

---

*End of specification.*
