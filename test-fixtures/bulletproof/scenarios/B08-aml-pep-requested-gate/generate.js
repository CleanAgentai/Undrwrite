#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthMortgageStatement, synthAppraisal, synthNOA } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { singleTurnIntake } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES, LENDERS } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');
const SCENARIO_ID = 'B08';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const broker = BROKERS.jonathan_ferrara;
  const borrower = BORROWERS.sarah_chen;
  const property = ADDRESSES.vancouver_kingsway;
  const lender = LENDERS.national;

  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), await synthLoanApp({
    borrowerName: borrower.fullName, propertyAddress: property.full,
    propertyValue: 850000, loanAmount: 525000,
    transactionType: 'Refinance', mortgagePosition: '1st mortgage',
    existingFirstMortgageBalance: 410000, existingFirstMortgageLender: lender.name,
    annualIncome: 158000,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'mortgage_statement.pdf'), await synthMortgageStatement({
    borrowerName: borrower.fullName, propertyAddress: property.full, lender: lender.name,
    balance: 410000, payoffAmount: 411600, interestRate: 4.85, validityDate: '2026-06-25',
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), await synthAppraisal({
    propertyAddress: property.full, appraisedValue: 850000,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'noa.pdf'), await synthNOA({
    borrowerName: borrower.fullName, taxYear: '2024', incomeReported: 158400,
  }));

  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Refinance — ${borrower.fullName}`,
    textBody: `Hi Franco,\n\nClean refinance for ${borrower.fullName}. Full package attached.\n\nProperty: ${property.full}\nLoan amount: $525,000 (LTV 62%)\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: '2026-05-15T09:00:00.000Z',
    attachments: [
      { name: 'LoanApplication_Chen.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'MortgageStatement_Chen.pdf', documentRef: 'documents/mortgage_statement.pdf' },
      { name: 'Appraisal_Chen.pdf', documentRef: 'documents/appraisal.pdf' },
      { name: 'NOA_Chen.pdf', documentRef: 'documents/noa.pdf' },
    ],
  });

  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'), JSON.stringify(singleTurnIntake(intake), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 4 docs + 1-event sequence`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
