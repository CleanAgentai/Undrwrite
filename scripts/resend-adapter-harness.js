#!/usr/bin/env node
// Deterministic checks for the provider-agnostic mail layer (src/lib/mailer.js,
// src/lib/resendInbound.js). No network.
process.env.RESEND_WEBHOOK_SECRET = 'whsec_' + Buffer.from('vienna-test-secret-0123456789abcd').toString('base64');
const crypto = require('crypto');
const ri = require('../src/lib/resendInbound');
const mailer = require('../src/lib/mailer');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log(`  FAIL ${name} ${detail}`); } };

// Raw header parsing: folded References, case-insensitive keys, body ignored.
const raw = [
  'From: "Jason Mercer" <jason@mercer.example.com>',
  'In-Reply-To: <abc-123@vienna.serviceagent.dev>',
  'References: <first@mtasv.net>',
  '  <abc-123@vienna.serviceagent.dev>',
  'Subject: Re: Refinance',
  '',
  'In-Reply-To: <not-a-header@body>',
].join('\r\n');
const h = ri.parseRawHeaders(raw);
ok('In-Reply-To parsed', h['in-reply-to'] === '<abc-123@vienna.serviceagent.dev>', h['in-reply-to']);
ok('folded References unfolded', h.references === '<first@mtasv.net> <abc-123@vienna.serviceagent.dev>', h.references);
ok('body lines not parsed as headers', !String(h['in-reply-to']).includes('body'));

// Address parsing.
const a = ri.parseAddress('"Jason Mercer" <jason@mercer.example.com>');
ok('display name', a.name === 'Jason Mercer', a.name);
ok('address', a.email === 'jason@mercer.example.com', a.email);
ok('bare address', ri.parseAddress('x@y.com').email === 'x@y.com');

// HTML fallback text keeps line structure.
ok('html→text', ri.htmlToText('<p>Hi Franco,</p><p>Loan: $525,000<br>Thanks</p>') === 'Hi Franco,\nLoan: $525,000\nThanks');

// Signature verification (svix scheme).
const body = JSON.stringify({ type: 'email.received', data: { email_id: 'e1' } });
const id = 'msg_1', ts = String(Math.floor(Date.now() / 1000));
const key = Buffer.from(process.env.RESEND_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
ok('valid signature accepted', ri.verifySignature(body, { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` }));
ok('tampered body rejected', !ri.verifySignature(body + ' ', { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` }));
ok('missing headers rejected', !ri.verifySignature(body, {}));
ok('stale timestamp rejected', !ri.verifySignature(body, { 'svix-id': id, 'svix-timestamp': String(Number(ts) - 3600), 'svix-signature': `v1,${sig}` }));

// Threading ids: bare stored ids get the provider's domain; full ids pass through.
ok('bare id gets domain', /^<abc@.+>$/.test(mailer.messageIdHeader('abc')));
ok('full id passes through', mailer.messageIdHeader('x@gmail.com') === '<x@gmail.com>');

// Reply-To thread token round trip (Resend overwrites Message-ID, so threading rides here).
const u = '3f2b8c1e-9a4d-4e7b-8c2f-0123456789ab';
const rt = mailer.replyToWithToken('vienna@istoitenii.resend.app', u);
ok('token added to reply-to', rt === `vienna+${u}@istoitenii.resend.app`, rt);
ok('existing +tag replaced, not stacked', mailer.replyToWithToken(`vienna+old@x.app`, u) === `vienna+${u}@x.app`);
ok('token read back from To list', mailer.threadTokenFrom(['someone@else.com', rt]) === u);
ok('token read back case-insensitively', mailer.threadTokenFrom([rt.toUpperCase()]) === u);
ok('no token on a fresh email', mailer.threadTokenFrom(['vienna@istoitenii.resend.app']) === null);
ok('non-uuid +tag ignored', mailer.threadTokenFrom(['vienna+hello@istoitenii.resend.app']) === null);

console.log(`\n[resend-adapter-harness] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
