const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');

// Synthesize PDFs whose text is extractable by Vienna's pdf-parse (v1.1.1)
// pipeline. Direct pdf-lib output triggers parse errors ("Invalid PDF
// structure" / "bad XRef entry") because pdf-parse's old PDF.js fork rejects
// pdf-lib's flate streams and xref table format. pdfkit hits the same issue.
//
// Working pattern: load an existing pdf-parse-compatible PDF as base (its
// structure survives pdf-lib's save round-trip), append a NEW page with our
// synthesized text via drawText, then remove the original pages. The result
// is a single-page PDF that pdf-parse extracts cleanly, with our content as
// the only visible text.
//
// PDFs are ~310KB each because the base template's resources (fonts, AcroForm
// metadata) are retained. Acceptable for fixture storage; batch 1 = ~100 docs
// ~30MB. Worth optimizing if Phase 2 fixture count balloons.

// Union Borrower Intake (57KB) is the smallest pdf-parse-compatible seed in
// forms/; Loan Application Form is 309KB which would balloon fixture
// footprint to ~150MB at full matrix scale.
const SEED_TEMPLATE = path.join(__dirname, '..', '..', '..', 'forms', 'Union Borrower Intake Form.pdf');
let SEED_BYTES_CACHE = null;
const loadSeed = () => {
  if (!SEED_BYTES_CACHE) SEED_BYTES_CACHE = fs.readFileSync(SEED_TEMPLATE);
  return SEED_BYTES_CACHE;
};

// Build PDF: load seed, add new page with content sections, remove originals.
// Sections: [{ label, body }] — label rendered bold, body lines rendered below.
const buildDoc = async ({ title, sections }) => {
  const doc = await PDFDocument.load(loadSeed());
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([612, 792]);
  let y = 760;
  page.drawText(title, { x: 50, y, size: 16, font: fontBold });
  y -= 30;

  for (const section of sections) {
    if (y < 100) {
      page = doc.addPage([612, 792]);
      y = 760;
    }
    if (section.label) {
      page.drawText(section.label, { x: 50, y, size: 11, font: fontBold });
      y -= 16;
    }
    const lines = String(section.body || '').split('\n');
    for (const line of lines) {
      if (y < 60) {
        page = doc.addPage([612, 792]);
        y = 760;
      }
      page.drawText(line, { x: 60, y, size: 10, font });
      y -= 14;
    }
    y -= 8;
  }

  // Remove all original template pages (preserved during load, drop now so
  // our content is the only extractable text).
  const totalPages = doc.getPageCount();
  const synthesizedPageCount = totalPages - 1; // wrong: we added pages on top
  // Pages are appended at end; original pages are at indices [0 .. orig-1].
  // After our adds, our pages are at [orig .. total-1]. Remove indices [orig-1 .. 0].
  // We don't track orig count here directly — recompute: load seed, count pages.
  const seedDoc = await PDFDocument.load(loadSeed());
  const seedPageCount = seedDoc.getPageCount();
  for (let i = seedPageCount - 1; i >= 0; i--) {
    doc.removePage(i);
  }

  return Buffer.from(await doc.save());
};

// Loan Application — F1.LA / F1.PV / F1.BN / F1.MP / F1.TT / F1.FB / F1.EL /
// F1.AI / F1.CS source-hierarchy paths.
const synthLoanApp = async (opts) => {
  const {
    borrowerName,
    borrowerLegalName,
    propertyAddress,
    propertyValue,
    loanAmount,
    transactionType = 'Refinance',
    mortgagePosition = '1st mortgage',
    existingFirstMortgageBalance,
    existingFirstMortgageLender,
    annualIncome,
    creditScore,
    pageAnnotations = [],
    extraText = '',
  } = opts;

  const sections = [
    { label: 'BORROWER INFORMATION', body: [
      `Borrower name: ${borrowerName || ''}`,
      borrowerLegalName ? `Legal name: ${borrowerLegalName}` : '',
      annualIncome ? `Annual income: $${Number(annualIncome).toLocaleString()}` : '',
      creditScore ? `Credit score: ${creditScore}` : '',
    ].filter(Boolean).join('\n') },
    { label: 'PROPERTY INFORMATION', body: [
      `Subject property address: ${propertyAddress || ''}`,
      propertyValue ? `Property value: $${Number(propertyValue).toLocaleString()}` : '',
    ].filter(Boolean).join('\n') },
    { label: 'LOAN INFORMATION', body: [
      loanAmount ? `Loan amount requested: $${Number(loanAmount).toLocaleString()}` : '',
      `Transaction type: ${transactionType}`,
      `Mortgage position: ${mortgagePosition}`,
      existingFirstMortgageBalance ? `Existing first mortgage balance: $${Number(existingFirstMortgageBalance).toLocaleString()}` : '',
      existingFirstMortgageLender ? `Existing first mortgage lender: ${existingFirstMortgageLender}` : '',
    ].filter(Boolean).join('\n') },
  ];

  for (const annotation of pageAnnotations) {
    sections.push({ label: '', body: `[Page 1 annotation] ${annotation}` });
  }
  if (extraText) {
    sections.push({ label: 'ADDITIONAL INFORMATION', body: extraText });
  }

  return buildDoc({ title: 'LOAN APPLICATION', sections });
};

// Mortgage Payout Statement — F1.FB / F1.EL. Includes payout-statement
// keywords so deals.js text-fallback classifier catches via content.
const synthMortgageStatement = async (opts) => {
  const {
    borrowerName,
    propertyAddress,
    lender,
    accountNumber = '****' + Math.floor(Math.random() * 9000 + 1000),
    balance,
    payoffAmount,
    interestRate,
    validityDate,
  } = opts;

  // Production-faithful anchors (Sub-phase 6 Option A): real payout statements
  // use "Outstanding Principal Balance" + "TOTAL PAYOUT AMOUNT" + lender in the
  // header + a "Property Address" block — the conventions Vienna's deterministic
  // canonical-fields extractors (extractFromMortgageStatement) were tuned to on
  // verified RBC/TD/CIBC corpus. Prior synthetic text ("Current balance:" /
  // "Payout amount:") matched none → canonical_map sparse → Snapshot TBD.
  const sections = [
    { label: `${lender || 'Lender'} — Mortgage Payout Statement`, body: [
      `Lender: ${lender || ''}`,
      `Mortgage Account No.: ${accountNumber}`,
      `Borrower: ${borrowerName || ''}`,
      `Property Address: ${propertyAddress || ''}`,
    ].filter(Boolean).join('\n') },
    { label: 'STATEMENT OF MORTGAGE', body: [
      balance ? `Outstanding Principal Balance $${Number(balance).toLocaleString()}` : '',
      payoffAmount ? `TOTAL PAYOUT AMOUNT $${Number(payoffAmount).toLocaleString()}` : '',
      interestRate ? `Annual Interest Rate: ${interestRate}%` : '',
      validityDate ? `Payout valid until: ${validityDate}` : '',
      'Per diem interest applies after the validity date.',
    ].filter(Boolean).join('\n') },
  ];

  return buildDoc({ title: 'MORTGAGE PAYOUT STATEMENT', sections });
};

// Property Appraisal — F1.PV cross-source.
const synthAppraisal = async (opts) => {
  const {
    propertyAddress,
    appraisedValue,
    appraiserName = 'AIC Appraisal Services Inc.',
    appraisalDate = new Date().toISOString().slice(0, 10),
    comparableSales = 3,
  } = opts;

  // Production-faithful anchors (Sub-phase 6 Option A): real appraisal reports
  // carry a "SUBJECT PROPERTY" / "Civic Address" block and a reconciliation
  // section stating "Reconciled Market Value" / "OPINION OF VALUE" / "Final
  // Value Opinion" — the conventions Vienna's extractFromAppraisal was tuned to
  // (HarrisonBowker / Pinnacle verified corpus). Prior synthetic text
  // ("Appraised market value:") matched none → market_value null → Snapshot
  // "Appraised Value: TBD".
  const sections = [
    { label: 'PROPERTY APPRAISAL REPORT', body: [
      'SUBJECT PROPERTY',
      `Civic Address: ${propertyAddress || ''}`,
      `Effective date of appraisal: ${appraisalDate}`,
      `Appraiser: ${appraiserName}`,
    ].filter(Boolean).join('\n') },
    { label: 'RECONCILIATION AND FINAL VALUE OPINION', body: [
      `Comparable sales analyzed: ${comparableSales}`,
      'Final value estimate developed via the direct comparison approach.',
      `Reconciled Market Value: $${Number(appraisedValue).toLocaleString()}`,
    ].filter(Boolean).join('\n') },
  ];

  return buildDoc({ title: 'PROPERTY APPRAISAL', sections });
};

// CRA Notice of Assessment — F1.AI.
const synthNOA = async (opts) => {
  const { borrowerName, taxYear = '2024', incomeReported } = opts;

  const sections = [
    { label: 'NOTICE OF ASSESSMENT', body: [
      'Canada Revenue Agency / Agence du revenu du Canada',
      `Tax year: ${taxYear}`,
      `Taxpayer: ${borrowerName || ''}`,
      incomeReported ? `Total income reported: $${Number(incomeReported).toLocaleString()}` : '',
      'Notice of assessment summary attached.',
    ].filter(Boolean).join('\n') },
  ];

  return buildDoc({ title: 'NOTICE OF ASSESSMENT', sections });
};

module.exports = {
  buildDoc,
  synthLoanApp,
  synthMortgageStatement,
  synthAppraisal,
  synthNOA,
};
