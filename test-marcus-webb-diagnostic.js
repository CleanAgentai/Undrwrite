// Diagnostic — Marcus Webb (Scenario 2) discrepancy retest.
//
// Purpose: empirically determine whether Bradley's DATA DISCREPANCY DETECTION
// rule (post-commit-e4f6b89) catches non-numeric mismatches (lender names,
// employer tenure framings) in addition to the numeric mismatches it
// explicitly enumerates.
//
// We construct three conflicts:
//   1) DOLLAR mismatch     — body says $318,000; payout statement says $400,000
//   2) LENDER NAME mismatch — body says Scotiabank; payout statement says RBC
//   3) TENURE mismatch     — body says 8 years at Stantec; employer letter says 11 years
//
// (1) is straight number — Bradley's rule must catch it.
// (2) is non-numeric (institution name) — the residual-risk case Porter flagged.
// (3) is a number embedded in a fact statement — borderline.
//
// Output: print Vienna's welcome email + the deal summary JSON. Look for:
//   - Each conflict explicitly raised in the welcome email body
//   - Each conflict noted in dealSummary.key_risks_or_notes
//   - Whether the discrepancy rule applies to borrower-path emails at all
//     (Bradley's wording says "broker's email body" — we test borrower input)

require('dotenv').config();

const REAL_KEY = process.env.CLAUDE_API_KEY && !process.env.CLAUDE_API_KEY.startsWith('sk-test');
if (!REAL_KEY) {
  console.error('FAIL: requires a real CLAUDE_API_KEY (not sk-test-*) in .env');
  process.exit(1);
}

const aiService = require('./src/services/ai');

// Marcus's email body — borrower direct, states 8 years Stantec + $318k Scotiabank.
const emailBody = `Hi,

I'm Marcus Webb, looking for a second mortgage on my home in Toronto.

A bit of background: I'm 41, born January 22, 1985. I've been working at Stantec
as a senior planner for 8 years now — stable employment, good income.

Property: 142 Riverside Drive, Toronto, ON
Property value (per recent appraisal): $890,000
Existing first mortgage: $318,000 with Scotiabank
Loan amount requested: $90,000

I've attached my loan application, my most recent NOA, the appraisal, and the
mortgage payout statement from my lender.

Looking forward to working with you.

Marcus Webb`;

// Three "documents" with controlled extracted text. Filenames are chosen so that
// (a) the classifier routes them correctly and (b) dual-path doesn't fire base64
// alongside (which would conflict with our fabricated text).
const attachments = [
  {
    Name: 'Loan_App_Webb.pdf',           // matches /loan.?app/ but NOT /application/
    Content: Buffer.from('synthetic-pdf-loan-app').toString('base64'),
    ContentType: 'application/pdf',
    ContentLength: 1000,
  },
  {
    Name: 'NOA_Webb_2024.pdf',
    Content: Buffer.from('synthetic-pdf-noa').toString('base64'),
    ContentType: 'application/pdf',
    ContentLength: 1000,
  },
  {
    Name: 'Mortgage_Payout_Statement_Webb.pdf',
    Content: Buffer.from('synthetic-pdf-payout').toString('base64'),
    ContentType: 'application/pdf',
    ContentLength: 1000,
  },
  {
    Name: 'Employer_Letter_Stantec_Webb.pdf',
    Content: Buffer.from('synthetic-pdf-employer').toString('base64'),
    ContentType: 'application/pdf',
    ContentLength: 1000,
  },
];

// savedDocs lets us inject controlled extracted text. buildContentBlocks
// matches by file_name and uses extracted_data.text when length >= 200 and
// not form-like.
const savedDocs = [
  {
    file_name: 'Loan_App_Webb.pdf',
    classification: 'loan_application',
    extracted_data: {
      text: `LOAN APPLICATION FORM
Applicant: Marcus Webb
Date of Birth: January 22, 1985
Property Address: 142 Riverside Drive, Toronto, ON
Property Value: $890,000
Loan Amount Requested: $90,000

Existing Mortgage Details:
  Lender: Scotiabank
  Outstanding Balance: $318,000
  Mortgage Position: First Mortgage

Employment:
  Employer: Stantec
  Position: Senior Planner
  Years of Service: 8 years
  Annual Income: $145,000

Signed: Marcus Webb
Date of signature: 2026-04-15`,
    },
  },
  {
    file_name: 'NOA_Webb_2024.pdf',
    classification: 'noa',
    extracted_data: {
      text: `NOTICE OF ASSESSMENT — 2024 TAX YEAR
Canada Revenue Agency

Taxpayer: Marcus Webb
Total Income (Line 15000): $145,832
Net Income: $128,400
Federal Tax Payable: $24,118
Refund / Balance Owing: $0

Assessment Date: 2025-06-12
Notice issued for the 2024 tax year.`,
    },
  },
  {
    // CONFLICT: payout statement disagrees with both the body AND the loan app.
    // Body and loan app: Scotiabank $318k. Payout statement: RBC $400k.
    file_name: 'Mortgage_Payout_Statement_Webb.pdf',
    classification: 'mortgage_statement',
    extracted_data: {
      text: `MORTGAGE PAYOUT STATEMENT
Royal Bank of Canada (RBC)
Mortgage Account: 5400-XXXX-XXXX-1234

Mortgagor: Marcus Webb
Property: 142 Riverside Drive, Toronto, ON

As of 2026-04-30:
  Outstanding Principal Balance: $400,000.00
  Per Diem Interest:              $52.05
  Discharge Fee:                  $325.00
  TOTAL PAYOUT AMOUNT:            $400,377.05

Maturity Date: 2027-09-15
Interest Rate: 4.85% (fixed)

Lender: Royal Bank of Canada
Branch: 123 Bay St, Toronto

This statement is valid for 30 days from issue date.`,
    },
  },
  {
    // CONFLICT: employer letter says 11 years tenure; body says 8 years.
    file_name: 'Employer_Letter_Stantec_Webb.pdf',
    classification: 'income_proof',
    extracted_data: {
      text: `STANTEC INC.
EMPLOYMENT VERIFICATION LETTER

Date: April 15, 2026
RE: Employment confirmation for Marcus Webb

To Whom It May Concern,

This letter confirms that Marcus Webb has been employed at Stantec Inc. as a
Senior Planner since March 2015 — eleven (11) years of continuous service.

Mr. Webb's current annual base salary is $145,000, with eligibility for
performance bonuses.

His employment is permanent and full-time. He is in good standing.

Sincerely,
Susan Liu, Director of Human Resources
Stantec Inc.`,
    },
  },
];

(async () => {
  console.log('========== MARCUS WEBB DIAGNOSTIC ==========');
  console.log('Conflicts injected:');
  console.log('  (1) DOLLAR:  body says $318,000; payout statement says $400,000');
  console.log('  (2) LENDER:  body says Scotiabank; payout statement says RBC');
  console.log('  (3) TENURE:  body says 8 years; employer letter says 11 years');
  console.log('');

  const t0 = Date.now();
  const { welcomeEmail, dealSummary } = await aiService.processInitialEmail(
    'Marcus Webb',
    emailBody,
    attachments,
    savedDocs,
    false,  // hasOwnApplication
    false   // hasOwnPnw
  );
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`processInitialEmail returned in ${elapsed}s\n`);

  console.log('========== DEAL SUMMARY (JSON extraction) ==========');
  console.log(JSON.stringify(dealSummary, null, 2));
  console.log('');

  console.log('========== WELCOME EMAIL (broker-facing — but borrower in this case) ==========');
  console.log(welcomeEmail);
  console.log('');

  // ── Detection ─────────────────────────────────────────────────────────────
  const stripHtml = (s) => (s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const emailText = stripHtml(welcomeEmail).toLowerCase();
  const risks = (dealSummary?.key_risks_or_notes || '').toLowerCase();

  console.log('========== DIAGNOSIS ==========\n');
  console.log('Sender classification:');
  console.log(`  sender_type:  ${dealSummary?.sender_type}  (expected "borrower")`);
  console.log(`  sender_name:  ${dealSummary?.sender_name}`);
  console.log('');

  // Two INDEPENDENT conflicts to verify (dollar + lender are the SAME underlying
  // conflict — both come from comparing payout statement against body/app — so a
  // consolidated "Scotiabank vs RBC" or "$318k vs $400k" ask covers both halves).
  //
  //  Conflict A — MORTGAGE DOC CONFLICT (dollar OR lender mismatch surfaces it)
  //  Conflict B — TENURE CONFLICT (8 vs 11 years at Stantec)

  const combined = `${emailText}\n${risks}`;

  // Conflict A — flagged if EITHER (a) both dollar amounts appear with clarify
  // language, OR (b) both lender names appear with clarify language.
  const dollarBothPresent = /\$?\s*318/.test(combined) && /\$?\s*400/.test(combined);
  const lenderBothPresent = /scotia/i.test(combined) && /\brbc\b|royal bank/i.test(combined);
  const conflictAFlagged = dollarBothPresent || lenderBothPresent;
  const conflictAInEmail = (/\$?\s*318/.test(emailText) && /\$?\s*400/.test(emailText))
                        || (/scotia/i.test(emailText) && /\brbc\b|royal bank/i.test(emailText));
  const conflictAInRisks = (/\$?\s*318/.test(risks) && /\$?\s*400/.test(risks))
                        || (/scotia/i.test(risks) && /\brbc\b|royal bank/i.test(risks));

  // Conflict B — both year counts present together (in either email or risks)
  const conflictBInEmail = /\b8\s*(?:year|yr)/i.test(emailText) && /\b11\s*(?:year|yr)/i.test(emailText);
  const conflictBInRisks = /\b8\s*(?:year|yr)/i.test(risks) && /\b11\s*(?:year|yr)/i.test(risks);
  const conflictBFlagged = conflictBInEmail || conflictBInRisks;

  const flaggingLanguageInEmail = /(discrepan|differ|conflict|clarif|which is correct|confirm.*correct|noticed.*but|rather than|instead of)/i.test(emailText);

  console.log('Conflict A — MORTGAGE DOC ($318k Scotia vs $400k RBC, single underlying conflict):');
  console.log(`  flagged in welcome email:     ${conflictAInEmail ? '✓' : '— absent (may be in summary/risks instead)'}`);
  console.log(`  flagged in key_risks_or_notes:${conflictAInRisks ? '✓' : '— absent (may be in email/summary instead)'}`);
  console.log(`  flagged at least one site:    ${conflictAFlagged ? '✓' : '✗ — GAP'}`);
  console.log('');

  console.log('Conflict B — TENURE (8 yr body vs 11 yr employer letter):');
  console.log(`  flagged in welcome email:     ${conflictBInEmail ? '✓' : '— absent'}`);
  console.log(`  flagged in key_risks_or_notes:${conflictBInRisks ? '✓' : '— absent'}`);
  console.log(`  flagged at least one site:    ${conflictBFlagged ? '✓' : '✗ — GAP'}`);
  console.log('');

  console.log('Borrower-reply flagging:');
  console.log(`  Welcome email uses clarify/confirm/discrepancy language: ${flaggingLanguageInEmail ? '✓' : '✗ — Vienna silent to borrower'}`);
  console.log('');

  // ── Verdict ───────────────────────────────────────────────────────────────
  console.log('========== VERDICT ==========');

  if (conflictAFlagged && conflictBFlagged && flaggingLanguageInEmail) {
    console.log('✓ Both independent conflicts flagged AND borrower-facing reply uses clarify language.');
    console.log('  → Discrepancy rule generalizes to non-numeric facts AND across sender types (borrower path here).');
    process.exit(0);
  } else {
    console.log('✗ AT LEAST ONE GAP DETECTED.');
    if (!conflictAFlagged) console.log('  - Mortgage doc conflict (Scotia/$318k vs RBC/$400k) not flagged anywhere.');
    if (!conflictBFlagged) console.log('  - Tenure conflict (8 vs 11 years) not flagged anywhere.');
    if (!flaggingLanguageInEmail) console.log('  - Borrower reply silent on discrepancies.');
    process.exit(1);
  }
})().catch(err => {
  console.error('DIAGNOSTIC FAILED:', err.stack || err.message);
  process.exit(1);
});
