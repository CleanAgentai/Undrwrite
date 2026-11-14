#!/usr/bin/env node
// LIVE — F13 denylist + F6 reply threading.
//   F13: mail from notice@email.anthropic.com creates no deal.
//   F6a: an admin reply to a no-deal system alert ([Intake Filter]) is not turned into a referral.
//   F6b: a broker reply to the link-only holding email threads to that deal (admin_controlled
//        pause → forwarded to admin), instead of opening a new deal.
const L = require('./lib/live');
const base = (from, subject, text, extra = {}) => ({ From: from, FromName: extra.name || '', To: 'vienna@istoitenii.resend.app', Subject: subject, TextBody: text, HtmlBody: '', Attachments: [], MessageID: `live-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, Headers: extra.headers || [], Date: new Date().toISOString() });
const countByEmail = async (email) => ((await L.s.from('deals').select('id').eq('email', email)).data || []).length;

(async () => {
  const ids = [];
  try {
    const spam = `notice+${Date.now()}@email.anthropic.com`;
    await L.post(base(spam, '[No Action Required]: Higher rate limits on the Claude API', 'Your API rate limits have increased.', { name: 'Anthropic Team' }));
    await L.sleep(30000);
    L.check('F13: email.anthropic.com marketing mail creates no deal', (await countByEmail(spam)) === 0);

    const referred = `newbroker+${Date.now()}@blackhole.postmarkapp.com`;
    await L.post(base(L.ADMIN, 'Re: [Intake Filter] New-client intake rejected — Acme Holdings', `Thanks — that one was spam. FYI ${referred} might reach out.`, { name: 'Franco Maione' }));
    await L.sleep(45000);
    L.check('F6a: admin reply to a no-deal system alert does not create a referral deal', (await countByEmail(referred)) === 0);

    const broker = L.newBroker('link');
    await L.post(base(broker, 'New Mortgage Submission — Omar Haddad', 'Hi, docs are here: https://www.dropbox.com/scl/fo/abc123/xyz?dl=0\n\nThanks,\nJason Mercer\nMercer Mortgage Group', { name: 'Jason Mercer' }));
    const deal = await L.waitFor('link-only deal', () => L.dealByEmail(broker)); ids.push(deal.id);
    await L.waitFor('admin_controlled', async () => (await L.getDeal(deal.id)).admin_controlled === true, { timeoutMs: 120000 });
    await L.settle(deal.id, 20000);
    const holding = (await L.outbound(deal.id)).find(m => /^Re: New Mortgage Submission/.test(m.subject || ''));
    L.check('F6b: link-only holding reply saved with a Message-ID', !!holding?.external_message_id);
    await L.reply({ dealId: deal.id, from: broker, fromName: 'Jason Mercer', text: 'Did you get the Dropbox link?', subjectMatch: /^Re: New Mortgage Submission/ });
    await L.sleep(30000);
    L.check('F6b: broker reply threads to the same deal (no second deal)', (await countByEmail(broker)) === 1);
    const fwd = (await L.outbound(deal.id)).find(m => /^\[Admin-controlled deal\]/.test(m.subject || ''));
    L.check('F6b: reply honoured the admin_controlled pause (forwarded to admin, saved with ID)', !!fwd?.external_message_id);
  } finally {
    for (const id of ids) await L.cleanup(id);
  }
  L.finish('live-threading-denylist');
})().catch((e) => { console.error('LIVE FLOW ERROR:', e.message); process.exit(1); });
