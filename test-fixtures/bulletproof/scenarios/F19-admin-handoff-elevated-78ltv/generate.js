#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthMortgageStatement, synthAppraisal } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { singleTurnIntake } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES, LENDERS } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');
const SCENARIO_ID = 'F19';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const borrower = BORROWERS.marcus_webb;
  const property = ADDRESSES.edmonton_tory, lender = LENDERS.rbc;
  // 78% LTV deal context; admin-direction message
  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), await synthLoanApp({
    borrowerName: borrower.fullName, propertyAddress: property.full,
    propertyValue: 650000, loanAmount: 507000,
    transactionType: 'Refinance', mortgagePosition: '1st mortgage',
    existingFirstMortgageBalance: 395000, existingFirstMortgageLender: lender.name,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'mortgage_statement.pdf'), await synthMortgageStatement({
    borrowerName: borrower.fullName, propertyAddress: property.full, lender: lender.name,
    balance: 395000, payoffAmount: 396800, interestRate: 5.45, validityDate: '2026-06-15',
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), await synthAppraisal({
    propertyAddress: property.full, appraisedValue: 650000,
  }));
  const adminMsg = buildPostmarkPayload({
    from: 'admin@privatemortgagelink.com', fromName: 'Admin',
    subject: `Draft Email Preview — ${borrower.fullName} (78% LTV refi)`,
    textBody: `Vienna,\n\nLooking at the ${borrower.fullName} refi — 78% LTV is within band but elevated. Draft to broker looks reasonable; flag the band in the Risk Factors section as usual.\n\nAdmin`,
    messageId: `${SCENARIO_ID}-admin@bulletproof.synthetic`,
    date: '2026-05-15T15:00:00.000Z',
    attachments: [
      { name: 'LoanApplication_Webb.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'MortgageStatement_Webb.pdf', documentRef: 'documents/mortgage_statement.pdf' },
      { name: 'Appraisal_Webb.pdf', documentRef: 'documents/appraisal.pdf' },
    ],
  });
  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'), JSON.stringify(singleTurnIntake(adminMsg), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 3 docs + 1-event sequence (admin handoff)`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
