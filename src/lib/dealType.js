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

module.exports = { isPurchaseFromSummary, PROPERTY_NOUN_RE };
