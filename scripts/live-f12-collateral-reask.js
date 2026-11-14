#!/usr/bin/env node
// LIVE — F12: an ambiguous collateral reply gets the dedicated collateral re-ask
// (R10-C-1 generator), the deal stays on hold, and no second admin hold notice is sent.
const { execSync } = require('child_process');
const L = require('./lib/live');
(async () => {
  const broker = L.newBroker('f12');
  await L.post(L.scenarioIntake('E04-ltv-band-80-85-high', broker));
  const deal = await L.waitFor('deal', () => L.dealByEmail(broker));
  try {
    await L.waitFor('awaiting_collateral', async () => (await L.getDeal(deal.id)).status === 'awaiting_collateral');
    await L.settle(deal.id, 40000);
    const t0 = new Date().toISOString();
    await L.reply({ dealId: deal.id, from: broker, fromName: 'Jonathan Ferrara', subjectMatch: /^Re: Refinance/, text: 'Let me check with the borrower on that and get back to you.\n\nJonathan' });
    await L.settle(deal.id, 60000);
    const logs = execSync('fly logs --app vienna-undrwrite --no-tail 2>&1', { encoding: 'utf8' }).replace(/\x1b\[[0-9;]*m/g, '');
    const fired = logs.split('\n').some(l => l.slice(0, 20) >= t0.slice(0, 19) && /R10-C-1 \(active-branch\): ambiguous collateral reply/.test(l));
    L.check('F12: dedicated collateral re-ask fired for the ambiguous reply', fired);
    L.check('F12: deal still on collateral hold', (await L.getDeal(deal.id)).status === 'awaiting_collateral', (await L.getDeal(deal.id)).status);
    const notices = (await L.outbound(deal.id)).filter(m => /^\[On hold — awaiting collateral\]/.test(m.subject || ''));
    L.check('admin hold notice sent once only', notices.length === 1, `${notices.length}`);
  } finally { await L.cleanup(deal.id); }
  L.finish('live-f12-collateral-reask');
})().catch((e) => { console.error('LIVE FLOW ERROR:', e.message); process.exit(1); });
