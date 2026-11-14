#!/usr/bin/env node
// LIVE — auto-decline flows.
//   F4: first email at 92% LTV → exactly one broker email (the decline), no welcome; admin alert saved with an ID.
//   F3: 60% deal stays active (no docs) → broker correction pushes it to 94% → follow-up auto-decline,
//       no conversational reply alongside it; status rejected.
// Usage: node scripts/live-decline-flows.js [--keep]
const L = require('./lib/live');

const intake = (broker, loan, value) => ({
  From: broker, FromName: 'Jason Mercer', To: 'vienna@istoitenii.resend.app',
  Subject: `Second mortgage request — Laura Bennett`,
  TextBody: `Hi,\n\nNew file for Laura Bennett.\nProperty: 88 Harvest Hills Blvd NE, Calgary, AB T3K 4K9\nLoan amount: $${loan.toLocaleString('en-US')}\nAppraised at $${value.toLocaleString('en-US')}\nExit strategy: refinance with a bank at renewal.\n\nThanks,\nJason Mercer\nMercer Mortgage Group\nLic. #M12001505`,
  HtmlBody: '', Attachments: [], MessageID: `live-${Date.now()}`, Headers: [], Date: new Date().toISOString(),
});
const brokerFacing = (outs) => outs.filter(m => !/^\[|ACTION REQUIRED|DRAFT|PREVIEW/i.test(m.subject || ''));

(async () => {
  const keep = process.argv.includes('--keep');
  const ids = [];
  try {
    console.log('F4 — first email over 90%');
    const b4 = L.newBroker('f4');
    await L.post(intake(b4, 460000, 500000));
    const d4 = await L.waitFor('F4 deal', () => L.dealByEmail(b4)); ids.push(d4.id);
    await L.waitFor('F4 rejected', async () => (await L.getDeal(d4.id)).status === 'rejected');
    await L.settle(d4.id, 45000);
    const o4 = await L.outbound(d4.id);
    const bf4 = brokerFacing(o4);
    L.check('F4: deal rejected', (await L.getDeal(d4.id)).status === 'rejected');
    L.check('F4: exactly one broker email (the decline, no welcome)', bf4.length === 1, bf4.map(m => m.subject).join(' | '));
    const alert4 = o4.find(m => /^\[Auto-Decline\]/.test(m.subject || ''));
    L.check('F6: admin [Auto-Decline] alert saved with a Message-ID', !!alert4?.external_message_id);
    L.check('F6: broker decline saved with a Message-ID', !!bf4[0]?.external_message_id);

    console.log('F3 — follow-up correction over 90%');
    const b3 = L.newBroker('f3');
    await L.post(intake(b3, 300000, 500000));
    const d3 = await L.waitFor('F3 deal', () => L.dealByEmail(b3)); ids.push(d3.id);
    await L.settle(d3.id, 60000);
    L.check('F3 setup: 60% deal with no docs stays active', (await L.getDeal(d3.id)).status === 'active', (await L.getDeal(d3.id)).status);
    const before = brokerFacing(await L.outbound(d3.id)).length;
    await L.reply({ dealId: d3.id, from: b3, fromName: 'Jason Mercer', text: 'Correction: the loan amount is actually $470,000, not $300,000.\n\nJason' });
    await L.waitFor('F3 rejected', async () => (await L.getDeal(d3.id)).status === 'rejected', { timeoutMs: 240000 });
    await L.settle(d3.id, 45000);
    const bf3 = brokerFacing(await L.outbound(d3.id));
    L.check('F3: follow-up pushes LTV over 90% → deal rejected', (await L.getDeal(d3.id)).status === 'rejected');
    L.check('F3: exactly one new broker email (the decline, no conversational reply)', bf3.length - before === 1, bf3.slice(before).map(m => m.subject).join(' | '));
  } finally {
    if (!keep) for (const id of ids) await L.cleanup(id);
  }
  L.finish('live-decline-flows');
})().catch((e) => { console.error('LIVE FLOW ERROR:', e.message); process.exit(1); });
