#!/usr/bin/env node
// LIVE — F7: inbound auth + durable dedup on the deployed service.
const L = require('./lib/live');
const URL_ = 'https://vienna-undrwrite.fly.dev/webhook/inbound';
(async () => {
  const noAuth = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  L.check('F7: no credentials → 401', noAuth.status === 401, `HTTP ${noAuth.status}`);
  const bad = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from('vienna:wrong').toString('base64') }, body: '{}' });
  L.check('F7: wrong credentials → 401', bad.status === 401, `HTTP ${bad.status}`);

  const broker = L.newBroker('dedup');
  const payload = { From: broker, FromName: 'Jason Mercer', To: 'vienna@istoitenii.resend.app', Subject: 'Refinance — Nadia Petrov', TextBody: 'Refi for Nadia Petrov.\nProperty: 12 Elm St, Calgary, AB T2T 1A1\nLoan amount: $250,000\nAppraised at $600,000\n\nJason Mercer\nMercer Mortgage Group', HtmlBody: '', Attachments: [], MessageID: `live-dedup-${Date.now()}`, Headers: [], Date: new Date().toISOString() };
  await L.post(payload);
  const deal = await L.waitFor('deal', () => L.dealByEmail(broker));
  L.check('F7: authenticated delivery processed (deal created)', !!deal);
  await L.settle(deal.id, 45000);
  const outBefore = (await L.outbound(deal.id)).length;
  // Same email delivered again after a restart-equivalent gap (in-memory set can't help across machines/restarts;
  // the DB check is what's under test). Deploy restarts cleared memory before this run.
  await L.post(payload);
  await L.sleep(40000);
  const deals = (await L.s.from('deals').select('id').eq('email', broker)).data || [];
  const inbound = (await L.s.from('messages').select('id').eq('deal_id', deal.id).eq('direction', 'inbound')).data || [];
  L.check('F7: duplicate delivery creates no second deal', deals.length === 1, `${deals.length} deals`);
  L.check('F7: duplicate delivery adds no second inbound row', inbound.length === 1, `${inbound.length} inbound`);
  L.check('F7: duplicate delivery triggers no new outbound', (await L.outbound(deal.id)).length === outBefore);
  const stored = (await L.s.from('messages').select('external_message_id').eq('deal_id', deal.id).eq('direction', 'inbound')).data?.[0];
  L.check('F7: inbound row stores the provider Message-ID', stored?.external_message_id === payload.MessageID);
  await L.cleanup(deal.id);
  L.finish('live-inbound-auth-dedup');
})().catch((e) => { console.error('LIVE FLOW ERROR:', e.message); process.exit(1); });
