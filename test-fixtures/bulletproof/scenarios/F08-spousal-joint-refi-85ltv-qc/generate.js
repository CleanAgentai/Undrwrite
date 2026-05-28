#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthMortgageStatement, synthAppraisal } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { correctionSequence } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES, LENDERS } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');
const SCENARIO_ID = 'F08';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const broker = BROKERS.jonathan_ferrara;
  const jointName = `${BORROWERS.sarah_chen.fullName} and Wei Chen`;
  const property = ADDRESSES.montreal_papineau;
  const lender = LENDERS.desjardins;
  // 85% LTV: $493k / $580k
  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), await synthLoanApp({
    borrowerName: jointName, propertyAddress: property.full,
    propertyValue: 580000, loanAmount: 493000,
    transactionType: 'Refinance', mortgagePosition: '1st mortgage',
    existingFirstMortgageBalance: 380000, existingFirstMortgageLender: lender.name,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'mortgage_statement.pdf'), await synthMortgageStatement({
    borrowerName: jointName, propertyAddress: property.full, lender: lender.name,
    balance: 380000, payoffAmount: 381500, interestRate: 5.10, validityDate: '2026-06-25',
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), await synthAppraisal({
    propertyAddress: property.full, appraisedValue: 580000,
  }));
  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Refinancement — ${jointName} (Montréal)`,
    textBody: `Bonjour Franco,\n\nRefi joint pour ${jointName} (conjoints), propriété à ${property.full}. LTV 85%, montant du prêt $493,000. Hypothèque existante: ${lender.name}, solde $380,000.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: '2026-05-15T11:00:00.000Z',
    attachments: [
      { name: 'DemandePret_Chen.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'ReleveDuHypotheque_Chen.pdf', documentRef: 'documents/mortgage_statement.pdf' },
      { name: 'Evaluation_Chen.pdf', documentRef: 'documents/appraisal.pdf' },
    ],
  });
  const correction = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Re: Refinancement — ${jointName} (Montréal)`,
    textBody: `Correction: existing lender is Caisse Desjardins (not just "Desjardins") — please use full name in the file. Same payout terms.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-correction@bulletproof.synthetic`,
    date: '2026-05-16T11:00:00.000Z',
  });
  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'),
    JSON.stringify(correctionSequence({ intake, correction, correctionDelayMs: 24 * 3600 * 1000 }), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 3 docs + 2-event sequence`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
