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

const runDiscrepancyDetection = (emailBody, savedDocs, borrowerName = null) => {
  // Commercial / corporate submissions: out-of-scope (residential 2nd-mortgage gate only).
  const comm = cf.isCommercialSubmission(emailBody, savedDocs, borrowerName);
  if (comm.commercial) {
    return { commercial: true, commercial_signal: comm.signal, canonical_map: {}, discrepancy_set: [] };
  }
  const canonical_map = cf.extractCanonicalFields(emailBody, savedDocs);
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
  const discrepancy_set = computeDiscrepancySet(canonical_map);
  return {
    commercial: false,
    joint_multi_borrower: jointBorrowers || null,
    canonical_map,
    discrepancy_set,
  };
};

module.exports = {
  PARTITIONED_FIELDS,
  FIELD_DISPLAY_NAMES,
  valuesEqual,
  groupTuples,
  computeDiscrepancySet,
  renderDiscrepancyBullet,
  formatCanonicalFieldsForPrompt,
  runDiscrepancyDetection,
};
