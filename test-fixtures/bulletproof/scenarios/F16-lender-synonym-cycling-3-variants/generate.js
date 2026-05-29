#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthMortgageStatement, synthAppraisal } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { linearTurns } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');
const SCENARIO_ID = 'F16';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const broker = BROKERS.jonathan_ferrara, borrower = BORROWERS.marcus_webb;
  const property = ADDRESSES.edmonton_tory;
  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), await synthLoanApp({
    borrowerName: borrower.fullName, propertyAddress: property.full,
    propertyValue: 650000, loanAmount: 280000,
    transactionType: 'Refinance', mortgagePosition: '1st mortgage',
    existingFirstMortgageBalance: 225000, existingFirstMortgageLender: 'RBC',
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'mortgage_statement.pdf'), await synthMortgageStatement({
    borrowerName: borrower.fullName, propertyAddress: property.full, lender: 'Royal Bank of Canada',
    balance: 225000, payoffAmount: 226500, interestRate: 5.45, validityDate: '2026-06-15',
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), await synthAppraisal({
    propertyAddress: property.full, appraisedValue: 650000,
  }));
  const t1 = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Refinance — ${borrower.fullName}`,
    textBody: `Hi Franco,\n\nRefi for ${borrower.fullName}, existing first with RBC.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-t1@bulletproof.synthetic`,
    date: '2026-05-15T10:00:00.000Z',
    attachments: [
      { name: 'LoanApplication_Webb.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'MortgageStatement_Webb.pdf', documentRef: 'documents/mortgage_statement.pdf' },
      { name: 'Appraisal_Webb.pdf', documentRef: 'documents/appraisal.pdf' },
    ],
  });
  const t2 = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Re: Refinance — ${borrower.fullName}`,
    textBody: `Quick follow-up — Royal Bank payout statement is the most recent (attached to original). Standard payout within validity window.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-t2@bulletproof.synthetic`,
    date: '2026-05-16T11:00:00.000Z',
  });
  const t3 = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Re: Refinance — ${borrower.fullName}`,
    textBody: `Borrower asked about alternative lender quotes — would B of M be a fit if Royal Bank renewal terms aren't competitive? Not a switch request yet, just exploring.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-t3@bulletproof.synthetic`,
    date: '2026-05-17T14:00:00.000Z',
  });
  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'), JSON.stringify(linearTurns([t1, t2, t3]), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 3 docs + 3-event sequence`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
