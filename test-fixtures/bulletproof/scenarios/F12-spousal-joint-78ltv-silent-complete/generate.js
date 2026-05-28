#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthMortgageStatement, synthAppraisal, synthNOA } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { silentSequence } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES, LENDERS } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');
const SCENARIO_ID = 'F12';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const broker = BROKERS.jason_mercer;
  const jointName = `${BORROWERS.patricia_simmons.fullName} and James Simmons`;
  const property = ADDRESSES.toronto_glencairn, lender = LENDERS.scotia;
  // 78% LTV: $718k / $920k
  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), await synthLoanApp({
    borrowerName: jointName, propertyAddress: property.full,
    propertyValue: 920000, loanAmount: 718000,
    transactionType: 'Refinance', mortgagePosition: '1st mortgage',
    existingFirstMortgageBalance: 560000, existingFirstMortgageLender: lender.name,
    annualIncome: 295000,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'mortgage_statement.pdf'), await synthMortgageStatement({
    borrowerName: jointName, propertyAddress: property.full, lender: lender.name,
    balance: 560000, payoffAmount: 562000, interestRate: 4.95, validityDate: '2026-06-30',
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), await synthAppraisal({
    propertyAddress: property.full, appraisedValue: 920000,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'noa.pdf'), await synthNOA({
    borrowerName: jointName, taxYear: '2024', incomeReported: 295000,
  }));
  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Refinance — ${jointName}`,
    textBody: `Hi Franco,\n\nJoint refi for ${jointName} (spouses). Property ${property.full}, 78% LTV ($718k against $920k). Full package attached.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: '2026-05-15T11:00:00.000Z',
    attachments: [
      { name: 'LoanApplication_Simmons.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'MortgageStatement_Simmons.pdf', documentRef: 'documents/mortgage_statement.pdf' },
      { name: 'Appraisal_Simmons.pdf', documentRef: 'documents/appraisal.pdf' },
      { name: 'NOA_Simmons.pdf', documentRef: 'documents/noa.pdf' },
    ],
  });
  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'), JSON.stringify(silentSequence(intake), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 4 docs + 1-event sequence (silent path — chase-cron drives forward)`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
