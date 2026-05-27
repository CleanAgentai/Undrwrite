#!/usr/bin/env node
// Generator for scenario B01 — discrepancyHold ACTIVE on major loan_amount
// discrepancy. Two-event sequence: initial intake with loan_app doc showing
// $95k; broker correction email asserting actual loan amount is $280k.

const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthMortgageStatement, synthAppraisal } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { correctionSequence } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES, LENDERS } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');

const SCENARIO_ID = 'B01';
const RUN_TIMESTAMP = '2026-05-15T10:00:00.000Z';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });

  const broker = BROKERS.franco;
  const borrower = BORROWERS.marcus_webb;
  const property = ADDRESSES.edmonton_tory;
  const lender = LENDERS.rbc;

  // Loan application doc shows $95,000 (broker will later correct to $280,000)
  const loanAppPdf = await synthLoanApp({
    borrowerName: borrower.fullName,
    borrowerLegalName: borrower.legalName,
    propertyAddress: property.full,
    propertyValue: 650000,
    loanAmount: 95000,
    transactionType: 'Refinance',
    mortgagePosition: '1st mortgage',
    existingFirstMortgageBalance: 225000,
    existingFirstMortgageLender: lender.name,
    annualIncome: 145000,
  });
  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), loanAppPdf);

  const mortStmtPdf = await synthMortgageStatement({
    borrowerName: borrower.fullName,
    propertyAddress: property.full,
    lender: lender.name,
    balance: 225000,
    payoffAmount: 226500,
    interestRate: 5.45,
    validityDate: '2026-06-15',
  });
  fs.writeFileSync(path.join(DOCS_DIR, 'mortgage_statement.pdf'), mortStmtPdf);

  const apprPdf = await synthAppraisal({
    propertyAddress: property.full,
    appraisedValue: 650000,
  });
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), apprPdf);

  // Event 0 — initial intake (broker submits package, loan_app shows $95k)
  const intake = buildPostmarkPayload({
    from: broker.email,
    fromName: broker.name,
    subject: `Refinance submission — ${borrower.fullName}`,
    textBody: `Hi Franco,

Submitting a refinance opportunity for ${borrower.fullName}.

Property: ${property.full}
Existing first mortgage: ${lender.name}
Current balance: $225,000

I've attached the loan application, mortgage statement, and appraisal. Will reply with the rest of the package shortly.

Thanks,
${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: RUN_TIMESTAMP,
    attachments: [
      { name: 'LoanApplication_Webb.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'MortgageStatement_Webb.pdf', documentRef: 'documents/mortgage_statement.pdf' },
      { name: 'Appraisal_Webb.pdf', documentRef: 'documents/appraisal.pdf' },
    ],
  });

  // Event 1 — broker correction (loan amount is actually $280k, not the $95k
  // shown on the loan_app form — broker forgot to update before submitting)
  const correction = buildPostmarkPayload({
    from: broker.email,
    fromName: broker.name,
    subject: `Re: Refinance submission — ${borrower.fullName}`,
    textBody: `Quick correction — the loan application form has an outdated number. ${borrower.fullName}'s actual loan request is $280,000, not the $95,000 shown on the form. We're refinancing to pull equity for renovations. Property value $650,000 stands.

Please use $280,000 for the underwriting.

${broker.signoff}`,
    messageId: `${SCENARIO_ID}-correction@bulletproof.synthetic`,
    date: '2026-05-16T14:30:00.000Z',
  });

  const events = correctionSequence({ intake, correction, correctionDelayMs: 28 * 3600 * 1000 });
  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'), JSON.stringify(events, null, 2));

  console.log(`[${SCENARIO_ID}] Generated 3 docs + ${events.length}-event sequence`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
