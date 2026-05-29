#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthMortgageStatement, synthAppraisal } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { correctionSequence } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES, LENDERS } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');
const SCENARIO_ID = 'F01';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const broker = BROKERS.jonathan_ferrara;
  const jointName = `${BORROWERS.marcus_webb.fullName} and Patricia Webb`;
  const property = ADDRESSES.edmonton_tory, lender = LENDERS.rbc;
  // 78% LTV: 507/650
  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), await synthLoanApp({
    borrowerName: jointName, propertyAddress: property.full,
    propertyValue: 650000, loanAmount: 507000,
    transactionType: 'Refinance', mortgagePosition: '1st mortgage',
    existingFirstMortgageBalance: 395000, existingFirstMortgageLender: lender.name,
    annualIncome: 245000,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'mortgage_statement.pdf'), await synthMortgageStatement({
    borrowerName: jointName, propertyAddress: property.full, lender: lender.name,
    balance: 395000, payoffAmount: 396800, interestRate: 5.45, validityDate: '2026-06-15',
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), await synthAppraisal({
    propertyAddress: property.full, appraisedValue: 650000,
  }));
  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Refinance — ${jointName}`,
    textBody: `Hi Franco,\n\nJoint refi for ${jointName} (spouses). Property ${property.full}, 78% LTV, $507k requested.\n\n${broker.signoff}`,
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
    subject: `Re: Refinance — ${jointName}`,
    textBody: `Correction — this is actually a 2nd mortgage*, keeping the existing first with ${lender.name} in place. Same $507k requested, same property, joint applicants unchanged. Just behind the existing first.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-correction@bulletproof.synthetic`,
    date: '2026-05-16T10:00:00.000Z',
  });
  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'),
    JSON.stringify(correctionSequence({ intake, correction, correctionDelayMs: 24 * 3600 * 1000 }), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 3 docs + 2-event sequence`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
