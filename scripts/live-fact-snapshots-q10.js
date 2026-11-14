#!/usr/bin/env node
// LIVE — P1 fact snapshots + F9 Q10 on all material fields.
const L = require('./lib/live');
(async () => {
  const broker = L.newBroker('q10');
  await L.post(L.scenarioIntake('D02-standard-prelim-review-control', broker));
  const deal = await L.waitFor('deal', () => L.dealByEmail(broker));
  try {
    await L.waitFor('under_review', async () => (await L.getDeal(deal.id)).status === 'under_review', { timeoutMs: 360000 });
    await L.settle(deal.id, 30000);
    const snaps = async () => ((await L.s.from('messages').select('subject,body').eq('deal_id', deal.id).eq('direction', 'system')).data || []).map(r => JSON.parse(r.body));
    let sn = await snaps();
    const prelim = sn.find(x => x.trigger === 'prelim');
    L.check('P1: intake snapshot recorded', sn.some(x => x.trigger === 'intake'));
    L.check('P1: prelim snapshot recorded with code-built facts', !!prelim && prelim.facts.loan_amount_requested === 525000 && prelim.facts.property_value === 850000, JSON.stringify(prelim?.facts));
    L.check('P1: snapshot rows never appear in the conversation', !(await L.outbound(deal.id)).some(m => /fact-snapshot/.test(m.subject || '')));

    await L.reply({ dealId: deal.id, from: broker, fromName: 'Jason Mercer', subjectMatch: /^Re: Refinance/, text: 'Hi,\n\nCorrection: the loan amount is actually $560,000. Also, this is actually a 2nd mortgage — the existing first mortgage stays in place.\n\nJason' });
    const notice = await L.waitFor('Q10 notice', async () => (await L.outbound(deal.id)).find(m => /^\[UPDATED\] Prelim correction/.test(m.subject || '')), { timeoutMs: 300000 });
    L.check('F9: Q10 notice sent to admin', !!notice, notice?.subject);
    L.check('F9: notice includes the loan amount change', /requested loan amount/.test(notice?.subject || ''));
    L.check('F9: notice includes the transaction type / position change (unreachable pre-F9)', /transaction type/.test(notice?.subject || ''), notice?.body?.split('\n').filter(l => l.startsWith('- ')).join(' | '));
    L.check('F9: notice saved with a Message-ID', !!notice?.external_message_id);
    sn = await snaps();
    L.check('P1: change recorded as a new inbound snapshot', sn.filter(x => x.trigger === 'inbound').some(x => x.facts.loan_amount_requested === 560000));
  } finally {
    await L.cleanup(deal.id);
  }
  L.finish('live-fact-snapshots-q10');
})().catch((e) => { console.error('LIVE FLOW ERROR:', e.message); process.exit(1); });
