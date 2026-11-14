// Helpers for multi-step live flows against the deployed Vienna (Fly).
// Broker mail comes from Postmark-blackhole addresses (accepted + discarded), admin mail
// from ADMIN_EMAIL as deployed (admin@blackhole.postmarkapp.com during testing). Replies
// thread the same way real ones do: In-Reply-To = a stored outbound external_message_id.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { postToWebhook } = require('../../test-fixtures/bulletproof/lib/replay');
const { resolveAttachmentRefs } = require('../../test-fixtures/bulletproof/lib/emailSynth');

const ADMIN = process.env.LIVE_ADMIN_EMAIL || 'admin@blackhole.postmarkapp.com';
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const scenariosDir = path.join(__dirname, '..', '..', 'test-fixtures', 'bulletproof', 'scenarios');

const newBroker = (tag) => `broker+${tag}${Date.now()}@blackhole.postmarkapp.com`;

// First broker_intake event of a bulletproof scenario, From rewritten to `broker`.
const scenarioIntake = (scenarioId, broker) => {
  const dir = path.join(scenariosDir, scenarioId);
  const ev = JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8'))[0];
  const p = resolveAttachmentRefs(JSON.parse(JSON.stringify(ev.postmark)), dir);
  p.From = broker;
  p.MessageID = `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return p;
};

const post = async (payload) => {
  const res = await postToWebhook(payload);
  if (res.status !== 200) throw new Error(`webhook HTTP ${res.status}`);
};

// Reply to the deal's latest outbound (optionally the latest whose subject matches).
const reply = async ({ dealId, from, fromName = '', text, subjectMatch = null, attachments = [] }) => {
  const outs = (await s.from('messages').select('subject,external_message_id,created_at').eq('deal_id', dealId).eq('direction', 'outbound').not('external_message_id', 'is', null).order('created_at', { ascending: false })).data || [];
  const target = outs.find(m => !subjectMatch || subjectMatch.test(m.subject || ''));
  if (!target) throw new Error(`no outbound to reply to on ${dealId}`);
  await post({
    From: from, FromName: fromName, To: 'vienna@istoitenii.resend.app',
    Subject: /^re:/i.test(target.subject) ? target.subject : `Re: ${target.subject}`,
    TextBody: text, HtmlBody: '', Attachments: attachments,
    MessageID: `live-reply-${Date.now()}`,
    Headers: [{ Name: 'In-Reply-To', Value: `<${target.external_message_id}@solveraiq.ai>` }],
    Date: new Date().toISOString(),
  });
  return target;
};

const getDeal = async (dealId) => (await s.from('deals').select('*').eq('id', dealId).single()).data;
const dealByEmail = async (email) => (await s.from('deals').select('*').eq('email', email).order('created_at', { ascending: false }).limit(1)).data?.[0] || null;
const outbound = async (dealId) => (await s.from('messages').select('subject,body,created_at,external_message_id').eq('deal_id', dealId).eq('direction', 'outbound').order('created_at', { ascending: true })).data || [];

// Poll until fn() returns truthy (returns that value) or time out.
const waitFor = async (label, fn, { timeoutMs = 300000, intervalMs = 5000 } = {}) => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for: ${label}`);
    await sleep(intervalMs);
  }
};

// Wait until no new outbound has landed for quietMs (Vienna finished this turn).
const settle = async (dealId, quietMs = 90000) => {
  let n = -1, since = Date.now();
  for (const end = Date.now() + 420000; Date.now() < end; await sleep(5000)) {
    const c = (await outbound(dealId)).length;
    if (c !== n) { n = c; since = Date.now(); } else if (Date.now() - since >= quietMs) return n;
  }
  return n;
};

const cleanup = async (dealId) => {
  await s.from('messages').delete().eq('deal_id', dealId);
  await s.from('documents').delete().eq('deal_id', dealId);
  await s.from('deals').delete().eq('id', dealId);
};

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`); };
const finish = (name) => { console.log(`\n[${name}] ${pass} pass / ${fail} fail`); process.exit(fail ? 1 : 0); };

module.exports = { s, ADMIN, sleep, newBroker, scenarioIntake, post, reply, getDeal, dealByEmail, outbound, waitFor, settle, cleanup, check, finish };
