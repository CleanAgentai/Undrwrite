const express = require('express');
const router = express.Router();
const { isAdminReplySubject, isAdminFacingSubject } = require('../lib/adminReply');
// Group KKKK: SSS-era doc-requirement helpers hoisted to dealType.js so
// ai.js can also consume them (circular-dep avoidance — webhook.js requires
// ai.js, so ai.js can't require webhook.js back). Single canonical source.
const {
  isPurchaseFromSummary,
  DOC_SYNONYMS,
  isDocRequirementSatisfied,
  BASE_REQUIRED_INTAKE_REFINANCE,
  BASE_REQUIRED_INTAKE_PURCHASE,
  COMPLIANCE_REQUIRED_POSTAPPROVAL,
  intakeRequiredFor,
  allRequiredForCompletion,
  allIntakeReceived,
} = require('../lib/dealType');
const config = require('../config');
const emailService = require('../services/email');
const aiService = require('../services/ai');
const dealsService = require('../services/deals');
const dEngine = require('../services/discrepancy-engine');

// Track processed message IDs to prevent duplicate processing
const processedMessages = new Set();

// Bug B Layer A — broker-name extraction rescue (defense in depth on top of
// Bradley's prompt-side RECIPIENT NAME RULE blocks). Catches the case where
// Claude returns sender_name=null/'Unknown', or where Claude has been confused
// by an inbound body addressed to "Hi Franco" and extracts "Franco" as the
// sender. Fallback: the Postmark From-header display name.
//
// Admin's first name is parsed from config.adminEmail so the guard tracks if
// the admin email ever changes. Comparing against the FIRST WORD of the
// extracted name (case-insensitive) avoids false positives on substring
// matches like "Frank" or "Johnson".
const ADMIN_FIRST_NAME = (() => {
  const local = (config.adminEmail || '').split('@')[0] || '';
  return local.split(/[.+]/)[0].toLowerCase().trim();
})();

const firstNameOf = (name) => String(name || '').trim().split(/\s+/)[0].toLowerCase();

const isUnreliableName = (name) => {
  const trimmed = String(name || '').trim();
  if (!trimmed) return true;
  if (trimmed.toLowerCase() === 'unknown') return true;
  if (ADMIN_FIRST_NAME && firstNameOf(trimmed) === ADMIN_FIRST_NAME) return true;
  return false;
};

// Tighter than isUnreliableName: only matches the Franco-pattern, not empty/null/Unknown.
// Used by the F2 pre-Claude collision check in webhook to avoid the over-fire where an
// empty Postmark FromName was being treated as a Franco-collision (regression observed
// in S1/S2/S3 retest — Vienna greeted Chris/Marcus/Brian as "Hi there!" because their
// emails arrived without a display name and isUnreliableName('') returned true).
const firstNameMatchesAdmin = (name) => {
  if (!ADMIN_FIRST_NAME) return false;
  const first = firstNameOf(name);
  return first.length > 0 && first === ADMIN_FIRST_NAME;
};

// Group KKKK (S1.1/S2.1/S5.1): SSS-era doc-requirement constants + helpers
// (DOC_SYNONYMS, isDocRequirementSatisfied, BASE_REQUIRED_INTAKE_*,
// COMPLIANCE_REQUIRED_POSTAPPROVAL, intakeRequiredFor, allRequiredForCompletion)
// hoisted to src/lib/dealType.js. They're imported at the top of this file
// and re-exported via __test__ for backward compat with existing SSS/NNN/
// CCCC/EEEE/JJJJ test-trigger references. The hoist was required so ai.js
// can also consume them — circular-dep avoidance (webhook.js requires
// ai.js, so ai.js can't require webhook.js back).

// Group VVV (S4.1): skip blank intake forms (Loan Application + PNW Statement)
// on the welcome email when the deal will route to a "deferred-intake" state.
// Currently two deferred-intake states:
//   - awaiting_collateral (Fix 7): LTV > 80 + no collateral_offered yet — Vienna's
//     welcome asks ONLY the collateral question. Most high-LTV deals get declined
//     → forms wasted (S4.1 production observation).
//   - awaiting_identity_confirmation (HHH): identity_clash=true — Vienna's welcome
//     asks ONLY the borrower-name clarification. Forms wasted if the docs turn
//     out to belong to a different borrower's file.
// Predicate matches the state-transition logic at the new-client INITIAL gate
// (identity_clash takes priority over LTV per HHH). Pure function — caller passes
// the freshly-extracted dealSummary. Per Q3-VVV: applies regardless of
// sender_type (borrowers in deferred state skip forms too).
const shouldSkipIntakeFormsForDeferredState = (dealSummary) => {
  if (!dealSummary) return false;
  if (dealSummary.identity_clash) return true;
  const ltv = dealSummary.ltv_percent;
  return !!(ltv && ltv > 80);
};

// Group EEEE (S12.2): compute the intake_asked_items snapshot at intake time.
// Pure function — caller passes dealSummary + classifications already on file.
// Returns:
//   - Array of classification strings (+ optional 'exit_strategy') for broker-
//     path deals not in a deferred-intake state. Empty array if everything was
//     pre-attached (broker submitted full package upfront).
//   - null for borrower-path / identity_clash / high-LTV deals (Vienna's
//     welcome doesn't ask for the standard intake doc list in those states —
//     no snapshot to record; cron falls back to current baseRequired).
//
// Snapshot drives cron reminders post-EEEE: cron uses snapshot if non-null/
// non-empty, else falls back to baseRequired (Q6-EEEE: forward-only, let-it-go
// for pre-EEEE deals + deferred-intake states). Pre-EEEE failure mode:
// cross-policy drift between intake-time baseRequired and reminder-time
// baseRequired (post-JJJ AML/PEP removed, post-TTT gov ID + property tax
// added) — reminders enumerated items Vienna never asked for.
const computeIntakeAskedItems = (dealSummary, classificationsOnFile = []) => {
  const isBrokerPath = dealSummary?.sender_type === 'broker';
  if (!isBrokerPath) return null;
  // Deferred-intake states: Vienna's welcome asks ONE specific question, not
  // the doc list. No snapshot (cron falls back to baseRequired if the deal
  // ever reaches a state where reminders fire).
  if (dealSummary?.identity_clash) return null;
  const ltv = dealSummary?.ltv_percent;
  if (ltv && ltv > 80) return null;
  // Broker-path, non-deferred-intake: compute the snapshot.
  const intakeBase = intakeRequiredFor(isPurchaseFromSummary(dealSummary));
  const askedItems = intakeBase.filter(req => !isDocRequirementSatisfied(req, classificationsOnFile));
  if (!dealSummary?.exit_strategy) askedItems.push('exit_strategy');
  return askedItems;
};

// Group JJJJ (S15.2): exclude misattached docs from the prelim-review gate.
// Vienna's processInitialEmail / generateBrokerResponse emit
// misattached_documents — an array of EXACT filenames whose CONTENT doesn't
// belong to the canonical deal file (either wrong borrower name OR wrong
// property address OR both — any axis is sufficient). The gate's
// hasReviewableDoc check (income_proof/noa/appraisal) must filter those out, or
// the prelim fires on docs that don't apply (Anna Bergstrom production case:
// Grace Paulson's appraisal for 88 Harvest Hills triggered prelim despite
// Vienna correctly annotating it as wrong-property in §9; the gate had no
// concept of misattachment). Re-evaluated by Claude every turn — if broker
// resends a correct replacement, the old filename stays in the array (still
// on file, still misattached) but the new doc is NOT in it, so the gate sees
// the new doc as eligible.
const eligibleDocsForGate = (docs, dealSummary) => {
  const misattached = new Set(
    Array.isArray(dealSummary?.misattached_documents)
      ? dealSummary.misattached_documents
      : []
  );
  if (misattached.size === 0) return docs;
  return docs.filter(d => !misattached.has(d.file_name));
};

// Group DDDD (S6.2): pre-label messages JS-side so admin replies (stored as
// direction='inbound' on under_review deals per the HITL pattern) get
// attributed to "Admin (Franco)" rather than the broker_name when rendered
// in the conversation log. Pre-DDDD the rendering loop in generateLeadSummary
// labeled EVERY inbound as "INBOUND from [broker_name]" — production case
// Kevin Tran 65676a8f: Franco's "approved" reply on the [UPDATED] PRELIMINARY
// Review (msg 5, subject "Re: [UPDATED] ACTION REQUIRED: PRELIMINARY Review")
// rendered in admin's COMPLETE Review log as "INBOUND from Sarah Okonkwo —
// approved". Mis-attribution.
//
// Heuristic via shared isAdminReplySubject (src/lib/adminReply.js) — same
// pattern MMM uses to filter admin replies from daily summary's broker
// activity. Outbound messages always get "OUTBOUND from Vienna". Inbound
// messages with admin-pattern subjects get "INBOUND from Admin (Franco)";
// non-admin inbounds get the broker_name fallback (existing default).
// Applied at the call sites that pass messages to generateLeadSummary +
// generateBrokerResponse — pre-labeling is deterministic; prompts use
// `m.senderLabel || <fallback>` with backward-compat fallback to the
// inline label logic for callers that don't pre-label.
const labelMessagesForLeadSummary = (messages, brokerName) => {
  const fallbackBroker = brokerName || 'Broker';
  return (messages || []).map(m => {
    if (m.direction !== 'inbound') {
      return { ...m, senderLabel: 'OUTBOUND from Vienna' };
    }
    if (isAdminReplySubject(m.subject)) {
      return { ...m, senderLabel: 'INBOUND from Admin (Franco)' };
    }
    return { ...m, senderLabel: `INBOUND from ${fallbackBroker}` };
  });
};

// Group YYY (S5.3): build the References-header chain for a draft preview reply.
// Pre-YYY chain was [...admin.references, admin.messageId] — relied on admin's
// email client to echo Vienna's prior outbound IDs in its own References header.
// If the client truncates the chain (Gmail does this on long threads) or strips
// References entirely, the thread loses its anchor and Gmail/Outlook fall back
// to subject-based threading — which fragments because each preview gets another
// "Re:" prefix. S5.3 production observation: parallel near-identical threads
// accumulated, broker risk of replying to the wrong thread.
//
// Post-YYY: anchor on Vienna's outbound IDs from the DB. Chain order is:
//   1. All Vienna outbound IDs in chronological order (oldest first — RFC convention)
//   2. Admin's incoming References (may overlap; deduped)
//   3. Admin's latest messageId
// Dedup key strips angle brackets and @domain so raw-UUID and wrapped/qualified
// variants of the same ID are recognized as duplicates.
//
// Extracted as a pure function (no DB, no I/O) so the truth table can exercise
// it without mocking the request pipeline. Caller fetches outbound IDs from the
// DB and passes them in.
const buildPreviewThreadChain = ({ outboundIds = [], inboundReferences = [], latestMessageId = null } = {}) => {
  const raw = [...outboundIds, ...inboundReferences, latestMessageId].filter(Boolean);
  const normalize = (id) => String(id).replace(/^</, '').replace(/>$/, '').split('@')[0];
  const seen = new Set();
  return raw.filter(id => {
    const key = normalize(id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// Group LLLL (S15.3+): extract the broker-conversation slice of the message log
// for thread-header construction on broker-facing sends (executeDraft).
// Counterpart to YYY's admin-thread construction at the draft-preview path:
// YYY pulls Vienna's full outbound chain anchored on admin's current reply
// (admin-direction); LLLL pulls the broker-conversation subset filtered AWAY
// from admin-facing subjects (broker-direction).
//
// Production case driving the fix: Derek Olsen 2026-05-16 (deal b1ba76b0).
// Karen's submission subject was "Derek Olsen — Potential Deal". After admin
// approved the prelim and SEND'd the doc-request draft, executeDraft sent it
// to broker with Claude-composed draft_subject "Re: Derek Olsen" (no descriptor)
// and empty headers — new thread in Karen's inbox. LLLL anchors the subject on
// the earliest broker-direction inbound + populates In-Reply-To/References
// from Vienna's broker-direction outbound chain.
//
// Filter: !isAdminFacingSubject(m.subject). Catches both directions of
// admin-side traffic (Vienna's outbound prelim/final/handoff originals +
// admin's inbound replies + draft-preview cycles) regardless of Re: depth.
//
// In-Reply-To anchored on Vienna's last broker-direction outbound (not
// broker's last inbound) because saveMessage doesn't currently persist
// external_message_id for inbound messages. The broker's mail client's
// References chain already contains Vienna's prior outbound IDs (it built
// them when broker replied), so anchoring our next outbound on Vienna's
// prior outbound chains correctly for both Gmail (References-based) and
// Outlook (In-Reply-To-based) threading.
const buildBrokerThreadInputs = (allMessages = []) => {
  const brokerMessages = allMessages.filter(m => !isAdminFacingSubject(m.subject));
  const brokerOutbounds = brokerMessages.filter(m => m.direction === 'outbound' && m.external_message_id);
  const earliestBrokerInbound = brokerMessages.find(m => m.direction === 'inbound');
  const latestBrokerOutbound = brokerOutbounds.length > 0 ? brokerOutbounds[brokerOutbounds.length - 1] : null;
  return {
    outboundIds: brokerOutbounds.map(m => m.external_message_id),
    inboundReferences: [],
    latestMessageId: latestBrokerOutbound ? latestBrokerOutbound.external_message_id : null,
    earliestBrokerSubject: earliestBrokerInbound ? earliestBrokerInbound.subject : null,
  };
};

// Group SSS Site 4 + Group CCCC (S6.1 + S7.2): JS-authoritative completion-path
// dispatch for the active branch. Pre-SSS this was Claude's allDocsReceived
// flag (probabilistic). Post-SSS: JS classifications + exit_strategy (deterministic).
// Post-CCCC: also routes between FINAL REVIEW (defense-in-depth) and the
// completion-handoff path (skip FINAL REVIEW when admin already approved at
// prelim — prelim_approved_at signal mirrors BBB's conditions_sent_at).
//
// Returns one of three actions:
//   - 'completion-handoff' : gates pass AND deal.prelim_approved_at is set.
//                            Caller invokes sendCompletionHandoff(...,
//                            { conditionsFulfilled: false }). Skips FINAL
//                            REVIEW noise (S6.1 + S7.2).
//   - 'final-review'       : gates pass AND deal.prelim_approved_at is null.
//                            Defense-in-depth (Q3-CCCC): pre-CCCC deals,
//                            write failures, or edge cases get the safe
//                            fallback FINAL REVIEW HITL.
//   - null                 : gates fail (not active, LTV/identity gate
//                            firing, intake incomplete, exit_strategy missing).
//
// Extracted as a pure function so the truth table can exercise it without
// mocking the full request pipeline (matches NNN's decideReviewDispatch pattern).
// Group NNNN (S3.3/S3.4 residual gap): active-branch willReview gate. Pre-NNNN
// the gate had no prelim_approved_at suppression — after admin approved at
// prelim and status flipped back to 'active' for post-approval doc collection,
// the FIRST partial-doc broker turn would re-fire willReview (gates pass: LTV
// ≤ 80, hasReviewableDoc carried over from intake, hasExitStrategy) BEFORE
// completion-handoff could fire (allDocsIn still false until the LAST broker
// turn submits the remaining intake/compliance docs). The post-MMMM Derek-
// shape bug (S3.3/S3.4) collapsed onto the false-positive purchase
// classification; NNNN closes the residual gap for correctly-classified
// refinances where post-approval doc collection splits across multiple
// broker turns. Production pattern: admin approves prelim → broker submits
// gov ID turn 1 → spurious second prelim → broker submits AML/PEP turn 2 →
// completion-handoff. Post-NNNN: turn 1 falls through to conversational
// handler (broker gets acknowledgment + ask for remaining docs); turn 2
// triggers completion-handoff correctly.
//
// Extracted as a pure function so the 12+ truth-table cases (including the
// exact split-turn regression repro) can exercise the gate without mocking
// the full request pipeline. This gate has now been wrong twice — BBBB's
// exit_strategy gap and NNNN's prelim_approved_at gap — and earns the truth
// table as a regression-prevention investment.
//
// INTENTIONAL ASYMMETRY: the initial branch (new-client INITIAL at
// webhook.js's `if (!existingDeal)` block) does NOT use this helper. The
// initial branch's gate is inline because prelim_approved_at is null by
// construction on a deal just created — the !deal.prelim_approved_at clause
// would be a no-op there, and a no-op clause is confusing dead code. The
// asymmetry is asserted by a source-string regression test that catches any
// future attempt to wire computeWillReview into the initial branch.
const computeWillReview = ({ deal, summary, classifications, identityClashUnresolved }) => {
  const ltv = summary?.ltv_percent;
  const hasReviewableDoc = ['income_proof', 'noa', 'appraisal'].some(c => (classifications || []).includes(c));
  const hasExitStrategy = !!(summary?.exit_strategy && String(summary.exit_strategy).trim());
  return !!(
    ltv && ltv <= 80
    && deal?.status === 'active'
    && hasReviewableDoc
    && hasExitStrategy
    && !identityClashUnresolved
    && !deal?.prelim_approved_at
    && !summary?.unresolved_discrepancy   // ← QQQQ (S8.1+S8.2): 3rd per-trigger gate clause
  );
};

// Group OOOO (S6.1): pre-approval enumeration of items blocking the willReview
// gate. Used by generateBrokerResponse to suppress Vienna's over-promising
// "we have everything we need to send the file for review" template when the
// JS gate would actually hold. Production case (Kevin Tran 2026-05-16, deal
// ef05f551): exit_strategy null → willReview correctly held, but Vienna's
// conversational reply said "I believe we have everything we need to send
// the file for review" — file stalled with no prelim ever firing; only cron
// reminders nudged Vienna into asking for exit_strategy on subsequent turns.
//
// Same primer pattern as KKKK: JS-computed signal → prompt-block injection
// instructs Claude on what to say (enumerate items) and what to NOT say
// (FORBIDDEN PHRASES — the verbatim over-promising template + paraphrases).
//
// Returns array of broker-actionable item strings. Empty when:
//   - Out-of-scope (status not 'active', or prelim_approved_at set [KKKK
//     handles post-approval conversational follow-up], or
//     identityClashUnresolved [HHH handles identity-clash re-ask], or
//     LTV > 80 [Fix 7 collateral path — different conversation]).
//   - All gate conditions pass — willReview would fire on this turn and
//     Vienna's conversational reply gets suppressed at the active-branch
//     dispatch anyway.
//
// Non-empty when in-scope (active, pre-approval, no identity clash, LTV
// in range) AND one or more gate predicates fails on broker-actionable
// items. Sibling helper to computeWillReview — both consume the same
// inputs; this one enumerates what's missing, that one returns the
// boolean gate decision.
//
// Forward-note (logged for future cleanup, NOT in OOOO's scope): the
// generateBrokerResponse prompt at ai.js:570 unconditionally hands Claude
// the over-promising template; OOOO's override-block + ban-list addresses
// the symptom. The cleaner long-term structure is making that template
// conditional at its source rather than handing it unconditionally then
// forbidding it via injection. Out of scope for this commit.
const computeStillMissingForReview = ({ deal, summary, classifications, identityClashUnresolved }) => {
  // Out-of-scope branches: different states own these flows.
  if (deal?.status !== 'active') return [];
  if (deal?.prelim_approved_at) return [];     // KKKK handles post-approval
  if (identityClashUnresolved) return [];      // HHH handles identity-clash re-ask

  const ltv = summary?.ltv_percent;
  // LTV > 80 routes through Fix 7's awaiting_collateral state — different
  // conversation (collateral question, not missing-docs ask). Suppress.
  if (ltv && ltv > 80) return [];

  const items = [];
  const hasReviewableDoc = ['income_proof', 'noa', 'appraisal'].some(c => (classifications || []).includes(c));
  const hasExitStrategy = !!(summary?.exit_strategy && String(summary.exit_strategy).trim());

  if (!ltv) items.push('a current property appraisal (so we can confirm LTV)');
  if (!hasReviewableDoc) items.push('a reviewable document (current appraisal, NOA, or proof of income)');
  if (!hasExitStrategy) items.push('exit strategy (how the borrower plans to repay or refinance out at maturity)');

  return items;
};

// Group RRRR (S8.3): extract the admin's stated decline reason from the
// parsed admin reply text. parseAdminReply returns { intent, message } where
// message carries the full admin text; pre-RRRR generateRejectionEmail only
// received dealSummary, so the admin's reason (e.g. "DECLINE — borrower's
// credit scores (729/735) do not meet our minimum threshold for this loan
// size.") was discarded and Vienna's broker-facing rejection omitted the
// reason entirely (Sandra Fletcher 2026-05-17 production case).
//
// MANDATORY FALLBACK GUARANTEE: when the strip pattern doesn't match an
// unexpected admin format (e.g. "scores too low. decline." or any non-
// standard ordering), return the FULL admin message text rather than null.
// The failure mode we must never hit is "reason omitted" — that IS the bug.
// Including slightly too much (an unstripped prefix) is acceptable; dropping
// the reason because the format was unexpected is not.
//
// Returns:
//   - null when adminMessage is empty / whitespace / a decline-only word
//     (no reason text present at all) → prompt falls back to generic decline.
//   - The stripped reason text when the message matches a known
//     "DECLINE/REJECT[ED] [— : -] <reason>" or looser "Decline. <reason>"
//     / "Decline <reason>" pattern.
//   - The FULL message text (untrimmed of any decline-prefix) when no
//     pattern matches but the message is non-empty — mandatory fallback.
const extractDeclineReason = (adminMessage) => {
  if (!adminMessage) return null;
  const text = String(adminMessage).trim();
  if (text.length === 0) return null;

  // Strict pattern: "DECLINE — <reason>" / "DECLINE: <reason>" / "DECLINE - <reason>"
  // (Sandra's exact production shape uses the em-dash variant.) Uses [\s\S]+
  // not .+ to match multi-line reasons across newlines.
  const strict = text.match(/^(?:DECLINE|REJECT)(?:ED|D)?\s*[—:\-]\s*([\s\S]+)$/i);
  if (strict && strict[1].trim().length > 0) {
    return strict[1].trim();
  }

  // Looser pattern: "Decline. <reason>" / "Decline, <reason>" / "Decline <reason>"
  // — starts with a decline word but no formal separator.
  const looser = text.match(/^(?:DECLINE|REJECT)(?:ED|D)?\b[.,\s]+([\s\S]+)$/i);
  if (looser && looser[1].trim().length > 0) {
    return looser[1].trim();
  }

  // Decline-only with no follow text (e.g. "DECLINE", "Decline.", "Rejected!")
  // → no reason present; return null → prompt's generic decline path fires.
  if (/^(?:DECLINE|REJECT)(?:ED|D)?[.!\s]*$/i.test(text)) {
    return null;
  }

  // Mandatory fallback: doesn't start with a decline word at all (admin used
  // a non-standard format that parseAdminReply still classified as 'rejected',
  // e.g. "Send a rejection — they didn't meet our threshold" or "scores too
  // low. decline."). Pass the FULL text — better to include slightly too much
  // than to silently omit the reason. Vienna's prompt receives the full
  // string as adminDeclineReason and incorporates it naturally.
  return text;
};

const computeCompletionDispatch = ({ deal, summary, classifications, willGoToCollateralCheck, willReview, identityClashUnresolved }) => {
  if (deal?.status !== 'active') return null;
  if (willGoToCollateralCheck || willReview || identityClashUnresolved) return null;
  const required = allRequiredForCompletion(isPurchaseFromSummary(summary));
  const allDocsIn = required.every(req => isDocRequirementSatisfied(req, classifications || []));
  const hasExitStrategy = !!summary?.exit_strategy;
  if (!(allDocsIn && hasExitStrategy)) return null;
  return deal.prelim_approved_at ? 'completion-handoff' : 'final-review';
};

const normalizeSenderName = (dealSummary, fromName) => {
  if (!dealSummary) return dealSummary;
  const normalized = { ...dealSummary };

  // F2 forward-recovery: every call re-evaluates the collision flag from current state.
  // Clear any stale flag carried over from previous turns or earlier (buggy) over-fires.
  // The flag is re-set below only if conditions still warrant it — deals that got the
  // flag set incorrectly will lose it on the next webhook touch, restoring name greetings.
  delete normalized.name_collides_with_admin;

  const fallback = (fromName || '').trim() || null;
  if (!fallback) return normalized;

  // F2 — Both-Franco collision branch. When BOTH Claude's extracted name AND
  // the From-header fallback look like Franco (admin-first-name match), we
  // can't reliably distinguish "broker actually named Franco" (e.g. Franco
  // Vieanna) from "Claude misextracted the lender name." Layer A's rescue
  // would no-op (replacing Franco with Franco), so we flag the collision and
  // keep the raw values intact. Prompts read this flag and use a generic
  // greeting instead of trying to greet the recipient by name.
  const fallbackUnreliable = isUnreliableName(fallback);
  const senderUnreliable = isUnreliableName(normalized.sender_name);
  const brokerUnreliable = normalized.sender_type === 'broker' && isUnreliableName(normalized.broker_name);

  if (fallbackUnreliable && (senderUnreliable || brokerUnreliable)) {
    normalized.name_collides_with_admin = true;
    return normalized;
  }

  // Single-Franco rescue (existing path) — extracted name is unreliable but
  // the From-header is fine, so use it.
  if (isUnreliableName(normalized.sender_name)) {
    normalized.sender_name = fallback;
  }
  if (normalized.sender_type === 'broker' && isUnreliableName(normalized.broker_name)) {
    normalized.broker_name = fallback;
  }
  return normalized;
};

// Group R: convert Franco's plain-text REPLACE-intent reply into HTML for the
// broker-facing send. If the text already contains HTML (any tag), use as-is —
// some email clients send HTML in the body. Otherwise wrap each \n\n-separated
// paragraph in a <p> tag, with single \n inside a paragraph becoming <br>.
//
// Group PPP-leak (S1.6): pre-fix HTML detect was /<[a-z][^>]*>/i which falsely
// matched email addresses in angle brackets like <fmaione@unionfinancialcorp.com>.
// Franco's REPLACE in production (msg 11) included his auto-appended sig with
// <email@x.com>, regex matched, function early-returned bare plaintext, and the
// outbound to broker rendered as one collapsed paragraph (S1.6) AND carried the
// sig (S1.7). Tightened to a known-tag whitelist so email-style angle brackets
// don't match.
const HTML_DETECT = /<(\/[a-z]+|p|div|br|h[1-6]|hr|ul|ol|li|strong|em|b|i|a|span|table|tr|td|th|tbody|thead|img|blockquote|pre|code)\b/i;
const textToHtml = (text) => {
  if (!text) return '';
  if (HTML_DETECT.test(text)) return text;
  return text
    .split(/\n\s*\n+/)
    .filter(p => p.trim().length > 0)
    .map(p => `<p>${p.trim().replace(/\n/g, '<br>')}</p>`)
    .join('\n');
};

// Helper: send LTV escalation email to admin and flip deal status to ltv_escalated.
// Body is line-for-line equivalent to the previous inline block in the existing-deal branch
// (only `existingDeal` → `deal` and `result.updatedSummary` → `dealSummary`).
//
// options.isUpdate (Fix 2): when true, prefix subject with "[UPDATED] " so Franco can
// distinguish a fresh escalation from the original one when broker submits more docs to
// an already-escalated deal.
const sendEscalationToAdmin = async (deal, dealSummary, ltv, options = {}) => {
  // LTV > 80% — escalate to Franco for approval
  console.log(`LTV ${ltv}% > 80 — escalating to admin for approval${options.isUpdate ? ' (updated)' : ''}`);
  const dealMessages = await dealsService.getMessages(deal.id);
  const dealDocs = await dealsService.getDocumentsWithText(deal.id);
  // Group DDDD (S6.2): pre-label admin replies so the escalation log doesn't
  // mis-attribute Franco's admin-direction inbounds to the broker.
  const escalationBrokerName = dealSummary?.broker_name || dealSummary?.sender_name || deal.borrower_name;
  const labeledEscalationMessages = labelMessagesForLeadSummary(dealMessages, escalationBrokerName);
  const escalationEmail = await aiService.generateEscalationNotification(dealSummary, labeledEscalationMessages, dealDocs);

  let escalationAttachments = [];
  if (dealDocs.length > 0) {
    console.log('Downloading documents for escalation zip...');
    const zipBase64 = await dealsService.downloadDocsAsZip(deal.id, dealDocs);
    const safeName = (dealSummary?.borrower_name || deal.borrower_name || 'Unknown').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
    escalationAttachments = [{
      Name: `${safeName}_Documents.zip`,
      Content: zipBase64,
      ContentType: 'application/zip',
    }];
  }

  const subjectPrefix = options.isUpdate ? '[UPDATED] ' : '';
  const subject = `${subjectPrefix}ACTION REQUIRED: LTV Over 80% — ${dealSummary?.borrower_name || deal.borrower_name}`;
  const escalateResult = await emailService.sendEmail(
    config.adminEmail,
    subject,
    escalationEmail.replace(/<[^>]*>/g, ''),
    escalationEmail,
    escalationAttachments
  );
  await dealsService.saveMessage(deal.id, 'outbound', subject, escalationEmail, escalateResult.MessageID);
  await dealsService.update(deal.id, { status: 'ltv_escalated' });
  console.log('Escalation email sent to admin, deal status: ltv_escalated');
};

// Helper: send preliminary review email to admin and flip deal status to under_review.
// Body is line-for-line equivalent to the previous inline block in the existing-deal branch.
// Includes Bradley's purchase-vs-refinance branching for the required-doc list.
//
// options.isUpdate (Fix 2): when true, prefix subject with "[UPDATED] " so Franco can
// distinguish a fresh review from the original one. Used when broker submits remaining
// docs to an under_review deal — replaces the passive [Broker Update] dead-end.
//
// options.brokerFacingReplyText (Cluster D — Marcus 1f1e7ac4 + Ethan 830f9ad5
// 2026-05-18 real-Postmark): the verbatim broker-facing text Vienna emitted (or
// would have emitted, on NNN-suppressed paths) on this turn. Classified by
// welcomeEmailIsAskingClarification — if the reply asks for clarification, the
// review banner is forced to PRELIMINARY — BROKER CLARIFICATION PENDING so a
// COMPLETE review never fires while a question to the broker is outstanding.
// Pre-fix: the gate at the statusFlag line used only missingDocs.length, which
// treated docs-on-file as sufficient for COMPLETE — Marcus and Ethan both had
// every required doc yet had unresolved Vienna→broker discrepancy asks, and
// COMPLETE fired anyway. JS classification used (not a Claude-set flag) per
// the S15-E lesson: dealSummary.unresolved_discrepancy was empirically unreliable
// both directions (Marcus true-ignored, Ethan wrongly-false).

// Cluster B (D-extension, R4-Bucket-B): pure helper returning admin-review
// banner trichotomy. Single source of truth — production wire (below) and the
// runRecallProbe helper in test-trigger.js both go through this function,
// structurally eliminating the mirror-drift class that caused the R4 bug.
//
// Trichotomy (precedence-ordered):
//   1. clarificationPending=true        → PRELIMINARY-CLARIFICATION (D)
//   2. missingDocs.length > 0           → PRELIMINARY (intake/exit_strategy gap;
//                                          BBBB-relaxed initial-submission path reaches here)
//   3. !deal.prelim_approved_at         → PRELIMINARY (Franco's rule: first review
//                                          is ALWAYS preliminary; COMPLETE only post-approval)
//   4. else                             → COMPLETE (post-approval; see reachability note)
//
// Cross-request durability of prelim_approved_at: stamped by Group CCCC at
// L1043/L1086 in a PRIOR request (admin's APPROVED reply), persisted to the
// deals row, then read here on a SUBSEQUENT prelim-send request. No within-
// request staleness possible — the field is durably written cross-request
// before any subsequent path can re-enter sendPreliminaryReviewToAdmin.
//
// Reachability of case 4 (post-approval COMPLETE): today the active-branch
// dispatch at L1976+ routes post-approval to sendCompletionHandoff, skipping
// sendPreliminaryReviewToAdmin entirely. Case 4 is therefore not exercised in
// the current call graph but is pinned in the matrix as defense-in-depth
// against future refactors that re-open the path.
//
// Resolves R4: S3/S6/S7/S9 Bug-1 (COMPLETE instead of PRELIMINARY on first
// review) and subsumes S6-B2/S9-B2 (subject-line says COMPLETE).
const computeAdminBanner = ({ clarificationPending, missingDocs, deal }) => {
  const isPostApproval = !!deal?.prelim_approved_at;
  if (clarificationPending) {
    return {
      statusFlag: 'PRELIMINARY-CLARIFICATION',
      bannerText: 'PRELIMINARY — BROKER CLARIFICATION PENDING',
      subjectStatus: 'PRELIMINARY (clarification pending)',
    };
  }
  if ((missingDocs || []).length > 0) {
    return {
      statusFlag: 'PRELIMINARY',
      bannerText: 'PRELIMINARY REVIEW — AWAITING APPROVAL',
      subjectStatus: 'PRELIMINARY',
    };
  }
  if (!isPostApproval) {
    return {
      statusFlag: 'PRELIMINARY',
      bannerText: 'PRELIMINARY REVIEW — AWAITING APPROVAL',
      subjectStatus: 'PRELIMINARY',
    };
  }
  return {
    statusFlag: 'COMPLETE',
    bannerText: 'COMPLETE — Ready for Review',
    subjectStatus: 'COMPLETE',
  };
};

const sendPreliminaryReviewToAdmin = async (deal, dealSummary, ownershipType, ltv, options = {}) => {
  // LTV ≤ 80% confirmed — send Franco preliminary review with docs
  console.log(`LTV ${ltv}% <= 80 — sending preliminary review to Franco${options.isUpdate ? ' (updated)' : ''}`);
  const dealDocs = await dealsService.getDocumentsWithText(deal.id);
  const allDocsList = await dealsService.getDocumentsByDeal(deal.id);
  const classifications = allDocsList.map(d => d.classification).filter(Boolean);

  // Branch the required-doc list on deal type: purchase deals don't have an existing
  // mortgage on the subject property, so no mortgage payout is needed; instead a purchase
  // contract and proof of down payment apply. Refinance/2nd mortgage need the payout.
  // Group SSS: prelim uses intakeRequiredFor (Tier 1 only — JJJ preserved, AML/PEP
  // do NOT appear in the prelim [MISSING] list).
  // Fix 4: isDocRequirementSatisfied makes NOA satisfy income_proof per Bradley's intent.
  const isPurchase = isPurchaseFromSummary(dealSummary);
  const missingDocs = intakeRequiredFor(isPurchase)
    .filter(req => !isDocRequirementSatisfied(req, classifications));

  // Group C (S6.3/S7.3): exit_strategy is a deal-summary field, not a document
  // classification. Surface it here when null/empty so it appears in the admin's
  // preliminary review [MISSING] list and downstream draft preview. missingDocs
  // semantically becomes "missing items" — the rendering loop downstream handles
  // the non-doc key via DOC_DISPLAY_NAMES.exit_strategy. Variable name stays for
  // diff-tightness; semantic widening is comment-only.
  if (!dealSummary?.exit_strategy) missingDocs.push('exit_strategy');

  const dealMessages = await dealsService.getMessages(deal.id);
  // Group DDDD (S6.2): pre-label messages so admin "approved" / "send" replies
  // render as "INBOUND from Admin (Franco)" instead of being mis-attributed to
  // the broker (existing production bug at Kevin Tran 65676a8f).
  const leadSummaryBrokerName = dealSummary?.broker_name || dealSummary?.sender_name || deal.borrower_name;
  const labeledMessages = labelMessagesForLeadSummary(dealMessages, leadSummaryBrokerName);

  // Cluster B Commit 2b — admin Snapshot pure JS injection (symmetric with broker-side).
  // JS pre-renders the entire Snapshot block from the canonical-field map; Vienna's
  // generateLeadSummary prompt is instructed NO-SNAPSHOT (start at Section 2). Post-Claude
  // strip backstop + prepend the JS Snapshot ensures admin Snapshot is JS-authoritative.
  // Admin sees full transparency on calibration-gated fields (market value, balance) even
  // though those are suppressed broker-facing pending Franco calibration.
  const _bDetectAdmin = dEngine.runDiscrepancyDetection(
    (dealMessages.find(m => m.direction === 'inbound')?.body) || '',
    dealDocs.map(d => ({ file_name: d.file_name, classification: d.classification, text: d?.extracted_data?.text || '' })),
    leadSummaryBrokerName,
    { emailSubject: dealMessages.find(m => m.direction === 'inbound')?.subject || '' }
  );
  const _bSnapshotHtml = dEngine.renderDealSnapshot(_bDetectAdmin.canonical_map, {
    ownershipType,
    isCommercial: !!_bDetectAdmin.commercial,
  });

  let leadSummary = await aiService.generateLeadSummary(
    dealSummary,
    ownershipType,
    dealDocs,
    missingDocs,
    labeledMessages,
    { noSnapshot: true }
  );
  // Post-Claude: strip any residual Vienna-emitted Snapshot block + prepend the JS canonical Snapshot.
  const _snapStrip = aiService.stripVienna_DealSnapshot(leadSummary);
  leadSummary = aiService.prependDealSnapshot(_snapStrip.stripped, _bSnapshotHtml);
  if (_snapStrip.strippedAny) {
    console.log('B-2b (admin Snapshot): Vienna emitted a Snapshot block despite NO-SNAPSHOT instruction — backstop stripped it before prepending JS canonical.');
  }

  let reviewAttachments = [];
  if (dealDocs.length > 0) {
    const zipBase64 = await dealsService.downloadDocsAsZip(deal.id, dealDocs);
    const safeName = (dealSummary?.borrower_name || deal.borrower_name || 'Unknown').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
    reviewAttachments = [{
      Name: `${safeName}_Documents.zip`,
      Content: zipBase64,
      ContentType: 'application/zip',
    }];
  }

  const borrowerName = dealSummary?.borrower_name || deal.borrower_name;

  // Cluster D: classify Vienna's broker-facing reply for this turn. If she's
  // asking the broker a clarification question, the admin review must NOT
  // emit COMPLETE — clarification-pending takes precedence over docs-complete.
  const clarificationPending = aiService.welcomeEmailIsAskingClarification(options.brokerFacingReplyText || '');
  // R4-Bucket-B (D-extension): banner trichotomy + isPostApproval gate via
  // computeAdminBanner (single source of truth; see helper docblock above for
  // precedence, cross-request durability, and case-4 reachability notes).
  const { statusFlag, bannerText, subjectStatus } = computeAdminBanner({ clarificationPending, missingDocs, deal });
  // JS-enforce the banner — strip Claude's emitted FILE STATUS line and prepend
  // the JS-determined banner; also strips the trailing "This file is COMPLETE…"
  // self-consistency line when the banner contradicts. Same trust profile as
  // Cluster E's planned post-gen sweep: JS owns the rule, not Claude.
  const enforcedLeadSummary = aiService.enforceReviewBanner(leadSummary, bannerText);
  const subjectPrefix = options.isUpdate ? '[UPDATED] ' : '';
  const subject = `${subjectPrefix}ACTION REQUIRED: ${subjectStatus} Review — ${borrowerName} — ${ltv}% LTV`;
  const reviewResult = await emailService.sendEmail(
    config.adminEmail,
    subject,
    enforcedLeadSummary.replace(/<[^>]*>/g, ''),
    enforcedLeadSummary,
    reviewAttachments
  );
  await dealsService.saveMessage(deal.id, 'outbound', subject, enforcedLeadSummary, reviewResult.MessageID);
  await dealsService.update(deal.id, { status: 'under_review' });
  console.log(`Preliminary review sent to Franco — deal status: under_review (${missingDocs.length} docs missing, clarificationPending=${clarificationPending}, statusFlag=${statusFlag})`);
};

// Group BBB (S9.1/S9.2/S9.3) → generalized in Group NNN: completion handoff. Fires
// when a deal in under_review reaches all-docs-complete on a broker turn, OR when
// broker fulfills admin-sent conditions (the original BBB trigger). Pre-BBB this
// path fired sendPreliminaryReviewToAdmin({ isUpdate: true }) which produced an
// "[UPDATED] ACTION REQUIRED: COMPLETE Review" with redundant APPROVED/DECLINE
// prompt — admin already gave APPROVE/DECLINE on the prior review, doubling the
// buttons was noise.
//
// New shape (two emails, both in the broker submission's thread for tidy admin
// inbox):
//   1. Informational notice — no action required. Subject prefix varies by
//      whether conditions had previously been sent: "[Conditions Fulfilled]" vs
//      "[File Complete]".
//   2. Closing draft preview — saveDraftAndPreview pattern with draft_action
//      'approval_completed' so admin's SEND advances status to 'completed'.
//
// Vienna's broker reply is suppressed in the call site (NNN extended this from
// BBB-only to the whole under_review/ltv_escalated branch). The next broker-
// facing message is the closing email after admin SENDs the preview.
const sendCompletionHandoff = async (deal, dealSummary, dealDocs, dealMessages, brokerInboundEmail, { conditionsFulfilled = false } = {}) => {
  const borrowerName = dealSummary?.borrower_name || deal.borrower_name;

  // 1. Informational notice — no APPROVED/DECLINE, no action required.
  const infoSubject = conditionsFulfilled
    ? `[Conditions Fulfilled] ${borrowerName} — File Complete`
    : `[File Complete] ${borrowerName} — Ready to Close`;
  const infoBodyLead = conditionsFulfilled
    ? `Broker submitted the remaining condition docs for <strong>${borrowerName}</strong>. The file is now complete.`
    : `Broker submitted the remaining required docs for <strong>${borrowerName}</strong>. The file is now complete.`;
  const infoBody = `<p>${infoBodyLead}</p><p>Closing draft preview will follow in this thread.</p>`;
  const infoResult = await emailService.sendEmail(
    config.adminEmail,
    infoSubject,
    infoBody.replace(/<[^>]*>/g, ''),
    infoBody,
    []
  );
  await dealsService.saveMessage(deal.id, 'outbound', infoSubject, infoBody, infoResult.MessageID);
  console.log(`Completion-handoff informational notice sent to admin (conditionsFulfilled=${conditionsFulfilled})`);

  // 2. Closing draft preview — replicate saveDraftAndPreview pattern (the helper
  // is scoped inside the admin-reply branch, not reachable here). Sets draft_email,
  // draft_subject, draft_action; sends preview to admin in-thread. Admin's eventual
  // SEND on this preview triggers executeDraft with action='approval_completed' →
  // broker gets the deterministic closing template, status flips to 'completed'.
  const closingEmail = await aiService.generateCompletionEmail(dealSummary, dealMessages, dealDocs);
  const borrowerSubject = `Re: ${borrowerName}`;
  await dealsService.update(deal.id, {
    draft_email: closingEmail,
    draft_subject: borrowerSubject,
    draft_action: 'approval_completed',
  });
  const previewLead = conditionsFulfilled ? 'Conditions fulfilled' : 'File complete';
  const previewHtml = `<h3>Closing Draft Preview — ${borrowerName}</h3>
<p>${previewLead}. Here's the closing email Vienna will send to <strong>${deal.email}</strong>:</p>
<hr>
${closingEmail}
<hr>
<p><strong>Reply SEND to confirm, or reply with your edits.</strong></p>`;
  const previewResult = await emailService.sendEmail(
    config.adminEmail,
    `Re: ${infoSubject}`,
    previewHtml.replace(/<[^>]*>/g, ''),
    previewHtml,
    []
  );
  await dealsService.saveMessage(deal.id, 'outbound', `Re: ${infoSubject}`, previewHtml, previewResult.MessageID);
  console.log('Closing draft preview sent to admin (in-thread with informational notice)');
};

// Group NNN: pure dispatch decision for the under_review/ltv_escalated branch.
// Extracted from the webhook handler so the truth-table tests can exercise it
// without mocking the full request pipeline. Returns one of five actions:
//   - 'completion-handoff' : file is complete (refinance: all 6 docs + exit_strategy;
//                            purchase: 5 docs + purchase_contract + exit_strategy);
//                            admin not mid-cycle on an existing draft. Caller
//                            invokes sendCompletionHandoff with conditionsFulfilled
//                            flag set from deal.conditions_sent_at presence.
//   - 'noop'               : file is complete but draft_email is set (admin mid
//                            preview-cycle). Caller does nothing — broker inbound
//                            already saved to thread; admin sees it next look.
//   - 'escalation-update'  : ltv_escalated status. Caller invokes
//                            sendEscalationToAdmin({ isUpdate: true }).
//   - 'preliminary-update' : default for under_review when file isn't complete.
//                            Caller invokes sendPreliminaryReviewToAdmin({ isUpdate: true }).
//   - 'text-only-noop'     : R4-Bucket-C.1 (S7 Bug 3 / S8 Bug 2). Broker text-only
//                            reply on under_review (hasNewDocsThisTurn=false). Caller
//                            does nothing admin-facing. Vienna's broker-facing reply
//                            already shipped upstream; deal state already updated;
//                            broker inbound saved to conversation thread. Admin sees
//                            the inbound when they look at the deal.
//
// R4-Bucket-C.1: hasNewDocsThisTurn 4th param defaults to true for backward-
// compatibility with the original NNN 12-case truth table — only the under_review
// path is gated on no-new-docs (ltv_escalated scope-locked; Franco didn't report,
// scope expansion = MVP creep). draft_email noop precedence preserved (admin mid-
// preview-cycle takes priority over text-only suppression).
//
// S1.3 regression-direction: NNN's Q7 fix routed the hasNewDocs=true +
// allDocsInNow=true cell to completion-handoff (the *right* shape for a complete
// file, replacing Fix 2's wrong-shape [UPDATED] COMPLETE Review with APPROVED/
// DECLINE buttons). C.1's text-only-noop occupies the orthogonal hasNewDocs=false
// cells — a no-emission terminal action cannot produce S1.3's wrong-shape
// emission. NNN's Q7 redirect target (the hasNewDocs=true cell) is unchanged.
const decideReviewDispatch = (deal, reviewSummary, reviewClassifications, hasNewDocsThisTurn = true) => {
  // Group SSS: allDocsInNow requires intake + compliance (AML/PEP) per JJJ's
  // post-approval flow. Pre-SSS this used intake-only, which fired completion-handoff
  // before AML/PEP had been requested.
  const required = allRequiredForCompletion(isPurchaseFromSummary(reviewSummary));
  const stillMissing = required.filter(req => !isDocRequirementSatisfied(req, reviewClassifications));
  const allDocsInNow = stillMissing.length === 0 && !!reviewSummary?.exit_strategy;

  if (deal.status === 'under_review' && allDocsInNow) {
    if (!deal.draft_email) {
      // R4-Bucket-C.1: text-only reply on a complete-file deal → no admin emission.
      // Pre-C.1 this fired completion-handoff regardless of new-docs presence
      // (S7 Bug 3: [File Complete] on a clarification-only reply).
      if (!hasNewDocsThisTurn) {
        return { action: 'text-only-noop', reason: 'broker text-only reply (no new docs)', allDocsInNow: true, stillMissing };
      }
      return { action: 'completion-handoff', conditionsFulfilled: !!deal.conditions_sent_at, allDocsInNow: true, stillMissing };
    }
    return { action: 'noop', reason: 'admin mid-cycle (draft_email set)', allDocsInNow: true, stillMissing, draftAction: deal.draft_action };
  }
  if (deal.status === 'ltv_escalated') {
    // Scope-lock: ltv_escalated unchanged. Franco didn't report; same hasNewDocs
    // axis would arguably apply, but expansion = MVP creep.
    return { action: 'escalation-update', allDocsInNow, stillMissing };
  }
  // under_review + !allDocsInNow.
  // R4-Bucket-C.1: text-only reply on an incomplete-file deal → no admin emission.
  // Pre-C.1 this fired preliminary-update regardless of new-docs presence
  // (S8 Bug 2: [UPDATED] PRELIMINARY on a clarification-only reply).
  if (deal.status === 'under_review' && !hasNewDocsThisTurn) {
    return { action: 'text-only-noop', reason: 'broker text-only reply (no new docs)', allDocsInNow, stillMissing };
  }
  return { action: 'preliminary-update', allDocsInNow, stillMissing };
};

// POST /webhook/inbound - receives incoming emails from Postmark
router.post('/inbound', async (req, res) => {
  // Respond immediately so Postmark doesn't retry
  res.status(200).json({ received: true });

  try {
    console.log('\n========== INBOUND WEBHOOK ==========');
    console.log('Timestamp:', new Date().toISOString());

    // Parse the inbound email
    const email = emailService.parseInboundEmail(req.body);
    console.log('From:', email.from);
    console.log('From Name:', email.fromName);
    console.log('Subject:', email.subject);
    console.log('Body:', email.textBody);
    console.log('Attachments:', email.attachments.length);
    if (email.attachments.length > 0) {
      console.log('Attachment names:', email.attachments.map(a => `${a.Name} (${a.ContentType}, ${a.ContentLength} bytes)`).join(', '));
    }

    // Deduplicate — skip if we already processed this exact message
    if (email.messageId && processedMessages.has(email.messageId)) {
      console.log('Duplicate message detected, skipping:', email.messageId);
      return;
    }
    if (email.messageId) {
      processedMessages.add(email.messageId);
      // Clean up old entries after 1 hour to prevent memory leak
      setTimeout(() => processedMessages.delete(email.messageId), 60 * 60 * 1000);
    }

    // Skip system/automated emails and our own outbound emails
    const senderEmail = config.postmark.senderEmail || '';
    const ignoredSenders = [
      'support@postmarkapp.com', 'noreply@', 'no-reply@',
      '@anthropic.com', '@mail.anthropic.com',
    ];
    if (senderEmail) ignoredSenders.push(senderEmail.toLowerCase());

    if (ignoredSenders.some(addr => email.from.toLowerCase().includes(addr))) {
      console.log('Skipping ignored/system email from:', email.from);
      return;
    }

    // Thread-based deal matching: check In-Reply-To header first
    let existingDeal = null;
    if (email.inReplyTo) {
      existingDeal = await dealsService.findByMessageId(email.inReplyTo);
      if (existingDeal) {
        console.log('Thread match found via In-Reply-To:', email.inReplyTo);
      }
    }
    // If no In-Reply-To match, check References header (full thread chain)
    if (!existingDeal && email.references && email.references.length > 0) {
      for (const ref of email.references) {
        existingDeal = await dealsService.findByMessageId(ref);
        if (existingDeal) {
          console.log('Thread match found via References:', ref);
          break;
        }
      }
    }
    // No thread match = new deal (even if broker has other active deals)
    if (!existingDeal) {
      console.log('No thread match — treating as new deal');
    }

    // --- ADMIN REPLY HANDLING ---
    // If the sender is the admin (Franco) and we matched a deal via thread, handle approval flow
    const adminEmail = config.adminEmail || '';
    const isAdmin = adminEmail && email.from.toLowerCase().includes(adminEmail.toLowerCase());

    if (isAdmin && existingDeal) {
      console.log('Admin reply detected for deal:', existingDeal.id, 'Status:', existingDeal.status);
      await dealsService.saveMessage(existingDeal.id, 'inbound', email.subject, email.textBody);

      const borrowerSubject = `Re: ${existingDeal.extracted_data?.borrower_name || 'Your Loan Inquiry'}`;

      // Helper: save draft and send preview to Franco (replies in same thread).
      // Hoisted above the draft-review branch (Bug B) so the EDIT path can route
      // revised drafts back through the same preview cycle rather than auto-sending.
      const saveDraftAndPreview = async (draftEmail, draftSubject, draftAction) => {
        await dealsService.update(existingDeal.id, {
          draft_email: draftEmail,
          draft_subject: draftSubject,
          draft_action: draftAction,
        });

        const borrowerName = existingDeal.extracted_data?.borrower_name || existingDeal.borrower_name;
        const previewHtml = `<h3>Draft Email Preview — ${borrowerName}</h3>
<p>Here's what Vienna will send to <strong>${existingDeal.email}</strong>:</p>
<hr>
${draftEmail}
<hr>
<p><strong>Reply SEND to confirm, or reply with your edits.</strong></p>`;

        // Reply in the same thread as Franco's message.
        // HITL email subjects vary across the flow (ACTION REQUIRED: ... -> Re: ACTION REQUIRED:
        // -> Draft Email Preview ...), so subject-based threading breaks. We must set explicit
        // In-Reply-To + References headers to keep the conversation grouped in Franco's inbox.
        // Postmark outbound Message-IDs are <uuid@mtasv.net>; inbound IDs may already have a domain
        // (Gmail / Outlook), so only append @mtasv.net if there's no @ in the raw value.
        // Group YYY (S5.3): anchor the References chain on Vienna's outbound IDs from
        // the DB. Pre-YYY only echoed admin's References, which fragmented when admin's
        // email client truncated/dropped the chain.
        const formatThreadId = (id) => (id && id.includes('@') ? `<${id}>` : `<${id}@mtasv.net>`);
        const threadHeaders = [];
        if (email.messageId) {
          const dealMessagesForThread = await dealsService.getMessages(existingDeal.id);
          const viennaOutboundIds = dealMessagesForThread
            .filter(m => m.direction === 'outbound' && m.external_message_id)
            .map(m => m.external_message_id);
          const chain = buildPreviewThreadChain({
            outboundIds: viennaOutboundIds,
            inboundReferences: email.references,
            latestMessageId: email.messageId,
          });
          threadHeaders.push({ Name: 'In-Reply-To', Value: formatThreadId(email.messageId) });
          threadHeaders.push({ Name: 'References', Value: chain.map(formatThreadId).join(' ') });
        }

        const previewResult = await emailService.sendEmail(
          config.adminEmail,
          `Re: ${email.subject}`,
          previewHtml.replace(/<[^>]*>/g, ''),
          previewHtml,
          [],
          threadHeaders
        );
        await dealsService.saveMessage(existingDeal.id, 'outbound', `Re: ${email.subject}`, previewHtml, previewResult.MessageID);
        console.log('Draft saved and preview sent to Franco (same thread)');
      };

      // --- DRAFT REVIEW HANDLING ---
      // If draft_action is set, Franco is reviewing a draft preview
      if (existingDeal.draft_action && (existingDeal.status === 'ltv_escalated' || existingDeal.status === 'under_review')) {
        console.log('Draft pending — checking if Franco wants to send, edit, or replace');
        const { action, editInstructions, replacementText } = await aiService.parseDraftReply(email.textBody);

        // Helper: send draft to broker and advance deal
        const executeDraft = async (draftEmail, draftSubject, draftAction) => {
          const draftAttachments = [];

          // Group LLLL (S15.3+): broker-thread anchor. Subject + In-Reply-To +
          // References derive from the broker-direction message slice so the
          // doc-request / decline / closing draft lands in the broker's
          // existing conversation instead of starting a new thread (Derek
          // Olsen 2026-05-16 case: Claude's "Re: Derek Olsen" draft_subject
          // dropped the original "— Potential Deal" descriptor; empty headers
          // meant Gmail/Outlook couldn't thread by Message-ID either).
          const allMessages = await dealsService.getMessages(existingDeal.id);
          const brokerInputs = buildBrokerThreadInputs(allMessages);
          const chain = buildPreviewThreadChain(brokerInputs);

          const formatThreadId = (id) => (id && id.includes('@') ? `<${id}>` : `<${id}@mtasv.net>`);
          const brokerHeaders = [];
          if (brokerInputs.latestMessageId) {
            brokerHeaders.push({ Name: 'In-Reply-To', Value: formatThreadId(brokerInputs.latestMessageId) });
          }
          if (chain.length > 0) {
            brokerHeaders.push({ Name: 'References', Value: chain.map(formatThreadId).join(' ') });
          }

          // Anchor subject on the earliest broker-direction inbound (broker's
          // submission). The Claude-composed draftSubject is forensic-only
          // post-LLLL — preserved in deal.draft_subject for debugging but not
          // used on the actual send.
          const anchorSubject = brokerInputs.earliestBrokerSubject
            ? (brokerInputs.earliestBrokerSubject.startsWith('Re:')
                ? brokerInputs.earliestBrokerSubject
                : `Re: ${brokerInputs.earliestBrokerSubject}`)
            : draftSubject;

          emailService.sendEmailDelayed(
            existingDeal.email,
            anchorSubject,
            draftEmail.replace(/<[^>]*>/g, ''),
            draftEmail,
            draftAttachments,
            brokerHeaders,
            async (result) => {
              await dealsService.saveMessage(existingDeal.id, 'outbound', anchorSubject, draftEmail, result.MessageID);
              console.log(`Draft sent to broker (LLLL: threaded into broker conversation, subject="${anchorSubject}", headers=${brokerHeaders.length})`);
            }
          );

          // Advance status based on action
          if (draftAction === 'approval_doc_request') {
            await dealsService.update(existingDeal.id, { status: 'active', draft_email: null, draft_subject: null, draft_action: null });
            console.log('Deal status: active');
          } else if (draftAction === 'rejection') {
            await dealsService.update(existingDeal.id, { status: 'rejected', draft_email: null, draft_subject: null, draft_action: null });
            console.log('Deal status: rejected');
          } else if (draftAction === 'approval_completed') {
            await dealsService.update(existingDeal.id, { status: 'completed', draft_email: null, draft_subject: null, draft_action: null });
            console.log('Deal status: completed');
          } else {
            // conditions — status stays. Group BBB (S9.2): stamp conditions_sent_at
            // (timestamptz column added in BBB migration) so the next inbound from
            // broker with new docs routes to the conditions-fulfilled handoff path
            // instead of re-firing the [UPDATED] PRELIMINARY Review with redundant
            // APPROVED/DECLINE prompt. Preserve original timestamp if conditions
            // are sent multiple times — first-stamp wins.
            await dealsService.update(existingDeal.id, {
              draft_email: null,
              draft_subject: null,
              draft_action: null,
              conditions_sent_at: existingDeal.conditions_sent_at || new Date().toISOString(),
            });
            console.log('Conditions sent to broker, status unchanged, conditions_sent_at stamped');
          }
        };

        if (action === 'send') {
          console.log('Franco confirmed — sending draft as-is');
          await executeDraft(existingDeal.draft_email, existingDeal.draft_subject, existingDeal.draft_action);
        } else if (action === 'replace') {
          // Group AAA fix (S8.1): REPLACE no longer bypasses the preview cycle.
          // Franco's full alternative draft is rendered to HTML verbatim (no Claude
          // rewrite — that's the kept-promise that distinguishes REPLACE from EDIT)
          // and routed through saveDraftAndPreview, same as EDIT post-Bug B. Result:
          // every draft change goes through admin preview before broker ship. The
          // verbatim guarantee is preserved — Franco's text reaches the broker
          // byte-for-byte after he replies SEND on the preview, with no Claude
          // rewriting at any step. Reverses Bug B Q4's "REPLACE is the explicit
          // override" — Franco's S8 retest showed that mental model was wrong; he
          // expects "skip rewriting, still confirm", not "skip approval".
          console.log('Franco sent a full corrected draft — saving verbatim and re-previewing for confirmation');
          const replacementHtml = textToHtml(replacementText);
          await saveDraftAndPreview(replacementHtml, existingDeal.draft_subject, existingDeal.draft_action);
        } else {
          // Bug B fix: EDIT no longer auto-sends. Revise the draft, then route the
          // revision back through saveDraftAndPreview so Franco approves the new
          // version before it ships. The deal stays in its current draft-review
          // state (draft_action + status preserved); Franco's next reply re-enters
          // this same branch, supporting unbounded edit cycles until SEND/REPLACE.
          console.log('Franco wants edits — generating revised draft for re-review');
          const revisedEmail = await aiService.reviseEmailWithEdits(
            existingDeal.draft_email,
            editInstructions,
            existingDeal.extracted_data
          );
          await saveDraftAndPreview(revisedEmail, existingDeal.draft_subject, existingDeal.draft_action);
        }
        return;
      }

      // --- FIRST REPLY HANDLING (no draft pending) ---

      if (existingDeal.status === 'ltv_escalated') {
        const { intent, message } = await aiService.parseAdminReply(email.textBody);
        console.log('Admin intent:', intent);

        // Get conversation history for contextual draft generation
        const dealMessages = await dealsService.getMessages(existingDeal.id);

        if (intent === 'approved') {
          // Group CCCC (S6.1/S7.2): stamp prelim_approved_at on admin's APPROVED
          // reply regardless of intake completeness (Q2-CCCC: signal is "admin
          // approved at prelim" — true in both single-cycle and two-cycle paths).
          // First-stamp-wins mirrors BBB's conditions_sent_at pattern.
          if (!existingDeal.prelim_approved_at) {
            const stampedAt = new Date().toISOString();
            await dealsService.update(existingDeal.id, { prelim_approved_at: stampedAt });
            existingDeal.prelim_approved_at = stampedAt;
          }
          console.log('Deal approved by admin — generating draft doc request');
          const existingDocs = await dealsService.getDocumentsByDeal(existingDeal.id);
          const docRequestEmail = await aiService.generateDocumentRequestEmail(
            existingDeal.extracted_data,
            existingDeal.ownership_type,
            existingDeal.has_application_form,
            existingDeal.has_pnw_statement,
            existingDocs,
            dealMessages
          );
          await saveDraftAndPreview(docRequestEmail, borrowerSubject, 'approval_doc_request');
        } else if (intent === 'rejected') {
          console.log('Deal rejected by admin — generating draft rejection');
          // Group RRRR (S8.3): propagate admin's stated decline reason to the
          // broker-facing draft. Mandatory full-text fallback in extractor
          // — if the strip regex misses, full message passes through.
          // Never let a regex miss cause a silent reason omission.
          const adminDeclineReason = extractDeclineReason(message);
          const rejectionEmail = await aiService.generateRejectionEmail(existingDeal.extracted_data, adminDeclineReason);
          await saveDraftAndPreview(rejectionEmail, borrowerSubject, 'rejection');
        } else {
          console.log('Admin sent conditions/notes — generating draft response');
          const polishedEmail = await aiService.generateAdminResponseEmail(existingDeal.extracted_data, message, dealMessages);
          await saveDraftAndPreview(polishedEmail, borrowerSubject, 'conditions');
        }
      } else if (existingDeal.status === 'under_review') {
        const { intent, message } = await aiService.parseAdminReply(email.textBody);
        console.log('Admin intent for under_review deal:', intent);

        // Get conversation history for contextual draft generation
        const dealMessages = await dealsService.getMessages(existingDeal.id);

        if (intent === 'approved') {
          // Group CCCC (S6.1/S7.2): stamp prelim_approved_at on admin's APPROVED
          // reply regardless of intake completeness (Q2-CCCC). Subsequent broker
          // activity in the active branch routes to sendCompletionHandoff via
          // computeCompletionDispatch instead of FINAL REVIEW. First-stamp-wins
          // mirrors BBB conditions_sent_at.
          if (!existingDeal.prelim_approved_at) {
            const stampedAt = new Date().toISOString();
            await dealsService.update(existingDeal.id, { prelim_approved_at: stampedAt });
            existingDeal.prelim_approved_at = stampedAt;
          }
          // Check if all docs are already received — if so, this is a final completion, not a doc request
          const existingDocs = await dealsService.getDocumentsByDeal(existingDeal.id);
          const docClassifications = existingDocs.map(d => d.classification).filter(Boolean);
          // Group SSS (S3.2): require intake + compliance (AML/PEP) for completion.
          // Pre-SSS this checked intake only — admin approving a deal with all intake
          // in fired generateCompletionEmail directly, bypassing JJJ's post-approval
          // AML/PEP request. Now: stillMissing includes AML/PEP if they aren't on
          // file → generateDocumentRequestEmail fires (which asks only the missing
          // items per its existing logic, typically just AML/PEP).
          // Pre-SSS also forgot the purchase/refinance branch (purchase deals would
          // never satisfy mortgage_statement). Fixed incidentally by allRequiredForCompletion.
          // Fix 4: isDocRequirementSatisfied so NOA satisfies income_proof.
          const stillMissing = allRequiredForCompletion(isPurchaseFromSummary(existingDeal.extracted_data))
            .filter(req => !isDocRequirementSatisfied(req, docClassifications));

          if (stillMissing.length === 0) {
            // FINAL COMPLETION — all docs received, Franco confirms the file is good
            console.log('Final approval by admin — all docs received, generating completion email');
            // Group I: pass docs-on-file so the closing email can't fabricate receipt of a doc not actually saved.
            const completionEmail = await aiService.generateCompletionEmail(existingDeal.extracted_data, dealMessages, existingDocs);
            await saveDraftAndPreview(completionEmail, borrowerSubject, 'approval_completed');
          } else {
            // PRELIMINARY APPROVAL — still missing docs, generate doc request
            console.log('Preliminary approval by admin — generating draft doc request for remaining items');
            const docRequestEmail = await aiService.generateDocumentRequestEmail(
              existingDeal.extracted_data,
              existingDeal.ownership_type,
              existingDeal.has_application_form,
              existingDeal.has_pnw_statement,
              existingDocs,
              dealMessages
            );
            await saveDraftAndPreview(docRequestEmail, borrowerSubject, 'approval_doc_request');
          }
        } else if (intent === 'rejected') {
          console.log('Deal rejected by admin — generating draft rejection');
          // Group RRRR (S8.3): propagate admin's stated decline reason
          // (under_review path, symmetric with the upper draft_email path).
          const adminDeclineReason = extractDeclineReason(message);
          const rejectionEmail = await aiService.generateRejectionEmail(existingDeal.extracted_data, adminDeclineReason);
          await saveDraftAndPreview(rejectionEmail, borrowerSubject, 'rejection');
        } else {
          console.log('Admin sent conditions/notes for under_review deal — generating draft');
          const polishedEmail = await aiService.generateAdminResponseEmail(existingDeal.extracted_data, message, dealMessages);
          await saveDraftAndPreview(polishedEmail, borrowerSubject, 'conditions');
        }
      } else {
        console.log(`Admin replied to deal in status ${existingDeal.status} — no escalation action taken`);
      }
      return; // Admin reply handled, stop processing
    }

    // If admin sends a new email (no thread match), treat as a referral
    if (isAdmin && !existingDeal) {
      // Group ZZZ (S11.1): wrap the referral branch in its own try/catch so
      // transient failures (Claude API errors, Supabase blips, email-send
      // failures) get surfaced as an alert email to admin instead of silently
      // swallowed by the outer webhook catch. Production case: Sophie Larsson
      // referral 2026-05-11 03:52 UTC arrived in Postmark stream cleanly but
      // never created a deal — most plausibly a transient Claude error during
      // parseReferralEmail or generateReferralWelcomeEmail. Pre-ZZZ left no
      // forensic trace; ZZZ alerts Franco with the Postmark MessageID so he
      // can retry.
      console.log('Admin sent new email with no thread match — treating as referral');
      try {
        // Parse referral details from Franco's email
        const referral = await aiService.parseReferralEmail(email.textBody);
        console.log('Referral parsed:', JSON.stringify(referral));

        if (!referral.referred_email) {
          // Group ZZZ Layer 3 (S11.1): pre-ZZZ this silently dropped the
          // referral. Now alert Franco with the parsed snapshot so he can
          // retry with the referred person's email explicitly in the body.
          console.log('No email address found in referral — alerting Franco (ZZZ Layer 3)');
          const layer3AlertBody = `Vienna couldn't find an email address in your referral.

Parsed snapshot:
${JSON.stringify(referral, null, 2)}

Original referral body (first 500 chars):
${(email.textBody || '').slice(0, 500)}

Postmark MessageID: ${email.messageId}

Please reply with the referred person's email address explicitly stated.

(This alert is automatic — Group ZZZ defensive bundle.)`;
          await emailService.sendEmail(
            config.adminEmail,
            `Referral missing email — ${email.subject || 'unknown subject'}`,
            layer3AlertBody,
            null,
            [],
            []
          );
          return;
        }

        // Create a new deal for the referred person
        const deal = await dealsService.create({
          email: referral.referred_email,
          borrower_name: referral.referred_name || 'Unknown',
        });
        console.log('Referral deal created:', deal.id);

        // Save Franco's referral email as the first message
        await dealsService.saveMessage(deal.id, 'inbound', email.subject, email.textBody);

        // Save any attachments Franco included
        let savedDocs = [];
        if (email.attachments.length > 0) {
          console.log('Saving referral attachments to Supabase...');
          savedDocs = await dealsService.saveAttachments(deal.id, email.attachments);
        }

        // Generate welcome email for the referred person
        const welcomeEmail = await aiService.generateReferralWelcomeEmail(referral);
        console.log('Referral welcome email generated');

        // Referrals always get both forms regardless of broker or borrower
        const formAttachments = emailService.getFormAttachments({ skipApplicationForm: false });
        console.log('Attaching', formAttachments.length, 'forms for referral');

        // Send welcome email to referred person, CC Franco
        const result = await emailService.sendEmail(
          referral.referred_email,
          `Private Mortgage Link — ${referral.referred_name || 'Your Loan Inquiry'}`,
          welcomeEmail.replace(/<[^>]*>/g, ''),
          welcomeEmail,
          formAttachments,
          [],
          config.adminEmail
        );
        await dealsService.saveMessage(deal.id, 'outbound', `Private Mortgage Link — ${referral.referred_name || 'Your Loan Inquiry'}`, welcomeEmail, result.MessageID);

        // Save deal summary
        await dealsService.update(deal.id, {
          status: 'active',
          extracted_data: {
            sender_type: referral.sender_type,
            sender_name: referral.referred_name,
            borrower_name: referral.referred_name,
            referred_by: 'Franco Maione',
            deal_details: referral.deal_details,
            notes: referral.notes,
          },
        });

        console.log('Referral welcome email sent to', referral.referred_email, '(CC:', config.adminEmail, ')');
      } catch (err) {
        // Group ZZZ Layer 1: any unhandled error in the referral dispatch path
        // gets surfaced as an alert email. Pre-ZZZ this was silently swallowed
        // by the outer webhook try/catch, leaving zero forensic trace. Now
        // Franco knows the referral failed and can retry. Best-effort: if the
        // alert send itself fails, the console.error in the outer catch still
        // logs.
        console.error('ZZZ Layer 1 — referral dispatch failed:', err);
        const layer1AlertBody = `Vienna encountered an error processing your referral email.

Error: ${err.message}

Original referral subject: ${email.subject}
Postmark MessageID: ${email.messageId}
Time: ${new Date().toISOString()}

The referred person did NOT receive a welcome email. Please retry by re-sending the referral.

(This alert is automatic — Group ZZZ defensive bundle.)`;
        try {
          await emailService.sendEmail(
            config.adminEmail,
            `Referral dispatch failed — ${email.subject || 'unknown subject'}`,
            layer1AlertBody,
            null,
            [],
            []
          );
        } catch (alertErr) {
          console.error('ZZZ Layer 1 alert send also failed:', alertErr);
        }
      }
      return;
    }

    if (!existingDeal) {
      // NEW CLIENT - first contact
      // Group FFFF (S14.1): wrap the new-client INITIAL dispatch in its own
      // try/catch — same defensive pattern as ZZZ Layer 1 (referral branch).
      // Pre-FFFF a transient Claude error during processInitialEmail (or any
      // other unhandled throw in this path) was silently swallowed by the
      // outer webhook catch, leaving an orphan scaffold deal with empty
      // extracted_data + wrong borrower_name fallback and no welcome email.
      // Production case: Lena Park 2026-05-11 22:35 UTC — credit-bureau
      // classification call succeeded but the larger processInitialEmail
      // call flaked; sender got no response and admin had no forensic trace.
      // FFFF tears down the scaffold (so retry doesn't shadow-match via
      // findActiveByEmail) and alerts Franco with the Postmark MessageID.
      let createdDeal = null;
      try {
        console.log('New client detected, creating deal...');

        // Create deal in database
        const deal = await dealsService.create({
          email: email.from,
          borrower_name: email.fromName,
        });
        createdDeal = deal;

        // Save inbound message
        await dealsService.saveMessage(deal.id, 'inbound', email.subject, email.textBody);

        // Save attachments first — extracts text once, stores in Supabase
        let savedDocs = [];
        if (email.attachments.length > 0) {
          console.log('Saving attachments to Supabase...');
          savedDocs = await dealsService.saveAttachments(deal.id, email.attachments);
        }

        // Check if broker already sent a loan application form / PNW statement.
        // Group S+W: detect own-PNW alongside own-application — pre-fix the PNW form
        // was always attached even when the broker submitted their own (Bug 9.2).
        const hasOwnApplication = email.attachments.some(a =>
          /application|loan.?app|summary/i.test(a.Name)
        );
        const hasOwnPnw = email.attachments.some(a =>
          /pnw|personal.?net.?worth|net.?worth/i.test(a.Name)
        );

        // F2 — Detect Franco-collision in the From-header BEFORE calling Claude.
        // Use firstNameMatchesAdmin (Franco-pattern only) — NOT isUnreliableName,
        // which over-fires on empty/Unknown FromName and triggered the Chris/Marcus/Brian
        // generic-greeting regression. Empty FromName means "no display name", which is
        // common; it does not mean "Franco-collision".
        const initialFromCollision = firstNameMatchesAdmin(email.fromName);

        // Cluster B Commit 2b — pre-Claude discrepancy detection (PURE JS injection).
        // Engine yields automatically on commercial / S15-E identity-clash deals.
        // filterBrokerFacing applies the Req-3 calibration gate: objective fields
        // (postal / lender / address / borrower_name) always broker-facing; market-
        // delta fields admin-only pending Franco's calibration.
        const _bDetect = dEngine.runDiscrepancyDetection(
          email.textBody,
          savedDocs,
          email.fromName,
          { emailSubject: email.subject }
        );
        const _bBrokerFacing = dEngine.filterBrokerFacing(_bDetect.discrepancy_set, { marketDeltaFlagsEnabled: false });
        const _bDiscrepancyDetected = _bBrokerFacing.length > 0;
        const _bCanonicalPromptCtx = (_bDetect.canonical_map && Object.keys(_bDetect.canonical_map).length > 0)
          ? dEngine.formatCanonicalFieldsForPrompt(_bDetect.canonical_map)
          : '';
        if (_bDiscrepancyDetected) {
          console.log(`B-2b: pre-Claude discrepancy detection fired — ${_bBrokerFacing.length} broker-facing entries (${_bDetect.discrepancy_set.length} total before separability filter). Prompt instructed NO-GENERATE-DISCREPANCY; JS will inject section post-Claude.`);
        }

        // Single Claude call: generate welcome email + deal summary together
        // Passes pre-extracted text from savedDocs — no second pdf-parse run
        console.log('Processing initial email with Claude...');
        console.log('Passing', email.attachments.length, 'attachments for analysis');
        if (initialFromCollision) console.log('From-header collides with admin first name — instructing generic greeting');
        // eslint-disable-next-line prefer-const
        let { welcomeEmail, dealSummary } = await aiService.processInitialEmail(
          email.fromName,
          email.textBody,
          email.attachments,
          savedDocs,
          hasOwnApplication,
          hasOwnPnw,
          initialFromCollision,
          email.subject,  // S15-E-followup: subject used by JS-side absence-based clash detection
          { discrepancyDetected: _bDiscrepancyDetected, canonicalFieldsPrompt: _bCanonicalPromptCtx }
        );
        // Cluster B Commit 2b — post-Claude strip + inject (pure JS injection completes).
        // strip is defense-in-depth backstop (Cluster E lesson — prompt enforcement is
        // probabilistic). injection writes the JS-authoritative discrepancy section
        // verbatim from the canonical-field map.
        if (_bDiscrepancyDetected) {
          const _stripRes = aiService.stripVienna_DiscrepancyContent(welcomeEmail);
          const _section = dEngine.renderDiscrepancySection(_bBrokerFacing);
          welcomeEmail = aiService.injectDiscrepancySection(_stripRes.stripped, _section);
          console.log(`B-2b: strip stripped-any=${_stripRes.strippedAny}; injected JS discrepancy section (${_bBrokerFacing.length} entries)`);
        }
        // Cluster E — post-gen routing-leak sweep (Vienna-autonomous broker-facing).
        // Runs AFTER B's strip+inject so the sweep operates on the final pre-send
        // content. Substitutes Franco-reported leak phrases + PPPP-listed residuals
        // with PPPP-allowed safe alternatives. Admin-edited/dictated content
        // structurally cannot reach this point (carve-out by call-site).
        {
          const _eSweep = aiService.enforceNoRoutingLeak(welcomeEmail);
          welcomeEmail = _eSweep.swept;
          if (_eSweep.sweptAny) console.log(`E: routing-leak sweep substituted phrasing in welcomeEmail`);
        }
        // Bug B Layer A: rescue sender_name/broker_name from the Postmark From-header
        // when Claude's extraction is null/Unknown/Franco-collision. F2 adds the
        // both-Franco branch — sets name_collides_with_admin: true on the summary
        // for downstream prompts (generateBrokerResponse) to read.
        dealSummary = normalizeSenderName(dealSummary, email.fromName);
        console.log('Welcome email + deal summary generated');

        // Get form attachments.
        // Group VVV (S4.1): if the deal will route to a deferred-intake state
        // (awaiting_collateral or awaiting_identity_confirmation), skip both
        // forms — Vienna's welcome asks ONE specific question and forms ship
        // wasted if the deal is declined or the borrower turns out wrong.
        // Q3-VVV: applies regardless of sender_type (borrowers in deferred
        // state skip forms too).
        // Otherwise: borrowers always get both forms (they don't have their own);
        // brokers skip whichever form they already provided.
        const deferredIntake = shouldSkipIntakeFormsForDeferredState(dealSummary);
        const isBorrower = dealSummary?.sender_type === 'borrower';
        const skipApp = deferredIntake || (isBorrower ? false : hasOwnApplication);
        const skipPnw = deferredIntake || (isBorrower ? false : hasOwnPnw);
        const formAttachments = emailService.getFormAttachments({ skipApplicationForm: skipApp, skipPnwForm: skipPnw });
        const skipNote = deferredIntake
          ? `(VVV — deferred-intake state, skipping forms; identity_clash=${!!dealSummary?.identity_clash} ltv=${dealSummary?.ltv_percent})`
          : (isBorrower
            ? '(borrower — always attach both)'
            : [hasOwnApplication && 'skipping Application Form', hasOwnPnw && 'skipping PNW Form'].filter(Boolean).join(', ') || '');
        console.log('Attaching', formAttachments.length, 'forms', skipNote ? `(${skipNote})` : '');

        // Send the AI-generated response with forms attached (HTML formatted)
        emailService.sendEmailDelayed(
          email.from,
          `Re: ${email.subject}`,
          welcomeEmail.replace(/<[^>]*>/g, ''),
          welcomeEmail,
          formAttachments,
          [],
          async (result) => {
            await dealsService.saveMessage(deal.id, 'outbound', `Re: ${email.subject}`, welcomeEmail, result.MessageID);
          }
        );

        // Save summary and update status
        await dealsService.update(deal.id, {
          status: 'active',
          extracted_data: dealSummary,
          ltv: dealSummary ? dealSummary.ltv_percent : null,
          borrower_name: dealSummary?.borrower_name || email.fromName,
          has_application_form: hasOwnApplication || false,
          has_pnw_statement: hasOwnPnw || false,
        });

        console.log('Welcome email sent, deal status: active');

        // Same HITL gate as the existing-deal `active` branch: if the broker submitted
        // an explicit LTV in the very first email, route Franco's escalation (>80%) or
        // preliminary review (≤80%) immediately. The welcome email to the broker still
        // goes — both fire in parallel.
        //
        // Predicate matches Bradley's commit e93f657: high-LTV escalation does NOT require
        // a reviewable doc (Franco wants to see those deals immediately); preliminary
        // review for ≤80% still requires at least one of income_proof / NOA / appraisal.
        const initialDocsForGateRaw = await dealsService.getDocumentsByDeal(deal.id);
        // Group JJJJ (S15.2): filter out misattached docs (wrong borrower OR
        // wrong property) before computing the reviewable-doc gate. Vienna's
        // dealSummary.misattached_documents lists filenames whose content doesn't
        // belong to the canonical deal file; gate must not count them or prelim
        // fires on docs that don't apply to the transaction.
        const initialDocsForGate = eligibleDocsForGate(initialDocsForGateRaw, dealSummary);
        const initialClassifications = initialDocsForGate.map(d => d.classification).filter(Boolean);

        // Group EEEE (S12.2): stamp intake_asked_items snapshot so cron reminders
        // enumerate what Vienna actually asked for (not what current policy
        // dictates — cross-policy drift caused the Noah MacKenzie reminder
        // mismatch). Best-effort per Q2-EEEE — try/catch + console.error;
        // welcome email already sent to broker, stamping is internal optimization
        // and fallback path is the pre-EEEE behavior (baseRequired recomputed
        // at reminder time).
        const intakeAskedItems = computeIntakeAskedItems(dealSummary, initialClassifications);
        if (intakeAskedItems !== null) {
          try {
            await dealsService.update(deal.id, { intake_asked_items: intakeAskedItems });
            console.log(`EEEE: stamped intake_asked_items=${JSON.stringify(intakeAskedItems)} on deal ${deal.id}`);
          } catch (stampErr) {
            console.error('EEEE: intake_asked_items stamp failed (best-effort; cron will fall back to baseRequired):', stampErr.message);
          }
        } else {
          console.log(`EEEE: skipped intake_asked_items stamp (borrower-path or deferred-intake state — cron will fall back to baseRequired)`);
        }
        const initialHasReviewableDoc = ['income_proof', 'noa', 'appraisal'].some(c => initialClassifications.includes(c));
        // Group BBBB (S7.1/S9.1) — RELAXED in R4-Bucket-B (S5/Patricia):
        // Original BBBB required exit_strategy populated before firing prelim,
        // to prevent NNN's preliminary-update dispatch from firing a SECOND
        // prelim after broker provided exit. But that gate held the FIRST prelim
        // ENTIRELY when exit_strategy was missing — S5/Patricia got zero admin
        // visibility for days (status stayed 'active', no prelim ever fired).
        // Post-relaxation: drop the exit_strategy precondition. Exit_strategy is
        // already pushed to missingDocs at L588 (Group C), so admin sees
        // [MISSING] Exit Strategy in the PRELIMINARY review and decides.
        // The S7.1/S9.1 duplicate-prelim regression remains closed because: the
        // initial prelim and the broker's exit-strategy follow-up now both land
        // on the same under_review state; NNN's preliminary-update dispatch is
        // an UPDATE to the existing prelim, not a second prelim (subjectPrefix
        // '[UPDATED]' at L713 and the banner trichotomy keep this honest).
        // Kept the variable definition because it's referenced in the log line.
        const initialHasExitStrategy = !!(dealSummary?.exit_strategy && String(dealSummary.exit_strategy).trim());
        const initialLtv = dealSummary?.ltv_percent;

        if (dealSummary?.identity_clash) {
          // Group HHH (S15.1): identity gate runs FIRST, before LTV gates. Vienna's
          // welcome email asks ONLY for the borrower-name clarification (per the
          // IDENTITY CLASH block in INITIAL_EMAIL_PROMPT); doc requests and the
          // collateral question are deferred until identity is resolved. Admin sees
          // nothing during this state — same silent-pending pattern as Fix 7.
          console.log('Initial submission identity_clash=true — entering awaiting_identity_confirmation state (HHH)');
          await dealsService.update(deal.id, { status: 'awaiting_identity_confirmation' });
        } else if (initialLtv && initialLtv > 80) {
          // Fix 7: do NOT escalate immediately. Set status to 'awaiting_collateral'
          // and let Vienna's welcome email carry the collateral question. Admin sees
          // nothing until the broker confirms no-collateral (then we silently
          // escalate) or offers collateral (then status flips back to active).
          // Reverses Bradley's e93f657 parallel-fire model per Franco's S4 retest.
          console.log(`Initial submission LTV ${initialLtv}% > 80 — entering awaiting_collateral state (Fix 7)`);
          await dealsService.update(deal.id, { status: 'awaiting_collateral' });
        } else if (initialLtv && initialLtv <= 80 && initialHasReviewableDoc) {
          console.log(`Initial submission LTV ${initialLtv}% <= 80 with reviewable doc — sending preliminary review immediately (BBBB-relaxed: exit_strategy gap surfaces as [MISSING] in admin prelim, not a hold-gate; initialHasExitStrategy=${initialHasExitStrategy})`);
          // ownership_type is null on initial submission (only set later by generateBrokerResponse).
          // Fix 6 closed the display side: generateLeadSummary now renders "Ownership Type: TBD"
          // when null. The remaining (deferred) enhancement is to extract ownership_type directly
          // in INITIAL_EMAIL_PROMPT's TASK 2 JSON so it's populated on day 1.
          // Cluster D: pass welcomeEmail so sendPreliminaryReviewToAdmin can detect
          // a pending broker-facing clarification ask and suppress COMPLETE.
          await sendPreliminaryReviewToAdmin(deal, dealSummary, null, initialLtv, { brokerFacingReplyText: welcomeEmail });
        }
      } catch (err) {
        // Group FFFF Layer 1: any unhandled error in the new-client INITIAL
        // dispatch tears down the partial scaffold and alerts Franco. Pre-FFFF
        // this was silently swallowed by the outer webhook catch — Lena Park
        // pattern. Cleanup runs first so a retry email from the same sender
        // doesn't shadow-match the orphan via findActiveByEmail (which would
        // route to the existing-deal active branch and skip processInitialEmail
        // entirely — different silent failure on retry).
        console.error('FFFF Layer 1 — new-client INITIAL dispatch failed:', err);
        if (createdDeal) {
          try {
            await dealsService.deleteDeal(createdDeal.id);
            console.log(`FFFF: cleaned up orphan scaffold deal ${createdDeal.id}`);
          } catch (cleanupErr) {
            console.error('FFFF: scaffold cleanup also failed (manual cleanup required):', cleanupErr.message);
          }
        }
        const ffffAlertBody = `Vienna encountered an error processing a new-client email.

Error: ${err.message}

Original subject: ${email.subject}
From: ${email.fromName} <${email.from}>
Postmark MessageID: ${email.messageId}
Time: ${new Date().toISOString()}

The sender did NOT receive a welcome email. Partial deal scaffold ${createdDeal ? createdDeal.id : '(not created)'} has been cleaned up — sender can retry by re-sending the email.

(This alert is automatic — Group FFFF defensive bundle.)`;
        try {
          await emailService.sendEmail(
            config.adminEmail,
            `New-client dispatch failed — ${email.subject || 'unknown subject'}`,
            ffffAlertBody,
            null,
            [],
            []
          );
        } catch (alertErr) {
          console.error('FFFF Layer 1 alert send also failed:', alertErr);
        }
        return;
      }
    } else {
      // EXISTING CLIENT - follow-up email
      console.log('Existing deal found:', existingDeal.id, 'Status:', existingDeal.status);

      // Save inbound message and reset reminder count (broker replied)
      await dealsService.saveMessage(existingDeal.id, 'inbound', email.subject, email.textBody);
      if (existingDeal.reminder_count > 0) {
        await dealsService.update(existingDeal.id, { reminder_count: 0 });
      }

      // Save attachments first — extracts text once, stores in Supabase
      let savedDocs = [];
      if (email.attachments.length > 0) {
        console.log('Saving attachments to Supabase...');
        savedDocs = await dealsService.saveAttachments(existingDeal.id, email.attachments);
      }

      // Group HHH (S15.1): identity gate. When a deal is awaiting_identity_confirmation,
      // parse the broker's reply for resolved/unresolved and dispatch:
      //   - 'resolved'   → broker confirmed which borrower is correct. If parser
      //                    extracted a confirmedBorrowerName, update dealSummary.borrower_name.
      //                    Flip status to active, clear identity_clash flag, and fall through
      //                    to normal active handling — generateBrokerResponse runs on the
      //                    resolved deal and resumes normal intake.
      //   - 'unresolved' → no DB state change; in-memory route through active branch so
      //                    Vienna re-asks via generateBrokerResponse's awaiting_identity_confirmation
      //                    block. Next broker reply gets re-parsed.
      // Identity gate runs BEFORE Fix 7's collateral gate — clarify identity first, then
      // evaluate LTV in subsequent turn (two-hop state for the rare double-issue case).
      if (existingDeal.status === 'awaiting_identity_confirmation') {
        console.log('Awaiting-identity-confirmation broker reply — parsing for resolved/unresolved');
        const { disposition, confirmedBorrowerName } = await aiService.parseIdentityClarification(
          email.textBody,
          existingDeal.extracted_data
        );
        console.log(`Identity disposition: ${disposition}${confirmedBorrowerName ? ` (confirmed: ${confirmedBorrowerName})` : ''}`);

        if (disposition === 'resolved') {
          console.log('Identity resolved — flipping status to active, clearing identity_clash');
          const updatedExtracted = {
            ...(existingDeal.extracted_data || {}),
            identity_clash: false,
          };
          // Q2: confirmedBorrowerName falls back to null if extraction unreliable. Only
          // update borrower_name if we have a confirmed value; otherwise keep the
          // originally-detected name (Vienna's subsequent flow re-extracts on next turn).
          const updates = { status: 'active', extracted_data: updatedExtracted };
          if (confirmedBorrowerName) {
            updates.borrower_name = confirmedBorrowerName;
            updatedExtracted.borrower_name = confirmedBorrowerName;
          }
          await dealsService.update(existingDeal.id, updates);
          existingDeal.status = 'active';
          if (confirmedBorrowerName) existingDeal.borrower_name = confirmedBorrowerName;
          existingDeal.extracted_data = updatedExtracted;
          // Fall through to normal active handling
        } else {
          console.log('Unresolved identity reply — staying in awaiting_identity_confirmation, re-asking via conversational handler');
          // In-memory route through active branch so generateBrokerResponse runs and
          // re-asks via the IDENTITY CLASH PENDING prompt block (gated on
          // existingSummary.identity_clash, not status). Mirrors Fix 7's ambiguous-
          // collateral pattern. DB status stays awaiting_identity_confirmation —
          // the active-branch LTV gate below requires status==='active' AND
          // identity_clash check happens at processInitialEmail time only, so the
          // active branch's LTV gate won't re-route this deal. Once broker
          // resolves on next turn, we'll flip to active properly.
          existingDeal.status = 'active';
        }
      }

      // Fix 7: high-LTV collateral gate. When a deal is awaiting_collateral, parse the
      // broker's reply for yes/no/ambiguous and dispatch:
      //   - 'no'        → silently escalate to admin (no broker reply, similar to Group L
      //                   suppression). sendEscalationToAdmin flips status to ltv_escalated.
      //   - 'yes'       → broker offered additional collateral. Set extracted_data.collateral_offered
      //                   so the active-branch LTV gate doesn't re-route back to awaiting_collateral.
      //                   Flip status to active and fall through to normal active handling.
      //   - 'ambiguous' → no DB state change; in-memory route through active branch so Vienna
      //                   re-asks via generateBrokerResponse. Next broker reply gets re-parsed.
      if (existingDeal.status === 'awaiting_collateral') {
        console.log('Awaiting-collateral broker reply — parsing for yes/no/ambiguous');
        const { disposition } = await aiService.parseCollateralReply(email.textBody);
        console.log(`Collateral disposition: ${disposition}`);

        if (disposition === 'no') {
          console.log('No additional collateral offered — escalating silently to admin');
          // Defensively normalize the stored summary before passing in (Bug B Layer A + F2).
          const escalationSummary = normalizeSenderName(existingDeal.extracted_data, email.fromName);
          await sendEscalationToAdmin(existingDeal, escalationSummary, existingDeal.ltv);
          return; // Silent — no broker-facing reply
        }

        if (disposition === 'yes') {
          console.log('Additional collateral offered — flipping status to active, marking collateral_offered');
          // Persist the collateral_offered flag so the active-branch LTV gate below does
          // NOT re-route this deal back to awaiting_collateral (which would otherwise
          // create a state loop, since the LTV value itself hasn't changed yet).
          const updatedExtracted = { ...(existingDeal.extracted_data || {}), collateral_offered: true };
          await dealsService.update(existingDeal.id, { status: 'active', extracted_data: updatedExtracted });
          existingDeal.status = 'active';
          existingDeal.extracted_data = updatedExtracted;
        } else {
          console.log('Ambiguous collateral reply — staying in awaiting_collateral, re-asking via conversational handler');
          // In-memory route through the active branch so generateBrokerResponse runs and
          // re-asks via the high-LTV prompt block. DB status stays 'awaiting_collateral',
          // so the next broker reply is parsed for collateral disposition again. The
          // active-branch LTV gate WILL re-write status='awaiting_collateral' to the DB
          // (idempotent — already that value).
          existingDeal.status = 'active';
        }
      }

      if (existingDeal.status === 'ltv_escalated' || existingDeal.status === 'under_review') {
        // Broker replied while Franco is reviewing.
        // Fix 2: dispatch admin notification AFTER generateBrokerResponse so we can
        // send an UPDATED preliminary review / escalation with fresh state when broker
        // submitted new docs. Pre-fix this branch only sent a passive [Broker Update]
        // ping with no action options — workflow stalled because admin couldn't see
        // the updated doc state or APPROVE/DECLINE without scrolling to the original
        // review email. New behavior:
        //   - hasNewDocs → updated review/escalation supersedes the passive [Broker Update]
        //   - no docs   → keep the passive [Broker Update] (state didn't change; just a note)
        const hasNewDocs = email.attachments.length > 0;
        console.log(`Broker replied while deal is ${existingDeal.status} (${email.attachments.length} attachment(s))`);

        // Run the conversational handler first so we have fresh extracted_data, LTV,
        // and ownership for the updated review. We intentionally do NOT re-trigger LTV
        // escalation/review based on LTV thresholds here — the deal is already in
        // admin's queue. The updated review (below) refreshes the doc state instead.
        console.log('Generating conversational response during review...');

        const reviewConversationHistory = await dealsService.getMessages(existingDeal.id);
        const reviewDocumentsOnFile = await dealsService.getDocumentsByDeal(existingDeal.id);

        // Bug B Layer A: defensively normalize stored extraction before feeding it back to Claude.
        const reviewSummaryIn = normalizeSenderName(existingDeal.extracted_data, email.fromName);
        // Group DDDD (S6.2): pre-label admin replies so generateBrokerResponse's
        // conversation history doesn't mis-attribute them to the broker — same
        // root cause + fix shape as generateLeadSummary's S6.2 (Q1-DDDD: symmetric).
        const reviewBrokerName = reviewSummaryIn?.broker_name || reviewSummaryIn?.sender_name || existingDeal.borrower_name;
        const labeledReviewHistory = labelMessagesForLeadSummary(reviewConversationHistory, reviewBrokerName);
        // Items 3+4: pass deal status so Vienna's reply is state-aware (no future-tense
        // forwarding language when the file has already been sent to admin).
        // Cluster B Commit 2b — pre-Claude discrepancy detection for existing-deal under_review path.
        const _bDetectReview = dEngine.runDiscrepancyDetection(
          email.textBody,
          savedDocs.concat(reviewDocumentsOnFile.map(d => ({ file_name: d.file_name, classification: d.classification, text: d?.extracted_data?.text || '' }))),
          email.fromName,
          { emailSubject: email.subject }
        );
        const _bBrokerFacingReview = dEngine.filterBrokerFacing(_bDetectReview.discrepancy_set, { marketDeltaFlagsEnabled: false });
        const _bDiscrepancyDetectedReview = _bBrokerFacingReview.length > 0;
        const _bCanonicalCtxReview = (_bDetectReview.canonical_map && Object.keys(_bDetectReview.canonical_map).length > 0)
          ? dEngine.formatCanonicalFieldsForPrompt(_bDetectReview.canonical_map)
          : '';
        if (_bDiscrepancyDetectedReview) {
          console.log(`B-2b (review path): pre-Claude discrepancy detection fired — ${_bBrokerFacingReview.length} broker-facing entries`);
        }

        const reviewResult = await aiService.generateBrokerResponse(
          email.textBody,
          email.attachments,
          savedDocs,
          reviewSummaryIn,
          labeledReviewHistory,
          reviewDocumentsOnFile,
          existingDeal.status,
          { discrepancyDetected: _bDiscrepancyDetectedReview, canonicalFieldsPrompt: _bCanonicalCtxReview }
        );
        // Cluster B Commit 2b — post-Claude strip + inject on reply (even though NNN may suppress it from broker;
        // the suppressed text is still passed to sendPreliminaryReviewToAdmin via brokerFacingReplyText for D's gate).
        if (_bDiscrepancyDetectedReview && reviewResult.responseEmail) {
          const _stripRes = aiService.stripVienna_DiscrepancyContent(reviewResult.responseEmail);
          const _section = dEngine.renderDiscrepancySection(_bBrokerFacingReview);
          reviewResult.responseEmail = aiService.injectDiscrepancySection(_stripRes.stripped, _section);
        }
        // Cluster E — routing-leak sweep on Vienna-autonomous review-path reply.
        if (reviewResult.responseEmail) {
          const _eSweep = aiService.enforceNoRoutingLeak(reviewResult.responseEmail);
          reviewResult.responseEmail = _eSweep.swept;
          if (_eSweep.sweptAny) console.log(`E: routing-leak sweep substituted phrasing in review-path responseEmail`);
        }
        // Normalize the freshly-updated summary on the way back, before persisting.
        reviewResult.updatedSummary = normalizeSenderName(reviewResult.updatedSummary, email.fromName);

        // Merge form booleans — once received, always true
        const reviewHasApp = reviewResult.hasApplicationForm || existingDeal.has_application_form;
        const reviewHasPnw = reviewResult.hasPnwStatement || existingDeal.has_pnw_statement;
        const reviewLtv = reviewResult.ltvPercent ?? existingDeal.ltv;
        const reviewOwnership = reviewResult.ownershipType || existingDeal.ownership_type;

        // Update deal with latest info (but keep the existing status — Franco is still reviewing)
        await dealsService.update(existingDeal.id, {
          extracted_data: reviewResult.updatedSummary,
          ltv: reviewLtv,
          ownership_type: reviewOwnership,
          borrower_name: reviewResult.updatedSummary?.borrower_name || existingDeal.borrower_name,
          has_application_form: reviewHasApp,
          has_pnw_statement: reviewHasPnw,
        });

        // Group NNN (S1.1–S1.3 + S2.3–S2.4): unified dispatch matrix for under_review
        // and ltv_escalated. Replaces the Fix 2 + Group BBB three-way split with:
        //   - under_review + allDocsInNow → sendCompletionHandoff (BBB-generalized
        //     for non-conditions path; gated on !draft_email to avoid clobbering an
        //     in-progress admin draft-edit cycle)
        //   - ltv_escalated → sendEscalationToAdmin({isUpdate:true})
        //   - under_review + !allDocsInNow → sendPreliminaryReviewToAdmin({isUpdate:true})
        //
        // The passive [Broker Update] forward is deleted entirely — every broker
        // turn now triggers a fresh admin signal regardless of hasNewDocs. Per Q1,
        // no rate-limit; brokers typically send one substantive turn at a time, and
        // over-fire risk is low. If retest surfaces noise, add rate-limit then.
        //
        // Q7: allDocsInNow gate covers case 6 (text-only reply when file is already
        // complete) — recovery from S1.3 noise shape (redundant [UPDATED] COMPLETE
        // Review buttons). With draft_email already set, no-op silently — broker's
        // inbound is saved to thread (line 781) and admin sees it on next look.
        //
        // Pure dispatch decision (decideReviewDispatch) — extracted helper so
        // truth-table tests can exercise it without mocking the full request
        // pipeline. See helper definition for action semantics.
        const reviewClassifications = reviewDocumentsOnFile.map(d => d.classification).filter(Boolean);
        // R4-Bucket-C.1: thread hasNewDocs into the dispatch decision. Broker
        // text-only replies on under_review (S7 Bug 3 / S8 Bug 2) now route to
        // 'text-only-noop' instead of producing wrong-shape admin signals
        // ([File Complete] / [UPDATED] PRELIMINARY on a clarification-only reply).
        const dispatch = decideReviewDispatch(existingDeal, reviewResult.updatedSummary, reviewClassifications, hasNewDocs);
        console.log(`NNN dispatch decision: ${JSON.stringify(dispatch)}`);

        if (dispatch.action === 'completion-handoff') {
          const reviewDocsWithText = await dealsService.getDocumentsWithText(existingDeal.id);
          const reviewMessagesForHandoff = await dealsService.getMessages(existingDeal.id);
          await sendCompletionHandoff(existingDeal, reviewResult.updatedSummary, reviewDocsWithText, reviewMessagesForHandoff, email, {
            conditionsFulfilled: dispatch.conditionsFulfilled,
          });
        } else if (dispatch.action === 'noop') {
          // Admin mid-preview-cycle on an existing draft. Broker inbound already
          // saved to thread (line 781); admin sees it when they finish the current
          // cycle and looks at conversation history. No clobber of generated draft.
        } else if (dispatch.action === 'text-only-noop') {
          // R4-Bucket-C.1 (S7 Bug 3 / S8 Bug 2): broker text-only reply on
          // under_review (hasNewDocs=false). No admin-facing emission — Vienna's
          // broker-facing reply (generateBrokerResponse) already ran upstream
          // (L1762-1777) and shipped; deal state already persisted at L1801-1808;
          // broker inbound saved to conversation thread. Admin sees the inbound
          // when they look at the deal. Pre-C.1 this branch fired
          // completion-handoff (S7: [File Complete] on a clarification reply,
          // file complete but admin hadn't approved) or preliminary-update
          // (S8: redundant [UPDATED] PRELIMINARY with no state change). Per
          // user direction this is a *conscious scoping* of "suppress the wrong
          // signal" — whether a CORRECT clarification-resolved signal should
          // fire on a text-only clarification reply is Cluster C.5's scope
          // (no-ack-after-clarification), NOT a C.1 decision that admin never
          // needs to know about clarification replies.
        } else if (dispatch.action === 'escalation-update') {
          await sendEscalationToAdmin(existingDeal, reviewResult.updatedSummary, reviewLtv, { isUpdate: true });
        } else {
          // 'preliminary-update' — under_review + !allDocsInNow + hasNewDocs=true
          // Cluster D: pass the generated-but-NNN-suppressed reviewResult.responseEmail
          // so the gate can still detect a pending clarification ask even though the
          // broker doesn't see Vienna's reply directly on this turn.
          await sendPreliminaryReviewToAdmin(existingDeal, reviewResult.updatedSummary, reviewOwnership, reviewLtv, { isUpdate: true, brokerFacingReplyText: reviewResult.responseEmail || '' });
        }

        // Group NNN: Vienna goes silent across the whole under_review/ltv_escalated
        // branch. Admin's draft preview SEND is the next and only broker-facing
        // message. Pre-NNN this branch suppressed Vienna only on the BBB path
        // (conditions+hasNewDocs); NNN extends suppression to all paths — every
        // broker turn flows through an admin HITL signal (or a no-op when admin is
        // mid-cycle), and Vienna's conversational reply alongside would be
        // redundant or misleading (S1.1 "Thanks for sending those through" while
        // a fresh review email is also landing; S1.2 "I believe we have everything
        // we need to send the file for review" when the file was already sent).
        //
        // reviewResult.responseEmail is still generated by generateBrokerResponse
        // because the same call also produces updatedSummary/ltv/ownership/
        // allDocsReceived — ~$0.005 of wasted generation per turn is acceptable to
        // keep the call site simple. Future: skip-generation flag on the prompt.
        console.log('NNN suppression — Vienna broker reply held; admin draft preview is next broker-facing message');
      } else if (existingDeal.status === 'active') {
        // CONVERSATIONAL HANDLER — respond to broker contextually
        console.log('Generating conversational response...');

        const conversationHistory = await dealsService.getMessages(existingDeal.id);
        const documentsOnFile = await dealsService.getDocumentsByDeal(existingDeal.id);

        // Bug B Layer A: defensively normalize stored extraction before feeding it back to Claude.
        const summaryIn = normalizeSenderName(existingDeal.extracted_data, email.fromName);
        // Group DDDD (S6.2): pre-label admin replies for the active-branch
        // conversation history too. Symmetric with under_review branch.
        const activeBrokerName = summaryIn?.broker_name || summaryIn?.sender_name || existingDeal.borrower_name;
        const labeledActiveHistory = labelMessagesForLeadSummary(conversationHistory, activeBrokerName);
        // Items 3+4: pass deal status (active here, since this is the active branch).
        // Status drives the FILE STATE block in the prompt — gates state-aware forwarding rules.
        // Group KKKK escalation (D3 5/5 leaked pre-block): compute JS-side
        // postApprovalAmlPepAsk signal and pass to generateBrokerResponse. Fires
        // when deal is post-approval (prelim_approved_at set), all intake docs
        // are on file, and AML or PEP missing. Triggers the explicit prompt
        // block instructing Vienna to request AML/PEP in this conversational
        // reply. Pre-KKKK the conversational handler omitted AML/PEP because
        // the prompt's STANDARD DOCUMENT CHECKLIST doesn't include them.
        const activeDocsClassifications = documentsOnFile.map(d => d.classification).filter(Boolean);
        const activeIsPurchase = isPurchaseFromSummary(summaryIn);
        const activeIntakeComplete = allIntakeReceived(activeDocsClassifications, activeIsPurchase);
        const activeAmlOnFile = activeDocsClassifications.includes('aml');
        const activePepOnFile = activeDocsClassifications.includes('pep');
        const postApprovalAmlPepAsk = !!existingDeal.prelim_approved_at
          && activeIntakeComplete
          && (!activeAmlOnFile || !activePepOnFile);

        // Group OOOO (S6.1): pre-approval enumeration of items blocking the
        // willReview gate. JS-computed signal → generateBrokerResponse's
        // stillMissingBlock injection. Same JS-flag-into-prompt pattern as
        // KKKK's postApprovalAmlPepAsk. Production case (Kevin Tran
        // 2026-05-16, deal ef05f551): exit_strategy null → willReview held
        // correctly but Vienna over-promised "we have everything we need
        // to send the file for review", stalling the file. OOOO suppresses
        // that template + enumerates the actual outstanding items.
        const activeIdentityClashUnresolved = !!summaryIn?.identity_clash;
        const stillMissingForReview = computeStillMissingForReview({
          deal: existingDeal,
          summary: summaryIn,
          classifications: activeDocsClassifications,
          identityClashUnresolved: activeIdentityClashUnresolved,
        });

        // Cluster B Commit 2b — pre-Claude discrepancy detection for existing-deal active path.
        const _bDetectActive = dEngine.runDiscrepancyDetection(
          email.textBody,
          savedDocs.concat(documentsOnFile.map(d => ({ file_name: d.file_name, classification: d.classification, text: d?.extracted_data?.text || '' }))),
          email.fromName,
          { emailSubject: email.subject }
        );
        const _bBrokerFacingActive = dEngine.filterBrokerFacing(_bDetectActive.discrepancy_set, { marketDeltaFlagsEnabled: false });
        const _bDiscrepancyDetectedActive = _bBrokerFacingActive.length > 0;
        const _bCanonicalCtxActive = (_bDetectActive.canonical_map && Object.keys(_bDetectActive.canonical_map).length > 0)
          ? dEngine.formatCanonicalFieldsForPrompt(_bDetectActive.canonical_map)
          : '';
        if (_bDiscrepancyDetectedActive) {
          console.log(`B-2b (active path): pre-Claude discrepancy detection fired — ${_bBrokerFacingActive.length} broker-facing entries`);
        }

        const result = await aiService.generateBrokerResponse(
          email.textBody,
          email.attachments,
          savedDocs,
          summaryIn,
          labeledActiveHistory,
          documentsOnFile,
          existingDeal.status,
          { postApprovalAmlPepAsk, stillMissingForReview, discrepancyDetected: _bDiscrepancyDetectedActive, canonicalFieldsPrompt: _bCanonicalCtxActive }
        );
        // Cluster B Commit 2b — post-Claude strip + inject on broker-facing reply.
        if (_bDiscrepancyDetectedActive && result.responseEmail) {
          const _stripRes = aiService.stripVienna_DiscrepancyContent(result.responseEmail);
          const _section = dEngine.renderDiscrepancySection(_bBrokerFacingActive);
          result.responseEmail = aiService.injectDiscrepancySection(_stripRes.stripped, _section);
        }
        // Cluster E — routing-leak sweep on Vienna-autonomous active-path reply.
        if (result.responseEmail) {
          const _eSweep = aiService.enforceNoRoutingLeak(result.responseEmail);
          result.responseEmail = _eSweep.swept;
          if (_eSweep.sweptAny) console.log(`E: routing-leak sweep substituted phrasing in active-path responseEmail`);
        }
        // Normalize the freshly-updated summary on the way back, before persisting.
        result.updatedSummary = normalizeSenderName(result.updatedSummary, email.fromName);

        // Merge form booleans — once received, always true
        const hasApp = result.hasApplicationForm || existingDeal.has_application_form;
        const hasPnw = result.hasPnwStatement || existingDeal.has_pnw_statement;
        const ltv = result.ltvPercent ?? existingDeal.ltv;
        const ownershipType = result.ownershipType || existingDeal.ownership_type;

        console.log(`Analysis: App=${hasApp} PNW=${hasPnw} | Ownership: ${ownershipType} | LTV: ${ltv} | AllDocs: ${result.allDocsReceived}`);

        // Update deal with latest info
        await dealsService.update(existingDeal.id, {
          extracted_data: result.updatedSummary,
          ltv: ltv,
          ownership_type: ownershipType,
          borrower_name: result.updatedSummary?.borrower_name || existingDeal.borrower_name,
          has_application_form: hasApp,
          has_pnw_statement: hasPnw,
        });

        // Gate the HITL review: only trigger once there's enough to actually evaluate.
        // For LTV ≤ 80% (preliminary review), require at least ONE of: proof of income, NOA, or appraisal.
        // For LTV > 80% (escalation), do NOT wait for any of those — Franco wants to see high-LTV deals
        // immediately so he can decide if there's room to work with additional collateral, etc.
        const docsForGateRaw = await dealsService.getDocumentsByDeal(existingDeal.id);
        // Group JJJJ (S15.2): filter out misattached docs (wrong borrower OR
        // wrong property) before computing the reviewable-doc gate. Anna
        // Bergstrom production case 2026-05-13: Grace Paulson's appraisal for
        // 88 Harvest Hills (correctly classified at the doc-level) triggered
        // prelim review on an Anna deal at 1801 Varsity Estates because the
        // gate had no concept of misattachment. Vienna's
        // updatedSummary.misattached_documents now surfaces the structured
        // signal; gate filters those filenames out.
        const docsForGate = eligibleDocsForGate(docsForGateRaw, result.updatedSummary);
        const classificationsForGate = docsForGate.map(d => d.classification).filter(Boolean);
        const hasReviewableDoc = ['income_proof', 'noa', 'appraisal'].some(c => classificationsForGate.includes(c));

        // Fix 7: high-LTV deals route to awaiting_collateral state instead of immediate
        // escalation. Skip the routing if extracted_data.collateral_offered is already
        // true (broker offered collateral on a previous turn — re-routing would create
        // a loop since LTV value hasn't changed). Once collateral is offered, the deal
        // proceeds through normal active flow; admin sees the collateral context on the
        // eventual prelim review.
        const collateralAlreadyOffered = !!existingDeal.extracted_data?.collateral_offered
          || !!result.updatedSummary?.collateral_offered;
        // Group HHH (S15.1): identity gate takes priority over all LTV gates. When
        // identity_clash is unresolved, the active-branch fall-through (from the
        // unresolved-reply handler that in-memory-flipped status='active') must NOT
        // trigger awaiting_collateral / under_review / FINAL REVIEW transitions —
        // identity must be confirmed first. The flag is cleared on resolved path
        // before reaching this gate, so resolved deals proceed normally.
        const identityClashUnresolved = !!existingDeal.extracted_data?.identity_clash
          || !!result.updatedSummary?.identity_clash;
        const willGoToCollateralCheck = ltv && ltv > 80 && existingDeal.status === 'active' && !collateralAlreadyOffered && !identityClashUnresolved;
        // Group BBBB (S7.1/S9.1): require exit_strategy populated before firing prelim.
        // Mirrors the initial-branch gate at line 1041. Pre-BBBB prelim fired with
        // exit_strategy: null → admin saw [MISSING] Exit Strategy → broker provided
        // exit → NNN's preliminary-update dispatch fired a second prelim. Now: held
        // until exit_strategy lands; generateBrokerResponse's existing ADDITIONAL
        // ITEMS prompt block asks for exit_strategy when missing.
        const hasExitStrategy = !!(result.updatedSummary?.exit_strategy && String(result.updatedSummary.exit_strategy).trim());
        // Group NNNN (S3.3/S3.4 residual gap): active-branch willReview gate
        // via pure helper. Post-NNNN includes !deal.prelim_approved_at
        // suppression so willReview cannot re-fire after admin approval —
        // post-approval doc-collection turns fall through to the
        // conversational handler (or completion-handoff when allDocsIn) instead
        // of triggering a spurious second prelim. See helper definition above
        // for INTENTIONAL ASYMMETRY note re: initial branch.
        const willReview = computeWillReview({
          deal: existingDeal,
          summary: result.updatedSummary,
          classifications: classificationsForGate,
          identityClashUnresolved,
        });

        // Group L: when the FINAL REVIEW HITL is about to fire (all docs in, no LTV gate
        // active, deal currently active), Vienna goes silent on the broker side. Per Franco:
        // "When all docs are in, Vienna should silently trigger the preliminary review to
        // admin and wait. No broker reply at this stage. The admin-approved closing draft
        // is the one and only broker-facing message."
        // Group SSS (Q1-SSS): bypass Claude's probabilistic result.allDocsReceived. JS
        // is authoritative — intake + compliance (AML/PEP) + exit_strategy gate, computed
        // from the same classifications that drive sendPreliminaryReviewToAdmin's [MISSING]
        // list.
        // Group CCCC (S6.1/S7.2): two-action dispatch via computeCompletionDispatch.
        // When deal.prelim_approved_at is set, route to sendCompletionHandoff (skip
        // FINAL REVIEW noise). When null, fall back to FINAL REVIEW as defense-in-depth.
        const completionDispatch = computeCompletionDispatch({
          deal: existingDeal,
          summary: result.updatedSummary,
          classifications: classificationsForGate,
          willGoToCollateralCheck,
          willReview,
          identityClashUnresolved,
        });
        const willFireFinalReview = completionDispatch === 'final-review';
        const willFireCompletionHandoff = completionDispatch === 'completion-handoff';

        if (ltv && ltv <= 80 && !hasReviewableDoc) {
          console.log('LTV ≤ 80% but no reviewable docs yet (no income_proof/NOA/appraisal) — keeping Vienna conversational');
        }

        // Send Vienna's conversational reply unless an admin HITL is about to fire —
        // in that case we suppress and let Franco's drafted reply be the next broker-
        // facing message. Group GGG (S14.3) extended this from FINAL REVIEW only to
        // also include PRELIMINARY review (willReview): pre-GGG, Vienna sent a "let me
        // know if you have questions, then I'll send for review" reply that contradicted
        // the prelim review which fired ~49s later. willGoToCollateralCheck is NOT
        // suppressed — that path uses Vienna's reply to deliver the collateral question
        // to the broker (Fix 7).
        if (result.responseEmail && !willFireFinalReview && !willReview && !willFireCompletionHandoff) {
          emailService.sendEmailDelayed(
            email.from,
            `Re: ${email.subject}`,
            result.responseEmail.replace(/<[^>]*>/g, ''),
            result.responseEmail,
            [],
            [],
            async (sendResult) => {
              await dealsService.saveMessage(existingDeal.id, 'outbound', `Re: ${email.subject}`, result.responseEmail, sendResult.MessageID);
              console.log('Conversational response sent to broker');
            }
          );
        } else if (willFireFinalReview || willReview || willFireCompletionHandoff) {
          const gateLabel = willFireCompletionHandoff
            ? 'COMPLETION HANDOFF (CCCC)'
            : willFireFinalReview ? 'FINAL REVIEW' : 'PRELIMINARY review';
          console.log(`Suppressing Vienna broker reply — ${gateLabel} firing to Franco; admin-drafted reply will be the next broker-facing message`);
        }
        if (willGoToCollateralCheck) {
          console.log('LTV gate active — Vienna replied conversationally AND routing deal to awaiting_collateral');
        } else if (willReview) {
          console.log('LTV gate active — Vienna reply suppressed AND sending PRELIMINARY review HITL to Franco');
        }

        if (willGoToCollateralCheck) {
          // Fix 7: high-LTV → awaiting_collateral state. No admin notification yet.
          // Vienna's reply (already sent above) carries the collateral question via
          // the high-LTV prompt block. Admin sees nothing until broker confirms
          // no-collateral (silent escalation) or offers collateral (resume active flow).
          await dealsService.update(existingDeal.id, { status: 'awaiting_collateral' });
          console.log('Deal status: awaiting_collateral (Fix 7 — collateral question pending)');
        } else if (willReview) {
          // Cluster D: pass result.responseEmail so the gate can detect a pending
          // broker clarification ask even when Vienna's reply is NNN-suppressed.
          await sendPreliminaryReviewToAdmin(existingDeal, result.updatedSummary, ownershipType, ltv, { brokerFacingReplyText: result.responseEmail || '' });
        } else {
          // Deal already under_review or no LTV yet — keep conversation going.
          // (We do NOT auto-flip to 'active' here anymore — awaiting_collateral, completed,
          // rejected, etc. should preserve their state.)
          if (!['active', 'under_review', 'awaiting_collateral', 'ltv_escalated', 'completed', 'rejected'].includes(existingDeal.status)) {
            await dealsService.update(existingDeal.id, { status: 'active' });
          }
          console.log('Conversation continues — waiting for more docs/info');
        }

        // Group CCCC (S6.1/S7.2): when prelim_approved_at is set on the deal,
        // skip the FINAL REVIEW step and fire the closing-draft handoff directly
        // (mirrors NNN under_review→completion-handoff and BBB conditions path).
        // The FINAL REVIEW block below stays as defense-in-depth (Q3-CCCC):
        // pre-CCCC deals or write failures land on null prelim_approved_at and
        // dispatch returns 'final-review' instead of 'completion-handoff'.
        if (willFireCompletionHandoff) {
          console.log('CCCC: prelim approved + all docs complete → closing handoff (non-conditions path)');
          const handoffDocs = await dealsService.getDocumentsWithText(existingDeal.id);
          const handoffMessages = await dealsService.getMessages(existingDeal.id);
          await sendCompletionHandoff(existingDeal, result.updatedSummary, handoffDocs, handoffMessages, email, {
            conditionsFulfilled: false,
          });
        }

        // ALL DOCS RECEIVED — send Franco a final complete review
        if (willFireFinalReview) {
          console.log('All documents received — sending final review to Franco');
          const finalDocs = await dealsService.getDocumentsWithText(existingDeal.id);
          const finalDocsList = await dealsService.getDocumentsByDeal(existingDeal.id);
          const finalClassifications = finalDocsList.map(d => d.classification).filter(Boolean);

          // Group SSS: final review's [MISSING] list checks intake + compliance.
          // When this path fires, computeWillFireFinalReview already gated on the
          // same set, so finalMissing should be empty in the normal path; the
          // array exists as a defensive belt for the rare case where doc inventory
          // shifted between the gate check and this point. Fix 4: NOA satisfies income_proof.
          const finalMissing = allRequiredForCompletion(isPurchaseFromSummary(result.updatedSummary))
            .filter(req => !isDocRequirementSatisfied(req, finalClassifications));

          const finalMessages = await dealsService.getMessages(existingDeal.id);
          const finalSummary = await aiService.generateLeadSummary(
            result.updatedSummary,
            ownershipType,
            finalDocs,
            finalMissing,
            finalMessages
          );

          let finalAttachments = [];
          if (finalDocs.length > 0) {
            const zipBase64 = await dealsService.downloadDocsAsZip(existingDeal.id, finalDocs);
            const safeName = (result.updatedSummary?.borrower_name || existingDeal.borrower_name || 'Unknown').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
            finalAttachments = [{
              Name: `${safeName}_Complete_Documents.zip`,
              Content: zipBase64,
              ContentType: 'application/zip',
            }];
          }

          const borrowerName = result.updatedSummary?.borrower_name || existingDeal.borrower_name;
          const finalReviewResult = await emailService.sendEmail(
            config.adminEmail,
            `FINAL REVIEW: All Documents Received — ${borrowerName}`,
            finalSummary.replace(/<[^>]*>/g, ''),
            finalSummary,
            finalAttachments
          );
          await dealsService.saveMessage(existingDeal.id, 'outbound', `FINAL REVIEW: All Documents Received — ${borrowerName}`, finalSummary, finalReviewResult.MessageID);
          await dealsService.update(existingDeal.id, { status: 'under_review' });
          console.log('Final review sent to Franco — deal status: under_review');
        }
      } else {
        console.log(`Deal status is ${existingDeal.status} — no action taken`);
      }
    }

  } catch (error) {
    console.error('Webhook error:', error);
  }
});

module.exports = router;
module.exports.__test__ = {
  sendEscalationToAdmin, sendPreliminaryReviewToAdmin, normalizeSenderName,
  isUnreliableName, firstNameMatchesAdmin, isDocRequirementSatisfied,
  DOC_SYNONYMS, ADMIN_FIRST_NAME, textToHtml, decideReviewDispatch,
  // Group SSS: tier constants + helpers
  BASE_REQUIRED_INTAKE_REFINANCE, BASE_REQUIRED_INTAKE_PURCHASE, COMPLIANCE_REQUIRED_POSTAPPROVAL,
  intakeRequiredFor, allRequiredForCompletion, isPurchaseFromSummary,
  computeCompletionDispatch,
  // Group YYY: preview-thread chain builder
  buildPreviewThreadChain,
  // Group VVV: deferred-intake form-skip predicate
  shouldSkipIntakeFormsForDeferredState,
  // Group DDDD: message pre-labeling for lead-summary / broker-response rendering
  labelMessagesForLeadSummary,
  // Group EEEE: intake_asked_items snapshot computation
  computeIntakeAskedItems,
  // Group JJJJ: misattached doc filter for prelim-review gate
  eligibleDocsForGate,
  // Group LLLL: broker-thread input extraction for executeDraft header construction
  buildBrokerThreadInputs,
  // Group NNNN: active-branch willReview gate with prelim_approved_at suppression
  computeWillReview,
  // Group OOOO: pre-approval enumeration of items blocking the willReview gate
  computeStillMissingForReview,
  // Group RRRR: admin decline-reason extraction with mandatory full-text fallback
  extractDeclineReason,
  // R4-Bucket-B (D-extension): admin banner trichotomy + isPostApproval gate
  computeAdminBanner,
};
