// ─────────────────────────────────────────────────────────────────────────
// Cluster B — discrepancy-engine
// ─────────────────────────────────────────────────────────────────────────
// Consumes the canonical-field map from canonical-fields.js and emits a
// structured discrepancy set used by the bidirectional gate.
//
// CROSS-CATEGORY PROTECTION: only values WITHIN a single canonical field
// are compared. Two distinct canonical fields are never cross-compared,
// even when both contain numerics. This is the B-category fix —
// existing_mortgage_balance ≠ loan_amount_requested ≠
// existing_mortgage_payout_total, by design.
//
// PARTITIONED FIELDS: existing_mortgage_balance and
// existing_mortgage_payout_total partition on lender_canonical. RBC's
// $400K balance and Scotiabank's $318K balance are NOT compared — they
// describe different mortgages.
//
// NOT WIRED in Commit 1 — this commit ships extraction + computation +
// deterministic tests + the clean-corpus FP measurement. Wiring into
// processInitialEmail / generateBrokerResponse / generateLeadSummary
// + structural enforcement (PURE JS injection per Cluster E lesson)
// land in Commit 2 after Commit 1's 0-FP gate clears empirically on
// the artifact-verified clean corpus.

const cf = require('./canonical-fields');
// S15-E lives in ai.js. Late-require to avoid circular import (ai.js doesn't yet
// require discrepancy-engine in Commit 1; will in Commit 2 wiring).
let _aiServiceForS15;
const getS15Detector = () => {
  if (_aiServiceForS15 === undefined) {
    try { _aiServiceForS15 = require('./ai').isIdentityClashByAbsence; }
    catch { _aiServiceForS15 = null; }
  }
  return _aiServiceForS15;
};

// Fields with categorical partitioning (compare only within partition).
const PARTITIONED_FIELDS = new Set(['existing_first_mortgage_balance', 'existing_first_mortgage_payout_total']);

// Per-field equality predicate after normalization.
// Returns true if the two values should be treated as equal under the
// canonical-field's normalization. Each value is already a normalized
// form coming out of the extractor.
// Per-field numeric tolerance — domain-aware comparison granularity.
// Bounded structural iteration (pilot v3 → v4):
//   - subject_property_market_value: 5% tolerance. Brokers regularly estimate
//     ("~$620K"); appraisals come back precise. UUU prompt rule defines 10%
//     for HEDGED email values; 5% applied UNIVERSALLY here is conservative
//     enough to catch material deltas (10-25% in corpus) while clearing
//     small hedge-equivalent deltas (0.8-2.5%).
//   - existing_first_mortgage_balance: 1% tolerance. Credit bureaus round
//     balances to the nearest hundred/thousand; mortgage statements report
//     exact-to-the-cent. A $150 delta on $290K (0.05%) is rounding, not
//     a discrepancy. >$3000 / 1% on a typical mortgage IS a discrepancy.
//   - subject_property_assessment_value / existing_first_mortgage_payout_total /
//     requested_loan_amount: exact (these are precise figures by domain
//     definition — assessment notice, payout calc, loan ask).
const NUMERIC_TOLERANCE_PCT = {
  subject_property_market_value: 0.05,
  existing_first_mortgage_balance: 0.01,
};

const valuesEqual = (field, a, b) => {
  if (a === b) return true;
  if (a == null || b == null) return false;
  switch (field) {
    case 'subject_property_market_value':
    case 'subject_property_assessment_value':
    case 'requested_loan_amount':
    case 'existing_first_mortgage_balance':
    case 'existing_first_mortgage_payout_total': {
      const an = Number(a), bn = Number(b);
      if (an === bn) return true;
      const tol = NUMERIC_TOLERANCE_PCT[field] || 0;
      if (tol <= 0) return false;
      const max = Math.max(Math.abs(an), Math.abs(bn));
      if (max === 0) return false;
      return Math.abs(an - bn) / max <= tol;
    }
    case 'subject_property_postal_code':
      return cf.normalizePostal(a) === cf.normalizePostal(b);
    case 'subject_property_address':
      return cf.normalizeAddress(a) === cf.normalizeAddress(b);
    case 'existing_first_mortgage_lender':
      return String(a).toUpperCase() === String(b).toUpperCase();
    case 'primary_borrower_full_name': {
      const ta = cf.tokenizeNameForCompare(a);
      const tb = cf.tokenizeNameForCompare(b);
      if (ta.length < 2 || tb.length < 2) return false;
      return ta[0] === tb[0] && ta[ta.length - 1] === tb[tb.length - 1];
    }
    default:
      return String(a) === String(b);
  }
};

// For a single canonical field, group tuples by normalized value into
// equivalence classes. Returns an array of { value, sources, lender? }
// groups. If >1 group exists → it's a discrepancy candidate.
const groupTuples = (field, tuples) => {
  const groups = [];
  for (const t of tuples || []) {
    if (t.value == null) continue;
    let found = null;
    for (const g of groups) {
      if (PARTITIONED_FIELDS.has(field)) {
        // Partition on lender_canonical first.
        if ((g.lender || null) !== (t.lender_canonical || null)) continue;
      }
      if (valuesEqual(field, g.value, t.value)) {
        found = g;
        break;
      }
    }
    if (found) {
      found.sources.push(t.source);
      if (t.raw && !found.raws.includes(t.raw)) found.raws.push(t.raw);
    } else {
      groups.push({
        value: t.value,
        sources: [t.source],
        raws: t.raw ? [t.raw] : [],
        lender: t.lender_canonical || null,
      });
    }
  }
  return groups;
};

// Compute discrepancy set across all canonical fields.
// Returns array of:
//   { field, lender? (for partitioned), groups: [{ value, sources, raws }+] }
// Only fields where ≥2 distinct groups exist (within a partition for
// partitioned fields) are emitted.
const computeDiscrepancySet = (canonicalMap) => {
  const out = [];
  for (const [field, tuples] of Object.entries(canonicalMap || {})) {
    if (PARTITIONED_FIELDS.has(field)) {
      // Partition tuples by lender_canonical, then group within each partition.
      const byPartition = new Map();
      for (const t of tuples || []) {
        const key = t.lender_canonical || '__unknown__';
        if (!byPartition.has(key)) byPartition.set(key, []);
        byPartition.get(key).push(t);
      }
      for (const [partitionKey, partTuples] of byPartition.entries()) {
        const groups = groupTuples(field, partTuples);
        if (groups.length >= 2) {
          out.push({ field, lender: partitionKey === '__unknown__' ? null : partitionKey, groups });
        }
      }
    } else {
      const groups = groupTuples(field, tuples || []);
      if (groups.length >= 2) {
        out.push({ field, groups });
      }
    }
  }
  return out;
};

// ════════════════════════════════════════════════════════════════════
// Cluster B Commit 2 — separability (objective vs calibration-gated)
// ════════════════════════════════════════════════════════════════════
// Per the Commit 2 plan: market-value / numeric-tolerance discrepancies
// are NOT broker-facing until Franco calibrates the threshold. Admin
// Snapshot still shows full transparency (both sources visible). This
// gate filters the broker-facing emission only.
const MARKET_DELTA_FIELDS = new Set([
  'subject_property_market_value',
  'subject_property_assessment_value',
  'existing_first_mortgage_balance',
  'existing_first_mortgage_payout_total',
  'requested_loan_amount',
]);

const filterBrokerFacing = (discrepancySet, opts = {}) => {
  const { marketDeltaFlagsEnabled = false } = opts;
  if (marketDeltaFlagsEnabled) return discrepancySet.slice();
  return discrepancySet.filter(e => !MARKET_DELTA_FIELDS.has(e.field));
};

// ════════════════════════════════════════════════════════════════════
// Commit 2 — broker-side discrepancy section renderer (pure JS)
// ════════════════════════════════════════════════════════════════════
// Generates the discrepancy clarification section verbatim from the
// canonical-field-derived discrepancy set. Vienna's prompt is instructed
// to NOT generate this content; JS owns it.
const renderDiscrepancySection = (discrepancySet) => {
  if (!discrepancySet || discrepancySet.length === 0) return '';
  const bullets = discrepancySet.map(e => '<li>' + renderDiscrepancyBullet(e) + '</li>').join('\n');
  const intro = discrepancySet.length === 1
    ? '<p>I noticed an item that needs clarification before we move forward:</p>'
    : discrepancySet.length === 2
      ? '<p>I noticed a couple of items that need clarification before we move forward:</p>'
      : '<p>I noticed a few items that need clarification before we move forward:</p>';
  return `${intro}\n<ul>\n${bullets}\n</ul>\n<p>Could you confirm those details so we have accurate information on file?</p>`;
};

// ════════════════════════════════════════════════════════════════════
// Commit 2 — admin Deal Snapshot renderer (pure JS, symmetric with broker)
// ════════════════════════════════════════════════════════════════════
// Generates the entire Deal Snapshot block from the canonical-field map.
// Vienna's generateLeadSummary prompt is instructed to NOT generate the
// Snapshot — JS owns this block in full.
//
// Admin transparency: when a canonical field has multiple distinct values
// (a real discrepancy), the row shows BOTH values with their sources —
// admin sees the full picture regardless of the broker-facing calibration
// gate. The discrepancy is visible to admin even when not broker-facing.

// Derive city/province from a normalized address string.
// Heuristic: address pattern "<num> <name> <suffix>, <city>, <prov> <postal>"
// or concatenated equivalents. Conservative — returns null if unable to parse.
// R6-δ (2026-05-21): two-tier semantic. Accepts either:
//   (a) a canonical_map object — prefer canonical_map.subject_property_city +
//       canonical_map.subject_property_province tuples populated by R6-δ's
//       extractFromEmailBody (informal "X property at <street>" pattern +
//       inline "<street>, City, Prov, postal" pattern).
//   (b) a normalized-address string — legacy contract; regex-parses the
//       embedded ", City, Prov" or " City Prov" trailing portion.
// Backward-compat: existing string callers continue to work; new
// renderDealSnapshot wiring passes the canonical_map first.
// R10-D (2026-05-27): R6-δ deferred-residual CLOSED — pre-R10-D this docblock
// flagged "Province may be null on the informal-pattern path (Q3-verdict
// residual — no city→province lookup table)." canonical-fields.js now pushes
// inferred province tuples via inferProvinceFromAddressSignals (postal-FSA
// primary, city-name fallback) when no doc-source province tuple exists.
// canonical_map.subject_property_province is now populated for the
// informal-pattern path; 'TBD' fallback below only fires when neither postal
// nor city signal yields a recognized province (edge cases only).
const deriveCityProvince = (input) => {
  if (!input) return null;
  // (a) canonical_map shape — has subject_property_city array OR fallback to
  //     address tuples for the legacy regex.
  if (typeof input === 'object' && !Array.isArray(input)) {
    const cityTuples = input.subject_property_city || [];
    const provinceTuples = input.subject_property_province || [];
    const city = cityTuples.find(t => t.value)?.value || null;
    const province = provinceTuples.find(t => t.value)?.value || null;
    if (city) return { city, province: province || 'TBD' };
    // Fall through to regex-parse via the first address tuple value.
    const addressTuples = input.subject_property_address || [];
    for (const t of addressTuples) {
      const r = deriveCityProvince(t.value);
      if (r) return r;
    }
    return null;
  }
  // (b) string shape — legacy regex.
  const m = input.match(/,\s*([a-z][a-z\s'\-]+?),\s*(ab|bc|sk|mb|on|qc|nb|ns|pe|nl|nt|yt|nu)\b/i)
         || input.match(/\s([a-z][a-z\s'\-]+?)\s+(ab|bc|sk|mb|on|qc|nb|ns|pe|nl|nt|yt|nu)\b/i);
  if (!m) return null;
  const city = m[1].split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ').trim();
  const province = m[2].toUpperCase();
  return { city, province };
};

const formatMoney = (n) => '$' + Number(n).toLocaleString('en-US');

// Render a single Snapshot row. Handles single-value, multi-value-with-discrepancy,
// and missing cases. Uses canonical sources for source attribution.
const renderSnapshotRow = (label, tuples, opts = {}) => {
  const { format = 'string', suffix = '', fallback = null, fallbackLabel = null } = opts;
  const formatValue = (v) => format === 'money' ? formatMoney(v) : String(v) + suffix;
  if (!tuples || tuples.length === 0) {
    if (fallback && fallback.length > 0) {
      const v = formatValue(fallback[0].value);
      return `<p><strong>${label}:</strong> ${v}${fallbackLabel ? ' (' + fallbackLabel + ')' : ''}</p>`;
    }
    return `<p><strong>${label}:</strong> TBD</p>`;
  }
  // Group by normalized value via valuesEqual
  // (assume tuples are within same canonical field — we don't know field name here,
  //  so we use a simpler dedup by string-stringified value).
  const groups = [];
  for (const t of tuples) {
    if (t.value == null) continue;
    const existing = groups.find(g => String(g.value) === String(t.value)
                                    && (g.lender || null) === (t.lender_canonical || null));
    if (existing) existing.sources.push(t.source);
    else groups.push({ value: t.value, sources: [t.source], lender: t.lender_canonical || null });
  }
  if (groups.length === 0) return `<p><strong>${label}:</strong> TBD</p>`;
  if (groups.length === 1) {
    return `<p><strong>${label}:</strong> ${formatValue(groups[0].value)}</p>`;
  }
  // Multiple distinct values — admin transparency: show all sources.
  const parts = groups.map(g => `${formatValue(g.value)} (per ${g.sources[0].replace(/\.pdf$/i, '').replace(/_/g, ' ')})`).join(' / ');
  return `<p><strong>${label}:</strong> ${parts}</p>`;
};

// R4-Bucket-C.4 (S4 Ryan): combined LTV for second-mortgage deals.
//
// Inputs sourced EXCLUSIVELY from B's already-anchored canonical-fields schema
// — no text parsing, no Claude calls, no extracted_data fallback. The function
// is a pure consumer of canonicalMap; an empty existing_first_mortgage_balance
// returns null (over-fire guard for clean first-mortgage deals).
//
// Field choice: existing_first_mortgage_balance, not payout_total. Three reasons:
//   1. Underwriting semantics: balance = principal owed on property (the actual
//      encumbrance). Payout total includes one-time discharge costs (penalty,
//      per-diem interest, discharge fee) that aren't permanent leverage.
//   2. S7-B2 same-category protection: B's discrepancy engine intentionally
//      separates balance from payout_total — using balance here honors B's
//      category boundary and protects S7-B2's same-category gate.
//   3. S4 pragmatic: S4 Ryan has NO payout statement (loan_type=2nd mortgage,
//      no mortgage_statement classification); credit-bureau Format A extracts
//      $385K balance. Using payout_total wouldn't compute for S4 at all.
//
// Over-fire guard (correctness req 2 — load-bearing): clean first-mortgage
// deals (credit bureau has no mortgage trade line) → existing balance is
// []  → return null. No Combined LTV row in Snapshot, no escalation injection.
// Verified against real Linda Okafor deal cf3f1db0 (purchase, zero credit-
// bureau mortgages).
//
// Fail-safe: null over a wrong figure. An underwriting number is too dangerous
// to fabricate from partial signals.
const computeCombinedLtv = (canonicalMap) => {
  const balances = (canonicalMap && canonicalMap.existing_first_mortgage_balance) || [];
  const loans = (canonicalMap && canonicalMap.requested_loan_amount) || [];
  const values = (canonicalMap && canonicalMap.subject_property_market_value) || [];
  if (balances.length === 0) return null;
  if (loans.length === 0 || values.length === 0) return null;
  const existing = balances[0].value;
  const requested = loans[0].value;
  const market = values[0].value;
  if (!Number.isFinite(existing) || !Number.isFinite(requested) || !Number.isFinite(market)) return null;
  if (market <= 0) return null;

  // R11-B-3 (2026-05-27): refinance LTV math carve-out. Consumes R11-A's
  // transaction_type canonical field. For refinance, the existing first
  // mortgage is BEING PAID OUT at closing — it's not additive leverage.
  // Combined LTV = standalone LTV (new mortgage IS the 1st position).
  //
  // Empirical anchor: Marcus Webb 8c404ae0 — broker stated "refinancing
  // his existing RBC first mortgage — the RBC will be paid out at closing."
  // Pre-R11-B-3 math: ($400k RBC + $408k requested) / $680k = 118.8%
  // (additive — wrong for refinance). Even with R11-B-2 correcting balance
  // source to mortgage_statement, the additive math still produces
  // structurally wrong combined LTV.
  // Post-R11-B-3 math: $408k / $680k = 60.0% (refinance-correct — existing
  // 1st paid out, new mortgage IS the 1st position; combined = standalone).
  //
  // LENDER MATCH MODES (mirrors R11-A inferMortgagePositionFromExistingBalance):
  //   (1) STRICT — broker rawPhrase names lender matching mortgage_statement
  //       source canonical lender. Tolerant of spelling variants via existing
  //       LENDER_SYNONYMS canonicalization (R6-γ + R9-D + R11-A).
  //   (2) IMPLICIT SINGLE-LENDER — broker says refinance WITHOUT naming
  //       lender AND mortgage_statement source has exactly ONE unique
  //       canonical lender → match by structural inference.
  //
  // Edge case preserved: refinance + new 2nd compound transaction (broker
  // refinancing existing 1st AND adding new 2nd) — covered by broker_
  // correction "2nd" mortgage_position tuple at canonical-map level
  // (R11-A's broker_correction suppression of derived signal handles this
  // separately).
  //
  // Backwards-compat: non-refinance transactions (transaction_type=null
  // OR transaction_type='2nd_mortgage' OR transaction_type='purchase')
  // get existing additive math preserved.
  const txnTypeTuples = (canonicalMap && canonicalMap.transaction_type) || [];
  const refinanceTuple = txnTypeTuples.find(t => t && t.value === 'refinance');
  // Shared lender-match test (R11-B-3 modes): STRICT (broker rawPhrase names a lender
  // matching the mortgage_statement source canonical lender) OR IMPLICIT SINGLE-LENDER
  // (no named lender + exactly one mortgage_statement lender). Used by BOTH carve-out
  // branches below.
  const refinanceLenderMatches = (() => {
    if (!refinanceTuple) return false;
    const payoutLenderCanonicals = Array.from(new Set(
      (canonicalMap.existing_first_mortgage_lender || [])
        .filter(t => t && t.classification === 'mortgage_statement' && t.value)
        .map(t => cf.normalizeLender(t.value)).filter(Boolean),
    ));
    const refinanceLenderInPhrase = cf.findLenderInWindow(refinanceTuple.rawPhrase || '');
    const strictMatch = refinanceLenderInPhrase && payoutLenderCanonicals.includes(refinanceLenderInPhrase);
    const implicitMatch = !refinanceLenderInPhrase && payoutLenderCanonicals.length === 1;
    return !!(strictMatch || implicitMatch);
  })();
  const carveOutStandalone = (existingSource) => {
    const standalone = (requested / market) * 100;
    return {
      combined_ltv_percent: Math.round(standalone * 10) / 10,
      components: {
        existing: 0, // refinance: existing first being paid out, treated as 0 for combined-LTV math
        requested,
        market,
        existing_source: existingSource,
        existing_lender: null,
        transaction_type: 'refinance',
      },
    };
  };
  // BRANCH 1 (FRANCO-Q1, 2026-05-28; PRESERVED as defense-in-depth): explicit payout
  // language (payoutConfirmed=true) + lender match → carve-out fires.
  if (refinanceTuple && refinanceTuple.payoutConfirmed === true && refinanceLenderMatches) {
    return carveOutStandalone('refinance-paid-out');
  }
  // BRANCH 2 (FRANCO-Q1-RULE-REFINEMENT, Franco 2026-05-30): a CONFIDENTLY-determined
  // refinance implies payout — "refinance and pay-out the existing mortgage are the same
  // thing." So refinance + refinanceConfident + lender match → carve-out fires WITHOUT
  // requiring explicit payout language. SUPERSEDES the BATCH-13 "require explicit payout"
  // reading (which escalated ~33% of deals). The confidence guards (ambiguous refi-vs-
  // purchase, explicit non-payout contraindication) are tagged at extraction and leave
  // those cases on the additive path below → escalate for clarification (the safety case).
  if (refinanceTuple && refinanceTuple.refinanceConfident === true && refinanceLenderMatches) {
    return carveOutStandalone('refinance-implicit-payout');
  }

  const combined = ((existing + requested) / market) * 100;
  return {
    combined_ltv_percent: Math.round(combined * 10) / 10,
    components: {
      existing,
      requested,
      market,
      existing_source: balances[0].source,
      existing_lender: balances[0].lender_canonical || null,
    },
  };
};

// Canonical STANDALONE LTV (new loan / market value) from the resolved-winner
// canonical tuples. [0] is the R10-G source-hierarchy winner (broker_correction
// > broker_initial_intent > docs), same indexing as computeCombinedLtv's
// loans[0]/values[0]. Deterministic — the JS-canonical standalone, NOT the
// LLM's extracted_data.ltv_percent.
//
// Why this exists (Bug 1, 2026-05-28): the LLM is prompted to store only a
// broker-STATED ltv_percent (ai.js: "Do NOT calculate LTV yourself ... store
// that number or null"), but empirically computes it ADDITIVELY for refinances
// (existing + new / market), mislabeling combined leverage as standalone. The
// escalation/prelim/form gates consumed that LLM value → a clean 56% refinance
// (existing 1st paid out) wrongly escalated for collateral at "103% LTV". This
// helper gives the gates the canonical standalone, mirroring the existing R9-B
// canonical-LTV display discipline (webhook.js:1127 — Snapshot already uses
// JS-canonical, not LLM, LTV). Completes R11-B-3: that fix corrected the
// canonical combined-LTV MATH; this routes the GATES to canonical instead of
// the LLM value.
const computeStandaloneLtv = (canonicalMap) => {
  const loans = (canonicalMap && canonicalMap.requested_loan_amount) || [];
  const values = (canonicalMap && canonicalMap.subject_property_market_value) || [];
  if (loans.length === 0 || values.length === 0) return null;
  const requested = loans[0].value;
  const market = values[0].value;
  if (!Number.isFinite(requested) || !Number.isFinite(market) || market <= 0) return null;
  return Number(((requested / market) * 100).toFixed(1));
};

// ──────────────────────────────────────────────────────────────────────────
// R4-RESIDUAL-1: Combined-LTV escalation trigger (closes C.4 (c) residual)
// ──────────────────────────────────────────────────────────────────────────
// Pre-fix: escalation gates keyed ONLY on dealSummary.ltv_percent (standalone).
// Gap: 2nd mortgage with standalone LTV ≤80 but combined LTV >80 did NOT
// auto-escalate. Dangerous direction — system never flagged the over-
// leveraged file.
//
// Fix: ADDITIVE trigger. Anything escalating today on standalone STILL
// escalates (no replacement, no regression). Combined-LTV-over-threshold
// adds a SECOND escalation reason. Null combined (clean first-mortgage,
// Linda-shape: existing_first_mortgage_balance=[]) → falls back to
// standalone-only (no over-fire on clean borrowers — preserves C.4's
// inverse-bug protection).
//
// COMBINED_LTV_ESCALATION_THRESHOLD_PCT is FRANCO-CALIBRATION-PENDING:
// shipped at conservative default (80%, matches standalone threshold).
// Lender's call on the actual threshold — adjust after Franco's first
// batch of combined-LTV-triggered escalations confirms or recalibrates.
const COMBINED_LTV_ESCALATION_THRESHOLD_PCT = 80;

const shouldEscalateOnAnyLtv = ({ standaloneLtv, combinedLtv, standaloneThreshold, combinedThreshold } = {}) => {
  const stdT = (standaloneThreshold !== undefined && standaloneThreshold !== null) ? standaloneThreshold : 80;
  const cmbT = (combinedThreshold !== undefined && combinedThreshold !== null) ? combinedThreshold : COMBINED_LTV_ESCALATION_THRESHOLD_PCT;
  const stdHit = Number.isFinite(standaloneLtv) && standaloneLtv > stdT;
  // Null combined → fall back to standalone-only (no over-fire on clean
  // first-mortgage deals where existing_first_mortgage_balance is absent).
  const cmbHit = Number.isFinite(combinedLtv) && combinedLtv > cmbT;
  return stdHit || cmbHit;
};

// BUG-4 (BATCH 14, 2026-05-29): canonical-incompleteness escalation guard
// (defense-in-depth, Bug-1 lineage). Returns true when the canonical state is
// SUSPECT-INCOMPLETE for a deal that SHOULD be combined-LTV-evaluatable:
//   - an existing-mortgage doc (mortgage_statement) is on file → a combined LTV
//     is expected to be computable, AND
//   - combinedLtv came back null (the canonical state couldn't produce it), AND
//   - payoutConfirmed === false (the null is NOT the legitimate Q1 payout carve-out
//     — for a payout-confirmed refi, combined==null is correct), AND
//   - a loan amount is present (the null is NOT "no loan to evaluate against").
// Silently falling through to 'active' on this state is underwriting-DANGEROUS
// (a deal whose true combined leverage was never evaluated could reach an approval
// path); escalating for clarification is RECOVERABLE (broker confirms, deal proceeds).
// ASYMMETRIC-RISK: the conservative direction is durably correct even if the rare
// upstream transient (F03/A33 canonical-state-incompleteness) is later root-caused.
// VERIFICATION NOTE: the production transient is rarer than any repetition probe can
// reliably reproduce (F03 escalates ~85% without this guard), so empirical "always
// escalates" CANNOT validate the fix — this PURE function's unit harness is the
// deterministic verification surface; production-transient elimination is a
// defense-in-depth claim, not an empirically-provable one.
const shouldEscalateOnIncompleteCanonical = ({ hasMortgageStatement = false, combinedLtv = null, payoutConfirmed = false, hasLoanAmount = false } = {}) => {
  return !!(hasMortgageStatement && combinedLtv == null && !payoutConfirmed && hasLoanAmount);
};

// FRANCO-Q2 (2026-05-28): >90% LTV auto-decline. Franco's tier: <=80 normal,
// 80-90 escalate (existing), >90 AUTO-DECLINE. Uses CANONICAL LTV (Bug-1 gate-
// hygiene continuation). STRICT > 90: 90.0 does NOT decline; 90.01 does.
// Standalone is always reliable. Combined is used ONLY when its payout status is
// RESOLVED — otherwise the provisional additive combined of an UNCONFIRMED
// refinance (e.g. A14's 103%) would wrongly auto-decline a deal that should first
// escalate for payout clarification (Q1). isCombinedLtvResolved gates that.
const AUTO_DECLINE_LTV_THRESHOLD_PCT = 90;

// Combined LTV is "resolved" (trustworthy as true leverage) when payout status is
// settled: carve-out fired (payoutConfirmed refinance → combined==standalone), OR
// an explicit 2nd-mortgage signal (transaction_type=2nd_mortgage / broker '2nd'
// position correction) → combined is genuinely additive. Unresolved → escalate, no decline.
const isCombinedLtvResolved = (canonicalMap) => {
  const tt = (canonicalMap && canonicalMap.transaction_type) || [];
  const payoutResolved = tt.some(t => t && t.value === 'refinance' && t.payoutConfirmed === true);
  const explicit2nd = tt.some(t => t && t.value === '2nd_mortgage');
  const pos2nd = ((canonicalMap && canonicalMap.mortgage_position) || [])
    .some(t => t && t.classification === 'broker_correction' && /2nd|second/i.test(String(t.value)));
  return payoutResolved || explicit2nd || pos2nd;
};

const shouldAutoDeclineOver90 = ({ standaloneLtv = null, combinedLtv = null, combinedResolved = false } = {}) => {
  if (Number.isFinite(standaloneLtv) && standaloneLtv > AUTO_DECLINE_LTV_THRESHOLD_PCT) {
    return { decline: true, basis: `standalone LTV ${standaloneLtv}% > ${AUTO_DECLINE_LTV_THRESHOLD_PCT}` };
  }
  if (combinedResolved && Number.isFinite(combinedLtv) && combinedLtv > AUTO_DECLINE_LTV_THRESHOLD_PCT) {
    return { decline: true, basis: `combined LTV ${combinedLtv}% > ${AUTO_DECLINE_LTV_THRESHOLD_PCT} (payout status resolved)` };
  }
  return { decline: false, basis: null };
};

// R10-C-2 (2026-05-27): LTV-band classifier. Closes contract Schedule A
// Stage 1 LTV-routing three-band specification at MVP level.
//
// Contract Schedule A Stage 1 spec:
//   - LTV ≥ 80%  → REJECTION band  (mapped to 'over_80'; current MVP
//                                   preserves the existing soft-rejection
//                                   front door via collateral-question
//                                   workflow rather than strict auto-reject;
//                                   see generateHighLtvCollateralAsk
//                                   docblock in ai.js for the deferred-
//                                   residual flag re: strict-spec literal
//                                   interpretation pending Franco
//                                   product-design call)
//   - 75% ≤ LTV < 80% → MANUAL REVIEW band ('elevated_75_80'; MVP surface
//                                   is Risk Factors callout in admin-
//                                   facing prelim + welcomeEmail
//                                   acknowledgment via prompt-context
//                                   hint. Deeper state-machine surface
//                                   deferred pending production fixture
//                                   need OR Franco product-design call.)
//   - LTV < 75%  → AUTO-PROCEED band ('standard'; existing flow unchanged)
//
// CONSERVATIVE-MAX SEMANTIC — band classification uses max(standalone,
// combined) to mirror shouldEscalateOnAnyLtv's OR-of-thresholds gate.
// A deal with combined LTV in the >80% band AND standalone in the 75-80%
// band classifies as 'over_80' (the more conservative band).
//
// Architectural family — State-derived gate signal (2nd template family,
// 5th instance per R10-F lineage extension: BBBB + JJJJ + SSS + R10-F +
// R10-C-2). Pure function; signal threaded through generator selection
// (R10-C-1) and prelim Risk Factors rendering (R10-C-2 admin surface).
const computeLtvBand = ({ standaloneLtv, combinedLtv } = {}) => {
  const stdFinite = Number.isFinite(standaloneLtv);
  const cmbFinite = Number.isFinite(combinedLtv);
  if (!stdFinite && !cmbFinite) return 'standard'; // no LTV signal → can't classify; defer to existing gates
  const effective = Math.max(
    stdFinite ? standaloneLtv : -Infinity,
    cmbFinite ? combinedLtv : -Infinity,
  );
  if (effective > 80) return 'over_80';
  if (effective >= 75) return 'elevated_75_80';
  return 'standard';
};

const renderDealSnapshot = (canonicalMap, opts = {}) => {
  const { ownershipType = null, isCommercial = false, jointBorrowers = null, qualificationRoster = null, corporateEntities = null } = opts;
  const lines = [];

  // Property Address row — clean street address only.
  //
  // R11-C (2026-05-27) DESIGN INTENT CHANGE — Franco Round 7 retest Bug 4:
  // "If Vienna flags a postal code discrepancy, it should do so in the
  // discrepancies or risk factors section — not appended to the property
  // address field. The address field should contain only the clean street
  // address."
  //
  // Pre-R11-C this row inlined postal disambiguation when subject_property_
  // postal_code had multi-value:
  //   <p><strong>Property Address:</strong> 1142 tory road nw — postal codes
  //     differ: T6R3K2 (per email body) / T6R0S4 (per RBC Payout Statement
  //     Marcus Webb)</p>
  // Original docblock framed this as "transparency requirement for the
  // calibration-gated case — admin also needs to see the conflict on the
  // structured admin-review surface." Empirical signal from Marcus Webb
  // 8c404ae0 retest contradicts this design choice — Franco wants the
  // Property Address field clean.
  //
  // R11-C admin-visibility replacement: JS-deterministic injection of a
  // Risk Factors callout at the prelim render pipeline (see ai.js
  // injectPostalCodeDiscrepancyCallout — sibling to R10-C-2's
  // injectElevatedLtvBandCallout). EMPIRICALLY-CLOSE-LOOP DISCIPLINE
  // (15th methodology carry-forward) applied: Vienna's LLM-generated
  // narrative did NOT flag the postal-code discrepancy in Marcus's
  // production prelim (LLM cited lender/balance/loan-amount discrepancies
  // but NOT postal). JS-deterministic callout guarantees admin visibility;
  // pure LLM-narrative reliance would be probabilistic per R8-B.
  //
  // BROKER-FACING SURFACE UNCHANGED — broker-facing discrepancy section
  // already handles postal-code via existing renderDiscrepancyBullet +
  // FIELD_DISPLAY_NAMES.subject_property_postal_code ('the postal code').
  // filterBrokerFacing does NOT include postal-code in MARKET_DELTA_FIELDS
  // → broker-facing surface renders postal-code clarification when
  // multi-value. R11-C is admin-side scoped only.
  lines.push(renderSnapshotRow('Property Address', canonicalMap.subject_property_address));

  // City / Province — R6-δ two-tier: prefer canonical_map.subject_property_city
  // + subject_property_province tuples (populated by extractFromEmailBody's
  // informal + inline patterns); fallback to regex-parse the address tuple
  // value when those are empty (legacy path for cross-source docs that embed
  // city/province in the address line).
  const cityProv = deriveCityProvince(canonicalMap);
  if (cityProv) {
    lines.push(`<p><strong>City / Province:</strong> ${cityProv.city} / ${cityProv.province}</p>`);
  } else {
    lines.push(`<p><strong>City / Province:</strong> TBD</p>`);
  }

  lines.push(renderSnapshotRow('Loan Amount Requested', canonicalMap.requested_loan_amount, { format: 'money' }));
  lines.push(renderSnapshotRow('Mortgage Position', canonicalMap.mortgage_position));

  // Appraised Value with fallback to tax assessment
  lines.push(renderSnapshotRow('Appraised Value', canonicalMap.subject_property_market_value, {
    format: 'money',
    fallback: canonicalMap.subject_property_assessment_value,
    fallbackLabel: 'tax assessment — appraisal pending',
  }));

  // LTV — computed from canonical loan_amount + market_value (or assessment fallback)
  const loanTuples = canonicalMap.requested_loan_amount || [];
  const marketTuples = canonicalMap.subject_property_market_value || [];
  const assessmentTuples = canonicalMap.subject_property_assessment_value || [];
  const loan = loanTuples.length > 0 ? loanTuples[0].value : null;
  const value = marketTuples.length > 0 ? marketTuples[0].value : (assessmentTuples.length > 0 ? assessmentTuples[0].value : null);
  if (loan != null && value != null && value > 0) {
    const ltv = Math.round((loan / value) * 100);
    lines.push(`<p><strong>LTV:</strong> ${ltv}% (computed)</p>`);
  } else {
    lines.push(`<p><strong>LTV:</strong> TBD</p>`);
  }

  // R4-Bucket-C.4 (S4 Ryan): Combined LTV row — second-mortgage deals only.
  // Rendered immediately after the standard LTV row so admin sees BOTH figures
  // side-by-side: standard (new loan / appraised — what Vienna typically cites)
  // and combined (existing + new) / appraised — the true leverage. Math
  // suffix is for admin transparency / audit. computeCombinedLtv returns null
  // for clean first-mortgage deals (no existing_first_mortgage_balance) — no
  // row rendered, no over-fire. See helper docblock for field-choice rationale.
  const combined = computeCombinedLtv(canonicalMap);
  if (combined) {
    const c = combined.components;
    const lenderTag = c.existing_lender ? `${c.existing_lender} ` : '';
    lines.push(`<p><strong>Combined LTV (incl. existing 1st):</strong> ${combined.combined_ltv_percent}% — (${lenderTag}${formatMoney(c.existing)} + ${formatMoney(c.requested)}) / ${formatMoney(c.market)}</p>`);
  } else {
    // BUG-5 (BATCH 14): deterministic Existing 1st Mortgage Balance row. The existing
    // balance is underwriting-critical but had NO deterministic Snapshot surface when the
    // Combined-LTV row is absent — for REFINANCES the payout carve-out suppresses the
    // combined row, so the balance appeared ONLY in the LLM narrative (variable). A33's
    // rare "missing $410k" transient was exactly that narrative omission. When an existing
    // 1st mortgage IS indicated (refinance / 2nd-position / balance or lender on file) but
    // no combined row rendered, surface the balance deterministically — the canonical value,
    // or "TBD" if the canonical state is incomplete (visible-incompleteness > silent-omission;
    // asymmetric-risk, Bug-1/BUG-4 lineage). Not rendered for clean first-mortgage / purchase
    // deals (no existing-mortgage signal → no row, no noise).
    const _bug5HasBalance = (canonicalMap.existing_first_mortgage_balance || []).length > 0;
    const _bug5HasLender = (canonicalMap.existing_first_mortgage_lender || []).length > 0;
    const _bug5IsRefiOr2nd = ((canonicalMap.transaction_type || []).some(t => t && /refinance|2nd|second/i.test(String(t.value))))
      || ((canonicalMap.mortgage_position || []).some(t => t && /2nd|second/i.test(String(t.value))));
    if (_bug5HasBalance || _bug5HasLender || _bug5IsRefiOr2nd) {
      lines.push(renderSnapshotRow('Existing 1st Mortgage Balance', canonicalMap.existing_first_mortgage_balance, { format: 'money' }));
    }
  }

  lines.push(renderSnapshotRow('Loan Term Requested', canonicalMap.requested_loan_term_months, { suffix: ' months' }));
  // FRANCO-PREDICTED-Q8 (2026-05-28): surface joint/multi-borrower deals so
  // Franco sees the structure at a glance. detectJointMultiBorrower already
  // runs in runDiscrepancyDetection(Aggregated) but its result was previously
  // dropped before render (Discipline-2 gap). Threaded in via opts.jointBorrowers
  // (the joint_multi_borrower array of distinct borrower names, or null).
  if (Array.isArray(jointBorrowers) && jointBorrowers.length >= 2) {
    lines.push(`<p><strong>Joint Applicants:</strong> ${jointBorrowers.join(', ')} (${jointBorrowers.length} borrowers)</p>`);
  }
  // FRANCO-Q3/Q4 (2026-05-28): multi-party qualification disposition — show per-
  // borrower role so Franco sees the qualification structure (who's counted vs
  // guarantor-only), not just the joint roster. Threaded via opts.qualificationRoster
  // (borrower-qualification.buildQualificationRoster output).
  if (qualificationRoster && qualificationRoster.multiParty && Array.isArray(qualificationRoster.roster)) {
    const dispo = (r) => r.role === 'guarantor_only'
      ? `${r.name} — guarantor-only (liable on default; NOT counted toward qualification)`
      : `${r.name} — counted (${r.role === 'primary' ? 'primary' : 'co-applicant'})`;
    lines.push(`<p><strong>Qualification basis:</strong> combined across ${qualificationRoster.countingCount} borrower(s)</p>`);
    for (const r of qualificationRoster.roster) {
      lines.push(`<p>&nbsp;&nbsp;• ${dispo(r)}</p>`);
    }
    // FRANCO-Q4: surface unconfirmed-cosigner clarification on the admin surface.
    if (qualificationRoster.clarificationPending && qualificationRoster.clarificationMessage) {
      lines.push(`<p><strong>⚠ Cosigner role — clarification needed:</strong> ${qualificationRoster.clarificationMessage}</p>`);
    }
  }
  lines.push(`<p><strong>Borrower Type:</strong> ${isCommercial ? 'Corporate' : 'Personal'}</p>`);
  // FRANCO-Q5 (2026-05-28): corporate-borrower flag — entity count, per-entity
  // disposition, accountant-financials requirement, and multi-entity clarification.
  // Threaded via opts.corporateEntities (corporate-entities.detectCorporateEntities).
  if (corporateEntities && corporateEntities.isCorporate && Array.isArray(corporateEntities.allEntities)) {
    const n = corporateEntities.allEntities.length;
    lines.push(`<p><strong>Corporate borrower:</strong> ${n} entit${n === 1 ? 'y' : 'ies'} — accountant-prepared financials required</p>`);
    const roleLabel = { primary: 'primary', additional_confirmed: 'additional (confirmed)', additional_pending: 'additional (clarification pending)' };
    for (const e of corporateEntities.allEntities) {
      lines.push(`<p>&nbsp;&nbsp;• ${e.name} — ${roleLabel[e.role] || e.role}</p>`);
    }
    if (corporateEntities.clarificationPending && corporateEntities.clarificationMessage) {
      lines.push(`<p><strong>⚠ Additional entity — clarification needed:</strong> ${corporateEntities.clarificationMessage}</p>`);
    }
  }
  lines.push(`<p><strong>Ownership Type:</strong> ${ownershipType || 'TBD'}</p>`);

  return `<h2>Deal Snapshot</h2>\n` + lines.join('\n');
};

// Render a single discrepancy entry as a broker-facing template bullet.
// Used by Commit 2's injection helper. Stable phrasing (D's classifier
// catches it — locked in D-CLARIFICATION-DETECT 19/19).
const FIELD_DISPLAY_NAMES = {
  subject_property_postal_code: 'the postal code',
  subject_property_address: 'the property address',
  subject_property_market_value: 'the appraised property value',
  subject_property_assessment_value: 'the property tax assessed value',
  requested_loan_amount: 'the loan amount requested',
  existing_first_mortgage_lender: 'the existing first mortgage lender',
  existing_first_mortgage_balance: 'the existing first mortgage balance',
  existing_first_mortgage_payout_total: 'the mortgage payout total',
  primary_borrower_full_name: 'the borrower name',
};

const renderDiscrepancyBullet = (entry) => {
  const label = FIELD_DISPLAY_NAMES[entry.field] || entry.field;
  // Pick the two groups with the most sources each — produces the most
  // informative two-source contrast.
  const sorted = entry.groups.slice().sort((a, b) => b.sources.length - a.sources.length);
  const a = sorted[0];
  const b = sorted[1];
  const formatSource = (s) => s === 'email_body' ? 'your email' : `the ${s.replace(/[._]/g, ' ').replace(/\.pdf$/i, '')}`;
  return `I noticed a discrepancy on ${label}: ${formatSource(a.sources[0])} shows "${a.value}", but ${formatSource(b.sources[0])} shows "${b.value}". Could you confirm which is accurate?`;
};

// Format the canonical-field map as a structured input for prompts (Commit 2).
// Authoritative values from the JS-extracted source-of-truth. Vienna's prompts
// will receive this to populate field-level claims rather than inferring from
// raw extracted_data.
const formatCanonicalFieldsForPrompt = (canonicalMap) => {
  const lines = [];
  for (const [field, tuples] of Object.entries(canonicalMap || {})) {
    const t = (tuples || []).filter(x => x.value != null);
    if (t.length === 0) continue;
    const uniqueValues = [];
    for (const tuple of t) {
      const exists = uniqueValues.find(u => valuesEqual(field, u.value, tuple.value)
                                              && (u.lender || null) === (tuple.lender_canonical || null));
      if (exists) {
        exists.sources.push(tuple.source);
      } else {
        uniqueValues.push({ value: tuple.value, sources: [tuple.source], lender: tuple.lender_canonical || null });
      }
    }
    lines.push(`  ${field}: ${uniqueValues.map(u =>
      `"${u.value}"${u.lender ? ` (lender: ${u.lender})` : ''} [sources: ${u.sources.join(', ')}]`
    ).join('; ')}`);
  }
  return lines.length === 0 ? '(no canonical fields extracted)' : lines.join('\n');
};

// R6-γ (2026-05-21): consumer-side source filter for existing-first-mortgage
// lender attribution.
//
// Diagnosis. Marcus/Ryan c56c2a0f and Patricia/Aisha 6507de12 production
// admin reviews surfaced lender attributions ("BMO" / "TD") for the existing
// first mortgage that Franco had no authoritative source for. Initial framing
// was "lender hallucination," but empirical pull showed BMO and TD ARE in the
// submitted documents — most authoritatively in the credit_bureau. The bug
// is the WORKFLOW rule: per Franco, existing-first-mortgage lender naming
// requires payout-statement confirmation; credit_bureau and pnw_statement
// signals are evidence but NOT authoritative attribution.
//
// Design. Extractors continue to populate canonical_map.existing_first_mortgage_lender
// + balance + payout authoritatively from all three sources (mortgage_statement,
// credit_report, pnw_statement) — the data model + audit trail remain intact.
// This filter applies at the consumer boundary only (Snapshot rendering +
// prompt-context formatting) and strips lender attribution from any tuple
// whose source classification is NOT mortgage_statement. Balance tuples are
// retained (the value is still load-bearing for combined-LTV math etc.) but
// have their lender_canonical nulled.
//
// Conservative default. Tuples written before R6-γ (no classification field)
// default to non-payout — they get their lender attribution stripped. This
// matches Franco's rule on the safe side: when in doubt, do not name a
// lender. Re-extraction restores classification on fresh canonical_map writes.
//
// Classification field semantic (post-R6-α extension, 2026-05-21). The
// `classification` field on canonical_map tuples started in R6-γ as a doc-
// classification tag (mortgage_statement / credit_report / pnw_statement)
// for lender + balance + payout tuples. R6-α extended it to also tag the
// requested_loan_amount tuples with email_body alongside doc classifications
// ('loan_application'). The field's semantic generalized: "source-type label for filter precedence."
// Future field-specific filters (R6-ι if it lands the same shape, etc.) can
// extend the same mechanism naturally without schema expansion.
//
// Behavior change carried in commit. Pre-payout-confirmation, no
// existing_first_mortgage_lender discrepancies will surface via
// renderDiscrepancyBullet — the filter strips all non-payout lender tuples
// before the discrepancy set sees them. Post-payout-confirmation, the
// mortgage_statement-sourced tuple is authoritative and discrepancies against
// it can surface. Defensible: matches Franco's "needs confirmation" rule.
// Future-trigger flag: if Franco surfaces a case where he wanted to see the
// lender discrepancy earlier (pre-confirmation), revisit.
const filterCanonicalLenderForPayoutOnly = (canonicalMap) => {
  if (!canonicalMap) return canonicalMap;
  const isPayoutSource = (t) => t?.classification === 'mortgage_statement';
  // R11-B-2 (2026-05-27): balance source-hierarchy filter extension.
  // Pre-R11-B-2 R6-γ stripped lender attribution from non-payout sources
  // but KEPT balance tuples (with lender_canonical nulled). Gap: when
  // mortgage_statement source present, computeCombinedLtv picked
  // balances[0] which was often the FIRST-pushed credit_bureau tuple
  // (per-doc loop ordering), causing combined LTV to use the wrong
  // (historical / closed-account) balance.
  //
  // Empirical anchor: Marcus Webb 8c404ae0 — canonical_map had
  // existing_first_mortgage_balance = [$318k credit_bureau Scotia,
  // $400k mortgage_statement RBC]. computeCombinedLtv used $318k Scotia
  // (the historical closed-account balance from credit bureau) instead
  // of $400k RBC (the actual current first mortgage from payout statement).
  // Prelim Combined LTV row rendered "106.8% — ($318,000 + $408,000) /
  // $680,000" — wrong source.
  //
  // R11-B-2 extension: when mortgage_statement source PRESENT, strip
  // non-payout balance tuples ENTIRELY (not just null lender). Payout
  // statement is authoritative for current existing mortgage balance.
  //
  // Edge case preserved (clean first-mortgage, Linda-shape): when NO
  // mortgage_statement source exists, credit_bureau/pnw balance retained
  // with lender_canonical nulled (R6-γ legacy behavior). Preserves R6-γ's
  // existing behavior on clean first-mortgage deals where no payout
  // statement applies.
  const balanceTuples = canonicalMap.existing_first_mortgage_balance || [];
  const hasMortgageStatementBalance = balanceTuples.some(t => t?.classification === 'mortgage_statement');
  return {
    ...canonicalMap,
    existing_first_mortgage_lender: (canonicalMap.existing_first_mortgage_lender || []).filter(isPayoutSource),
    existing_first_mortgage_balance: hasMortgageStatementBalance
      // R11-B-2: mortgage_statement source present → strip non-payout balance tuples entirely
      ? balanceTuples.filter(isPayoutSource)
      // R6-γ legacy: clean first-mortgage edge case (no mortgage_statement) → keep balance, null lender
      : balanceTuples.map((t) => ({ ...t, lender_canonical: null })),
  };
};

// R6-α (2026-05-21): consumer-side source-hierarchy filter for the
// requested_loan_amount field.
//
// Diagnosis. Derek James Olsen S3 (deal dce308c8-2f25-4aeb-9c2b-2ad5284ae792,
// 2026-05-21 production corpus). Broker's initial email contained a typo
// "$452,600" — Vienna extracted that into canonical_map.requested_loan_amount
// with source='email_body'. Broker's loan_application PDF Page-1 annotation
// is the actual figure $110,000 — also extracted into canonical_map (R6-β-A,
// source='LoanApplication_Derek_Olsen.pdf'). Across 3 broker exchanges
// explicitly correcting to $110,000, Vienna persistently emitted
// hallucinations claiming "the loan application shows $452,600" — INVERTING
// the source attribution. The PDF empirically contains $110,000; $452,600
// appears nowhere in any document. Claude was reading the canonical_map
// context (which correctly tagged both tuples with their sources) and still
// inverting which-value-from-which-source in its generated reply, then
// digging in across re-prompts.
//
// Design. Same R6-γ pattern (consumer-side source-hierarchy filter at the
// prompt-context boundary; canonical_map preserves both tuples for audit).
// When requested_loan_amount has at least one tuple with classification ===
// 'loan_application', email_body-sourced tuples are stripped from the
// consumer-side view. Claude can't mis-attribute what isn't in the prompt.
//
// Asymmetric conservative default vs R6-γ — structurally justified.
//   R6-γ semantic: "STRIP lender UNLESS mortgage_statement confirms."
//     Absence of classification = absence of confirmation = strip aligns
//     with the rule's default ("leave blank until confirmed"). Strip-bias.
//   R6-α semantic: "WHEN both doc-source and email-source conflict, PREFER
//     doc." Absence of classification means the filter can't tell which
//     tuple is which source-type. Strip-on-absence would regress BOTH the
//     loan_application authoritative value AND the email_body value (losing
//     the authoritative source). Keep-on-absence preserves legacy behavior
//     until re-extraction stamps classification on the next inbound turn.
//   Different conservative defaults follow from different filter semantics:
//   strip-bias (R6-γ) vs preference-bias (R6-α).
//
// Behavior change carried in commit. When loan_application is on file AND
// canonical_map.requested_loan_amount has conflicting email_body tuple
// (broker email typo'd, doc has true value), renderDiscrepancyBullet will
// NOT surface a loan_amount discrepancy. Defensible: docs are the canonical
// source for loan amount (intentional submission). If broker insists their
// email value is correct and doc has a typo (rare), broker must re-submit
// the corrected loan_application — same workflow as any doc correction.
// Future-trigger flag: if Franco surfaces a case where he wanted the
// email-vs-doc loan_amount discrepancy surfaced earlier, revisit.
//
// Composition with R6-γ at consumer sites. Function-composed: each consumer
// site wraps R6-γ's filter result with R6-α's filter. Both filters are
// field-scoped (lender vs loan_amount) so they don't interact; composition
// order doesn't matter mathematically, but standard order is
// R6-α(R6-γ(map)) for readability (innermost = earliest cluster).
const filterCanonicalLoanAmountForDocAuthoritative = (canonicalMap) => {
  if (!canonicalMap) return canonicalMap;
  const tuples = canonicalMap.requested_loan_amount || [];
  // R10-G (2026-05-27): broker_correction and broker_initial_intent are
  // intent-field-authoritative per Q2-sub-b. When either broker source
  // exists, it OUTRANKS docs + email_body for requested_loan_amount.
  // Filter to keep only the broker source (strip docs + email_body so the
  // Snapshot doesn't multi-render conflicting values).
  const hasBrokerCorrection = tuples.some(t => t?.classification === 'broker_correction');
  if (hasBrokerCorrection) {
    return {
      ...canonicalMap,
      requested_loan_amount: tuples.filter(t => t?.classification === 'broker_correction'),
    };
  }
  const hasBrokerIntent = tuples.some(t => t?.classification === 'broker_initial_intent');
  if (hasBrokerIntent) {
    return {
      ...canonicalMap,
      requested_loan_amount: tuples.filter(t => t?.classification === 'broker_initial_intent'),
    };
  }
  const hasDocSource = tuples.some(t => t?.classification === 'loan_application');
  if (!hasDocSource) return canonicalMap; // no doc on file → broker's email is the only signal; preserve.
  return {
    ...canonicalMap,
    // Strip email_body source when loan_application source exists. Other
    // sources (none currently expected for loan_amount) + legacy tuples
    // without classification preserved per Q3-(i) verdict.
    requested_loan_amount: tuples.filter(t => t?.classification !== 'email_body'),
  };
};

// R10-E (2026-05-27): mortgage_position OBJECTIVE-field source-hierarchy filter.
// 7th cluster in 1st template family. Strips email_body tuples when doc-source
// (loan_application annotation) OR derived signal (mortgage_position_inferred_
// from_existing_balance) is present. Empirical anchor: Patricia Simmons deal
// a0caddfb — broker email said "first mortgage" → canonical_map.mortgage_position
// had email_body tuple "1st"; loan_application annotation said "Second Mortgage"
// + existing_first_mortgage_balance was $342k from credit_bureau + PNW. Without
// this filter, the email_body tuple would win at [0]-indexed consumers.
//
// Source-hierarchy (post-R10-E, OBJECTIVE-field shape):
//   broker_correction (R10-G machinery; broker explicit correction outranks
//     even objective-field doc values per R10-G Q2-(a) universal verdict)
//   > loan_application (doc-authoritative AcroForm annotation extraction)
//   > mortgage_position_inferred_from_existing_balance (logical-constraint
//     derived signal — balance > 0 implies new application is 2nd+)
//   > email_subject_or_body (broker initial statement; least authoritative
//     for OBJECTIVE field — broker can be factually wrong about objective
//     transaction facts)
//
// Paired with R10-G's filterCanonicalPurposeForBrokerAuthoritative (INTENT
// field shape: broker_correction > broker_initial_intent > docs > email_body)
// to formalize the OBJECTIVE-vs-INTENT field-semantics distinction.
const filterCanonicalMortgagePositionForObjectiveAuthoritative = (canonicalMap) => {
  if (!canonicalMap) return canonicalMap;
  const tuples = canonicalMap.mortgage_position || [];
  // broker_correction wins universally (R10-G precedent — broker has authority
  // to correct any field including objective ones if explicitly corrected)
  const hasBrokerCorrection = tuples.some(t => t?.classification === 'broker_correction');
  if (hasBrokerCorrection) {
    return { ...canonicalMap, mortgage_position: tuples.filter(t => t?.classification === 'broker_correction') };
  }
  // Doc-source (loan_application annotation) wins over derived + email_body
  const hasDocSource = tuples.some(t => t?.classification === 'loan_application');
  if (hasDocSource) {
    return { ...canonicalMap, mortgage_position: tuples.filter(t => t?.classification === 'loan_application') };
  }
  // Derived signal wins over email_body
  const hasDerivedSignal = tuples.some(t => t?.classification === 'mortgage_position_inferred_from_existing_balance');
  if (hasDerivedSignal) {
    return { ...canonicalMap, mortgage_position: tuples.filter(t => t?.classification === 'mortgage_position_inferred_from_existing_balance') };
  }
  // No higher-priority source → preserve email_body tuples (fail-open;
  // clean 1st-mortgage deals legitimately have only email_body source)
  return canonicalMap;
};

// R10-G (2026-05-27): companion filter for purpose canonical field.
// Same intent-field-authoritative hierarchy as requested_loan_amount:
//   broker_correction > broker_initial_intent > loan_application / aml > email_body
// Applied at consumer-site boundary so the Snapshot + narrative input both
// see the broker-authoritative value.
const filterCanonicalPurposeForBrokerAuthoritative = (canonicalMap) => {
  if (!canonicalMap) return canonicalMap;
  const tuples = canonicalMap.purpose || [];
  const hasBrokerCorrection = tuples.some(t => t?.classification === 'broker_correction');
  if (hasBrokerCorrection) {
    return {
      ...canonicalMap,
      purpose: tuples.filter(t => t?.classification === 'broker_correction'),
    };
  }
  const hasBrokerIntent = tuples.some(t => t?.classification === 'broker_initial_intent');
  if (hasBrokerIntent) {
    return {
      ...canonicalMap,
      purpose: tuples.filter(t => t?.classification === 'broker_initial_intent'),
    };
  }
  // No broker source: defer to documents (loan_application + aml). Strip
  // generic email_body if any doc source present (same shape as the
  // requested_loan_amount filter — empirical pattern).
  const hasDocSource = tuples.some(t => t?.classification === 'loan_application' || t?.classification === 'aml' || t?.classification === 'pep');
  if (!hasDocSource) return canonicalMap;
  return {
    ...canonicalMap,
    purpose: tuples.filter(t => t?.classification !== 'email_body'),
  };
};

// Top-level wrapper — orchestrates commercial-detection short-circuit + extraction
// + discrepancy computation. Used by the FP measurement runner. NOT YET wired into
// production webhook/ai.js — that lands in Commit 2 after Commit 1's empirical
// validation clears.
// Detect joint-multi-borrower deals: 2+ credit_bureau docs with distinct primary
// borrower names. Each borrower typically has their own first mortgage on a
// separate property — the schema's existing_first_mortgage_* fields assume a
// single subject mortgage and would falsely flag the two separate mortgages
// as a discrepancy. Suppress existing_first_mortgage_* extraction for these
// deals (other fields are still detected normally — e.g., subject_property_*
// remains valid since the deal is on ONE subject property).
const detectJointMultiBorrower = (savedDocs) => {
  const cbBorrowerNames = new Set();
  for (const doc of (savedDocs || [])) {
    if (doc.classification !== 'credit_report') continue;
    const r = cf.extractFromCreditBureau(doc);
    if (r.primary_borrower_full_name) cbBorrowerNames.add(r.primary_borrower_full_name);
  }
  return cbBorrowerNames.size >= 2 ? Array.from(cbBorrowerNames) : null;
};

// FRANCO-PREDICTED-Q8-EXTENSION (BATCH 12, 2026-05-29) — joint-via-name-conjunction
// detection, broadening the joint SNAPSHOT-ROW signal beyond detectJointMultiBorrower's
// 2+-credit-report requirement (which the joint fixtures E11/E12/F12 don't satisfy —
// they express joint via the borrower_name conjunction + joint NOA, no credit reports).
//
// DISPLAY-ONLY: this signal feeds the Snapshot Joint-Applicants row + the Q3/Q4
// qualification roster. It deliberately does NOT drive the existing_first_mortgage_*
// suppression (that stays scoped to the credit-bureau 2-separate-mortgage case — a
// SPOUSAL joint shares ONE mortgage on one subject property, so suppressing its balance
// would be a regression).
//
// Conservative (false-negative > false-positive, per Q4 discipline): BOTH sides must be
// borrower-shaped FULL names (First Last[, + 1]); single first-names ("Tom and Jerry"),
// lowercase role phrases ("and his accountant"), and conjunctions adjacent to a
// disqualifying role word (accountant/broker/lawyer/witness/guarantor/cosigner/…) are
// rejected. Tagged FRANCO-PREDICTED (not Franco-confirmed) → revertible per the banked
// Q8-DETECTION-MECHANISM product-design question.
const JOINT_NAME_TOKEN = "[A-Z][a-zA-Z'\\-]+(?:\\s+[A-Z][a-zA-Z'\\-]+){1,2}";
const JOINT_CONJ_RE = new RegExp('\\b(' + JOINT_NAME_TOKEN + ')\\s+(?:and|&)\\s+(' + JOINT_NAME_TOKEN + ')\\b');
const JOINT_ROLE_DISQUALIFY_RE = /\b(accountant|broker|lawyer|notar|witness|guarantor|co-?signer|realtor|agent|lender|appraiser|solicitor|trustee)\b/i;
const detectJointFromNames = (borrowerName, textSources = '') => {
  for (const src of [String(borrowerName || ''), String(textSources || '')]) {
    if (!src) continue;
    const m = JOINT_CONJ_RE.exec(src);
    if (!m) continue;
    const ctx = src.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30);
    if (JOINT_ROLE_DISQUALIFY_RE.test(ctx)) continue; // role-disqualified (named accountant/cosigner/etc.)
    const a = m[1].trim(), b = m[2].trim();
    if (a.toLowerCase() === b.toLowerCase()) continue; // same name twice — not joint
    return [a, b];
  }
  return null;
};

const runDiscrepancyDetection = (emailBody, savedDocs, borrowerName = null, opts = {}) => {
  const { emailSubject = '' } = opts;
  // Commercial / corporate submissions: out-of-scope (residential 2nd-mortgage gate only).
  const comm = cf.isCommercialSubmission(emailBody, savedDocs, borrowerName);
  if (comm.commercial) {
    return { commercial: true, commercial_signal: comm.signal, canonical_map: {}, discrepancy_set: [] };
  }
  // S15-E yielding: identity-clash deals are routed via S15-E's dedicated path
  // (generateIdentityClashMinimalAsk + awaiting_identity_confirmation status).
  // B's engine must not interfere — return empty discrepancy_set so no broker-
  // facing discrepancy section is injected and no admin-side discrepancy banner
  // contention occurs with S15-E's gate.
  const s15 = getS15Detector();
  const clash = s15 ? s15(emailSubject, emailBody, savedDocs) : null;
  if (clash) {
    return { commercial: false, identity_clash_yielded: true, identity_clash_info: clash, canonical_map: {}, discrepancy_set: [] };
  }
  const canonical_map = cf.extractCanonicalFields(emailBody, savedDocs, { emailSubject });
  // Joint-multi-borrower suppression: clear the existing_first_mortgage_*
  // fields when 2+ distinct borrowers' credit bureaus are present. The
  // existing first mortgage isn't a single canonical entity in that case.
  const jointBorrowers = detectJointMultiBorrower(savedDocs);
  if (jointBorrowers) {
    canonical_map.existing_first_mortgage_lender = [];
    canonical_map.existing_first_mortgage_balance = [];
    canonical_map.existing_first_mortgage_payout_total = [];
    // primary_borrower_full_name doesn't have a single canonical value on
    // joint deals — multiple distinct primary borrowers by definition.
    canonical_map.primary_borrower_full_name = [];
  }
  // FRANCO-PREDICTED-Q8-EXTENSION: broaden the DISPLAY signal to the name-conjunction
  // case (does NOT trigger the existing_first_mortgage suppression above).
  const jointDisplay = jointBorrowers || detectJointFromNames(borrowerName, emailBody);
  const discrepancy_set = computeDiscrepancySet(canonical_map);
  return {
    commercial: false,
    joint_multi_borrower: jointDisplay || null,
    canonical_map,
    discrepancy_set,
  };
};

// ──────────────────────────────────────────────────────────────────────────
// R5 Cluster B Sub-root 1 (2026-05-21): Snapshot canonical_map staleness fix.
//
// Pre-B-1, the admin Snapshot at webhook.js:693 fed extractCanonicalFields with
// `dealMessages.find(m => m.direction === 'inbound')?.body` — msg[0] only.
// Subsequent broker correction turns never fed canonical_map, so Franco's
// Snapshot showed stale msg[0] data even when the broker corrected figures
// in turn 2+.
//
// Real-Postmark fixture grounding (Grace Paulson 6838e1cf-ca2d-40a8-a1d1-
// 8597d8c4ab50): broker corrected loan_amount $85k + market_value $615k +
// mortgage_position 2nd in msg[2]; pre-fix Snapshot rendered "1st" only from
// msg[0]. msg[3+] are admin-reply approvals containing quoted Vienna output;
// naive latest-non-empty across all inbounds would let admin-quoted-Vienna
// overwrite the true broker correction (mortgage_position "1st" leak).
//
// FIX SHAPE (F3 quote-strip-only, per F-3 verdict 2026-05-21):
//   1. Per-inbound quote-strip via stripQuotedReplyChain (C3 fall-through:
//      Gmail-style "On X wrote:" regex first, else strip > -prefixed lines).
//   2. extractFromEmailBody per inbound on the stripped body.
//   3. Latest-non-empty-wins resolution across inbounds (single-value shape
//      preserved — canonical_map's tuple shape unchanged; renderDealSnapshot
//      + computeDiscrepancySet untouched).
//   4. Result feeds extractCanonicalFields via opts.preExtractedEmailFields,
//      bypassing the internal single-body extract.
//
// EXPLICIT KNOWN LIMITATION (logged residual, NOT a bug):
// F3 is empirically defensible on the current admin-reply workflow (one-word
// verbs: "approved" / "SEND" / "send"). Admin-typed substantive inline content
// containing canonical-field text (e.g., "Approved — adjust loan to $90k")
// survives quote-strip and would feed canonical_map as if it were a broker
// statement. Trigger for revisit: any Franco-side report of admin-stated
// overrides surfacing in Snapshot, OR admin workflow shifting toward
// substantive inline content. The structural fix at that point is F1
// (schema migration to persist messages.from_email + add broker-filter at
// the extraction layer). NOT in B-1 scope.
// ──────────────────────────────────────────────────────────────────────────

// Quote-strip per C3 fall-through: Gmail-style header first, > -line strip second.
// NOT covered (logged residual): Outlook "-----Original Message-----" + bare
// "From: X Sent: Y" reply-chain markers. Trigger: future fixture surfacing
// Outlook-style quoted leakage → add Outlook alternation to the regex.
const stripQuotedReplyChain = (body) => {
  if (!body || typeof body !== 'string') return '';
  // Gmail-style: `^On <date / sender info, possibly multi-line> wrote:$`.
  // /s makes . match \n (multi-line tolerant — Grace fixture wraps email
  // address across lines); /m makes ^ and $ match line boundaries.
  const gmailMatch = body.match(/^On .+? wrote:[ \t]*$/ms);
  if (gmailMatch) {
    return body.slice(0, gmailMatch.index).trim();
  }
  // Fall-through: per-line strip of `> `-prefixed lines (the per-line quote
  // marker). Handles clients that emit > -prefixed quoted lines without a
  // Gmail-style header.
  const nonQuoted = body.split('\n').filter((line) => !line.startsWith('>'));
  return nonQuoted.join('\n').trim();
};

// Aggregating wrapper: per-inbound quote-strip + extractFromEmailBody + latest-
// non-empty-wins resolution; result feeds extractCanonicalFields via
// opts.preExtractedEmailFields. canonical_map shape unchanged (single-value
// email_body tuple per field, plus the standard per-doc tuples).
const extractCanonicalFieldsAggregated = (inboundMessages, savedDocs, opts = {}) => {
  const { emailSubject = '' } = opts;
  const inbounds = (inboundMessages || []).filter((m) => m && (m.body || m.subject));

  // Same shape as extractFromEmailBody return value — null until populated.
  const resolved = {
    subject_property_address: null,
    subject_property_postal_code: null,
    // R6-δ (2026-05-21): match extractFromEmailBody return shape.
    subject_property_city: null,
    subject_property_province: null,
    subject_property_market_value: null,
    requested_loan_amount: null,
    mortgage_position: null,
    requested_loan_term_months: null,
  };

  // Per-msg in ascending order: strip + extract + latest-non-empty resolution.
  for (const msg of inbounds) {
    const strippedBody = stripQuotedReplyChain(msg.body || '');
    const extracted = cf.extractFromEmailBody(strippedBody, msg.subject || emailSubject);
    for (const field of Object.keys(resolved)) {
      const v = extracted[field];
      if (v != null && v !== '') resolved[field] = v;
    }
  }

  // R10-G (2026-05-27): broker_initial_intent + broker_correction parsing.
  // Q5 verdict: parse on every broker inbound; initial intent from first
  // inbound; corrections from subsequent inbounds. Aggregated in priority
  // order before threading to extractCanonicalFields via opts.
  const brokerInitialIntent = inbounds.length > 0
    ? cf.parseBrokerInitialIntent(stripQuotedReplyChain(inbounds[0].body || ''))
    : [];
  const brokerCorrections = [];
  for (let i = 1; i < inbounds.length; i++) {
    const corrections = cf.parseBrokerCorrections(stripQuotedReplyChain(inbounds[i].body || ''));
    // Latest correction per field wins (later inbound's correction supersedes earlier).
    for (const c of corrections) {
      const existingIdx = brokerCorrections.findIndex(b => b.field === c.field);
      if (existingIdx >= 0) brokerCorrections[existingIdx] = c;
      else brokerCorrections.push(c);
    }
  }

  return cf.extractCanonicalFields('', savedDocs, {
    emailSubject,
    preExtractedEmailFields: resolved,
    brokerInitialIntent,
    brokerCorrections,
    // FRANCO-Q1: thread the real stripped broker body so payout/purchase
    // language detection works in the aggregated path (emailBody is '' here).
    brokerBodyText: inbounds.map(m => stripQuotedReplyChain(m.body || '')).join('\n'),
  });
};

// Aggregated discrepancy detection — mirrors runDiscrepancyDetection but uses
// the multi-inbound canonical_map aggregator. Upstream guards (commercial /
// S15-E identity-clash) use msg[0] body since they're deal-wide decisions
// not aggregation-semantics-sensitive (a deal is or isn't commercial based on
// initial submission shape; identity-clash detection runs against docs +
// initial body).
const runDiscrepancyDetectionAggregated = (inboundMessages, savedDocs, borrowerName = null, opts = {}) => {
  const { emailSubject = '' } = opts;
  const initialBody = (inboundMessages || [])[0]?.body || '';
  const comm = cf.isCommercialSubmission(initialBody, savedDocs, borrowerName);
  if (comm.commercial) {
    return { commercial: true, commercial_signal: comm.signal, canonical_map: {}, discrepancy_set: [] };
  }
  const s15 = getS15Detector();
  const clash = s15 ? s15(emailSubject, initialBody, savedDocs) : null;
  if (clash) {
    return { commercial: false, identity_clash_yielded: true, identity_clash_info: clash, canonical_map: {}, discrepancy_set: [] };
  }
  const canonical_map = extractCanonicalFieldsAggregated(inboundMessages, savedDocs, { emailSubject });
  const jointBorrowers = detectJointMultiBorrower(savedDocs);
  if (jointBorrowers) {
    canonical_map.existing_first_mortgage_lender = [];
    canonical_map.existing_first_mortgage_balance = [];
    canonical_map.existing_first_mortgage_payout_total = [];
    canonical_map.primary_borrower_full_name = [];
  }
  // FRANCO-PREDICTED-Q8-EXTENSION: broaden the DISPLAY signal to the name-conjunction
  // case (borrower_name "X and Y" + aggregated inbound text). Does NOT trigger the
  // existing_first_mortgage suppression above (spousal joint shares one mortgage).
  const _aggJointText = (inboundMessages || []).map(m => m.body || '').join('\n');
  const jointDisplay = jointBorrowers || detectJointFromNames(borrowerName, _aggJointText);
  const discrepancy_set = computeDiscrepancySet(canonical_map);
  return {
    commercial: false,
    joint_multi_borrower: jointDisplay || null,
    canonical_map,
    discrepancy_set,
  };
};

module.exports = {
  PARTITIONED_FIELDS,
  FIELD_DISPLAY_NAMES,
  MARKET_DELTA_FIELDS,
  valuesEqual,
  groupTuples,
  computeDiscrepancySet,
  renderDiscrepancyBullet,
  renderDiscrepancySection,
  renderDealSnapshot,
  // R6-δ (2026-05-21): two-tier city/province derivation — accepts
  // canonical_map (preferred, reads subject_property_city + _province
  // tuples) or normalized-address string (legacy backward-compat).
  deriveCityProvince,
  computeCombinedLtv,
  computeStandaloneLtv,
  // R4-RESIDUAL-1: combined-LTV escalation trigger
  COMBINED_LTV_ESCALATION_THRESHOLD_PCT,
  shouldEscalateOnAnyLtv,
  shouldEscalateOnIncompleteCanonical, // BUG-4 (BATCH 14)
  shouldAutoDeclineOver90,      // FRANCO-Q2
  isCombinedLtvResolved,        // FRANCO-Q2
  AUTO_DECLINE_LTV_THRESHOLD_PCT, // FRANCO-Q2
  // R10-C-2 (2026-05-27): LTV-band classifier — contract Schedule A Stage 1
  // three-band spec ('over_80' / 'elevated_75_80' / 'standard').
  computeLtvBand,
  formatCanonicalFieldsForPrompt,
  filterCanonicalLenderForPayoutOnly,
  // R6-α (2026-05-21): consumer-side source-hierarchy filter for
  // requested_loan_amount (doc-authoritative when loan_application on file).
  filterCanonicalLoanAmountForDocAuthoritative,
  // R10-G (2026-05-27): purpose filter — broker-source-authoritative for intent
  // fields per Q2-sub-b. Consumed at Snapshot rendering + narrative input
  // composition.
  filterCanonicalPurposeForBrokerAuthoritative,
  // R10-E (2026-05-27): mortgage_position filter — OBJECTIVE-field hierarchy
  // (broker_correction > docs > derived > email_body). 7th cluster in 1st
  // template family; pairs with R10-G's INTENT-field filter to formalize
  // OBJECTIVE-vs-INTENT distinction.
  filterCanonicalMortgagePositionForObjectiveAuthoritative,
  filterBrokerFacing,
  runDiscrepancyDetection,
  // R5-B-1 (2026-05-21): aggregating Snapshot fix
  stripQuotedReplyChain,
  extractCanonicalFieldsAggregated,
  runDiscrepancyDetectionAggregated,
  detectJointMultiBorrower,
  detectJointFromNames, // FRANCO-PREDICTED-Q8-EXTENSION (BATCH 12)
};
