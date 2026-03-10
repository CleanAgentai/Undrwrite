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

      if (existingDeal.status === 'ltv_escalated') {
        const { intent, message } = await aiService.parseAdminReply(email.textBody);
        console.log('Admin intent:', intent);

        if (intent === 'approved') {
          // Approved — move to pending_documents, send broker doc request
          console.log('Deal approved by admin — advancing to pending_documents');
          const existingDocs = await dealsService.getDocumentsByDeal(existingDeal.id);
          const docRequestEmail = await aiService.generateDocumentRequestEmail(
            existingDeal.extracted_data,
            existingDeal.ownership_type,
            existingDeal.has_application_form,
            existingDeal.has_pnw_statement,
            existingDocs
          );
          await dealsService.update(existingDeal.id, { status: 'pending_documents' });
          emailService.sendEmailDelayed(
            existingDeal.email,
            `Re: ${existingDeal.extracted_data?.borrower_name || 'Your Loan Inquiry'}`,
            docRequestEmail.replace(/<[^>]*>/g, ''),
            docRequestEmail,
            [],
            async (result) => {
              await dealsService.saveMessage(existingDeal.id, 'outbound', `Re: ${existingDeal.extracted_data?.borrower_name || 'Your Loan Inquiry'}`, docRequestEmail, result.MessageID);
              console.log('Document request sent to broker, deal status: pending_documents');
            }
          );
        } else if (intent === 'rejected') {
          // Rejected — update status and send rejection email to broker
          console.log('Deal rejected by admin');
          const rejectionEmail = await aiService.generateRejectionEmail(existingDeal.extracted_data);
          await dealsService.update(existingDeal.id, { status: 'rejected' });
          emailService.sendEmailDelayed(
            existingDeal.email,
            `Re: ${existingDeal.extracted_data?.borrower_name || 'Your Loan Inquiry'}`,
            rejectionEmail.replace(/<[^>]*>/g, ''),
            rejectionEmail,
            [],
            async (result) => {
              await dealsService.saveMessage(existingDeal.id, 'outbound', `Re: ${existingDeal.extracted_data?.borrower_name || 'Your Loan Inquiry'}`, rejectionEmail, result.MessageID);
              console.log('Rejection email sent to broker, deal status: rejected');
            }
          );
        } else {
          // Conditions/notes — AI polishes Franco's reply and sends to broker
          console.log('Admin sent conditions/notes — forwarding to broker');
          const polishedEmail = await aiService.generateAdminResponseEmail(existingDeal.extracted_data, message);
          emailService.sendEmailDelayed(
            existingDeal.email,
            `Re: ${existingDeal.extracted_data?.borrower_name || 'Your Loan Inquiry'}`,
            polishedEmail.replace(/<[^>]*>/g, ''),
            polishedEmail,
            [],
            async (result) => {
              await dealsService.saveMessage(existingDeal.id, 'outbound', `Re: ${existingDeal.extracted_data?.borrower_name || 'Your Loan Inquiry'}`, polishedEmail, result.MessageID);
              console.log('Polished admin response sent to broker, deal stays in ltv_escalated');
            }
          );
        }
      } else if (existingDeal.status === 'under_review') {
        const { intent, message } = await aiService.parseAdminReply(email.textBody);
        console.log('Admin intent for under_review deal:', intent);

        if (intent === 'approved') {
          // Franco approves despite missing docs — mark completed
          console.log('Deal approved by admin despite missing docs — marking completed');
          await dealsService.update(existingDeal.id, { status: 'completed' });
          console.log('Deal status: completed');
        } else if (intent === 'rejected') {
          console.log('Deal rejected by admin');
          const rejectionEmail = await aiService.generateRejectionEmail(existingDeal.extracted_data);
          await dealsService.update(existingDeal.id, { status: 'rejected' });
          emailService.sendEmailDelayed(
            existingDeal.email,
            `Re: ${existingDeal.extracted_data?.borrower_name || 'Your Loan Inquiry'}`,
            rejectionEmail.replace(/<[^>]*>/g, ''),
            rejectionEmail,
            [],
            async (result) => {
              await dealsService.saveMessage(existingDeal.id, 'outbound', `Re: ${existingDeal.extracted_data?.borrower_name || 'Your Loan Inquiry'}`, rejectionEmail, result.MessageID);
              console.log('Rejection email sent to broker, deal status: rejected');
            }
          );
        } else {
          // Conditions/notes — forward to broker
          console.log('Admin sent conditions/notes for under_review deal — forwarding to broker');
          const polishedEmail = await aiService.generateAdminResponseEmail(existingDeal.extracted_data, message);
          emailService.sendEmailDelayed(
            existingDeal.email,
            `Re: ${existingDeal.extracted_data?.borrower_name || 'Your Loan Inquiry'}`,
            polishedEmail.replace(/<[^>]*>/g, ''),
            polishedEmail,
            [],
            async (result) => {
              await dealsService.saveMessage(existingDeal.id, 'outbound', `Re: ${existingDeal.extracted_data?.borrower_name || 'Your Loan Inquiry'}`, polishedEmail, result.MessageID);
              console.log('Polished admin response sent to broker, deal stays in under_review');
            }
          );
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

      // Single Claude call: generate welcome email + deal summary together
      // Passes pre-extracted text from savedDocs — no second pdf-parse run
      console.log('Processing initial email with Claude...');
      console.log('Passing', email.attachments.length, 'attachments for analysis');
      const { welcomeEmail, dealSummary } = await aiService.processInitialEmail(
        email.fromName,
        email.textBody,
        email.attachments,
        savedDocs
      );
      console.log('Welcome email + deal summary generated');

      // Get form attachments
      const formAttachments = emailService.getFormAttachments();
      console.log('Attaching', formAttachments.length, 'forms');

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
        status: 'documents_requested',
        extracted_data: dealSummary,
        ltv: dealSummary ? dealSummary.ltv_percent : null,
        borrower_name: dealSummary?.borrower_name || email.fromName,
      });

      console.log('Welcome email sent, deal status: documents_requested');
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

      if (existingDeal.status === 'documents_requested') {
        // STAGE 2 — Check if broker sent back the required forms
        console.log('Stage 2: Analyzing submission for required forms...');
        const analysis = await aiService.analyzeStage2Submission(
          email.textBody,
          email.attachments,
          savedDocs,
          existingDeal.extracted_data
        );
        // Merge form booleans with DB — once received, always true
        const hasApp = analysis.hasApplicationForm || existingDeal.has_application_form;
        const hasPnw = analysis.hasPnwStatement || existingDeal.has_pnw_statement;
        const ltv = analysis.updatedSummary?.ltv_percent ?? existingDeal.ltv;
        const ownershipType = analysis.ownershipType || existingDeal.ownership_type;
        const canAdvance = ltv != null && ownershipType != null;

        console.log(`Forms: App=${hasApp} PNW=${hasPnw} | Ownership: ${ownershipType} | LTV: ${ltv} | Can advance: ${canAdvance}`);

        // Save updated summary, LTV, ownership, and form booleans
        await dealsService.update(existingDeal.id, {
          extracted_data: analysis.updatedSummary,
          ltv: ltv,
          ownership_type: ownershipType,
          borrower_name: analysis.updatedSummary?.borrower_name || existingDeal.borrower_name,
          has_application_form: hasApp,
          has_pnw_statement: hasPnw,
        });

        if (!canAdvance) {
          // Need more info — ask for what's missing
          console.log('Cannot advance — missing:', !ltv ? 'LTV' : '', !ownershipType ? 'ownership type' : '');
          const reminderEmail = analysis.reminderEmail || await aiService.generateInfoRequestEmail(
            analysis.updatedSummary,
            { ltv: !ltv, ownershipType: !ownershipType },
            hasApp,
            hasPnw
          );
          emailService.sendEmailDelayed(
            email.from,
            `Re: ${email.subject}`,
            reminderEmail.replace(/<[^>]*>/g, ''),
            reminderEmail,
            [],
            async (result) => {
              await dealsService.saveMessage(existingDeal.id, 'outbound', `Re: ${email.subject}`, reminderEmail, result.MessageID);
              console.log('Info request email sent');
            }
          );
        } else {
          // LTV + ownership determined — route by LTV
          if (ltv > 80) {
            console.log(`LTV ${ltv}% > 80 — escalating to admin for approval`);
            const dealMessages = await dealsService.getMessages(existingDeal.id);
            const dealDocs = await dealsService.getDocumentsWithText(existingDeal.id);
            const escalationEmail = await aiService.generateEscalationNotification(analysis.updatedSummary, dealMessages, dealDocs);

            // Zip all documents and attach to escalation email
            let escalationAttachments = [];
            if (dealDocs.length > 0) {
              console.log('Downloading documents for escalation zip...');
              const zipBase64 = await dealsService.downloadDocsAsZip(existingDeal.id, dealDocs);
              const safeName = (analysis.updatedSummary?.borrower_name || existingDeal.borrower_name || 'Unknown').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
              escalationAttachments = [{
                Name: `${safeName}_Documents.zip`,
                Content: zipBase64,
                ContentType: 'application/zip',
              }];
            }

            const escalateResult = await emailService.sendEmail(
              config.adminEmail,
              `ACTION REQUIRED: LTV Over 80% — ${analysis.updatedSummary?.borrower_name || existingDeal.borrower_name}`,
              escalationEmail.replace(/<[^>]*>/g, ''),
              escalationEmail,
              escalationAttachments
            );
            await dealsService.saveMessage(existingDeal.id, 'outbound', `ACTION REQUIRED: LTV Over 80% — ${analysis.updatedSummary?.borrower_name || existingDeal.borrower_name}`, escalationEmail, escalateResult.MessageID);
            await dealsService.update(existingDeal.id, { status: 'ltv_escalated' });
            console.log('Escalation email sent to admin, deal status: ltv_escalated');
          } else {
            // LTV <= 80% — auto-approved, advance to Stage 3
            console.log(`LTV ${ltv}% <= 80 — auto-approved, advancing to pending_documents`);

            // Get existing docs to determine what's already been received
            const existingDocs = await dealsService.getDocumentsByDeal(existingDeal.id);
            const docRequestEmail = await aiService.generateDocumentRequestEmail(
              analysis.updatedSummary,
              ownershipType,
              hasApp,
              hasPnw,
              existingDocs
            );
            emailService.sendEmailDelayed(
              email.from,
              `Re: ${email.subject}`,
              docRequestEmail.replace(/<[^>]*>/g, ''),
              docRequestEmail,
              [],
              async (result) => {
                await dealsService.saveMessage(existingDeal.id, 'outbound', `Re: ${email.subject}`, docRequestEmail, result.MessageID);
                console.log('Document request email sent, deal status: pending_documents');
              }
            );
            await dealsService.update(existingDeal.id, { status: 'pending_documents' });
          }
        }
      } else if (existingDeal.status === 'pending_documents' || existingDeal.status === 'under_review') {
        // STAGE 3 — Broker sending required documents (also handles under_review follow-ups)
        console.log(`Stage 3: Checking document completeness... (status: ${existingDeal.status})`);

        const ownershipType = existingDeal.ownership_type;
        const allDocs = await dealsService.getDocumentsByDeal(existingDeal.id);
        const classifications = allDocs.map(d => d.classification).filter(Boolean);

        // Determine required docs based on ownership type
        const baseRequired = [
          'government_id',
          'appraisal',
          'property_tax',
          'noa',
          'mortgage_statement',
          'income_proof',
        ];
        const corporateExtra = ['corporate_financials', 'tax_return'];

        const requiredDocs = [...baseRequired];
        if (ownershipType === 'corporate' || ownershipType === 'corporate_mixed') {
          requiredDocs.push(...corporateExtra);
        }
        // Add forms if not yet received
        if (!existingDeal.has_application_form && !classifications.includes('loan_application')) {
          requiredDocs.push('loan_application');
        }
        if (!existingDeal.has_pnw_statement && !classifications.includes('pnw_statement')) {
          requiredDocs.push('pnw_statement');
        }

        const missingDocs = requiredDocs.filter(req => !classifications.includes(req));
        console.log(`Documents received: ${classifications.join(', ') || 'none'}`);
        console.log(`Missing: ${missingDocs.join(', ') || 'NONE — all complete'}`);

        // Update form booleans if forms came in during Stage 3
        const hasApp = existingDeal.has_application_form || classifications.includes('loan_application');
        const hasPnw = existingDeal.has_pnw_statement || classifications.includes('pnw_statement');
        if (hasApp !== existingDeal.has_application_form || hasPnw !== existingDeal.has_pnw_statement) {
          await dealsService.update(existingDeal.id, {
            has_application_form: hasApp,
            has_pnw_statement: hasPnw,
          });
        }

        // Always generate lead summary for Franco — regardless of doc completeness
        const docsWithText = await dealsService.getDocumentsWithText(existingDeal.id);
        console.log('Generating lead summary for Franco...');
        const leadSummary = await aiService.generateLeadSummary(
          existingDeal.extracted_data,
          ownershipType,
          docsWithText,
          missingDocs
        );

        // Download all docs as zip and send lead summary to Franco
        const borrowerName = existingDeal.extracted_data?.borrower_name || existingDeal.borrower_name;
        const ltv = existingDeal.ltv;
        const isUpdate = existingDeal.status === 'under_review';
        const statusFlag = missingDocs.length > 0 ? 'INCOMPLETE' : 'COMPLETE';
        const updatePrefix = isUpdate ? 'UPDATED ' : '';

        console.log('Downloading documents for zip attachment...');
        const zipBase64 = await dealsService.downloadDocsAsZip(existingDeal.id, docsWithText);
        const safeBorrowerName = (borrowerName || 'Unknown').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
        const zipAttachment = [{
          Name: `${safeBorrowerName}_Deal_Documents.zip`,
          Content: zipBase64,
          ContentType: 'application/zip',
        }];

        const leadResult = await emailService.sendEmail(
          config.adminEmail,
          `[${updatePrefix}${statusFlag}] Lead Summary: ${borrowerName} — ${ltv}% LTV`,
          leadSummary.replace(/<[^>]*>/g, ''),
          leadSummary,
          zipAttachment
        );
        await dealsService.saveMessage(existingDeal.id, 'outbound', `[${updatePrefix}${statusFlag}] Lead Summary: ${borrowerName} — ${ltv}% LTV`, leadSummary, leadResult.MessageID);
        console.log(`Lead summary + docs zip sent to Franco (${statusFlag})`);

        if (missingDocs.length > 0) {
          // Send Franco an action required email with docs zip + missing docs list
          const dealMessages = await dealsService.getMessages(existingDeal.id);
          const reviewEmail = await aiService.generateDocReviewNotification(
            existingDeal.extracted_data,
            dealMessages,
            allDocs,
            missingDocs
          );
          const reviewResult = await emailService.sendEmail(
            config.adminEmail,
            `ACTION REQUIRED: Document Review — ${borrowerName}`,
            reviewEmail.replace(/<[^>]*>/g, ''),
            reviewEmail,
            zipAttachment
          );
          await dealsService.saveMessage(existingDeal.id, 'outbound', `ACTION REQUIRED: Document Review — ${borrowerName}`, reviewEmail, reviewResult.MessageID);

          await dealsService.update(existingDeal.id, { status: 'under_review' });
          console.log('Deal status: under_review (Franco notified with action required)');
        } else {
          // All docs received — mark completed
          await dealsService.update(existingDeal.id, { status: 'completed' });
          console.log('All documents received — deal status: completed');
        }
      } else if (existingDeal.status === 'ltv_escalated') {
        // Broker replied while deal is awaiting Franco's approval — save docs and notify
        console.log('Broker replied while deal is ltv_escalated — saving docs and forwarding to admin');

        // Forward broker's reply to Franco so he has the latest info
        const borrowerName = existingDeal.extracted_data?.borrower_name || existingDeal.borrower_name;
        const forwardBody = `<p><strong>Broker update for ${borrowerName}:</strong></p><p>${(email.textBody || '').replace(/\n/g, '<br>')}</p>${email.attachments.length > 0 ? `<p><em>${email.attachments.length} attachment(s) received and saved.</em></p>` : ''}`;
        const fwdResult = await emailService.sendEmail(
          config.adminEmail,
          `[Broker Update] ${borrowerName} — Awaiting Your Approval`,
          forwardBody.replace(/<[^>]*>/g, ''),
          forwardBody
        );
        await dealsService.saveMessage(existingDeal.id, 'outbound', `[Broker Update] ${borrowerName}`, forwardBody, fwdResult.MessageID);
        console.log('Broker update forwarded to admin');
      } else {
        console.log(`Deal status is ${existingDeal.status} — no action taken`);
      }
    }

  } catch (error) {
    console.error('Webhook error:', error);
  }
});

module.exports = router;
