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

    // Check if this sender has an active deal
    const existingDeal = await dealsService.findActiveByEmail(email.from);

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
      await emailService.sendEmail(
        email.from,
        `Re: ${email.subject}`,
        welcomeEmail.replace(/<[^>]*>/g, ''),
        welcomeEmail,
        formAttachments
      );

      // Save outbound message
      await dealsService.saveMessage(deal.id, 'outbound', `Re: ${email.subject}`, welcomeEmail);

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

      // Save inbound message
      await dealsService.saveMessage(existingDeal.id, 'inbound', email.subject, email.textBody);

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
          await emailService.sendEmail(
            email.from,
            `Re: ${email.subject}`,
            reminderEmail.replace(/<[^>]*>/g, ''),
            reminderEmail
          );
          await dealsService.saveMessage(existingDeal.id, 'outbound', `Re: ${email.subject}`, reminderEmail);
          console.log('Info request email sent');
        } else {
          // LTV + ownership determined — route by LTV
          if (ltv > 95) {
            console.log(`LTV ${ltv}% > 95 — rejecting deal`);
            const rejectionEmail = await aiService.generateRejectionEmail(analysis.updatedSummary);
            await emailService.sendEmail(
              email.from,
              `Re: ${email.subject}`,
              rejectionEmail.replace(/<[^>]*>/g, ''),
              rejectionEmail
            );
            await dealsService.saveMessage(existingDeal.id, 'outbound', `Re: ${email.subject}`, rejectionEmail);
            await dealsService.update(existingDeal.id, { status: 'ltv_rejected' });
            console.log('Rejection email sent, deal status: ltv_rejected');
          } else if (ltv >= 75) {
            console.log(`LTV ${ltv}% is 75-95 — escalating to admin`);
            const escalationEmail = await aiService.generateEscalationNotification(analysis.updatedSummary);
            await emailService.sendEmail(
              'admin@fsagent.com',
              `Deal Review Required: ${analysis.updatedSummary?.borrower_name || existingDeal.borrower_name} — ${ltv}% LTV`,
              escalationEmail.replace(/<[^>]*>/g, ''),
              escalationEmail
            );
            await dealsService.update(existingDeal.id, { status: 'ltv_escalated' });
            console.log('Escalation email sent to admin, deal status: ltv_escalated');
          } else {
            // LTV < 75% — advance to Stage 3
            console.log(`LTV ${ltv}% < 75 — advancing to pending_documents`);

            // Get existing docs to determine what's already been received
            const existingDocs = await dealsService.getDocumentsByDeal(existingDeal.id);
            const docRequestEmail = await aiService.generateDocumentRequestEmail(
              analysis.updatedSummary,
              ownershipType,
              hasApp,
              hasPnw,
              existingDocs
            );
            await emailService.sendEmail(
              email.from,
              `Re: ${email.subject}`,
              docRequestEmail.replace(/<[^>]*>/g, ''),
              docRequestEmail
            );
            await dealsService.saveMessage(existingDeal.id, 'outbound', `Re: ${email.subject}`, docRequestEmail);
            await dealsService.update(existingDeal.id, { status: 'pending_documents' });
            console.log('Document request email sent, deal status: pending_documents');
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

        await emailService.sendEmail(
          'admin@fsagent.com',
          `[${updatePrefix}${statusFlag}] Lead Summary: ${borrowerName} — ${ltv}% LTV`,
          leadSummary.replace(/<[^>]*>/g, ''),
          leadSummary,
          zipAttachment
        );
        console.log(`Lead summary + docs zip sent to Franco (${statusFlag})`);

        if (missingDocs.length > 0) {
          // Also remind broker about missing docs
          const docRequestEmail = await aiService.generateDocumentRequestEmail(
            existingDeal.extracted_data,
            ownershipType,
            hasApp,
            hasPnw,
            allDocs
          );
          await emailService.sendEmail(
            email.from,
            `Re: ${email.subject}`,
            docRequestEmail.replace(/<[^>]*>/g, ''),
            docRequestEmail
          );
          await dealsService.saveMessage(existingDeal.id, 'outbound', `Re: ${email.subject}`, docRequestEmail);
          await dealsService.update(existingDeal.id, { status: 'under_review' });
          console.log('Document reminder sent to broker, still missing:', missingDocs.join(', '));
          console.log('Deal status: under_review (Franco notified, awaiting remaining docs)');
        } else {
          // All docs received — mark completed
          await dealsService.update(existingDeal.id, { status: 'completed' });
          console.log('All documents received — deal status: completed');
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
