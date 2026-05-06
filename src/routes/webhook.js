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
            // conditions — status stays, just clear draft
            await dealsService.update(existingDeal.id, { draft_email: null, draft_subject: null, draft_action: null });
            console.log('Conditions sent to broker, status unchanged');
          }
        };

        if (action === 'send') {
          console.log('Franco confirmed — sending draft as-is');
          await executeDraft(existingDeal.draft_email, existingDeal.draft_subject, existingDeal.draft_action);
        } else if (action === 'replace') {
          // Group R: Franco sent a full alternative draft. Use his text VERBATIM —
          // no Claude rewriting, no tone wrapper. Convert plain text to HTML for
          // the broker-facing send (executeDraft expects HTML). Status flow stays
          // identical to SEND/EDIT — the draft_action code drives the state advance.
          console.log('Franco sent a full corrected draft — using verbatim, no Claude rewrite');
          const replacementHtml = textToHtml(replacementText);
          await executeDraft(replacementHtml, existingDeal.draft_subject, existingDeal.draft_action);
        } else {
          console.log('Franco wants edits — revising and sending immediately');
          const revisedEmail = await aiService.reviseEmailWithEdits(
            existingDeal.draft_email,
            editInstructions,
            existingDeal.extracted_data
          );
          await executeDraft(revisedEmail, existingDeal.draft_subject, existingDeal.draft_action);
        }
        return;
      }

      // --- FIRST REPLY HANDLING (no draft pending) ---
      // Helper: save draft and send preview to Franco (replies in same thread)
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
        console.log(`Initial submission LTV ${initialLtv}% > 80 — escalating immediately`);
        await sendEscalationToAdmin(deal, dealSummary, initialLtv);
      } else if (initialLtv && initialLtv <= 80 && initialHasReviewableDoc) {
        console.log(`Initial submission LTV ${initialLtv}% <= 80 with reviewable doc — sending preliminary review immediately`);
        // TODO: ownership_type is null on initial submission (only set later by generateBrokerResponse).
        // generateLeadSummary will render "Ownership Type: null" in the deal snapshot until then.
        // Tracked separately — fix is to either extract ownership_type in INITIAL_EMAIL_PROMPT
        // or have generateLeadSummary render "TBD" when null.
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

        // Admin notification dispatch (Fix 2):
        if (hasNewDocs) {
          // New docs arrived → send UPDATED review/escalation so admin sees fresh state
          // and the standard APPROVE/DECLINE action options. Replaces the passive ping.
          console.log(`hasNewDocs=true → sending updated ${existingDeal.status === 'ltv_escalated' ? 'escalation' : 'preliminary review'} (replaces passive [Broker Update])`);
          if (existingDeal.status === 'ltv_escalated') {
            await sendEscalationToAdmin(existingDeal, reviewResult.updatedSummary, reviewLtv, { isUpdate: true });
          } else {
            await sendPreliminaryReviewToAdmin(existingDeal, reviewResult.updatedSummary, reviewOwnership, reviewLtv, { isUpdate: true });
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
              console.log('Conversational response sent to broker (during review)');
            }
          );
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

        // Check if LTV triggers escalation or preliminary review
        // High-LTV escalation fires immediately; preliminary review waits for a reviewable doc
        const willEscalate = ltv && ltv > 80 && existingDeal.status !== 'ltv_escalated';
        const willReview = ltv && ltv <= 80 && existingDeal.status === 'active' && hasReviewableDoc;

        // Group L: when the FINAL REVIEW HITL is about to fire (all docs in, no LTV gate
        // active, deal currently active), Vienna goes silent on the broker side. Per Franco:
        // "When all docs are in, Vienna should silently trigger the preliminary review to
        // admin and wait. No broker reply at this stage. The admin-approved closing draft
        // is the one and only broker-facing message." Bradley's "always send" stays for
        // willEscalate / willReview (deliberate parallel send per his commit e93f657).
        const willFireFinalReview = result.allDocsReceived && !willEscalate && !willReview && existingDeal.status === 'active';

        if (ltv && ltv <= 80 && !hasReviewableDoc) {
          console.log('LTV ≤ 80% but no reviewable docs yet (no income_proof/NOA/appraisal) — keeping Vienna conversational');
        }

        // Send Vienna's conversational reply unless the FINAL REVIEW is about to fire —
        // in that case we suppress and let Franco's eventual closing draft be the only
        // broker-facing message at this stage.
        if (result.responseEmail && !willFireFinalReview) {
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
        } else if (willFireFinalReview) {
          console.log('All docs received — suppressing Vienna broker reply; FINAL REVIEW will fire silently to Franco');
        }
        if (willEscalate || willReview) {
          console.log('LTV gate active — Vienna replied conversationally AND sending HITL to Franco');
        }

        if (willEscalate) {
          await sendEscalationToAdmin(existingDeal, result.updatedSummary, ltv);
        } else if (willReview) {
          await sendPreliminaryReviewToAdmin(existingDeal, result.updatedSummary, ownershipType, ltv);
        } else {
          // Deal already under_review or no LTV yet — keep conversation going
          if (existingDeal.status !== 'active' && existingDeal.status !== 'under_review') {
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
