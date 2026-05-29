#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthMortgageStatement, synthAppraisal } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { singleTurnIntake } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES, LENDERS } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');
const SCENARIO_ID = 'E12';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const broker = BROKERS.jonathan_ferrara;
  const jointName = `${BORROWERS.david_okafor.fullName} and ${BORROWERS.jennifer_tran.fullName}`;
  const property = ADDRESSES.mississauga_winston, lender = LENDERS.td;
  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), await synthLoanApp({
    borrowerName: jointName, propertyAddress: property.full,
    propertyValue: 720000, loanAmount: 460000,
    transactionType: 'Refinance', mortgagePosition: '1st mortgage',
    existingFirstMortgageBalance: 360000, existingFirstMortgageLender: lender.name,
    annualIncome: 285000,
    extraText: `Co-applicants: ${BORROWERS.david_okafor.fullName} (50% title) and ${BORROWERS.jennifer_tran.fullName} (50% title). Unrelated co-owners — business partners. Income reported separately on NOAs; combined household exposure used for DSCR calc. Each applicant's credit and income to be assessed independently per joint-non-spousal underwriting.`,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'mortgage_statement.pdf'), await synthMortgageStatement({
    borrowerName: jointName, propertyAddress: property.full, lender: lender.name,
    balance: 360000, payoffAmount: 361500, interestRate: 5.15, validityDate: '2026-06-22',
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), await synthAppraisal({
    propertyAddress: property.full, appraisedValue: 720000,
  }));
  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Refinance — ${jointName}`,
    textBody: `Hi Franco,\n\nNon-spousal joint refi: ${jointName} are unrelated co-owners (business partners, 50/50 title) at ${property.full}.\n\nLoan amount $460,000. Combined income $285k (David $132k + Jennifer $153k); each filed separately. Both have strong credit independently.\n\nExit strategy: borrower intends to sell the property at end of term.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: '2026-05-15T11:00:00.000Z',
    attachments: [
      { name: 'LoanApplication_Okafor_Tran.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'MortgageStatement_Okafor_Tran.pdf', documentRef: 'documents/mortgage_statement.pdf' },
      { name: 'Appraisal_Property.pdf', documentRef: 'documents/appraisal.pdf' },
    ],
  });
  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'), JSON.stringify(singleTurnIntake(intake), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 3 docs + 1-event sequence`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
