const express = require('express');
const router = express.Router();
const config = require('../config');
const emailService = require('../services/email');
const aiService = require('../services/ai');
const dealsService = require('../services/deals');

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

// Document classification synonyms — for the missingDocs filter, certain doc types
// satisfy other required items. Bradley's commit e4f6b89 dropped 'noa' from baseRequired
// with the comment "NOA satisfies income_proof", but the filter logic was never updated
// to actually wire in the equivalence. Bug 2 from S3 retest: deal with NOA classification
// showed "Proof of Income" in [MISSING] list of preliminary review email despite the NOA
// being on file. Map structure makes future equivalences trivial to add (T4, paystubs are
// already covered because the classifier maps them to 'income_proof' directly).
const DOC_SYNONYMS = {
  income_proof: ['income_proof', 'noa'],
};

const isDocRequirementSatisfied = (req, classifications) => {
  const accepted = DOC_SYNONYMS[req] || [req];
  return accepted.some(c => classifications.includes(c));
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
const textToHtml = (text) => {
  if (!text) return '';
  if (/<[a-z][^>]*>/i.test(text)) return text;
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
  const escalationEmail = await aiService.generateEscalationNotification(dealSummary, dealMessages, dealDocs);

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
const sendPreliminaryReviewToAdmin = async (deal, dealSummary, ownershipType, ltv, options = {}) => {
  // LTV ≤ 80% confirmed — send Franco preliminary review with docs
  console.log(`LTV ${ltv}% <= 80 — sending preliminary review to Franco${options.isUpdate ? ' (updated)' : ''}`);
  const dealDocs = await dealsService.getDocumentsWithText(deal.id);
  const allDocsList = await dealsService.getDocumentsByDeal(deal.id);
  const classifications = allDocsList.map(d => d.classification).filter(Boolean);

  // Branch the required-doc list on deal type: purchase deals don't have an existing
  // mortgage on the subject property, so no mortgage payout is needed; instead a purchase
  // contract and proof of down payment apply. Refinance/2nd mortgage need the payout.
  const loanType = (dealSummary?.loan_type || '').toLowerCase();
  const isPurchase = /purchas/.test(loanType) || /purchas/.test(dealSummary?.purpose || '');
  const baseRequired = isPurchase
    ? ['government_id', 'appraisal', 'property_tax', 'income_proof', 'credit_report', 'purchase_contract']
    : ['government_id', 'appraisal', 'property_tax', 'mortgage_statement', 'income_proof', 'credit_report'];
  // Fix 4: use isDocRequirementSatisfied so NOA satisfies income_proof per Bradley's intent.
  const missingDocs = baseRequired.filter(req => !isDocRequirementSatisfied(req, classifications));

  // Group C (S6.3/S7.3): exit_strategy is a deal-summary field, not a document
  // classification. Surface it here when null/empty so it appears in the admin's
  // preliminary review [MISSING] list and downstream draft preview. missingDocs
  // semantically becomes "missing items" — the rendering loop downstream handles
  // the non-doc key via DOC_DISPLAY_NAMES.exit_strategy. Variable name stays for
  // diff-tightness; semantic widening is comment-only.
  if (!dealSummary?.exit_strategy) missingDocs.push('exit_strategy');

  const dealMessages = await dealsService.getMessages(deal.id);
  const leadSummary = await aiService.generateLeadSummary(
    dealSummary,
    ownershipType,
    dealDocs,
    missingDocs,
    dealMessages
  );

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
  const statusFlag = missingDocs.length > 0 ? 'PRELIMINARY' : 'COMPLETE';
  const subjectPrefix = options.isUpdate ? '[UPDATED] ' : '';
  const subject = `${subjectPrefix}ACTION REQUIRED: ${statusFlag} Review — ${borrowerName} — ${ltv}% LTV`;
  const reviewResult = await emailService.sendEmail(
    config.adminEmail,
    subject,
    leadSummary.replace(/<[^>]*>/g, ''),
    leadSummary,
    reviewAttachments
  );
  await dealsService.saveMessage(deal.id, 'outbound', subject, leadSummary, reviewResult.MessageID);
  await dealsService.update(deal.id, { status: 'under_review' });
  console.log(`Preliminary review sent to Franco — deal status: under_review (${missingDocs.length} docs missing)`);
};

// Group BBB (S9.1/S9.2/S9.3): conditions-fulfilled handoff. Fires when broker
// submits new docs to a deal that already has conditions_sent_at stamped — i.e.
// admin already approved with conditions, and the broker is now satisfying them.
//
// Pre-BBB this path fired sendPreliminaryReviewToAdmin({ isUpdate: true }) which
// produced "[UPDATED] ACTION REQUIRED: PRELIMINARY Review" with redundant
// APPROVED/DECLINE prompt — admin already moved past prelim by sending conditions.
//
// New shape (two emails per Porter's S9.2 framing, both in the broker submission's
// thread for tidy admin inbox):
//   1. [Conditions Fulfilled] informational notice — no action required
//   2. Closing draft preview — saveDraftAndPreview pattern with draft_action
//      'approval_completed' so admin's SEND advances status to 'completed'
//
// Vienna's broker reply is suppressed in the call site (line ~846 — symmetric
// with Group L / GGG). The next broker-facing message is the closing email
// after admin SENDs the preview.
const sendConditionsFulfilledHandoff = async (deal, dealSummary, dealDocs, dealMessages, brokerInboundEmail) => {
  const borrowerName = dealSummary?.borrower_name || deal.borrower_name;

  // 1. Informational notice — no APPROVED/DECLINE, no action required.
  const infoSubject = `[Conditions Fulfilled] ${borrowerName} — File Complete`;
  const infoBody = `<p>Broker submitted the remaining condition docs for <strong>${borrowerName}</strong>. The file is now complete.</p><p>Closing draft preview will follow in this thread.</p>`;
  const infoResult = await emailService.sendEmail(
    config.adminEmail,
    infoSubject,
    infoBody.replace(/<[^>]*>/g, ''),
    infoBody,
    []
  );
  await dealsService.saveMessage(deal.id, 'outbound', infoSubject, infoBody, infoResult.MessageID);
  console.log('Conditions-fulfilled informational notice sent to admin');

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
  const previewHtml = `<h3>Closing Draft Preview — ${borrowerName}</h3>
<p>Conditions fulfilled. Here's the closing email Vienna will send to <strong>${deal.email}</strong>:</p>
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
        const formatThreadId = (id) => (id && id.includes('@') ? `<${id}>` : `<${id}@mtasv.net>`);
        const threadHeaders = [];
        if (email.messageId) {
          threadHeaders.push({ Name: 'In-Reply-To', Value: formatThreadId(email.messageId) });
          const chain = [...(email.references || []), email.messageId].filter(Boolean);
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

          emailService.sendEmailDelayed(
            existingDeal.email,
            draftSubject,
            draftEmail.replace(/<[^>]*>/g, ''),
            draftEmail,
            draftAttachments,
            [],
            async (result) => {
              await dealsService.saveMessage(existingDeal.id, 'outbound', draftSubject, draftEmail, result.MessageID);
              console.log('Draft sent to broker');
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
          const rejectionEmail = await aiService.generateRejectionEmail(existingDeal.extracted_data);
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
          // Check if all docs are already received — if so, this is a final completion, not a doc request
          const existingDocs = await dealsService.getDocumentsByDeal(existingDeal.id);
          const docClassifications = existingDocs.map(d => d.classification).filter(Boolean);
          // Fix 4: drop stale 'noa' from list (Bradley's e4f6b89 made NOA satisfy
          // income_proof; the duplicate item was an oversight in this site). Use
          // isDocRequirementSatisfied so NOA-only deals correctly classify as
          // all-docs-received → completion path instead of doc-request loop.
          const requiredDocs = ['government_id', 'appraisal', 'property_tax', 'income_proof', 'credit_report'];
          const stillMissing = requiredDocs.filter(req => !isDocRequirementSatisfied(req, docClassifications));

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
          const rejectionEmail = await aiService.generateRejectionEmail(existingDeal.extracted_data);
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
      console.log('Admin sent new email with no thread match — treating as referral');

      // Parse referral details from Franco's email
      const referral = await aiService.parseReferralEmail(email.textBody);
      console.log('Referral parsed:', JSON.stringify(referral));

      if (!referral.referred_email) {
        console.log('No email address found in referral — ignoring');
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
      return;
    }

    if (!existingDeal) {
      // NEW CLIENT - first contact
      console.log('New client detected, creating deal...');

      // Create deal in database
      const deal = await dealsService.create({
        email: email.from,
        borrower_name: email.fromName,
      });

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
        initialFromCollision
      );
      // Bug B Layer A: rescue sender_name/broker_name from the Postmark From-header
      // when Claude's extraction is null/Unknown/Franco-collision. F2 adds the
      // both-Franco branch — sets name_collides_with_admin: true on the summary
      // for downstream prompts (generateBrokerResponse) to read.
      dealSummary = normalizeSenderName(dealSummary, email.fromName);
      console.log('Welcome email + deal summary generated');

      // Get form attachments.
      // Borrowers always get both forms (they don't have their own).
      // Brokers skip whichever form they already provided.
      const isBorrower = dealSummary?.sender_type === 'borrower';
      const skipApp = isBorrower ? false : hasOwnApplication;
      const skipPnw = isBorrower ? false : hasOwnPnw;
      const formAttachments = emailService.getFormAttachments({ skipApplicationForm: skipApp, skipPnwForm: skipPnw });
      const skipNote = isBorrower
        ? '(borrower — always attach both)'
        : [hasOwnApplication && 'skipping Application Form', hasOwnPnw && 'skipping PNW Form'].filter(Boolean).join(', ') || '';
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
      const initialDocsForGate = await dealsService.getDocumentsByDeal(deal.id);
      const initialClassifications = initialDocsForGate.map(d => d.classification).filter(Boolean);
      const initialHasReviewableDoc = ['income_proof', 'noa', 'appraisal'].some(c => initialClassifications.includes(c));
      const initialLtv = dealSummary?.ltv_percent;

      if (initialLtv && initialLtv > 80) {
        // Fix 7: do NOT escalate immediately. Set status to 'awaiting_collateral'
        // and let Vienna's welcome email carry the collateral question. Admin sees
        // nothing until the broker confirms no-collateral (then we silently
        // escalate) or offers collateral (then status flips back to active).
        // Reverses Bradley's e93f657 parallel-fire model per Franco's S4 retest.
        console.log(`Initial submission LTV ${initialLtv}% > 80 — entering awaiting_collateral state (Fix 7)`);
        await dealsService.update(deal.id, { status: 'awaiting_collateral' });
      } else if (initialLtv && initialLtv <= 80 && initialHasReviewableDoc) {
        console.log(`Initial submission LTV ${initialLtv}% <= 80 with reviewable doc — sending preliminary review immediately`);
        // ownership_type is null on initial submission (only set later by generateBrokerResponse).
        // Fix 6 closed the display side: generateLeadSummary now renders "Ownership Type: TBD"
        // when null. The remaining (deferred) enhancement is to extract ownership_type directly
        // in INITIAL_EMAIL_PROMPT's TASK 2 JSON so it's populated on day 1.
        await sendPreliminaryReviewToAdmin(deal, dealSummary, null, initialLtv);
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
        // Items 3+4: pass deal status so Vienna's reply is state-aware (no future-tense
        // forwarding language when the file has already been sent to admin).
        const reviewResult = await aiService.generateBrokerResponse(
          email.textBody,
          email.attachments,
          savedDocs,
          reviewSummaryIn,
          reviewConversationHistory,
          reviewDocumentsOnFile,
          existingDeal.status
        );
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

        // Admin notification dispatch (Fix 2 + Group BBB):
        if (hasNewDocs) {
          if (existingDeal.conditions_sent_at) {
            // Group BBB (S9.2): admin already moved past prelim by sending conditions.
            // Broker is now fulfilling them — route to handoff (informational notice +
            // closing draft preview), NOT another [UPDATED] ACTION REQUIRED prelim
            // review. Reads conditions_sent_at column added in BBB migration; if column
            // doesn't exist yet (pre-migration), value is undefined → falsy → falls
            // through to legacy Fix 2 path. Safe deployment ordering.
            console.log('hasNewDocs=true AND conditions_sent_at set → routing to conditions-fulfilled handoff');
            const reviewDocs = await dealsService.getDocumentsWithText(existingDeal.id);
            const reviewMessages = await dealsService.getMessages(existingDeal.id);
            await sendConditionsFulfilledHandoff(existingDeal, reviewResult.updatedSummary, reviewDocs, reviewMessages, email);
          } else {
            // Original Fix 2 path: new docs arrived, admin hasn't sent conditions yet.
            // Send UPDATED review/escalation with APPROVE/DECLINE.
            console.log(`hasNewDocs=true → sending updated ${existingDeal.status === 'ltv_escalated' ? 'escalation' : 'preliminary review'} (replaces passive [Broker Update])`);
            if (existingDeal.status === 'ltv_escalated') {
              await sendEscalationToAdmin(existingDeal, reviewResult.updatedSummary, reviewLtv, { isUpdate: true });
            } else {
              await sendPreliminaryReviewToAdmin(existingDeal, reviewResult.updatedSummary, reviewOwnership, reviewLtv, { isUpdate: true });
            }
          }
        } else {
          // No attachments → broker sent a question/note, doc state unchanged. Keep
          // the passive [Broker Update] notification so admin knows broker replied;
          // no fresh review needed.
          const statusLabel = existingDeal.status === 'ltv_escalated' ? 'Awaiting Your Approval' : 'Under Your Review';
          const borrowerNameForUpdate = reviewResult.updatedSummary?.borrower_name || existingDeal.extracted_data?.borrower_name || existingDeal.borrower_name;
          const forwardBody = `<p><strong>Broker update for ${borrowerNameForUpdate}:</strong></p><p>${(email.textBody || '').replace(/\n/g, '<br>')}</p>`;
          const fwdResult = await emailService.sendEmail(
            config.adminEmail,
            `[Broker Update] ${borrowerNameForUpdate} — ${statusLabel}`,
            forwardBody.replace(/<[^>]*>/g, ''),
            forwardBody
          );
          await dealsService.saveMessage(existingDeal.id, 'outbound', `[Broker Update] ${borrowerNameForUpdate}`, forwardBody, fwdResult.MessageID);
          console.log('No new docs — sent passive [Broker Update] notification');
        }

        // Group BBB (S9.1): suppress Vienna's broker reply when conditions_sent_at
        // set AND new docs landed — the closing draft preview is the next broker-
        // facing message, after admin SENDs it. Symmetric with Group L / GGG
        // suppression patterns. Vienna's reply still fires for non-conditions-
        // fulfilled paths (broker question without docs, broker submitting before
        // conditions sent, etc.) — original behavior preserved.
        if (reviewResult.responseEmail && !(existingDeal.conditions_sent_at && hasNewDocs)) {
          emailService.sendEmailDelayed(
            email.from,
            `Re: ${email.subject}`,
            reviewResult.responseEmail.replace(/<[^>]*>/g, ''),
            reviewResult.responseEmail,
            [],
            [],
            async (sendResult) => {
              await dealsService.saveMessage(existingDeal.id, 'outbound', `Re: ${email.subject}`, reviewResult.responseEmail, sendResult.MessageID);
              console.log('Conversational response sent to broker (during review)');
            }
          );
        } else if (existingDeal.conditions_sent_at && hasNewDocs) {
          console.log('Suppressing Vienna broker reply — conditions fulfilled, closing draft preview is the next broker-facing message');
        }
      } else if (existingDeal.status === 'active') {
        // CONVERSATIONAL HANDLER — respond to broker contextually
        console.log('Generating conversational response...');

        const conversationHistory = await dealsService.getMessages(existingDeal.id);
        const documentsOnFile = await dealsService.getDocumentsByDeal(existingDeal.id);

        // Bug B Layer A: defensively normalize stored extraction before feeding it back to Claude.
        const summaryIn = normalizeSenderName(existingDeal.extracted_data, email.fromName);
        // Items 3+4: pass deal status (active here, since this is the active branch).
        // Status drives the FILE STATE block in the prompt — gates state-aware forwarding rules.
        const result = await aiService.generateBrokerResponse(
          email.textBody,
          email.attachments,
          savedDocs,
          summaryIn,
          conversationHistory,
          documentsOnFile,
          existingDeal.status
        );
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
        const docsForGate = await dealsService.getDocumentsByDeal(existingDeal.id);
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
        const willGoToCollateralCheck = ltv && ltv > 80 && existingDeal.status === 'active' && !collateralAlreadyOffered;
        const willReview = ltv && ltv <= 80 && existingDeal.status === 'active' && hasReviewableDoc;

        // Group L: when the FINAL REVIEW HITL is about to fire (all docs in, no LTV gate
        // active, deal currently active), Vienna goes silent on the broker side. Per Franco:
        // "When all docs are in, Vienna should silently trigger the preliminary review to
        // admin and wait. No broker reply at this stage. The admin-approved closing draft
        // is the one and only broker-facing message."
        const willFireFinalReview = result.allDocsReceived && !willGoToCollateralCheck && !willReview && existingDeal.status === 'active';

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
        if (result.responseEmail && !willFireFinalReview && !willReview) {
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
        } else if (willFireFinalReview || willReview) {
          const gateLabel = willFireFinalReview ? 'FINAL REVIEW' : 'PRELIMINARY review';
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
          await sendPreliminaryReviewToAdmin(existingDeal, result.updatedSummary, ownershipType, ltv);
        } else {
          // Deal already under_review or no LTV yet — keep conversation going.
          // (We do NOT auto-flip to 'active' here anymore — awaiting_collateral, completed,
          // rejected, etc. should preserve their state.)
          if (!['active', 'under_review', 'awaiting_collateral', 'ltv_escalated', 'completed', 'rejected'].includes(existingDeal.status)) {
            await dealsService.update(existingDeal.id, { status: 'active' });
          }
          console.log('Conversation continues — waiting for more docs/info');
        }

        // ALL DOCS RECEIVED — send Franco a final complete review
        if (willFireFinalReview) {
          console.log('All documents received — sending final review to Franco');
          const finalDocs = await dealsService.getDocumentsWithText(existingDeal.id);
          const finalDocsList = await dealsService.getDocumentsByDeal(existingDeal.id);
          const finalClassifications = finalDocsList.map(d => d.classification).filter(Boolean);

          // Same purchase/refinance branch for the final review checklist
          const finalLoanType = (result.updatedSummary?.loan_type || '').toLowerCase();
          const finalIsPurchase = /purchas/.test(finalLoanType) || /purchas/.test(result.updatedSummary?.purpose || '');
          const finalBaseRequired = finalIsPurchase
            ? ['government_id', 'appraisal', 'property_tax', 'income_proof', 'credit_report', 'purchase_contract']
            : ['government_id', 'appraisal', 'property_tax', 'mortgage_statement', 'income_proof', 'credit_report'];
          // Fix 4: use isDocRequirementSatisfied so NOA satisfies income_proof.
          const finalMissing = finalBaseRequired.filter(req => !isDocRequirementSatisfied(req, finalClassifications));

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
module.exports.__test__ = { sendEscalationToAdmin, sendPreliminaryReviewToAdmin, normalizeSenderName, isUnreliableName, firstNameMatchesAdmin, isDocRequirementSatisfied, DOC_SYNONYMS, ADMIN_FIRST_NAME, textToHtml };
