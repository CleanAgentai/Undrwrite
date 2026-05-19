// ─────────────────────────────────────────────────────────────────────────
// Cluster B — canonical-field extraction (ROLE-SCOPED, anchor-derived)
// ─────────────────────────────────────────────────────────────────────────
// Source-of-truth JS extraction over (email body, savedDocs) → per-field
// tuple list [{value, source}+]. Consumed by discrepancy-engine.
//
// REDESIGN HISTORY (this session):
//   v1 (rejected by pilot FP gate, 58/58 corpus flagged): type-scoped
//     fields (postal_code / property_address / existing_lender_name) swept
//     ALL docs. Conflated different roles — borrower residence vs subject
//     property vs employer office vs comparable-sale postal codes all
//     counted as the same field, trivially discrepancy-flagged.
//   v2 (this file): role-scoped fields (subject_property_*,
//     existing_first_mortgage_*, primary_borrower_*) extracted via REAL
//     anchor strings derived from the corpus's actual doc structure.
//     Anchors NOT designed from assumption — pulled from real Marcus /
//     Ethan / Grace / Anna + corpus sample inspection.
//
// SCOPE — residential second-mortgage shape only. Commercial / corporate-
// mortgage submissions return early via `isCommercialSubmission` — engine
// produces zero canonical-field tuples for them, zero discrepancy flags.
// Commercial-detector is itself FP-measured against the corpus.
//
// REAL ANCHORS (greppable, audited from corpus inspection 2026-05-19):
//
//   Email body — broker template:
//     `*Property:* <addr line 1>\n<line 2 with postal>*`
//     `*Borrower:* <name>`
//     `*Mortgage Amount Requested:* $<amount>`
//     `*Appraised Value:* $<amount>`
//     `*LTV:* ~<pct>%`
//
//   mortgage_statement (RBC / TD / CIBC / Scotiabank verified):
//     Header first 200 chars contains canonical lender name.
//     `Property Address` label followed by 1-2 lines of address.
//     `Outstanding Principal Balance$<amount>`
//     `TOTAL PAYOUT AMOUNT$<amount>` (only on real payout statements)
//
//   property_tax (City of Edmonton / Calgary verified):
//     `Property Address` label followed by 1-2 lines of address.
//     `Total Assessed Value$<amount>` (often concatenated with neighbors).
//
//   credit_report (Equifax/TransUnion + Union Lending Corp formats):
//     `BORROWER INFORMATION\nFull Name:<name>`
//     `Current Address:<addr>` (borrower residence — OUT OF SCOPE for
//        subject_property fields; could be investment property)
//     TRADE LINES section:
//       `<Lender>Mortgage<DateOpened>$<Limit>$<Balance>$<Payment>R1`
//       (single-mortgage trade line — multiple lenders typical for
//        Visa/LOC/Installment but only one or two for Mortgage type)
//     Excludes: `Mortgage Application` / `MORTGAGE INQUIRY` (these are
//        inquiries, NOT trade lines).
//
//   appraisal (HarrisonBowker + Pinnacle verified):
//     `SUBJECT PROPERTY` header section.
//     `Civic Address:<addr>` OR `Subject Property\n<addr>` shape.
//     `OPINION OF VALUE` / `Reconciled Market Value` / `Final Value Opinion`.
//
//   AML/PEP forms (Private Mortgage Link template):
//     `Full Legal Name\n<name>`
//     `Current Address\n<addr>` (borrower-declared address — OUT OF SCOPE
//        for subject_property)
//
// Fields (9, all role-scoped):
//   subject_property_postal_code
//   subject_property_address
//   subject_property_market_value (appraisal-derived)
//   subject_property_assessment_value (property_tax-derived; DISTINCT field)
//   requested_loan_amount
//   existing_first_mortgage_lender
//   existing_first_mortgage_balance (BY-LENDER partition)
//   existing_first_mortgage_payout_total (BY-LENDER partition)
//   primary_borrower_full_name

// ════════════════════════════════════════════════════════════════════
// LENDER_SYNONYMS — hardcoded entity-resolution map
// ════════════════════════════════════════════════════════════════════
const LENDER_SYNONYMS = {
  'RBC':           ['RBC', 'Royal Bank', 'Royal Bank of Canada', 'RBC Royal Bank'],
  'TD':            ['TD', 'TD Bank', 'TD Canada Trust', 'Toronto-Dominion', 'Toronto-Dominion Bank', 'TD Bank Group'],
  'CIBC':          ['CIBC', 'Canadian Imperial Bank of Commerce'],
  'Scotiabank':    ['Scotiabank', 'Bank of Nova Scotia', 'BNS', 'The Bank of Nova Scotia'],
  'BMO':           ['BMO', 'Bank of Montreal', 'BMO Bank of Montreal'],
  'National Bank': ['National Bank', 'NBC', 'National Bank of Canada'],
  'Tangerine':     ['Tangerine', 'Tangerine Bank'],
  'Manulife':      ['Manulife', 'Manulife Bank', 'Manulife Bank of Canada'],
  'Equitable':     ['Equitable', 'Equitable Bank', 'EQ Bank'],
  'Haventree':     ['Haventree', 'Haventree Bank'],
  'MCAP':          ['MCAP', 'MCAP Financial'],
  'ATB':           ['ATB', 'ATB Financial'],
  'HSBC':          ['HSBC', 'HSBC Bank Canada'],
  'Desjardins':    ['Desjardins', 'Caisse Desjardins'],
  'First National':['First National', 'First National Financial'],
  'Home Trust':    ['Home Trust', 'Home Trust Company'],
};

const LENDER_REVERSE_MAP = (() => {
  const m = {};
  for (const [canonical, synonyms] of Object.entries(LENDER_SYNONYMS)) {
    for (const syn of synonyms) {
      m[syn.toLowerCase().trim()] = canonical;
    }
  }
  return m;
})();

// Sort synonyms by descending length so multi-word matches win before substring matches.
const LENDER_SYNONYMS_BY_LENGTH = Object.keys(LENDER_REVERSE_MAP).sort((a, b) => b.length - a.length);

const normalizeLender = (str) => {
  if (!str || typeof str !== 'string') return null;
  const cleaned = str.trim().replace(/[.,]/g, '').toLowerCase();
  if (LENDER_REVERSE_MAP[cleaned]) return LENDER_REVERSE_MAP[cleaned];
  // Try longest-match
  for (const syn of LENDER_SYNONYMS_BY_LENGTH) {
    if (cleaned === syn || cleaned.startsWith(syn + ' ') || cleaned.startsWith(syn + '_')) {
      return LENDER_REVERSE_MAP[syn];
    }
  }
  return null; // Unrecognized — NOT collapsed to a canonical id, returned null to skip.
};

// Find first lender synonym mentioned in a text window. Returns canonical id or null.
const findLenderInWindow = (text) => {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const syn of LENDER_SYNONYMS_BY_LENGTH) {
    // Word boundary match (avoid substring inside other words).
    const re = new RegExp(`\\b${syn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(lower)) return LENDER_REVERSE_MAP[syn];
  }
  return null;
};

// ════════════════════════════════════════════════════════════════════
// Normalizers
// ════════════════════════════════════════════════════════════════════

const POSTAL_RE_GLOBAL = /\b([A-Z]\d[A-Z])\s?(\d[A-Z]\d)\b/g;
const POSTAL_RE_SINGLE = /\b([A-Z]\d[A-Z])\s?(\d[A-Z]\d)\b/;

const normalizePostal = (str) => {
  if (!str) return null;
  const cleaned = String(str).toUpperCase().replace(/\s+/g, '');
  if (/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(cleaned)) return cleaned;
  return null;
};

const normalizeMoney = (val) => {
  if (val == null) return null;
  if (typeof val === 'number') return Math.round(val);
  const cleaned = String(val).replace(/[$,\s]/g, '');
  const n = parseFloat(cleaned);
  if (!isFinite(n)) return null;
  return Math.round(n);
};

const ADDRESS_ABBREV_EXPAND = [
  [/\bblvd\.?\b/gi, 'boulevard'],
  [/\bdr\.?\b/gi, 'drive'],
  [/\bst\.?\b/gi, 'street'],
  [/\bave\.?\b/gi, 'avenue'],
  [/\brd\.?\b/gi, 'road'],
  [/\bcir\.?\b/gi, 'circle'],
  [/\bct\.?\b/gi, 'court'],
  [/\bln\.?\b/gi, 'lane'],
  [/\bpl\.?\b/gi, 'place'],
  [/\bcres\.?\b/gi, 'crescent'],
];

const normalizeAddress = (str) => {
  if (!str) return null;
  let out = String(str).toLowerCase();
  for (const [re, repl] of ADDRESS_ABBREV_EXPAND) out = out.replace(re, repl);
  out = out
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return out || null;
};

// Extract the street-number + street-name + suffix portion of a longer address string.
// Strict: requires <digits>(1-5) <space> <name (≤6 words, no digit-only)> <recognized suffix word>
// Optional trailing directional (NW/NE/SW/SE/N/S/E/W).
const ADDR_LINE_RE = /\b(\d{1,5})\s+((?:[A-Za-z][A-Za-z'\-]*\s+){0,6}?(?:Boulevard|Drive|Street|Avenue|Road|Circle|Court|Lane|Place|Crescent|Way|Square|Terrace|Close|Highway|Parkway|Trail|Park|Heights|Hill|Hills|Mews|Park|Pointe|Promenade|Ridge|Run|Walk)(?:\s+(?:NW|NE|SW|SE|N|S|E|W))?)\b/i;

const extractAddressLine = (text) => {
  if (!text) return null;
  const m = text.match(ADDR_LINE_RE);
  if (!m) return null;
  return (m[1] + ' ' + m[2]).replace(/\s+/g, ' ').trim();
};

// ════════════════════════════════════════════════════════════════════
// Commercial detector — out-of-scope for residential 2nd-mortgage gate
// ════════════════════════════════════════════════════════════════════

// Returns true if the submission is commercial / corporate / non-residential.
// Conservative — only flags COMMERCIAL when CLEAR (corporate borrower name,
// or appraisal explicitly mentions commercial/mixed-use subject property,
// or loan purpose is commercial).
const isCommercialSubmission = (emailBody, savedDocs, borrowerName = null) => {
  // Signal 1: borrower name has corp suffix
  const corpRe = /\b(?:Corp|Corporation|Inc|Incorporated|Ltd|Limited|LLC|LLP|LP|GP)\.?\b/i;
  if (borrowerName && corpRe.test(borrowerName)) return { commercial: true, signal: `borrower_name corp suffix: "${borrowerName}"` };
  // Signal 2: email body indicates commercial / mixed-use
  if (emailBody) {
    const m = emailBody.match(/\b(?:commercial|mixed[\s-]?use|multi[\s-]?user|industrial|retail\s+property|office\s+building|warehouse|hotel|motel|farm|agricultural)\b/i);
    if (m) return { commercial: true, signal: `email body keyword: "${m[0]}"` };
  }
  // Signal 3: appraisal mentions commercial / mixed-use / multi-user in subject property area
  for (const doc of (savedDocs || [])) {
    if (doc.classification !== 'appraisal') continue;
    const text = doc?.text || doc?.extracted_data?.text || '';
    // Look in first 3000 chars (subject property section typically up top)
    const head = text.slice(0, 3000);
    const m = head.match(/\b(?:multi[\s-]?user|mixed[\s-]?use|commercial)\s+(?:property|building|use)|\bsubject\s+property\b[^.]{0,500}\b(?:commercial|mixed[\s-]?use|multi[\s-]?user|industrial|retail|office|warehouse)\b/i);
    if (m) return { commercial: true, signal: `appraisal keyword in subject property section: "${m[0].slice(0, 60)}"` };
  }
  return { commercial: false };
};

// ════════════════════════════════════════════════════════════════════
// Helper: find anchor block in text
// ════════════════════════════════════════════════════════════════════

// Given text + an anchor regex, return the text BETWEEN the anchor match and
// the next anchor/blank-line/section-break (~`windowChars` chars max). Used
// to constrain value extraction to text NEAR a specific role anchor.
const findAnchorBlock = (text, anchorRe, windowChars = 250) => {
  if (!text) return null;
  const m = text.match(anchorRe);
  if (!m) return null;
  const start = m.index + m[0].length;
  return text.slice(start, start + windowChars);
};

const findAllAnchorBlocks = (text, anchorReGlobal, windowChars = 250) => {
  if (!text) return [];
  const out = [];
  let m;
  anchorReGlobal.lastIndex = 0;
  while ((m = anchorReGlobal.exec(text)) !== null) {
    const start = m.index + m[0].length;
    out.push(text.slice(start, start + windowChars));
  }
  return out;
};

// ════════════════════════════════════════════════════════════════════
// EXTRACTORS — role-scoped, anchor-derived
// ════════════════════════════════════════════════════════════════════

// ─── Email body — broker template fields ───
// Real shape (Marcus verbatim, observed across corpus):
//   *Borrower:* <name> *Property:* <addr line 1>\n<line 2 with postal>*<next-tag>
// The `*` markers come from Postmark's inbound conversion of `*bold*` markdown.

const extractFromEmailBody = (emailBody) => {
  const out = {
    subject_property_address: null,
    subject_property_postal_code: null,
    requested_loan_amount: null,
    subject_property_market_value: null,
  };
  if (!emailBody) return out;
  // Property block: between `*Property:*` and next `*`
  const propM = emailBody.match(/\*\s*Property\s*:\s*\*\s*([\s\S]+?)\*/i);
  if (propM) {
    const block = propM[1];
    const addr = extractAddressLine(block);
    if (addr) out.subject_property_address = normalizeAddress(addr);
    const postalM = block.match(POSTAL_RE_SINGLE);
    if (postalM) out.subject_property_postal_code = normalizePostal(postalM[1] + postalM[2]);
  } else {
    // Fallback for non-bold-template broker emails: line starting with "Property:"
    const lineM = emailBody.match(/Property\s*:\s*([\s\S]{0,200}?)(?:\n\n|\nLTV|\nAppraised|\nMortgage|$)/i);
    if (lineM) {
      const addr = extractAddressLine(lineM[1]);
      if (addr) out.subject_property_address = normalizeAddress(addr);
      const postalM = lineM[1].match(POSTAL_RE_SINGLE);
      if (postalM) out.subject_property_postal_code = normalizePostal(postalM[1] + postalM[2]);
    }
  }
  // Loan amount: `*Mortgage Amount Requested:* $X` or similar
  const loanM = emailBody.match(/\*?\s*(?:Mortgage\s+Amount\s+Requested|Loan\s+Amount\s+Requested|Mortgage\s+Amount|Loan\s+Amount)\s*:?\s*\*?\s*\$?\s*([\d,]+)/i);
  if (loanM) out.requested_loan_amount = normalizeMoney(loanM[1]);
  // Appraised value (broker-stated): `*Appraised Value:* $X`
  const apprM = emailBody.match(/\*?\s*(?:Appraised\s+Value|Property\s+Value|Purchase\s+Price)\s*:?\s*\*?\s*\$?\s*([\d,]+)/i);
  if (apprM) out.subject_property_market_value = normalizeMoney(apprM[1]);
  return out;
};

// ─── Mortgage statement — anchored Property Address + Balance + Payout Total ───

const extractFromMortgageStatement = (doc) => {
  const text = doc?.text || doc?.extracted_data?.text || '';
  const out = {
    subject_property_address: null,
    subject_property_postal_code: null,
    existing_first_mortgage_lender: null,
    existing_first_mortgage_balance: null,
    existing_first_mortgage_payout_total: null,
  };
  if (!text) return out;
  // Lender from header (first 200 chars) or filename fallback.
  const headLender = findLenderInWindow(text.slice(0, 200));
  const filenameLender = findLenderInWindow(doc.file_name || '');
  out.existing_first_mortgage_lender = headLender || filenameLender;

  // Property Address block (real anchor — works on RBC/TD/CIBC/Scotiabank verified).
  // PDF extraction concatenates labels: real text is "Property AddressMortgage Account No."
  // — no colon, no newline directly after "Address". Match the label loosely; the next
  // 250 chars contain the address-line value(s).
  const block = findAnchorBlock(text, /Property\s+Address/i, 250);
  if (block) {
    const addr = extractAddressLine(block);
    if (addr) out.subject_property_address = normalizeAddress(addr);
    const postalM = block.match(POSTAL_RE_SINGLE);
    if (postalM) out.subject_property_postal_code = normalizePostal(postalM[1] + postalM[2]);
  }

  // Outstanding Principal Balance (real anchor, Marcus verified)
  const balM = text.match(/Outstanding\s+Principal\s+Balance\s*\$?\s*([\d,]+(?:\.\d{2})?)/i);
  if (balM) out.existing_first_mortgage_balance = normalizeMoney(balM[1]);

  // TOTAL PAYOUT AMOUNT (only on real payout statements — Grace's TD Balance Statement
  // legitimately lacks this; Grace's TD doc is technically a balance statement persisted
  // as mortgage_statement classification per OOO sub-fix).
  const payoutM = text.match(/TOTAL\s+PAYOUT\s+AMOUNT\s*\$?\s*([\d,]+(?:\.\d{2})?)/i)
                || text.match(/Total\s+Payout\s+Amount\s*\$?\s*([\d,]+(?:\.\d{2})?)/i);
  if (payoutM) out.existing_first_mortgage_payout_total = normalizeMoney(payoutM[1]);

  return out;
};

// ─── Property tax — anchored Property Address + Total Assessed Value ───

const extractFromPropertyTax = (doc) => {
  const text = doc?.text || doc?.extracted_data?.text || '';
  const out = {
    subject_property_address: null,
    subject_property_postal_code: null,
    subject_property_assessment_value: null,
  };
  if (!text) return out;
  // Same loose anchor as mortgage_statement — PDF concatenation strips separators.
  const block = findAnchorBlock(text, /Property\s+Address/i, 250);
  if (block) {
    const addr = extractAddressLine(block);
    if (addr) out.subject_property_address = normalizeAddress(addr);
    const postalM = block.match(POSTAL_RE_SINGLE);
    if (postalM) out.subject_property_postal_code = normalizePostal(postalM[1] + postalM[2]);
  }
  const valM = text.match(/Total\s+Assessed\s+Value\s*\$?\s*([\d,]+)/i);
  if (valM) out.subject_property_assessment_value = normalizeMoney(valM[1]);
  return out;
};

// ─── Appraisal — Civic Address / SUBJECT PROPERTY block + OPINION OF VALUE ───

const extractFromAppraisal = (doc) => {
  const text = doc?.text || doc?.extracted_data?.text || '';
  const out = {
    subject_property_address: null,
    subject_property_postal_code: null,
    subject_property_market_value: null,
  };
  if (!text) return out;
  // Civic Address anchor (Pinnacle format verified — Marcus/Ethan).
  // Falls back to SUBJECT PROPERTY block scan.
  let block = findAnchorBlock(text, /Civic\s+Address\s*:?/i, 200);
  if (!block) {
    // Sub-block within SUBJECT PROPERTY (HarrisonBowker / generic).
    block = findAnchorBlock(text, /SUBJECT\s+PROPERTY/i, 600);
  }
  if (block) {
    const addr = extractAddressLine(block);
    if (addr) out.subject_property_address = normalizeAddress(addr);
    const postalM = block.match(POSTAL_RE_SINGLE);
    if (postalM) out.subject_property_postal_code = normalizePostal(postalM[1] + postalM[2]);
  }
  // Market value
  const valM = text.match(/OPINION\s+OF\s+VALUE\s*\n?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i)
            || text.match(/Reconciled\s+Market\s+Value\s*[:\n]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i)
            || text.match(/Final\s+Value\s+Opinion\s*[:\n]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i);
  if (valM) out.subject_property_market_value = normalizeMoney(valM[1]);
  return out;
};

// ─── Credit bureau — TRADE LINES section: first-mortgage lender + balance only ───

const extractFromCreditBureau = (doc) => {
  const text = doc?.text || doc?.extracted_data?.text || '';
  const out = {
    existing_first_mortgage_lender: null,
    existing_first_mortgage_balance: null,
    primary_borrower_full_name: null,
  };
  if (!text) return out;
  // Borrower name: two real formats observed in corpus.
  // (1) Pinnacle / Capital Bridge:  "Full Name:Marcus James Webb"  (colon + Title Case)
  // (2) Union Lending Corp:         "Full NameHABIBZAI, KOCHAY"    (no colon + LAST, FIRST CAPS)
  // Both formats have the name on a single line, followed by newline + next
  // label ("Date of Birth"). Use [ \t]+ (NOT \s+) between name tokens so the
  // capture stops at the line boundary — otherwise the next label ("Date")
  // bleeds into the captured name.
  const nameM = text.match(/Full\s+Name\s*:?\s*([A-Z][a-zA-Z'\-,]+(?:[ \t]+[A-Z][a-zA-Z'\-,]+){1,4})/);
  if (nameM) out.primary_borrower_full_name = nameM[1].replace(/,/g, '').replace(/\s+/g, ' ').trim();

  // Mortgage trade line — multiple formats observed:
  //   Format A (Pinnacle/Capital Bridge): "ScotiabankMortgageOct 2017$520,000$318,000$2,210/moR1"
  //                                       (concatenated, no spaces between Lender and "Mortgage")
  //   Format B (Union Lending Corp):     "SCOTIABANK — MORTGAGE\nAccount TypeMortgage (M)\n..."
  //   Both: limit/balance pair as "$X$Y" or "$X/$Y" or distinct lines.
  //
  // We restrict to TRADE LINES section (excluding inquiries / report headers) by:
  //   - finding "TRADE LINES" anchor and scanning following ~3000 chars; OR
  //   - if no anchor, scanning the whole text but EXCLUDING lines containing
  //     "Mortgage Application" or "MORTGAGE INQUIRY" (header / inquiry indicators).
  let tradeBlock = findAnchorBlock(text, /TRADE\s+LINES/i, 4000);
  if (!tradeBlock) tradeBlock = text; // fallback

  // Strip inquiry/header lines from the scan block.
  const cleaned = tradeBlock
    .split('\n')
    .filter(ln => !/(?:Mortgage\s+Application|MORTGAGE\s+INQUIRY|Mortgage\s+Inquiry|Requested\s+By|Requested\s+by)/i.test(ln))
    .join('\n');

  // Format A: "<Lender>Mortgage<MonthYear>$<X>$<Y>" — PDF extraction often
  // concatenates "<Lender>Mortgage" with no space between. The trailing `\b`
  // after `<Lender>` blocks this concatenated case — we use start-boundary
  // only and gate via the required `Mortgage` token immediately after.
  for (const syn of LENDER_SYNONYMS_BY_LENGTH) {
    const escaped = syn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const reA = new RegExp(`\\b${escaped}\\s*Mortgage\\s*(?:[A-Z][a-z]+\\s+\\d{4})?\\s*\\$([\\d,]+)\\s*\\$([\\d,]+)`, 'i');
    const mA = cleaned.match(reA);
    if (mA) {
      out.existing_first_mortgage_lender = LENDER_REVERSE_MAP[syn];
      const balance = normalizeMoney(mA[2]); // second figure is balance (first is limit)
      if (balance) out.existing_first_mortgage_balance = balance;
      return out;
    }
  }
  // Format B: "<LENDER> — MORTGAGE" (caps with dash) — but we have to extract balance separately
  for (const syn of LENDER_SYNONYMS_BY_LENGTH) {
    const escaped = syn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const reB = new RegExp(`\\b${escaped}\\b\\s*[—–-]\\s*MORTGAGE`, 'i');
    if (reB.test(cleaned)) {
      out.existing_first_mortgage_lender = LENDER_REVERSE_MAP[syn];
      // Find the balance line near this trade line (within 600 chars after the anchor)
      const idx = cleaned.search(reB);
      const followBlock = cleaned.slice(idx, idx + 600);
      const balanceM = followBlock.match(/Current\s+Balance\s*\$?\s*([\d,]+(?:\.\d{2})?)/i)
                    || followBlock.match(/Balance\s*[:\n]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i);
      if (balanceM) out.existing_first_mortgage_balance = normalizeMoney(balanceM[1]);
      return out;
    }
  }
  return out;
};

// ─── AML / PEP forms — Full Legal Name only (borrower address out of scope) ───

const extractFromAmlPep = (doc) => {
  const text = doc?.text || doc?.extracted_data?.text || '';
  const out = { primary_borrower_full_name: null };
  if (!text) return out;
  const m = text.match(/Full\s+Legal\s+Name\s*\n\s*([A-Z][a-zA-Z'\-]+(?:[ \t]+[A-Z][a-zA-Z'\-]+){1,4})/);
  if (m) out.primary_borrower_full_name = m[1].trim();
  return out;
};

// ─── Property tax — Owner Name (additional borrower-name source) ───

const extractBorrowerFromPropertyTax = (doc) => {
  const text = doc?.text || doc?.extracted_data?.text || '';
  // Property tax format: "Owner NameRoll NumberAssessment Year\n<Name>...<concat>"
  // Extract first capitalized name on the line following "Owner Name" label.
  const block = findAnchorBlock(text, /Owner\s+Name(?:\s+Roll|\s*\n)/i, 200);
  if (!block) return null;
  // Block starts with name, then concatenated roll number. Take leading name tokens.
  const m = block.match(/^\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4})/);
  return m ? m[1].trim() : null;
};

// ─── Top-level: extract everything per submission ───

const extractCanonicalFields = (emailBody, savedDocs, opts = {}) => {
  const map = {
    subject_property_address: [],
    subject_property_postal_code: [],
    subject_property_market_value: [],
    subject_property_assessment_value: [],
    requested_loan_amount: [],
    existing_first_mortgage_lender: [],
    existing_first_mortgage_balance: [],
    existing_first_mortgage_payout_total: [],
    primary_borrower_full_name: [],
  };

  const push = (field, value, source, extra = {}) => {
    if (value == null) return;
    map[field].push({ value, source, ...extra });
  };

  // Email body
  const email = extractFromEmailBody(emailBody);
  push('subject_property_address', email.subject_property_address, 'email_body');
  push('subject_property_postal_code', email.subject_property_postal_code, 'email_body');
  push('subject_property_market_value', email.subject_property_market_value, 'email_body');
  push('requested_loan_amount', email.requested_loan_amount, 'email_body');

  // Per-doc
  for (const doc of (savedDocs || [])) {
    const cls = doc.classification;
    if (cls === 'mortgage_statement') {
      const r = extractFromMortgageStatement(doc);
      push('subject_property_address', r.subject_property_address, doc.file_name);
      push('subject_property_postal_code', r.subject_property_postal_code, doc.file_name);
      push('existing_first_mortgage_lender', r.existing_first_mortgage_lender, doc.file_name);
      // Partition balance + payout by lender.
      if (r.existing_first_mortgage_balance != null) {
        map.existing_first_mortgage_balance.push({
          value: r.existing_first_mortgage_balance,
          source: doc.file_name,
          lender_canonical: r.existing_first_mortgage_lender,
        });
      }
      if (r.existing_first_mortgage_payout_total != null) {
        map.existing_first_mortgage_payout_total.push({
          value: r.existing_first_mortgage_payout_total,
          source: doc.file_name,
          lender_canonical: r.existing_first_mortgage_lender,
        });
      }
    } else if (cls === 'property_tax') {
      const r = extractFromPropertyTax(doc);
      push('subject_property_address', r.subject_property_address, doc.file_name);
      push('subject_property_postal_code', r.subject_property_postal_code, doc.file_name);
      push('subject_property_assessment_value', r.subject_property_assessment_value, doc.file_name);
      const name = extractBorrowerFromPropertyTax(doc);
      push('primary_borrower_full_name', name, doc.file_name);
    } else if (cls === 'appraisal') {
      const r = extractFromAppraisal(doc);
      push('subject_property_address', r.subject_property_address, doc.file_name);
      push('subject_property_postal_code', r.subject_property_postal_code, doc.file_name);
      push('subject_property_market_value', r.subject_property_market_value, doc.file_name);
    } else if (cls === 'credit_report') {
      const r = extractFromCreditBureau(doc);
      push('existing_first_mortgage_lender', r.existing_first_mortgage_lender, doc.file_name);
      if (r.existing_first_mortgage_balance != null) {
        map.existing_first_mortgage_balance.push({
          value: r.existing_first_mortgage_balance,
          source: doc.file_name,
          lender_canonical: r.existing_first_mortgage_lender,
        });
      }
      push('primary_borrower_full_name', r.primary_borrower_full_name, doc.file_name);
    } else if (cls === 'aml' || cls === 'pep') {
      const r = extractFromAmlPep(doc);
      push('primary_borrower_full_name', r.primary_borrower_full_name, doc.file_name);
    }
    // Other classifications (loan_application, pnw_statement, income_proof, T4, government_id,
    // noa, other) — NOT extracted for canonical fields in Commit 1 scope. Production defects
    // came from the 5 doc types above; adding more = additional FP surface without artifact
    // evidence of benefit.
  }

  return map;
};

// Convenience tokenizer used by discrepancy-engine for name comparison.
const tokenizeNameForCompare = (name) => (name || '').trim().split(/\s+/)
  .map(t => t.toLowerCase().replace(/[.,]/g, ''))
  .filter(t => t.length > 0);

module.exports = {
  LENDER_SYNONYMS,
  LENDER_REVERSE_MAP,
  normalizeLender,
  findLenderInWindow,
  normalizePostal,
  normalizeMoney,
  normalizeAddress,
  extractAddressLine,
  isCommercialSubmission,
  findAnchorBlock,
  findAllAnchorBlocks,
  extractFromEmailBody,
  extractFromMortgageStatement,
  extractFromPropertyTax,
  extractFromAppraisal,
  extractFromCreditBureau,
  extractFromAmlPep,
  extractBorrowerFromPropertyTax,
  extractCanonicalFields,
  tokenizeNameForCompare,
};
