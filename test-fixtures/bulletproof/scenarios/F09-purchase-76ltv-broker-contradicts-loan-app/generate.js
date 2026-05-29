#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthAppraisal, synthNOA } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { singleTurnIntake } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');
const SCENARIO_ID = 'F09';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const broker = BROKERS.jason_mercer, borrower = BORROWERS.sarah_chen;
  const property = ADDRESSES.vancouver_kingsway;
  // 76% LTV purchase: $570k against $750k purchase
  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), await synthLoanApp({
    borrowerName: borrower.fullName, propertyAddress: property.full,
    propertyValue: 750000, loanAmount: 475000,
    transactionType: 'Purchase', mortgagePosition: '1st mortgage',
    annualIncome: 158000,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), await synthAppraisal({
    propertyAddress: property.full, appraisedValue: 750000,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'noa.pdf'), await synthNOA({
    borrowerName: borrower.fullName, taxYear: '2024', incomeReported: 158400,
  }));
  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Purchase — ${borrower.fullName}`,
    textBody: `Hi Franco,\n\nPurchase for ${borrower.fullName} at ${property.full}. Purchase $750k, loan amount $570,000 (please use this number; the $475k on the attached loan app form is from an earlier scenario before borrower bumped the offer).\n\nLTV 76%.\n\nExit strategy: borrower intends to sell the property at end of term.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: '2026-05-15T11:00:00.000Z',
    attachments: [
      { name: 'LoanApplication_Chen.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'Appraisal_Chen.pdf', documentRef: 'documents/appraisal.pdf' },
      { name: 'NOA_Chen.pdf', documentRef: 'documents/noa.pdf' },
    ],
  });
  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'), JSON.stringify(singleTurnIntake(intake), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 3 docs + 1-event sequence`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
