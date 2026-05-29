#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthAppraisal } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { singleTurnIntake } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');
const SCENARIO_ID = 'E10';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const broker = BROKERS.jonathan_ferrara, borrower = BORROWERS.david_okafor;
  const property = ADDRESSES.mississauga_winston;
  // Construction: bare-land value $280k; loan $620k for build; total value at completion $900k. 69% LTV at completion.
  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), await synthLoanApp({
    borrowerName: borrower.fullName, propertyAddress: property.full,
    propertyValue: 280000, loanAmount: 620000,
    transactionType: 'Construction', mortgagePosition: '1st mortgage',
    extraText: `Construction loan — financing build of single-family residence on bare land.\nLand value: $280,000 (current).\nConstruction cost: $620,000.\nProjected as-completed value: $900,000.\nDraw schedule: 4 progress draws (foundation, framing, interior, completion).\nProjected completion: 14 months from start.\nLoan-to-completed-value: 69%.`,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), await synthAppraisal({
    propertyAddress: property.full, appraisedValue: 280000,
    appraiserName: 'AIC Appraisal Services — Construction Appraisal',
  }));
  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Construction loan — ${borrower.fullName}`,
    textBody: `Hi Franco,\n\nConstruction loan for ${borrower.fullName} on bare-land lot at ${property.full}.\n\nLand value (current): $280,000\nConstruction cost: $620,000 (4-draw schedule)\nProjected completion value: $900,000\nLoan amount: $620,000\nLTV-to-completion: 69%\n\nBuilder: Okafor Construction (borrower is owner-builder; 12 years building experience).\n\nKnow Vienna's typical flow is for completed-property mortgages — let me know if construction is in-scope or if we should route differently.\n\nExit strategy: borrower intends to sell the property at end of term.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: '2026-05-15T11:00:00.000Z',
    attachments: [
      { name: 'LoanApplication_Okafor.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'Appraisal_Okafor.pdf', documentRef: 'documents/appraisal.pdf' },
    ],
  });
  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'), JSON.stringify(singleTurnIntake(intake), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 2 docs + 1-event sequence`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
