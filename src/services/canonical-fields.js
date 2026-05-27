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
// Fields (11, all role-scoped):
//   Defect-surface fields (in discrepancy compute list):
//     subject_property_postal_code
//     subject_property_address
//     subject_property_market_value (appraisal-derived)
//     subject_property_assessment_value (property_tax-derived; DISTINCT field)
//     requested_loan_amount
//     existing_first_mortgage_lender
//     existing_first_mortgage_balance (BY-LENDER partition)
//     existing_first_mortgage_payout_total (BY-LENDER partition)
//     primary_borrower_full_name
//   Display-only fields (Commit-2 Snapshot completeness, NOT in discrepancy compute):
//     mortgage_position (1st / 2nd / 3rd)
//     requested_loan_term_months (numeric)

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

const extractFromEmailBody = (emailBody, emailSubject = '') => {
  const out = {
    subject_property_address: null,
    subject_property_postal_code: null,
    // R6-δ (2026-05-21): top-level city + province canonical fields (mirrors
    // subject_property_postal_code naming). Populated from broker body's
    // "X property at <street>" informal pattern (Patricia S5 + Kevin S6) or
    // inline "<street>, City, Prov, postal" formal pattern (Sandra S8).
    // Distinct semantic from address tuple — keeps cross-source discrepancy
    // detection on bare street unchanged; deriveCityProvince in
    // discrepancy-engine.js prefers these tuples when populated.
    subject_property_city: null,
    subject_property_province: null,
    requested_loan_amount: null,
    subject_property_market_value: null,
    mortgage_position: null,
    requested_loan_term_months: null,
  };
  if (!emailBody && !emailSubject) return out;
  // Mortgage position — anchored to email subject ("Second Mortgage —", "First Mortgage Inquiry —")
  // or email body ("*Mortgage Position:* 2nd"). Subject is the strongest signal (broker convention).
  const subjPosM = (emailSubject || '').match(/\b(First|Second|Third|1st|2nd|3rd)\s+Mortgage\b/i);
  if (subjPosM) {
    const v = subjPosM[1].toLowerCase();
    out.mortgage_position = (v === 'first' || v === '1st') ? '1st' : (v === 'second' || v === '2nd') ? '2nd' : '3rd';
  } else if (emailBody) {
    const bodyPosM = emailBody.match(/\*?\s*Mortgage\s+Position\s*:?\s*\*?\s*(1st|2nd|3rd|First|Second|Third)/i);
    if (bodyPosM) {
      const v = bodyPosM[1].toLowerCase();
      out.mortgage_position = (v === 'first' || v === '1st') ? '1st' : (v === 'second' || v === '2nd') ? '2nd' : '3rd';
    } else {
      // Fallback: "second mortgage on" / "first mortgage for" prose.
      const proseM = emailBody.match(/\b(first|second|third)\s+mortgage\b/i);
      if (proseM) {
        const v = proseM[1].toLowerCase();
        out.mortgage_position = (v === 'first') ? '1st' : (v === 'second') ? '2nd' : '3rd';
      }
    }
  }
  // Loan term — broker template "*Term:* 12 months" or prose mention.
  if (emailBody) {
    const termM = emailBody.match(/\*?\s*(?:Loan\s+)?Term(?:\s+Requested)?\s*:?\s*\*?\s*(\d+)\s*(?:[-\s]?month|mo\.?)/i);
    if (termM) {
      const n = parseInt(termM[1], 10);
      if (n >= 1 && n <= 60) out.requested_loan_term_months = n;
    }
  }
  if (!emailBody) return out;
  // Property block: between `*Property:*` and next `*`
  const propM = emailBody.match(/\*\s*Property\s*:\s*\*\s*([\s\S]+?)\*/i);
  if (propM) {
    const block = propM[1];
    const addr = extractAddressLine(block);
    if (addr) out.subject_property_address = normalizeAddress(addr);
    const postalM = block.match(POSTAL_RE_SINGLE);
    if (postalM) out.subject_property_postal_code = normalizePostal(postalM[1] + postalM[2]);
    // R6-δ inline-comma pattern: `<street>, <City>, <Prov>[, postal]` —
    // captures city + province when explicit (Sandra S8 deal 84feed85
    // "412 Windermere Close SW, Edmonton, AB T6W 0R1" shape).
    const inlineM = block.match(/(?:Boulevard|Drive|Street|Avenue|Road|Circle|Court|Lane|Place|Crescent|Way|Square|Terrace|Close|Highway|Parkway|Trail|Heights|Hill|Hills|Mews|Pointe|Promenade|Ridge|Run|Walk)(?:\s+(?:NW|NE|SW|SE|N|S|E|W))?,?\s*([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s*,\s*(AB|BC|SK|MB|ON|QC|NB|NS|PE|NL|NT|YT|NU)\b/);
    if (inlineM) {
      out.subject_property_city = inlineM[1].trim();
      out.subject_property_province = inlineM[2].toUpperCase();
    } else {
      // R9-C (2026-05-26): inline-comma-city-only — `<street-suffix>(<direction>)?, <City>`
      // with NO trailing province. Marcus retest 996a676c
      // "1142 Tory Road NW, Edmonton" + Derek retest df33cdbf
      // "5519 Henwood Road SW, Calgary" shapes. Comma REQUIRED (Q3-(a)
      // verdict — anchors where city starts; without comma "Road NW Edmonton"
      // can't reliably mark city boundary vs continuation of street name).
      // Strict-superset additive widening (Q2-(a) parallel pattern AFTER
      // with-province; only fires on no-match per inner `else` branch).
      // Same partial-closure semantic as R6-δ's "<City> property at" informal
      // pattern: city populated, province null (Q1-(a) narrow — no
      // city→province lookup; would over-fit beyond Alberta jurisdictions).
      // Downstream deriveCityProvince renders "Edmonton / TBD" partial-
      // closure shape per discrepancy-engine.js:235.
      const inlineCityOnlyM = block.match(/(?:Boulevard|Drive|Street|Avenue|Road|Circle|Court|Lane|Place|Crescent|Way|Square|Terrace|Close|Highway|Parkway|Trail|Heights|Hill|Hills|Mews|Pointe|Promenade|Ridge|Run|Walk)(?:[ \t]+(?:NW|NE|SW|SE|N|S|E|W))?,[ \t]+([A-Z][a-zA-Z]+(?:[ \t]+[A-Z][a-zA-Z]+)?)\b/);
      if (inlineCityOnlyM) {
        out.subject_property_city = inlineCityOnlyM[1].trim();
      }
    }
  } else {
    // Fallback for non-bold-template broker emails: line starting with "Property:"
    const lineM = emailBody.match(/Property\s*:\s*([\s\S]{0,200}?)(?:\n\n|\nLTV|\nAppraised|\nMortgage|$)/i);
    if (lineM) {
      const addr = extractAddressLine(lineM[1]);
      if (addr) out.subject_property_address = normalizeAddress(addr);
      const postalM = lineM[1].match(POSTAL_RE_SINGLE);
      if (postalM) out.subject_property_postal_code = normalizePostal(postalM[1] + postalM[2]);
      // R6-δ inline-comma pattern (same as bold-template branch).
      const inlineM = lineM[1].match(/(?:Boulevard|Drive|Street|Avenue|Road|Circle|Court|Lane|Place|Crescent|Way|Square|Terrace|Close|Highway|Parkway|Trail|Heights|Hill|Hills|Mews|Pointe|Promenade|Ridge|Run|Walk)(?:\s+(?:NW|NE|SW|SE|N|S|E|W))?,?\s*([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s*,\s*(AB|BC|SK|MB|ON|QC|NB|NS|PE|NL|NT|YT|NU)\b/);
      if (inlineM) {
        out.subject_property_city = inlineM[1].trim();
        out.subject_property_province = inlineM[2].toUpperCase();
      } else {
        // R9-C (2026-05-26): symmetric extension in non-bold-template fallback
        // branch. Same shape as bold-template branch above. Marcus + Derek
        // retest fixtures use "Property: <street>, <City>" (non-bold) — this
        // branch handles them. Bold-template variant
        // ("*Property:* <street>, <City>") routes through the upper branch.
        const inlineCityOnlyM = lineM[1].match(/(?:Boulevard|Drive|Street|Avenue|Road|Circle|Court|Lane|Place|Crescent|Way|Square|Terrace|Close|Highway|Parkway|Trail|Heights|Hill|Hills|Mews|Pointe|Promenade|Ridge|Run|Walk)(?:[ \t]+(?:NW|NE|SW|SE|N|S|E|W))?,[ \t]+([A-Z][a-zA-Z]+(?:[ \t]+[A-Z][a-zA-Z]+)?)\b/);
        if (inlineCityOnlyM) {
          out.subject_property_city = inlineCityOnlyM[1].trim();
        }
      }
    }
  }
  // R6-δ informal "<City> property at <street>" pattern — Patricia S5 +
  // Kevin S6 prose shape ("Calgary property at 412 Coach Side Crescent SW").
  // Only sets city + province when not already set by the inline-comma branch
  // above (which has explicit province). Province is left null in this branch
  // — Q3 verdict residual: no city→province lookup table (would over-fit if
  // Franco expands beyond Alberta). City alone is still useful for the
  // Snapshot row ("Calgary / TBD" → still better than "TBD / TBD").
  if (!out.subject_property_city) {
    const propAtM = emailBody.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+property\s+at\b/);
    if (propAtM) {
      const candidate = propAtM[1].trim();
      // Negative guard: street-suffix words ("Court", "Hill", etc.) are not
      // cities. Cross-check against the address normalization vocab.
      const suffixWords = new Set(['Boulevard','Drive','Street','Avenue','Road','Circle','Court','Lane','Place','Crescent','Way','Square','Terrace','Close','Highway','Parkway','Trail','Park','Heights','Hill','Hills','Mews','Pointe','Promenade','Ridge','Run','Walk']);
      if (!suffixWords.has(candidate.split(/\s+/)[0])) {
        out.subject_property_city = candidate;
        // province stays null per Q3 verdict (informal pattern has no
        // explicit province; defer to deriveCityProvince fallback if needed).
      }
    }
  }
  // Loan amount.
  //
  // R6-δ (2026-05-21): strict-superset widening. Existing 4 formal alternations
  // preserved unchanged (optional `$` preserved); 1 new formal alternation
  // (`Requested\s+Loan(?:\s+Amount)?` — Sandra S8 deal 84feed85 "Requested
  // Loan: $68,000" shape). One informal-prose alternation handled separately
  // with REQUIRED `$` anchor to avoid false matches on non-money contexts
  // ("requesting more information", "requesting a callback"):
  //   • "requesting $X" — Patricia S5 + Kevin S6 prose shapes.
  //
  // Same widening discipline as R6-β-A "Appraised at" addition + R6-η R5-C-a
  // widening. Q2 verdict: narrow corpus discipline — adjacent variants
  // ("Loan Requested", "Funding Request", "Funds Requested") deliberately
  // NOT added without corpus evidence.
  const loanFormalM = emailBody.match(/\*?\s*(?:Mortgage\s+Amount\s+Requested|Loan\s+Amount\s+Requested|Mortgage\s+Amount|Loan\s+Amount|Requested\s+Loan(?:\s+Amount)?)\s*:?\s*\*?\s*\$?\s*([\d,]+)/i);
  if (loanFormalM) {
    out.requested_loan_amount = normalizeMoney(loanFormalM[1]);
  } else {
    const loanInformalM = emailBody.match(/\brequesting\s+\$\s*([\d,]+)/i);
    if (loanInformalM) out.requested_loan_amount = normalizeMoney(loanInformalM[1]);
  }
  // Appraised value (broker-stated): `*Appraised Value:* $X` (formal-template
  // shape) OR `Appraised at $X` (informal prose, Marcus/Ryan c56c2a0f R6-β-A
  // empirical addition — "Appraised at $545,000" without the "Value:" label).
  // R6-β-A widening discipline: same shape as R5-C-a widening in R6-η and
  // DOCUMENTS_INCLUDED_BLOCK_PATTERN widening in R6-ε — strict superset of
  // the previous regex via alternation (formal "Value" branch unchanged;
  // new "at" branch catches informal phrasing). Cascade-closes R6-δ
  // property_value TBD on informal-phrasing fixtures + enables R6-β LTV
  // CASCADE end-to-end on Marcus/Ryan.
  const apprM = emailBody.match(/\*?\s*(?:Appraised\s+(?:Value|at)|Property\s+Value|Purchase\s+Price)\s*:?\s*\*?\s*\$?\s*([\d,]+)/i);
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

// ─── PNW statement — existing first-mortgage lender + balance (R4-RESIDUAL-2) ───
//
// Real-corpus anchored: pdf-lib form-field annotations in the Liabilities /
// Real Estate Owned section (Page 2 of the standard PNW form). Verified
// against two real corpus fixtures:
//   - Lena Park (1e9841a4): `[Page 2 annotation] Scotiabank — First Mortgage
//     (3704 Parkhill Street SW)` immediately followed by
//     `[Page 2 annotation] $336,000`
//   - Ryan Callahan (ff8c809e): `[Page 2 annotation] BMO — First Mortgage
//     (2847 Whitemud Dr NW)` immediately followed by
//     `[Page 2 annotation] $385,000`
//
// Anchor pattern: `[Page N annotation] <Lender> — First Mortgage` followed
// (next annotation, within ~150 chars) by `[Page N annotation] $<digits>`.
// Lender token must be in LENDER_SYNONYMS (canonicalized via the existing B map).
//
// Page-3 fallback DROPPED — Page-3 Real Estate Owned detail section can list
// multiple properties, and the role-scoping logic to identify subject-property
// FIRST mortgage from Page-3 alone is non-trivial (type-scoped-vs-role-scoped
// risk per B's 58/58 lesson). Page-2 anchor handles both validated fixtures;
// expand only if a corpus case surfaces requiring Page-3 grounding.
//
// Over-fire protection (preserves C.4 Linda over-fire negative): if no PNW
// annotation block OR no "<Lender> — First Mortgage" pattern in Page 2,
// returns null. Linda's PNW (no first-mortgage on subject property — she's a
// first-mortgage purchase) has no such annotation → null → C.4 inverse-bug
// protection intact.
const extractFromPnwStatement = (doc) => {
  const text = doc?.text || doc?.extracted_data?.text || '';
  const out = {
    existing_first_mortgage_lender: null,
    existing_first_mortgage_balance: null,
  };
  if (!text) return out;
  // Anchor: `[Page N annotation] <Lender> — First Mortgage`. The em-dash may
  // appear as — / – / -. Lender must be one of LENDER_SYNONYMS (case-
  // insensitive substring match) to qualify.
  for (const syn of LENDER_SYNONYMS_BY_LENGTH) {
    const escapedSyn = syn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\[Page\\s+\\d+\\s+annotation\\]\\s*${escapedSyn}\\s*[—–\\-]\\s*First\\s+Mortgage\\b`, 'i');
    const m = text.match(re);
    if (!m) continue;
    out.existing_first_mortgage_lender = LENDER_REVERSE_MAP[syn];
    // Find the IMMEDIATELY-FOLLOWING `[Page N annotation] $<digits>`
    // within 150 chars after the anchor (the corpus has it on the next
    // annotation line, ~50-80 chars away).
    const afterIdx = m.index + m[0].length;
    const followingWindow = text.slice(afterIdx, afterIdx + 200);
    const balM = followingWindow.match(/\[Page\s+\d+\s+annotation\]\s*\$([\d,]+(?:\.\d{2})?)/);
    if (balM) {
      const bal = normalizeMoney(balM[1]);
      if (bal != null) out.existing_first_mortgage_balance = bal;
    }
    break;
  }
  return out;
};

// ─── Loan application — requested_loan_amount from Page-1 form annotation (R6-β-A) ───
//
// Franco's R5 S4 Bug 1 (Marcus Fitzpatrick / Ryan Callahan c56c2a0f) — Vienna
// failed to escalate LTV>80% at initial submission because canonical_map
// didn't have requested_loan_amount. Email-body extraction (the only path
// pre-R6-β-A) returned empty because the broker's email body said only "a
// second mortgage application... Appraised at $545,000" — no loan figure.
// The loan application PDF page-1 annotation has "$68,000" but no per-doc
// extractor handled the loan_application classification. _r1InitialCombined
// Ltv returned null → escalation gate never fired → Vienna welcomed the
// broker conversationally + asked for missing docs (msg[1]) → Franco saw
// this as a "wrong workflow ordering" bug. Actual root: extraction gap.
//
// Real-corpus convention (7-fixture verification: Ryan/Sandra/Ethan/Kevin/
// Patricia/James/Derek): the FIRST `[Page 1 annotation]` in the PML loan
// application template is the requested loan amount. 6 of 7 fixtures have
// `$<amount>` with leading `$` (e.g. `$68,000`); 1 of 7 (Derek dce308c8)
// has bare `110,000` without `$`. The regex allows optional leading `$`.
//
// Sanity bound: $5,000-$2,000,000 per verdict. Conservative around the
// observed corpus range ($68k-$415k). Catches obvious wrong-field
// extractions (year "2026", percentage "10.99", etc.) without constraining
// legitimate Franco-business loan amounts. If a future deal legitimately
// hits outside this range, narrow at that fixture moment per standing
// playbook (don't anticipate edge cases).
//
// Cross-cluster cascade closure: this extractor populates canonical_map.
// requested_loan_amount from doc-side, which:
//   (1) Closes R6-β primary symptom (LTV ordering on Marcus/Ryan-shape
//       initial submissions — combined-LTV gate fires when all three
//       canonical fields populate from email + loan_app + PNW)
//   (2) Closes R6-δ partial scope (loan_amount TBD in Deal Snapshot per
//       S5/S6/S8 fixtures — Snapshot reads from canonical_map). R6-δ
//       residual scope unchanged: City/Province / Loan Term / LTV TBD
//       remain, separate cycle.
// R5-D composition: this extractor fires on the standard PML loan app
// template. If a broker submits their OWN form (not PML's template),
// extractor likely returns null → R5-D Surface B's post-clash routing
// through processInitialEmail handles the own-form acknowledgment +
// PNW template attachment. Two clusters compose cleanly; no interaction.
const extractFromLoanApplication = (doc) => {
  const text = doc?.text || doc?.extracted_data?.text || '';
  const out = { requested_loan_amount: null, requested_loan_term_months: null };
  if (!text) return out;
  // First Page-1 annotation matching money shape (optional `$`, digits with
  // commas, optional decimal). The `m` flag makes `$` match line-end so we
  // anchor on the FULL annotation line (no spurious text trailing). Anchor
  // on first match in the doc — Page-1 annotations come before Page-2+ in
  // PDF text-extraction order.
  const annM = text.match(/\[Page\s+1\s+annotation\]\s*\$?\s*([\d,]+(?:\.\d{2})?)\s*$/m);
  if (annM) {
    const amount = normalizeMoney(annM[1]);
    // Sanity bound per R6-β-A verdict: $5,000-$2,000,000. Catches obvious
    // wrong-field extractions (years, percentages, IDs); conservative
    // around observed corpus range ($68k-$415k).
    if (amount != null && amount >= 5000 && amount <= 2000000) {
      out.requested_loan_amount = amount;
    }
  }
  // R6-δ (2026-05-21): Loan Term extraction. Q3 verdict: shape-keyed (not
  // positional) — scan ALL Page-1 annotations; FIRST that matches
  // `^\d{1,2}\s+months?$` wins. Robust to PML template field reorderings.
  // Cross-corpus verified on 4/4 fixtures (Patricia/Kevin/Sandra/Ryan — all
  // produce 12 months as the 3rd Page-1 annotation in current template).
  // Sanity bound 1-60 months matches the email-body extractor's range.
  //
  // Distinguishes the broker-filled annotation from form-template boilerplate
  // ("Requested Term (eg. 6, 12 or 18 months):" appears in unwrapped text but
  // NOT inside `[Page 1 annotation]` markers).
  const annTermRe = /\[Page\s+1\s+annotation\]\s*(\d{1,2})\s+months?\s*$/gm;
  let termMatch;
  while ((termMatch = annTermRe.exec(text)) !== null) {
    const n = parseInt(termMatch[1], 10);
    if (n >= 1 && n <= 60) {
      out.requested_loan_term_months = n;
      break;
    }
  }
  return out;
};

// ─── AML / PEP forms — Full Legal Name only (borrower address out of scope) ───

const extractFromAmlPep = (doc) => {
  const text = doc?.text || doc?.extracted_data?.text || '';
  const out = { primary_borrower_full_name: null, purpose: null };
  if (!text) return out;
  const m = text.match(/Full\s+Legal\s+Name\s*\n\s*([A-Z][a-zA-Z'\-]+(?:[ \t]+[A-Z][a-zA-Z'\-]+){1,4})/);
  if (m) out.primary_borrower_full_name = m[1].trim();
  // R10-G (2026-05-27): purpose extraction from AML "Purpose of Mortgage" /
  // "Source of Funds" field. Empirically anchored against Ethan AML form
  // (Round-6 Scenario 7) where "Debt consolidation and emergency home
  // repairs" appears under the Purpose of Mortgage label.
  const purposeM = text.match(/(?:Purpose\s+of\s+Mortgage|Source\s+of\s+Funds)\s*\n+\s*([^.\n]{3,100})/i);
  if (purposeM && purposeM[1]) {
    const p = purposeM[1].trim().replace(/[,.]+$/, '');
    if (p.length >= 3 && p.length <= 100) out.purpose = p;
  }
  return out;
};

// R10-G (2026-05-27): purpose extraction from loan_application Page-1
// AcroForm annotations. Same extractor shape as R6-β-A
// extractFromLoanApplication for requested_loan_amount. Annotations after
// the amount/rate/term typically include "Use of funds" / purpose text.
// Empirically anchored against Ethan loan_application where Page-1
// annotation contained "Debt consolidation and emergency home repairs".
const extractPurposeFromLoanApplication = (doc) => {
  const text = doc?.text || doc?.extracted_data?.text || '';
  if (!text) return null;
  // Look for Page-1 annotations matching the purpose-shaped text
  // (multi-word, mid-length, not numeric/percent/duration).
  const annPattern = /\[Page\s*1\s*annotation\]\s+([^\n]{5,100})/gi;
  const annotations = [];
  let m;
  while ((m = annPattern.exec(text)) !== null) {
    const val = m[1].trim().replace(/[,.]+$/, '');
    // Filter: skip numeric/percent/duration shapes
    if (/^\$[\d,]+(\.\d+)?$/.test(val)) continue;        // amount
    if (/^\d+(\.\d+)?\s*%$/.test(val)) continue;          // rate
    if (/^\d+\s*months?$/i.test(val)) continue;           // duration
    if (/^(?:1st|2nd|3rd|First|Second|Third)\s+Mortgage$/i.test(val)) continue;  // position
    if (/^[A-Z][a-z]+$/.test(val)) continue;              // single name (borrower first name)
    if (val.length < 5) continue;                          // too short
    annotations.push(val);
  }
  // First multi-word annotation = purpose (loan_application annotation
  // order: amount, rate, term, purpose, position, name).
  for (const ann of annotations) {
    if (/\s/.test(ann)) return ann;  // contains whitespace → multi-word → purpose candidate
  }
  return null;
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

// ──────────────────────────────────────────────────────────────────────────
// R10-G (2026-05-27) — Broker-correction parser + intent-vs-objective source
// hierarchy. 5th cluster in 1st template family (canonical-map source-
// hierarchy enforcement; precedents: R6-γ + R6-α + R9-B + R9-D).
//
// Empirical headline: Franco Round-6 Scenario 7 (Ethan Broussard deal
// c95f3a20). The loan_application PDF has filled AcroForm annotations
// ($74,000 + "Debt consolidation and emergency home repairs"); broker email
// stated $73,880 + "home renovation"; broker explicitly corrected with
// "The correct loan amount is $73,880" in reply. Pre-R10-G: documents won
// over broker statements for intent fields; broker correction was IGNORED
// in canonical_map; prelim narrative said "broker confirmed the application
// amount" — the OPPOSITE of what broker said.
//
// Architectural innovation (Q2-sub-b verdict): source-classification
// distinction between INTENT fields (requested_loan_amount, purpose —
// broker INTENT for what's being requested) vs OBJECTIVE fields (property
// address, balances, lender, market value — facts about the world).
//   For intent fields:    broker_correction > broker_initial_intent > documents > generic email_body
//   For objective fields: documents > broker_correction > broker_initial_intent > generic email_body
//   broker_correction OVERRIDES even objective-field doc values (broker has
//     authority to correct documents when they're wrong).
//
// Two new source-classifications:
//   broker_correction       — explicit correction in subsequent inbound
//   broker_initial_intent   — initial broker statement of intent (from
//                              FIRST inbound's body for intent fields)
//
// parseBrokerCorrections: deterministic regex-based parser (Q1 verdict).
// Returns array of structured corrections; webhook calls on every broker
// inbound (Q5 verdict) after AI extraction, before prelim/draft prompt
// generation. Output threads to generateLeadSummary via
// canonicalCorrectionsOverride opt (Q4 verdict; R9-B/R9-D pattern).
//
// Carve-out discipline (Q-CARVE-OUT-RESPECT):
//   - Confirmations of Vienna's question ("Yes, $73,880 is correct") →
//     treat as broker_correction with that value
//   - Reconsideration agreements ("Looking at it again, $74,000 sounds
//     right") → treat as broker_correction (broker has selected)
//   - Hedging/approximation ("I think the amount might be around X") → NO
//     pattern match (defer to future broker_initial_intent_hedged classification)
//   - Question forms ("Is the amount $X?") → NO pattern match
const parseBrokerCorrections = (messageBody) => {
  if (!messageBody || typeof messageBody !== 'string') return [];
  const corrections = [];

  // Carve-out 1: skip hedging/approximation phrases. If the message contains
  // hedging language anywhere near a number, defer to non-correction default
  // hierarchy. Empirically: "I think the amount might be around $X" /
  // "approximately $X" / "roughly $X" / "maybe $X".
  const HEDGING_RE = /\b(?:I\s+think|might\s+be|maybe|approximately|roughly|around|about|sort\s+of|kind\s+of|could\s+be)\b/i;
  const isHedged = HEDGING_RE.test(messageBody);

  // Carve-out 2: skip question forms. Question marks AND leading
  // is/are/can/could/would/should before the number portion suggest a
  // question, not a statement.
  const QUESTION_RE = /\b(?:is|are|can|could|would|should)\b[^.\n]{0,100}\$?[\d,]+[^.\n]*\?/i;
  const isQuestion = QUESTION_RE.test(messageBody);

  if (isHedged || isQuestion) return [];

  // Loan amount correction patterns. Each captures the amount as group 1.
  const amountPatterns = [
    /\bthe\s+correct\s+(?:loan\s+)?amount\s+is\s*\$?\s*([\d,]+(?:\.\d+)?)/i,
    /\bcorrect\s+(?:loan\s+)?amount\s*:\s*\$?\s*([\d,]+(?:\.\d+)?)/i,
    /\bthe\s+(?:loan\s+)?amount\s+is\s+actually\s*\$?\s*([\d,]+(?:\.\d+)?)/i,
    /\bactually\s*\$?\s*([\d,]+(?:\.\d+)?)\s*\(\s*not\s*\$?[\d,]+(?:\.\d+)?\s*\)/i,
    /\bI\s+meant\s*\$?\s*([\d,]+(?:\.\d+)?)/i,
    /\b(?:loan\s+)?amount\s+should\s+be\s*\$?\s*([\d,]+(?:\.\d+)?)/i,
    // Confirmation patterns (broker affirming a specific value in reply)
    /\byes,?\s*\$?\s*([\d,]+(?:\.\d+)?)\s+is\s+correct/i,
    // Reconsideration patterns ("looking at it again, $X sounds right")
    /\b(?:looking\s+at\s+it\s+again|on\s+second\s+look|after\s+checking),?\s*\$?\s*([\d,]+(?:\.\d+)?)\s+(?:sounds\s+right|is\s+correct|works)/i,
  ];
  for (const re of amountPatterns) {
    const m = messageBody.match(re);
    if (m) {
      const value = normalizeMoney(m[1]);
      if (value != null && value > 0 && value < 100_000_000) {
        corrections.push({
          field: 'requested_loan_amount',
          value,
          source: 'broker_correction',
          rawPhrase: m[0],
        });
        break;
      }
    }
  }

  // Purpose correction patterns
  const purposePatterns = [
    /\bthe\s+(?:correct|actual)\s+purpose\s+is[:\s]+["']?([^."'\n]{3,80})/i,
    /\b(?:correct|actual)\s+(?:loan\s+)?purpose\s*:\s*["']?([^."'\n]{3,80})/i,
    /\bthe\s+purpose\s+is\s+actually\s+["']?([^."'\n]{3,80})/i,
    /\bthis\s+is\s+(?:for|a)\s+["']?([^."'\n]{3,80}?)["']?\s*\(\s*not\s/i,
  ];
  for (const re of purposePatterns) {
    const m = messageBody.match(re);
    if (m && m[1]) {
      const value = m[1].trim().replace(/[,.]+$/, '');
      if (value.length >= 3 && value.length <= 100) {
        corrections.push({
          field: 'purpose',
          value,
          source: 'broker_correction',
          rawPhrase: m[0],
        });
        break;
      }
    }
  }

  return corrections;
};

// Extract broker's initial intent statements from FIRST inbound's body.
// Different from parseBrokerCorrections: looks for the broker stating
// loan amount + purpose in their initial submission email (NOT correcting
// a prior Vienna statement). Examples from Round-6 fixtures:
//   "Loan Request: Second mortgage — $73,880 — home renovation" (Harpreet)
//   "Loan Request: $250,000 — debt consolidation" (synthetic)
// Returns same structure as parseBrokerCorrections but with source
// 'broker_initial_intent' (rank below broker_correction; above docs for
// intent fields; below docs for objective fields per Q2-sub-b verdict).
const parseBrokerInitialIntent = (messageBody) => {
  if (!messageBody || typeof messageBody !== 'string') return [];
  const intents = [];

  // Pattern: "Loan Request: [type] — $X — [purpose]" / variants
  // Captures both amount and purpose from the same line where possible.
  const loanRequestM = messageBody.match(/\bLoan\s+Request\s*:?\s*[^—\n]*?[—\-]\s*\$?\s*([\d,]+(?:\.\d+)?)\s*[—\-]\s*([^.\n]{3,80})/i);
  if (loanRequestM) {
    const amount = normalizeMoney(loanRequestM[1]);
    if (amount != null && amount > 0 && amount < 100_000_000) {
      intents.push({ field: 'requested_loan_amount', value: amount, source: 'broker_initial_intent', rawPhrase: loanRequestM[0] });
    }
    const purpose = loanRequestM[2].trim().replace(/[,.]+$/, '');
    if (purpose.length >= 3 && purpose.length <= 100) {
      intents.push({ field: 'purpose', value: purpose, source: 'broker_initial_intent', rawPhrase: loanRequestM[0] });
    }
  }

  // Fallback: "for $X" purpose-only or amount-only patterns
  if (!intents.find(i => i.field === 'purpose')) {
    // "for [purpose]" patterns common in broker initial statements
    const purposeM = messageBody.match(/\b(?:purpose|use\s+of\s+funds)\s*:?\s+([^.\n]{3,80})/i);
    if (purposeM) {
      const purpose = purposeM[1].trim().replace(/[,.]+$/, '');
      if (purpose.length >= 3 && purpose.length <= 100) {
        intents.push({ field: 'purpose', value: purpose, source: 'broker_initial_intent', rawPhrase: purposeM[0] });
      }
    }
  }

  return intents;
};

// ──────────────────────────────────────────────────────────────────────────
// R10-D (2026-05-27) — Province inference from postal_code + city signals.
// 6th cluster in 1st template family (canonical-map source-hierarchy
// enforcement; precedents R6-γ + R6-α + R9-B + R9-D + R10-G).
//
// Closes R6-δ docblock's explicit deferred residual at discrepancy-engine.js
// (pre-R10-D): "Province may be null on the informal-pattern path (Q3-verdict
// residual — no city→province lookup table)." Empirically across Round-6,
// 3 of 4 deals had postal_code populated + city populated + province tuple
// EMPTY → Snapshot rendered "City / Province: Calgary / TBD". R10-D fills
// the gap via deterministic postal-FSA + city-name lookup.
//
// Architectural source-hierarchy ordering for subject_property_province:
//   doc-source tuples (R6-δ inline extractor "Calgary, AB" pattern)
//   > province_inferred_from_postal (Canada Post FSA first-letter lookup)
//   > province_inferred_from_city (top-15 major-city lookup; defense-in-depth)
//
// Push logic in extractCanonicalFields uses empty-list guard: R10-D inferred
// tuples ONLY push when subject_property_province is empty post-doc-pushes.
// Doc-source-wins discipline preserved (Ethan regression-prevention).
//
// Carry-forward: code-docblock deferred-residual flagging discipline (R6-δ
// precedent that enabled this R10-D closure). When future cycles defer
// scope, document the deferred-residual IN CODE with explicit pointer to
// closure conditions. Commit-body-only deferrals require commit-history
// archaeology and tend to accumulate as PERSISTENT-from-earlier-rounds bugs.
//
// Defended residual (deferred per Q3-sub-(a) verdict, flagged here per the
// methodology learning above): X-prefix postal-code precision. X0A-X0G is
// Nunavut (NU); X1-X9 is Northwest Territories (NT). R10-D maps X→NT
// universally (over-coverage; harmless since NU broker submissions are
// empirically zero). Future-trigger closure condition: if a Nunavut deal
// surfaces with X0A-X0G postal and "TBD" province issue, extend X branch
// with X0[A-G]→NU specificity.

// Canada Post FSA first-letter → province standard (Q3-(a) FULL 18-entry).
// Static reference; Canada Post hasn't added new provinces in living memory.
// Unassigned letters (D, F, I, O, Q, U, W, Z) return null via missing-key
// lookup. Verified: Calgary (T1-T3), Edmonton (T5-T6), Toronto (M), Vancouver
// (V), Montreal (H), Ottawa (K), Winnipeg (R), Halifax (B), etc.
const FSA_LETTER_TO_PROVINCE = {
  A: 'NL', // Newfoundland & Labrador
  B: 'NS', // Nova Scotia
  C: 'PE', // Prince Edward Island
  E: 'NB', // New Brunswick
  G: 'QC', H: 'QC', J: 'QC',  // Quebec (eastern / Montreal / western)
  K: 'ON', L: 'ON', M: 'ON', N: 'ON', P: 'ON',  // Ontario (east / central / Toronto / SW / north)
  R: 'MB', // Manitoba
  S: 'SK', // Saskatchewan
  T: 'AB', // Alberta
  V: 'BC', // British Columbia
  X: 'NT', // NT default (X0A-X0G NU precision deferred per Q3-sub-a verdict)
  Y: 'YT', // Yukon
};

// Q4-(a) minimal top-15 Canadian-city lookup as defense-in-depth fallback
// when postal absent. Empirically every Round-6 deal has postal_code → city
// fallback rare-fires. Expand on Stage 2 evidence per R8-B empirical-
// evidence-required discipline. Case-insensitive matching; multi-word
// cities (Quebec City) supported via lowercase key.
const CITY_TO_PROVINCE = {
  'calgary': 'AB', 'edmonton': 'AB',
  'toronto': 'ON', 'ottawa': 'ON', 'hamilton': 'ON', 'mississauga': 'ON', 'london': 'ON',
  'vancouver': 'BC', 'victoria': 'BC',
  'montreal': 'QC', 'gatineau': 'QC', 'quebec city': 'QC',
  'winnipeg': 'MB',
  'halifax': 'NS',
  'saskatoon': 'SK', 'regina': 'SK',
};

// Pure helper: infer province from postal + city signals. Postal-FSA
// primary (deterministic 100% Round-6 coverage); city-name fallback
// (defense-in-depth). Returns null when neither signal yields a recognized
// mapping. Source field in return value documents which signal fired.
const inferProvinceFromAddressSignals = (city, postal) => {
  // Postal-FSA primary
  if (postal && typeof postal === 'string') {
    const firstLetter = postal.trim().toUpperCase()[0];
    if (firstLetter && FSA_LETTER_TO_PROVINCE[firstLetter]) {
      return {
        value: FSA_LETTER_TO_PROVINCE[firstLetter],
        source: 'province_inferred_from_postal',
      };
    }
  }
  // City-name fallback
  if (city && typeof city === 'string') {
    const key = city.trim().toLowerCase();
    if (CITY_TO_PROVINCE[key]) {
      return {
        value: CITY_TO_PROVINCE[key],
        source: 'province_inferred_from_city',
      };
    }
  }
  return null;
};

// ─── Top-level: extract everything per submission ───

// R5 Cluster B Sub-root 1 (2026-05-21): opts.preExtractedEmailFields
// supports the aggregating wrapper in discrepancy-engine.js — when provided
// (object with the email-body field shape), the internal extractFromEmailBody
// call is bypassed and these values feed the `email_body` tuples directly.
// The wrapper resolves multi-msg latest-non-empty-wins externally and passes
// the result here. emailBody can be '' when preExtractedEmailFields is used.
const extractCanonicalFields = (emailBody, savedDocs, opts = {}) => {
  const emailSubject = opts.emailSubject || '';
  const map = {
    subject_property_address: [],
    subject_property_postal_code: [],
    // R6-δ (2026-05-21): top-level city + province canonical fields.
    // Mirrors subject_property_postal_code; display-only (not in
    // discrepancy-compute list). Consumed by discrepancy-engine's
    // deriveCityProvince, which prefers these tuples when populated and
    // falls back to regex-parsing the address value.
    subject_property_city: [],
    subject_property_province: [],
    subject_property_market_value: [],
    subject_property_assessment_value: [],
    requested_loan_amount: [],
    existing_first_mortgage_lender: [],
    existing_first_mortgage_balance: [],
    existing_first_mortgage_payout_total: [],
    primary_borrower_full_name: [],
    // Display-only fields (Snapshot completeness — NOT in discrepancy compute list):
    mortgage_position: [],
    requested_loan_term_months: [],
    // R10-G (2026-05-27): purpose canonical field. Intent-type (broker's
    // stated reason for the loan); pushed from broker_initial_intent
    // (first inbound), broker_correction (subsequent explicit corrections),
    // loan_application (AcroForm annotation), aml form (Source of Funds /
    // Purpose of Mortgage field). Source-hierarchy resolution per Q2-sub-b:
    // broker_correction > broker_initial_intent > documents > generic email_body.
    purpose: [],
  };

  const push = (field, value, source, extra = {}) => {
    if (value == null) return;
    map[field].push({ value, source, ...extra });
  };

  // Email body + subject — bypass extraction when wrapper supplies pre-extracted fields.
  const email = opts.preExtractedEmailFields || extractFromEmailBody(emailBody, emailSubject);
  push('subject_property_address', email.subject_property_address, 'email_body');
  push('subject_property_postal_code', email.subject_property_postal_code, 'email_body');
  push('subject_property_city', email.subject_property_city, 'email_body');
  push('subject_property_province', email.subject_property_province, 'email_body');
  push('subject_property_market_value', email.subject_property_market_value, 'email_body');
  // R6-α (2026-05-21): thread classification:'email_body' onto requested_loan_amount
  // tuples so the consumer-side filter in discrepancy-engine.
  // filterCanonicalLoanAmountForDocAuthoritative can identify email-body-sourced
  // tuples and strip them from prompt context when a loan_application-sourced
  // tuple exists (Derek S3 dce308c8 source-mis-attribution-inversion fix).
  push('requested_loan_amount', email.requested_loan_amount, 'email_body', { classification: 'email_body' });
  push('mortgage_position', email.mortgage_position, 'email_subject_or_body');
  push('requested_loan_term_months', email.requested_loan_term_months, 'email_body');

  // Per-doc
  for (const doc of (savedDocs || [])) {
    const cls = doc.classification;
    if (cls === 'mortgage_statement') {
      const r = extractFromMortgageStatement(doc);
      push('subject_property_address', r.subject_property_address, doc.file_name);
      push('subject_property_postal_code', r.subject_property_postal_code, doc.file_name);
      push('existing_first_mortgage_lender', r.existing_first_mortgage_lender, doc.file_name, { classification: cls });
      // Partition balance + payout by lender. R6-γ (2026-05-21): thread
      // classification onto balance/payout tuples so the consumer-side filter
      // in discrepancy-engine.filterCanonicalLenderForPayoutOnly can identify
      // payout-statement-sourced tuples and preserve their lender_canonical
      // attribution; non-payout sources (credit_report, pnw_statement) keep
      // the balance value but have lender_canonical nulled at the consumer
      // boundary. See discrepancy-engine helper docblock for rationale.
      if (r.existing_first_mortgage_balance != null) {
        map.existing_first_mortgage_balance.push({
          value: r.existing_first_mortgage_balance,
          source: doc.file_name,
          lender_canonical: r.existing_first_mortgage_lender,
          classification: cls,
        });
      }
      if (r.existing_first_mortgage_payout_total != null) {
        map.existing_first_mortgage_payout_total.push({
          value: r.existing_first_mortgage_payout_total,
          source: doc.file_name,
          lender_canonical: r.existing_first_mortgage_lender,
          classification: cls,
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
      push('existing_first_mortgage_lender', r.existing_first_mortgage_lender, doc.file_name, { classification: cls });
      if (r.existing_first_mortgage_balance != null) {
        map.existing_first_mortgage_balance.push({
          value: r.existing_first_mortgage_balance,
          source: doc.file_name,
          lender_canonical: r.existing_first_mortgage_lender,
          classification: cls,
        });
      }
      push('primary_borrower_full_name', r.primary_borrower_full_name, doc.file_name);
    } else if (cls === 'aml' || cls === 'pep') {
      const r = extractFromAmlPep(doc);
      push('primary_borrower_full_name', r.primary_borrower_full_name, doc.file_name);
      // R10-G: purpose from AML form's Purpose-of-Mortgage field
      push('purpose', r.purpose, doc.file_name, { classification: cls });
    } else if (cls === 'loan_application') {
      // R6-β-A (2026-05-21): Page-1 annotation extraction of requested_loan_amount.
      // R6-δ (2026-05-21): same extractor extended for requested_loan_term_months
      // via shape-keyed Page-1 annotation matching `^\d{1,2}\s+months?$`. Both
      // values come from the PML loan_application template's Page-1 annotations.
      // Cross-corpus verified on 4/4 fixtures (Patricia/Kevin/Sandra/Ryan — all
      // 12-month terms). See extractFromLoanApplication header for full
      // diagnosis + corpus convention + cross-cluster cascade notes.
      // R6-α (2026-05-21): thread classification:'loan_application' onto the
      // requested_loan_amount push so the consumer-side filter can identify
      // doc-source-authoritative tuples and strip conflicting email_body
      // tuples from prompt context (Derek S3 dce308c8 fix).
      const r = extractFromLoanApplication(doc);
      push('requested_loan_amount', r.requested_loan_amount, doc.file_name, { classification: cls });
      push('requested_loan_term_months', r.requested_loan_term_months, doc.file_name);
      // R10-G (2026-05-27): purpose from loan_application Page-1 annotation
      const loanAppPurpose = extractPurposeFromLoanApplication(doc);
      push('purpose', loanAppPurpose, doc.file_name, { classification: cls });
    } else if (cls === 'pnw_statement') {
      // R4-RESIDUAL-2: PNW-only existing-first-mortgage fallback. Page-2
      // annotation anchor `<Lender> — First Mortgage` + immediately-following
      // `$<balance>`. Validated against Lena Park (1e9841a4) Scotiabank
      // $336,000 + Ryan Callahan (ff8c809e) BMO $385,000 — both REAL corpus
      // PNW annotation blocks. Returns null when no annotation block / no
      // first-mortgage anchor (Linda Okafor preservation — first-mortgage
      // purchase has no existing-mortgage annotation).
      const r = extractFromPnwStatement(doc);
      push('existing_first_mortgage_lender', r.existing_first_mortgage_lender, doc.file_name, { classification: cls });
      if (r.existing_first_mortgage_balance != null) {
        map.existing_first_mortgage_balance.push({
          value: r.existing_first_mortgage_balance,
          source: doc.file_name,
          lender_canonical: r.existing_first_mortgage_lender,
          classification: cls,
        });
      }
    }
    // Other classifications (loan_application, income_proof, T4, government_id,
    // noa, other) — NOT extracted for canonical fields. Production defects
    // came from the 6 doc types above; adding more = additional FP surface
    // without artifact evidence of benefit. PNW added in R4-RESIDUAL-2 with
    // bounded scope (Page-2 annotation anchor only).
  }

  // R10-D (2026-05-27): province inference from postal_code + city signals.
  // Empty-list guard preserves doc-source-wins discipline (R6-δ inline
  // extractor + future doc-source province tuples still authoritative).
  // Closes R6-δ docblock's explicit deferred residual (city→province lookup
  // table). 6th cluster in 1st template family. Pushed BEFORE R10-G broker
  // block so broker explicit correction would still override if needed
  // (broker_correction unshifts to [0]; inferred sits below in hierarchy).
  if (!map.subject_property_province || map.subject_property_province.length === 0) {
    const cityTuple = (map.subject_property_city || [])[0];
    const postalTuple = (map.subject_property_postal_code || [])[0];
    const inferred = inferProvinceFromAddressSignals(cityTuple?.value, postalTuple?.value);
    if (inferred) {
      map.subject_property_province.push({
        value: inferred.value,
        source: inferred.source,
        classification: inferred.source,
      });
    }
  }

  // R10-G (2026-05-27): Broker-source push (broker_correction +
  // broker_initial_intent). Per Q2-sub-b verdict, broker_correction has
  // highest priority universally; broker_initial_intent has higher priority
  // than documents for INTENT fields (requested_loan_amount, purpose) and
  // lower priority than documents for OBJECTIVE fields (others). Unshift to
  // index 0 puts the broker source at highest priority position; existing
  // [0]-indexed consumers (discrepancy-engine renderSnapshotRow's
  // formatValue + computeCombinedLtv) naturally see the broker value first.
  // resolveCanonicalForIntent (helper below) does explicit filter at
  // consumer-site boundary for Snapshot rendering + override block injection.
  const INTENT_FIELDS = new Set(['requested_loan_amount', 'purpose']);
  if (Array.isArray(opts.brokerCorrections)) {
    for (const c of opts.brokerCorrections) {
      if (!c || !c.field || !map[c.field]) continue;
      map[c.field].unshift({
        value: c.value,
        source: 'broker_correction',
        classification: 'broker_correction',
        rawPhrase: c.rawPhrase || '',
      });
    }
  }
  if (Array.isArray(opts.brokerInitialIntent)) {
    for (const i of opts.brokerInitialIntent) {
      if (!i || !i.field || !map[i.field]) continue;
      if (INTENT_FIELDS.has(i.field)) {
        // For intent fields: insert AFTER any broker_correction, BEFORE docs.
        const correctionIdx = map[i.field].findIndex(t => t.classification === 'broker_correction');
        const insertAt = correctionIdx === -1 ? 0 : correctionIdx + 1;
        map[i.field].splice(insertAt, 0, {
          value: i.value,
          source: 'broker_initial_intent',
          classification: 'broker_initial_intent',
          rawPhrase: i.rawPhrase || '',
        });
      } else {
        // For objective fields: append (docs already win).
        map[i.field].push({
          value: i.value,
          source: 'broker_initial_intent',
          classification: 'broker_initial_intent',
          rawPhrase: i.rawPhrase || '',
        });
      }
    }
  }

  return map;
};

// R10-G (2026-05-27): resolver helper. Returns the canonical chosen tuple
// for an INTENT field per Q2-sub-b source-hierarchy:
//   broker_correction > broker_initial_intent > docs > email_body > other
// Used by ai.js override-block builder + (optionally) by discrepancy-engine
// renderer to ensure broker-source authority on intent fields.
const INTENT_FIELDS_R10G = new Set(['requested_loan_amount', 'purpose']);
const resolveCanonicalIntentValue = (canonicalMap, field) => {
  if (!canonicalMap || !INTENT_FIELDS_R10G.has(field)) return null;
  const tuples = canonicalMap[field] || [];
  if (tuples.length === 0) return null;
  const PRIORITY = ['broker_correction', 'broker_initial_intent', 'loan_application', 'aml', 'pep', 'email_body'];
  for (const cls of PRIORITY) {
    const found = tuples.find(t => t?.classification === cls);
    if (found) return { value: found.value, source: cls, rawPhrase: found.rawPhrase || '' };
  }
  // Fallback: first tuple
  return { value: tuples[0].value, source: tuples[0].classification || tuples[0].source || 'unknown', rawPhrase: '' };
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
  extractFromPnwStatement,
  // R10-G (2026-05-27): broker-correction parser + initial-intent parser +
  // canonical intent-value resolver. 5th cluster in 1st template family
  // (canonical-map source-hierarchy enforcement; R6-γ/R6-α/R9-B/R9-D
  // precedents).
  parseBrokerCorrections,
  parseBrokerInitialIntent,
  resolveCanonicalIntentValue,
  extractPurposeFromLoanApplication,
  // R10-D (2026-05-27): province inference helpers + FSA/city lookup
  // tables. 6th cluster in 1st template family (canonical-map source-
  // hierarchy enforcement). Closes R6-δ deferred-residual.
  inferProvinceFromAddressSignals,
  FSA_LETTER_TO_PROVINCE,
  CITY_TO_PROVINCE,
  extractFromLoanApplication,
  extractBorrowerFromPropertyTax,
  extractCanonicalFields,
  tokenizeNameForCompare,
};
