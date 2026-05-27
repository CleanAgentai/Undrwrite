#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthMortgageStatement, synthAppraisal } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { singleTurnIntake } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES, LENDERS } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');
const SCENARIO_ID = 'E14';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const broker = BROKERS.jonathan_ferrara, borrower = BORROWERS.webb_holdings_ltd;
  const property = ADDRESSES.mississauga_winston, lender = LENDERS.rbc;
  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), await synthLoanApp({
    borrowerName: borrower.fullName, propertyAddress: property.full,
    propertyValue: 1850000, loanAmount: 1100000,
    transactionType: 'Refinance', mortgagePosition: '1st mortgage',
    existingFirstMortgageBalance: 890000, existingFirstMortgageLender: lender.name,
    extraText: `Corporate borrower: ${borrower.fullName}.\nIncorporated: Alberta, 2018.\nDirectors/Officers: Marcus Webb (sole director & officer).\nBeneficial owners (>25%): Marcus Webb (100%).\nProperty held in corporate name; refinancing investment property held by holding company.\nCorporate Articles + Director Resolution authorizing the mortgage to be provided separately.`,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'mortgage_statement.pdf'), await synthMortgageStatement({
    borrowerName: borrower.fullName, propertyAddress: property.full, lender: lender.name,
    balance: 890000, payoffAmount: 892000, interestRate: 5.55, validityDate: '2026-06-22',
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), await synthAppraisal({
    propertyAddress: property.full, appraisedValue: 1850000,
  }));
  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Corporate refinance — ${borrower.fullName}`,
    textBody: `Hi Franco,\n\nCorporate refi for ${borrower.fullName} on investment property at ${property.full}.\n\nBorrower: ${borrower.fullName} (Alberta holding co; Marcus Webb sole director + 100% beneficial owner).\nProperty value $1,850,000.\nExisting 1st mortgage ${lender.name}, balance $890,000.\nNew loan amount: $1,100,000.\nLTV: 59%.\n\nCorporate Articles + Director Resolution authorizing mortgage attached separately on signing. AML/PEP applies to Marcus as ultimate beneficial owner.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: '2026-05-15T13:00:00.000Z',
    attachments: [
      { name: 'LoanApplication_WebbHoldings.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'MortgageStatement_WebbHoldings.pdf', documentRef: 'documents/mortgage_statement.pdf' },
      { name: 'Appraisal_WebbHoldings.pdf', documentRef: 'documents/appraisal.pdf' },
    ],
  });
  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'), JSON.stringify(singleTurnIntake(intake), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 3 docs + 1-event sequence`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
