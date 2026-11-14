#!/usr/bin/env node
// LIVE — Q9 admin override end to end (F2), then a broker follow-up after approval (F1).
//   1. Broker submits a >80% LTV deal → awaiting_collateral.
//   2. Admin replies "Approved" → Q9 override: active + collateral_override_at + doc-request draft preview.
//   3. Admin replies "SEND" → draft executes (F2): doc request goes to broker, draft cleared.
//   4. Broker replies with a document → deal must stay active, not re-enter awaiting_collateral (F1).
// Usage: node scripts/live-q9-override-flow.js [--keep] [--skip-f1]
const L = require('./lib/live');

(async () => {
  const keep = process.argv.includes('--keep');
  const broker = L.newBroker('q9');
  await L.post(L.scenarioIntake('E04-ltv-band-80-85-high', broker));
  const deal = await L.waitFor('deal created', () => L.dealByEmail(broker));
  console.log(`deal ${deal.id}`);
  try {
    const held = await L.waitFor('awaiting_collateral', async () => { const d = await L.getDeal(deal.id); return d.status === 'awaiting_collateral' && d; });
    L.check('intake >80% → awaiting_collateral', held.status === 'awaiting_collateral');
    await L.settle(deal.id, 45000);

    await L.reply({ dealId: deal.id, from: L.ADMIN, fromName: 'Franco Maione', text: 'Approved. Override the collateral requirement on this one.' });
    const drafted = await L.waitFor('Q9 override draft', async () => { const d = await L.getDeal(deal.id); return d.draft_action && d; });
    L.check('Q9 override → status active', drafted.status === 'active', drafted.status);
    L.check('Q9 override → collateral_override_at recorded', !!drafted.extracted_data?.collateral_override_at);
    L.check('Q9 override → approval_doc_request draft previewed', drafted.draft_action === 'approval_doc_request', drafted.draft_action);
    await L.settle(deal.id, 30000);

    const before = (await L.outbound(deal.id)).length;
    await L.reply({ dealId: deal.id, from: L.ADMIN, fromName: 'Franco Maione', text: 'SEND' });
    const sent = await L.waitFor('draft executed', async () => { const d = await L.getDeal(deal.id); return !d.draft_action && d; }, { timeoutMs: 180000 });
    const outs = await L.outbound(deal.id);
    L.check('F2: SEND executes the Q9 draft (draft cleared)', !sent.draft_action);
    L.check('F2: doc request sent to broker after SEND', outs.length > before, `${before} → ${outs.length} outbound`);
    L.check('F2: deal active after SEND', sent.status === 'active', sent.status);

    if (!process.argv.includes('--skip-f1')) {
      await L.settle(deal.id, 30000);
      await L.reply({ dealId: deal.id, from: broker, fromName: 'Jason Mercer', text: 'Hi, attached is the borrower ID as requested. Thanks, Jason', subjectMatch: /^(?!.*(ACTION REQUIRED|DRAFT|PREVIEW))/i });
      await L.settle(deal.id, 60000);
      const after = await L.getDeal(deal.id);
      L.check('F1: approved deal stays active after broker follow-up', after.status === 'active', after.status);
      const lastBroker = (await L.outbound(deal.id)).filter(m => !/ACTION REQUIRED|DRAFT|PREVIEW|\[/i.test(m.subject || '')).pop();
      L.check('F1: Vienna reply does not re-ask for collateral', lastBroker && !/additional collateral|collateral/i.test(lastBroker.body || ''), (lastBroker?.subject || 'none'));
    }
  } finally {
    if (!keep) await L.cleanup(deal.id);
  }
  L.finish('live-q9-override-flow');
})().catch((e) => { console.error('LIVE FLOW ERROR:', e.message); process.exit(1); });
