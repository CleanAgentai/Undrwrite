#!/usr/bin/env node
// A14-PAYOUT — controlled A/B comparison vs A14 to ISOLATE Finding 1a.
//
// IDENTICAL figures to A14 (existing BMO $380k + new $460k / $815k property →
// additive combined 103%, standalone 56%). The ONLY difference: this fixture
// ADDS the explicit payout signal A14 lacks — "Refinancing the existing BMO
// first mortgage ... will be paid out at closing" + lender match — so R11-B-3's
// carve-out FIRES → canonical combined = standalone = 56%.
//
// Isolation logic (off-hours staging run): with canonical now 56, the single
// remaining question is whether the LLM extracted_data.ltv_percent STILL
// computes additive (103) even with the payout signal present:
//   - LLM 103 while canonical 56 → Finding 1a is ACTIVE (Bug 1 gate-fix resolves
//     a real divergence; pre-fix this would wrongly escalate on LLM 103).
//   - LLM also 56 → Finding 1a is LATENT-robustness (LLM+canonical agree; the
//     gate-fix is defense-in-depth).
// Only the payout signal differs from A14, so any behavior delta is the carve-out.

const fs = require('fs');
const path = require('path');
const { synthLoanApp, synthMortgageStatement, synthAppraisal } = require('../../lib/pdfSynth');
const { buildPostmarkPayload } = require('../../lib/emailSynth');
const { singleTurnIntake } = require('../../lib/conversationSynth');
const { BORROWERS, BROKERS, ADDRESSES, LENDERS } = require('../../lib/shapes');

const FIXTURE_DIR = __dirname;
const DOCS_DIR = path.join(FIXTURE_DIR, 'documents');
const SCENARIO_ID = 'A14P';

(async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const broker = BROKERS.jonathan_ferrara;
  const borrower = BORROWERS.sarah_chen;
  const property = ADDRESSES.vancouver_kingsway;
  const lender = LENDERS.bmo;
  const lenderToken = 'BMO'; // single-cap-word synonym matches the R11-A txn-type pattern + findLenderInWindow

  fs.writeFileSync(path.join(DOCS_DIR, 'loan_application.pdf'), await synthLoanApp({
    borrowerName: borrower.fullName, propertyAddress: property.full,
    propertyValue: 815000, loanAmount: 460000,
    transactionType: 'Refinance', mortgagePosition: '1st mortgage',
    existingFirstMortgageBalance: 380000, existingFirstMortgageLender: lender.name,
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'mortgage_statement.pdf'), await synthMortgageStatement({
    borrowerName: borrower.fullName, propertyAddress: property.full, lender: lender.name,
    balance: 380000, payoffAmount: 381500, interestRate: 5.05, validityDate: '2026-06-25',
  }));
  fs.writeFileSync(path.join(DOCS_DIR, 'appraisal.pdf'), await synthAppraisal({
    propertyAddress: property.full, appraisedValue: 815000,
  }));

  const intake = buildPostmarkPayload({
    from: broker.email, fromName: broker.name,
    subject: `Refinance — ${borrower.fullName}`,
    textBody: `Hi Franco,\n\nRefinancing the existing ${lenderToken} first mortgage for ${borrower.fullName} at ${property.street} — the ${lenderToken} mortgage will be paid out at closing. Loan amount $460,000. Estimated LTV ~56%.\n\nAppraisal attached. Exit strategy: sale of the property at end of term.\n\n${broker.signoff}`,
    messageId: `${SCENARIO_ID}-intake@bulletproof.synthetic`,
    date: '2026-05-15T10:00:00.000Z',
    attachments: [
      { name: 'LoanApplication_Chen.pdf', documentRef: 'documents/loan_application.pdf' },
      { name: 'MortgageStatement_Chen.pdf', documentRef: 'documents/mortgage_statement.pdf' },
      { name: 'Appraisal_Chen.pdf', documentRef: 'documents/appraisal.pdf' },
    ],
  });

  fs.writeFileSync(path.join(FIXTURE_DIR, 'events.json'), JSON.stringify(singleTurnIntake(intake), null, 2));
  console.log(`[${SCENARIO_ID}] Generated 3 docs + 1-event sequence (payout-signal A/B vs A14)`);
})().catch(e => { console.error(`[${SCENARIO_ID}] FAIL:`, e); process.exit(1); });
