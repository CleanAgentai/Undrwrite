// Group MMMM (S3.1/S3.2): canonical purchase vs refinance/non-purchase
// classification. Pre-MMMM was a loose /purchas/ substring regex over
// loan_type + purpose, duplicated across webhook.js, ai.js (two sites),
// and cron/dailySummary.js. Production failure (Derek Olsen 2026-05-16,
// deal b1ba76b0): purpose "Business working capital and equipment
// purchase" matched the regex despite being a second-mortgage refinance.
// The substring match treated "equipment purchase" as a real-property
// purchase signal, which made intakeRequiredFor() return the purchase
// checklist (with Purchase Contract + Down Payment Proof), which never
// arrived for a refinance, which kept allDocsInNow=false, which made
// computeCompletionDispatch return null, which made willReview re-fire
// after admin had already approved → second prelim review for Derek
// (S3.3/S3.4).
//
// Post-MMMM:
//   - Primary signal: Claude's structured is_purchase boolean field on
//     dealSummary (emitted by processInitialEmail + re-evaluated by
//     generateBrokerResponse each turn). Authoritative when present.
//   - Fallback: context-anchored regex covering both word orderings
//     ("home purchase" / "purchase of a home"). Tightened to NOT match
//     "equipment purchase" / "purchase of materials" / similar non-
//     property usages. Strong-signal-only: bias toward FALSE when
//     ambiguous — false is the safer default (most deals are refinances;
//     a false-negative just means Vienna doesn't ask for Purchase
//     Contract on a real purchase, which Claude's structured signal
//     reliably covers anyway).
//
// Single source of truth for purchase/refinance — eliminates the four-
// site regex duplication that drift-risks the original bug.

// Property nouns that signal real-property acquisition. Excludes
// "equipment" / "materials" / "supplies" / "vehicles" which appear in
// non-property "purchase" contexts (Derek's bug shape).
const PROPERTY_NOUN_RE = /(?:home|house|condo|townhouse|townhome|duplex|residential|property)/i;

const isPurchaseFromSummary = (summary) => {
  // Primary: Claude's structured signal. Authoritative when present.
  if (typeof summary?.is_purchase === 'boolean') return summary.is_purchase;

  // Fallback for pre-MMMM deals: context-anchored patterns.
  const purpose = (summary?.purpose || '').toLowerCase();

  // Pattern A: "<property-noun> purchase" — e.g. "home purchase",
  // "property purchase".
  if (new RegExp(`\\b${PROPERTY_NOUN_RE.source}\\s+purchase\\b`, 'i').test(purpose)) return true;

  // Pattern B: "purchase of [0-4 intermediate tokens] <property-noun>"
  // — covers "purchase of a home", "purchase of new home", "purchase of
  // investment property", "purchase of my first home in Edmonton" etc.
  if (new RegExp(`\\bpurchase\\s+of\\s+(?:\\S+\\s+){0,4}${PROPERTY_NOUN_RE.source}\\b`, 'i').test(purpose)) return true;

  // Pattern C: "purchase price" — strong purchase-loan-doc signal.
  if (/\bpurchase\s+price\b/i.test(purpose)) return true;

  // Pattern D: "down payment" / "downpayment" — purchase-loan-only
  // concept. Refinances don't have down payments.
  if (/\bdown[\s-]?payment\b/i.test(purpose)) return true;

  return false;
};

// ════════════════════════════════════════════════════════════════
// Group KKKK (S1.1/S2.1/S5.1): SSS-era doc-requirement helpers hoisted from
// webhook.js into this canonical module. Pre-KKKK these lived in webhook.js;
// the AML/PEP-bundling bug in generateDocumentRequestEmail (which has been
// counted "fixed" three times across rounds) needs access to the same
// intakeRequiredFor + isDocRequirementSatisfied predicates from ai.js. ai.js
// can't require webhook.js (circular — webhook.js already requires ai.js),
// so the helpers move here. webhook.js imports + re-exports via __test__
// for backward compat with existing SSS/NNN/CCCC/EEEE/JJJJ test references.
//
// Why "addressed three times" hasn't held:
//   - JJJ (S12.2) moved AML/PEP OUT of the intake welcome email. Pre-JJJ
//     Vienna asked for AML/PEP at first contact. Post-JJJ they moved to
//     post-approval via generateDocumentRequestEmail. JJJ did NOT gate the
//     complianceDocs block inside generateDocumentRequestEmail.
//   - SSS (S3.2) made the COMPLETION gate two-tier — allRequiredForCompletion
//     = intake + compliance — so completion-handoff waits for AML+PEP. SSS
//     did NOT gate the complianceDocs block; SSS fixed WHEN completion fires,
//     not WHEN AML/PEP get requested.
//   - Each round verified "AML/PEP eventually requested" (which they were,
//     bundled with intake), missing Franco's actual rule: intake items first,
//     AML/PEP as a separate request once intake completes.
//   - KKKK adds the missing layer — an explicit allIntakeReceived predicate
//     that gates the complianceDocs block. Shape-asserting tests (D1 intake-
//     incomplete → output has NO AML/PEP; D2 intake-complete → output has
//     AML+PEP) replace the "AML/PEP eventually appear" pattern that hid the
//     bug. Close criterion is Franco's retest passing.
//
// Document-type synonyms — for the requirement-satisfaction filter, certain
// doc types satisfy other required items (e.g. 'noa' satisfies 'income_proof').
// Map structure makes future equivalences trivial to add.
const DOC_SYNONYMS = {
  income_proof: ['income_proof', 'noa'],
};

const isDocRequirementSatisfied = (req, classifications) => {
  const accepted = DOC_SYNONYMS[req] || [req];
  return accepted.some(c => (classifications || []).includes(c));
};

// Two-tier required-doc model (SSS). Intake (Tier 1) is what gets asked
// pre-approval (welcome email + prelim review missing-docs list). Compliance
// (Tier 2) is post-approval — broker compliance forms required for funding.
const BASE_REQUIRED_INTAKE_REFINANCE = [
  'government_id', 'appraisal', 'property_tax', 'mortgage_statement',
  'income_proof', 'credit_report',
];
const BASE_REQUIRED_INTAKE_PURCHASE = [
  'government_id', 'appraisal', 'property_tax',
  'income_proof', 'credit_report', 'purchase_contract',
];
const COMPLIANCE_REQUIRED_POSTAPPROVAL = ['aml', 'pep'];

const intakeRequiredFor = (isPurchase) =>
  isPurchase ? BASE_REQUIRED_INTAKE_PURCHASE : BASE_REQUIRED_INTAKE_REFINANCE;

const allRequiredForCompletion = (isPurchase) => [
  ...intakeRequiredFor(isPurchase),
  ...COMPLIANCE_REQUIRED_POSTAPPROVAL,
];

// Group KKKK gate predicate: "all intake docs (Tier 1) satisfied?"
// Used by generateDocumentRequestEmail to decide whether to bundle AML/PEP
// (Tier 2) with the doc-request to broker. Pre-KKKK the complianceDocs
// block was unconditionally appended for broker deals; post-KKKK it's
// gated behind this predicate. When intake-incomplete → request asks for
// intake only; when intake-complete → request asks for AML+PEP as the
// remaining items.
//
// Synonym-aware via isDocRequirementSatisfied (e.g. 'noa' satisfies
// 'income_proof'). Purchase/refinance-aware via intakeRequiredFor.
const allIntakeReceived = (classifications, isPurchase) =>
  intakeRequiredFor(isPurchase).every(req =>
    isDocRequirementSatisfied(req, classifications || [])
  );

// SINGLE SOURCE OF TRUTH for "what intake items are still outstanding?" (Franco
// Round-9, Katherine Morrison). Pre-this, the admin preliminary review computed
// the accurate missing-docs list inline (intakeRequiredFor − satisfied, + a null
// exit_strategy) while the broker-facing reply used a SEPARATE narrow heuristic
// (computeStillMissingForReview: only "a reviewable doc" + exit_strategy) — so the
// broker reply didn't know what admin knew and could declare a file "complete"
// while gov ID / property tax / payout were outstanding. This helper is now the
// ONE computation both consumers call, by construction eliminating that divergence.
// Returns classification KEYS (+ the non-document 'exit_strategy' sentinel) ordered
// per the requirement list; callers map to display names via DOC_DISPLAY_NAMES /
// the broker-facing phrase map. Synonym-aware (NOA satisfies income_proof) and
// purchase/refinance-aware via the shared predicates above.
const computeMissingIntakeItems = ({ classifications, isPurchase, exitStrategy }) => {
  const missing = intakeRequiredFor(isPurchase)
    .filter(req => !isDocRequirementSatisfied(req, classifications || []));
  if (!exitStrategy || !String(exitStrategy).trim()) missing.push('exit_strategy');
  return missing;
};

module.exports = {
  // MMMM
  isPurchaseFromSummary,
  PROPERTY_NOUN_RE,
  // SSS-era (hoisted by KKKK)
  DOC_SYNONYMS,
  isDocRequirementSatisfied,
  BASE_REQUIRED_INTAKE_REFINANCE,
  BASE_REQUIRED_INTAKE_PURCHASE,
  COMPLIANCE_REQUIRED_POSTAPPROVAL,
  intakeRequiredFor,
  allRequiredForCompletion,
  // KKKK
  allIntakeReceived,
  // Round-9 (Katherine Morrison): single source of truth for outstanding intake items
  computeMissingIntakeItems,
};
