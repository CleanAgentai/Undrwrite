// Spec-to-Vienna field-name normalization layer + shape transformations.
//
// Empirical anchor: pre-implementation introspection of one representative
// Vienna deal (Phase 5 Sub-phase 5.1 empirical probe, 2026-05-27) revealed
// >60% of spec field names do NOT match Vienna's actual extracted_data keys.
// Spec authoring used canonical-field names from architectural template
// family lineage (R8-R11 carry-forwards); Vienna's actual storage shape
// evolved with different naming conventions over the same period.
//
// Anti-circularity reminder: spec field names remain authoritative per Phase 4
// intent grounding (R10-G OBJECTIVE-vs-INTENT framing); this normalization
// layer translates spec-side intent to Vienna-side observation at Phase 5
// assertion time. The mismatch is not a spec error — Vienna's persisted
// shape is the empirical reality, and this layer bridges the two.
//
// Two-factor architecture-amendment-candidate detection per Q-R3:
//   (a) Field has no direct or transformed Vienna mapping AND
//   (b) Field has no entry in GATE_INFERENCE table (i.e., not a transient gate)
// → architecture-amendment-candidate (concept genuinely missing from Vienna).
// Otherwise: transient gate handled by Option B inference logic in assertEngine.
//
// Default for ambiguous fields: transient (avoid over-tagging).

// ────────────────────────────────────────────────────────────────────────────
// Direct key remappings: spec key → Vienna's actual extracted_data key
// ────────────────────────────────────────────────────────────────────────────
const SPEC_TO_VIENNA_KEY = {
  // Direct matches (no transformation)
  borrower_name: 'borrower_name',
  broker_name: 'broker_name',
  property_value: 'property_value',
  exit_strategy: 'exit_strategy',
  identity_clash: 'identity_clash',
  is_purchase: 'is_purchase',
  ltv_percent: 'ltv_percent',
  property_address: 'property_address',
  total_debt: 'total_debt',
  unresolved_discrepancy: 'unresolved_discrepancy',

  // Remappings (word-order swap / prefix-suffix difference)
  requested_loan_amount: 'loan_amount_requested',
  subject_property_address: 'property_address',
  first_mortgage_balance: 'existing_mortgage_balance',

  // Shape-transformed (handled via SHAPE_TRANSFORM below)
  transaction_type: '_shape_transform_transaction_type',
  annual_income: '_shape_transform_annual_income',

  // Likely transient OR genuinely absent (assertEngine resolves via two-factor)
  mortgage_position: 'mortgage_position', // present sometimes (R10-G inference); also transient gate
  existing_mortgage_lender: 'existing_mortgage_lender', // R11-B-2 may persist or compute transient
  postal_code: '_extract_from_property_address',
};

// ────────────────────────────────────────────────────────────────────────────
// Shape transformations: spec scalar/structure → Vienna's actual shape
// ────────────────────────────────────────────────────────────────────────────
const SHAPE_TRANSFORM = {
  transaction_type: {
    // Spec: enum string ("refinance" | "purchase" | "2nd mortgage" | ...)
    // Vienna: loan_type (string) + is_purchase (boolean) split
    // Inference: is_purchase=true → "purchase"; is_purchase=false + loan_type
    //   indicates refi-variant
    rationale: 'R11-A inferential canonical field; Vienna persists as loan_type + is_purchase boolean',
    extract: (extracted_data) => {
      if (extracted_data?.is_purchase === true) return 'purchase';
      const lt = (extracted_data?.loan_type || '').toLowerCase();
      if (/2nd|second/.test(lt)) return '2nd mortgage';
      if (/3rd|third/.test(lt)) return '3rd mortgage';
      if (/construction/.test(lt)) return 'construction';
      if (/private/.test(lt)) return 'private mortgage';
      if (/refinanc/.test(lt)) return 'refinance';
      return lt || null;
    },
  },
  annual_income: {
    // Spec: scalar number ($145,000)
    // Vienna: income_details (object with sub-fields)
    rationale: 'F1.AI architecture-amendment-candidate per A41; income_details object shape may not align with scalar-canonical spec assumption',
    extract: (extracted_data) => {
      const id = extracted_data?.income_details;
      if (typeof id === 'number') return id;
      if (typeof id === 'object' && id !== null) {
        return id.total ?? id.annual ?? id.amount ?? null;
      }
      return null;
    },
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Postal-code extraction from address string (Vienna doesn't persist postal
// separately based on probe; embedded in property_address)
// ────────────────────────────────────────────────────────────────────────────
const POSTAL_RE = /\b([A-Z]\d[A-Z])\s?(\d[A-Z]\d)\b/;
const extractPostalFromAddress = (extracted_data) => {
  const addr = extracted_data?.property_address || '';
  const m = POSTAL_RE.exec(addr);
  return m ? `${m[1]} ${m[2]}` : null;
};

// ────────────────────────────────────────────────────────────────────────────
// Fields confirmed architecture-amendment-candidates (no Vienna mapping AND
// no transient-gate inference). Per Q-R3 two-factor check + Layer 3 baseline.
// ────────────────────────────────────────────────────────────────────────────
const ARCH_AMENDMENT_FIELDS = new Set([
  'credit_score',           // Layer 3 #12
  'cosigner_name',          // Layer 3 #8
  'cosigner_income',        // Layer 3 #8
  'beneficial_owners',      // Layer 3 #1 (corporate)
  'incorporation_jurisdiction', // Layer 3 #1
  'directors',              // Layer 3 #1
  'draw_schedule',          // Layer 3 #3 (construction)
  'projected_completion_value', // Layer 3 #3
  'completion_date',        // Layer 3 #3
  'lender_inspection_required', // Layer 3 #3
  'province',               // possibly derived not persisted — verify in Phase 5
  'postal_code_tuples',     // spec assumes tuple structure; Vienna stores single postal in address
]);

// ────────────────────────────────────────────────────────────────────────────
// Workflow state enum normalization: spec → Vienna's actual status values
// Empirical probe: Vienna uses status='under_review' for what spec calls 'active'
// in some contexts. Need expanded mapping based on Phase 5 observation.
// ────────────────────────────────────────────────────────────────────────────
const SPEC_TO_VIENNA_STATUS = {
  active: ['active', 'under_review'], // spec 'active' may match either
  awaiting_collateral: ['awaiting_collateral'],
  awaiting_identity_confirmation: ['awaiting_identity_confirmation'],
  ltv_escalated: ['ltv_escalated'],
  admin_handoff: ['admin_handoff', 'admin_controlled_true'], // pseudo-status; may map to admin_controlled boolean
  completed: ['completed'],
};

// ────────────────────────────────────────────────────────────────────────────
// Primary API: resolve a spec field name to actual Vienna value
// ────────────────────────────────────────────────────────────────────────────
const resolveSpecField = (specKey, extracted_data) => {
  if (ARCH_AMENDMENT_FIELDS.has(specKey)) {
    return { value: null, classification: 'architecture_amendment_candidate', rationale: `Field '${specKey}' has no Vienna mapping; flagged as architecture-amendment-candidate per Q-R3 two-factor check` };
  }
  const mapped = SPEC_TO_VIENNA_KEY[specKey];
  if (!mapped) {
    // No direct mapping; treat as potentially-transient (assertEngine resolves via GATE_INFERENCE)
    return { value: null, classification: 'unmapped_potentially_transient', rationale: `No direct mapping for spec field '${specKey}'; check assertEngine GATE_INFERENCE table` };
  }
  if (mapped === '_shape_transform_transaction_type') {
    return { value: SHAPE_TRANSFORM.transaction_type.extract(extracted_data), classification: 'shape_transformed', rationale: SHAPE_TRANSFORM.transaction_type.rationale };
  }
  if (mapped === '_shape_transform_annual_income') {
    return { value: SHAPE_TRANSFORM.annual_income.extract(extracted_data), classification: 'shape_transformed', rationale: SHAPE_TRANSFORM.annual_income.rationale };
  }
  if (mapped === '_extract_from_property_address') {
    return { value: extractPostalFromAddress(extracted_data), classification: 'extracted_from_address', rationale: 'Vienna does not persist postal_code separately; extracted from property_address string' };
  }
  return { value: extracted_data?.[mapped], classification: 'direct_or_remapped', rationale: `Mapped to extracted_data.${mapped}` };
};

const resolveStatus = (specStatus, viennaStatus) => SPEC_TO_VIENNA_STATUS[specStatus]?.includes(viennaStatus) || specStatus === viennaStatus;

module.exports = {
  SPEC_TO_VIENNA_KEY,
  SHAPE_TRANSFORM,
  ARCH_AMENDMENT_FIELDS,
  SPEC_TO_VIENNA_STATUS,
  resolveSpecField,
  resolveStatus,
};
