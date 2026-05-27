#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthMortgageStatement, synthAppraisal } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { linearTurns } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES, LENDERS } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');
const SCENARIO_ID = 'B07';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const broker = BROKERS.franco;
  const borrower = BORROWERS.marcus_webb;
  const property = ADDRESSES.edmonton_tory;
  const lender = LENDERS.rbc;

  // 83% LTV
  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), await synthLoanApp({
    borrowerName: borrower.fullName, propertyAddress: property.full,
    propertyValue: 650000, loanAmount: 540000,
    transactionType: 'Refinance', mortgagePosition: '1st mortgage',
    existingFirstMortgageBalance: 425000, existingFirstMortgageLender: lender.name,
    annualIncome: 145000,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'mortgage_statement.pdf'), await synthMortgageStatement({
    borrowerName: borrower.fullName, propertyAddress: property.full, lender: lender.name,
    balance: 425000, payoffAmount: 426800, interestRate: 5.45, validityDate: '2026-06-15',
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), await synthAppraisal({
    propertyAddress: property.full, appraisedValue: 650000,
  }));

  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Refinance — ${borrower.fullName} (high LTV)`,
    textBody: `Hi Franco,\n\nRefi for ${borrower.fullName}, LTV 83%. Property at ${property.full}, appraised $650k, requesting $540k.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: '2026-05-15T10:00:00.000Z',
    attachments: [
      { name: 'LoanApplication_Webb.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'MortgageStatement_Webb.pdf', documentRef: 'documents/mortgage_statement.pdf' },
      { name: 'Appraisal_Webb.pdf', documentRef: 'documents/appraisal.pdf' },
    ],
  });

  const collateralOffer = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Re: Refinance — ${borrower.fullName} (high LTV)`,
    textBody: `Hi Franco,\n\nCollateral update: ${borrower.fullName} can pledge a second property as additional security — 2447 Whyte Avenue NW, Edmonton, AB, currently appraised at $385,000 with no existing mortgage. This brings effective combined LTV well below 70%. Title can be encumbered on closing.\n\nHappy to provide title docs for the second property.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-collateral@bulletproof.synthetic`,
    date: '2026-05-17T11:00:00.000Z',
  });

  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'),
    JSON.stringify(linearTurns([intake, collateralOffer]), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 3 docs + 2-event sequence`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
