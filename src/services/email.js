const postmarkClient = require('../lib/postmark');
const fs = require('fs');
const path = require('path');
const config = require('../config');

module.exports = {
  sendEmail: async (to, subject, textBody, htmlBody = null, attachments = []) => {
    try {
      const result = await postmarkClient.sendEmail({
        From: config.postmark.senderEmail,
        To: to,
        Subject: subject,
        TextBody: textBody,
        HtmlBody: htmlBody || textBody,
        Attachments: attachments,
      });
      console.log('Email sent:', result.MessageID);
      return result;
    } catch (error) {
      console.error('Failed to send email:', error);
      throw error;
    }
  },

  getFormAttachments: () => {
    const formsDir = path.join(__dirname, '../../forms');
    const formFiles = [
      'Loan Application Form (1).pdf',
      'PNW Statement Form.pdf',
      'Union Borrower Intake Form.pdf',
    ];

    return formFiles.map((fileName) => ({
      Name: fileName,
      Content: fs.readFileSync(path.join(formsDir, fileName)).toString('base64'),
      ContentType: 'application/pdf',
    }));
  },

  parseInboundEmail: (payload) => {
    return {
      from: payload.From,
      fromName: payload.FromName,
      to: payload.To,
      subject: payload.Subject,
      textBody: payload.TextBody,
      htmlBody: payload.HtmlBody,
      attachments: payload.Attachments || [],
      messageId: payload.MessageID,
      date: payload.Date,
    };
  },
};
