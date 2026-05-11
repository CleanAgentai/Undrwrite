// Group DDDD (S6.2): admin-reply subject detection — shared utility.
//
// Origin: Group MMM (S13.1) introduced this heuristic in cron/dailySummary.js
// to filter admin-direction inbounds out of the daily summary's "Emails
// Received" section. Admin replies to Vienna's HITL emails are stored as
// direction='inbound' (the existing pattern at webhook.js admin-reply handlers)
// but inherit Vienna's controlled outbound-to-admin subject prefixes — the
// heuristic detects them by subject pattern.
//
// DDDD extracts the heuristic into a shared utility because webhook.js now
// also needs it: generateLeadSummary's conversation log was mis-attributing
// admin "approved" replies to the broker (S6.2 production case). The pre-DDDD
// architecture (webhook importing cron) would have been a smell — webhook is
// foundation, cron consumes it. The shared util eliminates the directionality
// concern.
//
// Subject patterns matched (Vienna's outbound-to-admin signals that admin
// replies inherit via Re: prefixes):
//   - "ACTION REQUIRED:" (prelim review or LTV escalation HITL)
//   - "[UPDATED] ACTION REQUIRED:" (Fix 2 / NNN refresh)
//   - "FINAL REVIEW:" (all-docs FINAL REVIEW HITL — defense-in-depth path
//     post-CCCC; still fires when prelim_approved_at is null)
//   - "[Conditions Fulfilled]" (Group BBB conditions-fulfilled handoff notice)
//   - "[File Complete]" (Group NNN+CCCC completion handoff notice — non-
//     conditions path)
//   - "[Broker Update]" — retired path but tolerated for old in-flight deals
//
// HHH (awaiting_identity_confirmation): no admin-bound subject — silent gate.
// VVV (awaiting_collateral): same. No regex update needed for these.

const ADMIN_REPLY_SUBJECT_RE = /^(?:Re:\s+)+(?:\[UPDATED\]\s+)?(?:ACTION REQUIRED:|FINAL REVIEW:|\[Conditions Fulfilled\]|\[File Complete\]|\[Broker Update\])/i;

const isAdminReplySubject = (subject) => ADMIN_REPLY_SUBJECT_RE.test(subject || '');

module.exports = { ADMIN_REPLY_SUBJECT_RE, isAdminReplySubject };
