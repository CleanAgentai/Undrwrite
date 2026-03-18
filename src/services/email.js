const postmarkClient = require('../lib/postmark');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const DELAY_MS = 90 * 1000; // 90 seconds

module.exports = {
  sendEmail: async (to, subject, textBody, htmlBody = null, attachments = [], headers = []) => {
    try {
      const emailData = {
        From: config.postmark.senderEmail,
        To: to,
        Subject: subject,
        TextBody: textBody,
        HtmlBody: htmlBody || textBody,
        Attachments: attachments,
      };
      if (headers.length > 0) emailData.Headers = headers;
      const result = await postmarkClient.sendEmail(emailData);
      console.log('Email sent:', result.MessageID);
      return result;
    } catch (error) {
      console.error('Failed to send email:', error);
      throw error;
    }
  },

  // Send email with delay (fire-and-forget, saves message ID via onSent callback)
  sendEmailDelayed: (to, subject, textBody, htmlBody = null, attachments = [], onSent = null) => {
    console.log(`Email to ${to} queued — will send in 90s`);
    setTimeout(async () => {
      try {
        const result = await postmarkClient.sendEmail({
          From: config.postmark.senderEmail,
          To: to,
          Subject: subject,
          TextBody: textBody,
          HtmlBody: htmlBody || textBody,
          Attachments: attachments,
        });
        console.log('Delayed email sent:', result.MessageID);
        if (onSent) await onSent(result);
      } catch (error) {
        console.error('Failed to send delayed email:', error);
      }
    }, DELAY_MS);
  },

  getFormAttachments: ({ skipApplicationForm = false, includeIntakeForm = false } = {}) => {
    const formsDir = path.join(__dirname, '../../forms');
    const formFiles = [];

    if (!skipApplicationForm) formFiles.push('Loan Application Form (1).pdf');
    formFiles.push('PNW Statement Form.pdf');
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
