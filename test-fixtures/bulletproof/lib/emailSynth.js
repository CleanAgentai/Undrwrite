const fs = require('fs');
const path = require('path');
const { POSTMARK_SHAPE, VIENNA_INBOX } = require('./shapes');

// Build a Postmark-shape inbound payload from a structured opts object. The
// shape mirrors what test-staging-e2e.js + src/routes/webhook.js handle on the
// /inbound route; attachments accept either inline base64 Content or a
// documentRef (relative path resolved at replay time).
const buildPostmarkPayload = (opts) => {
  const {
    from,
    fromName,
    to = VIENNA_INBOX,
    subject,
    textBody,
    htmlBody = null,
    messageId,
    date = new Date().toISOString(),
    attachments = [],
    headers = [],
  } = opts;

  const Attachments = attachments.map(a => {
    const out = {
      Name: a.name,
      ContentType: a.contentType || 'application/pdf',
    };
    if (a.documentRef) {
      out.documentRef = a.documentRef;
    } else if (a.content) {
      out.Content = a.content;
      out.ContentLength = a.contentLength || Buffer.from(a.content, 'base64').length;
    }
    return out;
  });

  return {
    ...POSTMARK_SHAPE,
    From: from,
    FromName: fromName,
    To: to,
    Subject: subject,
    TextBody: textBody,
    HtmlBody: htmlBody,
    MessageID: messageId,
    Date: date,
    Headers: headers,
    Attachments,
  };
};

// Resolve documentRef references against a fixture's documents/ directory.
// Replay harness (Phase 5) calls this to inline base64 content at POST time;
// keeps events.json small and human-readable.
const resolveAttachmentRefs = (postmarkPayload, fixtureDir) => {
  const resolved = JSON.parse(JSON.stringify(postmarkPayload));
  resolved.Attachments = resolved.Attachments.map(a => {
    if (a.documentRef) {
      const docPath = path.join(fixtureDir, a.documentRef);
      const bytes = fs.readFileSync(docPath);
      return {
        Name: a.Name,
        ContentType: a.ContentType,
        Content: bytes.toString('base64'),
        ContentLength: bytes.length,
      };
    }
    return a;
  });
  return resolved;
};

module.exports = {
  buildPostmarkPayload,
  resolveAttachmentRefs,
};
