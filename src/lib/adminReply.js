// Audience-classification helpers — Vienna's admin↔broker email-thread
// directionality.
//
// TWO HELPERS, DIFFERENT AUDIENCE DIRECTIONS (R7-B docblock clarification,
// 2026-05-22):
//
//   isAdminReplySubject(subject) — detects ADMIN → Vienna REPLY/INBOUND
//     subjects. Matches subjects with the Re: prefix following Vienna's
//     outbound-to-admin originals (e.g., "Re: ACTION REQUIRED: PRELIMINARY
//     Review — ..."). Used by webhook's labelMessagesForLeadSummary +
//     R6-ζ's brokerRepliedSinceLastViennaOutbound walk to filter admin
//     replies OUT of broker-attribution conversation history.
//
//   isAdminFacingSubject(subject) — detects ADMIN-DIRECTION subjects
//     regardless of Re: depth. Matches Vienna's outbound-to-admin
//     originals ("ACTION REQUIRED: ...", "[File Complete] ..."), Vienna's
//     draft-preview re-sends ("Re: Re: ACTION REQUIRED: ..."), AND
//     admin's inbound replies ("Re: ACTION REQUIRED: ..."). Used by
//     executeDraft's broker-thread construction + R7-B's cron reminder-
//     threading filter — invert into a broker-conversation filter so
//     admin-cycle messages don't leak into the broker-thread header chain.
//
//   When to use which:
//     • Need to detect "is this message an admin reply specifically?" →
//       isAdminReplySubject.
//     • Need to detect "is this message part of any admin-direction
//       thread?" (i.e., should it be filtered out of broker context) →
//       isAdminFacingSubject.
//
//   Direction-of-flow distinction matters for the audience filter
//   semantic. Both helpers operate on the same `subject` string but
//   answer different questions about thread participation.
//
// ─── ORIGIN HISTORY ────────────────────────────────────────────────
//
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

// Group LLLL (S15.3+): broader predicate that matches admin-direction messages
// regardless of Re: depth — catches Vienna's outbound originals ("ACTION
// REQUIRED: ..."), Vienna's draft-preview re-sends ("Re: Re: ACTION REQUIRED:
// ..."), AND admin's inbound replies ("Re: ACTION REQUIRED: ..."). Includes
// "Daily Summary" (outbound-only, no Re: variant). Used by executeDraft's
// broker-thread construction to invert into a broker-conversation filter so
// admin-cycle messages don't leak into the broker-thread header chain.
//
// Kept distinct from isAdminReplySubject because the existing callers (cron's
// "Emails Received" filter, DDDD admin-label heuristic in generateLeadSummary)
// depend on the reply-only semantic — they specifically want admin REPLIES,
// not Vienna's outbound-to-admin originals.
const ADMIN_FACING_SUBJECT_RE = /^(?:Re:\s+)*(?:\[UPDATED\]\s+)?(?:ACTION REQUIRED:|FINAL REVIEW:|\[Conditions Fulfilled\]|\[File Complete\]|\[Broker Update\]|Daily Summary)/i;

const isAdminFacingSubject = (subject) => ADMIN_FACING_SUBJECT_RE.test(subject || '');

module.exports = { ADMIN_REPLY_SUBJECT_RE, isAdminReplySubject, ADMIN_FACING_SUBJECT_RE, isAdminFacingSubject };
