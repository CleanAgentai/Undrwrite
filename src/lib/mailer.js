// Outbound email transport. Postmark-shaped in, Postmark-shaped out, so every
// caller (services/email.js) is provider-agnostic:
//   send({ From, To, Cc, Subject, TextBody, HtmlBody, Attachments, Headers }) → { MessageID }
//
// EMAIL_PROVIDER=postmark (default) — Postmark ServerClient, Message-IDs are <uuid@mtasv.net>.
// EMAIL_PROVIDER=resend            — Resend REST API. Resend's MTA (SES) replaces any
//   Message-ID we set, so replies can't thread on In-Reply-To. Instead the thread token
//   rides in the Reply-To address: EMAIL_REPLY_TO local+<uuid>@domain. Every mail client
//   replies to that address, and resendInbound turns the token back into In-Reply-To.
//   messages.external_message_id stores the bare uuid with either provider.
const crypto = require('crypto');
const config = require('../config');

const provider = config.email.provider;

// Bare stored id → RFC 5322 Message-ID for In-Reply-To / References headers.
// Ids that already carry a domain (inbound Gmail/Outlook ids) pass through.
const messageIdHeader = (id) => (id && id.includes('@') ? `<${id}>` : `<${id}@${config.email.messageIdDomain}>`);

// vienna@x.resend.app + uuid → vienna+uuid@x.resend.app
const replyToWithToken = (addr, uuid) => addr.replace(/^([^@+]+)(?:\+[^@]*)?@/, `$1+${uuid}@`);

// Token back out of a recipient list (the inverse of replyToWithToken).
const UUID_RE = /\+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/i;
const threadTokenFrom = (recipients) => {
  for (const r of [].concat(recipients || [])) {
    const m = String(r).match(UUID_RE);
    if (m) return m[1].toLowerCase();
  }
  return null;
};

const sendViaPostmark = async (emailData) => {
  const client = require('./postmark');
  return client.sendEmail(emailData);
};

const sendViaResend = async ({ From, To, Cc, Subject, TextBody, HtmlBody, Attachments = [], Headers = [] }) => {
  const uuid = crypto.randomUUID();
  const headers = {};
  for (const h of Headers || []) headers[h.Name] = h.Value;
  const split = (v) => String(v).split(',').map(s => s.trim()).filter(Boolean);
  const body = {
    from: From,
    to: split(To),
    subject: Subject,
    text: TextBody || undefined,
    html: HtmlBody || undefined,
    headers,
    attachments: (Attachments || []).map(a => ({ filename: a.Name, content: a.Content, content_type: a.ContentType })),
  };
  if (Cc) body.cc = split(Cc);
  if (config.email.replyTo) body.reply_to = replyToWithToken(config.email.replyTo, uuid);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resend.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend send failed (${res.status}): ${json.message || JSON.stringify(json)}`);
  return { MessageID: uuid, ProviderMessageID: json.id, To, SubmittedAt: new Date().toISOString() };
};

const send = (emailData) => (provider === 'resend' ? sendViaResend(emailData) : sendViaPostmark(emailData));

module.exports = { send, messageIdHeader, replyToWithToken, threadTokenFrom, provider };
