// R5 Cluster E refined (2026-05-21): selectGreetingFirstName helper.
//
// Pre-E refined, Vienna's broker-facing greeting on followup turns +
// identity-clash minimal-ask + cron reminders was derived from the deal
// summary's `sender_name` (Postmark From-name). Production failure mode
// (Anna 11196627 Eric Johansson, R4-S15): the sender is Franco's testing-
// proxy address (franco@vimarealty.com / FromName="Franco Maione"), so
// sender_name first-token = "Franco" → name-collision-with-admin fallback
// fires → generic "Hi there!" / "Hi Franco!" greetings across all 5 reply
// shapes on the deal. The TRUE broker (Eric Johansson) is correctly
// extracted into `broker_name` at processInitialEmail time (LLM + C.7
// parser both succeed), but `broker_name` was never consulted for greeting
// selection in any downstream prompt.
//
// FIX: deterministic JS-side selection. Helper prefers the right name
// per sender_type, anti-collides against admin's first name as defense-
// in-depth, returns null when no defensible greeting target exists
// (caller renders generic "Hi there!" / "Hello!").
//
// SELECTION POLICY (priority order):
//   - sender_type='borrower' → borrower_name → fallback sender_name
//   - else (broker, default) → broker_name → fallback sender_name
//   - anti-collision: if chosen first-name lowercase-equals ADMIN_FIRST_NAME,
//     return null. Handles BOTH the proxy-shadow case (sender_name="Franco
//     Maione") AND the rare genuine-broker-named-Franco case.
//
// SHAPE TOLERANCE: accepts full names ("Eric Johansson") or first-only
// ("Eric") — caller-flexible. Splits on whitespace, takes first token,
// validates Title-Case shape. Returns null on non-name tokens.

const ADMIN_FIRST_NAME = 'Franco';

const extractFirstName = (full) => {
  if (!full || typeof full !== 'string') return null;
  const tok = full.trim().split(/\s+/)[0];
  if (!tok) return null;
  // Title-Case first-name shape (allows hyphens like "Ji-Young", apostrophes
  // like "O'Connor" though those are last-name shaped — first-name is just
  // the leading capitalized token, hyphenation OK).
  if (!/^[A-Z][a-zA-Z\-']*$/.test(tok)) return null;
  return tok;
};

const selectGreetingFirstName = ({ broker_name, sender_name, borrower_name, sender_type } = {}) => {
  let candidate;
  if (sender_type === 'borrower') {
    candidate = extractFirstName(borrower_name) || extractFirstName(sender_name);
  } else {
    candidate = extractFirstName(broker_name) || extractFirstName(sender_name);
  }
  if (!candidate) return null;
  // Anti-collision: chosen candidate must not equal admin's first name
  // (case-insensitive). Defense against:
  //   (a) sender_name="Franco Maione" leaking through when broker_name was empty
  //   (b) rare-but-possible broker actually named Franco
  if (candidate.toLowerCase() === ADMIN_FIRST_NAME.toLowerCase()) return null;
  return candidate;
};

module.exports = {
  selectGreetingFirstName,
  extractFirstName,
  ADMIN_FIRST_NAME,
};
