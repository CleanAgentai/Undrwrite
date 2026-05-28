#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthMortgageStatement } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { singleTurnIntake } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES, LENDERS } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');
const SCENARIO_ID = 'F25';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const broker = BROKERS.franco, borrower = BORROWERS.marcus_webb;
  const property = ADDRESSES.edmonton_tory, lender = LENDERS.rbc;
  // Loan_app omits loanAmount (broker is sole source); no appraisal attached (PV not in any source)
  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), await synthLoanApp({
    borrowerName: borrower.fullName, propertyAddress: property.full,
    transactionType: 'Refinance', mortgagePosition: '1st mortgage',
    existingFirstMortgageBalance: 225000, existingFirstMortgageLender: lender.name,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'mortgage_statement.pdf'), await synthMortgageStatement({
    borrowerName: borrower.fullName, propertyAddress: property.full, lender: lender.name,
    balance: 225000, payoffAmount: 226500, interestRate: 5.45, validityDate: '2026-06-15',
  }));
  // No appraisal — property_value has NO source anywhere
  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Refinance — ${borrower.fullName}`,
    textBody: `Hi Franco,\n\nRefi for ${borrower.fullName} at ${property.full}. Loan amount $280,000. Existing first mortgage with ${lender.name}, balance per attached payout statement.\n\nAppraisal will follow next week — borrower's appraiser booking pending.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: '2026-05-15T10:00:00.000Z',
    attachments: [
      { name: 'LoanApplication_Webb.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'MortgageStatement_Webb.pdf', documentRef: 'documents/mortgage_statement.pdf' },
    ],
  });
  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'), JSON.stringify(singleTurnIntake(intake), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 2 docs (no appraisal; property_value has no source) + 1-event sequence`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
