#!/usr/bin/env node
// Generator for scenario C03 — broker initial intent on new deal (clean
// baseline). First-touch intake with complete document package + no
// discrepancy + no corrections. Single-event sequence.

const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthMortgageStatement, synthAppraisal, synthNOA } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { singleTurnIntake } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES, LENDERS } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');

const SCENARIO_ID = 'C03';
const RUN_TIMESTAMP = '2026-05-15T09:30:00.000Z';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });

  const broker = BROKERS.jason_mercer;
  const borrower = BORROWERS.patricia_simmons;
  const property = ADDRESSES.toronto_glencairn;
  const lender = LENDERS.scotia;

  const loanAppPdf = await synthLoanApp({
    borrowerName: borrower.fullName,
    borrowerLegalName: borrower.legalName,
    propertyAddress: property.full,
    propertyValue: 920000,
    loanAmount: 460000,
    transactionType: 'Refinance',
    mortgagePosition: '1st mortgage',
    existingFirstMortgageBalance: 380000,
    existingFirstMortgageLender: lender.name,
    annualIncome: 168000,
  });
  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), loanAppPdf);

  const mortStmtPdf = await synthMortgageStatement({
    borrowerName: borrower.fullName,
    propertyAddress: property.full,
    lender: lender.name,
    balance: 380000,
    payoffAmount: 382000,
    interestRate: 4.95,
    validityDate: '2026-06-30',
  });
  fs.writeFileSync(path.join(DOCS_DIR, 'mortgage_statement.pdf'), mortStmtPdf);

  const apprPdf = await synthAppraisal({
    propertyAddress: property.full,
    appraisedValue: 920000,
  });
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), apprPdf);

  const noaPdf = await synthNOA({
    borrowerName: borrower.fullName,
    taxYear: '2024',
    incomeReported: 168400,
  });
  fs.writeFileSync(path.join(DOCS_DIR, 'noa.pdf'), noaPdf);

  const intake = buildPostmarkPayload({
    from: broker.email,
    fromName: broker.name,
    subject: `Refinance — ${borrower.fullName}`,
    textBody: `Hi Franco,

New refinance opportunity for ${borrower.fullName}.

Property: ${property.full}
Property value (appraised): $920,000
Existing first mortgage: ${lender.name}, balance $380,000
Loan amount requested: $460,000 (refinance pull-out)
LTV: approximately 50%

Borrower: ${borrower.fullName}, senior planner at Stantec for 8 years. Recent NOA attached.

I've attached the complete package: loan application, mortgage statement, appraisal, and NOA.

Thanks,
${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: RUN_TIMESTAMP,
    attachments: [
      { name: 'LoanApplication_Simmons.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'MortgageStatement_Simmons.pdf', documentRef: 'documents/mortgage_statement.pdf' },
      { name: 'Appraisal_Simmons.pdf', documentRef: 'documents/appraisal.pdf' },
      { name: 'NOA_Simmons.pdf', documentRef: 'documents/noa.pdf' },
    ],
  });

  const events = singleTurnIntake(intake);
  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'), JSON.stringify(events, null, 2));

  console.log(`[${SCENARIO_ID}] Generated 4 docs + ${events.length}-event sequence`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
