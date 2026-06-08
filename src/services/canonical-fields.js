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
//   (requested_loan_term_months removed FRANCO Round-8 2026-06-06 — Loan Term is no longer
//    a structured field; lenders set the term post-approval.)

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

// Bug 2 (2026-05-28): magnitude-suffix family. Brokers write "$280k",
// "$1.2M"/"1.2MM", "$1.2 million", "$280 thousand" — the pre-fix money-capture
// regexes captured "([\\d,]+)" only, DROPPING the suffix → "$280k" extracted as
// $280 (factor-1000) and "$1.2 million" as $1 (factor-1,000,000). This poisoned
// every downstream computation (LTV, escalation, admin Snapshot). Centralized
// here: any captured token that includes a k/K, m/M/MM, "thousand", or "million"
// suffix is multiplied. The broker-written capture regexes are widened (with a
// letter-lookahead guard) to feed the suffix through; doc-extractor regexes are
// intentionally NOT widened (real production docs write full amounts) but this
// helper still multiplies a suffix if one ever reaches it.
const MONEY_MAGNITUDE_RE = /^[\s$]*([\d,]+(?:\.\d+)?)\s*(million|thousand|mm|m|k)\b/i;
const normalizeMoney = (val) => {
  if (val == null) return null;
  if (typeof val === 'number') return Math.round(val);
  const s = String(val).trim();
  const sm = MONEY_MAGNITUDE_RE.exec(s);
  if (sm) {
    const base = parseFloat(sm[1].replace(/,/g, ''));
    if (isFinite(base)) {
      const unit = sm[2].toLowerCase();
      const factor = (unit === 'k' || unit === 'thousand') ? 1000 : 1000000; // m / mm / million → 1e6
      const result = base * factor;
      // No-silent-guess sanity bound: an absurd multiplied result signals a
      // malformed double-unit ("$280,000k"). Do NOT silently emit the absurd
      // figure NOR a silent guess — log the inference + fall back to the base
      // (visible-as-inferred), so a malformed money input never drives the
      // LTV/escalation gates invisibly (same discipline as Bug 1).
      if (result > 100000000) {
        console.warn(`[normalizeMoney] magnitude suffix on already-large base '${val}' → ${result} exceeds sanity ceiling; INFERRING base ${Math.round(base)} (flagged-inferred, not a clean extraction)`);
        return Math.round(base);
      }
      return Math.round(result);
    }
  }
  const cleaned = s.replace(/[$,\s]/g, '');
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
// Strict: requires <digits>(1-5) <sep> <name (≤5 alpha words + optional one numeric
// pre-suffix token) <recognized suffix word> with optional trailing directional.
//
// FRANCO Scenario-2 Fix 2 (2026-06-02 / Bug 1(d) "116 street nw"): Alberta/Prairie grid
// addresses put a NUMERIC street name before the suffix ("4412 116 Street NW" = house
// 4412 on 116th Street). The old name token required [A-Za-z], so the regex skipped the
// real house number 4412 and captured 116 as the number → "116 Street NW" (house number
// dropped). Two changes: (1) the house/street separator accepts a hyphen ("4412-116
// Street"); (2) an OPTIONAL single numeric token is allowed in the immediately-pre-suffix
// slot — the numbered-street name. Bounding the numeric to that one slot (not a general
// name token) prevents a unit/range number from leaking into the captured house number
// (e.g. "Unit 5 1234 Jasper Avenue NW" still captures 1234, not 5).
const ADDR_LINE_RE = /\b(\d{1,5})[\s-]+((?:[A-Za-z][A-Za-z'\-]*\s+){0,5}?(?:\d{1,4}\s+)?(?:Boulevard|Drive|Street|Avenue|Road|Circle|Court|Lane|Place|Crescent|Way|Square|Terrace|Close|Highway|Parkway|Trail|Park|Heights|Hill|Hills|Mews|Park|Pointe|Promenade|Ridge|Run|Walk)(?:\s+(?:NW|NE|SW|SE|N|S|E|W))?)\b/i;

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

// FRANCO-Q7 (2026-05-28): non-Canadian SUBJECT-PROPERTY detection for auto-decline.
// Franco's rule is PROPERTY-based — a non-Canadian borrower on a Canadian property
// is processed normally; only a non-Canadian PROPERTY is declined. So detection is
// scoped to the property-address REGION (same anchors as extractFromEmailBody's
// property block), NOT the whole email — a US-resident borrower's mailing address
// elsewhere in the body must NOT trigger a decline.
//
// CONSERVATIVE BY DESIGN: declines ONLY on strong structural US/international
// signals in the property region (US ZIP+4, US-state+5-digit-ZIP adjacency, or an
// address-positioned country marker). It does NOT decline on mere absence of a
// Canadian postal — false-positive (declining a Canadian deal) is the costly error;
// false-negative (a US property without these markers slips to normal processing)
// is recoverable downstream. US state codes listed below exclude all Canadian
// province codes (AB/BC/MB/NB/NL/NS/NT/NU/ON/PE/QC/SK/YT) so there is no collision.
const US_STATE_CODES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','MA','MD','ME','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VA','VT','WA','WI','WV','WY'];
const US_STATE_ZIP_RE = new RegExp('\\b(' + US_STATE_CODES.join('|') + ')\\s+\\d{5}\\b'); // uppercase-only — low false-positive
const US_ZIP4_RE = /\b\d{5}-\d{4}\b/;
const US_COUNTRY_LINE_RE = /,\s*(USA|U\.S\.A\.?|United States)\b/i;

// Returns the raw property-address region text from a broker email (bold
// `*Property:* …*` block, else `Property:` fallback line), or '' if none found.
const extractPropertyRegion = (emailBody) => {
  if (!emailBody) return '';
  const boldM = emailBody.match(/\*\s*Property\s*:\s*\*\s*([\s\S]+?)\*/i);
  if (boldM) return boldM[1];
  const lineM = emailBody.match(/Property\s*:\s*([\s\S]{0,200}?)(?:\n\n|\nLTV|\nAppraised|\nMortgage|$)/i);
  if (lineM) return lineM[1];
  return '';
};

const detectNonCanadianProperty = (emailBody) => {
  const region = extractPropertyRegion(emailBody);
  if (!region) return { outOfScope: false, signal: null }; // no property region → can't tell → fail-open (process)
  let m;
  if ((m = region.match(US_ZIP4_RE))) return { outOfScope: true, signal: `US ZIP+4 in property region: "${m[0]}"` };
  if ((m = region.match(US_STATE_ZIP_RE))) return { outOfScope: true, signal: `US state+ZIP in property region: "${m[0]}"` };
  if ((m = region.match(US_COUNTRY_LINE_RE))) return { outOfScope: true, signal: `non-Canadian country marker in property region: "${m[0].trim()}"` };
  return { outOfScope: false, signal: null };
};

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
      // Fallback: "second mortgage on" / "first mortgage for" prose (spelled-out;
      // pre-Bug-3-EXT-2 — unchanged).
      const proseM = emailBody.match(/\b(first|second|third)\s+mortgage\b/i);
      if (proseM) {
        const v = proseM[1].toLowerCase();
        out.mortgage_position = (v === 'first') ? '1st' : (v === 'second') ? '2nd' : '3rd';
      } else {
        // Bug-3-EXTENSION-2 (BATCH 15): numeric-ordinal prose "2nd mortgage"
        // (E09 "Private 2nd mortgage submission"). STRICT SUPERSET — fires only
        // when the spelled-out form above did NOT match. FP guard: skip occurrences
        // that REFERENCE an existing mortgage ("behind [the] existing 1st mortgage",
        // "existing 2nd mortgage") rather than the deal's own position; take the
        // first non-reference ordinal-mortgage occurrence.
        const numM = [...emailBody.matchAll(/\b(behind\s+(?:the\s+)?(?:existing\s+)?|(?:the\s+)?existing\s+)?(1st|2nd|3rd)\s+mortgage\b/gi)].find(m => !m[1]);
        if (numM) {
          const v = numM[2].toLowerCase();
          out.mortgage_position = (v === '1st') ? '1st' : (v === '2nd') ? '2nd' : '3rd';
        }
      }
    }
  }
  // FRANCO Round-8 (2026-06-06): Loan Term removed as a structured field. Lenders set the
  // term post-approval, so the broker-stated term drives no underwriting decision. The
  // email-body and loan-application term extractors + the Snapshot row are all removed.
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
  // Bug 2: capture trailing magnitude suffix (k/K, m/M/MM, "thousand", "million")
  // so normalizeMoney multiplies; (?![A-Za-z]) guard avoids swallowing a
  // following word's initial ("$650,000 Market" → not "650,000 M").
  //
  // Bug 3 (BATCH 12, 2026-05-29): broker-shorthand widening — surfaced by the
  // Discipline-2 BATCH-12 probe (E07 "New 2nd mortgage request: $120,000" → null →
  // Combined-LTV row absent). Four ratified patterns ADDED beyond the formal labels,
  // tried in order after formal/informal. NARROW-CORPUS DISCIPLINE (per the note
  // above): every Bug-3 pattern REQUIRES a "$" anchor adjacent to its cue, so prose
  // like "loan application", "first mortgage: Scotiabank", "the loan officer", or a
  // hypothetical "$X they paid last year" cannot false-match. Magnitude suffix is
  // handled centrally by normalizeMoney (+ its no-silent-guess sanity bound).
  // The "$X for [purpose]" sub-pattern is scoped to FINANCING purposes only
  // (refinance/purchase/renovation/…) — a bare "for" is FP-prone (down payment
  // "$X for the deposit", "$X for closing") and is deliberately NOT matched.
  const MONEY = '([\\d,]+(?:\\.\\d+)?(?:\\s*(?:million|thousand|MM|[kKmM])(?![A-Za-z]))?)';
  const loanPatterns = [
    // formal labels (pre-Bug-3, unchanged — optional $)
    '\\*?\\s*(?:Mortgage\\s+Amount\\s+Requested|Loan\\s+Amount\\s+Requested|Mortgage\\s+Amount|Loan\\s+Amount|Requested\\s+Loan(?:\\s+Amount)?)\\s*:?\\s*\\*?\\s*\\$?\\s*' + MONEY,
    // informal "requesting $X" (pre-Bug-3, unchanged — $ required)
    '\\brequesting\\s+\\$\\s*' + MONEY,
    // Bug-3 A: "New Nth mortgage [request]: $X" OR "Nth mortgage request[ed]: $X"
    // ($ required, adjacent). REQUIRES the new-loan signal ("new" or "request") —
    // BATCH-14 FP fix: bare "first mortgage $X" is ambiguous (often the EXISTING
    // balance, e.g. "existing first mortgage $380k") and must NOT be captured as
    // the new loan. Legit cases (E07/E08) all carry "new" or "request".
    '\\b(?:new\\s+(?:first|second|third|fourth|1st|2nd|3rd|4th)\\s+mortgage(?:\\s+request(?:ed)?)?|(?:first|second|third|fourth|1st|2nd|3rd|4th)\\s+mortgage\\s+request(?:ed)?)\\s*:?\\s*\\$\\s*' + MONEY,
    // Bug-3 B: bare "Loan $X" / "Loan: $X" ($ required — excludes "Loan application")
    '\\bLoan\\s*:?\\s*\\$\\s*' + MONEY,
    // Bug-3 C: word-order "$X loan" / "$X requested" / "$X for <financing-purpose>"
    '\\$\\s*' + MONEY + '\\s+(?:loan\\b|requested\\b|for\\s+(?:a\\s+|the\\s+)?(?:refinanc|refi\\b|purchase|renovat|construction|payout|consolidat|debt))',
    // Bug-3 E (loan side): "$X against $Y" — loan is the FIRST amount ($ leads)
    '\\$\\s*' + MONEY + '\\s+against\\s+\\$\\s*[\\d,]+',
    // Bug-3-EXTENSION F (BATCH 14): 2nd-mortgage "$X behind [the] existing/first/1st"
    // (F04 "$185k behind existing RBC 1st", F13 "($145k) behind existing 1st"). The
    // optional ")" tolerates the parenthetical form. "behind <existing|first|1st>"
    // guard excludes "$X behind on payments". Captures the NEW 2nd amount, not the
    // existing balance (which is "$X balance", no "behind" adjacency).
    '\\$\\s*' + MONEY + '\\s*\\)?\\s+behind\\s+(?:the\\s+)?(?:existing|first|1st)\\b',
    // Bug-3-EXTENSION-2 G (BATCH 15): private-lender Nth-mortgage formal-label
    // phrasing "Private Nth [mortgage] [request]: $X" (E09 "Private 2nd request:
    // $425,000"). Differs from Bug-3 A (which REQUIRES the word "mortgage" between
    // ordinal and request) — private-lender shorthand often drops "mortgage"
    // ("Private 2nd request:", "Private 2nd:"). FP-guarded: REQUIRES the "private"
    // qualifier + an ordinal + a "$" anchor, so generic "private ... request: $X"
    // (no ordinal) cannot match. Captures the NEW private 2nd amount.
    '\\bprivate\\s+(?:first|second|third|fourth|1st|2nd|3rd|4th)(?:\\s+mortgage)?(?:\\s+request(?:ed)?)?\\s*:?\\s*\\$\\s*' + MONEY,
  ];
  for (const p of loanPatterns) {
    const m = emailBody.match(new RegExp(p, 'i'));
    if (m) { out.requested_loan_amount = normalizeMoney(m[1]); break; }
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
  //
  // Bug-3 D (BATCH 12): bare "appraised $X" lowercase prose (no "at"/"Value") —
  // E07 "appraised $720,000" was missed and only rendered because the appraisal
  // DOC backfilled it. $ required (a bare "appraised" with no $ is not a figure).
  const apprM = emailBody.match(/\*?\s*(?:Appraised\s+(?:Value|at)|Property\s+Value|Purchase\s+Price)\s*:?\s*\*?\s*\$?\s*([\d,]+(?:\.\d+)?(?:\s*(?:million|thousand|MM|[kKmM])(?![A-Za-z]))?)/i)
    || emailBody.match(/\bappraised\s+\$\s*([\d,]+(?:\.\d+)?(?:\s*(?:million|thousand|MM|[kKmM])(?![A-Za-z]))?)/i);
  if (apprM) out.subject_property_market_value = normalizeMoney(apprM[1]);
  // Bug-3 E (value side): "$X against $Y [property]" — the SECOND amount is the
  // property value (only when PV not already extracted by the labelled patterns).
  if (out.subject_property_market_value == null) {
    const againstM = emailBody.match(/\$\s*[\d,]+(?:\.\d+)?(?:\s*(?:million|thousand|MM|[kKmM])(?![A-Za-z]))?\s+against\s+\$\s*([\d,]+(?:\.\d+)?(?:\s*(?:million|thousand|MM|[kKmM])(?![A-Za-z]))?)/i);
    if (againstM) out.subject_property_market_value = normalizeMoney(againstM[1]);
  }
  // Bug-3-EXTENSION (BATCH 14): "[on] $X property" — 2nd-mortgage value phrasing
  // (F04/F13 "Combined LTV 78% on $720k property"). Negative lookahead excludes
  // "property tax". Only when PV not already extracted.
  if (out.subject_property_market_value == null) {
    const propM = emailBody.match(/(?:on\s+)?\$\s*([\d,]+(?:\.\d+)?(?:\s*(?:million|thousand|MM|[kKmM])(?![A-Za-z]))?)\s+property\b(?!\s+tax)/i);
    if (propM) out.subject_property_market_value = normalizeMoney(propM[1]);
  }
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
  // R11-B (Thornton 8c024006, 2026-06-08): `:?` added so a label-colon-value form
  // ("Outstanding Principal Balance:$147,000.00", no whitespace after the colon) matches.
  // Pre-fix the colon sat between "Balance" and "$" and broke the `\$?\s*` adjacency.
  const balM = text.match(/Outstanding\s+Principal\s+Balance\s*:?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i);
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
    // R11-B (Thornton 8c024006, 2026-06-08): accept an ISO date (2017-11) between
    // "Mortgage" and the figures, in addition to the original "Mon YYYY" form — some
    // bureaus render opened-date as ISO, which broke the "<date>\s*\$" adjacency.
    const reA = new RegExp(`\\b${escaped}\\s*Mortgage\\s*(?:[A-Z][a-z]+\\s+\\d{4}|\\d{4}-\\d{2})?\\s*\\$([\\d,]+)\\s*\\$([\\d,]+)`, 'i');
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
    const balM = followingWindow.match(/\[Page\s+\d+\s+annotation\]\s*\$([\d,]+(?:\.\d{2})?(?:\s*(?:million|thousand|MM|[kKmM])(?![A-Za-z]))?)/); // Bug 2: suffix-aware (broker-filled annotation)
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
  const out = { requested_loan_amount: null };
  if (!text) return out;
  // First Page-1 annotation matching money shape (optional `$`, digits with
  // commas, optional decimal). The `m` flag makes `$` match line-end so we
  // anchor on the FULL annotation line (no spurious text trailing). Anchor
  // on first match in the doc — Page-1 annotations come before Page-2+ in
  // PDF text-extraction order.
  const annM = text.match(/\[Page\s+1\s+annotation\]\s*\$?\s*([\d,]+(?:\.\d{2})?(?:\s*(?:million|thousand|MM|[kKmM])(?![A-Za-z]))?)\s*$/m); // Bug 2: suffix-aware (broker-filled annotation)
  let rawAmount = annM ? annM[1] : null;
  // R11-B (Thornton 8c024006, 2026-06-08): plain-text fallback for the DIGITAL PML loan-app
  // template, which has NO "[Page N annotation]" markers (those appear only on scanned/
  // broker-filled forms). Matches a labeled "Loan Amount Requested:$88,600" field; REQUIRES
  // the label + a $-amount so it stays conservative (won't fire on narrative prose like
  // "...the loan amount of $X"). Third instance of the annotation-gating gap (Thomas/Jennifer
  // loan_term, now Thornton loan_amount) — new extractors should support both formats up front.
  if (rawAmount == null) {
    const plainM = text.match(/\b(?:Loan\s+Amount\s+Requested|Requested\s+Loan\s+Amount|Loan\s+Amount|Amount\s+Requested)\s*:?\s*\$\s*([\d,]+(?:\.\d{2})?)/i);
    if (plainM) rawAmount = plainM[1];
  }
  if (rawAmount != null) {
    const amount = normalizeMoney(rawAmount);
    // Sanity bound per R6-β-A verdict: $5,000-$2,000,000. Catches obvious
    // wrong-field extractions (years, percentages, IDs); conservative
    // around observed corpus range ($68k-$415k).
    if (amount != null && amount >= 5000 && amount <= 2000000) {
      out.requested_loan_amount = amount;
    }
  }
  // FRANCO Round-8 (2026-06-06): Loan Term extraction removed (see header note) — lenders
  // set the term post-approval, so it drives no underwriting decision.
  return out;
};

// R11-B (Thornton 8c024006, 2026-06-08): deterministic OCCUPANCY extractor (Owner Occupied /
// Rental / Second Home) for the Snapshot "Ownership Type" row. DISTINCT from the LLM
// analysis.ownership_type (personal|corporate ENTITY type, load-bearing for corporate-checklist
// gating at ai.js:3133 — left untouched). Deterministic-over-LLM per innovation IV(a) / OBS-N+2
// (don't let an LLM field silently mask a canonical miss). Tiered + conservative: explicit
// label/phrase first; rental/investment/second-home BEFORE the owner-occupied derivation so a
// rental subject (whose borrower also lists a principal-residence asset) isn't mislabeled.
// Returns null when no confident signal (visible TBD > wrong value).
const _normalizeOccupancy = (raw) => {
  const v = String(raw || '').toLowerCase();
  if (/owner|principal|primary/.test(v)) return 'Owner Occupied';
  if (/rental|investment|tenant|non[\s-]?owner/.test(v)) return 'Rental';
  if (/second|vacation/.test(v)) return 'Second Home';
  return null;
};
const extractOccupancyFromLoanApplication = (doc) => {
  const text = doc?.text || doc?.extracted_data?.text || '';
  if (!text) return null;
  // 1. Explicit occupancy / property-use LABEL with a value.
  const labelM = text.match(/\b(?:Occupancy(?:\s+Type)?|Property\s+Use|Intended\s+Use|Owner\s+Occupancy)\s*:?\s*(Owner[\s-]?Occupied|Rental(?:\s+Property)?|Investment(?:\s+Property)?|Second\s+Home|Vacation(?:\s+Home)?|Principal\s+Residence|Primary\s+Residence)\b/i);
  if (labelM) return _normalizeOccupancy(labelM[1]);
  // 2. Standalone explicit phrases — rental/investment/second-home FIRST (a subject-use signal
  //    outranks the owner-occupied derivation in tier 3).
  if (/\b(?:Rental\s+Property|Investment\s+Property|tenant[\s-]?occupied|non[\s-]?owner[\s-]?occupied)\b/i.test(text)) return 'Rental';
  if (/\b(?:Second\s+Home|Vacation\s+(?:Home|Property))\b/i.test(text)) return 'Second Home';
  if (/\bOwner[\s-]?Occupied\b/i.test(text)) return 'Owner Occupied';
  // 3. Derivation (Owner Occupied only): the subject property is listed as the borrower's
  //    principal/primary residence (e.g. the ASSETS row "Principal Residence — <subject addr>").
  //    Gated behind the absence of rental/investment/second-home signals above.
  if (/\b(?:Principal|Primary)\s+Residence\b/i.test(text)) return 'Owner Occupied';
  return null;
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
  // Bug 2: group 1 widened to include the magnitude suffix (k/K, m/M/MM,
  // "thousand", "million") so a corrected "$1.2 million" isn't read as $1.2.
  // The "not $X" tail in the `actually` pattern is intentionally NOT widened.
  const amountPatterns = [
    /\bthe\s+correct\s+(?:loan\s+)?amount\s+is\s*\$?\s*([\d,]+(?:\.\d+)?(?:\s*(?:million|thousand|MM|[kKmM])(?![A-Za-z]))?)/i,
    /\bcorrect\s+(?:loan\s+)?amount\s*:\s*\$?\s*([\d,]+(?:\.\d+)?(?:\s*(?:million|thousand|MM|[kKmM])(?![A-Za-z]))?)/i,
    /\bthe\s+(?:loan\s+)?amount\s+is\s+actually\s*\$?\s*([\d,]+(?:\.\d+)?(?:\s*(?:million|thousand|MM|[kKmM])(?![A-Za-z]))?)/i,
    /\bactually\s*\$?\s*([\d,]+(?:\.\d+)?(?:\s*(?:million|thousand|MM|[kKmM])(?![A-Za-z]))?)\s*\(\s*not\s*\$?[\d,]+(?:\.\d+)?\s*\)/i,
    /\bI\s+meant\s*\$?\s*([\d,]+(?:\.\d+)?(?:\s*(?:million|thousand|MM|[kKmM])(?![A-Za-z]))?)/i,
    /\b(?:loan\s+)?amount\s+should\s+be\s*\$?\s*([\d,]+(?:\.\d+)?(?:\s*(?:million|thousand|MM|[kKmM])(?![A-Za-z]))?)/i,
    // Confirmation patterns (broker affirming a specific value in reply)
    /\byes,?\s*\$?\s*([\d,]+(?:\.\d+)?(?:\s*(?:million|thousand|MM|[kKmM])(?![A-Za-z]))?)\s+is\s+correct/i,
    // Reconsideration patterns ("looking at it again, $X sounds right")
    /\b(?:looking\s+at\s+it\s+again|on\s+second\s+look|after\s+checking),?\s*\$?\s*([\d,]+(?:\.\d+)?(?:\s*(?:million|thousand|MM|[kKmM])(?![A-Za-z]))?)\s+(?:sounds\s+right|is\s+correct|works)/i,
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

  // R11-A (2026-05-27): mortgage_position correction patterns.
  // Empirical anchor: Marcus Webb 8c404ae0 broker confirmation
  // "this is a first mortgage (1st position). Marcus is refinancing his
  // existing RBC first mortgage — the RBC will be paid out at closing."
  // Strip asterisks first (Marcus's broker used *1st* emphasis variant
  // in re-confirmation inbound).
  const asteriskStripped = messageBody.replace(/\*/g, '');
  const positionPatterns = [
    // "this is a first/second/third mortgage" / "this is a 1st mortgage"
    /\bthis\s+is\s+(?:a |the )?(first|second|third|1st|2nd|3rd)\s+mortgage\b/i,
    // "first/second/third position" / "1st position"
    /\b(?:in\s+(?:the\s+)?)?(first|second|third|1st|2nd|3rd)\s+position\b/i,
    // "mortgage position is a/the first/1st"
    /\b(?:mortgage\s+)?position\s+is\s+(?:a |the )?(first|second|third|1st|2nd|3rd)\b/i,
    // "the mortgage position is *1st*" (asterisk stripped above already)
    // "*1st*" emphasis (post-asterisk-strip becomes "1st" — caught above
    // by other patterns when in context)
  ];
  for (const re of positionPatterns) {
    const m = asteriskStripped.match(re);
    if (m) {
      const raw = m[1].toLowerCase();
      let value = null;
      if (/^(first|1st)$/.test(raw)) value = '1st';
      else if (/^(second|2nd)$/.test(raw)) value = '2nd';
      else if (/^(third|3rd)$/.test(raw)) value = '3rd';
      if (value) {
        corrections.push({
          field: 'mortgage_position',
          value,
          source: 'broker_correction',
          rawPhrase: m[0],
        });
        break;
      }
    }
  }

  // R11-A (2026-05-27): transaction_type correction patterns.
  // Detects broker's assertion of transaction structure (refinance / purchase /
  // 2nd_mortgage). Independent of mortgage_position — broker can assert
  // transaction_type without explicitly stating position (and vice versa).
  // Patterns cover Marcus's "refinancing his existing RBC first mortgage" +
  // "this is a refinance" + similar variants.
  const transactionTypePatterns = [
    // "refinancing his/her/their/the/an existing X mortgage"
    { re: /\brefinanc(?:e|ing)\s+(?:his|her|their|the|this|an?|my|our)?\s*(?:existing\s+)?(?:[A-Z][A-Za-z]*\s+)?(?:first |1st )?mortgage\b/i, value: 'refinance' },
    // "this is a refinance" / "this is actually a refinance" (BUG-7 BATCH 15:
    // optional "actually" — F14 "this is actually a refinance, not a purchase".
    // Strict superset; hedging/question guards above still suppress non-assertions.)
    { re: /\bthis\s+is\s+(?:actually\s+)?(?:a |the )?refinance\b/i, value: 'refinance' },
    // "first mortgage refinance" / "refinance to pay out existing X"
    { re: /\b(?:first\s+|1st\s+)?mortgage\s+refinance\b/i, value: 'refinance' },
    /* purchase patterns */
    { re: /\bpurchas(?:e|ing)\s+(?:this\s+|the\s+|a\s+|an\s+|new\s+|the\s+new\s+)?(?:home|property|house|condo)\b/i, value: 'purchase' },
    { re: /\bthis\s+is\s+(?:actually\s+)?(?:a |the )?purchase\b/i, value: 'purchase' },
    /* second-mortgage patterns */
    { re: /\bsecond\s+mortgage\s+application\b/i, value: '2nd_mortgage' },
    { re: /\bthis\s+is\s+(?:actually\s+)?(?:a |the )?(?:second|2nd)\s+mortgage\b/i, value: '2nd_mortgage' },
  ];
  for (const { re, value } of transactionTypePatterns) {
    const m = asteriskStripped.match(re);
    if (m) {
      corrections.push({
        field: 'transaction_type',
        value,
        source: 'broker_correction',
        rawPhrase: m[0],
      });
      break;
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
    // THOMAS-BERGQVIST Bug 2 (2026-06-05): the broker frequently runs a SEPARATE field onto the
    // same line after the purpose with no delimiter — e.g. "... refinancing existing TD Bank
    // mortgage Existing mortgage: TD Bank (matures March 2028)". The greedy capture above swallows
    // that trailing clause, so the canonical purpose became a truncated run-on that the R10-G
    // override then pinned into the prelim Loan Purpose verbatim. Cut the captured value at a
    // trailing capitalized "Label:" field or a parenthetical maturity clause so only the purpose
    // itself is canonical. Conservative — only trims when a new run-on field marker appears.
    const purpose = loanRequestM[2]
      .replace(/\s+(?:Existing|Current)\s+(?:mortgage|lender|loan)\b.*$/i, '') // trailing "Existing mortgage: TD Bank ..." run-on field
      .replace(/\s*\(?\bmatur(?:es|ing|ity)\b.*$/i, '')                         // trailing "(matures ...)" / "maturity ..." clause
      .trim()
      .replace(/[,.:;]+$/, '');
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

  // R11-A (2026-05-27): mortgage_position initial-intent patterns.
  // Symmetric coverage of parseBrokerCorrections position patterns for the
  // first-inbound case (broker states position in initial submission email).
  // Empirical anchor: Marcus Webb msg[0] "Loan Request: First mortgage
  // refinance — $408,000 — refinancing" — implicit "first mortgage" position
  // assertion in the loan-request line.
  const asteriskStripped = messageBody.replace(/\*/g, '');
  // Check the Loan Request line specifically — implicit position assertion
  // from "First mortgage refinance" / "Second mortgage" framing.
  const loanRequestPositionM = asteriskStripped.match(/\bLoan\s+Request\s*:?\s*[^\n]*?\b(first|second|third|1st|2nd|3rd)\s+mortgage\b/i);
  if (loanRequestPositionM) {
    const raw = loanRequestPositionM[1].toLowerCase();
    let value = null;
    if (/^(first|1st)$/.test(raw)) value = '1st';
    else if (/^(second|2nd)$/.test(raw)) value = '2nd';
    else if (/^(third|3rd)$/.test(raw)) value = '3rd';
    if (value) {
      intents.push({ field: 'mortgage_position', value, source: 'broker_initial_intent', rawPhrase: loanRequestPositionM[0] });
    }
  }
  // Fallback: explicit position statement anywhere in body (sibling to
  // parseBrokerCorrections position patterns; first-inbound caller).
  if (!intents.find(i => i.field === 'mortgage_position')) {
    const positionPatterns = [
      /\bthis\s+is\s+(?:a |the )?(first|second|third|1st|2nd|3rd)\s+mortgage\b/i,
      /\b(?:in\s+(?:the\s+)?)?(first|second|third|1st|2nd|3rd)\s+position\b/i,
      /\b(?:mortgage\s+)?position\s+is\s+(?:a |the )?(first|second|third|1st|2nd|3rd)\b/i,
    ];
    for (const re of positionPatterns) {
      const m = asteriskStripped.match(re);
      if (m) {
        const raw = m[1].toLowerCase();
        let value = null;
        if (/^(first|1st)$/.test(raw)) value = '1st';
        else if (/^(second|2nd)$/.test(raw)) value = '2nd';
        else if (/^(third|3rd)$/.test(raw)) value = '3rd';
        if (value) {
          intents.push({ field: 'mortgage_position', value, source: 'broker_initial_intent', rawPhrase: m[0] });
          break;
        }
      }
    }
  }

  // R11-A (2026-05-27): transaction_type initial-intent patterns.
  // Sibling to parseBrokerCorrections transaction_type extraction; covers
  // broker's first-inbound transaction-structure assertion. Empirical
  // anchor: Marcus "Loan Request: First mortgage refinance — $408,000 —
  // refinancing" pushes transaction_type='refinance'.
  const transactionTypePatterns = [
    { re: /\brefinanc(?:e|ing)\s+(?:his|her|their|the|this|an?|my|our)?\s*(?:existing\s+)?(?:[A-Z][A-Za-z]*\s+)?(?:first |1st )?mortgage\b/i, value: 'refinance' },
    { re: /\bthis\s+is\s+(?:a |the )?refinance\b/i, value: 'refinance' },
    { re: /\b(?:first\s+|1st\s+)?mortgage\s+refinance\b/i, value: 'refinance' },
    { re: /\brefinancing\b/i, value: 'refinance' },
    { re: /\bpurchas(?:e|ing)\s+(?:this\s+|the\s+|a\s+|an\s+|new\s+|the\s+new\s+)?(?:home|property|house|condo)\b/i, value: 'purchase' },
    { re: /\bthis\s+is\s+(?:a |the )?purchase\b/i, value: 'purchase' },
    { re: /\bsecond\s+mortgage\s+application\b/i, value: '2nd_mortgage' },
    { re: /\bthis\s+is\s+(?:a |the )?(?:second|2nd)\s+mortgage\b/i, value: '2nd_mortgage' },
  ];
  for (const { re, value } of transactionTypePatterns) {
    const m = asteriskStripped.match(re);
    if (m) {
      intents.push({ field: 'transaction_type', value, source: 'broker_initial_intent', rawPhrase: m[0] });
      break;
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

// ──────────────────────────────────────────────────────────────────────────
// R10-E (2026-05-27) — mortgage_position canonical resolver.
// 7th cluster in 1st template family (canonical-map source-hierarchy
// enforcement; precedents R6-γ + R6-α + R9-B + R9-D + R10-G + R10-D).
//
// Empirical headline (Patricia Simmons deal a0caddfb): canonical_map only
// pushed mortgage_position from email_body source ("Loan Request: First
// mortgage" — broker's incorrect statement); Snapshot rendered "Mortgage
// Position: 1st" while Risk Factors narrative correctly said "second
// mortgage with existing $342,000 TD Bank first mortgage." Self-
// contradicting prelim because Snapshot is data-driven (canonical_map)
// while narrative is LLM-driven with broader context. R10-E adds two
// canonical sources: loan_application Page-1 annotation extraction + derived
// signal from existing_first_mortgage_balance > 0 logical constraint.
//
// ARCHITECTURAL DISTINCTION — OBJECTIVE vs INTENT fields (R10-G + R10-E
// formalize this pairing):
//   INTENT fields (R10-G — requested_loan_amount, purpose): broker statement
//     authoritative. Hierarchy: broker_correction > broker_initial_intent >
//     docs > generic email_body. Rationale: broker is authority for what
//     they're REQUESTING.
//   OBJECTIVE fields (R10-E — mortgage_position, address, balances, lender,
//     market_value, province): documents + derived signals authoritative.
//     Hierarchy: broker_correction > docs > derived signals > email_body.
//     Rationale: broker can be factually wrong about objective transaction
//     facts; documents + logical constraints win.
//   Common: broker_correction sits at top universally (broker has authority
//     to correct any field). Distinction: where broker_initial_intent fits —
//     present for INTENT fields above docs; absent for OBJECTIVE fields.
//
// Defended residual (code-docblock per R10-D deferred-residual-flagging
// discipline): 3rd-mortgage case. Currently inferMortgagePositionFromExistingBalance
// returns "2nd" when existing_first_mortgage_balance > 0. Closure condition:
// when canonical_map.existing_first_mortgage_balance has tuples representing
// distinct existing mortgages (separate lenders + balances suggesting
// multiple existing positions), infer position = N+1 where N = count of
// distinct existing mortgages. Future-trigger if production 3rd-mortgage
// case surfaces; empirically rare in residential lending.
//
// Defended residual (code-docblock): R9-B/R9-D/R10-G-style override block
// in prelim prompt NOT added in R10-E per Q5 verdict. Patricia's narrative
// was already correct via LLM broader-context inference; bug surface was
// Snapshot data-driven path only. Closure condition: if Stage 2 retest
// surfaces narrative non-compliance with canonical mortgage_position (e.g.,
// LLM emits "first mortgage" in narrative despite canonical = "2nd"), add
// override block in subsequent cycle. R8-B empirical-evidence-required
// discipline (post-gen sweep requires production evidence threshold).

// R10-E (2026-05-27): mortgage_position extraction from loan_application
// Page-1 AcroForm annotation. Sibling to R10-G's extractPurposeFromLoanApplication.
// Empirical anchor: Patricia loan_application annotation list contains
// literal "Second Mortgage" standalone-line annotation — directly extractable.
// Annotation order in loan_application template: amount, rate, term, purpose,
// position, name. extractMortgagePositionFromLoanApplication walks annotations
// and matches the position-shaped line.
const extractMortgagePositionFromLoanApplication = (doc) => {
  const text = doc?.text || doc?.extracted_data?.text || '';
  if (!text) return null;
  const annPattern = /\[Page\s*1\s*annotation\]\s+([^\n]+)/gi;
  let m;
  while ((m = annPattern.exec(text)) !== null) {
    const val = m[1].trim();
    const posM = val.match(/^(1st|2nd|3rd|First|Second|Third)\s+Mortgage$/i);
    if (posM) {
      const v = posM[1].toLowerCase();
      return (v === 'first' || v === '1st') ? '1st'
           : (v === 'second' || v === '2nd') ? '2nd'
           : '3rd';
    }
  }
  return null;
};

// R10-E (2026-05-27): derived signal — OBJECTIVE-field logical constraint.
// When canonical_map.existing_first_mortgage_balance has any tuple with
// value > 0, the new application is mathematically a 2nd mortgage (or
// higher) by definition: can't have two 1st mortgages on the same property.
// Empirical anchor: Patricia has $342k existing TD Bank 1st mortgage from
// credit_bureau + PNW tuples; new application is necessarily 2nd or higher.
//
// Returns { value, source } shape consistent with R10-D's
// inferProvinceFromAddressSignals. Source classification:
// 'mortgage_position_inferred_from_existing_balance' (verbose-explicit per
// R10-D + R10-G naming discipline).
//
// 3rd-mortgage future-trigger flagged in docblock above; currently returns
// "2nd" universally when balance > 0.
//
// R11-A (2026-05-27): refinance carve-out. When transaction_type='refinance'
// AND existing_first_mortgage_lender (mortgage_statement source) matches a
// lender named in the broker's refinance assertion (broker_correction or
// broker_initial_intent rawPhrase for transaction_type), the derived "2nd"
// signal is SUPPRESSED — the existing first mortgage is being paid out at
// closing, the new mortgage takes 1st position. Empirical anchor: Marcus
// Webb 8c404ae0 "refinancing his existing RBC first mortgage — the RBC will
// be paid out at closing."
//
// Lender-match has TWO modes (both tolerant of spelling variants via the
// existing LENDER_SYNONYMS canonicalization infrastructure — R6-γ + R9-D):
//
//   (1) STRICT — broker_correction / broker_initial_intent rawPhrase
//       explicitly names a lender that matches the mortgage_statement-source
//       canonical lender. Example: Marcus inbound[1] "refinancing his existing
//       RBC first mortgage" → findLenderInWindow returns 'RBC' → matches
//       mortgage_statement source canonical 'RBC' → match.
//
//   (2) IMPLICIT SINGLE-LENDER — when broker says refinance WITHOUT naming
//       a lender AND mortgage_statement source has exactly ONE unique
//       canonical lender, that lender is by inference the one being paid
//       off. Example: Marcus inbound[0] "First mortgage refinance —
//       $408,000 — refinancing" + RBC payout statement attached → implicit
//       match (single mortgage_statement lender = RBC; broker's refinance
//       targets the single existing mortgage by structural necessity).
//       Closes the UX gap where the first-turn broker submission with
//       explicit refinance intent would otherwise trigger a discrepancy
//       question Vienna shouldn't need to ask.
//
// Defensive: when broker_correction lacks lender name AND mortgage_statement
// source has MULTIPLE lenders OR ZERO lenders, neither match mode fires →
// derived signal still pushes → discrepancy detected → broker asked. Once
// broker resolves with broker_correction (which suppresses derived per the
// canonical-map-level suppression at extractCanonicalFields), discrepancy
// resolves on the next turn.
//
// Compound transaction (refinance + new 2nd) preserved: lender-match is
// conditional. If broker refinances RBC AND adds a NEW 2nd, broker_correction
// for mortgage_position would explicitly say "2nd" → broker_correction
// suppression at extractCanonicalFields strips derived anyway.
const inferMortgagePositionFromExistingBalance = (canonicalMap) => {
  if (!canonicalMap) return null;
  const balances = canonicalMap.existing_first_mortgage_balance || [];
  const hasNonZero = balances.some(t => t && Number.isFinite(t.value) && t.value > 0);
  if (!hasNonZero) return null;

  // R11-A refinance carve-out
  const txnTypeTuples = canonicalMap.transaction_type || [];
  const refinanceTuple = txnTypeTuples.find(t => t && t.value === 'refinance');
  if (refinanceTuple) {
    // OPTION C (Franco 2026-06-02): a plainly-stated first-mortgage refinance
    // (payoutConfirmed OR refinanceConfident) pays out the existing 1st — the new
    // mortgage IS the 1st position, so the derived "2nd" inference is wrong.
    // Suppress it REGARDLESS of whether a mortgage_statement is attached to
    // confirm the lender. Mirrors the computeCombinedLtv Option-C carve-out
    // (discrepancy-engine.js): resolve correctly; a lender disagreement is
    // surfaced as a SEPARATE admin discrepancy flag, not by leaving a wrong "2nd"
    // position to drive a mortgage-position discrepancy / escalation. Empirical
    // anchor — Franco 5d1479ea: existing $318k Scotiabank from credit_report (no
    // mortgage_statement) inferred "2nd" → false position discrepancy on a clean
    // RBC first-mortgage refinance.
    //
    // PAYOUT-CAPABILITY GUARD (mirrors computeCombinedLtv): only suppress the
    // derived "2nd" when the new loan can actually pay out the existing 1st
    // (requested >= existing). If requested is absent or < existing, the existing
    // balance is NOT being paid out by this loan → it reads as a 2nd mortgage →
    // KEEP the derived "2nd" (preserves R10-E true-2nd detection for bare-balance
    // / new<existing shapes — e.g. a $100k loan behind a $342k existing 1st, or a
    // credit_report-only submission with no loan amount).
    const _requestedTuples = canonicalMap.requested_loan_amount || [];
    const _requested = (_requestedTuples[0] && Number.isFinite(_requestedTuples[0].value)) ? _requestedTuples[0].value : null;
    const _maxExisting = Math.max(0, ...balances.filter(t => t && Number.isFinite(t.value)).map(t => t.value));
    const _payoutCapable = _requested != null && _requested >= _maxExisting;
    if ((refinanceTuple.payoutConfirmed === true || refinanceTuple.refinanceConfident === true) && _payoutCapable) {
      return null;
    }
    // Fallback (ambiguous refinance — neither payout-confirmed nor confidence-
    // tagged): retain the prior R11-A mortgage_statement lender-match suppression
    // as defense-in-depth.
    const payoutLenderTuples = (canonicalMap.existing_first_mortgage_lender || [])
      .filter(t => t && t.classification === 'mortgage_statement' && t.value);
    const payoutLenderCanonicals = Array.from(new Set(
      payoutLenderTuples.map(t => normalizeLender(t.value)).filter(Boolean),
    ));
    // Mode 1 — strict: broker rawPhrase names a lender matching payout source
    const refinanceLenderInPhrase = findLenderInWindow(refinanceTuple.rawPhrase || '');
    if (refinanceLenderInPhrase && payoutLenderCanonicals.includes(refinanceLenderInPhrase)) {
      return null; // Strict lender match → suppress derived (refinance pays out existing 1st)
    }
    // Mode 2 — implicit single-lender: broker says refinance without naming
    // lender, but mortgage_statement source has exactly one canonical lender
    if (!refinanceLenderInPhrase && payoutLenderCanonicals.length === 1) {
      return null; // Implicit match → suppress derived
    }
  }

  return { value: '2nd', source: 'mortgage_position_inferred_from_existing_balance' };
};

// ─── Top-level: extract everything per submission ───

// R5 Cluster B Sub-root 1 (2026-05-21): opts.preExtractedEmailFields
// supports the aggregating wrapper in discrepancy-engine.js — when provided
// (object with the email-body field shape), the internal extractFromEmailBody
// call is bypassed and these values feed the `email_body` tuples directly.
// The wrapper resolves multi-msg latest-non-empty-wins externally and passes
// the result here. emailBody can be '' when preExtractedEmailFields is used.
// FRANCO-Q1 (2026-05-28): conservative payout-language detector. Gates the
// R11-B-3 refinance carve-out — the existing 1st is treated as paid-out (combined
// LTV = standalone) ONLY when the broker EXPLICITLY states payout-at-closing
// (Franco's Q1 rule). LEAN FALSE-NEGATIVE: missing a real payout → the deal
// escalates for clarification (recoverable); a false-positive → carve-out fires on
// what might be a 2nd-mortgage-add (under-conservative, underwriting-dangerous). So
// DIRECT payout phrasing only — do NOT infer from "refi"/"replacing"/"consolidating".
const PAYOUT_LANGUAGE_RE = /\bpaid out at closing\b|\bwill be paid out\b|\bbeing paid out\b|\bto be paid out\b|\bpaying out (?:the |his |her |their |my |our )?existing\b|\brefinanc\w* to pay (?:off|out)\b|\bto pay off (?:the |his |her |their |my |our )?existing\b|\bdischarg\w+ (?:the |his |her |their |my |our )?existing\b/i;
const detectPayoutLanguage = (text) => {
  if (!text) return { present: false, phrase: null };
  const m = String(text).match(PAYOUT_LANGUAGE_RE);
  return m ? { present: true, phrase: m[0] } : { present: false, phrase: null };
};

// FRANCO-Q1: purchase-signal detector — used only to decide the DEFAULT when
// transaction_type has no explicit signal (purchase contract doc, or clear
// purchase language). "refinance to purchase X" is refinance-context, so a
// dominant refinance signal suppresses the purchase default.
const PURCHASE_LANGUAGE_RE = /\bpurchas(?:e|ing)\b|\bbuying\b|\bto buy\b|\bagreement of purchase and sale\b/i;
const detectPurchaseSignal = (emailBody, savedDocs) => {
  const hasPurchaseDoc = (savedDocs || []).some(d => /purchase[_\s-]?contract|agreement[_\s-]?of[_\s-]?purchase|^aps$/i.test(d.classification || ''));
  if (hasPurchaseDoc) return { present: true, signal: 'purchase_contract document on file' };
  if (emailBody && PURCHASE_LANGUAGE_RE.test(emailBody) && !/\brefinanc/i.test(emailBody)) {
    const m = emailBody.match(PURCHASE_LANGUAGE_RE);
    return { present: true, signal: `purchase language: "${m[0]}"` };
  }
  return { present: false, signal: null };
};

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
    // R10-G (2026-05-27): purpose canonical field. Intent-type (broker's
    // stated reason for the loan); pushed from broker_initial_intent
    // (first inbound), broker_correction (subsequent explicit corrections),
    // loan_application (AcroForm annotation), aml form (Source of Funds /
    // Purpose of Mortgage field). Source-hierarchy resolution per Q2-sub-b:
    // broker_correction > broker_initial_intent > documents > generic email_body.
    purpose: [],
    // R11-A (2026-05-27): transaction_type — first INFERENTIAL canonical
    // field (signal-derived from multi-source semantic interpretation rather
    // than direct extraction). Values: 'refinance' | 'purchase' |
    // '2nd_mortgage' | '3rd_mortgage' | null (undetermined). Sources:
    //   broker_correction (parser detects "refinancing existing X mortgage"
    //     / "this is a refinance" / etc. in subsequent inbounds)
    //   broker_initial_intent (same parser on first-inbound loan-request
    //     line)
    //   loan_application (purpose field from AcroForm; future: when
    //     extractor surfaces purpose-as-transaction-type semantic)
    // Consumed by inferMortgagePositionFromExistingBalance (refinance
    // carve-out — suppresses derived "2nd" signal when refinance + existing
    // lender match) AND R11-B computeCombinedLtv (refinance LTV math —
    // existing first being paid off, not additive).
    //
    // ARCHITECTURAL INNOVATION (worth pinning) — first inferential canonical
    // field at HIGHER semantic layer than R10-E's mortgage_position_inferred
    // _from_existing_balance + R10-D's province_inferred_from_postal/city.
    // 1st-family extension via NEW sub-pattern. Promotion to its own
    // template family deferred until 3+ inferential fields establish the
    // lineage empirically (sibling future candidates: property_use_type,
    // collateral_type, loan_program).
    transaction_type: [],
    // R11-B (Thornton 8c024006, 2026-06-08): property OCCUPANCY (Owner Occupied / Rental /
    // Second Home) — deterministic, loan_application-sourced. Display-only (Snapshot "Ownership
    // Type" row); NOT in the discrepancy-compute list. Distinct from the LLM entity ownership_type.
    subject_property_occupancy: [],
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
  // R10-E (2026-05-27): classification field added for uniform filter logic
  // (filterCanonicalMortgagePositionForObjectiveAuthoritative checks
  // classification === 'email_subject_or_body' to strip when doc/derived
  // sources present). Existing source field preserved for backward-compat
  // with any pre-R10-E consumers reading source directly.
  push('mortgage_position', email.mortgage_position, 'email_subject_or_body', { classification: 'email_subject_or_body' });

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
      // R6-α (2026-05-21): thread classification:'loan_application' onto the
      // requested_loan_amount push so the consumer-side filter can identify
      // doc-source-authoritative tuples and strip conflicting email_body
      // tuples from prompt context (Derek S3 dce308c8 fix).
      // (FRANCO Round-8 2026-06-06: the requested_loan_term_months push was removed here —
      // Loan Term is no longer a structured field.)
      const r = extractFromLoanApplication(doc);
      push('requested_loan_amount', r.requested_loan_amount, doc.file_name, { classification: cls });
      // R10-G (2026-05-27): purpose from loan_application Page-1 annotation
      const loanAppPurpose = extractPurposeFromLoanApplication(doc);
      push('purpose', loanAppPurpose, doc.file_name, { classification: cls });
      // R10-E (2026-05-27): mortgage_position from loan_application Page-1
      // annotation. OBJECTIVE-field doc-source — outranks email_body at
      // filter time. Empirically anchored: Patricia loan_application
      // annotation contains "Second Mortgage" standalone-line.
      const loanAppMortgagePos = extractMortgagePositionFromLoanApplication(doc);
      push('mortgage_position', loanAppMortgagePos, doc.file_name, { classification: cls });
      // R11-B (Thornton 8c024006, 2026-06-08): deterministic occupancy (Owner Occupied / Rental
      // / Second Home) from the loan app → Snapshot "Ownership Type" row.
      const loanAppOccupancy = extractOccupancyFromLoanApplication(doc);
      push('subject_property_occupancy', loanAppOccupancy, doc.file_name, { classification: cls });
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
  //
  // R11-A (2026-05-27): non-aggregated detection wiring — when caller
  // doesn't supply opts.brokerCorrections / opts.brokerInitialIntent,
  // parse current-turn emailBody and push tuples. This bridges the active-
  // branch detection at webhook.js:3477 (uses extractCanonicalFields, NOT
  // extractCanonicalFieldsAggregated) to broker_correction visibility.
  // Load-bearing for keeping Q1-D detection-symmetry fix deferred — without
  // this wiring, broker confirmations from the current-turn inbound would
  // not reach canonical_map → discrepancyHold gate wouldn't release →
  // broker corrections ignored repeatedly (R11-A empirical: Marcus's
  // outbounds 1 + 3 asked the SAME discrepancy verbatim).
  //
  // R11-A extends INTENT_FIELDS to include transaction_type (intent-shape:
  // broker asserts transaction structure; doc-source AcroForm purpose can
  // also fill but broker's stated intent ranks higher per R10-G framing).
  // mortgage_position stays OBJECTIVE (broker correction wins universally
  // per R10-E hierarchy when explicitly stated, but absent broker_correction
  // doc-source remains authoritative).
  const INTENT_FIELDS = new Set(['requested_loan_amount', 'purpose', 'transaction_type']);
  // R11-A: derive brokerCorrections + brokerInitialIntent from current-turn
  // emailBody when caller didn't supply them. Backwards-compat: existing
  // aggregated caller (extractCanonicalFieldsAggregated) passes both arrays
  // and the local computation is skipped.
  const brokerCorrections = Array.isArray(opts.brokerCorrections)
    ? opts.brokerCorrections
    : (emailBody ? parseBrokerCorrections(emailBody) : []);
  const brokerInitialIntent = Array.isArray(opts.brokerInitialIntent)
    ? opts.brokerInitialIntent
    : (emailBody ? parseBrokerInitialIntent(emailBody) : []);
  for (const c of brokerCorrections) {
    if (!c || !c.field || !map[c.field]) continue;
    map[c.field].unshift({
      value: c.value,
      source: 'broker_correction',
      classification: 'broker_correction',
      rawPhrase: c.rawPhrase || '',
    });
  }
  for (const i of brokerInitialIntent) {
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

  // R10-E (2026-05-27): mortgage_position derived signal from existing_first_
  // mortgage_balance > 0 logical constraint. OBJECTIVE-field signal sitting
  // BELOW loan_application doc-source in hierarchy (filter at consumer site
  // picks loan_application if present; falls back to derived signal; falls
  // back to email_body). 7th cluster in 1st template family. Closes Patricia
  // Snapshot vs Risk Factors self-contradiction (canonical_map now has
  // docs/derived tuples outranking broker's incorrect "first mortgage"
  // email statement).
  //
  // R11-A (2026-05-27) REORDERING: inferMortgagePosition now runs AFTER
  // broker-source push (was: BEFORE). Reason — refinance carve-out checks
  // canonical_map.transaction_type tuples (populated by broker push) AND
  // mortgage_position broker_correction presence (also from broker push).
  // Reordering preserves R10-E source-hierarchy semantic (broker_correction
  // > docs > derived > email_body) and correctly suppresses derived push
  // at canonical_map level when broker has explicitly resolved the position
  // OR when transaction_type='refinance' + lender match indicates refinance
  // semantic supersedes existing-balance-based inference.
  //
  // CANONICAL-MAP-LEVEL SUPPRESSION RATIONALE — computeDiscrepancySet
  // operates on the unfiltered canonical_map. Without canonical-map-level
  // suppression (only consumer-site filtering), broker_correction "1st" +
  // derived "2nd" would still produce a 2-group discrepancy → discrepancy-
  // Hold gate would hold → broker re-asked despite explicit resolution.
  // R11-A's load-bearing fix: suppress derived signal at canonical-map
  // construction when (a) broker_correction for mortgage_position present
  // OR (b) refinance carve-out fires.
  const inferredMortgagePos = inferMortgagePositionFromExistingBalance(map);
  if (inferredMortgagePos) {
    // R11-A: skip derived push if broker_correction for mortgage_position
    // already present (broker explicitly resolved — derived is redundant /
    // potentially contradictory).
    const hasBrokerCorrectionPosition = (map.mortgage_position || [])
      .some(t => t && t.classification === 'broker_correction');
    if (!hasBrokerCorrectionPosition) {
      map.mortgage_position.push({
        value: inferredMortgagePos.value,
        source: inferredMortgagePos.source,
        classification: inferredMortgagePos.source,
      });
    }
  }

  // R11-B-1 Layer 1 (2026-05-27): canonical-map suppression of loan_application
  // requested_loan_amount tuple when broker-authoritative source contradicts
  // by >30%. Empirical anchor: Marcus Webb 8c404ae0 blank Union Lending
  // template emits $95k loan_application tuple (AcroForm annotation default
  // value) while broker_initial_intent stated $408k — 77% delta. Without
  // suppression, computeDiscrepancySet sees BOTH tuples → discrepancy_set
  // flags as cross-source mismatch → Vienna LLM cites "loan application
  // requests $95k" in Risk Factors narrative.
  //
  // ARCHITECTURAL FAMILY — 1st template family extension (canonical-map
  // source-hierarchy enforcement). Same pattern as R11-A's broker_correction
  // suppression of derived mortgage_position signal at canonical-map level
  // (M5 reorder + suppression). When broker is authoritative AND doc-source
  // contradicts substantially (>30%), the doc-source is suspect (likely
  // template-default AcroForm annotation, not real broker-filled data).
  //
  // THRESHOLD CALIBRATION (R10-D code-docblock discipline) — 30% delta is
  // initial empirical anchor (Marcus 77%). Tunable per closure condition:
  // if production surfaces legitimate small-delta cases (broker stated
  // $408k + loan_app filled $410k = 0.5% delta) being incorrectly
  // suppressed OR larger legitimate disagreements (>30%) being preserved
  // when they shouldn't, recalibrate threshold.
  //
  // PRESERVATION — small-delta disagreements (≤30%) preserved per the
  // existing R10-G consumer-site filter (filterCanonicalLoanAmountForDocAuthoritative
  // strips loan_app from Snapshot context when broker source present);
  // canonical-map level keeps both tuples for audit transparency. R11-B-1
  // Layer 1 only fires on LARGE deltas — empirical signal of template-
  // default-not-real-data.
  const loanAmountTuples = map.requested_loan_amount || [];
  const hasBrokerSourceAmount = loanAmountTuples.some(t =>
    t && (t.classification === 'broker_correction' || t.classification === 'broker_initial_intent'));
  if (hasBrokerSourceAmount) {
    const brokerTuple = loanAmountTuples.find(t =>
      t.classification === 'broker_correction' || t.classification === 'broker_initial_intent');
    const brokerValue = brokerTuple?.value;
    if (Number.isFinite(brokerValue) && brokerValue > 0) {
      const filtered = loanAmountTuples.filter(t => {
        if (!t || t.classification !== 'loan_application') return true;
        const docValue = t.value;
        if (!Number.isFinite(docValue) || docValue <= 0) return true;
        const delta = Math.abs(brokerValue - docValue);
        const maxValue = Math.max(brokerValue, docValue);
        const deltaPct = delta / maxValue;
        // Suppress loan_application tuple when delta > 30% (suspect template-default)
        return deltaPct <= 0.30;
      });
      if (filtered.length !== loanAmountTuples.length) {
        map.requested_loan_amount = filtered;
      }
    }
  }

  // FRANCO-Q1 (2026-05-28): payout-language confirmation + transaction_type default.
  // (1) Tag every transaction_type tuple with payoutConfirmed — read from the FULL
  //     email body + doc text (not just the rawPhrase snippet) so an explicit payout
  //     statement anywhere in the submission qualifies (Marcus: "the RBC will be paid
  //     out at closing"). This flag GATES the R11-B-3 carve-out in computeCombinedLtv.
  // (2) Default transaction_type when no explicit signal: refinance unless a purchase
  //     signal is present (Franco's rule — all files are refinance unless purchase).
  // Aggregated caller passes emailBody='' but threads the real stripped broker
  // body via opts.brokerBodyText — prefer it so payout/purchase language is seen.
  const _q1BrokerText = opts.brokerBodyText != null ? opts.brokerBodyText : (emailBody || '');
  const _q1PayoutText = `${_q1BrokerText}\n${(savedDocs || []).map(d => d.text || '').join('\n')}`;
  const _q1Payout = detectPayoutLanguage(_q1PayoutText);
  for (const t of (map.transaction_type || [])) {
    if (t) t.payoutConfirmed = _q1Payout.present;
  }
  if (!map.transaction_type || map.transaction_type.length === 0) {
    const _q1Purchase = detectPurchaseSignal(_q1BrokerText, savedDocs);
    map.transaction_type = map.transaction_type || [];
    if (_q1Purchase.present) {
      map.transaction_type.push({ value: 'purchase', source: 'defaulted_purchase_signal', classification: 'defaulted_purchase_signal', rawPhrase: _q1Purchase.signal, payoutConfirmed: false });
    } else {
      map.transaction_type.push({ value: 'refinance', source: 'defaulted_from_purchase_absence', classification: 'defaulted_from_purchase_absence', rawPhrase: '', payoutConfirmed: _q1Payout.present });
    }
  }
  // FRANCO-Q1-RULE-REFINEMENT (Franco 2026-05-30): "If it is a refinance, there is no
  // other option than to pay out the existing mortgage — that IS refinancing." So a
  // CONFIDENTLY-determined refinance implies payout (the R11-B-3 carve-out in
  // computeCombinedLtv fires WITHOUT requiring explicit payout language). This SUPERSEDES
  // the original BATCH-13 reading (require explicit payout language → 33% escalation) with
  // Franco's sharper articulation. Confidence guards — these stay escalate-for-clarification:
  //   - AMBIGUOUS refi-vs-purchase (broker uncommitted: "either refinancing or buying,
  //     depending on the appraisal") → NOT confident.
  //   - explicit NON-PAYOUT contraindication ("second mortgage", "existing stays in place")
  //     → NOT confident (the existing 1st is NOT being paid out).
  // The payoutConfirmed flag is preserved (defense-in-depth: explicit payout still fires
  // via its own branch); this ADDS a refinanceConfident tag the new branch consumes.
  const _q1AmbiguousRefiPurchase = /\beither\b[^.]*\b(?:refinanc|purchas|buy)|(?:refinanc\w*|purchas\w*)\s+or\s+(?:a\s+)?(?:purchas|refinanc|buy|new)|depend\w*\s+on\s+(?:the\s+)?appraisal/i.test(_q1BrokerText);
  const _q1NonPayoutContra = /\bsecond\s+mortgage\b|\b2nd\s+mortgage\b|\bexisting\b[^.]{0,40}\b(?:stays?|remain(?:s|ing)?)\s+in\s+place\b/i.test(_q1BrokerText);
  const _q1RefiConfident = !_q1AmbiguousRefiPurchase && !_q1NonPayoutContra;
  for (const t of (map.transaction_type || [])) {
    if (t && t.value === 'refinance') t.refinanceConfident = _q1RefiConfident;
  }

  // OPTION C (Franco 2026-06-02) ORDERING RECONCILIATION: the derived
  // mortgage_position "2nd" inference (inferMortgagePositionFromExistingBalance,
  // pushed earlier in this function) ran BEFORE transaction_type's
  // payoutConfirmed/refinanceConfident flags were tagged (set just above in this
  // pass). So a plainly-stated first-mortgage refinance could not suppress the
  // derived "2nd" at push time, leaving a stale "2nd" tuple that the objective
  // filter would resolve over the broker/email "1st" → false position
  // discrepancy + wrong 2nd. Re-run the now-fully-flagged suppression decision
  // and remove the stale derived tuple if the refinance carve-out applies. The
  // re-check reuses inferMortgagePositionFromExistingBalance verbatim (no
  // duplicated logic) and is idempotent: null return = suppress (no non-zero
  // balance OR carve-out fires) → strip any derived tuple; truthy = keep.
  if (inferMortgagePositionFromExistingBalance(map) === null) {
    map.mortgage_position = (map.mortgage_position || [])
      .filter(t => !(t && t.source === 'mortgage_position_inferred_from_existing_balance'));
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

// ════════════════════════════════════════════════════════════════════
// R11-B-1 Layer 2 (2026-05-27): sanitizeLoanAppDocTextForLLM
// ════════════════════════════════════════════════════════════════════
// LLM-prompt-context consumer-side filter — sibling to consumer-side
// filtering at the Snapshot-renderer boundary (R6-γ + R10-E + R10-G filter
// chain). NEW SUB-PATTERN within 1st template family.
//
// EMPIRICAL ANCHOR — Marcus Webb 8c404ae0: blank Union Lending loan_app
// template contains AcroForm annotation values extracted as `[Page N
// annotation]` markers in the doc text (e.g., `[Page 1 annotation] 95,000`
// + `[Page 1 annotation] Debt consolidation and home renovation` + 7
// Scotiabank placeholder mentions inside annotation markers). When this
// raw doc text is interpolated into Vienna's LLM prompt context at
// generateLeadSummary docSections (ai.js:3103), the LLM reads template
// defaults as if they're filled-in broker data and emits cross-source
// discrepancies in Risk Factors narrative ("loan application requests
// $95,000... loan application shows existing Scotiabank mortgage").
//
// CONDITIONAL SANITIZATION — annotations stripped ONLY when canonical_map
// has broker-authoritative source for requested_loan_amount (broker_
// correction OR broker_initial_intent). Without broker source: annotations
// PRESERVED (R10-E Patricia parity — loan_application annotations contain
// real broker-filled data in legitimate cases like "Second Mortgage"
// position assertion). The presence of broker source signals that
// loan_application data is suspect / template-default.
//
// IMMUTABILITY — returns new documents array; doesn't mutate input.
//
// SCOPE — strips `[Page N annotation][^\n]*\n?` markers + their per-line
// content. Each annotation line typically contains annotation-emitted
// content only (template default values). Plain text on different lines
// preserved. R10-E's extractFromLoanApplication runs on the ORIGINAL text
// during canonical_map construction (BEFORE sanitization); only LLM-prompt
// consumer sees the sanitized version. Canonical extraction parity
// preserved.
//
// DEFERRED RESIDUAL (per R10-D code-docblock discipline):
//   - LLM-prompt-context sanitization at OTHER call sites (generate-
//     BrokerResponse, processInitialEmail) deferred per asymmetric-gate
//     discipline (R10-F 12th carry-forward). R11-B scope limits to
//     sendPreliminaryReviewToAdmin (Marcus empirical anchor — the
//     production prelim where Bug 2 surfaced). Other call sites may need
//     parallel sanitization. Closure condition: Franco surfaces empirical
//     instances of LLM-narrative misattribution at other generators.
//   - Deeper blank-template fingerprint detection (template-schema-level
//     identification): deferred unless this regex-level sanitization
//     doesn't close empirical surface. Closure condition: Marcus retest
//     post-R11-B still shows LLM misattribution despite annotation strip.
const PAGE_ANNOTATION_LINE_RE = /\[Page\s*\d+\s*annotation\][^\n]*\n?/gi;
const sanitizeLoanAppDocTextForLLM = (documents, canonicalMap) => {
  if (!Array.isArray(documents)) return documents;
  // Determine if canonical_map has broker-authoritative source for
  // requested_loan_amount. If absent, return docs unchanged (Patricia
  // R10-E parity preserved).
  const loanAmountTuples = (canonicalMap && canonicalMap.requested_loan_amount) || [];
  const hasBrokerSource = loanAmountTuples.some(t =>
    t && (t.classification === 'broker_correction' || t.classification === 'broker_initial_intent'));
  if (!hasBrokerSource) return documents;
  // Sanitize loan_application docs only; other classifications unchanged.
  return documents.map(d => {
    if (!d || d.classification !== 'loan_application') return d;
    const originalText = d.extracted_data?.text || '';
    if (!PAGE_ANNOTATION_LINE_RE.test(originalText)) return d;
    // Reset regex lastIndex (test() with /g flag advances it)
    PAGE_ANNOTATION_LINE_RE.lastIndex = 0;
    const sanitizedText = originalText.replace(PAGE_ANNOTATION_LINE_RE, '');
    return {
      ...d,
      extracted_data: {
        ...d.extracted_data,
        text: sanitizedText,
      },
    };
  });
};

module.exports = {
  LENDER_SYNONYMS,
  LENDER_REVERSE_MAP,
  normalizeLender,
  detectNonCanadianProperty, // FRANCO-Q7
  extractPropertyRegion,     // FRANCO-Q7 (exported for testing)
  detectPayoutLanguage,      // FRANCO-Q1
  detectPurchaseSignal,      // FRANCO-Q1
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
  // R10-E (2026-05-27): mortgage_position canonical resolver helpers.
  // 7th cluster in 1st template family. OBJECTIVE-field source-hierarchy
  // (docs > derived > email_body); pairs with R10-G's INTENT-field
  // hierarchy to formalize the OBJECTIVE-vs-INTENT distinction.
  extractMortgagePositionFromLoanApplication,
  inferMortgagePositionFromExistingBalance,
  extractFromLoanApplication,
  extractOccupancyFromLoanApplication,
  extractBorrowerFromPropertyTax,
  extractCanonicalFields,
  tokenizeNameForCompare,
  // R11-B-1 Layer 2 (2026-05-27): LLM-prompt-context consumer-side filter
  // for loan_application doc text — strips [Page N annotation] markers
  // when canonical_map has broker-authoritative source for
  // requested_loan_amount.
  sanitizeLoanAppDocTextForLLM,
};
