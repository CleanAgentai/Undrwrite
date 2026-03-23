const express = require('express');
const router = express.Router();
const config = require('../config');
const emailService = require('../services/email');
const aiService = require('../services/ai');
const dealsService = require('../services/deals');

// Track processed message IDs to prevent duplicate processing
const processedMessages = new Set();

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
        console.log('Draft pending — checking if Franco wants to send or edit');
        const { action, editInstructions } = await aiService.parseDraftReply(email.textBody);

        // Helper: send draft to broker and advance deal
        const executeDraft = async (draftEmail, draftSubject, draftAction) => {
          // Attach Intake Form when sending approval doc request
          const draftAttachments = draftAction === 'approval_doc_request'
            ? emailService.getFormAttachments({ skipApplicationForm: true, includeIntakeForm: true }).filter(f => f.Name.includes('Intake'))
            : [];

          emailService.sendEmailDelayed(
            existingDeal.email,
            draftSubject,
            draftEmail.replace(/<[^>]*>/g, ''),
            draftEmail,
            draftAttachments,
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

        // Reply in the same thread as Franco's message
        const threadHeaders = email.messageId
          ? [{ Name: 'In-Reply-To', Value: `<${email.messageId}>` }]
          : [];

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
          // Preliminary approval — generate doc request email for remaining items
          console.log('Preliminary approval by admin — generating draft doc request for remaining items');
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
          console.log('Admin sent conditions/notes for under_review deal — generating draft');
          const polishedEmail = await aiService.generateAdminResponseEmail(existingDeal.extracted_data, message, dealMessages);
          await saveDraftAndPreview(polishedEmail, borrowerSubject, 'conditions');
        }
      } else {
        console.log(`Admin replied to deal in status ${existingDeal.status} — no escalation action taken`);
      }
      return; // Admin reply handled, stop processing
    }

    // If admin sends a new email (no thread match), ignore — don't create a deal for them
    if (isAdmin && !existingDeal) {
      console.log('Admin sent new email with no thread match — ignoring');
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

      // Check if broker already sent a loan application form
      const hasOwnApplication = email.attachments.some(a =>
        /application|loan.?app|summary/i.test(a.Name)
      );

      // Single Claude call: generate welcome email + deal summary together
      // Passes pre-extracted text from savedDocs — no second pdf-parse run
      console.log('Processing initial email with Claude...');
      console.log('Passing', email.attachments.length, 'attachments for analysis');
      const { welcomeEmail, dealSummary } = await aiService.processInitialEmail(
        email.fromName,
        email.textBody,
        email.attachments,
        savedDocs,
        hasOwnApplication
      );
      console.log('Welcome email + deal summary generated');

      // Get form attachments — skip Application Form if broker sent their own, no Intake Form in initial email
      const formAttachments = emailService.getFormAttachments({ skipApplicationForm: hasOwnApplication });
      console.log('Attaching', formAttachments.length, 'forms', hasOwnApplication ? '(skipping Application Form — broker sent their own)' : '');

      // Send the AI-generated response with forms attached (HTML formatted)
      emailService.sendEmailDelayed(
        email.from,
        `Re: ${email.subject}`,
        welcomeEmail.replace(/<[^>]*>/g, ''),
        welcomeEmail,
        formAttachments,
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
      });

      console.log('Welcome email sent, deal status: active');
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
        // Broker replied while Franco is reviewing — save docs and forward to Franco
        const statusLabel = existingDeal.status === 'ltv_escalated' ? 'Awaiting Your Approval' : 'Under Your Review';
        console.log(`Broker replied while deal is ${existingDeal.status} — saving docs and forwarding to admin`);

        const borrowerName = existingDeal.extracted_data?.borrower_name || existingDeal.borrower_name;
        const forwardBody = `<p><strong>Broker update for ${borrowerName}:</strong></p><p>${(email.textBody || '').replace(/\n/g, '<br>')}</p>${email.attachments.length > 0 ? `<p><em>${email.attachments.length} attachment(s) received and saved.</em></p>` : ''}`;
        const fwdResult = await emailService.sendEmail(
          config.adminEmail,
          `[Broker Update] ${borrowerName} — ${statusLabel}`,
          forwardBody.replace(/<[^>]*>/g, ''),
          forwardBody
        );
        await dealsService.saveMessage(existingDeal.id, 'outbound', `[Broker Update] ${borrowerName}`, forwardBody, fwdResult.MessageID);
        console.log('Broker update forwarded to admin');
      } else if (existingDeal.status === 'active') {
        // CONVERSATIONAL HANDLER — respond to broker contextually
        console.log('Generating conversational response...');

        const conversationHistory = await dealsService.getMessages(existingDeal.id);
        const documentsOnFile = await dealsService.getDocumentsByDeal(existingDeal.id);

        const result = await aiService.generateBrokerResponse(
          email.textBody,
          email.attachments,
          savedDocs,
          existingDeal.extracted_data,
          conversationHistory,
          documentsOnFile
        );

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

        // Check if LTV triggers escalation or preliminary review
        // If so, Vienna stays silent — Franco decides first
        const willEscalate = ltv && ltv > 80 && existingDeal.status !== 'ltv_escalated';
        const willReview = ltv && ltv <= 80 && existingDeal.status === 'active';

        if (!willEscalate && !willReview && result.responseEmail) {
          // Only send Vienna's reply if deal stays in conversation mode
          emailService.sendEmailDelayed(
            email.from,
            `Re: ${email.subject}`,
            result.responseEmail.replace(/<[^>]*>/g, ''),
            result.responseEmail,
            [],
            async (sendResult) => {
              await dealsService.saveMessage(existingDeal.id, 'outbound', `Re: ${email.subject}`, result.responseEmail, sendResult.MessageID);
              console.log('Conversational response sent to broker');
            }
          );
        } else if (willEscalate || willReview) {
          console.log('LTV confirmed — skipping broker reply, sending to Franco for review');
        }

        if (willEscalate) {
          // LTV > 80% — escalate to Franco for approval
          console.log(`LTV ${ltv}% > 80 — escalating to admin for approval`);
          const dealMessages = await dealsService.getMessages(existingDeal.id);
          const dealDocs = await dealsService.getDocumentsWithText(existingDeal.id);
          const escalationEmail = await aiService.generateEscalationNotification(result.updatedSummary, dealMessages, dealDocs);

          let escalationAttachments = [];
          if (dealDocs.length > 0) {
            console.log('Downloading documents for escalation zip...');
            const zipBase64 = await dealsService.downloadDocsAsZip(existingDeal.id, dealDocs);
            const safeName = (result.updatedSummary?.borrower_name || existingDeal.borrower_name || 'Unknown').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
            escalationAttachments = [{
              Name: `${safeName}_Documents.zip`,
              Content: zipBase64,
              ContentType: 'application/zip',
            }];
          }

          const escalateResult = await emailService.sendEmail(
            config.adminEmail,
            `ACTION REQUIRED: LTV Over 80% — ${result.updatedSummary?.borrower_name || existingDeal.borrower_name}`,
            escalationEmail.replace(/<[^>]*>/g, ''),
            escalationEmail,
            escalationAttachments
          );
          await dealsService.saveMessage(existingDeal.id, 'outbound', `ACTION REQUIRED: LTV Over 80% — ${result.updatedSummary?.borrower_name || existingDeal.borrower_name}`, escalationEmail, escalateResult.MessageID);
          await dealsService.update(existingDeal.id, { status: 'ltv_escalated' });
          console.log('Escalation email sent to admin, deal status: ltv_escalated');
        } else if (willReview) {
          // LTV ≤ 80% confirmed — send Franco preliminary review with docs
          console.log(`LTV ${ltv}% <= 80 — sending preliminary review to Franco`);
          const dealDocs = await dealsService.getDocumentsWithText(existingDeal.id);
          const allDocsList = await dealsService.getDocumentsByDeal(existingDeal.id);
          const classifications = allDocsList.map(d => d.classification).filter(Boolean);

          const baseRequired = ['government_id', 'appraisal', 'property_tax', 'noa', 'mortgage_statement', 'income_proof', 'credit_report'];
          const missingDocs = baseRequired.filter(req => !classifications.includes(req));

          const dealMessages = await dealsService.getMessages(existingDeal.id);
          const leadSummary = await aiService.generateLeadSummary(
            result.updatedSummary,
            ownershipType,
            dealDocs,
            missingDocs,
            dealMessages
          );

          let reviewAttachments = [];
          if (dealDocs.length > 0) {
            const zipBase64 = await dealsService.downloadDocsAsZip(existingDeal.id, dealDocs);
            const safeName = (result.updatedSummary?.borrower_name || existingDeal.borrower_name || 'Unknown').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
            reviewAttachments = [{
              Name: `${safeName}_Documents.zip`,
              Content: zipBase64,
              ContentType: 'application/zip',
            }];
          }

          const borrowerName = result.updatedSummary?.borrower_name || existingDeal.borrower_name;
          const statusFlag = missingDocs.length > 0 ? 'PRELIMINARY' : 'COMPLETE';
          const reviewResult = await emailService.sendEmail(
            config.adminEmail,
            `ACTION REQUIRED: ${statusFlag} Review — ${borrowerName} — ${ltv}% LTV`,
            leadSummary.replace(/<[^>]*>/g, ''),
            leadSummary,
            reviewAttachments
          );
          await dealsService.saveMessage(existingDeal.id, 'outbound', `ACTION REQUIRED: ${statusFlag} Review — ${borrowerName} — ${ltv}% LTV`, leadSummary, reviewResult.MessageID);
          await dealsService.update(existingDeal.id, { status: 'under_review' });
          console.log(`Preliminary review sent to Franco — deal status: under_review (${missingDocs.length} docs missing)`);
        } else {
          // Deal already under_review or no LTV yet — keep conversation going
          if (existingDeal.status !== 'active' && existingDeal.status !== 'under_review') {
            await dealsService.update(existingDeal.id, { status: 'active' });
          }
          console.log('Conversation continues — waiting for more docs/info');
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
