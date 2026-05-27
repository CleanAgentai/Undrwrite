#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthMortgageStatement, synthAppraisal } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { correctionSequence } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES, LENDERS } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');
const SCENARIO_ID = 'A18';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const broker = BROKERS.jason_mercer;
  const borrower = BORROWERS.david_okafor;
  const shortAddr = '52 Winston Boulevard, Mississauga, ON L5M 4Y1';
  const fullAddr = '52 Winston Churchill Boulevard, Mississauga, ON L5M 4Y1';
  const lender = LENDERS.td;

  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), await synthLoanApp({
    borrowerName: borrower.fullName, propertyAddress: shortAddr,
    propertyValue: 720000, loanAmount: 360000,
    transactionType: 'Refinance', mortgagePosition: '1st mortgage',
    existingFirstMortgageBalance: 285000, existingFirstMortgageLender: lender.name,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'mortgage_statement.pdf'), await synthMortgageStatement({
    borrowerName: borrower.fullName, propertyAddress: shortAddr, lender: lender.name,
    balance: 285000, payoffAmount: 286400, interestRate: 5.15, validityDate: '2026-06-22',
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), await synthAppraisal({
    propertyAddress: shortAddr, appraisedValue: 720000,
  }));

  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Refinance — ${borrower.fullName}`,
    textBody: `Hi Franco,\n\nRefi for ${borrower.fullName}. Property: ${shortAddr}.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: '2026-05-15T10:00:00.000Z',
    attachments: [
      { name: 'LoanApplication_Okafor.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'MortgageStatement_Okafor.pdf', documentRef: 'documents/mortgage_statement.pdf' },
      { name: 'Appraisal_Okafor.pdf', documentRef: 'documents/appraisal.pdf' },
    ],
  });

  const correction = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Re: Refinance — ${borrower.fullName}`,
    textBody: `Full property address is ${fullAddr} — please use the fuller name (matches title record). Same property, just clarifying the formal street name.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-correction@bulletproof.synthetic`,
    date: '2026-05-16T10:00:00.000Z',
  });

  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'),
    JSON.stringify(correctionSequence({ intake, correction, correctionDelayMs: 24 * 3600 * 1000 }), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 3 docs + 2-event sequence`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
