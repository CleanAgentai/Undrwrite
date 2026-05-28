// FRANCO-Q5 — corporate-borrower entity detection + accountant-financials doc-ask.
//
// Layer 1 (RELIABLE, deterministic): primary-corporation detection on the borrower
//   name via entity suffix (Inc/Ltd/Corp/Corporation/Incorporated/Limited/LLC/LLP).
//   Numbered companies ("1234567 Ontario Inc.", "2024-12345 BC Ltd.") carry a suffix
//   and are covered. Conservative: a bare "<name> Holdings" without a suffix is NOT
//   treated as corporate (false-positive — extra doc ask on a personal borrower — is
//   friction; false-negative is the gap Franco wants closed, but we still require an
//   UNAMBIGUOUS signal: a real suffix).
// Layer 2 (BEST-EFFORT, heuristic): additional corporations the director may own
//   collateral under. Honest scope — over-claiming precision hurts more than honest
//   best-effort. A confirmed-linkage additional entity gets a doc-ask; an ambiguous
//   one is NOT silently guessed — it raises clarificationPending (broker confirms).
// Numeric evaluation of financial-statement CONTENTS (once provided) is OUT OF SCOPE —
// that is the qualification path's job (LLM-narrative). Q5's scope is the DOC-ASK.

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Suffix that unambiguously marks a corporate entity (mirrors isCommercialSubmission;
// deliberately EXCLUDES bare "Holdings"/"Group"/"Capital" which are ambiguous alone).
const ENTITY_SUFFIX_RE = /\b(?:Inc|Incorporated|Ltd|Limited|Corp|Corporation|LLC|LLP)\.?\b/i;

// Match a corporate entity NAME (start through a suffix) for Layer-2 scanning.
// Each entity word must start capitalized or numeric (proper-noun-like) so
// lowercase connectors ("for"/"through"/"and") are NOT absorbed into the name.
const ENTITY_NAME_RE = /([A-Z0-9][A-Za-z0-9&.\-']*(?:\s+[A-Z0-9][A-Za-z0-9&.\-']*){0,4}\s+(?:Inc|Incorporated|Ltd|Limited|Corp|Corporation)\.?)/g;

// Ownership/collateral linkage words → an additional entity is "confirmed" associated.
const LINKAGE_RE = /\b(own|owns|owned|owning|through|under|holds?|holding|collateral|propert|also|another|other\s+(?:corp|compan|entit|holding))\b/i;

const detectCorporateEntities = ({ borrowerName = '', textSources = '' } = {}) => {
  const EMPTY = { isCorporate: false, primaryEntity: null, additionalEntities: [], allEntities: [], docAskLines: '', clarificationPending: false, clarificationMessage: null, entityCount: 0 };
  if (!borrowerName || !ENTITY_SUFFIX_RE.test(borrowerName)) return EMPTY;

  const primaryEntity = String(borrowerName).trim().replace(/\s+/g, ' ');
  const text = String(textSources || '');
  const seen = new Set([norm(primaryEntity)]);
  const additionalEntities = [];
  let m;
  ENTITY_NAME_RE.lastIndex = 0;
  while ((m = ENTITY_NAME_RE.exec(text))) {
    const name = m[1].trim().replace(/\s+/g, ' ');
    const key = norm(name);
    if (seen.has(key)) continue;
    seen.add(key);
    const pre = text.slice(Math.max(0, m.index - 60), m.index);
    const confidence = LINKAGE_RE.test(pre) ? 'confirmed' : 'pending';
    additionalEntities.push({ name, confidence, signal: pre.trim().slice(-40) });
  }

  const confirmed = additionalEntities.filter(e => e.confidence === 'confirmed');
  const pending = additionalEntities.filter(e => e.confidence === 'pending');

  // Doc-ask: primary + confirmed-additional entities (pending entities wait for
  // broker confirmation before we add their ask).
  const askEntities = [primaryEntity, ...confirmed.map(e => e.name)];
  const docAskLines = askEntities
    .map(n => `- Accountant-prepared financial statements for ${n} (most recent fiscal year)`)
    .join('\n');

  const clarificationPending = pending.length > 0;
  const clarificationMessage = clarificationPending
    ? `We noted ${pending.map(e => e.name).join(', ')} in the submission — ${pending.length > 1 ? 'are these corporations' : 'is this corporation'} associated with collateral being used for this loan? If yes, we'll need accountant-prepared financial statements for ${pending.length > 1 ? 'each' : 'it'} as well.`
    : null;

  const allEntities = [
    { name: primaryEntity, role: 'primary' },
    ...confirmed.map(e => ({ name: e.name, role: 'additional_confirmed' })),
    ...pending.map(e => ({ name: e.name, role: 'additional_pending' })),
  ];

  return {
    isCorporate: true,
    primaryEntity,
    additionalEntities,
    allEntities,
    docAskLines,
    clarificationPending,
    clarificationMessage,
    entityCount: allEntities.length,
  };
};

module.exports = { detectCorporateEntities };
