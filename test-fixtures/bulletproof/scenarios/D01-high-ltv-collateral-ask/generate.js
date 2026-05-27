#!/usr/bin/env node
// Generator for scenario D01 — high-LTV dedicated collateral-ask (R10-C-1).
// Refinance with LTV >80% triggers awaiting_collateral state + dedicated
// minimal-ask generator. Single-event sequence.

const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthMortgageStatement, synthAppraisal } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { singleTurnIntake } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES, LENDERS } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');

const SCENARIO_ID = 'D01';
const RUN_TIMESTAMP = '2026-05-15T11:15:00.000Z';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });

  const broker = BROKERS.jonathan_ferrara;
  const borrower = BORROWERS.david_okafor;
  const property = ADDRESSES.mississauga_winston;
  const lender = LENDERS.td;

  // 83% LTV: $540k requested against $650k appraised
  const loanAppPdf = await synthLoanApp({
    borrowerName: borrower.fullName,
    borrowerLegalName: borrower.legalName,
    propertyAddress: property.full,
    propertyValue: 650000,
    loanAmount: 540000,
    transactionType: 'Refinance',
    mortgagePosition: '1st mortgage',
    existingFirstMortgageBalance: 420000,
    existingFirstMortgageLender: lender.name,
    annualIncome: 132000,
  });
  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), loanAppPdf);

  const mortStmtPdf = await synthMortgageStatement({
    borrowerName: borrower.fullName,
    propertyAddress: property.full,
    lender: lender.name,
    balance: 420000,
    payoffAmount: 422100,
    interestRate: 5.15,
    validityDate: '2026-06-20',
  });
  fs.writeFileSync(path.join(DOCS_DIR, 'mortgage_statement.pdf'), mortStmtPdf);

  const apprPdf = await synthAppraisal({
    propertyAddress: property.full,
    appraisedValue: 650000,
  });
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), apprPdf);

  const intake = buildPostmarkPayload({
    from: broker.email,
    fromName: broker.name,
    subject: `High-LTV refinance — ${borrower.fullName}`,
    textBody: `Hi Franco,

Submitting a refinance for ${borrower.fullName}.

Property: ${property.full}
Appraised value: $650,000
Existing first mortgage: ${lender.name}, balance $420,000
Loan amount requested: $540,000
LTV: 83% (we know it's elevated — borrower has solid income and credit to support)

Borrower: ${borrower.fullName}, owner-operator at Okafor Logistics, 12 years in business. Income $132k stable.

Full package attached: loan application, mortgage statement, appraisal.

Thanks,
${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: RUN_TIMESTAMP,
    attachments: [
      { name: 'LoanApplication_Okafor.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'MortgageStatement_Okafor.pdf', documentRef: 'documents/mortgage_statement.pdf' },
      { name: 'Appraisal_Okafor.pdf', documentRef: 'documents/appraisal.pdf' },
    ],
  });

  const events = singleTurnIntake(intake);
  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'), JSON.stringify(events, null, 2));

  console.log(`[${SCENARIO_ID}] Generated 3 docs + ${events.length}-event sequence`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
