// Resend inbound → Postmark-shaped payload, so the existing inbound handler
// (routes/webhook.js handleInbound) runs unchanged on mail received through Resend.
//
// Resend's `email.received` webhook carries only metadata. The body comes from
// GET /emails/receiving/{id}, attachments from GET /emails/receiving/{id}/attachments
// (temporary download_url per file), and the threading headers (In-Reply-To,
// References) from the raw RFC 822 message — the parsed `headers` object is not
// guaranteed to include them.
const crypto = require('crypto');
const config = require('../config');
const mailer = require('./mailer');

const API = 'https://api.resend.com';

const api = async (pathname) => {
  const res = await fetch(`${API}${pathname}`, { headers: { Authorization: `Bearer ${config.resend.apiKey}` } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend GET ${pathname} failed (${res.status}): ${json.message || ''}`);
  return json;
};

// Svix-style signature check (Resend signs webhooks with svix-id / svix-timestamp /
// svix-signature over `${id}.${timestamp}.${rawBody}` using the whsec_ secret).
const verifySignature = (rawBody, headers) => {
  const secret = config.resend.webhookSecret;
  if (!secret) return true;
  const id = headers['svix-id'];
  const ts = headers['svix-timestamp'];
  const sigs = String(headers['svix-signature'] || '').split(' ').map(s => s.split(',')[1]).filter(Boolean);
  if (!id || !ts || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64');
  return sigs.some(s => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
};

// "Jane Broker <jane@x.com>" → { name, email }
const parseAddress = (raw) => {
  const m = String(raw || '').match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim(), email: m[2].trim() } : { name: '', email: String(raw || '').trim() };
};

// Header block of a raw RFC 822 message, unfolded, as a lowercase-keyed map.
const parseRawHeaders = (raw) => {
  const block = String(raw).split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
  const out = {};
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
};

const htmlToText = (html) => String(html || '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const toPostmarkPayload = async (event) => {
  const meta = event.data || {};
  const email = await api(`/emails/receiving/${meta.email_id}`);

  let rawHeaders = {};
  if (email.raw?.download_url) {
    const raw = await fetch(email.raw.download_url).then(r => r.text()).catch(() => '');
    rawHeaders = parseRawHeaders(raw);
  }
  // A reply to Vienna arrives at vienna+<uuid>@… (see mailer.replyToWithToken). That
  // uuid is the stored external_message_id of the Vienna email being answered, so it
  // becomes In-Reply-To — the exact signal the Postmark path threads on.
  const token = mailer.threadTokenFrom([...[].concat(email.to || meta.to || []), ...[].concat(meta.received_for || []), ...[].concat(email.cc || [])]);
  const headerList = [];
  if (token) headerList.push({ Name: 'In-Reply-To', Value: `<${token}@${config.email.messageIdDomain}>` });
  for (const name of ['In-Reply-To', 'References', 'Message-ID']) {
    const v = rawHeaders[name.toLowerCase()];
    if (v && !(token && name === 'In-Reply-To')) headerList.push({ Name: name, Value: v });
  }

  const attachments = [];
  if ((email.attachments || meta.attachments || []).length) {
    const list = await api(`/emails/receiving/${meta.email_id}/attachments`);
    for (const a of list.data || []) {
      const buf = Buffer.from(await fetch(a.download_url).then(r => r.arrayBuffer()));
      attachments.push({ Name: a.filename, Content: buf.toString('base64'), ContentType: a.content_type, ContentLength: buf.length });
    }
  }

  const from = parseAddress(email.from || meta.from);
  return {
    From: from.email,
    FromName: from.name,
    To: [].concat(email.to || meta.to || []).join(', '),
    Subject: email.subject || meta.subject || '',
    TextBody: email.text || htmlToText(email.html),
    HtmlBody: email.html || '',
    Attachments: attachments,
    MessageID: email.id || meta.email_id,
    Headers: headerList,
    Date: email.created_at || meta.created_at,
  };
};

module.exports = { verifySignature, toPostmarkPayload, parseRawHeaders, parseAddress, htmlToText };
