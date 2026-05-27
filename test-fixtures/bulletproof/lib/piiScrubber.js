// PII scrubber. Original intent: scrub production-corpus shape-reference
// samples before storage. Phase 3 sample-pull program was DEFERRED 2026-05-27
// (Option B) after first live-pull surfaced significant leak categories not
// caught by regex-based scrubbing — see production-samples/shape-log.md for
// the empirical escalation anchor.
//
// CLOSURE CONDITION: if Phase 5 triage surfaces synthetic-bias material gap
// that warrants production-sample storage, this scrubber needs the following
// extensions BEFORE being safe for any production-sample storage path:
//   M1 — License number patterns (broker Lic. #MB###### style)
//   M2 — Bracketed/parenthesized phone variants (e.g., '<(NNN)+NNN-NNNN>')
//   M3 — Street address patterns (street number + street name + city)
//   M4 — Identifying URL patterns (broker calendly/social/personal-site URLs)
//   M5 — Mandatory caller-supplied nameList contract (raise explicit error on
//        missing input rather than silently degrading to no-name-scrub)
//
// This file is RETAINED for completeness + documentation of the deferred
// extensions. Currently UNUSED by any active code path in the harness.
//
// Discipline (preserved for closure-condition reference): production samples
// would inform SHAPE only (broker phrasing patterns, AcroForm annotation
// conventions, document layouts). Content is scrubbed to synthetic
// placeholders. Audit log records each replacement so reviewer can verify
// no PII slipped through.

const REPLACEMENT_BUCKETS = {
  borrower_full_name: ['Marcus Webb', 'Patricia Simmons', 'Sarah Chen', 'David Okafor', 'Jennifer Tran'],
  street_address: ['1142 Tory Road NW', '287 Glencairn Avenue', '4421 Kingsway', '52 Winston Churchill Boulevard'],
  city: ['Edmonton', 'Toronto', 'Vancouver', 'Mississauga'],
  postal_code: ['T6R 2K8', 'M5N 1V3', 'V5R 5T7', 'L5M 4Y1'],
  phone: ['780-555-0142', '416-555-0188', '604-555-0211', '905-555-0376'],
  email: ['marcus.webb@example.com', 'patricia.simmons@example.com', 'sarah.chen@example.com'],
  loan_amount: [125000, 280000, 95000, 175000, 460000],
  property_value: [650000, 850000, 920000, 1100000, 450000],
};

const PATTERNS = [
  // Canadian phone numbers
  { name: 'phone', re: /\b(\+1[\s-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, bucket: 'phone' },
  // Email addresses
  { name: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, bucket: 'email' },
  // Postal codes (Canadian FSA + LDU)
  { name: 'postal_code', re: /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/g, bucket: 'postal_code' },
  // Dollar amounts ≥ $1,000 (assume any 4+ digit dollar figure is financial PII)
  { name: 'currency', re: /\$\s?\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\$\s?\d{4,}(?:\.\d{2})?/g, bucket: 'loan_amount' },
  // SIN-like 9-digit numbers
  { name: 'sin', re: /\b\d{3}[\s-]?\d{3}[\s-]?\d{3}\b/g, bucket: null }, // dropped entirely
];

const stableHash = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

const pickReplacement = (bucket, original) => {
  if (!bucket || !REPLACEMENT_BUCKETS[bucket]) return '[REDACTED]';
  const pool = REPLACEMENT_BUCKETS[bucket];
  const idx = stableHash(original) % pool.length;
  const replacement = pool[idx];
  if (bucket === 'loan_amount' || bucket === 'property_value') {
    return `$${Number(replacement).toLocaleString()}`;
  }
  return String(replacement);
};

// Names are harder than regex-detectable patterns — proper-noun detection
// requires NER or hand-flagging. The scrubber accepts an explicit nameList
// argument (caller identifies names to redact during manual review pass).
const scrubText = (rawText, opts = {}) => {
  const { nameList = [] } = opts;
  const replacements = [];
  let scrubbed = rawText;

  for (const name of nameList) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    scrubbed = scrubbed.replace(re, (m) => {
      const r = pickReplacement('borrower_full_name', m);
      replacements.push({ kind: 'name', original: m, replacement: r });
      return r;
    });
  }

  for (const pattern of PATTERNS) {
    scrubbed = scrubbed.replace(pattern.re, (m) => {
      const r = pickReplacement(pattern.bucket, m);
      replacements.push({ kind: pattern.name, original: m, replacement: r });
      return r;
    });
  }

  return { scrubbed, replacements };
};

module.exports = {
  scrubText,
  REPLACEMENT_BUCKETS,
  PATTERNS,
};
