// FRANCO-Q11 (Franco 2026-05-30) — registered-property-owner rule.
//
// Franco's words: "Whoever is/are the registered property owner(s) must be on the
// application regardless. If there's only one registered property owner, the other
// applicant would be a guarantor."
//
// Two product effects:
//   (1) A registered owner NOT listed as an applicant → require them (broker clarification).
//   (2) A non-owner applicant on a SINGLE-registered-owner deal → GUARANTOR (definitively,
//       superseding Q4's ambiguous-cosigner default — Q11 is a hard owner-vs-not test).
//
// Conservative (Q4 lineage, failure-mode asymmetry): acts ONLY on EXPLICIT registered-owner
// signals ("registered owner", "on title", "sole owner", "holds title"). Absent a signal,
// no Q11 classification — defers to Q3/Q4. This avoids mislabeling a co-applicant as a
// guarantor on a silent deal (the under-qualify error Q4 already guards).

const OWNER_SIGNAL_RE = /\b(?:registered\s+(?:property\s+)?owner|on\s+title|sole\s+owner|holds?\s+title|title\s+holder|owner\s+of\s+record)\b/i;
const SOLE_RE = /\bsole\s+(?:registered\s+)?(?:property\s+)?owner|\bsole(?:ly)?\s+on\s+title|\bonly\s+(?:one\s+)?(?:registered\s+owner|on\s+title)|\bsole\s+title\s+holder|\bowns?\s+it\s+(?:solely|alone|on\s+(?:his|her|their)\s+own)/i;
const BOTH_RE = /\bboth\b[^.]{0,45}\b(?:on\s+title|registered\s+owners?|owners?\s+of\s+record|title\s+holders?)\b|\b(?:joint(?:ly)?|co)[-\s]?own/i;

// Text within ±radius chars of each occurrence of `name` (case-insensitive).
const windowAround = (text, name, radius = 70) => {
  if (!name || !text) return '';
  const lower = String(text).toLowerCase();
  const target = String(name).toLowerCase();
  let idx = lower.indexOf(target), out = '';
  while (idx !== -1) { out += ' ' + text.slice(Math.max(0, idx - radius), idx + target.length + radius); idx = lower.indexOf(target, idx + target.length); }
  return out;
};

// Extract owner names from explicit "<Name> is/are [the] [sole] registered owner / on title"
// and "registered owner is/are <Name>" patterns. Borrower-shaped full names (First Last[+1]).
// Borrower/entity-shaped name (First Last[+1]); a trailing "." is consumed ONLY as an
// ABBREVIATION period ("Webb Holdings Ltd.", "Inc.") — NOT a sentence-ending period (one
// followed by a new sentence's capital), so "Marcus Webb. Jennifer Tran is the owner" does
// NOT let "Marcus Webb." swallow the boundary and bind to Jennifer's owner phrase.
const NAME = "[A-Z][a-zA-Z'\\-]+(?:\\s+[A-Z][a-zA-Z'\\-]+){1,2}(?:\\.(?!\\s+[A-Z]))?";
// Connectors are period/newline-bounded (`[^.\n]`) so an owner phrase cannot bind across a
// sentence boundary to an upstream name — combined with the abbreviation-only NAME period,
// "Marcus Webb. Jennifer Tran is the registered owner" correctly binds to Jennifer.
// Case-flexible owner/is terms (so the regex stays case-SENSITIVE for NAME's capital anchor
// — the `i` flag would make [A-Z] match lowercase and over-capture, e.g. "Refi for Marcus").
const IS = '(?:[Ii]s|[Aa]re)';
const OWNER = '(?:[Rr]egistered\\s+(?:[Pp]roperty\\s+)?[Oo]wner|[Oo]n\\s+[Tt]itle|[Tt]itle\\s+[Hh]older|[Oo]wner\\s+of\\s+[Rr]ecord)';
const OWNER_NAME_RE = new RegExp('\\b(' + NAME + ')[^.\\n]{0,35}?\\b' + IS + '\\b[^.\\n]{0,25}?\\b(?:[Tt]he\\s+)?(?:[Ss]ole\\s+)?' + OWNER + '\\b', 'g');
const OWNER_NAME_RE2 = new RegExp('\\b' + OWNER + 's?\\b[^.\\n]{0,20}?\\b' + IS + '\\b\\s+(' + NAME + ')', 'g');

// Detect registered property owners asserted in the text.
//   textSources    : broker email body + doc text
//   candidateNames : the applicants / detected borrowers (for proximity + "both" expansion)
// Returns { signalPresent, owners:[names], soleOwnerExplicit }
const detectRegisteredOwners = (textSources, candidateNames = []) => {
  const text = String(textSources || '');
  const names = (candidateNames || []).filter(Boolean);
  if (!OWNER_SIGNAL_RE.test(text)) return { signalPresent: false, owners: [], soleOwnerExplicit: false };
  // "both on title" / "jointly own" → all named applicants are owners (no sole-owner downgrade).
  if (BOTH_RE.test(text)) return { signalPresent: true, owners: names.slice(), soleOwnerExplicit: false };
  // Extract explicitly-named owners by NAME (the subject of the owner assertion) — may
  // include owners NOT on the application. NOTE: deliberately NO bare proximity fallback —
  // a name sitting NEAR an owner phrase that refers to someone else (e.g. "...the sole
  // registered owner. Patricia is his spouse") must NOT be mislabeled an owner.
  const found = new Map(); // key→display
  for (const re of [OWNER_NAME_RE, OWNER_NAME_RE2]) {
    re.lastIndex = 0; let m;
    while ((m = re.exec(text))) { const nm = m[1].trim(); found.set(nm.toLowerCase().replace(/\.+$/, ''), nm); }
  }
  const owners = Array.from(found.values());
  const soleOwnerExplicit = SOLE_RE.test(text) || owners.length === 1;
  return { signalPresent: owners.length > 0, owners, soleOwnerExplicit };
};

module.exports = { detectRegisteredOwners, OWNER_SIGNAL_RE };
