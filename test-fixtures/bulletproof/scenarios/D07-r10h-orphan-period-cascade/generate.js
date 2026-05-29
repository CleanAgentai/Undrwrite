#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthMortgageStatement, synthAppraisal } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { correctionSequence } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES, LENDERS } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');
const SCENARIO_ID = 'D07';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const broker = BROKERS.jonathan_ferrara;
  const borrower = BORROWERS.marcus_webb;
  const property = ADDRESSES.edmonton_tory;
  const lender = LENDERS.rbc;

  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), await synthLoanApp({
    borrowerName: borrower.fullName, propertyAddress: property.full,
    propertyValue: 650000, loanAmount: 280000,
    transactionType: 'Refinance', mortgagePosition: '1st mortgage',
    existingFirstMortgageBalance: 225000, existingFirstMortgageLender: lender.name,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'mortgage_statement.pdf'), await synthMortgageStatement({
    borrowerName: borrower.fullName, propertyAddress: property.full, lender: lender.name,
    balance: 225000, payoffAmount: 226500, interestRate: 5.45, validityDate: '2026-06-15',
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), await synthAppraisal({
    propertyAddress: property.full, appraisedValue: 650000,
  }));

  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Refinance — ${borrower.fullName}`,
    textBody: `Hi Franco,\n\nRefi for ${borrower.fullName}.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: '2026-05-15T10:00:00.000Z',
    attachments: [
      { name: 'LoanApplication_Webb.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'MortgageStatement_Webb.pdf', documentRef: 'documents/mortgage_statement.pdf' },
      { name: 'Appraisal_Webb.pdf', documentRef: 'documents/appraisal.pdf' },
    ],
  });

  // Correction phrasing chosen to exercise R10-H sweep at orphan-period-prone position.
  // Vienna's internal-review-tail markers (R5-C-a) following a sentence end create the
  // dangling-period cascade if sweep regex anchoring is wrong.
  const correction = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Re: Refinance — ${borrower.fullName}`,
    textBody: `Hi Franco,\n\nUpdate on the file. Note for internal review: borrower's exit strategy involves a property sale, expected mid-2027. Please flag this for the underwriter.\n\nRest of the package is unchanged.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-correction@bulletproof.synthetic`,
    date: '2026-05-16T09:30:00.000Z',
  });

  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'),
    JSON.stringify(correctionSequence({ intake, correction, correctionDelayMs: 23 * 3600 * 1000 + 30 * 60 * 1000 }), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 3 docs + 2-event sequence`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
