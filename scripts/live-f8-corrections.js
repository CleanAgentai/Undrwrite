#!/usr/bin/env node
// LIVE — F8: replay the real fixture correction phrasings and check the facts Vienna holds.
//   A06: "Updating loan amount: $345,000" (was ignored → prelim kept $310,000)
//   A34: "Current first mortgage balance is $222,500 not $225,000" (balance corrections were unsupported)
const fs = require('fs');
const path = require('path');
const L = require('./lib/live');
const second = (sc) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-fixtures', 'bulletproof', 'scenarios', sc, 'events.json'), 'utf8'))[1].postmark.TextBody;
const facts = async (dealId) => {
  const rows = (await L.s.from('messages').select('body,created_at').eq('deal_id', dealId).eq('direction', 'system').order('created_at', { ascending: true })).data || [];
  return rows.length ? JSON.parse(rows[rows.length - 1].body).facts : null;
};
const run = async (sc, field, expected) => {
  const broker = L.newBroker('f8');
  await L.post(L.scenarioIntake(sc, broker));
  const deal = await L.waitFor(`${sc} deal`, () => L.dealByEmail(broker));
  try {
    await L.settle(deal.id, 90000);
    const before = await facts(deal.id);
    await L.reply({ dealId: deal.id, from: broker, fromName: 'Jonathan Ferrara', subjectMatch: /^Re: /, text: second(sc) });
    await L.settle(deal.id, 90000);
    const after = await facts(deal.id);
    L.check(`${sc.slice(0, 3)}: ${field} ${before?.[field]} → ${expected}`, after?.[field] === expected, `now ${after?.[field]} (status ${(await L.getDeal(deal.id)).status})`);
  } finally { await L.cleanup(deal.id); }
};
(async () => {
  await run('A06-loan-amount-broker-mid-conversation-correct', 'loan_amount_requested', 345000);
  await run('A34-first-mortgage-balance-broker-correction-over-statement', 'existing_mortgage_balance', 222500);
  L.finish('live-f8-corrections');
})().catch((e) => { console.error('LIVE FLOW ERROR:', e.message); process.exit(1); });
