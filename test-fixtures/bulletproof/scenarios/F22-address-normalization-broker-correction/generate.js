#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthMortgageStatement, synthAppraisal } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { correctionSequence } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES, LENDERS } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');
const SCENARIO_ID = 'F22';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const broker = BROKERS.jonathan_ferrara, borrower = BORROWERS.marcus_webb;
  const abbr = '1142 Tory Rd NW, Edmonton, AB T6R 2K8';
  const full = ADDRESSES.edmonton_tory.full;
  const lender = LENDERS.rbc;
  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), await synthLoanApp({
    borrowerName: borrower.fullName, propertyAddress: abbr,
    propertyValue: 650000, loanAmount: 280000,
    transactionType: 'Refinance', mortgagePosition: '1st mortgage',
    existingFirstMortgageBalance: 225000, existingFirstMortgageLender: lender.name,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'mortgage_statement.pdf'), await synthMortgageStatement({
    borrowerName: borrower.fullName, propertyAddress: abbr, lender: lender.name,
    balance: 225000, payoffAmount: 226500, interestRate: 5.45, validityDate: '2026-06-15',
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), await synthAppraisal({
    propertyAddress: abbr, appraisedValue: 650000,
  }));
  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Refinance — ${borrower.fullName}`,
    textBody: `Hi Franco,\n\nRefi for ${borrower.fullName}, ${abbr}.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: '2026-05-15T10:00:00.000Z',
    attachments: [
      { name: 'LoanApplication_Webb.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'MortgageStatement_Webb.pdf', documentRef: 'documents/mortgage_statement.pdf' },
      { name: 'Appraisal_Webb.pdf', documentRef: 'documents/appraisal.pdf' },
    ],
  });
  const correction = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Re: Refinance — ${borrower.fullName}`,
    textBody: `Quick clean-up — full property address is ${full} (fully-spelled-out; matches title). Same property as the abbreviated form in earlier email.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-correction@bulletproof.synthetic`,
    date: '2026-05-16T11:00:00.000Z',
  });
  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'),
    JSON.stringify(correctionSequence({ intake, correction, correctionDelayMs: 25 * 3600 * 1000 }), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 3 docs + 2-event sequence`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
