# Phase 4.5 — Layer 3 Product-Design Decisions Needed

**Status:** in-progress (Phase 4 spec authoring underway; items added as scenarios surface them).
**Resolution mechanism:** Phase 4.5 working session — Porter batches Porter-decidable items; Franco-input-required items folded into next acceptance-cycle conversation.

---

# FINAL STATE — consolidated index (2026-05-30, staging 792775c)

The historical Layer-3 ledger is preserved below; this index is the current decision status.

## OPEN — Franco's clustered-text response (3 + 1 dependent)
- **Q1-escalation-rate** — is escalating ~41/125 (33%) of deals for "no explicit payout
  language" the intended conservatism, or too aggressive? Gates Track-4 LIST-C cat-1 bulk.
  (Surfaced BATCH-13; detail in §"BATCH 12 — LIST-C" + BATCH13-RESULTS.md.)
- **C01 — admin-intake routing** — `admin_controlled=true` when `FromName="Admin"` sends the
  initial intake? (EMERGENT-FIND-D below; never in Franco-9.)
- **Q8-detection-extension keep-or-revert** — name-conjunction broadening (`75d91e2`)
  vs credit-bureau-doc-confirmation-only. (§"BANKED Franco product-design questions".)
- **A33 part (b)** [DEPENDENT on Q1-escalation-rate] — canonical loan_app existing-balance
  extraction; flips A33 → Q1-escalation, so unblocks only once Q1-rate is ratified.

## RESOLVED — with Franco answer / Porter direction + implementing commit
- **Franco-9 dispositions Q1–Q10** — all answered + shipped (§"FRANCO-9 DISPOSITIONS"):
  Q1 `e8975be`, Q2 `8b65776`, Q3 `6a67e59`, Q4 `a35947a`, Q5 `1255199` (+ render `d4bd476`,
  doc-ask `2734032`), Q6 `21ccbe4`, Q7 `9794d61`, Q8 `b20b7cd` (+ ext `75d91e2`), Q9 `f1e944e`,
  Q10 `a5c032c`.
- **Finding-1b (terse "Refi" recognition)** — RESOLVED by Q1's conservative payout rule
  (`e8975be`); supersedes the open Finding-1b question below.
- **Porter-decidable Layer-3 items implemented** — e.g. #13 outside-Canada → property-scoped
  decline (Q7 `9794d61`); #18 non-CAD reject; #6 chase timing (Q6 `21ccbe4`). Per-item
  resolution in the historical ledger below.
- **BATCH-12 LIST-C surgical set** — broker_correction mechanism `0c826b9`, Q10-renotify
  `14989bc`, casing/province `2b3ba10`, E07/A14/F04/F13 combined+escalation (`abef24f`/
  `c4c3d3c`/`6481363`).
- **Confirmed Vienna bugs** (not product-design, but decision-adjacent): Bug-1 `d749b1e`,
  Bug-2 `2238952`, Bug-3 `d76e02b` + EXT `b427906`, Bug-4 `988badd`, Bug-5 `792775c`.

## DEFERRED-DOCUMENTED — not pursued, with rationale
- **Q5 corporate-row / Q8 joint-via-name end-to-end on escalating flows** — verification ceiling
  ACCEPTED (corporate/joint high-LTV correctly gate before prelim; unit harness is the ceiling).
  Not a defect. (VERIFICATION-CEILING-Q5-Q8-FLOW-GATED.md, `5e76b71`.)
- **A34 broker-correction Q10** — no prelim at intake → not a post-prelim correction → Q10
  correctly does not fire. Held, correct-as-is.
- **R4-RESIDUAL-1 elevated-band callout** — pre-existing residual (matrix-wide), not a Bug-N
  regression. Tracked in [[project_residual_narrative_fab]] / BUG3-SCOPE context.
- **Architecture-amendment candidates** (#2 3rd-mortgage, #3 construction, #4 private-specific,
  #5 wrong-doc) — out of the current matrix scope; surface empirical anchor before any amendment.

---

## (historical Layer-3 ledger — preserved below)

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

## ARCHITECTURE-AMENDMENT-CANDIDATES (4 baseline items + Phase 5 Sub-phase 5.1 auto-detection expansion)

These items surface Phase 5 triage empirical anchors before any Phase 1 matrix amendment lands. Phase 4 spec uses placeholder behavior pending Phase 5 confirmation.

### Auto-detection expansion (Sub-phase 5.1 empirical probe, 2026-05-27)

Per Q-R3 two-factor detection (no Vienna mapping + no gate-inference entry), `lib/normalize-map.js` ARCH_AMENDMENT_FIELDS auto-flags scenarios that reference genuinely-missing canonical fields:

| Field | Scenarios | Layer 3 # |
|---|---|---|
| `credit_score` | A42, F24 | #12 |
| `cosigner_name`, `cosigner_income` | E13 | #8 |
| `beneficial_owners`, `incorporation_jurisdiction`, `directors` | E14, F03 | #1 |
| `draw_schedule`, `projected_completion_value`, `completion_date`, `lender_inspection_required` | E10 | #3 |
| `postal_code_tuples` (spec shape issue) | A22, F06 | (normalize-map handling concern; verify in Phase 5) |
| `province` (may be derived not persisted) | E27, E28, E29 | (verify in Phase 5) |

**Auto-detected scope: ~10-12 scenarios** (within Porter's modest expansion projection vs original Revision 3 estimate of 15-20). Baseline 6 (E08/E10/E13/E14/E27/F03) + auto-detection adds A22/A42/F06/F24/E28/E29 to candidate pool.

Per Q-R3 refinement: ambiguous fields default to TRANSIENT (Option B gate-inference), not architecture-amendment. Specifically:
- `mortgage_position` (R10-G machinery): transient, NOT auto-flagged
- `existing_mortgage_lender` (R11-B-2 transient inference): NOT auto-flagged
- `annual_income` (shape-transformed via income_details object): NOT auto-flagged (handled via SHAPE_TRANSFORM)

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

---

## Sub-phase 5.2 / Mini-triage Findings (2026-05-27)

Empirical anchors from 9-scenario sample replay + 4-scenario validation re-run (post-patches). All findings durable in `bulletproof-sample-results-1.json` + `bulletproof-mini-triage-validation.json`.

### Finding #1 — Vienna R9-F intake classifier rejects FromName="Franco Maione" (architectural context, NOT a Porter decision)

- **Mechanism**: `src/routes/webhook.js:530-633` — `classifyIntakeBorrower` rejects when `firstNameOf(email.fromName) === ADMIN_FIRST_NAME` ("franco") + no broker_name context + no Lic.# body-signal override (R10-A). Returns `reject:admin-as-borrower` → no deal created.
- **Sample-replay impact**: 43 fixtures across A/B/C/D/E/F groups used FromName="Franco Maione" as spec-author error (Franco IS the admin per `ADMIN_EMAIL=franco@privatemortgagelink.com`, not a broker). All 43 produced extracted_data=undefined.
- **Fix applied**: Mini-triage commit re-tagged all 43 fixtures' FromName + From + body-signature → Jonathan Ferrara. Mechanical, additive. No spec semantics change.
- **Status**: RESOLVED in fixtures. Vienna's safety rule is correct behavior — no Vienna change needed.

### Finding #2 — Vienna prelim outbound Supabase persistence latency exceeds 8s (machinery, NOT a Porter decision)

- **Mechanism**: Vienna's `sendPreliminaryReviewToAdmin` (webhook.js:1235) runs synchronously within the inbound webhook handler, but outbound email render + Supabase messages-table insert latency is variable (8s sometimes insufficient).
- **Empirical**: B04 missed prelim with 8s post-extraction wait; captured cleanly at 30s wait (5/5 assertions pass).
- **Fix applied**: Mini-triage commit raised `replay.js` default `waitForOutbound` 8s → 30s. Env var override `BULLETPROOF_WAIT_OUTBOUND_MS` retained for tuning.
- **Status**: RESOLVED in machinery.

### Finding #3 — Vienna persists admin-handoff as `admin_controlled` boolean, NOT status enum

- **Mechanism**: `src/routes/webhook.js:1988, 2786, 2818` — admin_controlled boolean flag flipped on deal; status remains `active`. No `admin_handoff` status enum value exists in Vienna.
- **Fix applied**: Mini-triage commit updated `normalize-map.js` `resolveStatus()` to accept full deal object; special-case `specStatus='admin_handoff'` → check `deal.admin_controlled === true`.
- **Status**: RESOLVED in normalize-map. C01 still failed in validation re-run — Phase 5.4 triage needed to verify Vienna actually sets admin_controlled=true on FromName="Admin" intake (the C01 scenario shape).

### Finding #4 — B06 + B04 full-pass validates 3-layer assertion framework end-to-end (positive validation)

- **Empirical**: B06 (Group B awaiting_collateral) and B04 (preliminary_review_admin dispatch) both achieve full 5/5 assertion pass post-patches. Layer 1 STRUCTURAL + Layer 1 GATES + Layer 1 WORKFLOW + Layer 2 OUTBOUND all functional.
- **Status**: NO ACTION — positive control for matrix machinery soundness.

---

## EMERGENT FROM SUB-PHASE 5.2 VALIDATION — Phase 5.4 triage candidates

These are real Vienna behavior findings (NOT machinery issues) surfaced by post-patch validation re-run. They are empirical anchors for Phase 5.4 triage, NOT Porter decisions yet — they need Phase 5.4 disposition (Vienna bug vs spec assumption mismatch vs architectural-amendment).

### EMERGENT-FIND-A — F1.LA broker_correction tier not persisting

- **Scenarios**: B01 (4/7 pass), A01 (3/5 pass)
- **Symptom**: Spec asserts `requested_loan_amount` reflects broker_correction tier value; Vienna's extracted_data retains loan_app value.
  - B01: expected=$280k (broker correction), actual=$95k (loan_app)
  - A01: expected=$295k (broker correction), actual=$260k (loan_app)
- **Disposition pending**: Phase 5.4 triage — Vienna F1.LA implementation gap, OR spec assumption about correction-tier persistence vs request-time behavior mismatch, OR transient processing concept (not persisted).

### EMERGENT-FIND-B — F2.DH admin_discrepancy_notification not firing for >30% discrepancy

- **Scenarios**: B01
- **Symptom**: Spec asserts admin_discrepancy_notification fires when broker_correction vs loan_app discrepancy >30%; Vienna does not fire for B01 (195% discrepancy).
- **Disposition pending**: Phase 5.4 triage — Vienna R11-B-1 Layer 1 gate implementation gap, OR spec wording about which outbound kind is correct, OR notification routes to a different email kind.

### EMERGENT-FIND-C — F4.EL elevated_ltv_band "75-80%" callout pattern absent

- **Scenarios**: D03 (3/5 pass)
- **Symptom**: Spec asserts Risk Factors callout contains "75-80%" band string for LTV=78% (in elevated band); Vienna does not include this exact string.
- **Disposition pending**: Phase 5.4 triage — Vienna R10-C-2 implementation uses different wording, OR callout fires in different outbound kind, OR spec wording is too narrow.

### EMERGENT-FIND-D — C01 admin_handoff persistence pattern

- **Scenarios**: C01 (1/2 pass)
- **Symptom**: Spec asserts workflow_state='admin_handoff'; Vienna's actual status='active' AND (per Finding #3 fix) admin_controlled flag check ALSO did not match.
- **Disposition pending**: Phase 5.4 triage — verify whether Vienna actually sets admin_controlled=true when FromName="Admin" sends initial intake (vs only on link-submission flip at L2786 or per-deal pause at L1988). C01 scenario shape may not trigger Vienna's admin_controlled flip logic.


### EMERGENT-FIND-E — F25 prelim gate correctly held when property_value source absent

- **Scenarios**: F25 (spot-check 2026-05-27, 4/7 pass)
- **Symptom**: F25 spec expected preliminary_review_admin fire=true; Vienna correctly did NOT fire because property_value=null → LTV uncomputable → `computeWillReview` ltv-precondition fails.
- **Disposition pending**: SPEC REVISION (not Vienna bug). F25 should expect prelim NOT fire pending appraisal arrival. Sharpens carry-forward candidate "empirical-trigger validation" — Vienna's automated triggers have multi-precondition gates (LTV computability is one); spec assumptions about "complete docs = prelim fires" need PV-presence qualifier.
- **Additional F25 fails**: `first_mortgage_balance` $225k vs $226.5k (fixture-doc precision check); `existing_mortgage_lender` undefined (R11-B-2 statement-tier extraction gap; strengthens EMERGENT-FIND-A persistence-extraction pattern).

---

## FRANCO-INPUT — Finding 1b: terse "Refi" refinance recognition (2026-05-28)

**Surfaced by:** Bug 1 investigation (A14). When a broker writes a terse "Refi" /
"Refinance file" with an existing mortgage statement on file but WITHOUT explicit
payout language ("paying out the existing at closing"), `transaction_type` stays
empty → R11-B-3's payout carve-out doesn't fire → `computeCombinedLtv` goes
additive (existing+new/market) → the deal escalates for collateral.

**The question for Franco:** when a broker sends terse "Refi" + existing mortgage
statement but no explicit payout statement, should Vienna —
- (a) **assume refinance-replace** (existing 1st paid out → standalone LTV ~56%, no escalation), or
- (b) **conservatively treat as potential added leverage** (combined LTV → escalate to confirm collateral/intent)?

**Trade-off:** (a) matches common domain usage ("Refi" usually = replace) but risks
UNDER-escalating a genuine 2nd-mortgage-add; (b) is R11-B-3's current deliberate
design (require explicit payout signal + lender match) and errs safe, but
over-escalates terse-but-legitimate payout-refinances. **A14's escalation is
plausibly correct-conservative under (b).** Depends on Franco's broker corpus +
underwriting preference. NOT a confirmed bug — a product-design choice.

**If (a):** broaden `transaction_type` extraction to recognize terse "Refi"/
"Refinance" (with lender-match gating, mirroring R11-A). **If (b):** A14-shape
fixtures are under-specified; real payout-refinances state intent explicitly
(like Marcus 8c404ae0) → no Vienna change.

---

## FRANCO-9 DISPOSITIONS — RESOLVED (2026-05-28/29)

Franco answered Q1–Q7; Q8/Q9 built per Porter's predicted-answer call. All nine
implemented as the FRANCO-* commit bundle (shipped to staging 2026-05-29) and rolled
into fixtures (BATCH 7). Each disposition + its commit:

- **Q1 — Finding 1b RESOLVED → conservative payout rule:** default `transaction_type=refinance`
  unless purchase signals; R11-B-3 carve-out now THREE-condition (refinance + lender
  match + **explicit payout language**). Terse "Refi" without payout → escalates for
  clarification. Commit `e8975be`. This SUPERSEDES the Finding-1b open question above.
- **Q2 — >90% LTV auto-decline** (canonical; standalone always, combined only when
  payout-resolved). Commit `8b65776`.
- **Q3 — joint income/debt aggregation** (Option B: deterministic roster + prompt-override).
  Commit `6a67e59`.
- **Q4 — cosigner conservative gating** (ambiguous → guarantor-only, not counted). Commit `a35947a`.
- **Q5 — corporate accountant-financials doc-ask + multi-entity + Snapshot flag.** Commit `1255199`.
- **Q6 — chase cadence 3→4, escalate-to-admin (no auto-close).** Commit `21ccbe4`.
- **Q7 — non-Canadian PROPERTY auto-decline** (property-scoped; borrower location not a trigger).
  Commit `9794d61`.
- **Q8 — joint applicants surfaced in admin Snapshot.** Commit `b20b7cd`.
- **Q9 — admin-override out of awaiting_collateral** (→ active + audit trail). Commit `f1e944e`.

### Q10 — POST-PRELIM BROKER-CORRECTION ADMIN RE-NOTIFICATION (Franco answered YES, 2026-05-29)
Was the "Q2 banked" item; Franco resolved YES (with material-change qualifier). Now a
tenth Franco-disposition (FRANCO-Q10, own commit/harness/revert). When a broker corrects
a MATERIAL canonical field (requested_loan_amount, subject_property_market_value,
existing_first_mortgage_balance, mortgage_position, transaction_type, subject_property_address)
AFTER the admin prelim was sent → Vienna re-notifies the admin with the delta (old→new) +
audit entry. Non-material (name/contact/housekeeping) → no re-notify. Corrections BEFORE
the prelim → no re-notify (admin sees it in the first prelim).

### STILL OPEN — C01 admin-intake routing
EMERGENT-FIND-D (C01 admin_handoff persistence) remains a Franco/Porter disposition:
should Vienna set `admin_controlled=true` when `FromName="Admin"` sends the initial
intake (vs only on link-submission flip / per-deal pause)? C01 was NOT in the Franco-9
set; carried forward as the one remaining product-design open item. Surfaces again in
BATCH 8's re-run as a mismatch for empirical classification.

---

## BATCH 12 — LIST-C OUTCOME + HELD CATEGORIES (2026-05-29)

LIST-C reality-checked against actual code/fixtures (per-category Franco-rule fingerprint
grep, not raw BATCH-8 fail count). The "~85 stale-spec" estimate was a ~10:1 over-count by
raw-failure metric (see PHASE8 carry-forward). Genuine surgical updates applied; the rest
are HELD with explicit re-verification triggers, or were no-ops.

### Applied (surgical set)
- **LIST-C-VERIFICATION-SURFACE-BROKER-CORRECTION** (harness machinery, 0c826b9) — assertEngine
  broker_correction surface (PRIMARY=Q10 notice+ack, SECONDARY=extracted_data, NOT Snapshot re-render).
- **LIST-C-Q10-RENOTIFY** — A01/A13 (verified end-to-end) + C07/A34 (per probe). Adds the Q10
  `admin_material_correction_notice` + broker_correction `verification_profile`.
- **LIST-C-VERIFICATION-SURFACE-MISC** — A03 transaction_type casing, F23 province gate-form.

### Categories with ZERO genuine updates (over-count — no stale fingerprint)
- **Q6 chase-4** — no expected.json encodes a reminder count / auto-close. Chase emails fail
  in BATCH-8 only because replay doesn't fast-forward the reminder cron (harness-temporal).
- **Q7 non-Canadian** — E30/A12 already expect declines; Q7's property-scoping doesn't change them.

### HELD — pending Bug-3 fix + clean BATCH-13 re-run
- **Q1 escalation-pattern (cat 1)** — escalation scenarios (A02/A11/A14/A15/A19/A21/A22/A23/A25/
  A30/B02/B04/B07/C03/D03/E12/E14/E15/E22 …) have a correct `wf=active` spec but a BATCH-8
  `awaiting_collateral` actual *entangled* with the Bug-3 extraction gap + premature-prelim
  (both corrupt the LTV that drives escalation). The stale dataset can't distinguish a genuine
  Franco-9 escalation from an artifact. **Re-verify in BATCH-13** (post-Bug-3, post-Finding-1b).
- **Q2 auto-decline-pattern (cat 2)** — same entanglement (>90 LTV needs correct loan/value).
  **Re-verify BATCH-13.**
- **A14 specifically** — intake "$500k against $880k property" is Bug-3 word-order territory;
  the escalation actual is ambiguous between Q1-correct and Bug-3-artifact, AND it hinges on the
  still-open **Finding-1b** (terse-"Refi" additive verification surface). Re-classify after Bug-3.
- **Combined-LTV / 2nd-mortgage spec updates** — E07/E08/A24/E13/E23/E28/E29/F03/F06/F07/F14
  (+ F04/F13 "any others scoped"). The Combined-LTV row is absent downstream of the Bug-3
  null loan amount. **Unblocks after Bug-3 ships (BATCH-14).** See BUG3-SCOPE.md.
- **Premature-prelim-resolved (cat 9)** — ORIGINAL PREMISE WAS WRONG: Phase-1 threading does
  NOT make broker_correction render values update (Vienna intentionally does not re-render the
  Snapshot post-correction; that's why Q10 exists). The render assertions for broker_correction
  scenarios resolve via the harness-side broker_correction surface (above), NOT via expected.json
  edits expecting a non-existent re-render.

### NEW-VIENNA-FINDINGS surfaced by BATCH-12 live-fire probes (→ BATCH 14)
- **Q5 corporate Snapshot row does NOT render** (F03 probe: clean corporate prelim "Webb Holdings
  Ltd. — 65% LTV", no Corporate-borrower row). Detector + threading both correct; render-time
  borrower_name plumbing evidently doesn't deliver the corporate string. **Q5 expected.json NOT
  written.** BATCH-14 trace.
- **Q8 joint-applicants row does NOT render** for joint-via-name deals (E11/E12/F12 probes:
  prelim fires with both names in the subject, no Joint Applicants row). Root: `detectJointMultiBorrower`
  requires 2+ credit-bureau docs with distinct names; these fixtures express joint via the
  borrower_name conjunction + joint NOA (no credit reports). **Q8 expected.json NOT written.**
  BATCH-14: broaden the joint feed (or a Franco disposition on what "joint" requires).
- **Q9 admin-override (C06)** — HELD; shipped unit-only like Q5/Q8, multi-turn. Needs BATCH-13
  live-fire before writing the spec (not asserted blind given Q5/Q8 both failed live-fire).

### BANKED Franco product-design questions (Phase-8 closeout cluster — NOT asked now)
Both route during Phase 8 docs closeout (cluster-routed when the closeout text is ready):
- **Q8-DETECTION-MECHANISM** — Should Q8 joint-applicant detection trigger on the intake
  NAME-CONJUNCTION (the BATCH-12 conservative broadening, FRANCO-PREDICTED-Q8-EXTENSION
  75d91e2), or wait for credit-bureau-doc confirmation? Shipped with the conservative
  name-conjunction broadening (display-only; does not affect existing-mortgage suppression);
  revertible if Franco prefers doc-confirmation-only. Pairs with the original Q8 b20b7cd.
- **C01-ADMIN-INTAKE-DISPOSITION** — still durably open from the original 9 (admin_handoff
  persistence when FromName="Admin" sends the initial intake). Routes alongside
  Q8-DETECTION-MECHANISM in the Phase-8 closeout.
