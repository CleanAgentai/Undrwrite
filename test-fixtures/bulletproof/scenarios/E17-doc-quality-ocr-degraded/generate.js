#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { buildDoc, synthMortgageStatement, synthAppraisal } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { singleTurnIntake } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES, LENDERS } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');
const SCENARIO_ID = 'E17';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const broker = BROKERS.franco;
  const property = ADDRESSES.edmonton_tory, lender = LENDERS.rbc;
  // OCR-degraded loan_app: O→0, l→1, S→5 substitutions; lowercase noise; spacing artifacts
  const ocrSections = [
    { label: 'B0RROWER 1NF0RMATI0N', body: 'B0rrower name: Marcu5 Anth0ny Webb\nAnnua1 incom3: $145,O00' },
    { label: 'PR0PERTY 1NF0RMATI0N', body: 'Subject prOperty: 1142 T0ry Road NW, Edm0nt0n, AB T6R 2K8\nProperty va1ue: $65O,OOO' },
    { label: 'L0AN INF0RMATI0N', body: 'Lo4n amount: $28O,OOO\nTransacti0n typ3: Refinanc3\nM0rtgage p0siti0n: 1st m0rtgage\nExisting first m0rtgage b4lance: $225,O00\nExisting first m0rtgage 1ender: R0yal Bank 0f Canada' },
  ];
  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), await buildDoc({ title: 'L0AN APPLICATI0N (scanned)', sections: ocrSections }));
  fs.writeFileSync(path.join(DOCS_DIR, 'mortgage_statement.pdf'), await synthMortgageStatement({
    borrowerName: BORROWERS.marcus_webb.fullName, propertyAddress: property.full, lender: lender.name,
    balance: 225000, payoffAmount: 226500, interestRate: 5.45, validityDate: '2026-06-15',
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), await synthAppraisal({
    propertyAddress: property.full, appraisedValue: 650000,
  }));
  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Refinance — ${BORROWERS.marcus_webb.fullName}`,
    textBody: `Hi Franco,\n\nRefi for ${BORROWERS.marcus_webb.fullName} at ${property.full}. Loan amount $280,000.\n\nFYI — loan app was scanned from a paper copy, scan quality is rough. Borrower will re-fill the digital form if extraction issues come up.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: '2026-05-15T10:00:00.000Z',
    attachments: [
      { name: 'LoanApplication_Webb_scanned.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'MortgageStatement_Webb.pdf', documentRef: 'documents/mortgage_statement.pdf' },
      { name: 'Appraisal_Webb.pdf', documentRef: 'documents/appraisal.pdf' },
    ],
  });
  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'), JSON.stringify(singleTurnIntake(intake), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 3 docs (loan_app OCR-degraded) + 1-event sequence`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
