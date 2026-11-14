#!/usr/bin/env node
// LIVE — P2 estimate labelling + P3 stalled alert.
const fs = require('fs');
const path = require('path');
const L = require('./lib/live');
(async () => {
  const ids = [];
  try {
    // P2: stated LTV, no confirmable loan/value figures, one reviewable (income) document.
    const b2 = L.newBroker('p2');
    const pdf = fs.readFileSync(path.join(__dirname, '..', 'test-fixtures', 'bulletproof', 'scenarios', 'D02-standard-prelim-review-control', 'documents', fs.readdirSync(path.join(__dirname, '..', 'test-fixtures', 'bulletproof', 'scenarios', 'D02-standard-prelim-review-control', 'documents')).find(f => /pdf$/i.test(f)))).toString('base64');
    await L.post({ From: b2, FromName: 'Jason Mercer', To: 'vienna@istoitenii.resend.app', Subject: 'Refinance — Priya Natarajan', TextBody: 'Hi Franco,\n\nRefi for Priya Natarajan, roughly 65% LTV per the broker price opinion. Income attached; appraisal to follow.\nExit strategy: sale of the property at end of term.\n\nJason Mercer\nMercer Mortgage Group', HtmlBody: '', Attachments: [{ Name: 'T4_Priya_Natarajan_2025.pdf', Content: pdf, ContentType: 'application/pdf', ContentLength: pdf.length }], MessageID: `live-p2-${Date.now()}`, Headers: [], Date: new Date().toISOString() });
    const d2 = await L.waitFor('P2 deal', () => L.dealByEmail(b2)); ids.push(d2.id);
    await L.settle(d2.id, 90000);
    const prelim = (await L.outbound(d2.id)).find(m => /PRELIMINARY Review/.test(m.subject || ''));
    if (!prelim) console.log(`  (P2: no prelim fired; status ${(await L.getDeal(d2.id)).status}; outbound: ${(await L.outbound(d2.id)).map(m => m.subject).join(' | ')})`);
    L.check('P2: estimated-LTV prelim subject marked "(est.)"', /LTV \(est\.\)/.test(prelim?.subject || ''), prelim?.subject || 'no prelim');
    L.check('P2: estimate callout in the prelim body', /p2-ltv-estimate/.test(prelim?.body || ''));

    // P3: a deal at the reminder cap gets exactly one [Stalled] alert across two cron runs.
    const b3 = L.newBroker('p3');
    await L.post({ From: b3, FromName: 'Jason Mercer', To: 'vienna@istoitenii.resend.app', Subject: 'Refinance — Omar Haddad', TextBody: 'Refi for Omar Haddad.\nLoan amount: $250,000\nAppraised at $600,000\n\nJason Mercer\nMercer Mortgage Group', HtmlBody: '', Attachments: [], MessageID: `live-p3-${Date.now()}`, Headers: [], Date: new Date().toISOString() });
    const d3 = await L.waitFor('P3 deal', () => L.dealByEmail(b3)); ids.push(d3.id);
    await L.settle(d3.id, 45000);
    await L.s.from('deals').update({ reminder_count: 4 }).eq('id', d3.id);
    const trigger = () => fetch('https://vienna-undrwrite.fly.dev/cron/run-daily', { method: 'POST', headers: { 'X-Cron-Secret': process.env.CRON_SECRET } });
    L.check('P3: manual cron trigger accepted', (await trigger()).status === 202);
    await L.sleep(30000);
    await trigger();
    await L.sleep(30000);
    const stalled = (await L.outbound(d3.id)).filter(m => /^\[Stalled\]/.test(m.subject || ''));
    L.check('P3: exactly one [Stalled] alert after two cron runs', stalled.length === 1, `${stalled.length}`);
    L.check('P3: alert saved with a Message-ID', !!stalled[0]?.external_message_id);
  } finally {
    for (const id of ids) await L.cleanup(id);
  }
  L.finish('live-p2-p3');
})().catch((e) => { console.error('LIVE FLOW ERROR:', e.message); process.exit(1); });
