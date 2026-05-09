const postmarkClient = require('../lib/postmark');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const DELAY_MS = 0; // immediate send

// Group III (S12.1) — scrub admin-greeting opener from broker-facing emails.
// Production failure mode: Group A's HARD RULE leaks when the broker email body
// has TWO signatures (broker's inner sig + admin auto-appended outer sig from a
// QA mail client) and Claude picks the outer one, baking sender_name="Franco
// Maione" into the deal record. Downstream emails then naturally greet "Hi Franco"
// from Claude's perspective. Belt-and-suspenders escalation per Q3 of original
// Group A plan: prompt-only first, JS post-processing if smokes flake — they did
// in production deal 9db03a27 (Torres/Westgate, 3 reminders sent to "Hi Franco").
//
// Match opening greeting up to closing </p> or newline. Handles:
//   <p>Hi Franco!</p>... → <p>Hi there!</p>...
//   <p>Hello Franco Maione,</p>... → <p>Hi there!</p>...
//   <p>Hey Franco — </p>... → <p>Hi there!</p>...
//   Hi Franco,\n\nThanks... → Hi there!\n\nThanks... (text body)
// Negative cases (don't match): "Hi Sarah!", "Hi Frances!" (word-boundary), mid-body Franco mentions.
const stripAdminGreeting = (body) => {
  if (!body) return body;
  return body.replace(
    /^(\s*(?:<p>\s*)?)(?:hi|hello|hey|dear)\s+franco(?:\s+\w+)?[^<\n]*?(?=<\/p>|\n|$)/i,
    '$1Hi there!'
  );
};

const isAdminRecipient = (to) => {
  const adminEmail = (config.adminEmail || '').toLowerCase();
  return !!(adminEmail && String(to || '').toLowerCase().includes(adminEmail));
};

module.exports = {
  sendEmail: async (to, subject, textBody, htmlBody = null, attachments = [], headers = [], cc = null) => {
    try {
      // Group III: scrub admin-greeting opener for broker-facing sends. Admin sends
      // pass through unchanged (admin-facing emails legitimately reference Franco).
      const isAdmin = isAdminRecipient(to);
      const scrubbedHtml = isAdmin ? htmlBody : stripAdminGreeting(htmlBody);
      const scrubbedText = isAdmin ? textBody : stripAdminGreeting(textBody);
      const emailData = {
        From: config.postmark.senderEmail,
        To: to,
        Subject: subject,
        TextBody: scrubbedText,
        HtmlBody: scrubbedHtml || scrubbedText,
        Attachments: attachments,
      };
      if (headers.length > 0) emailData.Headers = headers;
      if (cc) emailData.Cc = cc;
      const result = await postmarkClient.sendEmail(emailData);
      console.log('Email sent:', result.MessageID);
      return result;
    } catch (error) {
      console.error('Failed to send email:', error);
      throw error;
    }
  },

  // Send email with delay (fire-and-forget, saves message ID via onSent callback)
  sendEmailDelayed: (to, subject, textBody, htmlBody = null, attachments = [], headers = [], onSent = null) => {
    console.log(`Email to ${to} queued — sending immediately`);
    setTimeout(async () => {
      try {
        // Group III: same scrub policy as sendEmail above.
        const isAdmin = isAdminRecipient(to);
        const scrubbedHtml = isAdmin ? htmlBody : stripAdminGreeting(htmlBody);
        const scrubbedText = isAdmin ? textBody : stripAdminGreeting(textBody);
        const emailData = {
          From: config.postmark.senderEmail,
          To: to,
          Subject: subject,
          TextBody: scrubbedText,
          HtmlBody: scrubbedHtml || scrubbedText,
          Attachments: attachments,
        };
        if (headers.length > 0) emailData.Headers = headers;
        const result = await postmarkClient.sendEmail(emailData);
        console.log('Delayed email sent:', result.MessageID);
        if (onSent) await onSent(result);
      } catch (error) {
        console.error('Failed to send delayed email:', error);
      }
    }, DELAY_MS);
  },

  getFormAttachments: ({ skipApplicationForm = false, skipPnwForm = false, includeIntakeForm = false } = {}) => {
    const formsDir = path.join(__dirname, '../../forms');
    const formFiles = [];

    if (!skipApplicationForm) formFiles.push('Loan Application Form (1).pdf');
    if (!skipPnwForm) formFiles.push('PNW Statement Form.pdf');
    if (includeIntakeForm) formFiles.push('Union Borrower Intake Form.pdf');

    return formFiles.map((fileName) => ({
      Name: fileName,
      Content: fs.readFileSync(path.join(formsDir, fileName)).toString('base64'),
      ContentType: 'application/pdf',
    }));
  },

  parseInboundEmail: (payload) => {
    // Extract In-Reply-To from Postmark Headers array
    const headers = payload.Headers || [];
    const inReplyToHeader = headers.find(h => h.Name === 'In-Reply-To');
    const referencesHeader = headers.find(h => h.Name === 'References');

    return {
      from: payload.From,
      fromName: payload.FromName,
      to: payload.To,
      subject: payload.Subject,
      textBody: payload.TextBody,
      htmlBody: payload.HtmlBody,
      attachments: payload.Attachments || [],
      messageId: payload.MessageID,
      inReplyTo: inReplyToHeader ? inReplyToHeader.Value.trim() : null,
      references: referencesHeader ? referencesHeader.Value.trim().split(/\s+/) : [],
      date: payload.Date,
    };
  },
};

// Test-only exposure for the deterministic Group III scrub truth table.
// Production callers use the local consts at module scope; this just makes the
// pure-regex predicates reachable from test-trigger.js.
module.exports.__test__ = { stripAdminGreeting, isAdminRecipient };
