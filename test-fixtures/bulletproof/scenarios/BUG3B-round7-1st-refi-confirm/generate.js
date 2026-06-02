#!/usr/bin/env node
// BUG3B Round-7 reproduction fixture — staging replay of the mortgage-position
// re-flagging loop Franco reported in Round 7/8.
//
// Shape (per Porter's approved replay scope, 2026-06-01):
//   - Clean 1st-refi intake with a REAL (filled) RBC mortgage statement.
//   - Explicit position language in the broker email AND the loan_application:
//     "first mortgage refinance — refinancing existing RBC mortgage".
//   - Loan amount + property value present → standalone LTV 60% ($390k/$650k).
//   - Two bare CONFIRMATION turns that do NOT re-state refinance language
//     ("yes, it's a first mortgage" / "correct, 1st position") — the specific
//     turn shape Round 7 reported as failing (a confirmation that does not
//     re-extract transaction_type=refinance on the current turn).
//
// Substrate reuses A26's verified RBC refinance values: existing balance $225k,
// lender Royal Bank of Canada, mortgage_statement lender-match present (the
// inputs to the R11-A refinance carve-out in inferMortgagePositionFromExistingBalance).
const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthMortgageStatement, synthAppraisal } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { multiCorrectionSequence } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES, LENDERS } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');
const SCENARIO_ID = 'BUG3B';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const broker = BROKERS.jonathan_ferrara;
  const borrower = BORROWERS.marcus_webb;
  const property = ADDRESSES.edmonton_tory;
  const lender = LENDERS.rbc;

  // 60% standalone LTV: 390000 / 650000. Explicit 1st-mortgage position in the
  // loan_application LOAN INFORMATION block; existing RBC $225k being refinanced.
  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), await synthLoanApp({
    borrowerName: borrower.fullName, borrowerLegalName: borrower.legalName,
    propertyAddress: property.full,
    propertyValue: 650000, loanAmount: 390000,
    transactionType: 'Refinance',
    mortgagePosition: '1st mortgage',
    existingFirstMortgageBalance: 225000, existingFirstMortgageLender: lender.name,
    extraText: 'Purpose: first mortgage refinance — refinancing existing Royal Bank of Canada mortgage to a new first-position mortgage. No second mortgage or subordinate financing on title.',
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'mortgage_statement.pdf'), await synthMortgageStatement({
    borrowerName: borrower.fullName, propertyAddress: property.full, lender: lender.name,
    balance: 225000, payoffAmount: 226500, interestRate: 5.45, validityDate: '2026-07-15',
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), await synthAppraisal({
    propertyAddress: property.full, appraisedValue: 650000,
  }));

  // Turn 0 — broker intake, explicit 1st-refi language.
  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Refinance — ${borrower.fullName}`,
    textBody: `Hi Franco,\n\nNew file for ${borrower.fullName}. This is a first mortgage refinance — we're refinancing the existing ${lender.name} mortgage into a new first-position mortgage. Property at ${property.full}.\n\nLoan amount $390,000. Property value $650,000 (appraisal attached), so we're at 60% LTV. Existing ${lender.name} balance is about $225k — payout statement attached.\n\nFull package attached.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: '2026-05-15T10:00:00.000Z',
    attachments: [
      { name: 'LoanApplication_Webb.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'MortgageStatement_Webb.pdf', documentRef: 'documents/mortgage_statement.pdf' },
      { name: 'Appraisal_Webb.pdf', documentRef: 'documents/appraisal.pdf' },
    ],
  });

  // Turn 1 — bare confirmation (no refinance language). Reply to Vienna.
  const confirm1 = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Re: Refinance — ${borrower.fullName}`,
    textBody: `Hi Franco,\n\nYes, it's a first mortgage. Confirming first position on title.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-confirm1@bulletproof.synthetic`,
    date: '2026-05-15T14:00:00.000Z',
  });

  // Turn 2 — second bare confirmation, adjacent context, still no refinance verb.
  const confirm2 = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Re: Refinance — ${borrower.fullName}`,
    textBody: `Hi Franco,\n\nCorrect, 1st position. Nothing subordinate on title. Let me know if you need anything else from me.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-confirm2@bulletproof.synthetic`,
    date: '2026-05-15T16:00:00.000Z',
  });

  fs.writeFileSync(
    path.join(FIXTURE_DIR, 'events.json'),
    JSON.stringify(multiCorrectionSequence([intake, confirm1, confirm2]), null, 2),
  );
  console.log(`[${SCENARIO_ID}] Generated 3 docs + 3-event sequence (intake + 2 confirmation turns)`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
