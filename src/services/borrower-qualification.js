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
};

// Build the qualification roster from the detected-borrower list.
//   detectedBorrowers : string[] | null  (from dEngine.detectJointMultiBorrower)
//   primaryName       : string | null    (dealSummary.borrower_name / canonical primary)
// Returns:
//   { multiParty, roster:[{name, role, countsTowardQualification}],
//     countingCount, aggregationDirective:string|null }
// Pure function — no side effects (R9-B pattern; testable independently of the prompt).
const buildQualificationRoster = ({ detectedBorrowers = null, primaryName = null } = {}) => {
  const names = Array.isArray(detectedBorrowers) ? detectedBorrowers.filter(Boolean) : [];

  // 0 or 1 borrower → no aggregation; passthrough (qualification flow unchanged).
  if (names.length < 2) {
    return {
      multiParty: false,
      roster: names.length === 1
        ? [{ name: names[0], role: ROLE.PRIMARY, countsTowardQualification: true }]
        : [],
      countingCount: names.length,
      aggregationDirective: null,
    };
  }

  let primaryAssigned = false;
  const matchesPrimary = (name) => primaryName && name.toLowerCase().trim() === primaryName.toLowerCase().trim();
  const roster = names.map((name, i) => {
    const isPrimary = !primaryAssigned && (primaryName ? matchesPrimary(name) : i === 0);
    if (isPrimary) primaryAssigned = true;
    return {
      name,
      role: isPrimary ? ROLE.PRIMARY : ROLE.CO_APPLICANT,
      countsTowardQualification: true, // Q3: all detected joint borrowers count
    };
  });
  // If primaryName was provided but matched none, promote the first entry to primary
  // so exactly one primary is always present.
  if (!primaryAssigned && roster.length > 0) {
    roster[0].role = ROLE.PRIMARY;
  }

  const counting = roster.filter(r => r.countsTowardQualification);
  const aggregationDirective =
`MULTI-PARTY QUALIFICATION (FRANCO-Q3 JS-deterministic roster, USE THIS):
- ${counting.length} borrowers count toward qualification: ${counting.map(r => r.name).join(', ')}.
- AGGREGATE (SUM) income and debt across ALL ${counting.length} counting parties for the qualification assessment — do NOT use primary-borrower-only figures.
- In the FINANCIAL SNAPSHOT, present BOTH the combined totals AND a per-borrower breakdown (one line per counting borrower) so the underwriter sees the structure, not just the total.`;

  return {
    multiParty: true,
    roster,
    countingCount: counting.length,
    aggregationDirective,
  };
};

module.exports = { ROLE, buildQualificationRoster };
