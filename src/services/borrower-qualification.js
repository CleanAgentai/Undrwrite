// FRANCO-Q3 / Q4 — multi-party borrower qualification roster.
//
// ARCHITECTURE NOTE (Phase-8 carry-forward): Vienna's income/debt are
// LLM-narrative (income_details string + total_debt number, computed by the
// qualification prompt), NOT structured canonical fields — there is no per-borrower
// income/debt tuple to sum in JS. So this helper is deterministic ONLY for what
// CAN be determined deterministically: the counting-borrower ROSTER and the
// aggregation DIRECTIVE fed to the prompt. The numeric summation itself rides the
// existing LLM qualification path (the only place income/debt live). This is the
// canonical "redesign within the existing architecture rather than retrofit the
// architecture to the design" (Option B vs Option A) carry-forward example.
//
// Q3 (this commit): all detected joint borrowers count toward qualification.
// Q4 (next commit) extends classifyRole with guarantor/cosigner gating.

const ROLE = {
  PRIMARY: 'primary',
  CO_APPLICANT: 'co_applicant',
  GUARANTOR_ONLY: 'guarantor_only', // FRANCO-Q4: liable on default, NOT counted toward qualification
};

// FRANCO-Q4 role-signal patterns. Conservative by design (failure-mode asymmetry:
// counting a true guarantor over-qualifies a weak borrower — the underwriting error
// Franco wants avoided; treating a true co-applicant as guarantor-only under-qualifies
// — recoverable via clarification). So an explicit GUARANTOR signal wins, an explicit
// CO-APPLICANT signal counts, and a bare ambiguous "cosigner" DEFAULTS to guarantor-only
// (not counted) AND flags for clarification.
const CO_APPLICANT_RE = /\bco[-\s]?applicant\b|\bco[-\s]?borrower\b|\bjoint applicant\b|\bboth (?:are )?applicants\b/i;
const GUARANTOR_RE = /\bguarantor(?:\s+only)?\b|\bsupporting\s+only\b|\bas\s+guarantor\b/i;
const COSIGNER_AMBIG_RE = /\bco[-\s]?signer\b/i;

// Collect text within ±radius chars of each occurrence of `name` (case-insensitive).
const windowAround = (text, name, radius = 90) => {
  if (!name || !text) return '';
  const lower = text.toLowerCase();
  const target = String(name).toLowerCase();
  let idx = lower.indexOf(target);
  let out = '';
  while (idx !== -1) {
    out += ' ' + text.slice(Math.max(0, idx - radius), idx + target.length + radius);
    idx = lower.indexOf(target, idx + target.length);
  }
  return out;
};

// Determine a non-primary party's role. resolvedRole (from a prior broker
// clarification) overrides text inference.
const classifyRole = (name, textSources, resolvedRole) => {
  if (resolvedRole === ROLE.CO_APPLICANT || resolvedRole === ROLE.GUARANTOR_ONLY) {
    return { role: resolvedRole, ambiguous: false };
  }
  const win = windowAround(textSources, name);
  if (GUARANTOR_RE.test(win)) return { role: ROLE.GUARANTOR_ONLY, ambiguous: false };      // explicit guarantor wins
  if (CO_APPLICANT_RE.test(win)) return { role: ROLE.CO_APPLICANT, ambiguous: false };      // explicit co-applicant counts
  if (COSIGNER_AMBIG_RE.test(win)) return { role: ROLE.GUARANTOR_ONLY, ambiguous: true };   // ambiguous → conservative default + flag
  return { role: ROLE.CO_APPLICANT, ambiguous: false };                                      // detected joint borrower, no role label → counts (Q3 default)
};

// Build the qualification roster from the detected-borrower list.
//   detectedBorrowers : string[] | null  (from dEngine.detectJointMultiBorrower)
//   primaryName       : string | null    (dealSummary.borrower_name / canonical primary)
// Returns:
//   { multiParty, roster:[{name, role, countsTowardQualification}],
//     countingCount, aggregationDirective:string|null }
// Pure function — no side effects (R9-B pattern; testable independently of the prompt).
const buildQualificationRoster = ({ detectedBorrowers = null, primaryName = null, textSources = '', resolvedRoles = {}, registeredOwners = [], registeredOwnerSignal = false } = {}) => {
  const names = Array.isArray(detectedBorrowers) ? detectedBorrowers.filter(Boolean) : [];

  // FRANCO-Q11: a registered owner not listed on the application must be added — this check
  // applies regardless of applicant count (even a single-applicant deal can omit the owner).
  const _ownerKey = (n) => String(n).toLowerCase().trim().replace(/\.+$/, '');
  const _q11Active = registeredOwnerSignal && Array.isArray(registeredOwners) && registeredOwners.length > 0;
  const q11OwnerMissing = _q11Active
    ? registeredOwners.filter(o => !names.some(n => _ownerKey(n) === _ownerKey(o)))
    : [];
  const _q11MissingClar = q11OwnerMissing.length
    ? `${q11OwnerMissing.join(', ')} ${q11OwnerMissing.length > 1 ? 'are registered property owners' : 'is a registered property owner'} but not listed on the application — per policy the registered owner(s) must be on the application; please add ${q11OwnerMissing.length > 1 ? 'them' : q11OwnerMissing[0]}.`
    : '';

  // 0 or 1 borrower → no aggregation; passthrough (qualification flow unchanged) — EXCEPT
  // a Q11 missing-owner clarification still fires (the owner must be added to the app).
  if (names.length < 2) {
    return {
      multiParty: false,
      roster: names.length === 1
        ? [{ name: names[0], role: ROLE.PRIMARY, countsTowardQualification: true, ambiguous: false }]
        : [],
      countingCount: names.length,
      aggregationDirective: null,
      clarificationPending: q11OwnerMissing.length > 0,
      clarificationMessage: _q11MissingClar || null,
    };
  }

  let primaryAssigned = false;
  const matchesPrimary = (name) => primaryName && name.toLowerCase().trim() === primaryName.toLowerCase().trim();
  const roster = names.map((name, i) => {
    const isPrimary = !primaryAssigned && (primaryName ? matchesPrimary(name) : i === 0);
    if (isPrimary) { primaryAssigned = true; return { name, role: ROLE.PRIMARY, countsTowardQualification: true, ambiguous: false }; }
    // FRANCO-Q4: conservative role gating for non-primary parties.
    const { role, ambiguous } = classifyRole(name, textSources, resolvedRoles[name]);
    return { name, role, countsTowardQualification: role !== ROLE.GUARANTOR_ONLY, ambiguous };
  });
  // If primaryName was provided but matched none, promote the first entry to primary.
  if (!primaryAssigned && roster.length > 0) {
    roster[0] = { ...roster[0], role: ROLE.PRIMARY, countsTowardQualification: true, ambiguous: false };
  }

  // FRANCO-Q11 (Franco 2026-05-30): registered-property-owner override. When a registered-
  // owner signal is present and there is exactly ONE registered owner, any non-primary
  // applicant who is NOT that owner is a GUARANTOR by definition — this SUPERSEDES Q4's
  // ambiguous/co-applicant inference (a definitive owner-vs-not test beats a role-language
  // guess). Registered owners NOT on the application are flagged for broker clarification
  // (Franco: "must be on the application regardless").
  if (_q11Active && registeredOwners.length === 1) {
    const ownerSet = new Set(registeredOwners.map(_ownerKey));
    for (let i = 0; i < roster.length; i++) {
      const r = roster[i];
      if (r.role === ROLE.PRIMARY) continue;
      if (!ownerSet.has(_ownerKey(r.name))) {
        roster[i] = { ...r, role: ROLE.GUARANTOR_ONLY, countsTowardQualification: false, ambiguous: false, q11: 'non-owner on single-registered-owner deal → guarantor (FRANCO-Q11)' };
      }
    }
  }

  const counting = roster.filter(r => r.countsTowardQualification);
  const guarantors = roster.filter(r => r.role === ROLE.GUARANTOR_ONLY);
  const ambiguousParties = roster.filter(r => r.ambiguous);
  const clarificationPending = ambiguousParties.length > 0 || q11OwnerMissing.length > 0;
  const _q4Clar = ambiguousParties.length
    ? `This deal lists ${ambiguousParties.map(r => r.name).join(', ')} as cosigner${ambiguousParties.length > 1 ? 's' : ''} — confirming whether ${ambiguousParties.length > 1 ? 'they should' : ambiguousParties[0].name + ' should'} be counted as a co-applicant for qualification (income and credit contribute), or treated as guarantor-only (on the hook for default, but not counted toward qualification). Defaulted to guarantor-only pending confirmation.`
    : '';
  // FRANCO-Q11 missing-owner clarification computed at the top (_q11MissingClar).
  const clarificationMessage = clarificationPending ? [_q4Clar, _q11MissingClar].filter(Boolean).join(' ') : null;

  const guarantorClause = guarantors.length
    ? `\n- Parties marked GUARANTOR-ONLY (disclose as liable-on-default, do NOT count income/credit toward qualification): ${guarantors.map(r => r.name).join(', ')}.`
    : '';
  const aggregationDirective =
`MULTI-PARTY QUALIFICATION (FRANCO-Q3/Q4 JS-deterministic roster, USE THIS):
- ${counting.length} part${counting.length === 1 ? 'y counts' : 'ies count'} toward qualification: ${counting.map(r => r.name).join(', ')}.
- AGGREGATE (SUM) income and debt across ${counting.length === 1 ? 'this party' : `ALL ${counting.length} counting parties`} for the qualification assessment — do NOT use primary-borrower-only figures.
- In the FINANCIAL SNAPSHOT, present BOTH the combined totals AND a per-borrower breakdown (one line per counting borrower) so the underwriter sees the structure, not just the total.${guarantorClause}`;

  return {
    multiParty: true,
    roster,
    countingCount: counting.length,
    aggregationDirective,
    clarificationPending,
    clarificationMessage,
  };
};

module.exports = { ROLE, buildQualificationRoster };
