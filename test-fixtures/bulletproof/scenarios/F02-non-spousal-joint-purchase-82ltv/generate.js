#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthAppraisal, synthNOA } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { singleTurnIntake } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');
const SCENARIO_ID = 'F02';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const broker = BROKERS.jonathan_ferrara;
  const jointName = `${BORROWERS.david_okafor.fullName} and ${BORROWERS.jennifer_tran.fullName}`;
  const property = ADDRESSES.mississauga_winston;
  // 82% LTV purchase: 738/900
  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), await synthLoanApp({
    borrowerName: jointName, propertyAddress: property.full,
    propertyValue: 900000, loanAmount: 738000,
    transactionType: 'Purchase', mortgagePosition: '1st mortgage',
    annualIncome: 285000,
    extraText: `Non-spousal co-applicants: business partners (50/50 title). David Okafor income $132k; Jennifer Tran income $153k.`,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), await synthAppraisal({
    propertyAddress: property.full, appraisedValue: 900000,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'noa.pdf'), await synthNOA({
    borrowerName: jointName, taxYear: '2024', incomeReported: 285000,
  }));
  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Purchase — ${jointName} (82% LTV)`,
    textBody: `Hi Franco,\n\nNon-spousal joint purchase: ${jointName} buying ${property.full} as business partners (50/50 title). Purchase price $900k, loan amount $738k (82% LTV).\n\nCombined income $285k. Both NOAs attached. Lender wants additional collateral conversation given the elevated LTV.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: '2026-05-15T11:00:00.000Z',
    attachments: [
      { name: 'LoanApplication_Okafor_Tran.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'Appraisal_Property.pdf', documentRef: 'documents/appraisal.pdf' },
      { name: 'NOA_Combined.pdf', documentRef: 'documents/noa.pdf' },
    ],
  });
  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'), JSON.stringify(singleTurnIntake(intake), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 3 docs + 1-event sequence`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
