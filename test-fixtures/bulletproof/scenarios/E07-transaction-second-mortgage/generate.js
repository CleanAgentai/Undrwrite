#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthMortgageStatement, synthAppraisal } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { singleTurnIntake } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES, LENDERS } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');
const SCENARIO_ID = 'E07';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const broker = BROKERS.jonathan_ferrara, borrower = BORROWERS.patricia_simmons;
  const property = ADDRESSES.toronto_glencairn, lender = LENDERS.scotia;
  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), await synthLoanApp({
    borrowerName: borrower.fullName, propertyAddress: property.full,
    propertyValue: 720000, loanAmount: 120000,
    transactionType: '2nd Mortgage', mortgagePosition: '2nd mortgage',
    existingFirstMortgageBalance: 380000, existingFirstMortgageLender: lender.name,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'mortgage_statement.pdf'), await synthMortgageStatement({
    borrowerName: borrower.fullName, propertyAddress: property.full, lender: lender.name,
    balance: 380000, payoffAmount: 381500, interestRate: 4.95, validityDate: '2026-06-30',
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), await synthAppraisal({
    propertyAddress: property.full, appraisedValue: 720000,
  }));
  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `2nd mortgage — ${borrower.fullName}`,
    textBody: `Hi Franco,\n\nSecond mortgage opportunity for ${borrower.fullName}.\n\nProperty: ${property.full}, appraised $720,000.\nExisting first mortgage: ${lender.name}, balance $380,000.\nNew 2nd mortgage request: $120,000.\nCombined LTV: 69% ($500k total / $720k).\nStandalone LTV of 2nd: 17%.\n\nExit strategy: borrower intends to sell the property at end of term.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: '2026-05-15T11:00:00.000Z',
    attachments: [
      { name: 'LoanApplication_Simmons.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'MortgageStatement_Simmons.pdf', documentRef: 'documents/mortgage_statement.pdf' },
      { name: 'Appraisal_Simmons.pdf', documentRef: 'documents/appraisal.pdf' },
    ],
  });
  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'), JSON.stringify(singleTurnIntake(intake), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 3 docs + 1-event sequence`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
