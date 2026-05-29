#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthMortgageStatement, synthAppraisal } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { singleTurnIntake } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES, LENDERS } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');
const SCENARIO_ID = 'E08';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const broker = BROKERS.jonathan_ferrara, borrower = BORROWERS.marcus_webb;
  const property = ADDRESSES.edmonton_tory, lender = LENDERS.scotia;
  // 3rd mortgage: existing 1st $380k + 2nd $85k + new 3rd $50k. Combined LTV: $515k/$720k = 71.5%
  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), await synthLoanApp({
    borrowerName: borrower.fullName, propertyAddress: property.full,
    propertyValue: 720000, loanAmount: 50000,
    transactionType: '3rd Mortgage', mortgagePosition: '3rd mortgage',
    existingFirstMortgageBalance: 380000, existingFirstMortgageLender: lender.name,
    extraText: `Existing 2nd mortgage: $85,000 with Centum Private Capital Inc. (private lender). Combined 1st + 2nd outstanding: $465,000.`,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'mortgage_statement.pdf'), await synthMortgageStatement({
    borrowerName: borrower.fullName, propertyAddress: property.full, lender: lender.name,
    balance: 380000, payoffAmount: 381500, interestRate: 5.45, validityDate: '2026-06-15',
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), await synthAppraisal({
    propertyAddress: property.full, appraisedValue: 720000,
  }));
  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `3rd mortgage — ${borrower.fullName}`,
    textBody: `Hi Franco,\n\nThird mortgage for ${borrower.fullName} at ${property.full}.\n\n1st mortgage: ${lender.name}, balance $380,000 (statement attached).\n2nd mortgage: Centum Private Capital Inc., balance $85,000.\nNew 3rd mortgage request: $50,000.\n\nCombined LTV: 71.5% ($515k / $720k). Borrower needs the 3rd to cover renovation overruns; 1st and 2nd both current.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: '2026-05-15T11:00:00.000Z',
    attachments: [
      { name: 'LoanApplication_Webb.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'MortgageStatement_Webb.pdf', documentRef: 'documents/mortgage_statement.pdf' },
      { name: 'Appraisal_Webb.pdf', documentRef: 'documents/appraisal.pdf' },
    ],
  });
  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'), JSON.stringify(singleTurnIntake(intake), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 3 docs + 1-event sequence`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
