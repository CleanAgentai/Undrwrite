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
// R4-RESIDUAL-1: combined-LTV escalation gate uses the narrowest pure path —
// cFields.extractCanonicalFields + dEngine.computeCombinedLtv. Both are
// side-effect-free read-only helpers; no B-pipeline injection or admin-
// Snapshot side effect fires at the escalation-decision layer.
const cFields = require('../services/canonical-fields');
const bq = require('../services/borrower-qualification'); // FRANCO-Q3/Q4 multi-party qualification roster
// ADMIN-HANDOFF LINK-SUBMISSION (2026-05-20): pure detection of file-hosting
// links in inbound broker body. No URL fetching, no link-following.
const { detectFileHostingLinksInBody } = require('../lib/linkDetector');
const { selectGreetingFirstName } = require('../lib/greeting');

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
const shouldSkipIntakeFormsForDeferredState = (dealSummary, canonicalHighLtv) => {
  if (!dealSummary) return false;
  if (dealSummary.identity_clash) return true;
  // Bug 1 (2026-05-28): the high-LTV deferred state (awaiting_collateral) is the
  // ESCALATION outcome — so detect it via the canonical escalation decision the
  // caller computes (canonical standalone/combined), NOT dealSummary.ltv_percent
  // (the LLM computes that additively for refinances → a 56% refi was wrongly
  // treated as high-LTV deferred, skipping the broker's intake forms). Fallback
  // to the LLM value only when the caller hasn't threaded the canonical signal.
  if (canonicalHighLtv !== undefined) return !!canonicalHighLtv;
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
const computeIntakeAskedItems = (dealSummary, classificationsOnFile = [], canonicalHighLtv) => {
  const isBrokerPath = dealSummary?.sender_type === 'broker';
  if (!isBrokerPath) return null;
  // Deferred-intake states: Vienna's welcome asks ONE specific question, not
  // the doc list. No snapshot (cron falls back to baseRequired if the deal
  // ever reaches a state where reminders fire).
  if (dealSummary?.identity_clash) return null;
  // Bug 1 (2026-05-28): high-LTV deferred via the canonical escalation decision
  // (caller-computed), not dealSummary.ltv_percent (LLM additive-for-refi).
  const isHighLtv = (canonicalHighLtv !== undefined)
    ? !!canonicalHighLtv
    : !!(dealSummary?.ltv_percent && dealSummary.ltv_percent > 80);
  if (isHighLtv) return null;
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

// R6-ζ (2026-05-21): structured signal — did the broker reply since Vienna's
// last outbound on this deal? Used by both generateDocumentRequestEmail (the
// primary leak path on admin-approval-triggered turns: Kevin S6 178d714e +
// Ethan S7 533fbd4f production corpus) and generateBrokerResponse to gate
// the forbidden-non-sequitur-openers prompt block in ai.js.
//
// Semantic. Walk messages in REVERSE chronological order. First match wins:
//   - outbound (from Vienna)                      → return false (no broker
//                                                   reply since the last
//                                                   Vienna outbound)
//   - inbound that is NOT an admin reply (broker) → return true (broker DID
//                                                   reply since the last
//                                                   Vienna outbound)
// Admin-inbound messages (isAdminReplySubject) are SKIPPED in the walk — they
// don't count as broker replies. Empty history → false (conservative; no
// prior context, so suppress the thanks-for-reply opener).
//
// Asymmetry handling. The just-arrived inbound that triggered this turn is
// present in `messages` at compute time:
//   - At admin-approval sites the trigger is admin-inbound — skipped by
//     isAdminReplySubject; walk finds the previous Vienna outbound → false.
//   - At active/under_review sites the trigger is broker-inbound (or admin) —
//     broker case finds the just-arrived inbound and returns true; admin case
//     skips it and walks past to find the previous outbound → false.
// No explicit "exclude current turn" branch needed (Q1 verdict).
//
// Edge case (Q1 verdict, residual-flagged). Interleaved broker-clarification
// arcs (broker → Vienna → broker → Vienna → admin → new outbound) resolve
// correctly under the simple reverse-walk: the latest Vienna outbound
// precedes the admin reply and was already a reply to the broker's most
// recent inbound, so signal=false (no NEW reply since Vienna's last out).
// If a sequence ever lands where the broker's latest inbound is more recent
// than Vienna's latest outbound but interleaved with admin replies, the
// helper returns true — Vienna's response can legitimately reference that
// pending broker turn. Rare; defensible.
const brokerRepliedSinceLastViennaOutbound = (messages) => {
  const msgs = messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.direction === 'outbound') return false;
    if (m.direction === 'inbound' && !isAdminReplySubject(m.subject)) return true;
    // inbound-from-admin: skip and continue walk.
  }
  return false; // empty / admin-only history — conservative default.
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
// ──────────────────────────────────────────────────────────────────────────
// R5 Cluster B Sub-root 2 (2026-05-21): discrepancy-resolution gate.
//
// Pre-B-2, the prelim trigger fires while a Vienna-detected discrepancy is
// pending broker confirmation. Two sites manifest the bug:
//   - Site A initial-submission gate (L1869): no discrepancy/clarification
//     check at all. Sandra Nathan (ffb4fa0c) + Sandra Jennifer (112b619a) +
//     Lena (8486bf8a) all premature-fire on msg[02] from this site.
//   - Site B active-branch via computeWillReview (L2393): QQQQ
//     summary?.unresolved_discrepancy gate is probabilistic (Vienna-LLM-set
//     flag, not reliable). Sandra Jennifer was POST-QQQQ — still premature.
//
// FIX: shouldHoldPrelimForDiscrepancy — OR-of-three structured predicate
// mirroring BBBB / JJJJ deterministic-signal pattern:
//   1. brokerFacingDiscrepancyCount > 0   (PRIMARY structured signal — from
//                                          canonical_map.discrepancy_set +
//                                          filterBrokerFacing, deterministic)
//   2. clarificationPending=true           (Cluster D signal — broker-facing
//                                          reply asks for clarification;
//                                          catches doc-vs-doc on non-canonical
//                                          fields like credit_scores, Lena's
//                                          case)
//   3. summary?.unresolved_discrepancy=true  (SECONDARY soft fallback — QQQQ
//                                          Vienna-flag, residual coverage
//                                          for novel-shape discrepancies the
//                                          structured signal missed)
//
// HOLD SEMANTICS: when held, deal stays status='active' (no flip to under_
// review). Vienna's broker-facing reply (which contains the clarification
// ask) still sends. Next broker turn re-evaluates. By construction, when the
// broker confirms → next turn's gate releases → prelim fires for the FIRST
// AND ONLY time → no [UPDATED] PRELIMINARY can fire (Bug 2 falls out as a
// side-effect of fixing Bug 1).
//
// Cross-cluster: B-1's aggregating canonical_map wrapper runs INSIDE
// sendPreliminaryReviewToAdmin at L702 — downstream of this gate. When B-2
// holds, sendPreliminaryReviewToAdmin doesn't run; canonical_map freshness
// is moot. When B-2 releases, the wrapper aggregates by then. No interaction
// risk. C.1's text-only-noop at decideReviewDispatch is on the under_review
// path — only reachable AFTER the first prelim fires. If B-2 holds the first
// prelim, status stays 'active' and decideReviewDispatch isn't called.
// Belt-and-suspenders if both apply: no double-suppression risk because the
// gates are on disjoint code paths.
// ──────────────────────────────────────────────────────────────────────────
const shouldHoldPrelimForDiscrepancy = ({ brokerFacingDiscrepancyCount, brokerFacingReplyText, summary }) => {
  const hasStructuredDiscrepancy = (brokerFacingDiscrepancyCount || 0) > 0;
  const clarificationPending = aiService.welcomeEmailIsAskingClarification(brokerFacingReplyText || '');
  const viennaFlaggedDiscrepancy = !!summary?.unresolved_discrepancy;
  return hasStructuredDiscrepancy || clarificationPending || viennaFlaggedDiscrepancy;
};

const computeWillReview = ({ deal, summary, classifications, identityClashUnresolved, standaloneLtv }) => {
  // Bug 1 (2026-05-28): prefer the caller-computed CANONICAL standalone LTV;
  // fall back to LLM summary.ltv_percent only when canonical is unavailable
  // (preserves any caller that doesn't yet thread it).
  const ltv = (standaloneLtv != null) ? standaloneLtv : summary?.ltv_percent;
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
const computeStillMissingForReview = ({ deal, summary, classifications, identityClashUnresolved, highLtv }) => {
  // Out-of-scope branches: different states own these flows.
  if (deal?.status !== 'active') return [];
  if (deal?.prelim_approved_at) return [];     // KKKK handles post-approval
  if (identityClashUnresolved) return [];      // HHH handles identity-clash re-ask

  // Bug 1 (2026-05-28): high-LTV routes through Fix 7's awaiting_collateral
  // (collateral question, not missing-docs ask) — detect via the caller's
  // CANONICAL escalation decision, not summary.ltv_percent (LLM additive-for-
  // refi). Fallback to LLM only when canonical signal not threaded.
  const isHighLtv = (highLtv !== undefined)
    ? !!highLtv
    : !!(summary?.ltv_percent && summary.ltv_percent > 80);
  if (isHighLtv) return [];

  const items = [];
  const hasReviewableDoc = ['income_proof', 'noa', 'appraisal'].some(c => (classifications || []).includes(c));
  const hasExitStrategy = !!(summary?.exit_strategy && String(summary.exit_strategy).trim());

  if (!ltv) items.push('a current property appraisal (so we can confirm LTV)');
  if (!hasReviewableDoc) items.push('a reviewable document (current appraisal, NOA, or proof of income)');
  if (!hasExitStrategy) items.push('exit strategy (how the borrower plans to repay or refinance out at maturity)');

  return items;
};

// R9-F (2026-05-26): pre-create intake classification + data-model gate —
// non-deal entry filter at deal-create boundary.
//
// Empirical root (scripts/r9zeta-corpus-grep.js — production corpus pull
// PERSISTENT from R4):
//   8 non-deal entries surfaced in 123-deal corpus:
//     "Westgate Aggravation owners" (company/junk)
//     "Franco Maione" × 2 (admin-as-borrower)
//     "King of Dates Corp" (junk company)
//     "Mateen Jannesar and Kochay Habibzai" (admin-direct co-borrowers)
//     "David Chen" (broker-persona — ambiguous)
//     "Mateen Jannesar and Kochay Habibzai / King of Dates Corp" (junk)
//     "Sarah Mitchell" (broker-persona — ambiguous)
//   Plus: "Postmark Team" × 2 (system-sender emails treated as deals)
//
// 3rd architectural template family established this session:
//   (1) Canonical-map source-hierarchy enforcement (R6-γ + R6-α + R9-B + R9-D)
//   (2) State-derived gate signal (R6-κ + R6-ζ + R5-D Surface A + R9-A')
//   (3) Pre-create intake classification + data-model gate (R9-F — new this
//       cycle). Operates BEFORE LLM/prompt machinery fires; data-model
//       layer; filters non-deal entries at deal-create boundary.
//
// Per Q1-(a) SPLIT + Q2-(a) ALERT-ADMIN-AND-SKIP + Q3-(a) FAIL-OPEN verdict:
//   Q1-(a) SPLIT: R9-F = intake-gate non-deal-entry filter (this cycle).
//     R9-F' (borrower-identity dedup, sub-bugs 1+2) deferred to separate
//     cycle — architectural change, may need Supabase migration for
//     canonical_borrower_identity column (R6-κ aml_pep_requested_at
//     precedent).
//   Q2-(a) ALERT-ADMIN-AND-SKIP: on reject, send admin alert email
//     (Group ZZZ defensive-alert precedent) + skip deal-create. Preserves
//     Franco visibility for review-and-override on misfire.
//   Q3-(a) FAIL-OPEN: ambiguous cases default to accept. Conservative
//     "never silently drop legitimate broker submission" discipline.
//     Mis-accepting non-deal = low cost (manual cleanup via daily summary);
//     mis-rejecting legitimate broker = high cost (lost business signal).
//
// Reject categories (CLEAR-reject only, per fail-open):
//   'reject:admin-as-borrower' — borrower_name first-token === ADMIN_FIRST_NAME
//     AND no broker_name (broker-set submission for legitimately-named-Franco
//     borrower remains acceptable). Defensive guard against Franco-as-borrower
//     mock-test entries.
//   'reject:system-sender' — borrower_name matches known system-sender shape
//     (Postmark Team, Mailer-Daemon, noreply, etc.). System notification
//     emails should never create deal records.
//   'reject:no-human-name' — borrower_name contains org-suffix (Corp/Inc/Ltd/
//     LLC/Owners/Company/Holdings/Partners) AND lacks two-adjacent-title-case-
//     tokens (no plausible "First Last" human name). "King of Dates Corp" /
//     "Westgate Aggravation owners" reject; "John Smith Holdings" accepts
//     (real borrower with org-suffix in name).
//
// Ambiguous cases (David Chen / Sarah Mitchell / Mateen-and-Kochay variants /
// broker-persona-names) DEFAULT TO ACCEPT per Q3 fail-open. Admin reviews
// via existing daily summary if real misfire surfaces. R9-F handles only
// the CLEAR-reject categories empirically grounded.
const classifyIntakeBorrower = (input, opts = {}) => {
  // Defensive: null/undefined/non-object input → fail-open accept (Q3).
  if (!input || typeof input !== 'object') return 'accept';
  const { borrower_name, broker_name } = input;
  if (!borrower_name || typeof borrower_name !== 'string') return 'accept';  // fail-open on missing data
  const trimmed = borrower_name.trim();
  if (!trimmed) return 'accept';

  // R10-A (2026-05-26): body-aware classifier signal computed up-front; reused
  // in admin-as-borrower + no-human-name override branches below. opts.emailBody
  // is the broker email body (email.textBody at webhook call site); when null/
  // undefined, no override path fires (preserves pre-R10-A behavior for any
  // legacy single-arg callers). R10-B (2026-05-27) replaced the direct R8-A
  // parseBrokerFirstNameFromSignature call with the parseBrokerFirstName
  // resolver-chain wrapper: body-prose self-ID ("My name is X from Y") is
  // PRIMARY (canonical Round-6 fixture shape across all 4 brokers); signature
  // anchor (Lic. # marker) is FALLBACK for non-canonical bodies. Returns null
  // when no broker signal OR when first-token is "franco" / common-word /
  // company-suffix-shaped (filters in shared _validateBrokerFirstNameCapture).
  // Non-null return = high-confidence broker self-identification → structurally
  // invalidates admin-as-borrower / no-human-name false-positive class.
  const _r10aBodySignal = opts.emailBody
    ? aiService.parseBrokerFirstName(opts.emailBody)
    : null;

  // 1. admin-as-borrower: first-token matches ADMIN_FIRST_NAME ("Franco") + no broker_name set.
  //    The no-broker-set guard is the discriminator that lets a legitimate
  //    broker-submitted "Franco Vieanna" borrower through (broker_name would
  //    be the broker's name, not Franco). Franco-as-borrower-with-no-broker
  //    is the empirical mock-test pattern (6870b225 + 617f1626 fixtures).
  const firstToken = trimmed.split(/\s+/)[0];
  if (firstToken && firstToken.toLowerCase() === ADMIN_FIRST_NAME.toLowerCase()) {
    if (!broker_name || !String(broker_name).trim()) {
      // R10-A (2026-05-26): body-signal override. Donna Blackwood / Jerome Osei
      // Round-6 fixtures had Postmark From-Name="Franco Maione" (broker Gmail
      // display-name artifact) + body=("I'm Donna Blackwood from Pemberton
      // Lending Inc. Lic. #MB668374"). _r10aBodySignal returns non-null when
      // body carries broker Lic. # signature (R8-A pure helper, admin-name
      // filter built in). Non-null = structural invalidation of admin-as-
      // borrower false-positive; override to accept.
      if (_r10aBodySignal) {
        console.log(`R10-A: body-signal override fired (admin-as-borrower → accept); body identifies broker as "${_r10aBodySignal}"`);
        return 'accept';
      }
      return 'reject:admin-as-borrower';
    }
    // broker_name set — could be legitimately-named-Franco borrower submitted
    // by another broker. Per Q3 fail-open: accept; admin reviews if misfire.
  }

  // 2. system-sender: known system patterns appearing as borrower (Postmark
  //    Team × 2 fixtures; defensive against other notification-source emails).
  const systemSenderPatterns = [
    /^postmark team$/i,
    /^postmark$/i,
    /^mailer.?daemon$/i,
    /^noreply$/i,
    /^no.?reply$/i,
    /^do.?not.?reply$/i,
    /^support team$/i,
    /^notification(?:s)?$/i,
  ];
  for (const re of systemSenderPatterns) {
    if (re.test(trimmed)) return 'reject:system-sender';
  }

  // 3. no-human-name: org-suffix present AND pre-org-portion does not START
  //    with two-adjacent-title-case-tokens (no plausible "First Last" human
  //    name at the start of the borrower_name string). The "start with
  //    adjacent title-case" rule rejects phrase-shape names like "King of
  //    Dates Corp" (lowercase "of" breaks adjacency at start) while
  //    accepting legit shapes like "John Smith Holdings" (preserves real
  //    borrowers with org-suffix in name).
  //
  //    Ambiguous shapes like "Westgate Aggravation owners" — two title-case
  //    tokens at start but not actually human names — fall on the accept
  //    side per Q3 fail-open. Admin reviews via existing daily summary if
  //    misfire; classifier surface-bounded to CLEAR rejects only.
  //
  //    "Mateen Jannesar and Kochay Habibzai / King of Dates Corp" → preOrg=
  //    "Mateen Jannesar and Kochay Habibzai /" → starts with "Mateen
  //    Jannesar" (adjacent title-case) → accept (legit co-borrower shape
  //    with junky company suffix).
  const orgSuffixMatch = trimmed.match(/\b(Corp\.?|Inc\.?|Ltd\.?|LLC|LLP|Owners|Tenants|Residents|Company|Co\.?|Holdings|Partners)\b/i);
  if (orgSuffixMatch) {
    const preOrgPortion = trimmed.slice(0, orgSuffixMatch.index).trim();
    // Two-adjacent-title-case-tokens AT START of pre-org-portion. Phrase-
    // pattern names with lowercase connectors ("King of Dates") fail this.
    const humanNameAtStartRe = /^[A-Z][a-z]+\s+[A-Z][a-z]+\b/;
    if (!humanNameAtStartRe.test(preOrgPortion)) {
      // R10-A (2026-05-26): body-signal override (symmetric with admin-as-
      // borrower branch above). Body-signal non-null = broker is identifying
      // themselves via Lic. # signature → structural invalidation of no-
      // human-name false-positive. Same _r10aBodySignal computed above.
      if (_r10aBodySignal) {
        console.log(`R10-A: body-signal override fired (no-human-name → accept); body identifies broker as "${_r10aBodySignal}"`);
        return 'accept';
      }
      return 'reject:no-human-name';
    }
  }

  return 'accept';
};

// R9-F' (2026-05-26): admin-handoff email for potential-duplicate detection.
// Sibling mechanism to R9-F classifyIntakeBorrower at the same pre-create
// data-model boundary. Same alert-admin-and-skip semantics; same Group ZZZ
// admin-handoff precedent.
//
// Q3 verdict: cost-asymmetry — false-positive dedup (rejecting legitimate
// submission via auto-link) > false-negative dedup (admin manually consolidates).
// Therefore: send admin a side-by-side comparison of NEW SUBMISSION vs
// EXISTING DEAL; admin manually decides link-vs-create.
//
// Content discipline (R9-F'-ADMIN-ALERT-CONTENT-ANCHORS verification group):
// each anchor is load-bearing for admin's link-vs-create decision. Removing
// any anchor in future "simplification" silently weakens triage capability.
const sendDuplicateAlertToAdmin = async (newEmail, existingDeal, newExtracted, reason) => {
  const newBorrowerName = newEmail.fromName || '(unknown)';
  const newBrokerEmail = newEmail.from;
  const newProperty = newExtracted?.subject_property_address
    || newExtracted?.property_address
    || '(no property extracted from email body)';
  const existingProperty = existingDeal.extracted_data?.subject_property_address
    || existingDeal.extracted_data?.property_address
    || '(no property on record)';
  const subject = `[Potential Duplicate] ${newBorrowerName} — ${newBrokerEmail}`;
  const body = `Vienna detected a potential duplicate submission and did not create a new deal.

Reason classification: ${reason}

NEW SUBMISSION
  Borrower name:    ${newBorrowerName}
  Broker email:     ${newBrokerEmail}
  Property address: ${newProperty}
  Subject:          ${newEmail.subject || '(empty)'}
  Postmark MID:     ${newEmail.messageId}

EXISTING DEAL
  Deal ID:          ${existingDeal.id}
  Status:           ${existingDeal.status}
  Created at:       ${existingDeal.created_at}
  Property address: ${existingProperty}
  Borrower (DB):    ${existingDeal.borrower_name || '(none)'}

DECISION PROMPT
  To link these deals, reply to the existing-deal thread (deal ${existingDeal.id}) and forward the new submission's content/docs into that thread.
  If this is a new deal (different transaction), please reply directly to ${newBrokerEmail} and ask the broker to resubmit — Vienna will create a new record on the re-submission.

(This alert is automatic — R9-F' borrower-identity dedup, alert-admin-and-skip semantics per Q3 verdict. Carve-outs honored: different property (FSA+street# differs) → new deal proceeds; refinance after >90 days terminal → new deal proceeds; property missing in either side → Q3a fail-open new deal proceeds. Match reasons: property_match_active = same property + non-terminal deal on file; property_match_recent_terminal = same property + terminal deal closed <90 days ago.)`;

  await emailService.sendEmail(
    config.adminEmail,
    subject,
    body,
    null,
    [],
    []
  );
};

// R10-A (2026-05-26): broker acknowledgment on classifier-reject categories
// where false-positive risk is non-trivial (admin-as-borrower / no-human-name).
// system-sender stays silent-drop (structurally impossible for legitimate
// broker submission to come from Postmark Team / mailer-daemon display name —
// see classifyIntakeBorrower system-sender branch).
//
// Q4-(a) generic-receipt content discipline: doesn't leak classifier decision;
// broker-friendly; admin alert (existing R9-F path, unchanged) carries full
// triage context for admin to override. Same content-anchor discipline as
// R9-D / R9-A' / R9-F / R9-F' precedents — load-bearing UX preserved by
// closed-set anchors in R10-A-ACK-CONTENT-ANCHORS verification group.
//
// Q7-(a) every-reject-sends-ack: no idempotency state tracking. Rejected
// submissions don't create deal records, so there's no DB state to query
// for "did this broker get an ack before?" Cost of occasional duplicate ack
// when broker re-submits is low; admin alert is the primary signal.
const sendBrokerAcknowledgmentOnReject = async (email) => {
  const subject = (email.subject || '').startsWith('Re:')
    ? email.subject
    : `Re: ${email.subject || 'Your submission'}`;
  const textBody = `Hi there!

We received your submission and are reviewing it. You'll hear back shortly.

Vienna
Private Mortgage Link`;
  await emailService.sendEmail(
    email.from,
    subject,
    textBody,
    null,
    [],
    []
  );
};

// R9-A' (2026-05-26): state-derived gate signal — post-approval AML/PEP pending
// receipt (broker may have claimed to attach but docs not yet in table).
//
// Empirical root (Derek df33cdbf retest, R9-A SPLIT-deferred cluster):
//   1. Admin "Approved" at msg #8 → prelim_approved_at stamped 04:25:56
//   2. R6-κ post-approval flow fires at msg #9 — Vienna draft preview asking
//      for AML/PEP → aml_pep_requested_at stamped 04:26:01
//   3. Broker msg #10 INBOUND 04:27: "Please find the AML and PEP forms
//      attached" — but NO AML/PEP rows landed in documents table
//      (Franco-testing-artifact inferred from Marcus parallel succeeding +
//      zero docs created at 04:27 timestamp + no archival raw payload)
//   4. computeCompletionDispatch returned null (allDocsIn=false) → active
//      branch conversational generateBrokerResponse fires
//   5. stillMissingForReview was empty (SSS scopes intake-only; AML/PEP
//      out of OOOO gate scope post-approval); STANDARD DOC CHECKLIST in
//      generateBrokerResponse prompt didn't include AML/PEP (JJJ scope);
//      L1858 forbidden-phrase block silent → Vienna emitted "we now have
//      everything we need for Derek's file and can proceed with our
//      review." (Franco S3-Bug-3 confirmed).
//
// Architectural family — state-derived gate signal (per Q1-(a) narrow scope):
//   Same architectural shape as R6-κ postApprovalAmlPepAsk + R6-ζ
//   brokerRepliedSinceLastViennaOutbound + R5-D Surface A structured
//   identity_clash signal + computeStillMissingForReview. JS-side derived
//   boolean from durable deal/state fields → conditional prompt-context
//   block. Structural > prompt content-matching (Franco's standing
//   direction; matches R5-D Surface A / R6-γ / R6-ζ / R6-α precedent).
//
// Q2-(a) PROMPT-SIDE ONLY verdict: this signal feeds a NEW prompt ban-block
// (ai.js generateBrokerResponse). JS post-gen strip deferred per Q2-(a) —
// prompt-first, sweep-on-empirical-failure (R8-B precedent: 3 months of
// prompt-only failure justified structural backstop; R9-A' has 1 empirical
// fixture + the LLM hasn't been TOLD to suppress this language yet).
//
// Q3-(a) BAN + ASK-TO-RESEND: prompt block forbids completion-shape phrases
// AND positively directs Vienna to acknowledge broker claim + ask to
// resend (attachment may not have come through).
//
// Semantic: TRUE when admin has approved (prelim_approved_at SET) AND
// AML/PEP was requested (aml_pep_requested_at SET) AND at least one of
// AML/PEP is NOT yet classified in the deal's documents.
//   - prelim_approved_at NULL → FALSE (pre-approval; AML/PEP not relevant)
//   - aml_pep_requested_at NULL → FALSE (request not yet sent; covered by
//     R6-κ's postApprovalAmlPepAsk family — Vienna asks via that path)
//   - Both AML AND PEP on file → FALSE (received-and-classified; signal
//     would over-fire on legitimate completion-shape language)
//
// Pure-function shape for harness testability + matches the family precedent
// (computeStillMissingForReview, computeWillReview, brokerRepliedSinceLast
// ViennaOutbound) — exported via __test__.
const isPostApprovalAmlPepPending = (deal, classifications) => {
  if (!deal || !deal.prelim_approved_at) return false;
  if (!deal.aml_pep_requested_at) return false;
  const cls = Array.isArray(classifications) ? classifications : [];
  const amlOnFile = cls.includes('aml');
  const pepOnFile = cls.includes('pep');
  return !amlOnFile || !pepOnFile;
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

// R7-A (2026-05-22): Franco S14-Bug-1 fix. Pre-R7-A, when `prelim_approved_at`
// was null (no prior admin approval) AND all docs were in AND willReview
// gate held (e.g., on unresolved_discrepancy), this returned 'final-review'
// — firing the FINAL REVIEW dispatcher with "FILE STATUS: COMPLETE" banner
// on the FIRST admin-facing review. Production fixture: Lena Park 4850dc32
// (Carlos Mendez / Pinnacle Mortgage Solutions Lic. #MB339885) — Vienna
// dispatched "FINAL REVIEW: All Documents Received — Lena Ji-Young Park"
// with banner "FILE STATUS: COMPLETE — Ready for Review" when admin had
// never approved.
//
// Franco's rule (load-bearing):
//   • PRELIMINARY = first admin-facing review, ALWAYS, regardless of doc
//     count.
//   • COMPLETE/handoff = only after admin has previously approved (i.e.,
//     prelim_approved_at is stamped) AND all conditions fulfilled.
//   • Doc-completeness is NOT a template-selection signal.
//
// Fix shape (Mechanism A1 — strict-superset additive widening per Q1):
// when prelim_approved_at=null, return 'preliminary-all-docs-in' instead
// of 'final-review'. The consumer (active-branch dispatcher in webhook.js)
// handles 'preliminary-all-docs-in' by firing sendPreliminaryReviewToAdmin
// (the same dispatcher as the regular willReview path) — admin sees a
// PRELIMINARY review with the JS-injected computeAdminBanner-authoritative
// banner.
//
// Legacy 'final-review' dispatch is retained as DEAD-CODE under A1 — only
// theoretically reachable via pre-CCCC defense-in-depth write-failure
// recovery (vanishingly rare and arguably unreachable). See annotation at
// the FINAL REVIEW dispatcher consumer block.
//
// R10-F (2026-05-27) — ASYMMETRIC-GATE EMPIRICAL DISCIPLINE. Patricia Simmons
// deal a0caddfb (Bug 5-3): mortgage_position discrepancy (1st-via-email vs
// 2nd-via-loan-app + derived-balance) detected at msg[2] all-docs-in turn.
// Initial-submission gate at L2894-2911 correctly held under discrepancy
// (R5-B-2 wired the gate there); active-branch gate at L3637-3646 wired
// _b2HoldActive ONLY into willReview (one of TWO prelim-trigger paths).
// 'preliminary-all-docs-in' R7-A dispatch (this function's all-docs branch)
// was the orthogonal trigger NOT covered by the gate — when allDocsIn=true
// + hasExitStrategy=true, R7-A dispatch returned 'preliminary-all-docs-in'
// regardless of discrepancy state, broker reply was suppressed at L3689,
// PRELIM fired to admin, broker never asked. R10-F closes by adding the
// discrepancyHold parameter (gate symmetry across both trigger paths).
//
// 2nd template family (state-derived gate signal) — NEW sub-pattern of
// trigger-path-coverage extension (vs the prior sub-pattern of new state
// flag). Lineage: BBBB, JJJJ, SSS + R10-F. Defining shape preserved:
// pre-computed JS signal + threaded through gate predicate + short-circuit
// return null on hold. R10-F's sub-pattern innovation: extending coverage
// of an EXISTING gate signal to a previously-uncovered trigger path.
//
// DEFERRED RESIDUAL (per R10-D code-docblock discipline) — Under_review path
// parallel-gate symmetry: decideReviewDispatch at L3221 has its own dispatch
// logic for the under_review state. R10-F empirical-grounding did NOT
// surface a production fixture where the under_review path fires prelim
// with brokerFacingDiscrepancyCount > 0. Closure condition: trigger when
// empirical fixture surfaces under_review path firing prelim/completion-
// handoff with brokerFacingDiscrepancyCount > 0 → audit decideReviewDispatch
// for parallel-gate symmetry.
//
// BACKWARDS-COMPAT — discrepancyHold defaults to undefined → falsy → no
// behavior change at any legacy call site that doesn't pass the parameter.
const computeCompletionDispatch = ({ deal, summary, classifications, willGoToCollateralCheck, willReview, identityClashUnresolved, discrepancyHold }) => {
  if (deal?.status !== 'active') return null;
  if (willGoToCollateralCheck || willReview || identityClashUnresolved || discrepancyHold) return null;
  const required = allRequiredForCompletion(isPurchaseFromSummary(summary));
  const allDocsIn = required.every(req => isDocRequirementSatisfied(req, classifications || []));
  const hasExitStrategy = !!summary?.exit_strategy;
  if (!(allDocsIn && hasExitStrategy)) return null;
  return deal.prelim_approved_at ? 'completion-handoff' : 'preliminary-all-docs-in';
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
  // R4-Bucket-C.4 (S4 Ryan): compute combined LTV from B's canonical-fields BEFORE
  // generateEscalationNotification, then post-Claude prepend a JS-rendered callout
  // when applicable. Same pattern as B 2b's Deal Snapshot prepend — pure JS, no
  // prompt-instruction hallucination surface. Pre-C.4: escalation email rendered
  // standard LTV (Vienna's ltv_percent = new_loan/appraised) only — for a 2nd-mortgage
  // deal with a $385K existing first, the surfaced 83% misrepresented the actual
  // 153% leverage.
  const _c4InboundForCanonical = dealMessages.find(m => m.direction === 'inbound');
  const _c4Detect = _c4InboundForCanonical ? dEngine.runDiscrepancyDetection(
    _c4InboundForCanonical.body || '',
    dealDocs.map(d => ({ file_name: d.file_name, classification: d.classification, text: d?.extracted_data?.text || '' })),
    escalationBrokerName,
    { emailSubject: _c4InboundForCanonical.subject || '' }
  ) : null;
  const _c4Combined = _c4Detect ? dEngine.computeCombinedLtv(_c4Detect.canonical_map) : null;
  let escalationEmail = await aiService.generateEscalationNotification(dealSummary, labeledEscalationMessages, dealDocs);
  if (_c4Combined) {
    const c = _c4Combined.components;
    const lenderTag = c.existing_lender ? `${c.existing_lender} ` : '';
    const fmt = (n) => '$' + Number(n).toLocaleString('en-US');
    const calloutHtml = `<p><strong>Combined LTV (incl. existing 1st):</strong> ${_c4Combined.combined_ltv_percent}% — (${lenderTag}${fmt(c.existing)} + ${fmt(c.requested)}) / ${fmt(c.market)}. <em>The standard ${ltv}% LTV figure below reflects the new loan only; combined LTV is the leverage figure for second-mortgage deals.</em></p>\n`;
    escalationEmail = calloutHtml + escalationEmail;
    console.log(`C.4: prepended Combined LTV callout (${_c4Combined.combined_ltv_percent}%) to escalation email`);
  }

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

// R9-B (2026-05-26): canonical LTV resolver for preliminary review surfaces
// (subject line + generateLeadSummary prompt override). Wraps dEngine's
// computeCombinedLtv with a standalone fallback so the canonical LTV is
// always computed JS-side from canonical_map (not the LLM's ltv_percent
// extraction).
//
// Empirical root (Marcus S2 996a676c + Derek S3 df33cdbf retest):
//   Marcus extracted_data.ltv_percent=72.8 (LLM) vs JS canonical 60.7%
//     ($318k + $95k) / $680k. LLM picked existing=$400k from RBC payout
//     statement; JS canonical_map picked existing=$318k per source-
//     hierarchy in existing_first_mortgage_balance.
//   Derek extracted_data.ltv_percent=62.4 (LLM) vs JS canonical 61.8%
//     ($341k + $110k) / $730k. Same root mechanism.
//
// Per Q1 (a) NARROW + Q2 (a) COMBINED PREFERRED, STANDALONE FALLBACK
// + Q3 (a) FULL EXPANSION verdict:
//   - combined LTV preferred when computable (2nd mortgage, existing
//     balance + loan + market all present in canonical_map)
//   - standalone fallback (loan / market * 100) when combined null
//     (1st mortgage / clean first-mortgage shape — existing_first_
//     mortgage_balance absent per dEngine.computeCombinedLtv null return)
//   - return null when neither computable (defensive — caller falls back
//     to LLM-derived ltv arg, preserving pre-R9-B behavior on out-of-
//     scope shapes)
//
// Defended residual NOT in R9-B scope: the upstream source-divergence root
// in existing_first_mortgage_balance canonical_map (RBC payout vs loan-app/
// email-body source-hierarchy selection). R9-B treats JS canonical as
// authoritative output per orchestrator framing; ratifying upstream source
// selection is a separate cycle (R9-B-prime) if Franco surfaces.
const computeCanonicalLtvForReview = (canonicalMap) => {
  const combined = dEngine.computeCombinedLtv(canonicalMap);
  if (combined) {
    return {
      value: combined.combined_ltv_percent,
      kind: 'combined',
      components: combined.components,
    };
  }
  // Standalone fallback — loan / market * 100. Captures 1st-mortgage clean
  // deals where existing_first_mortgage_balance is empty (Linda Okafor-shape
  // per dEngine.computeCombinedLtv docblock).
  const loans = (canonicalMap && canonicalMap.requested_loan_amount) || [];
  const values = (canonicalMap && canonicalMap.subject_property_market_value) || [];
  if (loans.length === 0 || values.length === 0) return null;
  const requested = loans[0].value;
  const market = values[0].value;
  if (!Number.isFinite(requested) || !Number.isFinite(market) || market <= 0) return null;
  const ltv = Math.round((requested / market) * 100 * 10) / 10;
  return {
    value: ltv,
    kind: 'standalone',
    components: { requested, market },
  };
};

// R9-D (2026-05-26): canonical existing-mortgage lender resolver for the
// generateLeadSummary Exit Strategy narrative override block. Same
// architectural shape as R9-B's computeCanonicalLtvForReview — wraps
// canonical_map at the consumer boundary; reads from the FILTERED
// canonical_map (R6-γ filterCanonicalLenderForPayoutOnly already applied
// upstream) so the lender attribution is mortgage_statement-sourced only.
//
// Empirical root (Marcus S2 996a676c retest):
//   Document corpus scan: Scotiabank appears 13+ times across loan_application
//   + PNW + credit_bureau (HISTORICAL — broker had Scotiabank mortgage, has
//   since refinanced to RBC); RBC only in payout statement (4 mentions) + email
//   body (broker stated). Vienna's preliminary review Exit Strategy section
//   emitted "his current Scotiabank mortgage matures in October 2027" —
//   majority-document-weight hallucination absent explicit source-hierarchy
//   instruction at the narrative-prompt input. R6-γ filter is correctly
//   applied at Deal Snapshot consumer boundary but generateLeadSummary's
//   prompt context feeds raw dealSummary + raw document texts to Claude.
//
// 4th cycle on canonical-map source-hierarchy enforcement architectural
// template (carry-forward principle):
//   R6-γ: filter lender at canonical_map consumer boundary (Deal Snapshot)
//   R6-α: filter requested_loan_amount source-hierarchy at canonical_map consumer
//   R9-B: DETERMINISTIC LTV override at narrative-prompt input (consumer-side
//         filter + prompt block both consume the FILTERED canonical_map for
//         no-drift)
//   R9-D: DETERMINISTIC lender override at narrative-prompt input (this commit)
//
// Per Q1-(a) NARROW + Q2-(a) FULL ANTI-SOURCE + Q3-(a) PRESERVE UUU FLAGGING
// CARVE-OUT verdict:
//   - returns { value: 'RBC', source: <payout filename> } when filtered
//     canonical_map has mortgage_statement-sourced lender tuple
//   - returns null when no payout-statement-sourced lender (1st mortgage
//     clean deal / no existing mortgage / R6-γ-stripped all non-payout)
//   - downstream prompt block conditionally injected; null → no block,
//     pre-R9-D LLM behavior preserved on out-of-scope shapes
//   - UUU cross-source discrepancy detection is PRESERVED (Q3-(a) carve-out
//     in block content); R9-D enforces OUTPUT discipline on factual lender
//     statements, not DETECTION discipline on discrepancy flagging
const computeCanonicalLenderForReview = (canonicalMap) => {
  const tuples = (canonicalMap && canonicalMap.existing_first_mortgage_lender) || [];
  if (tuples.length === 0) return null;
  // R6-γ filter has already stripped non-mortgage_statement-sourced tuples
  // at the caller boundary (_bFilteredCanonicalMap). Take the first tuple's
  // value. If multiple payout statements exist for the same deal (rare —
  // refinance-in-flight), the canonical-map tuple-ordering reflects extract
  // order; first wins (same semantic as R9-B canonical LTV resolver +
  // R6-γ rendering).
  const first = tuples.find(t => t && t.value);
  if (!first) return null;
  return {
    value: first.value,
    source: first.source || null,
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
  //
  // R5-B-1 (2026-05-21): runDiscrepancyDetectionAggregated walks ALL inbound
  // messages (msg[0..N]) and quote-strips each before feeding canonical_map.
  // Pre-B-1 this site used msg[0].body only — broker corrections in turn 2+
  // (Grace 6838e1cf msg[2] loan/value/position correction) were lost from the
  // admin Snapshot. F3 quote-strip-only resolution (latest-non-empty wins)
  // prevents the admin-reply-with-quoted-Vienna leakage that naive aggregation
  // would have produced. See discrepancy-engine.js header for F3's known
  // limitation (substantive admin-typed inline content not currently filtered).
  const _bInboundMessages = dealMessages.filter(m => m.direction === 'inbound');
  const _bDetectAdmin = dEngine.runDiscrepancyDetectionAggregated(
    _bInboundMessages,
    dealDocs.map(d => ({ file_name: d.file_name, classification: d.classification, text: d?.extracted_data?.text || '' })),
    leadSummaryBrokerName,
    { emailSubject: _bInboundMessages[0]?.subject || '' }
  );
  // R6-γ (2026-05-21): strip lender attribution from non-payout-statement
  // sources before consumer-side rendering. canonical_map remains intact for
  // audit / discrepancy compute upstream.
  // R6-α (2026-05-21): composed outside R6-γ — strip email_body
  // requested_loan_amount tuples when loan_application is on file. Derek S3
  // dce308c8 source-mis-attribution-inversion fix.
  // R9-B (2026-05-26): extract the filtered canonical_map so the canonical
  // LTV computed below uses IDENTICAL source-hierarchy to what the Deal
  // Snapshot displays — no drift between Snapshot "Combined LTV" row and
  // subject-line / narrative override.
  // R10-E (2026-05-27): filter chain composes by field; ordering is by
  // introduction cycle (R6-γ first innermost, R10-E last outermost) for
  // reading-order parity with cycle history. Filters are commutative since
  // each operates on a distinct field; ordering is purely a readability
  // convention. Per-field source-hierarchy: R6-γ (lender, OBJECTIVE),
  // R6-α (loan_amount, INTENT post-R10-G), R10-G (purpose, INTENT),
  // R10-E (mortgage_position, OBJECTIVE).
  const _bFilteredCanonicalMap = dEngine.filterCanonicalMortgagePositionForObjectiveAuthoritative(
    dEngine.filterCanonicalPurposeForBrokerAuthoritative(
      dEngine.filterCanonicalLoanAmountForDocAuthoritative(
        dEngine.filterCanonicalLenderForPayoutOnly(_bDetectAdmin.canonical_map)
      )
    )
  );
  // FRANCO-Q3/Q4 (2026-05-28): multi-party qualification roster — deterministic
  // who-counts determination feeding the Snapshot disposition rows + the
  // generateLeadSummary aggregation directive below.
  const _q3Roster = bq.buildQualificationRoster({
    detectedBorrowers: _bDetectAdmin.joint_multi_borrower,
    primaryName: dealSummary?.borrower_name || leadSummaryBrokerName || null,
  });
  const _bSnapshotHtml = dEngine.renderDealSnapshot(
    _bFilteredCanonicalMap,
    {
      ownershipType,
      isCommercial: !!_bDetectAdmin.commercial,
      jointBorrowers: _bDetectAdmin.joint_multi_borrower, // FRANCO-PREDICTED-Q8
      qualificationRoster: _q3Roster,                     // FRANCO-Q3/Q4
    }
  );

  // R9-B (2026-05-26): canonical LTV for subject-line override + prompt
  // override block. Combined LTV preferred (Q2-(a)); standalone fallback
  // when combined null (1st-mortgage clean deal). When BOTH null
  // (incomplete extraction defensive case), the subject falls back to the
  // LLM-derived `ltv` arg per pre-R9-B behavior (defense-in-depth — never
  // emit a blank LTV in the subject; out-of-scope shapes preserved).
  const _r9bCanonicalLtv = computeCanonicalLtvForReview(_bFilteredCanonicalMap);

  // R9-D (2026-05-26): canonical existing-mortgage lender for Exit Strategy
  // narrative override block. Reads from the same FILTERED canonical_map as
  // R9-B (R6-γ filter applied upstream); no drift between Deal Snapshot
  // lender attribution and Exit Strategy lender claim.
  const _r9dCanonicalLender = computeCanonicalLenderForReview(_bFilteredCanonicalMap);

  // R10-G (2026-05-27): broker-corrections override block. Reads
  // requested_loan_amount + purpose canonical tuples from filtered map;
  // selects broker_correction > broker_initial_intent > docs source per
  // intent-field hierarchy. Override block (in generateLeadSummary) injects
  // anti-source + anti-phrasing instructions when broker source present.
  const _r10gLoanAmount = cFields.resolveCanonicalIntentValue(_bFilteredCanonicalMap, 'requested_loan_amount');
  const _r10gPurpose = cFields.resolveCanonicalIntentValue(_bFilteredCanonicalMap, 'purpose');
  const _r10gIsBrokerSourceForAmount = _r10gLoanAmount && (_r10gLoanAmount.source === 'broker_correction' || _r10gLoanAmount.source === 'broker_initial_intent');
  const _r10gIsBrokerSourceForPurpose = _r10gPurpose && (_r10gPurpose.source === 'broker_correction' || _r10gPurpose.source === 'broker_initial_intent');
  const _r10gCanonicalCorrections = (_r10gIsBrokerSourceForAmount || _r10gIsBrokerSourceForPurpose)
    ? {
        loanAmount: _r10gIsBrokerSourceForAmount ? _r10gLoanAmount : null,
        purpose: _r10gIsBrokerSourceForPurpose ? _r10gPurpose : null,
      }
    : null;

  // R11-B-1 Layer 2 (2026-05-27): LLM-prompt-context consumer-side filter.
  // Sanitize loan_application doc text (strip [Page N annotation] markers)
  // when canonical_map has broker-authoritative source for requested_loan_
  // amount. Closes empirically-close-loop discipline (15th methodology
  // carry-forward): Marcus Bug 2 surfaced in admin-facing prelim narrative
  // even though R10-G machinery correctly filtered loan_app from Snapshot.
  // Root cause: Vienna's LLM read loan_app doc text directly at
  // ai.js:3103 docSections + emitted "$95k from loan_application" + 7
  // Scotiabank misattributions from AcroForm annotation markers in the
  // blank Union Lending template. Layer 2 sanitization closes the LLM-
  // prompt-context surface — sibling to Snapshot-renderer consumer filter
  // (R6-γ + R10-E + R10-G). NEW SUB-PATTERN within 1st template family.
  //
  // Conditional sanitization preserves R10-E Patricia parity — annotations
  // only stripped when broker source is authoritative (signals template-
  // default vs broker-filled).
  const _r11bSanitizedDealDocs = cFields.sanitizeLoanAppDocTextForLLM(dealDocs, _bDetectAdmin.canonical_map);
  let leadSummary = await aiService.generateLeadSummary(
    dealSummary,
    ownershipType,
    _r11bSanitizedDealDocs,
    missingDocs,
    labeledMessages,
    {
      noSnapshot: true,
      canonicalLtvOverride: _r9bCanonicalLtv,
      canonicalLenderOverride: _r9dCanonicalLender,
      canonicalCorrectionsOverride: _r10gCanonicalCorrections,
      multiPartyQualificationOverride: _q3Roster.aggregationDirective, // FRANCO-Q3/Q4
    }
  );
  // Post-Claude: strip any residual Vienna-emitted Snapshot block + prepend the JS canonical Snapshot.
  const _snapStrip = aiService.stripVienna_DealSnapshot(leadSummary);
  leadSummary = aiService.prependDealSnapshot(_snapStrip.stripped, _bSnapshotHtml);
  if (_snapStrip.strippedAny) {
    console.log('B-2b (admin Snapshot): Vienna emitted a Snapshot block despite NO-SNAPSHOT instruction — backstop stripped it before prepending JS canonical.');
  }
  // R10-C-2 (2026-05-27): elevated-LTV-band Risk Factors callout. Closes
  // contract Schedule A Stage 1 75-80% manual-review band gap at MVP level.
  // Computes ltvBand from the same filtered canonical_map driving R9-B's
  // canonical LTV (no drift between Snapshot LTV row + callout band). Fires
  // only for 'elevated_75_80'; 'over_80' deals bypass this site entirely
  // (awaiting_collateral state); 'standard' deals fall through unchanged.
  //
  // STAGE-1 MANUAL-REVIEW SURFACE — MVP-level visibility for the admin
  // reviewer; no separate state machine or distinct admin-handoff template.
  // Deeper surface deferred (per R10-D code-docblock discipline) — closure
  // condition: production fixture surfaces need OR Franco product-design
  // call. Risk Factors callout is the JS-deterministic backstop matching
  // the broker-facing prompt-and-sweep language discipline pattern for
  // empirically-stubborn Claude surfaces.
  const _r10cPrelimMarketTuples = _bFilteredCanonicalMap.subject_property_market_value || [];
  const _r10cPrelimRequestedTuples = _bFilteredCanonicalMap.requested_loan_amount || [];
  const _r10cPrelimMarketVal = _r10cPrelimMarketTuples[0]?.value;
  const _r10cPrelimRequestedVal = _r10cPrelimRequestedTuples[0]?.value;
  const _r10cPrelimStandaloneLtv = (Number.isFinite(_r10cPrelimMarketVal) && _r10cPrelimMarketVal > 0
    && Number.isFinite(_r10cPrelimRequestedVal))
    ? Number(((_r10cPrelimRequestedVal / _r10cPrelimMarketVal) * 100).toFixed(1))
    : null;
  const _r10cPrelimCombined = dEngine.computeCombinedLtv(_bFilteredCanonicalMap);
  const _r10cPrelimCombinedLtv = _r10cPrelimCombined ? _r10cPrelimCombined.combined_ltv_percent : null;
  const _r10cPrelimBand = dEngine.computeLtvBand({
    standaloneLtv: _r10cPrelimStandaloneLtv,
    combinedLtv: _r10cPrelimCombinedLtv,
  });
  if (_r10cPrelimBand === 'elevated_75_80') {
    const _r10cPrelimEffectiveLtv = (_r10cPrelimCombinedLtv != null) ? _r10cPrelimCombinedLtv : _r10cPrelimStandaloneLtv;
    leadSummary = aiService.injectElevatedLtvBandCallout(leadSummary, _r10cPrelimBand, _r10cPrelimEffectiveLtv);
    console.log(`R10-C-2: elevated LTV band (${_r10cPrelimEffectiveLtv}%) — admin prelim callout injected (Schedule A Stage 1 manual-review band).`);
  }
  // R11-C (2026-05-27): postal-code discrepancy callout. Sibling to R10-C-2
  // — 2nd instance of JS-INJECTED ADMIN RISK FACTORS CALLOUT sub-pattern
  // within 1st template family. Closes Franco Round 7 Bug 4: postal-code
  // discrepancy was inlined into Property Address row pre-R11-C; now
  // surfaced via JS-deterministic Risk Factors callout (admin-visibility
  // guaranteed per empirically-close-loop discipline — 15th methodology
  // carry-forward). Marcus Webb 8c404ae0 empirical: Vienna's LLM-narrative
  // did NOT flag postal-code in Risk Factors (LLM probabilistic; flagged
  // lender/balance/loan-amount but NOT postal). JS-deterministic callout
  // guarantees admin visibility. Reads postal tuples from the SAME filtered
  // canonical_map driving Snapshot rendering (R6-γ + R10-E + R10-G + R11-B
  // filter chain) — no drift between Property Address row + callout source
  // attribution.
  const _r11cPostalTuples = _bFilteredCanonicalMap.subject_property_postal_code || [];
  const _r11cDistinctPostals = new Set(_r11cPostalTuples.map(t => t?.value).filter(Boolean));
  if (_r11cDistinctPostals.size > 1) {
    leadSummary = aiService.injectPostalCodeDiscrepancyCallout(leadSummary, _r11cPostalTuples);
    console.log(`R11-C: postal-code discrepancy (${Array.from(_r11cDistinctPostals).join(' / ')}) — admin prelim callout injected.`);
  }
  // R4-Bucket-C.6 (Grace 5f8e4921 T4 fix): strip Claude's Documents Included
  // section + inject JS-rendered authoritative one. Claude probabilistically
  // dropped items from Section 9 (Grace lost T4 from [RECEIVED] + gov_id +
  // property_tax from [MISSING]). Pattern anchored EXACTLY on
  // `<h2>Documents Included</h2>` — does NOT match B's `<h2>Deal Snapshot</h2>`
  // block prepended above. Inject location: before first `<hr>` (the
  // Section-10 separator), preserving Section 9's logical position.
  // Verified by GROUP C6-B-SNAPSHOT-INTERACTION: B Snapshot byte-intact under
  // C.6 pipeline (Grace's corrected figures from C.5 REQUIRED-1 stay intact).
  const _c6DocsResult = aiService.stripAndInjectDocumentsIncluded(leadSummary, dealDocs, missingDocs);
  leadSummary = _c6DocsResult.result;
  console.log(`C.6: Documents Included JS-rendered (stripped=${_c6DocsResult.stripped}, injected=${_c6DocsResult.injected})`);

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
  // R9-B (2026-05-26): canonical LTV preferred over LLM-derived ltv arg for
  // subject line consistency with Deal Snapshot block. Marcus retest
  // 996a676c showed subject="72.8% LTV" (LLM) while Snapshot showed "60.7%"
  // (JS canonical) — Franco observed the contradiction. Post-R9-B subject
  // uses _r9bCanonicalLtv when computable; falls back to LLM ltv arg when
  // canonical null (incomplete extraction — defense-in-depth preserves
  // pre-R9-B behavior on out-of-scope shapes; never emits blank LTV).
  const _r9bSubjectLtv = _r9bCanonicalLtv ? _r9bCanonicalLtv.value : ltv;
  const subject = `${subjectPrefix}ACTION REQUIRED: ${subjectStatus} Review — ${borrowerName} — ${_r9bSubjectLtv}% LTV`;
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
// R9-A (2026-05-26): pure auto-send close-out — admin-SEND-confirmation gate
// removed. Pre-R9-A: 4-message admin-side handshake (info notice → draft
// preview → admin SEND → broker close). Post-R9-A: 2-message admin-side
// (info notice → broker auto-send). Franco's R8/S2-Bug-1 + S3-Bug-2
// PERSISTENT cross-scenario ask: "Standard fixed language never needs
// editing; auto-send required." generateCompletionEmail's deterministic
// template (ai.js:2124) was already correct-language pre-R9-A — only the
// SEND gate remained as friction. R9-A removes that gate by short-circuiting
// the draft cycle and directly sending the deterministic closing email to
// the broker with LLLL broker-thread headers (mirrors executeDraft's
// header-construction logic, inlined here per single-site usage).
//
// Status transition is atomic: dealsService.update(deal.id, { status:
// 'completed' }) immediately follows the broker auto-send. Single-source-
// of-truth co-location (R6-κ first-stamp-wins pattern). executeDraft's
// 'approval_completed' branch (L1429-1431) is now structurally dead-code
// for the autonomous close-out path but is RETAINED as defense-in-depth
// (Q2-(a) verdict) — see annotation at that branch.
//
// Two-stage verification:
//   Stage 1 (this commit): deterministic harness pins code-side fix-shape.
//     R9-A-FLOW-MATRIX + R9-A-MARCUS-FIXTURE + R9-A-INFO-NOTICE-TEXT +
//     R9-A-CALL-SITE-WIRING + R9-A-EXECUTE-DRAFT-DEFENSE + R9-A-CROSS-
//     CLUSTER-INTEGRATION.
//   Stage 2 (Franco retest): next file-completion arc with AML/PEP saved
//     observes 2-message admin handshake + auto-sent closing with canonical
//     fixed-template language; NO Closing Draft Preview, NO SEND gate,
//     status='completed' atomic.
const sendCompletionHandoff = async (deal, dealSummary, dealDocs, dealMessages, brokerInboundEmail, { conditionsFulfilled = false } = {}) => {
  const borrowerName = dealSummary?.borrower_name || deal.borrower_name;

  // R9-G (2026-05-26): NEW FEATURE — submission-ready document package
  // attached to the [File Complete] info notice. Franco S2-Bug-2: at file
  // completion, admin should receive a bundled package of all borrower
  // documents to take directly to the lender. R9-G integrates the existing
  // downloadDocsAsZip helper (deals.js:384, already used at 3 prior sites:
  // sendEscalationToAdmin / sendPreliminaryReviewToAdmin / legacy FINAL
  // REVIEW dispatcher post-R7-A DEFENSE-IN-DEPTH UNREACHABLE) into
  // sendCompletionHandoff — additive deliverable at the existing dispatcher
  // boundary using existing infrastructure.
  //
  // Architectural framing — NEW FEATURE (not new template family):
  // doesn't fit (1) canonical-map source-hierarchy enforcement (no source
  // divergence) / (2) state-derived gate signal (no prompt conditional) /
  // (3) pre-create intake classification (post-completion delivery).
  // "Augment existing dispatcher with new deliverable using existing
  // helpers" is generic feature-development, not architectural pattern
  // requiring a new template family.
  //
  // Q1-(a) ATTACH-TO-INFO-NOTICE: single admin email; zip attached to
  // existing [File Complete] info notice (currently empty attachments
  // array). No second admin email. Postmark attachment-size limits +
  // signed-URL alternative deferred per Q1-(c) future-trigger if
  // empirically surfaced.
  // Q2-(a) ALL DOCS ON FILE: bundle every classified document in dealDocs.
  // Marcus fixture = 10 docs (intake + AML + PEP). Admin curates outbound
  // to lender on their side; R9-G doesn't pre-filter (AML/PEP exclusion
  // deferred per Q2-(b) future-trigger).
  // Q3-(a) CATCH + LOG + CONTINUE on zip-helper failure: defense-in-depth
  // discipline (R9-A "never silently block close-out" principle). Status=
  // 'completed' still transitions; broker still gets closing email; admin
  // still gets info notice (without package — admin grabs docs manually).
  //
  // Naming convention: `{SafeName}_Complete_Documents.zip` mirrors legacy
  // FINAL REVIEW path (webhook.js:3496) for cross-call-site grep discipline.
  let _r9gPackageAttachments = [];
  if (Array.isArray(dealDocs) && dealDocs.length > 0) {
    try {
      const _r9gZipBase64 = await dealsService.downloadDocsAsZip(deal.id, dealDocs);
      const _r9gSafeName = (borrowerName || 'Unknown').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
      _r9gPackageAttachments = [{
        Name: `${_r9gSafeName}_Complete_Documents.zip`,
        Content: _r9gZipBase64,
        ContentType: 'application/zip',
      }];
      console.log(`R9-G: submission-ready document package built — ${dealDocs.length} docs in ${_r9gSafeName}_Complete_Documents.zip`);
    } catch (err) {
      // Q3-(a) defensive: zip failure should NOT block the close-out flow.
      // Info notice still fires (without attachment); broker still gets
      // closing email; status='completed' still transitions. Admin can
      // grab docs manually from the deal on observing missing attachment.
      console.error(`R9-G: downloadDocsAsZip failed for deal ${deal.id}, continuing without attachment:`, err.message);
    }
  } else {
    console.log(`R9-G: no docs available for completion package (dealDocs ${Array.isArray(dealDocs) ? 'empty' : 'invalid'}); info notice fires without attachment`);
  }

  // 1. Informational notice to admin — no action required (R9-A: text
  // updated from "Closing draft preview will follow" to reflect auto-send.
  // R9-G: body text now references attached package + attachments array
  // interpolates _r9gPackageAttachments).
  const infoSubject = conditionsFulfilled
    ? `[Conditions Fulfilled] ${borrowerName} — File Complete`
    : `[File Complete] ${borrowerName} — Ready to Close`;
  const infoBodyLead = conditionsFulfilled
    ? `Broker submitted the remaining condition docs for <strong>${borrowerName}</strong>. The file is now complete.`
    : `Broker submitted the remaining required docs for <strong>${borrowerName}</strong>. The file is now complete.`;
  // R10-I (2026-05-27): admin info-notice text updated to reflect that
  // the broker NOW ALSO receives the complete document package (R10-I
  // wire-extension at L1631 broker emailService.sendEmail). Pre-R10-I,
  // only admin received the zip; broker got generic close-out with no
  // attachments. Admin still receives the zip (for reference / fallback)
  // — same _r9gPackageAttachments array passed to both admin info notice
  // here AND broker lender-package email downstream.
  const _r9gPackageLine = _r9gPackageAttachments.length > 0
    ? `<p>The lender-package closing email + complete document package has been sent to the broker for lender submission. Admin copy of the package is attached for your records.</p>`
    : `<p>The closing email has been sent to the broker.</p>`;
  const infoBody = `<p>${infoBodyLead}</p>${_r9gPackageLine}`;
  const infoResult = await emailService.sendEmail(
    config.adminEmail,
    infoSubject,
    infoBody.replace(/<[^>]*>/g, ''),
    infoBody,
    _r9gPackageAttachments
  );
  await dealsService.saveMessage(deal.id, 'outbound', infoSubject, infoBody, infoResult.MessageID);
  console.log(`R9-A: completion-handoff informational notice sent to admin (conditionsFulfilled=${conditionsFulfilled})`);

  // ────────────────────────────────────────────────────────────────────
  // R6-λ (2026-05-21) PRESERVED: 2-second delay between admin info notice
  // and broker auto-send. Pre-R9-A this delay was between the two ADMIN
  // emails (info notice + draft preview); post-R9-A the second email is
  // the BROKER auto-send. Same Postmark queue-parallelism defense applies
  // — the broker receives the closing after the admin sees the [File
  // Complete] notification, matching Franco's stated mental model.
  // ────────────────────────────────────────────────────────────────────
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // 2. Auto-send deterministic closing email to broker (R9-A — no draft
  // cycle). LLLL pattern: subject + In-Reply-To + References derive from
  // broker-direction message slice so the close-out lands in the broker's
  // existing conversation. Mirrors executeDraft's header construction
  // (L1376-1397), inlined here per single-site usage.
  //
  // R10-I (2026-05-27): closes Bug 6-? + 7-6 (Franco R10 Scenarios 6+7).
  // Pre-R10-I, broker close-out used generateCompletionEmail (Claude-
  // generated narrative — "The file is now complete and submitted. Please
  // direct any further questions to Franco..."). Broker had NO portable
  // artifact to forward to lenders. R10-I replaces the Claude call with
  // a JS-deterministic composeBrokerLenderPackageEmail that bundles:
  //   - Deal Snapshot HTML (renderDealSnapshot from canonical_map — same
  //     filtered map driving the admin Snapshot at sendPreliminaryReview-
  //     ToAdmin per Cluster B Commit 2b precedent)
  //   - Lead-in framing the artifact for lender-forwarding workflow
  //   - Attachment-mention line for the R9-G zip
  //   - Franco-pointer for questions (preserves R9-A exit language)
  //   - Vienna signoff (existing convention)
  // _r9gPackageAttachments (built above for the admin info notice) is
  // also passed to the broker emailService.sendEmail (single-attribute
  // change from `[]` to the populated array).
  //
  // CASCADE-COMPOSITION per Q4 ratification — enforceNoRoutingLeak +
  // stripPerfectOpener applied for cross-cluster discipline consistency
  // with R10-H's sweepBrokerFacingDraft helper. No-op in the clean JS-
  // deterministic case but preserves the cascade pattern. Carve-out at
  // ai.js:1097 protects admin-dictated (executeDraft / draft-preview /
  // reviseEmailWithEdits) — sendCompletionHandoff is Vienna-autonomous
  // by call-site so sweep applies cleanly.
  //
  // BROKER SNAPSHOT — reuses the SAME filtered canonical_map driving the
  // admin Snapshot upstream (filterCanonicalMortgagePosition + Purpose +
  // LoanAmount + Lender chain). No drift between admin-prelim Snapshot
  // and broker-lender-package Snapshot. R10-E/R10-G OBJECTIVE-vs-INTENT
  // source-hierarchy preserved.
  const _r10iInboundMessages = dealMessages.filter(m => m.direction === 'inbound');
  const _r10iDetect = dEngine.runDiscrepancyDetectionAggregated(
    _r10iInboundMessages,
    dealDocs.map(d => ({ file_name: d.file_name, classification: d.classification, text: d?.extracted_data?.text || '' })),
    dealSummary?.broker_name || dealSummary?.sender_name || borrowerName,
    { emailSubject: _r10iInboundMessages[0]?.subject || '' }
  );
  const _r10iFilteredMap = dEngine.filterCanonicalMortgagePositionForObjectiveAuthoritative(
    dEngine.filterCanonicalPurposeForBrokerAuthoritative(
      dEngine.filterCanonicalLoanAmountForDocAuthoritative(
        dEngine.filterCanonicalLenderForPayoutOnly(_r10iDetect.canonical_map)
      )
    )
  );
  const _r10iSnapshotHtml = dEngine.renderDealSnapshot(_r10iFilteredMap, {
    ownershipType: deal.ownership_type || null,
    isCommercial: !!_r10iDetect.commercial,
    jointBorrowers: _r10iDetect.joint_multi_borrower, // FRANCO-PREDICTED-Q8
    qualificationRoster: bq.buildQualificationRoster({ // FRANCO-Q3/Q4
      detectedBorrowers: _r10iDetect.joint_multi_borrower,
      primaryName: dealSummary?.borrower_name || borrowerName || null,
    }),
  });
  const _r10iBrokerGreeting = selectGreetingFirstName({
    broker_name: dealSummary?.broker_name,
    sender_name: dealSummary?.sender_name,
    borrower_name: dealSummary?.borrower_name,
    sender_type: dealSummary?.sender_type,
  });
  const _r10iBorrowerSafeName = (borrowerName || 'Unknown').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
  let closingEmail = aiService.composeBrokerLenderPackageEmail({
    borrowerName,
    brokerGreetingName: _r10iBrokerGreeting,
    snapshotHtml: _r10iSnapshotHtml,
    packageAttached: _r9gPackageAttachments.length > 0,
    borrowerSafeName: _r10iBorrowerSafeName,
  });
  // R10-H cascade-composition sweep — Vienna-autonomous broker-facing
  // outbound discipline preserved. No-op in the clean JS-deterministic
  // composition case (composer is structurally sweep-safe by
  // construction) but maintains cross-cluster invariant.
  {
    const _eSweep = aiService.enforceNoRoutingLeak(closingEmail);
    closingEmail = _eSweep.swept;
    if (_eSweep.sweptAny) console.log(`R10-I: enforceNoRoutingLeak fired on broker lender-package email (unexpected — composer should be sweep-safe by construction)`);
  }
  {
    const _r8bSweep = aiService.stripPerfectOpener(closingEmail);
    closingEmail = _r8bSweep.swept;
    if (_r8bSweep.sweptAny) console.log(`R10-I: stripPerfectOpener fired on broker lender-package email (unexpected — composer hardcodes "Hi {Name}," opener)`);
  }
  const allMessages = await dealsService.getMessages(deal.id);
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
  const anchorSubject = brokerInputs.earliestBrokerSubject
    ? (brokerInputs.earliestBrokerSubject.startsWith('Re:')
        ? brokerInputs.earliestBrokerSubject
        : `Re: ${brokerInputs.earliestBrokerSubject}`)
    : `Re: ${borrowerName}`;
  const brokerSendResult = await emailService.sendEmail(
    deal.email,
    anchorSubject,
    closingEmail.replace(/<[^>]*>/g, ''),
    closingEmail,
    // R10-I (2026-05-27): attach R9-G zip to broker email. Previously `[]`
    // (admin-only). Broker now ALSO receives the complete document
    // package for lender forwarding.
    _r9gPackageAttachments,
    brokerHeaders
  );
  await dealsService.saveMessage(deal.id, 'outbound', anchorSubject, closingEmail, brokerSendResult.MessageID);
  console.log(`R10-I: lender-package closing email auto-sent to broker (LLLL: threaded into broker conversation, subject="${anchorSubject}", headers=${brokerHeaders.length}, attachments=${_r9gPackageAttachments.length})`);

  // 3. Atomic status transition — R9-A co-location with the action that
  // triggers it (Q3-(a) verdict). Mirrors R6-κ first-stamp-wins pattern.
  // Pre-R9-A status='completed' was set inside executeDraft's
  // 'approval_completed' branch (L1430); that branch is now defense-in-
  // depth dead-code (Q2-(a) verdict + annotation).
  await dealsService.update(deal.id, { status: 'completed' });
  console.log(`R9-A: deal status transitioned to 'completed' atomically (single-source-of-truth co-location with broker auto-send)`);
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
      // STRUCTURAL ORDER NOTE (R5-B-3 PIN 3): this text-only-noop branch is
      // intentionally checked BEFORE the R5-B-3 prelim_approved_at gate below.
      // The order is load-bearing — if a future refactor reorders these
      // returns such that the prelim_approved_at gate fires first, broker
      // text-only replies would route to preliminary-update instead of
      // text-only-noop, reintroducing S8 Bug 2's wrong-shape [UPDATED]
      // PRELIMINARY on clarification-only replies. The R5B3-C1-PRECEDENCE-
      // STRUCTURAL test source-greps this ordering.
      if (!hasNewDocsThisTurn) {
        return { action: 'text-only-noop', reason: 'broker text-only reply (no new docs)', allDocsInNow: true, stillMissing };
      }
      // R5-B-3 (Lena Park 8486bf8a, R4-S14 retest): gate completion-handoff
      // on prelim_approved_at — symmetric with computeCompletionDispatch
      // L435's active-branch gate. Pre-fix this returned completion-handoff
      // regardless of admin approval state → broker submitting final intake
      // docs on under_review deal with prelim_approved_at=null fired
      // [File Complete] handoff before admin's APPROVED reply ever landed.
      // Post-fix: post-approval routes to completion-handoff (the close-out);
      // pre-approval routes to preliminary-update so admin sees the
      // [UPDATED] PRELIMINARY review (all docs received, clarification
      // resolved per Bucket-B-relaxed banner trichotomy) and can approve.
      // After admin's APPROVED reply, active-branch's computeCompletionDispatch
      // correctly routes to close-out (it always checked prelim_approved_at).
      if (deal.prelim_approved_at) {
        return { action: 'completion-handoff', conditionsFulfilled: !!deal.conditions_sent_at, allDocsInNow: true, stillMissing };
      }
      return { action: 'preliminary-update', allDocsInNow: true, stillMissing };
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
    // ──────────────────────────────────────────────────────────────────────
    // R5 Cluster F Bug 4 (2026-05-21): denylist expansion + advisory positive
    // criteria.
    //
    // Pre-expansion, the denylist caught Postmark system, generic noreply, and
    // Anthropic addresses. Production audit surfaced 15 garbage deals from
    // non-broker inbounds that slipped through: Postmark marketing
    // (@fyi.postmarkapp.com), internal team (@fsagent.com — Bradley, Porter),
    // VIMA admin staff (gabriela/brandon/admin@vimarealty.com), and one
    // ambiguous sender (Christine — handled via cleanup script, not filter).
    //
    // CRITICAL CARVE-OUT: franco@vimarealty.com is NOT denylisted. Franco is
    // the testing proxy on 93/108 production deals — denylisting his address
    // would break the entire R5 retest harness and break production VIMA broker
    // workflows that legitimately route through his address. Domain-wide
    // @vimarealty.com denylist would catch Franco; explicit per-address
    // denylist for the three known admins keeps Franco unblocked structurally.
    const senderEmail = config.postmark.senderEmail || '';
    const ignoredSenders = [
      'support@postmarkapp.com', 'noreply@', 'no-reply@',
      '@anthropic.com', '@mail.anthropic.com',
      // R5-F4: Postmark marketing/system (production garbage source)
      '@fyi.postmarkapp.com',
      // R5-F4: internal team (Bradley, Porter, internal admin via domain)
      '@fsagent.com',
      // R5-F4: VIMA admin staff — explicit per-address (NOT domain-wide,
      // because franco@vimarealty.com is the testing proxy and MUST pass)
      'gabriela@vimarealty.com',
      'brandon@vimarealty.com',
      'admin@vimarealty.com',
    ];
    if (senderEmail) ignoredSenders.push(senderEmail.toLowerCase());

    if (ignoredSenders.some(addr => email.from.toLowerCase().includes(addr))) {
      console.log('Skipping ignored/system email from:', email.from);
      return;
    }

    // R5 Cluster F Bug 4: advisory positive-criteria check. Logs (does NOT
    // block) when a sender that PASSED the denylist lacks any broker-submission
    // signal. Forensic visibility for Franco — surfaces ambiguous-sender
    // patterns so the denylist can be reactively expanded if a new garbage
    // source emerges. Non-blocking by design: positive criteria are noisy and
    // not all legitimate broker submissions match (e.g. brokers replying to
    // referrals may have no attachments, no Lic.# yet, and a conversational
    // subject). Future signal-tightening based on production samples.
    const _f4HasAttachments = (email.attachments?.length || 0) > 0;
    const _f4HasLicSig = /Lic\.?\s*#/i.test(email.textBody || '');
    const _f4HasBrokerSubject = /(submission|application|mortgage|loan|inquiry|refinance)/i.test(email.subject || '');
    const _f4LooksLikeBroker = _f4HasAttachments || _f4HasLicSig || _f4HasBrokerSubject;
    if (!_f4LooksLikeBroker) {
      console.log(`R5-F4 advisory: sender ${email.from} passed denylist but lacks broker-submission signal (no attachments, no Lic.# signature, no broker-keyword subject). Not blocking; logging for forensic review.`);
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

    // ──────────────────────────────────────────────────────────────────────
    // ADMIN-HANDOFF LINK-SUBMISSION feature — NOTIFY-ADMIN-ONLY structural gate
    // ──────────────────────────────────────────────────────────────────────
    // When a deal has been handed off to admin (link-only submission earlier
    // in the thread, see the new-deal branch below), Vienna pauses automation
    // on that deal — broker inbounds are saved + forwarded to admin, no
    // Vienna response, no attachment processing, no downstream automation.
    // Per-deal scoped via deal.admin_controlled (NOT email-scoped). Thread-
    // based deal matching above (L950-967) ensures broker submits for other
    // deals (different threads) continue to route normally.
    //
    // Admin replies (isAdmin) are NOT gated — admin owns the deal end-to-end
    // after handoff; their replies continue to flow through the existing
    // admin-reply branch below.
    if (existingDeal && existingDeal.admin_controlled === true && !isAdmin) {
      console.log(`Admin-controlled gate: broker inbound on deal ${existingDeal.id} — saving + notifying admin; Vienna paused on this deal.`);
      // Persist broker's message to the deal thread (pure INSERT, no
      // automation downstream — verified by saveMessage source-grep).
      await dealsService.saveMessage(existingDeal.id, 'inbound', email.subject, email.textBody);
      // Forward to admin so they see the broker's reply in their inbox.
      const _ahcBorrowerName = existingDeal.extracted_data?.borrower_name || existingDeal.borrower_name || '(unknown borrower)';
      const _ahcSubject = `[Admin-controlled deal] Broker reply — ${_ahcBorrowerName}`;
      const _ahcBody = `<p>Broker replied on an admin-controlled deal (Vienna is paused on this deal).</p>
<p><strong>Deal:</strong> ${existingDeal.id}</p>
<p><strong>Borrower:</strong> ${_ahcBorrowerName}</p>
<p><strong>From:</strong> ${email.from}</p>
<p><strong>Subject:</strong> ${email.subject || '(no subject)'}</p>
<hr>
<p><strong>Broker message:</strong></p>
<div>${(email.textBody || '').replace(/\n/g, '<br>')}</div>
<hr>
<p><em>Vienna will NOT respond on this thread. Action manually.</em></p>`;
      await emailService.sendEmail(
        config.adminEmail,
        _ahcSubject,
        _ahcBody.replace(/<[^>]*>/g, ''),
        _ahcBody
      );
      return;
    }

    if (isAdmin && existingDeal) {
      console.log('Admin reply detected for deal:', existingDeal.id, 'Status:', existingDeal.status);
      await dealsService.saveMessage(existingDeal.id, 'inbound', email.subject, email.textBody);

      const borrowerSubject = `Re: ${existingDeal.extracted_data?.borrower_name || 'Your Loan Inquiry'}`;

      // R10-H (2026-05-27) — admin-handoff broker-facing-draft sweep helper.
      // Closes Bug 7-5 EMPIRICAL-CALL-SITE gap surfaced during R10-H execute:
      // the Ethan deal c95f3a20 outbound 2026-05-27T03:09:14 emitted "I'll
      // be in touch shortly with an update once we've had a chance to review
      // everything." via the under_review→approved partial branch (generate-
      // DocumentRequestEmail → saveDraftAndPreview), but enforceNoRoutingLeak
      // + stripPerfectOpener were NOT invoked on this code path. M2's 5 new
      // sweep patterns would have been dead code without this widening.
      //
      // Scope: applies to ALL Claude-generated broker-facing drafts that
      // route through saveDraftAndPreview at admin-handoff post-approval
      // paths — doc-request (ltv_escalated + under_review branches),
      // rejection (both branches), conditions (both branches), completion.
      // EXCLUDED: REPLACE path (L2038) where admin's verbatim text is
      // routed to broker — admin-dictated content carve-out per ai.js:1097.
      // INCLUDED with intent: revisedEmail (L2051) — Claude-derived,
      // not pure admin content; same sweep eligibility as other Claude-gen.
      //
      // Composes enforceNoRoutingLeak (Cluster E + R4-C.3 + R5-C + R6-η +
      // R10-H) and stripPerfectOpener (R8-B) in single-pass cascade per
      // R5-C-CASCADE-COMPOSITION precedent.
      const sweepBrokerFacingDraft = (html) => {
        if (!html || typeof html !== 'string') return html;
        let out = html;
        const _eSweep = aiService.enforceNoRoutingLeak(out);
        out = _eSweep.swept;
        if (_eSweep.sweptAny) console.log(`R10-H: routing-leak sweep substituted phrasing in admin-handoff draft (deal ${existingDeal.id})`);
        const _r8bSweep = aiService.stripPerfectOpener(out);
        out = _r8bSweep.swept;
        if (_r8bSweep.sweptAny) console.log(`R10-H: "Perfect"-opener sweep neutralized opener in admin-handoff draft (deal ${existingDeal.id})`);
        return out;
      };

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
      //
      // R5-A+G (2026-05-21, Franco's R5-S1 Grace + R5-S2 Marcus retest): the
      // post-CCCC close-out path stranded admin's SEND on closing draft previews.
      // sendCompletionHandoff (active-branch completion-handoff dispatch) sets
      // draft_email + draft_action='approval_completed' WITHOUT transitioning
      // status (status stays 'active' after sendCompletionHandoff). Admin's SEND
      // reply on the closing draft preview needs to reach executeDraft to
      // (a) ship the closing email to broker AND
      // (b) transition status='completed'.
      // Pre-fix, the L1085 guard's status filter excluded 'active', so executeDraft
      // never ran on these replies — broker never received the closing email AND
      // status stayed at 'active' AND reminder cron (filters d.status==='active'
      // at dailySummary.js:51) kept firing follow-ups on completed files.
      // Both symptoms (Cluster A no-broker-delivery + Cluster G reminder-misfire)
      // share this single root via the transitivity:
      //   executeDraft is the SOLE setter of status='completed' (verified by
      //   grep — only L1144 in src/) AND the SOLE broker-facing send on
      //   action='approval_completed'. So if executeDraft fires correctly,
      //   reminder cron's d.status==='active' filter naturally excludes the deal.
      //
      // Conservative guard scoping: 'active' enters ONLY when
      // draft_action === 'approval_completed' (the empirically-verified close-out
      // path through sendCompletionHandoff). Defends against legacy/race-condition
      // stale draft_action on active deals via a code path that doesn't exist
      // today but might in future. NNNN/Case-5/scope-lock-protective form.
      const _r5IsPrelimReviewDraft = existingDeal.draft_action && (
        existingDeal.status === 'ltv_escalated' ||
        existingDeal.status === 'under_review'
      );
      const _r5IsClosingDraft = existingDeal.draft_action === 'approval_completed' && existingDeal.status === 'active';
      if (_r5IsPrelimReviewDraft || _r5IsClosingDraft) {
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
            // R9-A AUTO-SEND DEAD-CODE (2026-05-26): post-R9-A this branch is
            // structurally unreachable from the autonomous close-out path.
            // sendCompletionHandoff (webhook.js:937+) now auto-sends the
            // deterministic closing email to the broker directly and sets
            // status='completed' inline, bypassing the draft cycle entirely.
            // The 'approval_completed' draft_action is no longer written by
            // sendCompletionHandoff, so executeDraft never sees this branch
            // value from the autonomous flow.
            //
            // RETAINED AS DEFENSE-IN-DEPTH (Q2-(a) verdict, R7-A precedent for
            // DEFENSE-IN-DEPTH UNREACHABLE annotation): branch remains
            // theoretically reachable via admin-controlled-mode escape valve
            // or future admin-edit-then-SEND scenarios that explicitly set
            // draft_action='approval_completed' from an out-of-band path.
            //
            // R9-A REACTIVATION NOTE (COMPOUNDING-BUG GUARD — R7-A precedent):
            // If a future cleanup-commit reactivates this branch as a primary
            // dispatch path, it MUST ALSO re-implement the status='completed'
            // atomic transition co-located with the broker send. The current
            // line below transitions status here ONLY because executeDraft is
            // the historical pre-R9-A close-out path. Sending the broker email
            // without flipping status (or vice versa) leaves the deal in a
            // half-completed state. Co-location is the invariant.
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
          await saveDraftAndPreview(sweepBrokerFacingDraft(revisedEmail), existingDeal.draft_subject, existingDeal.draft_action);
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
          // R6-ζ (2026-05-21): admin-approval branch → broker has NOT replied
          // since Vienna's last outbound by construction. Signal computed
          // uniformly to preserve the structural pattern.
          const _zRepliedPrelim = brokerRepliedSinceLastViennaOutbound(dealMessages);
          // R6-κ (2026-05-21): post-approval gate. isPostApproval=true here
          // by construction (admin just stamped prelim_approved_at above —
          // or it was already stamped from a prior approval cycle). Drives
          // ai.js complianceDocs consolidation: intake + AML/PEP asked in
          // ONE email when both categories missing. Stamp aml_pep_requested_at
          // below if AML or PEP wasn't already on file (Q1 stamp-condition).
          const _kAmlOnFile = existingDocs.some(d => d.classification === 'aml');
          const _kPepOnFile = existingDocs.some(d => d.classification === 'pep');
          const _kAmlPepAsked = !_kAmlOnFile || !_kPepOnFile;
          // R8-A (2026-05-22): JS-deterministic greeting target. Selected from
          // existingDeal.extracted_data (persisted broker_name from initial
          // extraction). Mirrors R5-E refined wiring at the active-branch
          // generateBrokerResponse site (L2351, L2682). Eric Johansson R4 +
          // Nadia Petrov S15 production fixtures are LOAD-BEARING for this
          // wiring — both deals' admin-approval branches previously emitted
          // "Hi there!" / "Hi Franco!" greetings.
          const _r8aDocReqGreeting = selectGreetingFirstName({
            broker_name: existingDeal.extracted_data?.broker_name,
            sender_name: existingDeal.extracted_data?.sender_name,
            borrower_name: existingDeal.extracted_data?.borrower_name,
            sender_type: existingDeal.extracted_data?.sender_type,
          });
          const docRequestEmail = await aiService.generateDocumentRequestEmail(
            existingDeal.extracted_data,
            existingDeal.ownership_type,
            existingDeal.has_application_form,
            existingDeal.has_pnw_statement,
            existingDocs,
            dealMessages,
            { brokerRepliedSinceLastViennaOutbound: _zRepliedPrelim, isPostApproval: true, greetingFirstName: _r8aDocReqGreeting }
          );
          await saveDraftAndPreview(sweepBrokerFacingDraft(docRequestEmail), borrowerSubject, 'approval_doc_request');
          // R6-κ: first-stamp-wins. Mirrors prelim_approved_at + conditions_sent_at
          // precedents. Stamp only when AML/PEP was actually included in the
          // consolidated request (Q1 verdict — semantic alignment).
          if (_kAmlPepAsked && !existingDeal.aml_pep_requested_at) {
            const _kStampedAt = new Date().toISOString();
            await dealsService.update(existingDeal.id, { aml_pep_requested_at: _kStampedAt });
            existingDeal.aml_pep_requested_at = _kStampedAt;
            console.log(`R6-κ: aml_pep_requested_at stamped (ltv_escalated→approved branch; ${!_kAmlOnFile ? 'AML' : ''}${!_kAmlOnFile && !_kPepOnFile ? '+' : ''}${!_kPepOnFile ? 'PEP' : ''} included in consolidated request)`);
          }
        } else if (intent === 'rejected') {
          console.log('Deal rejected by admin — generating draft rejection');
          // Group RRRR (S8.3): propagate admin's stated decline reason to the
          // broker-facing draft. Mandatory full-text fallback in extractor
          // — if the strip regex misses, full message passes through.
          // Never let a regex miss cause a silent reason omission.
          const adminDeclineReason = extractDeclineReason(message);
          // R8-A (2026-05-22): JS-deterministic greeting target for rejection
          // emails. Symmetric with the doc-request wiring above.
          const _r8aRejectionGreeting = selectGreetingFirstName({
            broker_name: existingDeal.extracted_data?.broker_name,
            sender_name: existingDeal.extracted_data?.sender_name,
            borrower_name: existingDeal.extracted_data?.borrower_name,
            sender_type: existingDeal.extracted_data?.sender_type,
          });
          const rejectionEmail = await aiService.generateRejectionEmail(existingDeal.extracted_data, adminDeclineReason, { greetingFirstName: _r8aRejectionGreeting });
          await saveDraftAndPreview(sweepBrokerFacingDraft(rejectionEmail), borrowerSubject, 'rejection');
        } else {
          console.log('Admin sent conditions/notes — generating draft response');
          const polishedEmail = await aiService.generateAdminResponseEmail(existingDeal.extracted_data, message, dealMessages);
          await saveDraftAndPreview(sweepBrokerFacingDraft(polishedEmail), borrowerSubject, 'conditions');
        }
      } else if (existingDeal.status === 'awaiting_collateral') {
        // FRANCO-PREDICTED-Q9 (2026-05-28): admin-override path out of the
        // collateral hold. awaiting_collateral previously had NO admin-reply
        // branch — an admin reply fell through the chain entirely. Now an admin
        // 'approved'/override transitions the deal back to active WITH an audit
        // trail (collateral_override_at + collateral_override_by stored in
        // extracted_data — mirrors the collateral_offered persistence pattern at
        // the broker-reply branch; NO new DB column / migration), then proceeds
        // exactly like an approval (doc-request draft). 'rejected'/conditions
        // mirror the ltv_escalated/under_review branches.
        const { intent, message } = await aiService.parseAdminReply(email.textBody);
        console.log('Admin intent for awaiting_collateral deal:', intent);
        const dealMessages = await dealsService.getMessages(existingDeal.id);

        if (intent === 'approved') {
          const _q9OverrideAt = new Date().toISOString();
          const _q9UpdatedExtracted = {
            ...(existingDeal.extracted_data || {}),
            collateral_override_at: _q9OverrideAt,
            collateral_override_by: email.from,
          };
          const _q9Update = { status: 'active', extracted_data: _q9UpdatedExtracted };
          if (!existingDeal.prelim_approved_at) _q9Update.prelim_approved_at = _q9OverrideAt;
          await dealsService.update(existingDeal.id, _q9Update);
          existingDeal.status = 'active';
          existingDeal.extracted_data = _q9UpdatedExtracted;
          if (_q9Update.prelim_approved_at) existingDeal.prelim_approved_at = _q9OverrideAt;
          console.log(`FRANCO-PREDICTED-Q9: admin override on awaiting_collateral → active (collateral_override_at=${_q9OverrideAt}, by=${email.from})`);
          const existingDocs = await dealsService.getDocumentsByDeal(existingDeal.id);
          const _q9DocGreeting = selectGreetingFirstName({
            broker_name: existingDeal.extracted_data?.broker_name,
            sender_name: existingDeal.extracted_data?.sender_name,
            borrower_name: existingDeal.extracted_data?.borrower_name,
            sender_type: existingDeal.extracted_data?.sender_type,
          });
          const docRequestEmail = await aiService.generateDocumentRequestEmail(
            existingDeal.extracted_data,
            existingDeal.ownership_type,
            existingDeal.has_application_form,
            existingDeal.has_pnw_statement,
            existingDocs,
            dealMessages,
            { isPostApproval: true, greetingFirstName: _q9DocGreeting }
          );
          await saveDraftAndPreview(sweepBrokerFacingDraft(docRequestEmail), borrowerSubject, 'approval_doc_request');
        } else if (intent === 'rejected') {
          console.log('Admin rejected awaiting_collateral deal — generating draft rejection');
          const adminDeclineReason = extractDeclineReason(message);
          const _q9RejGreeting = selectGreetingFirstName({
            broker_name: existingDeal.extracted_data?.broker_name,
            sender_name: existingDeal.extracted_data?.sender_name,
            borrower_name: existingDeal.extracted_data?.borrower_name,
            sender_type: existingDeal.extracted_data?.sender_type,
          });
          const rejectionEmail = await aiService.generateRejectionEmail(existingDeal.extracted_data, adminDeclineReason, { greetingFirstName: _q9RejGreeting });
          await saveDraftAndPreview(sweepBrokerFacingDraft(rejectionEmail), borrowerSubject, 'rejection');
        } else {
          console.log('Admin sent conditions/notes on awaiting_collateral — generating draft response');
          const polishedEmail = await aiService.generateAdminResponseEmail(existingDeal.extracted_data, message, dealMessages);
          await saveDraftAndPreview(sweepBrokerFacingDraft(polishedEmail), borrowerSubject, 'conditions');
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
            await saveDraftAndPreview(sweepBrokerFacingDraft(completionEmail), borrowerSubject, 'approval_completed');
          } else {
            // PRELIMINARY APPROVAL — still missing docs, generate doc request
            console.log('Preliminary approval by admin — generating draft doc request for remaining items');
            // R6-ζ (2026-05-21): admin-approval branch → signal=false by construction.
            const _zRepliedPrelimPartial = brokerRepliedSinceLastViennaOutbound(dealMessages);
            // R6-κ (2026-05-21): post-approval gate. James S9 (004cf263)
            // empirical fixture hit this branch — admin "approved" plain,
            // intake + AML/PEP both missing, pre-R6-κ split into two emails.
            // isPostApproval=true here drives ai.js complianceDocs
            // consolidation; stamp aml_pep_requested_at when AML/PEP was
            // actually included (Q1 stamp-condition: !amlOnFile || !pepOnFile).
            const _kAmlOnFilePartial = existingDocs.some(d => d.classification === 'aml');
            const _kPepOnFilePartial = existingDocs.some(d => d.classification === 'pep');
            const _kAmlPepAskedPartial = !_kAmlOnFilePartial || !_kPepOnFilePartial;
            // R8-A (2026-05-22): symmetric to ltv_escalated→approved branch above.
            const _r8aDocReqGreetingPartial = selectGreetingFirstName({
              broker_name: existingDeal.extracted_data?.broker_name,
              sender_name: existingDeal.extracted_data?.sender_name,
              borrower_name: existingDeal.extracted_data?.borrower_name,
              sender_type: existingDeal.extracted_data?.sender_type,
            });
            // R10-F (2026-05-27) DEFERRED RESIDUAL — post-approval doc-request
            // discrepancy injection. This path does NOT run the discrepancy
            // strip+inject pipeline (which only runs at the active-branch
            // generateBrokerResponse call site at L3520-3523). R10-F's gate
            // fix at computeCompletionDispatch + L3660 prevents this path from
            // being reached with an unresolved-discrepancy state — broker must
            // resolve the discrepancy first (held at active branch), THEN
            // prelim fires on the resolved state, THEN admin can approve,
            // THEN this path executes. Closure condition: trigger when
            // empirical fixture surfaces a broker-confirmed-resolved deal
            // where admin still wants the discrepancy-history surfaced in
            // the post-approval doc request.
            const docRequestEmail = await aiService.generateDocumentRequestEmail(
              existingDeal.extracted_data,
              existingDeal.ownership_type,
              existingDeal.has_application_form,
              existingDeal.has_pnw_statement,
              existingDocs,
              dealMessages,
              { brokerRepliedSinceLastViennaOutbound: _zRepliedPrelimPartial, isPostApproval: true, greetingFirstName: _r8aDocReqGreetingPartial }
            );
            await saveDraftAndPreview(sweepBrokerFacingDraft(docRequestEmail), borrowerSubject, 'approval_doc_request');
            // R6-κ: first-stamp-wins. Mirrors prelim_approved_at + conditions_sent_at.
            if (_kAmlPepAskedPartial && !existingDeal.aml_pep_requested_at) {
              const _kStampedAtPartial = new Date().toISOString();
              await dealsService.update(existingDeal.id, { aml_pep_requested_at: _kStampedAtPartial });
              existingDeal.aml_pep_requested_at = _kStampedAtPartial;
              console.log(`R6-κ: aml_pep_requested_at stamped (under_review→approved branch; ${!_kAmlOnFilePartial ? 'AML' : ''}${!_kAmlOnFilePartial && !_kPepOnFilePartial ? '+' : ''}${!_kPepOnFilePartial ? 'PEP' : ''} included in consolidated request)`);
            }
          }
        } else if (intent === 'rejected') {
          console.log('Deal rejected by admin — generating draft rejection');
          // Group RRRR (S8.3): propagate admin's stated decline reason
          // (under_review path, symmetric with the upper draft_email path).
          const adminDeclineReason = extractDeclineReason(message);
          // R8-A (2026-05-22): symmetric to ltv_escalated→rejected branch above.
          const _r8aRejectionGreetingUR = selectGreetingFirstName({
            broker_name: existingDeal.extracted_data?.broker_name,
            sender_name: existingDeal.extracted_data?.sender_name,
            borrower_name: existingDeal.extracted_data?.borrower_name,
            sender_type: existingDeal.extracted_data?.sender_type,
          });
          const rejectionEmail = await aiService.generateRejectionEmail(existingDeal.extracted_data, adminDeclineReason, { greetingFirstName: _r8aRejectionGreetingUR });
          await saveDraftAndPreview(sweepBrokerFacingDraft(rejectionEmail), borrowerSubject, 'rejection');
        } else {
          console.log('Admin sent conditions/notes for under_review deal — generating draft');
          const polishedEmail = await aiService.generateAdminResponseEmail(existingDeal.extracted_data, message, dealMessages);
          await saveDraftAndPreview(sweepBrokerFacingDraft(polishedEmail), borrowerSubject, 'conditions');
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

        // R9-F (2026-05-26): pre-create intake classification — alert-admin-
        // and-skip on clear-reject categories (admin-as-borrower / system-
        // sender / no-human-name with org-suffix). Q3 fail-open: ambiguous
        // cases default to accept. Group ZZZ admin-alert precedent.
        // At admin-referral path, broker_name is absent (referral source is
        // admin, not a broker) — admin-as-borrower with no broker IS the
        // Franco-Maione mock-test fixture shape.
        const _r9fReferralClassification = classifyIntakeBorrower(
          {
            borrower_name: referral.referred_name || '',
            broker_name: null,
          },
          { emailBody: email.textBody || '' }  // R10-A (2026-05-26): body-signal source
        );
        if (_r9fReferralClassification !== 'accept') {
          console.log(`R9-F: admin-referral classified as ${_r9fReferralClassification} — alerting admin + skipping deal-create`);
          const _r9fAlertBody = `Vienna filtered an admin referral as a non-deal entry.

Classification: ${_r9fReferralClassification}
Referred borrower_name: ${referral.referred_name || '(empty)'}
Referred email: ${referral.referred_email || '(empty)'}

Parsed referral snapshot:
${JSON.stringify(referral, null, 2)}

Original referral body (first 500 chars):
${(email.textBody || '').slice(0, 500)}

Postmark MessageID: ${email.messageId}

No deal record was created. If this was a legitimate referral, please reply with the corrected borrower name + email and Vienna will retry.

(This alert is automatic — R9-F intake-gate classifier, alert-admin-and-skip semantics per Q2-(a) verdict. Reject categories: admin-as-borrower / system-sender / no-human-name. Ambiguous cases default to accept per Q3 fail-open.)`;
          await emailService.sendEmail(
            config.adminEmail,
            `[Intake Filter] Referral rejected — ${referral.referred_name || 'unnamed'}`,
            _r9fAlertBody,
            null,
            [],
            []
          );
          // R10-A (2026-05-26): broker acknowledgment on uncertain-reject
          // categories (admin-as-borrower / no-human-name). system-sender
          // stays silent-drop (no false-positive surface). Q3-(a) cost-asymmetry
          // verdict: false-positive on these categories has high broker-
          // confusion cost; admin alert above is the primary signal for Franco
          // to override via daily-summary surface or direct reply.
          if (_r9fReferralClassification === 'reject:admin-as-borrower'
              || _r9fReferralClassification === 'reject:no-human-name') {
            await sendBrokerAcknowledgmentOnReject(email);
          }
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

        // R9-F (2026-05-26): pre-create intake classification — alert-admin-
        // and-skip on clear-reject categories. At broker-submission path,
        // broker_name isn't yet known (processInitialEmail hasn't run); pass
        // borrower_name from Postmark fromName only. Per Q3 fail-open,
        // ambiguous cases default to accept — the classifier only catches
        // CLEAR reject categories (Postmark Team system-sender being the
        // primary empirical fixture at this path).
        const _r9fIntakeClassification = classifyIntakeBorrower(
          {
            borrower_name: email.fromName || '',
            broker_name: null,
          },
          { emailBody: email.textBody || '' }  // R10-A (2026-05-26): body-signal source
        );
        if (_r9fIntakeClassification !== 'accept') {
          console.log(`R9-F: new-client intake classified as ${_r9fIntakeClassification} — alerting admin + skipping deal-create`);
          const _r9fAlertBody = `Vienna filtered a new-client intake as a non-deal entry.

Classification: ${_r9fIntakeClassification}
Postmark From-Name: ${email.fromName || '(empty)'}
Postmark From-Email: ${email.from}
Subject: ${email.subject || '(empty)'}

Original body (first 500 chars):
${(email.textBody || '').slice(0, 500)}

Postmark MessageID: ${email.messageId}

No deal record was created. If this was a legitimate broker submission, please review and either reply directly or re-submit with corrected From-Name.

(This alert is automatic — R9-F intake-gate classifier, alert-admin-and-skip semantics per Q2-(a) verdict. Reject categories: admin-as-borrower / system-sender / no-human-name. Ambiguous cases default to accept per Q3 fail-open.)`;
          await emailService.sendEmail(
            config.adminEmail,
            `[Intake Filter] New-client intake rejected — ${email.fromName || 'unnamed'}`,
            _r9fAlertBody,
            null,
            [],
            []
          );
          // R10-A (2026-05-26): broker acknowledgment on uncertain-reject
          // categories (admin-as-borrower / no-human-name). system-sender
          // stays silent-drop (no false-positive surface). Q3-(a) cost-asymmetry
          // verdict: false-positive on these categories has high broker-
          // confusion cost; admin alert above is the primary signal for Franco
          // to override via daily-summary surface or direct reply.
          if (_r9fIntakeClassification === 'reject:admin-as-borrower'
              || _r9fIntakeClassification === 'reject:no-human-name') {
            await sendBrokerAcknowledgmentOnReject(email);
          }
          return;
        }

        // R9-F' (2026-05-26): cross-status duplicate detection. Pre-create
        // dedup using email + lightweight property extraction (no AI cost).
        // findActiveByEmail (the broker-reply continuation lookup) filtered
        // by status — so re-submitting after a deal closed silently created
        // a new record. R9-F' catches that gap with carve-outs for legitimate
        // refinance (>90 days), new property (FSA + street# differs), and
        // ambiguity (property missing → Q3a fail-open).
        //
        // Property comes from cFields.extractFromEmailBody — pure regex on
        // broker email body (subject_property_address). Same extractor used
        // at line 2607 for combined-LTV computation; reusing pre-create
        // avoids redundant AI extraction.
        //
        // On duplicate detected: alert admin via sendDuplicateAlertToAdmin
        // (Group ZZZ admin-handoff precedent) + skip create. Admin manually
        // decides link-vs-create.
        const _r9fPrimeExtract = cFields.extractFromEmailBody(email.textBody || '', email.subject || '');
        const _r9fPrimeDupCheck = await dealsService.findExistingDealForBorrower(
          email.from,
          _r9fPrimeExtract
        );
        if (_r9fPrimeDupCheck.existingDeal) {
          console.log(`R9-F': duplicate detected — reason=${_r9fPrimeDupCheck.reason}, existing=${_r9fPrimeDupCheck.existingDeal.id} (status=${_r9fPrimeDupCheck.existingDeal.status}). Alerting admin + skipping deal-create.`);
          await sendDuplicateAlertToAdmin(email, _r9fPrimeDupCheck.existingDeal, _r9fPrimeExtract, _r9fPrimeDupCheck.reason);
          return;
        }

        // FRANCO-Q7 (2026-05-28): non-Canadian SUBJECT-PROPERTY auto-decline.
        // Franco's rule: Canadian property + non-Canadian borrower = process
        // normally; non-Canadian PROPERTY = decline. Detection is property-region
        // scoped + conservative (strong structural US signals only) — see
        // cFields.detectNonCanadianProperty. Placed pre-create so non-Canadian
        // properties don't consume full processing. On detect: polite broker
        // decline + admin alert + skip create (mirrors R9-F / R9-F' convention).
        const _q7NonCanadian = cFields.detectNonCanadianProperty(email.textBody || '');
        if (_q7NonCanadian.outOfScope) {
          console.log(`FRANCO-Q7: non-Canadian property detected (${_q7NonCanadian.signal}) — declining + alerting admin + skipping deal-create.`);
          const _q7DealSummary = {
            borrower_name: email.fromName,
            sender_name: email.fromName,
            sender_type: 'broker',
          };
          const _q7Greeting = aiService.parseBrokerFirstName(email.textBody);
          const _q7DeclineEmail = await aiService.generateRejectionEmail(
            _q7DealSummary,
            'our underwriting is currently limited to properties located in Canada',
            { greetingFirstName: _q7Greeting }
          );
          await emailService.sendEmail(
            email.from,
            `Re: ${email.subject || 'Your mortgage inquiry'}`,
            _q7DeclineEmail.replace(/<[^>]*>/g, ''),
            _q7DeclineEmail
          );
          await emailService.sendEmail(
            config.adminEmail,
            `[Out of Scope] Non-Canadian property auto-declined — ${email.fromName || 'unnamed'}`,
            `Vienna auto-declined a submission because the SUBJECT PROPERTY appears to be outside Canada.\n\nSignal: ${_q7NonCanadian.signal}\nFrom: ${email.fromName || '(empty)'} <${email.from}>\nSubject: ${email.subject || '(empty)'}\n\nProperty region (first 300 chars of body):\n${(email.textBody || '').slice(0, 300)}\n\nNo deal record was created. Borrower location is NOT a decline trigger (per Franco Q7) — if this property IS in Canada, reply directly to the broker.\n\n(Automatic — FRANCO-Q7 non-Canadian-property gate, conservative strong-signal detection.)`,
            null,
            [],
            []
          );
          return;
        }

        // Create deal in database
        const deal = await dealsService.create({
          email: email.from,
          borrower_name: email.fromName,
        });
        createdDeal = deal;

        // Save inbound message
        await dealsService.saveMessage(deal.id, 'inbound', email.subject, email.textBody);

        // ──────────────────────────────────────────────────────────────────
        // ADMIN-HANDOFF LINK-SUBMISSION 4-step branch (zero attachments + file-hosting link)
        // ──────────────────────────────────────────────────────────────────
        // When broker submits with ZERO attachments + a recognized file-
        // hosting link in the body: (a) flip the deal to admin_controlled=true,
        // (b) send broker a JS-rendered holding ack (no claim of docs received,
        // no Vienna processing promise), (c) send admin a handoff with the
        // broker's verbatim message + detected service+URL, (d) return early —
        // no processInitialEmail, no welcome, no missing-docs intake. Vienna
        // emits nothing else on this deal; the structural gate at the top of
        // this handler routes future broker inbound to NOTIFY-ADMIN-ONLY.
        const _ahLink = detectFileHostingLinksInBody(email.textBody);
        const _ahIsLinkOnly = email.attachments.length === 0 && _ahLink.hasLink;
        if (_ahIsLinkOnly) {
          console.log(`ADMIN-HANDOFF LINK-SUBMISSION: link-only submission detected (${_ahLink.service}: ${_ahLink.url}) — flipping deal ${deal.id} to admin_controlled=true; Vienna paused.`);
          // (a) Set admin_controlled = true on the deal (per-deal scoped).
          await dealsService.update(deal.id, { admin_controlled: true });
          // (b) Send broker LINK_SUBMISSION_HOLDING acknowledgment (JS-rendered,
          //     no Claude — deterministic, no fabrication surface). Broker-name
          //     personalized via R10-B parseBrokerFirstName resolver chain
          //     (body-prose primary, R8-A signature fallback); falls back to
          //     "Hi there!" on null. R10-B upgrade from C.7/R8-A signature-only
          //     path closes the Round-6 Donna/Jerome/Simone/Harpreet shapes.
          const _ahBrokerFirstName = aiService.parseBrokerFirstName(email.textBody);
          const _ahGreeting = _ahBrokerFirstName ? `Hi ${_ahBrokerFirstName},` : 'Hi there,';
          const _ahHoldingBody = `<p>${_ahGreeting}</p>
<p>Thanks for the submission — got your email. Someone from our team will review the file and be in touch shortly.</p>
<p>Vienna<br>Private Mortgage Link</p>`;
          await emailService.sendEmail(
            email.from,
            `Re: ${email.subject || 'Mortgage submission'}`,
            _ahHoldingBody.replace(/<[^>]*>/g, ''),
            _ahHoldingBody
          );
          // Save Vienna's outbound ack to the deal thread.
          await dealsService.saveMessage(deal.id, 'outbound', `Re: ${email.subject || 'Mortgage submission'}`, _ahHoldingBody);
          // (c) Send admin ADMIN_LINK_HANDOFF notification.
          const _ahAdminSubject = `ACTION REQUIRED: Link-only submission — ${email.fromName || email.from}`;
          const _ahAdminBody = `<p>Broker submitted a deal via <strong>${_ahLink.service}</strong> link (no attachments). Vienna has been paused on this deal — action manually.</p>
<p><strong>Deal:</strong> ${deal.id}</p>
<p><strong>From:</strong> ${email.from}</p>
<p><strong>Subject:</strong> ${email.subject || '(no subject)'}</p>
<p><strong>Service:</strong> ${_ahLink.service}</p>
<p><strong>Link:</strong> <a href="${_ahLink.url}">${_ahLink.url}</a></p>
<hr>
<h3>Original broker message</h3>
<div>${(email.textBody || '').replace(/\n/g, '<br>')}</div>
<hr>
<p><em>This deal is admin-controlled. Vienna will NOT respond to further broker emails on this thread — action manually and / or update the deal's admin_controlled flag once docs are attached.</em></p>`;
          await emailService.sendEmail(
            config.adminEmail,
            _ahAdminSubject,
            _ahAdminBody.replace(/<[^>]*>/g, ''),
            _ahAdminBody
          );
          await dealsService.saveMessage(deal.id, 'outbound', _ahAdminSubject, _ahAdminBody);
          // (d) Return early — no processInitialEmail, no attachment
          //     processing, no downstream automation.
          console.log(`ADMIN-HANDOFF LINK-SUBMISSION complete for deal ${deal.id}: broker holding ack + admin handoff sent. Returning early.`);
          return;
        }

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
        // R6-γ (2026-05-21): consumer-side lender source filter — see helper docblock.
        // R6-α (2026-05-21): composed outside R6-γ — loan_amount doc-authoritative filter.
        const _bCanonicalPromptCtx = (_bDetect.canonical_map && Object.keys(_bDetect.canonical_map).length > 0)
          ? dEngine.formatCanonicalFieldsForPrompt(
              dEngine.filterCanonicalLoanAmountForDocAuthoritative(
                dEngine.filterCanonicalLenderForPayoutOnly(_bDetect.canonical_map)
              )
            )
          : '';
        if (_bDiscrepancyDetected) {
          console.log(`B-2b: pre-Claude discrepancy detection fired — ${_bBrokerFacing.length} broker-facing entries (${_bDetect.discrepancy_set.length} total before separability filter). Prompt instructed NO-GENERATE-DISCREPANCY; JS will inject section post-Claude.`);
        }

        // Single Claude call: generate welcome email + deal summary together
        // Passes pre-extracted text from savedDocs — no second pdf-parse run
        console.log('Processing initial email with Claude...');
        console.log('Passing', email.attachments.length, 'attachments for analysis');
        if (initialFromCollision) console.log('From-header collides with admin first name — instructing generic greeting');
        // R4-Bucket-C.7 (S4 Marcus 1f1e7ac4): deterministic broker-signature
        // first-name parse BEFORE Claude. R10-B (2026-05-27) upgrade: uses
        // parseBrokerFirstName resolver chain (body-prose self-ID "My name
        // is X from Y" primary; R8-A signature anchor fallback). RFC-footer-
        // strip + admin-name filter + company-suffix filter + common-word
        // filter all live inside the shared validator. When resolver returns
        // non-null, processInitialEmail uses the name deterministically. When
        // resolver returns null, generic "Hi there!" fallback fires — same
        // safe failure direction.
        const _c7ParsedBrokerName = aiService.parseBrokerFirstName(email.textBody);
        if (_c7ParsedBrokerName) {
          console.log(`C.7: signature parser extracted broker first name "${_c7ParsedBrokerName}" — passing to processInitialEmail for deterministic greeting`);
        }
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
          { discrepancyDetected: _bDiscrepancyDetected, canonicalFieldsPrompt: _bCanonicalPromptCtx, parsedBrokerFirstName: _c7ParsedBrokerName }
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
        // R8-B (2026-05-22): post-gen "Perfect"-opener sweep. Runs AFTER
        // enforceNoRoutingLeak (R5-C-CASCADE-COMPOSITION precedent — single
        // pass, additive). Empirical corpus: 10 production hits across 9
        // deals / 3 months despite 8+ prompt ban repetitions (Nadia S15
        // anchor — see scripts/r8beta-corpus-grep.js). Q3-(b) REWRITE-WITH-
        // NAME verdict for Shape B; strip-in-place for Shape A.
        {
          const _r8bSweep = aiService.stripPerfectOpener(welcomeEmail);
          welcomeEmail = _r8bSweep.swept;
          if (_r8bSweep.sweptAny) console.log(`R8-B: "Perfect"-opener sweep neutralized opener in welcomeEmail`);
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
        // Bug 1 (2026-05-28): canonical high-LTV signal for the intake-forms +
        // asked-items gates (was dealSummary.ltv_percent — LLM additive-for-refi
        // → 56% refi wrongly treated as high-LTV deferred, skipping forms). Same
        // canonical escalation decision the LTV-gate block below uses. (Separate
        // extractCanonicalFields from the LTV-gate block's — small duplicate,
        // isolated to avoid reordering the verified escalation gate.)
        const _bug1IntakeCanon = cFields.extractCanonicalFields(email.textBody, savedDocs.map(d => ({ file_name: d.file_name, classification: d.classification, text: d?.extracted_data?.text || '' })), { emailSubject: email.subject || '' });
        const _bug1IntakeCombined = dEngine.computeCombinedLtv(_bug1IntakeCanon);
        const _bug1IntakeHighLtv = dEngine.shouldEscalateOnAnyLtv({
          standaloneLtv: dEngine.computeStandaloneLtv(_bug1IntakeCanon),
          combinedLtv: _bug1IntakeCombined ? _bug1IntakeCombined.combined_ltv_percent : null,
        });
        const deferredIntake = shouldSkipIntakeFormsForDeferredState(dealSummary, _bug1IntakeHighLtv);
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
        const intakeAskedItems = computeIntakeAskedItems(dealSummary, initialClassifications, _bug1IntakeHighLtv);
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

        // R4-RESIDUAL-1: compute combined-LTV for the escalation gate using the
        // NARROWEST pure path (extractCanonicalFields + computeCombinedLtv —
        // confirmed side-effect-free, no B-pipeline injection or admin-Snapshot
        // side effects at this site). Falls back to null on clean first-mortgage
        // deals (no existing_first_mortgage_balance) → standalone-only gate
        // applies, preserving the C.4 Linda-Okafor over-fire negative.
        const _r1InitialCanonicalMap = cFields.extractCanonicalFields(email.textBody, savedDocs.map(d => ({ file_name: d.file_name, classification: d.classification, text: d?.extracted_data?.text || '' })), { emailSubject: email.subject || '' });
        const _r1InitialCombined = dEngine.computeCombinedLtv(_r1InitialCanonicalMap);
        const _r1InitialCombinedLtv = _r1InitialCombined ? _r1InitialCombined.combined_ltv_percent : null;
        // Bug 1 (2026-05-28): escalation/prelim gates consume the CANONICAL
        // standalone LTV, not dealSummary.ltv_percent (the LLM computes that
        // additively for refinances → a clean 56% refi wrongly escalated for
        // collateral at "103% LTV"). Canonical standalone falls back to the LLM
        // value only when canonical_map lacks loan/value tuples (no regression
        // on shapes where canonical can't compute).
        const _r1InitialStandaloneLtv = dEngine.computeStandaloneLtv(_r1InitialCanonicalMap) ?? initialLtv;
        const _r1InitialShouldEscalate = dEngine.shouldEscalateOnAnyLtv({
          standaloneLtv: _r1InitialStandaloneLtv,
          combinedLtv: _r1InitialCombinedLtv,
        });

        if (dealSummary?.identity_clash) {
          // Group HHH (S15.1): identity gate runs FIRST, before LTV gates. Vienna's
          // welcome email asks ONLY for the borrower-name clarification (per the
          // IDENTITY CLASH block in INITIAL_EMAIL_PROMPT); doc requests and the
          // collateral question are deferred until identity is resolved. Admin sees
          // nothing during this state — same silent-pending pattern as Fix 7.
          console.log('Initial submission identity_clash=true — entering awaiting_identity_confirmation state (HHH)');
          await dealsService.update(deal.id, { status: 'awaiting_identity_confirmation' });
        } else if (_r1InitialShouldEscalate) {
          // Fix 7 + R4-RESIDUAL-1: do NOT escalate immediately. Set status to
          // 'awaiting_collateral'. ADDITIVE escalation trigger — fires if
          // standalone > 80 (existing behavior, S4 Ryan preserved) OR
          // combined > COMBINED_LTV_ESCALATION_THRESHOLD_PCT (NEW — captures
          // the dangerous-leverage case a 2nd mortgage with standalone ≤80 but
          // combined >80 was previously not flagging).
          const _r1Reason = (_r1InitialStandaloneLtv && _r1InitialStandaloneLtv > 80)
            ? `standalone LTV ${_r1InitialStandaloneLtv}% > 80`
            : `combined LTV ${_r1InitialCombinedLtv}% > ${dEngine.COMBINED_LTV_ESCALATION_THRESHOLD_PCT} (standalone ${_r1InitialStandaloneLtv ?? 'null'}% under threshold)`;
          console.log(`Initial submission escalation gate triggered (Fix 7 + R4-RESIDUAL-1): ${_r1Reason} — entering awaiting_collateral state`);
          await dealsService.update(deal.id, { status: 'awaiting_collateral' });
        } else if (_r1InitialStandaloneLtv && _r1InitialStandaloneLtv <= 80 && initialHasReviewableDoc) {
          // R5-B-2 (2026-05-21): discrepancy-resolution gate at the initial-
          // submission trigger. Pre-B-2, Sandra Nathan (ffb4fa0c) + Sandra
          // Jennifer (112b619a) + Lena (8486bf8a) all fired premature
          // prelim here while Vienna was simultaneously asking the broker
          // to clarify a figure discrepancy. Hold the trigger until the
          // discrepancy resolves; broker reply still sends (welcome email
          // contains the clarification ask). Next broker turn re-evaluates
          // via the active-branch gate.
          const _b2HoldInitial = shouldHoldPrelimForDiscrepancy({
            brokerFacingDiscrepancyCount: _bBrokerFacing.length,
            brokerFacingReplyText: welcomeEmail,
            summary: dealSummary,
          });
          if (_b2HoldInitial) {
            const _b2Clar = aiService.welcomeEmailIsAskingClarification(welcomeEmail || '');
            console.log(`B-2 (initial-submission): prelim held — discrepancy/clarification pending broker confirmation. structuredDiscrepancyCount=${_bBrokerFacing.length}, clarificationPending=${_b2Clar}, qqqq=${!!dealSummary?.unresolved_discrepancy}. Deal stays 'active'; broker reply still sent.`);
          } else {
            console.log(`Initial submission canonical standalone LTV ${_r1InitialStandaloneLtv}% <= 80 with reviewable doc — sending preliminary review immediately (BBBB-relaxed: exit_strategy gap surfaces as [MISSING] in admin prelim, not a hold-gate; initialHasExitStrategy=${initialHasExitStrategy})`);
            // ownership_type is null on initial submission (only set later by generateBrokerResponse).
            // Fix 6 closed the display side: generateLeadSummary now renders "Ownership Type: TBD"
            // when null. The remaining (deferred) enhancement is to extract ownership_type directly
            // in INITIAL_EMAIL_PROMPT's TASK 2 JSON so it's populated on day 1.
            // Cluster D: pass welcomeEmail so sendPreliminaryReviewToAdmin can detect
            // a pending broker-facing clarification ask and suppress COMPLETE.
            await sendPreliminaryReviewToAdmin(deal, dealSummary, null, _r1InitialStandaloneLtv, { brokerFacingReplyText: welcomeEmail });
          }
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
          // R5-D Surface B (2026-05-21): set was_in_identity_clash=true as a
          // persistent marker on the deal. Used downstream at the active-branch
          // routing decision to detect post-clash arc and route subsequent
          // broker turns through processInitialEmail-equivalent intake template
          // (instead of generateBrokerResponse) until form-requirements are
          // fulfilled. Resolves Anna 11196627 R4-S15 Bug 2+3: pre-R5-D, the
          // post-clash followup turns went through generateBrokerResponse which
          // has no form-attachment logic + no own-forms-acceptance language,
          // leaving PNW Statement Form unmentioned/unattached across multiple
          // turns. identity_clash flips to false (resolution complete);
          // was_in_identity_clash stays true (arc marker, NEVER reset by
          // subsequent broker turns).
          const updatedExtracted = {
            ...(existingDeal.extracted_data || {}),
            identity_clash: false,
            was_in_identity_clash: true,
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
        // R6-γ (2026-05-21): consumer-side lender source filter — see helper docblock.
        // R6-α (2026-05-21): composed outside R6-γ — loan_amount doc-authoritative filter.
        const _bCanonicalCtxReview = (_bDetectReview.canonical_map && Object.keys(_bDetectReview.canonical_map).length > 0)
          ? dEngine.formatCanonicalFieldsForPrompt(
              dEngine.filterCanonicalLoanAmountForDocAuthoritative(
                dEngine.filterCanonicalLenderForPayoutOnly(_bDetectReview.canonical_map)
              )
            )
          : '';
        if (_bDiscrepancyDetectedReview) {
          console.log(`B-2b (review path): pre-Claude discrepancy detection fired — ${_bBrokerFacingReview.length} broker-facing entries`);
        }

        // R5-E refined (2026-05-21): JS-side greeting selection. broker_name >
        // sender_name (broker turns) / borrower_name > sender_name (borrower turns),
        // anti-collided against admin's first name. Null when no defensible target
        // exists → prompt instructs Vienna to use generic "Hi there!".
        const _eReviewGreeting = selectGreetingFirstName({
          broker_name: reviewSummaryIn?.broker_name,
          sender_name: reviewSummaryIn?.sender_name,
          borrower_name: reviewSummaryIn?.borrower_name,
          sender_type: reviewSummaryIn?.sender_type,
        });
        // R6-ζ (2026-05-21): structured signal for forbidden-non-sequitur-openers
        // block in ai.js — see helper docblock at brokerRepliedSinceLastViennaOutbound.
        const _zReviewBrokerReplied = brokerRepliedSinceLastViennaOutbound(reviewConversationHistory);
        const reviewResult = await aiService.generateBrokerResponse(
          email.textBody,
          email.attachments,
          savedDocs,
          reviewSummaryIn,
          labeledReviewHistory,
          reviewDocumentsOnFile,
          existingDeal.status,
          { discrepancyDetected: _bDiscrepancyDetectedReview, canonicalFieldsPrompt: _bCanonicalCtxReview, greetingFirstName: _eReviewGreeting, brokerRepliedSinceLastViennaOutbound: _zReviewBrokerReplied }
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
        // R8-B: "Perfect"-opener sweep on review-path reply (cascade-composes AFTER E).
        if (reviewResult.responseEmail) {
          const _r8bSweep = aiService.stripPerfectOpener(reviewResult.responseEmail);
          reviewResult.responseEmail = _r8bSweep.swept;
          if (_r8bSweep.sweptAny) console.log(`R8-B: "Perfect"-opener sweep neutralized opener in review-path responseEmail`);
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
          // under_review (hasNewDocs=false). No admin-facing emission — pre-C.1
          // this branch fired completion-handoff (S7: [File Complete] on a
          // clarification reply, file complete but admin hadn't approved) or
          // preliminary-update (S8: redundant [UPDATED] PRELIMINARY with no
          // state change). C.1 correctly suppressed the WRONG admin signal.
          //
          // R4-Bucket-C.5 (Ethan no-ack fix): ship Vienna's broker-facing
          // responseEmail to broker. generateBrokerResponse already ran
          // upstream (L1762-1777), passing through B-strip+inject + E-sweep,
          // so the reply is content-filtered. Admin emission stays zero
          // (C.1 invariant preserved — load-bearing regression-direction).
          //
          // C.1/C.5 boundary closure (option b — grounded against real
          // R4-S1 Grace + R3-S7 Ethan artifacts): admin already has signal
          // from prior PRELIMINARY-CLARIFICATION (Bucket B) on this branch,
          // and deal state updates at L1801-1808 reflect the broker's
          // resolution; no separate admin "resolved-signal" added in MVP.
          if (reviewResult.responseEmail) {
            emailService.sendEmailDelayed(
              email.from,
              `Re: ${email.subject}`,
              reviewResult.responseEmail.replace(/<[^>]*>/g, ''),
              reviewResult.responseEmail,
              [],
              [],
              async (sendResult) => {
                await dealsService.saveMessage(existingDeal.id, 'outbound', `Re: ${email.subject}`, reviewResult.responseEmail, sendResult.MessageID);
                console.log('C.5: Vienna broker-facing reply shipped on text-only-noop branch (admin emission still zero per C.1 invariant)');
              }
            );
          }
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

        // ──────────────────────────────────────────────────────────────────
        // R5-D Surface B (2026-05-21): post-clash arc → intake-template routing.
        //
        // When this deal was once in identity-clash (was_in_identity_clash=true,
        // persisted at the identity-clash resolution point above) AND form-
        // requirements are still unfulfilled (broker hasn't provided both their
        // own loan-app and own PNW), re-invoke processInitialEmail on this turn
        // to generate an intake-template response with PNW Form attachment +
        // own-forms acceptance language. Bypasses generateBrokerResponse for
        // these specific turns. Once forms are fulfilled, normal active-branch
        // flow resumes (or the deal reaches prelim/complete state via other gates).
        //
        // SAFE RE-INVOCATION (load-bearing design-decision note): processInitial-
        // Email has NO DB side effects — all state writes (deal scaffold, document
        // persistence, saveMessage, form-attachment send) live in this caller at
        // L1714-1830 (new-deal branch). The function itself is pure modulo the
        // stateless Claude API call. The remaining concern (JS-side identity-
        // clash recheck firing again at ai.js:1005-1015) is semantically correct
        // on re-fire: if docs now match, recheck returns false → normal intake;
        // if docs are still misattributed, recheck routes to minimal-ask again,
        // which is the right behavior. Verdict-revised from B-i to B-ii after
        // empirical inspection of processInitialEmail's body confirmed the
        // function is side-effect-free; no helper extraction needed.
        //
        // R5-E refined interaction: pre-compute selectGreetingFirstName from
        // the deal's persisted extracted_data (broker_name="Eric Johansson")
        // and pass as parsedBrokerFirstName opt — overrides the current-turn
        // C.7 parser fallback (which could return null on broker confirmation
        // turns with no signature). Anna 11196627 was the R5-E load-bearing
        // fixture; intake-template path must NOT regress its greeting.
        const _r5dWasInClash = existingDeal.extracted_data?.was_in_identity_clash === true;
        const _r5dHasOwnApp = (email.attachments || []).some(a => /application|loan.?app|summary/i.test(a.Name))
          || documentsOnFile.some(d => /application|loan.?app|summary/i.test(d.file_name || ''));
        const _r5dHasOwnPnw = (email.attachments || []).some(a => /pnw|personal.?net.?worth|net.?worth/i.test(a.Name))
          || documentsOnFile.some(d => /pnw|personal.?net.?worth|net.?worth/i.test(d.file_name || ''));
        const _r5dFormsUnfulfilled = !_r5dHasOwnApp || !_r5dHasOwnPnw;
        if (_r5dWasInClash && _r5dFormsUnfulfilled) {
          console.log(`R5-D-B (post-clash intake-template): was_in_identity_clash=true + forms unfulfilled (hasOwnApp=${_r5dHasOwnApp}, hasOwnPnw=${_r5dHasOwnPnw}) — re-invoking processInitialEmail`);

          // R5-E wiring (now R8-A parallel-signal restructure): helper passes
          // through `greetingFirstName` opt; parser passes through
          // `parsedBrokerFirstName` opt. processInitialEmail's
          // effectiveGreetingFirstName resolver chain (helper-first,
          // parser-fallback) handles the combination — functionally identical
          // to the pre-R8-A merged-at-caller pattern, but architecturally
          // clean (consumer-site resolution, Q2-(b) verdict).
          const _r5dGreetingFromHelper = selectGreetingFirstName({
            broker_name: existingDeal.extracted_data?.broker_name,
            sender_name: existingDeal.extracted_data?.sender_name,
            borrower_name: existingDeal.extracted_data?.borrower_name,
            sender_type: existingDeal.extracted_data?.sender_type,
          });
          // R10-B (2026-05-27): upgraded to parseBrokerFirstName resolver
          // chain (body-prose primary, signature fallback). Variable name
          // retains "_r5dParsedFromSig" for source-pin compatibility with
          // R5-D-B tests; the underlying resolution is now broader than
          // signature-only.
          const _r5dParsedFromSig = aiService.parseBrokerFirstName(email.textBody);
          const _r5dFromCollision = firstNameMatchesAdmin(email.fromName);

          const _r5dIntakeRes = await aiService.processInitialEmail(
            email.fromName,
            email.textBody,
            email.attachments,
            savedDocs,
            _r5dHasOwnApp,
            _r5dHasOwnPnw,
            _r5dFromCollision,
            email.subject,
            { greetingFirstName: _r5dGreetingFromHelper, parsedBrokerFirstName: _r5dParsedFromSig }
          );
          let _r5dIntakeEmail = _r5dIntakeRes.welcomeEmail;
          // R5-C: post-gen routing-leak sweep on broker-facing intake-template output
          _r5dIntakeEmail = aiService.enforceNoRoutingLeak(_r5dIntakeEmail).swept;
          // R8-B: "Perfect"-opener sweep on R5-D-B intake-template output.
          _r5dIntakeEmail = aiService.stripPerfectOpener(_r5dIntakeEmail).swept;

          // Form-attachment decision — same shape as new-deal branch L1796-1806
          // Bug 1 (2026-05-28): canonical high-LTV signal (isolated build, doc-
          // state-at-moment) instead of _r5dIntakeRes.dealSummary.ltv_percent.
          const _r5dCanonDocs = await dealsService.getDocumentsWithText(existingDeal.id);
          const _r5dCanon = cFields.extractCanonicalFields(email.textBody, _r5dCanonDocs.map(d => ({ file_name: d.file_name, classification: d.classification, text: d?.extracted_data?.text || '' })), { emailSubject: email.subject || '' });
          const _r5dCanonCombined = dEngine.computeCombinedLtv(_r5dCanon);
          const _r5dHighLtv = dEngine.shouldEscalateOnAnyLtv({
            standaloneLtv: dEngine.computeStandaloneLtv(_r5dCanon),
            combinedLtv: _r5dCanonCombined ? _r5dCanonCombined.combined_ltv_percent : null,
          });
          const _r5dDeferredIntake = shouldSkipIntakeFormsForDeferredState(_r5dIntakeRes.dealSummary, _r5dHighLtv);
          const _r5dSkipApp = _r5dDeferredIntake || _r5dHasOwnApp;
          const _r5dSkipPnw = _r5dDeferredIntake || _r5dHasOwnPnw;
          const _r5dFormAttachments = emailService.getFormAttachments({
            skipApplicationForm: _r5dSkipApp,
            skipPnwForm: _r5dSkipPnw,
          });
          console.log(`R5-D-B: attaching ${_r5dFormAttachments.length} form(s) (skipApp=${_r5dSkipApp}, skipPnw=${_r5dSkipPnw})`);

          emailService.sendEmailDelayed(
            email.from,
            `Re: ${email.subject}`,
            _r5dIntakeEmail.replace(/<[^>]*>/g, ''),
            _r5dIntakeEmail,
            _r5dFormAttachments,
            [],
            async (sendResult) => {
              await dealsService.saveMessage(existingDeal.id, 'outbound', `Re: ${email.subject}`, _r5dIntakeEmail, sendResult.MessageID);
              console.log('R5-D-B: intake-template response shipped on post-clash arc');
            }
          );

          // Persist updated extracted_data (merge re-extracted intake summary with
          // the preserved was_in_identity_clash marker). has_application_form /
          // has_pnw_statement reflect current-turn form-presence.
          const _r5dMergedSummary = {
            ...(existingDeal.extracted_data || {}),
            ...(_r5dIntakeRes.dealSummary || {}),
            was_in_identity_clash: true,  // marker NEVER reset (R5-D-B invariant)
          };
          await dealsService.update(existingDeal.id, {
            extracted_data: _r5dMergedSummary,
            has_application_form: _r5dHasOwnApp,
            has_pnw_statement: _r5dHasOwnPnw,
          });

          return;  // R5-D-B: skip remaining active-branch processing this turn
        }

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
        // R6-κ (2026-05-21): suppress redundant ask when R6-κ already
        // consolidated AML/PEP into the admin-approval-time doc request.
        // aml_pep_requested_at stamped by both admin-approval branches at
        // L1496 + L1582; null otherwise → KKKK fires normally for any path
        // that did not go through R6-κ's consolidation (defense-in-depth,
        // includes the deferred 'conditions' intent path per Q2 verdict).
        const postApprovalAmlPepAsk = !!existingDeal.prelim_approved_at
          && activeIntakeComplete
          && (!activeAmlOnFile || !activePepOnFile)
          && !existingDeal.aml_pep_requested_at;

        // R9-A' (2026-05-26): post-approval AML/PEP pending receipt — fires
        // AFTER aml_pep_requested_at stamped but BEFORE AML+PEP land in docs.
        // Sibling signal to postApprovalAmlPepAsk above (which fires when
        // the request hasn't gone out yet). Derek df33cdbf empirical
        // fixture: broker claimed "AML/PEP attached" at msg #10 but zero
        // docs arrived → Vienna emitted "we now have everything we need for
        // Derek's file and can proceed with our review." R9-A' signal feeds
        // a new prompt ban-block forbidding completion-shape language +
        // ask-to-resend directive when this state is detected. See
        // isPostApprovalAmlPepPending docblock at file scope for full
        // architectural family + verdict provenance.
        const postApprovalAmlPepPending = isPostApprovalAmlPepPending(existingDeal, activeDocsClassifications);

        // Group OOOO (S6.1): pre-approval enumeration of items blocking the
        // willReview gate. JS-computed signal → generateBrokerResponse's
        // stillMissingBlock injection. Same JS-flag-into-prompt pattern as
        // KKKK's postApprovalAmlPepAsk. Production case (Kevin Tran
        // 2026-05-16, deal ef05f551): exit_strategy null → willReview held
        // correctly but Vienna over-promised "we have everything we need
        // to send the file for review", stalling the file. OOOO suppresses
        // that template + enumerates the actual outstanding items.
        const activeIdentityClashUnresolved = !!summaryIn?.identity_clash;
        // Bug 1 (2026-05-28): canonical high-LTV signal for the missing-docs gate
        // (was summary.ltv_percent — LLM additive-for-refi). Isolated build here
        // captures doc-state at THIS gate's moment.
        // DEFERRED-RESIDUAL (R10-D docblock discipline): this is a separate
        // getDocumentsWithText + extractCanonicalFields from the escalation
        // block's _r1Active build (~L3825). Could collapse to a single build IF
        // the active branch is confirmed NOT to mutate/reclassify docs between
        // here and the escalation block — NOT yet confirmed, so the isolated
        // build (doc-state-at-moment correctness) is the safe default.
        const _bug1ActiveDocsText = await dealsService.getDocumentsWithText(existingDeal.id);
        const _bug1ActiveCanon = cFields.extractCanonicalFields(email.textBody, _bug1ActiveDocsText.map(d => ({ file_name: d.file_name, classification: d.classification, text: d?.extracted_data?.text || '' })), { emailSubject: email.subject || '' });
        const _bug1ActiveCombined = dEngine.computeCombinedLtv(_bug1ActiveCanon);
        const _bug1ActiveHighLtv = dEngine.shouldEscalateOnAnyLtv({
          standaloneLtv: dEngine.computeStandaloneLtv(_bug1ActiveCanon),
          combinedLtv: _bug1ActiveCombined ? _bug1ActiveCombined.combined_ltv_percent : null,
        });
        const stillMissingForReview = computeStillMissingForReview({
          deal: existingDeal,
          summary: summaryIn,
          classifications: activeDocsClassifications,
          identityClashUnresolved: activeIdentityClashUnresolved,
          highLtv: _bug1ActiveHighLtv,
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
        // R6-γ (2026-05-21): consumer-side lender source filter — see helper docblock.
        // R6-α (2026-05-21): composed outside R6-γ — loan_amount doc-authoritative filter.
        const _bCanonicalCtxActive = (_bDetectActive.canonical_map && Object.keys(_bDetectActive.canonical_map).length > 0)
          ? dEngine.formatCanonicalFieldsForPrompt(
              dEngine.filterCanonicalLoanAmountForDocAuthoritative(
                dEngine.filterCanonicalLenderForPayoutOnly(_bDetectActive.canonical_map)
              )
            )
          : '';
        if (_bDiscrepancyDetectedActive) {
          console.log(`B-2b (active path): pre-Claude discrepancy detection fired — ${_bBrokerFacingActive.length} broker-facing entries`);
        }

        // R5-E refined (2026-05-21): JS-side greeting selection — same shape as
        // review-path call site. Computed once per turn from summaryIn fields.
        const _eActiveGreeting = selectGreetingFirstName({
          broker_name: summaryIn?.broker_name,
          sender_name: summaryIn?.sender_name,
          borrower_name: summaryIn?.borrower_name,
          sender_type: summaryIn?.sender_type,
        });
        // R6-ζ (2026-05-21): structured signal for forbidden-non-sequitur-openers
        // block — see helper docblock at brokerRepliedSinceLastViennaOutbound.
        const _zActiveBrokerReplied = brokerRepliedSinceLastViennaOutbound(conversationHistory);
        const result = await aiService.generateBrokerResponse(
          email.textBody,
          email.attachments,
          savedDocs,
          summaryIn,
          labeledActiveHistory,
          documentsOnFile,
          existingDeal.status,
          { postApprovalAmlPepAsk, postApprovalAmlPepPending, stillMissingForReview, discrepancyDetected: _bDiscrepancyDetectedActive, canonicalFieldsPrompt: _bCanonicalCtxActive, greetingFirstName: _eActiveGreeting, brokerRepliedSinceLastViennaOutbound: _zActiveBrokerReplied }
        );
        // R10-C-1 (2026-05-27): active-branch dedicated-generator bypass for
        // the high-LTV collateral-question workflow. Closes Bug 4-? empirical
        // (Ryan/Donna 45bd01df msg[3] + msg[5] outbounds bypassed the HIGH LTV
        // prompt block at ai.js:2052-2059 and asked for intake docs instead).
        //
        // Gate condition: status='awaiting_collateral' AND broker hasn't
        // offered collateral yet (per the existing collateralAlreadyOffered
        // derivation pattern at L3625-3626, hoisted here for the gate). Same
        // gate semantic as willGoToCollateralCheck at L3654 but applied to
        // the broker-facing responseEmail rather than the DB-status routing.
        //
        // Wiring: REPLACE result.responseEmail with the dedicated generator's
        // output. result.updatedSummary preserved (Task 2 still runs — deal
        // metadata + LTV recompute remain authoritative). Subsequent sweeps
        // (discrepancy strip+inject, enforceNoRoutingLeak, stripPerfectOpener)
        // cascade-compose normally on the dedicated output — preserved per
        // R5-C-CASCADE-COMPOSITION precedent.
        const _r10cActiveCollateralOffered = !!existingDeal.extracted_data?.collateral_offered
          || !!result.updatedSummary?.collateral_offered;
        if (existingDeal.status === 'awaiting_collateral' && !_r10cActiveCollateralOffered && result.responseEmail) {
          console.log(`R10-C-1 (active-branch): awaiting_collateral && !collateral_offered — replacing Claude responseEmail with generateHighLtvCollateralAsk output`);
          const _r10cActiveCollateralAsk = await aiService.generateHighLtvCollateralAsk(
            result.updatedSummary || summaryIn,
            _eActiveGreeting,
          );
          result.responseEmail = _r10cActiveCollateralAsk;
        }
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
        // R8-B: "Perfect"-opener sweep on active-path reply (cascade-composes AFTER E).
        if (result.responseEmail) {
          const _r8bSweep = aiService.stripPerfectOpener(result.responseEmail);
          result.responseEmail = _r8bSweep.swept;
          if (_r8bSweep.sweptAny) console.log(`R8-B: "Perfect"-opener sweep neutralized opener in active-path responseEmail`);
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
        // R4-RESIDUAL-1: compute combined-LTV via the narrowest pure path
        // (extractCanonicalFields + computeCombinedLtv — side-effect-free,
        // no B-pipeline injection at this gate). Active-branch conjunction
        // PRESERVED BYTE-IDENTICAL except the LTV term: NNNN/S7.1/S9.1
        // scope-lock requires `status==='active' && !collateralAlreadyOffered
        // && !identityClashUnresolved` unchanged — relaxing any of those
        // reopens the duplicate-prelim regression.
        const _r1ActiveDocsWithText = await dealsService.getDocumentsWithText(existingDeal.id);
        const _r1ActiveCanonicalMap = cFields.extractCanonicalFields(
          email.textBody,
          _r1ActiveDocsWithText.map(d => ({ file_name: d.file_name, classification: d.classification, text: d?.extracted_data?.text || '' })),
          { emailSubject: email.subject || '' }
        );
        const _r1ActiveCombined = dEngine.computeCombinedLtv(_r1ActiveCanonicalMap);
        const _r1ActiveCombinedLtv = _r1ActiveCombined ? _r1ActiveCombined.combined_ltv_percent : null;
        // Bug 1 (2026-05-28): canonical standalone LTV for the active-branch
        // escalation gate (was LLM `ltv`). Same rationale as the initial branch.
        const _r1ActiveStandaloneLtv = dEngine.computeStandaloneLtv(_r1ActiveCanonicalMap) ?? ltv;
        const _r1ActiveLtvShouldEscalate = dEngine.shouldEscalateOnAnyLtv({
          standaloneLtv: _r1ActiveStandaloneLtv,
          combinedLtv: _r1ActiveCombinedLtv,
        });
        const willGoToCollateralCheck = _r1ActiveLtvShouldEscalate && existingDeal.status === 'active' && !collateralAlreadyOffered && !identityClashUnresolved;
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
        const _willReviewBeforeB2 = computeWillReview({
          deal: existingDeal,
          summary: result.updatedSummary,
          classifications: classificationsForGate,
          identityClashUnresolved,
          standaloneLtv: _r1ActiveStandaloneLtv, // Bug 1: canonical, not LLM ltv_percent
        });
        // R5-B-2 (2026-05-21): Option II orthogonal gate at the call layer.
        // computeWillReview's signature + D1-D7+QQQQ truth-table preserved
        // unchanged; the new structured gate is AND'd in here. When held,
        // `willReview` resolves to false → conversational broker reply path
        // fires (broker sees the clarification ask), deal stays 'active',
        // no prelim emission. Next broker turn re-evaluates.
        const _b2HoldActive = _willReviewBeforeB2 && shouldHoldPrelimForDiscrepancy({
          brokerFacingDiscrepancyCount: _bBrokerFacingActive.length,
          brokerFacingReplyText: result.responseEmail,
          summary: result.updatedSummary,
        });
        if (_b2HoldActive) {
          const _b2ClarA = aiService.welcomeEmailIsAskingClarification(result.responseEmail || '');
          console.log(`B-2 (active-branch): prelim held — discrepancy/clarification pending broker confirmation. structuredDiscrepancyCount=${_bBrokerFacingActive.length}, clarificationPending=${_b2ClarA}, qqqq=${!!result.updatedSummary?.unresolved_discrepancy}. Deal stays 'active'; broker reply still sent.`);
        }
        const willReview = _willReviewBeforeB2 && !_b2HoldActive;

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
          // R10-F (2026-05-27): asymmetric-gate symmetry restoration.
          // _b2HoldActive already gates willReview at L3646. Without this
          // line, the 'preliminary-all-docs-in' R7-A dispatch path would
          // still fire when discrepancy is detected — Patricia Bug 5-3.
          discrepancyHold: _b2HoldActive,
        });
        // R7-A (2026-05-22): 'preliminary-all-docs-in' fires sendPreliminaryReviewToAdmin
        // when prelim_approved_at=null + all docs in. Franco S14-Bug-1 fix —
        // FIRST admin-facing review is ALWAYS PRELIMINARY, regardless of doc count.
        // Legacy 'final-review' value retained but unreachable on fresh deals
        // (see dead-code annotation at the FINAL REVIEW dispatcher block below).
        const willFireFinalReview = completionDispatch === 'final-review';
        const willFireCompletionHandoff = completionDispatch === 'completion-handoff';
        const willFirePreliminaryAllDocsIn = completionDispatch === 'preliminary-all-docs-in';

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
        if (result.responseEmail && !willFireFinalReview && !willReview && !willFireCompletionHandoff && !willFirePreliminaryAllDocsIn) {
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
        } else if (willFireFinalReview || willReview || willFireCompletionHandoff || willFirePreliminaryAllDocsIn) {
          const gateLabel = willFireCompletionHandoff
            ? 'COMPLETION HANDOFF (CCCC)'
            : willFireFinalReview ? 'FINAL REVIEW (legacy dead-code path)'
            : willFirePreliminaryAllDocsIn ? 'PRELIMINARY review (R7-A all-docs-in path)'
            : 'PRELIMINARY review';
          console.log(`Suppressing Vienna broker reply — ${gateLabel} firing to Franco; admin-drafted reply will be the next broker-facing message`);
        }
        if (willGoToCollateralCheck) {
          console.log('LTV gate active — Vienna replied conversationally AND routing deal to awaiting_collateral');
        } else if (willReview) {
          console.log('LTV gate active — Vienna reply suppressed AND sending PRELIMINARY review HITL to Franco');
        } else if (willFirePreliminaryAllDocsIn) {
          console.log('R7-A: all docs in + no prior approval — Vienna reply suppressed AND sending PRELIMINARY review HITL to Franco (S14-Bug-1 fix path)');
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
          // Bug 1 (2026-05-28): prelim-subject LTV display = canonical standalone
          // (coherent with the Snapshot's LTV row), not LLM ltv.
          await sendPreliminaryReviewToAdmin(existingDeal, result.updatedSummary, ownershipType, _r1ActiveStandaloneLtv, { brokerFacingReplyText: result.responseEmail || '' });
        } else if (willFirePreliminaryAllDocsIn) {
          // R7-A (2026-05-22): Franco S14-Bug-1 fix. When all docs in + no
          // prior approval, dispatcher routes to sendPreliminaryReviewToAdmin
          // (NOT FINAL REVIEW with COMPLETE banner). Same dispatcher as
          // willReview path → JS-injected computeAdminBanner-authoritative
          // PRELIMINARY banner; admin sees PRELIMINARY review as expected
          // for first admin-facing review.
          // Bug 1 (2026-05-28): canonical standalone LTV display (see willReview branch).
          await sendPreliminaryReviewToAdmin(existingDeal, result.updatedSummary, ownershipType, _r1ActiveStandaloneLtv, { brokerFacingReplyText: result.responseEmail || '' });
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

        // R7-A DEFENSE-IN-DEPTH UNREACHABLE — legacy pre-CCCC write-failure
        // recovery only. Franco S14-Bug-1 fix (2026-05-22) redirected the
        // prelim_approved_at=null + all-docs-in case to
        // 'preliminary-all-docs-in' dispatch → sendPreliminaryReviewToAdmin
        // (the correct PRELIMINARY-with-banner path). On fresh deals, this
        // block is unreachable: computeCompletionDispatch never returns
        // 'final-review' anymore.
        //
        // Theoretically reachable via pre-CCCC defense-in-depth write-failure
        // recovery: a deal that admin approved but where prelim_approved_at
        // stamp failed to persist (rare write-path failure between CCCC's
        // stamp and the next webhook turn). Empirically vanishingly rare;
        // arguably this block could be removed in a separate cleanup commit
        // (strict-additive R7-A discipline keeps it for now).
        //
        // COMPOUNDING-BUG NOTE: if this block ever becomes reachable again,
        // it has a SECOND defect — the FINAL REVIEW dispatcher does NOT
        // apply computeAdminBanner's JS-authoritative banner strip-and-
        // prepend that sendPreliminaryReviewToAdmin uses. Result: Claude's
        // raw "FILE STATUS: COMPLETE — Ready for Review" line survives
        // un-stripped. Future cleanup-commit author working on this block:
        // apply computeAdminBanner first if making the path live again.
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
  brokerRepliedSinceLastViennaOutbound,
  // Group EEEE: intake_asked_items snapshot computation
  computeIntakeAskedItems,
  // Group JJJJ: misattached doc filter for prelim-review gate
  eligibleDocsForGate,
  // Group LLLL: broker-thread input extraction for executeDraft header construction
  buildBrokerThreadInputs,
  // Group NNNN: active-branch willReview gate with prelim_approved_at suppression
  computeWillReview,
  // R5-B-2 (2026-05-21): discrepancy-resolution gate (OR-of-three structured signal)
  shouldHoldPrelimForDiscrepancy,
  // Group OOOO: pre-approval enumeration of items blocking the willReview gate
  computeStillMissingForReview,
  // Group RRRR: admin decline-reason extraction with mandatory full-text fallback
  extractDeclineReason,
  // R4-Bucket-B (D-extension): admin banner trichotomy + isPostApproval gate
  computeAdminBanner,
  // R9-B (2026-05-26): canonical LTV resolver (combined preferred, standalone fallback)
  computeCanonicalLtvForReview,
  // R9-D (2026-05-26): canonical existing-mortgage lender resolver (R6-γ filtered)
  computeCanonicalLenderForReview,
  // R9-A' (2026-05-26): post-approval AML/PEP pending receipt — state-derived gate signal
  isPostApprovalAmlPepPending,
  // R9-F (2026-05-26): pre-create intake classification — non-deal-entry filter
  classifyIntakeBorrower,
};
