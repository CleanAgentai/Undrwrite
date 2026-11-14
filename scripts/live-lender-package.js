#!/usr/bin/env node
// LIVE — full path to "Ready to Close": intake → prelim → admin Approved → SEND →
// broker sends remaining docs → completion handoff. Checks F14 (code-built Snapshot in the
// lender package) and F10 (checklist rows follow the completion rules).
const fs = require('fs');
const path = require('path');
const L = require('./lib/live');
const docsDir = path.join(__dirname, '..', 'test-fixtures', 'bulletproof', 'scenarios', 'D02-standard-prelim-review-control', 'documents');
const filler = fs.readFileSync(path.join(docsDir, 'loan_application.pdf')).toString('base64');
const att = (Name) => ({ Name, Content: filler, ContentType: 'application/pdf', ContentLength: filler.length });

(async () => {
  const broker = L.newBroker('pkg');
  await L.post(L.scenarioIntake('D02-standard-prelim-review-control', broker));
  const deal = await L.waitFor('deal', () => L.dealByEmail(broker));
  try {
    await L.waitFor('under_review', async () => (await L.getDeal(deal.id)).status === 'under_review', { timeoutMs: 360000 });
    await L.settle(deal.id, 30000);
    await L.reply({ dealId: deal.id, from: L.ADMIN, fromName: 'Franco Maione', text: 'Approved', subjectMatch: /PRELIMINARY Review/ });
    await L.waitFor('approval draft', async () => (await L.getDeal(deal.id)).draft_action, { timeoutMs: 240000 });
    await L.settle(deal.id, 20000);
    await L.reply({ dealId: deal.id, from: L.ADMIN, fromName: 'Franco Maione', text: 'SEND' });
    await L.waitFor('draft sent', async () => !(await L.getDeal(deal.id)).draft_action, { timeoutMs: 180000 });
    await L.settle(deal.id, 20000);
    await L.reply({ dealId: deal.id, from: broker, fromName: 'Jason Mercer', subjectMatch: /^Re: Refinance/, text: 'Hi, attached are the remaining documents: credit bureau, T4, ID, property tax, AML and PEP.\n\nJason', attachments: ['Credit_Bureau_Sarah_Chen.pdf', 'T4_Sarah_Chen_2025.pdf', 'Government_ID_Sarah_Chen.pdf', 'Property_Tax_2025_Sarah_Chen.pdf', 'AML_Form_Sarah_Chen.pdf', 'PEP_Form_Sarah_Chen.pdf'].map(att) });
    const pkg = await L.waitFor('[File Complete]', async () => (await L.outbound(deal.id)).find(m => /^\[(File Complete|Conditions Fulfilled)\]/.test(m.subject || '')), { timeoutMs: 420000 });
    const body = pkg?.body || '';
    L.check('reached the "Ready to Close" lender package', !!pkg, pkg?.subject);
    L.check('F14: package carries exactly one Deal Snapshot', (body.match(/<h2>\s*Deal Snapshot\s*<\/h2>/gi) || []).length === 1);
    L.check('F14: Snapshot is the code-built one (canonical figures, "(computed)" LTV row)', /Deal Snapshot<\/h2>\n<p><strong>/i.test(body) && /\(computed\)/i.test(body));
    L.check('F10: checklist present with payout row from the completion rules', /Mortgage Payout Statement — (✓ Received|✗ Not on file)/.test(body));
    L.check('F10: AML and PEP rows ticked', /AML Form — ✓ Received/.test(body) && /PEP Form — ✓ Received/.test(body));
    await L.settle(deal.id, 30000);
    L.check('deal completed', (await L.getDeal(deal.id)).status === 'completed', (await L.getDeal(deal.id)).status);
  } finally {
    if (!process.argv.includes('--keep')) await L.cleanup(deal.id);
  }
  L.finish('live-lender-package');
})().catch((e) => { console.error('LIVE FLOW ERROR:', e.message); process.exit(1); });
