#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthMortgageStatement, synthAppraisal } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { singleTurnIntake } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES, LENDERS } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');
const SCENARIO_ID = 'A12';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const broker = BROKERS.jason_mercer;
  const borrower = BORROWERS.david_okafor;
  const property = ADDRESSES.toronto_glencairn;
  const lender = LENDERS.cibc;

  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), await synthLoanApp({
    borrowerName: borrower.fullName, propertyAddress: property.full,
    propertyValue: 920000, loanAmount: 280000,
    transactionType: 'Refinance', mortgagePosition: '1st mortgage',
    existingFirstMortgageBalance: 380000, existingFirstMortgageLender: lender.name,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'mortgage_statement.pdf'), await synthMortgageStatement({
    borrowerName: borrower.fullName, propertyAddress: property.full, lender: lender.name,
    balance: 380000, payoffAmount: 382000, interestRate: 4.95, validityDate: '2026-06-30',
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), await synthAppraisal({
    propertyAddress: property.full, appraisedValue: 920000,
  }));

  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Refinance — ${borrower.fullName}`,
    textBody: `Hi Franco,\n\nRefi for ${borrower.fullName}. Borrower's investor partner is settling in USD — loan amount: USD $280,000. Property ${property.full}.\n\nLet me know if Vienna can quote in USD or if we need to convert to CAD upfront.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: '2026-05-15T13:00:00.000Z',
    attachments: [
      { name: 'LoanApplication_Okafor.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'MortgageStatement_Okafor.pdf', documentRef: 'documents/mortgage_statement.pdf' },
      { name: 'Appraisal_Okafor.pdf', documentRef: 'documents/appraisal.pdf' },
    ],
  });

  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'), JSON.stringify(singleTurnIntake(intake), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 3 docs + 1-event sequence`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
