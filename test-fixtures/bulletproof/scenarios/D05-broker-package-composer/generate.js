#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthMortgageStatement, synthAppraisal, synthNOA } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { linearTurns } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES, LENDERS } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');
const SCENARIO_ID = 'D05';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const broker = BROKERS.jason_mercer;
  const borrower = BORROWERS.patricia_simmons;
  const property = ADDRESSES.toronto_glencairn;
  const lender = LENDERS.scotia;

  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), await synthLoanApp({
    borrowerName: borrower.fullName, propertyAddress: property.full,
    propertyValue: 920000, loanAmount: 460000,
    transactionType: 'Refinance', mortgagePosition: '1st mortgage',
    existingFirstMortgageBalance: 380000, existingFirstMortgageLender: lender.name,
    annualIncome: 168000,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'mortgage_statement.pdf'), await synthMortgageStatement({
    borrowerName: borrower.fullName, propertyAddress: property.full, lender: lender.name,
    balance: 380000, payoffAmount: 382000, interestRate: 4.95, validityDate: '2026-06-30',
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), await synthAppraisal({
    propertyAddress: property.full, appraisedValue: 920000,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'noa.pdf'), await synthNOA({
    borrowerName: borrower.fullName, taxYear: '2024', incomeReported: 168400,
  }));

  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Refinance — ${borrower.fullName}`,
    textBody: `Hi Franco,\n\nRefi for ${borrower.fullName}. Full package attached.\n\nProperty: ${property.full}\nLoan amount: $460,000 (LTV 50%)\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: '2026-05-15T10:00:00.000Z',
    attachments: [
      { name: 'LoanApplication_Simmons.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'MortgageStatement_Simmons.pdf', documentRef: 'documents/mortgage_statement.pdf' },
      { name: 'Appraisal_Simmons.pdf', documentRef: 'documents/appraisal.pdf' },
      { name: 'NOA_Simmons.pdf', documentRef: 'documents/noa.pdf' },
    ],
  });

  const adminApproval = buildPostmarkPayload({
    from: 'admin@privatemortgagelink.com', fromName: 'Admin',
    subject: `Re: ACTION REQUIRED: PRELIMINARY Review — ${borrower.fullName}`,
    textBody: `Approved — proceed to broker package. Terms: 5.95% / 2 yr / $460,000 / 50% LTV. Send the formatted package to ${broker.name}.\n\nAdmin`,
    messageId: `${SCENARIO_ID}-admin-approve@bulletproof.synthetic`,
    date: '2026-05-17T14:00:00.000Z',
  });

  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'),
    JSON.stringify(linearTurns([intake, adminApproval]), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 4 docs + 2-event sequence`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
