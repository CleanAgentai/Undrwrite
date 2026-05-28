# Phase 4.5 — Layer 3 Product-Design Decisions Needed

**Status:** in-progress (Phase 4 spec authoring underway; items added as scenarios surface them).
**Resolution mechanism:** Phase 4.5 working session — Porter batches Porter-decidable items; Franco-input-required items folded into next acceptance-cycle conversation.

## Categories

- **PORTER-DECIDABLE**: validation policies, workflow timing for low-stakes paths, when-required field rules, name precedence, etc. Porter handles in working session.
- **FRANCO-INPUT-REQUIRED**: items where business policy intersects lender-relationship judgment or broker-workflow expectations. Routed to next Franco conversation.
- **ARCHITECTURE-AMENDMENT-CANDIDATE**: Vienna's canonical_map shape may need extension; Phase 5 triage surfaces empirical anchor before any Phase 1 matrix amendment.

## Format per item

Each item:
- **Scenario anchors**: fixtures that exercise this question
- **Question**: what's undefined
- **Options**: (a) / (b) / (c) discrete choices
- **Recommended default**: Phase 5 placeholder so execution can proceed pre-Phase-4.5
- **Default rationale**: why this default is least-harmful pending real decision

---

## PORTER-DECIDABLE (18 items)

### #6 — Broker-silent escalation timing threshold
- **Scenario anchors**: D09, E21, E23, F12
- **Question**: After Vienna sends prelim review (or discrepancy callout), broker goes silent. When does F4.CH chase email fire? After 24h / 48h / 72h / 1wk / never (admin-only)?
- **Options**: (a) 48h auto-fire; (b) 72h auto-fire; (c) admin-triggered only (no auto-chase); (d) escalating cadence (24h then 72h then admin handoff)
- **Recommended default**: (b) 72h auto-fire — balances responsiveness with not annoying brokers; conservative starting point
- **Default rationale**: 72h is a common business-day threshold; broker silence on a deal in flight beyond 72h warrants gentle follow-up
- **Cross-listed**: Likely FRANCO-INPUT — affects retest experience

### #9 — Legal vs preferred name precedence
- **Scenario anchors**: A39
- **Question**: When loan_application doc shows legal name + broker correction supplies preferred name, which is canonical?
- **Options**: (a) legal always; (b) preferred for broker-facing comms + legal for legal docs (two-field model); (c) broker_correction tier always wins
- **Recommended default**: (c) broker_correction always wins per F1 source-hierarchy template; preferred name used in canonical_map
- **Default rationale**: F1 source-hierarchy intent says broker correction is authoritative; legal name appears in docs anyway for legal-doc generation

### #10 — Borrower contact info missing — when required
- **Scenario anchors**: (no fixture; surfaced from A40 spec authoring)
- **Question**: Is borrower_contact (phone/email) required for canonical_map completion, or optional?
- **Options**: (a) required (escalate-as-missing); (b) optional (proceed without)
- **Recommended default**: (b) optional — broker is Vienna's primary contact; borrower contact is supplementary
- **Default rationale**: Vienna's workflow is broker-facing; direct borrower contact not in standard flow

### #11 — Annual income missing — escalation timing
- **Scenario anchors**: A41
- **Question**: When annual_income has no source anywhere (no NOA + loan_app omits + broker silent), when does Vienna escalate?
- **Options**: (a) immediate intake escalation; (b) hold for 24h grace period; (c) include in next round of doc-ask
- **Recommended default**: (c) include in next round of doc-ask — bundle with other missing-doc requests
- **Default rationale**: Bundles escalations rather than per-field paging; reduces broker friction

### #12 — Credit score requirements — when needed
- **Scenario anchors**: A42, F24
- **Question**: Is credit_score required canonical field? Does broker-supplied score (no credit-pull doc) satisfy?
- **Options**: (a) required + must have credit-pull doc; (b) required + broker-supplied accepted; (c) optional + accept broker-supplied
- **Recommended default**: (b) required + broker-supplied accepted (trust-based); credit-pull doc requested as additional verification
- **Default rationale**: Brokers have lender-relationship trust; doc requested but not blocking

### #15 — transaction_type missing all signals
- **Scenario anchors**: A31
- **Question**: When TT has no source (no broker mention, no doc field, no mortgage_statement inference), what's the default?
- **Options**: (a) default to refinance (most common); (b) flag-as-missing + escalate to broker; (c) admin hold
- **Recommended default**: (b) flag-as-missing + ask broker — TT is load-bearing for all downstream LTV math
- **Default rationale**: Defaulting to refi silently risks wrong workflow; explicit ask is cheap

### #16 — mortgage_position ambiguous signal
- **Scenario anchors**: A27
- **Question**: When MP has no broker signal AND no lender match AND no doc field, what's the default?
- **Options**: (a) default to 1st mortgage; (b) flag-as-missing; (c) admin hold
- **Recommended default**: (a) default to 1st mortgage — vast majority of refis are 1st-position; lowest-error default
- **Default rationale**: First mortgage is the dominant case; defaulting is acceptable when no signal exists

### #17 — Loan amount range ambiguity ("$80k-100k")
- **Scenario anchors**: A09
- **Question**: When broker phrases LA as range, how to resolve?
- **Options**: (a) pick midpoint; (b) pick high end; (c) flag for broker disambiguation
- **Recommended default**: (c) flag for broker disambiguation — LA exactness affects LTV calc + lender quoting
- **Default rationale**: Range handling is downstream-fragile; cheap to ask broker to specify

### #18 — Loan amount validation (zero/negative/very-large/non-CAD)
- **Scenario anchors**: A10, A11, A12
- **Question**: What validation rules apply to LA?
- **Options**: (a) zero/negative reject + very-large warn (>$5M) + non-CAD reject; (b) all flag for admin review; (c) accept any positive numeric
- **Recommended default**: (a) zero/negative reject at intake + non-CAD reject + very-large flag-for-review at >$5M
- **Default rationale**: Zero/negative are clearly invalid; non-CAD is out-of-jurisdiction; very-large warrants review but not reject

### #19 — Property value < requested loan amount (sanity violation)
- **Scenario anchors**: A17
- **Question**: When PV < LA (>100% LTV), what does Vienna do?
- **Options**: (a) decline outright; (b) escalate to admin; (c) flag-for-broker-confirmation
- **Recommended default**: (b) escalate to admin — sanity-violation is rarely intentional; admin reviews
- **Default rationale**: PV<LA is impossible-to-underwrite; admin can determine if it's typo or real exception

### #20 — Broker correction on unknown/unparsed field
- **Scenario anchors**: C05
- **Question**: When broker corrects with unrecognized field name, gracefully ignore vs flag?
- **Options**: (a) gracefully ignore unknown + process recognized; (b) flag for admin attention; (c) error
- **Recommended default**: (a) gracefully ignore + process recognized fields in same message
- **Default rationale**: Brokers occasionally use idiosyncratic field labels; ignoring unknown preserves intake flow

### #21 — Multiple correction emails within minutes (race)
- **Scenario anchors**: C07
- **Question**: When 3+ corrections to same field arrive within an hour, how to resolve?
- **Options**: (a) last-write-wins; (b) reject after N corrections within window (rate limit); (c) flag for admin disambiguation
- **Recommended default**: (a) last-write-wins per temporal-order — broker's latest is authoritative intent
- **Default rationale**: Brokers iterate; treating last as authoritative matches their mental model

### #22 — QC French-language name/address handling
- **Scenario anchors**: E27, F08
- **Question**: Does Vienna extract French content (accented characters, French street types) cleanly, or escalate?
- **Options**: (a) full French support (extract + render); (b) accept French intake + render English in admin email; (c) escalate French intake to admin
- **Recommended default**: (b) accept French intake + admin-facing English rendering — common Canadian bilingual broker workflow
- **Default rationale**: QC brokers operate bilingually; admin-side English is acceptable; full French support is larger project

### #23 — Admin-override for legitimate same-property new-deal cases
- **Scenario anchors**: (no current fixture; surfaced from Franco's dedup-block interaction)
- **Question**: When R9-F' property_match_active blocks new-deal creation, but admin determines it's legitimate (e.g., refinance returning after 6mo, new borrower on same property, testing-workflow restart), how does override work?
- **Options**: (a) admin force-create via specific subject pattern; (b) admin force-create via admin-handoff path; (c) bypass dedup-check entirely for admin-direction intake
- **Recommended default**: (a) admin force-create via specific subject pattern ("FORCE-NEW:...")
- **Default rationale**: Explicit override pattern surfaces audit trail; bypass-entirely is risky

### #24 — Postal code missing — when required
- **Scenario anchors**: A23
- **Question**: Is postal_code required canonical field, or geocode-derivable from street?
- **Options**: (a) required (escalate-as-missing); (b) derive-via-lookup (Vienna geocodes); (c) optional
- **Recommended default**: (a) required + escalate-as-missing — postal is load-bearing for FSA-province mapping
- **Default rationale**: F1.PC drives F1.AD province inference; geocoding adds external-service dependency

### (extras to surface during Phase 4 batches)
*Items 25-30 added as Phase 4 spec authoring proceeds*

---

## FRANCO-INPUT-REQUIRED (6 items)

### #14 — LTV ceiling policy (>85% — decline vs escalate)
- **Scenario anchors**: E05
- **Question**: At LTV >85%, does Vienna decline outright (out-of-band) or escalate for manual exception review?
- **Options**: (a) decline at intake; (b) escalate for manual exception review; (c) treat same as F4.HL >80% path with extra collateral ask
- **Recommended default**: (b) escalate for manual exception review
- **Default rationale**: Borderline-band deals occasionally warrant exception; declining at intake forecloses legitimate cases. Franco co-decides — affects lender-relationship judgments.

### #7 — Non-spousal joint aggregation rules
- **Scenario anchors**: E12, F02
- **Question**: Are non-spousal joint applicants treated identically to spousal joint, or different aggregation rules (separate income, combined LTV, etc.)?
- **Options**: (a) identical to spousal-joint; (b) separate income but combined LTV; (c) per-applicant qualifying with weakest applicant gating
- **Recommended default**: (b) separate income but combined LTV — matches common lender practice
- **Default rationale**: Affects broker workflow expectations; Franco co-decides — broker workflow + lender practice intersection.

### #8 — Cosigner/guarantor distinction from joint
- **Scenario anchors**: E13
- **Question**: How does Vienna distinguish cosigner (on note, not title) from co-applicant (on title)?
- **Options**: (a) cosigner = additional canonical field (cosigner_name + cosigner_income); (b) cosigner = co-applicant with title-share=0%; (c) cosigner = extraText only
- **Recommended default**: (a) cosigner as additional canonical field — most semantically clean
- **Default rationale**: ARCHITECTURE-AMENDMENT cross-listed (may need new canonical field). Franco co-decides — lender acceptance varies.

### #1 — Corporate borrower canonical_map shape
- **Scenario anchors**: E14, F03
- **Question**: Does Vienna's canonical_map need new fields for corporate borrowers (incorporation_jurisdiction, directors, beneficial_owners[]) or can borrower_name + extraText accommodate?
- **Options**: (a) extend canonical_map with corporate-specific fields; (b) borrower_name handles corp name + AML/PEP per beneficial-owner uses borrower_name; (c) treat as out-of-scope (private-mortgage-link is individual-borrower only)
- **Recommended default**: (b) borrower_name + AML/PEP per beneficial-owner — minimal extension
- **Default rationale**: ARCHITECTURE-AMENDMENT cross-listed. Franco co-decides — corporate borrowers affect AML/PEP workflow + lender acceptance.

### #6 — Broker-silent escalation timing
- **Scenario anchors**: D09, E21, E23, F12 (cross-listed Porter)
- **Question**: When does F4.CH chase fire? (See Porter section #6 for options; Franco co-decides because affects retest experience.)
- **Recommended default**: (b) 72h auto-fire
- **Default rationale**: Cross-listed in Porter; Franco confirms timing matches his broker-relationship expectations.

### #13 — Outside-Canada / unknown FSA handling
- **Scenario anchors**: E30
- **Question**: Is non-Canadian-jurisdiction property in scope for Vienna, or explicit decline?
- **Options**: (a) explicit decline with out-of-scope message; (b) admin handoff for case-by-case; (c) treat as Layer 3 deferred (accept now, decide later)
- **Recommended default**: (a) explicit decline with out-of-scope message — Vienna is Canadian-jurisdiction product
- **Default rationale**: Franco confirms whether US/etc. is in or out of scope (likely out; explicit decline cleaner than silent processing).

---

## ARCHITECTURE-AMENDMENT-CANDIDATES (4 items)

These items surface Phase 5 triage empirical anchors before any Phase 1 matrix amendment lands. Phase 4 spec uses placeholder behavior pending Phase 5 confirmation.

### #2 — 3rd mortgage support
- **Scenario anchors**: E08
- **Question**: Does Vienna's combined-LTV math + canonical_map support 3rd mortgages (1st + 2nd + new 3rd)?
- **Phase 4 placeholder spec**: canonical_map uses mortgage_position='3rd mortgage'; 2nd-mortgage info in extraText; Phase 5 triage reveals whether existing fields handle the combined-LTV math
- **Architecture-amendment trigger**: if Phase 5 reveals 2nd-mortgage-balance needs canonical field, surface as Phase 1 matrix amendment

### #3 — Construction loan support
- **Scenario anchors**: E10
- **Question**: Does Vienna support construction loans (draw schedule, progress inspection, projected-completion-value vs current land value)?
- **Phase 4 placeholder spec**: canonical_map uses transactionType='Construction'; draw schedule + completion timeline in extraText
- **Architecture-amendment trigger**: if Phase 5 reveals construction-loan-specific canonical fields needed (draw_schedule[], completion_date, lender_inspection_required), surface as Phase 1 matrix amendment

### #4 — Private mortgage specific handling
- **Scenario anchors**: E09
- **Question**: Does Vienna differentiate private mortgages from bank-lender refis in workflow / risk-classification / canonical_map?
- **Phase 4 placeholder spec**: canonical_map treats private mortgages identically to bank-lender refis; existingFirstMortgageLender holds private-lender name
- **Architecture-amendment trigger**: if Phase 5 reveals private-mortgage-specific workflow needs differentiation, surface

### #5 — Wrong-doc-uploaded escalation policy
- **Scenario anchors**: E20
- **Question**: When filename routes to one classification but content doesn't match, what's the escalation flow?
- **Phase 4 placeholder spec**: filename classification dominates (deals.js classifyDocument behavior); Phase 5 reveals content-mismatch detection capability
- **Architecture-amendment trigger**: if Phase 5 reveals filename-vs-content mismatch detection is desired but not present, surface as feature gap

---

## SEMANTIC-INVARIANT-UNDER-SPECIFICATION (deferred to Phase 4 surfacing)

### LLM-narrative fab vector — F25
- **Status**: Phase 4 Batch 4 spec authoring will surface this. F25 is the strongest 16th carry-forward candidate. Spec articulates: narrative must NOT fabricate canonical values not in canonical_map; broker-stated INTENT values authoritative per R10-G; verified doc values acceptable; everything else must not appear as canonical figures.
- **Anchor**: R10-G OBJECTIVE vs INTENT framing.

---

## Running Layer 3 count: 24 firm + 4 architecture-amendment candidates = 24-28 items

**Trajectory:** 22 Phase 1 baseline + 2 mid-program additions + 0 firm new from Batches 3-4. Architecture-amendment candidates may convert to firm Layer 3 items in Phase 5 triage. Below 40-item escalation threshold.
