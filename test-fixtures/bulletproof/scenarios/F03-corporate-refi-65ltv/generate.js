#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthMortgageStatement, synthAppraisal } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { singleTurnIntake } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES, LENDERS } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');
const SCENARIO_ID = 'F03';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const broker = BROKERS.jason_mercer, borrower = BORROWERS.webb_holdings_ltd;
  const property = ADDRESSES.toronto_glencairn, lender = LENDERS.bmo;
  // 65% LTV: $585k / $900k
  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), await synthLoanApp({
    borrowerName: borrower.fullName, propertyAddress: property.full,
    propertyValue: 900000, loanAmount: 585000,
    transactionType: 'Refinance', mortgagePosition: '1st mortgage',
    existingFirstMortgageBalance: 460000, existingFirstMortgageLender: lender.name,
    extraText: `Corporate borrower (Alberta holding co; Marcus Webb sole director + 100% beneficial owner). Investment property.`,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'mortgage_statement.pdf'), await synthMortgageStatement({
    borrowerName: borrower.fullName, propertyAddress: property.full, lender: lender.name,
    balance: 460000, payoffAmount: 461800, interestRate: 5.55, validityDate: '2026-06-30',
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), await synthAppraisal({
    propertyAddress: property.full, appraisedValue: 900000,
  }));
  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Corporate refinance — ${borrower.fullName}`,
    textBody: `Hi Franco,\n\nCorporate refi for ${borrower.fullName} on investment property at ${property.full}. Standard 65% LTV, loan $585k. Clean file.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: '2026-05-15T11:00:00.000Z',
    attachments: [
      { name: 'LoanApplication_WebbHoldings.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'MortgageStatement_WebbHoldings.pdf', documentRef: 'documents/mortgage_statement.pdf' },
      { name: 'Appraisal_WebbHoldings.pdf', documentRef: 'documents/appraisal.pdf' },
    ],
  });
  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'), JSON.stringify(singleTurnIntake(intake), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 3 docs + 1-event sequence`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
