// Generalized deployed scenario runner for Franco's Vienna test suite (Scenarios 2-15).
// Usage: node scripts/replay-scenarios-2to15.js <scenarioId>
// Self-contained: reads the real PDFs from ~/Desktop/UndrWrite Testing; threads broker
// replies + admin replies via In-Reply-To; cleans up its deal at the end.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { postToWebhook, pollForDeal, fetchOutboundFromSupabase } = require('../test-fixtures/bulletproof/lib/replay');

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ADMIN = process.env.ADMIN_EMAIL || 'franco@privatemortgagelink.com';
const TO = 'info@privatemortgagelink.com';
const ROOT = '/Users/porterstanley/Desktop/UndrWrite Testing';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const strip = (h) => (h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
// Franco regenerated 5 loan apps (2026-06-12) into "remaining docs/" — read those overrides
// from there, everything else from the scenario folder.
const REGEN_DIR = 'remaining docs';
const REGEN_FILES = new Set(['LoanApplication_Sandra_Fletcher.pdf', 'LoanApplication_James_Okafor.pdf', 'LoanApplication_Noah_MacKenzie.pdf', 'LoanApplication_Lena_Park.pdf', 'LoanApplication_Grace_Paulson.pdf']);
const att = (dir, name) => ({ Name: name, ContentType: 'application/pdf', Content: fs.readFileSync(path.join(ROOT, REGEN_FILES.has(name) ? REGEN_DIR : dir, name)).toString('base64') });
const isPrelim = (m) => /PRELIMINARY|ACTION REQUIRED/i.test(m.Subject || '');
const isEscalation = (m) => /ESCALAT|LTV|>80|COLLATERAL|HIGH.?LTV/i.test(m.Subject || '');

let failures = 0;
const check = (name, cond, detail) => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.log(`  ✗ ${name}${detail ? '\n      ' + String(detail).slice(0, 300) : ''}`); } };

// stableMs = how long to wait with NO new outbound before giving up (the "nothing
// more is coming" fallback). Default 90s. The completion handoff needs a larger
// value: at file completion Vienna now generates the RICH lender submission package
// (generateLeadSummary lenderPackage mode — full underwriting write-up, ~45s) on the
// same async webhook turn before the [File Complete] admin notice + broker closing,
// so the completion outbounds land ~120-130s after the broker's AML/PEP fulfilment
// (vs ~65s with the prior thin fact-sheet). The webhook acks Postmark immediately
// (process-after-ack) so this is latency, not a timeout/duplicate risk.
const waitStable = async (dealId, label, expect, maxMs = 240000, stableMs = 90000) => {
  const start = Date.now(); let last = -1, lastChange = Date.now(), out = [];
  while (Date.now() - start < maxMs) {
    await sleep(5000);
    try { out = await fetchOutboundFromSupabase(s, dealId); } catch (e) {}
    if (out.length !== last) { last = out.length; lastChange = Date.now(); console.log(`    [${label}] outbound → ${last} @ ${((Date.now() - start) / 1000).toFixed(0)}s : [${out.map(m => (m.Subject || '').slice(0, 38)).join(' | ')}]`); }
    const stableFor = Date.now() - lastChange;
    if (last >= (expect || 1) && stableFor >= 30000) break;
    if (last >= 1 && stableFor >= stableMs) break;
  }
  return out;
};
const dealState = async (dealId) => { const { data } = await s.from('deals').select('status,ltv,extracted_data').eq('id', dealId).single(); return data; };
const docClasses = async (dealId) => { const { data } = await s.from('documents').select('classification').eq('deal_id', dealId); return (data || []).map(d => d.classification); };
const dealsForEmail = async (email) => { const { data } = await s.from('deals').select('id').eq('email', email); return (data || []).length; };
const lastMidOf = (out, filterFn) => { const p = (filterFn ? out.filter(filterFn) : out).filter(m => m.external_message_id); return p.length ? p[p.length - 1].external_message_id : null; };
const cleanup = async (email) => {
  const { data } = await s.from('deals').select('id').eq('email', email);
  for (const d of (data || [])) {
    const { data: docs } = await s.from('documents').select('storage_path').eq('deal_id', d.id);
    const paths = (docs || []).map(x => x.storage_path).filter(Boolean);
    if (paths.length) { try { await s.storage.from('documents').remove(paths); } catch (e) {} }
    await s.from('documents').delete().eq('deal_id', d.id);
    await s.from('messages').delete().eq('deal_id', d.id);
    try { await s.from('daily_summaries').delete().eq('deal_id', d.id); } catch (e) {}
    await s.from('deals').delete().eq('id', d.id);
  }
  console.log(`  [cleanup] removed ${(data || []).length} deal(s) for ${email}`);
};

// ── per-scenario configs ───────────────────────────────────────────────────
const sig = (name, firm, lic, phone) => `\n\n${name}\n${firm} | Lic. #${lic}\n${phone}`;
const SCENARIOS = {
  2: {
    dir: 'Scenario 2 docs', fromName: 'Charlotte Brennan', email: 'c.brennan+s2@lakewoodmortgage.ca',
    subject: 'New Mortgage Submission — Sandra Whitfield — 23 Hawkwood Blvd NW, Calgary',
    body: `Hi,\nMy name is Charlotte Brennan, mortgage broker with Lakewood Mortgage Corp, Lic. #MB445127. I'd like to submit a new application for your review.\n\nBorrower: Sandra Whitfield\nProperty: 23 Hawkwood Blvd NW, Calgary, AB\nMortgage Position: 1st\n\nPlease find the complete document package attached.${sig('Charlotte Brennan', 'Lakewood Mortgage Corp', 'MB445127', '(403) 514-7823')}`,
    docs: ['LoanApplication_Sandra_Whitfield.pdf', 'PNW_Statement_Sandra_Whitfield.pdf', 'T4_Sandra_Whitfield_2025.pdf', 'Appraisal_23_Hawkwood_Blvd_Calgary.pdf', 'Credit_Bureau_Sandra_Whitfield.pdf', 'GovernmentID_Sandra_Whitfield.pdf', 'PropertyTaxAssessment_Sandra_Whitfield.pdf', 'RBC_Payout_Statement_Sandra_Whitfield.pdf'],
    expect: 'prelim-complete',
  },
  4: {
    dir: 'Scenario 4', fromName: 'Rebecca Santos', email: 'r.santos+s4@clearfieldmortgage.ca',
    subject: 'New Mortgage Submission — Ryan Callahan — 412 Elbow Drive SW, Calgary',
    body: `Hi,\nMy name is Rebecca Santos, mortgage broker with Clearfield Mortgage Inc., Lic. #MB667349. I'd like to submit a new application for your review.\n\nBorrower: Ryan Callahan\nProperty: 412 Elbow Drive SW, Calgary, AB\nMortgage Position: 1st\n\nPlease find the document package attached.${sig('Rebecca Santos', 'Clearfield Mortgage Inc.', 'MB667349', '(403) 741-6628')}`,
    docs: ['LoanApplication_Ryan_Callahan.pdf', 'PNW_Statement_Ryan_Callahan.pdf', 'T4_Ryan_Callahan_2025.pdf', 'Appraisal_412_Elbow_Drive_SW_Calgary.pdf', 'Credit_Bureau_Ryan_Callahan.pdf', 'GovernmentID_Ryan_Callahan.pdf', 'PropertyTaxAssessment_Ryan_Callahan.pdf'],
    expect: 'escalation-highltv',
  },
  5: {
    dir: 'Scenario 5', fromName: 'David Okonkwo', email: 'd.okonkwo+s5@riversidelending.ca',
    subject: 'New Mortgage Submission — Margaret Chen — 127 Maplewood Drive SE, Calgary',
    body: `Hi,\nMy name is David Okonkwo, mortgage broker with Riverside Lending Corp, Lic. #MB778450. I'd like to submit a new application for your review.\n\nBorrower: Margaret Lynn Chen\nProperty: 127 Maplewood Drive SE, Calgary, AB T2J 3K8\nLoan Request: $268,000 (1st mortgage)\nProperty Value: $412,000\nLTV: Approximately 65%\n\nPlease find the complete document package attached.${sig('David Okonkwo', 'Riverside Lending Corp', 'MB778450', '(403) 852-7739')}`,
    docs: ['LoanApplication_Margaret_Chen.pdf', 'PNW_Statement_Margaret_Chen.pdf', 'T4_Margaret_Chen_2025.pdf', 'Credit_Bureau_Margaret_Chen.pdf', 'GovernmentID_Margaret_Chen.pdf', 'PropertyTaxAssessment_Margaret_Chen.pdf', 'TD_Payout_Statement_Margaret_Chen.pdf'],
    expect: 'prelim-missing-appraisal',
  },
  14: {
    dir: 'Scenario 14', fromName: 'Elena Vasquez', email: 'e.vasquez+s14@suncrestmortgage.ca',
    subject: 'New Mortgage Submission — Lena Park — 3704 Parkhill Street SW, Calgary',
    body: `Hi,\nMy name is Elena Vasquez, mortgage broker with Suncrest Mortgage Group, Lic. #MB434996. I'd like to submit a new application for your review.\n\nBorrower: Lena Park\nProperty: 3704 Parkhill Street SW, Calgary, AB\nMortgage Position: 1st\n\nPlease find the documents attached.${sig('Elena Vasquez', 'Suncrest Mortgage Group', 'MB434996', '(403) 881-5529')}`,
    docs: ['LoanApplication_Lena_Park.pdf', 'PNW_Statement_Lena_Park.pdf', 'T4_Lena_Park_2025.pdf', 'Appraisal_3704_Parkhill_Street_SW_Calgary.pdf', 'Credit_Bureau_Lena_Park.pdf', 'Scotiabank_Payout_Statement_Lena_Park.pdf', 'GovernmentID_Lena_Park.pdf', 'PropertyTaxAssessment_3704_Parkhill_Street_SW_Calgary.pdf'],
    expect: 'discrepancy-hold',
    turn2: { body: 'The correct scores are 748 and 752 as shown on the credit bureau. The loan application had an old figure — please use the bureau scores.', docs: [] },
  },
  15: {
    dir: 'Scenario 15', fromName: 'Nathan Blackwood', email: 'n.blackwood+s15@kestrelmortgage.ca',
    subject: 'New Mortgage Submission — Anna Bergstrom — 1801 Varsity Estates Dr NW, Calgary',
    body: `Hi,\nMy name is Nathan Blackwood, mortgage broker with Kestrel Mortgage Corp, Lic. #MB545107. I'm submitting a new application using our firm's own loan application form.\n\nBorrower: Anna Bergstrom\nProperty: 1801 Varsity Estates Dr NW, Calgary, AB\nMortgage Position: 1st\n\nPlease find the documents attached.${sig('Nathan Blackwood', 'Kestrel Mortgage Corp', 'MB545107', '(403) 774-8823')}`,
    docs: ['LoanApplication_Grace_Paulson.pdf', 'T4_Anna_Bergstrom_2025.pdf', 'Credit_Bureau_Anna_Bergstrom.pdf', 'Appraisal_1801_Varsity_Estates_Dr_NW_Calgary.pdf', 'BMO_Payout_Statement_Anna_Bergstrom.pdf'],
    expect: 'identity-clash',
    turn2: { body: 'Apologies — the loan application was mislabeled. Anna Bergstrom is the correct borrower at 1801 Varsity Estates Dr NW. I will resend the correct application.', docs: [] },
  },
  9: {
    dir: 'Scenario 9', fromName: 'Fernando Reyes', email: 'f.reyes+s9@hillsidemortgage.ca',
    subject: 'New Mortgage Submission — James Okafor — 2281 Rabbit Hill Road NW, Edmonton',
    body: `Hi,\nMy name is Fernando Reyes, mortgage broker with Hillside Mortgage Corp, Lic. #MB212894. I'd like to submit a new application for your review.\n\nBorrower: James Okafor\nProperty: 2281 Rabbit Hill Road NW, Edmonton, AB\nMortgage Position: 1st\n\nPlease find the complete document package attached.${sig('Fernando Reyes', 'Hillside Mortgage Corp', 'MB212894', '(587) 443-8819')}`,
    docs: ['LoanApplication_James_Okafor.pdf', 'PNW_Statement_James_Okafor.pdf', 'T4_James_Okafor_2025.pdf', 'Appraisal_2281_Rabbit_Hill_Road_NW_Edmonton.pdf', 'Credit_Bureau_James_Okafor.pdf', 'GovernmentID_James_Okafor.pdf', 'PropertyTaxAssessment_2281_Rabbit_Hill_Rd_NW.pdf', 'Scotiabank_Payout_Statement_James_Okafor.pdf'],
    expect: 'admin-conditions',
    adminFlow: [{ replyTo: 'prelim', body: 'Approved with the following conditions: please obtain the AML form and PEP form from the broker before funding.' }, { replyTo: 'last', body: 'SEND — looks good, send it to the broker as-is.' }],
    conditionTurn: { body: 'Here are the completed AML and PEP forms for James. Let me know if anything else is needed.', docs: ['AML_Form_James_Okafor.pdf', 'PEP_Form_James_Okafor.pdf'] },
  },
  12: {
    dir: 'Scenario 12', fromName: 'Piotr Nowak', email: 'p.nowak+s12@westwoodmortgage.ca',
    subject: 'New Mortgage Submission — Noah MacKenzie — 5831 Riverbend Road NW, Edmonton',
    body: `Hi,\nMy name is Piotr Nowak, mortgage broker with Westwood Mortgage Solutions, Lic. #MB323905. I'd like to submit a new application for your review.\n\nBorrower: Noah MacKenzie\nProperty: 5831 Riverbend Road NW, Edmonton, AB\nMortgage Position: 1st\n\nPlease find the initial documents attached. I'll send the remaining items shortly.${sig('Piotr Nowak', 'Westwood Mortgage Solutions', 'MB323905', '(780) 614-3327')}`,
    docs: ['LoanApplication_Noah_MacKenzie.pdf', 'PNW_Statement_Noah_MacKenzie.pdf', 'T4_Noah_MacKenzie_2025.pdf', 'Appraisal_5831_Riverbend_Road_NW_Edmonton.pdf', 'Credit_Bureau_Noah_MacKenzie.pdf'],
    expect: 'prelim-partial-missing',
  },
  3: {
    dir: 'Scenario 3', fromName: 'James Whitfield', email: 'j.whitfield+s3@stonewoodlending.ca',
    subject: 'Quick question about a deal — Michael Thornton',
    body: `Hi there,\nMy name is James Whitfield from Stonewood Lending Group. I have a client, Michael Thornton, looking for a short-term private mortgage on his property in Lethbridge. LTV is around 62%, clean credit, solid employment. Is this something you'd be able to help with? Happy to send the full package if so.\n\nThanks,\nJames Whitfield\nStonewood Lending Group | Lic. #MB556238\n(403) 629-5514`,
    docs: [],
    expect: 'conversational',
    turn2: { body: "Great, here's the full package for Michael.\n\nJames", docs: ['LoanApplication_Michael_Thornton.pdf', 'PNW_Statement_Michael_Thornton.pdf', 'T4_Michael_Thornton_2025.pdf', 'Appraisal_614_University_Drive_W_Lethbridge.pdf', 'Credit_Bureau_Michael_Thornton.pdf', 'GovernmentID_Michael_Thornton.pdf', 'PropertyTaxAssessment_Michael_Thornton.pdf', 'TD_Payout_Statement_Michael_Thornton.pdf'] },
  },
  10: {
    dir: 'Scenario 1 docs', fromName: 'Helen MacGregor', email: 'h.macgregor+s10@sunridgelending.ca',
    subject: 'Referral from Franco — New Broker Introduction',
    body: `Hi,\nMy name is Helen MacGregor from Sunridge Lending Group. Franco Maione referred me to you. I have a client I'd like to discuss — can you let me know how you work with referred brokers and what I need to send over?\n\nThanks,\nHelen MacGregor\nSunridge Lending Group`,
    docs: [],
    expect: 'referral-broker',
  },
  8: {
    dir: 'Scenario 8', fromName: 'Anita Kowalski', email: 'a.kowalski+s8@clearwaterlending.ca',
    subject: 'New Mortgage Submission — Sandra Fletcher — 412 Windermere Close SW, Edmonton',
    body: `Hi,\nMy name is Anita Kowalski, mortgage broker with Clearwater Lending Inc., Lic. #MB101783. I'd like to submit a new application for your review.\n\nBorrower: Sandra Fletcher\nProperty: 412 Windermere Close SW, Edmonton, AB\nMortgage Position: 1st\n\nPlease find the document package attached.${sig('Anita Kowalski', 'Clearwater Lending Inc.', 'MB101783', '(403) 785-2244')}`,
    docs: ['LoanApplication_Sandra_Fletcher.pdf', 'PNW_Statement_Sandra_Fletcher.pdf', 'T4_Sandra_Fletcher_2025.pdf', 'Appraisal_412_Windermere_Close_SW_Edmonton.pdf', 'Credit_Bureau_Sandra_Fletcher.pdf', 'RBC_Payout_Statement_Sandra_Fletcher.pdf'],
    expect: 'admin-reject',
    resolve: 'To confirm — this is a FIRST mortgage (1st position). The loan app checkbox was marked wrong; please proceed as a 1st.',
    adminFlow: [{ replyTo: 'prelim', body: 'DECLINE — the borrower\'s debt servicing is too tight for this file. Please send a polite decline.' }, { replyTo: 'last', body: 'SEND — looks good, send it to the broker as-is.' }],
  },
  90: { // isolation: clean loan-app (Kevin Tran) + CONDITIONS → broker fulfils AML/PEP → handoff
    dir: 'Scenario 6', fromName: 'Sarah Chen', email: 's.chen+s90@northbrookmortgage.ca',
    subject: 'New Mortgage Submission — Kevin Tran — 3312 Brentwood Road NW, Calgary',
    body: `Hi,\nMy name is Sarah Chen, mortgage broker with Northbrook Mortgage Group, Lic. #MB889561.\n\nBorrower: Kevin Minh Tran\nProperty: 3312 Brentwood Road NW, Calgary, AB\nMortgage Position: 1st\n\nPlease find the complete document package attached.${sig('Sarah Chen', 'Northbrook Mortgage Group', 'MB889561', '(403) 963-4412')}`,
    docs: ['LoanApplication_Kevin_Tran.pdf', 'PNW_Statement_Kevin_Tran.pdf', 'T4_Kevin_Tran_2025.pdf', 'Appraisal_3312_Brentwood_Road_NW_Calgary.pdf', 'Credit_Bureau_Kevin_Tran.pdf', 'GovernmentID_Kevin_Tran.pdf', 'PropertyTaxAssessment_Kevin_Tran.pdf', 'ATB_Payout_Statement_Kevin_Tran.pdf'],
    expect: 'admin-conditions',
    adminFlow: [{ replyTo: 'prelim', body: 'Approved with the following conditions: please obtain the AML form and PEP form from the broker before funding.' }, { replyTo: 'last', body: 'SEND — looks good, send it to the broker as-is.' }],
    conditionTurn: { body: 'Here are the completed AML and PEP forms for Kevin. Let me know if anything else is needed.', docs: ['AML_Form_Kevin_Tran.pdf', 'PEP_Form_Kevin_Tran.pdf'] },
  },
  80: { // isolation: clean loan-app (Kevin Tran) + DECLINE, no discrepancy hold → tests reject dispatch
    dir: 'Scenario 6', fromName: 'Sarah Chen', email: 's.chen+s80@northbrookmortgage.ca',
    subject: 'New Mortgage Submission — Kevin Tran — 3312 Brentwood Road NW, Calgary',
    body: `Hi,\nMy name is Sarah Chen, mortgage broker with Northbrook Mortgage Group, Lic. #MB889561.\n\nBorrower: Kevin Minh Tran\nProperty: 3312 Brentwood Road NW, Calgary, AB\nMortgage Position: 1st\n\nPlease find the complete document package attached.${sig('Sarah Chen', 'Northbrook Mortgage Group', 'MB889561', '(403) 963-4412')}`,
    docs: ['LoanApplication_Kevin_Tran.pdf', 'PNW_Statement_Kevin_Tran.pdf', 'T4_Kevin_Tran_2025.pdf', 'Appraisal_3312_Brentwood_Road_NW_Calgary.pdf', 'Credit_Bureau_Kevin_Tran.pdf', 'GovernmentID_Kevin_Tran.pdf', 'PropertyTaxAssessment_Kevin_Tran.pdf', 'ATB_Payout_Statement_Kevin_Tran.pdf'],
    expect: 'admin-reject',
    adminFlow: [{ replyTo: 'prelim', body: 'DECLINE — the borrower does not meet our lending criteria for this property type. Please send a polite decline.' }, { replyTo: 'last', body: 'SEND — the draft looks great, send it to the broker as-is.' }],
  },
  6: {
    dir: 'Scenario 6', fromName: 'Sarah Chen', email: 's.chen+s6@northbrookmortgage.ca',
    subject: 'New Mortgage Submission — Kevin Tran — 3312 Brentwood Road NW, Calgary',
    body: `Hi,\nMy name is Sarah Chen, mortgage broker with Northbrook Mortgage Group, Lic. #MB889561. I'd like to submit a new application for your review.\n\nBorrower: Kevin Minh Tran\nProperty: 3312 Brentwood Road NW, Calgary, AB\nMortgage Position: 1st\n\nPlease find the complete document package attached.${sig('Sarah Chen', 'Northbrook Mortgage Group', 'MB889561', '(403) 963-4412')}`,
    docs: ['LoanApplication_Kevin_Tran.pdf', 'PNW_Statement_Kevin_Tran.pdf', 'T4_Kevin_Tran_2025.pdf', 'Appraisal_3312_Brentwood_Road_NW_Calgary.pdf', 'Credit_Bureau_Kevin_Tran.pdf', 'GovernmentID_Kevin_Tran.pdf', 'PropertyTaxAssessment_Kevin_Tran.pdf', 'ATB_Payout_Statement_Kevin_Tran.pdf'],
    expect: 'admin-approve-send',
    adminFlow: [{ replyTo: 'prelim', body: 'APPROVED — looks good, proceed.' }, { replyTo: 'last', body: 'SEND — the draft looks great, send it to the broker as-is.' }],
  },
  7: {
    dir: 'Scenario 7', fromName: 'Paul Drummond', email: 'p.drummond+s7@sherwoodmortgage.ca',
    subject: 'New Mortgage Submission — Daniel Hartley — 2847 Palliser Drive SW, Calgary',
    body: `Hi,\nMy name is Paul Drummond, mortgage broker with Sherwood Mortgage Partners, Lic. #MB990672. I'd like to submit a new application for your review.\n\nBorrower: Daniel James Hartley\nProperty: 2847 Palliser Drive SW, Calgary, AB T2V 4A8\nLoan Request: $298,000 (1st mortgage, refinance)\nProperty Value: $498,000\nLTV: Approximately 59.8%\n\nPlease find the documents attached.${sig('Paul Drummond', 'Sherwood Mortgage Partners', 'MB990672', '(403) 874-3315')}`,
    docs: ['LoanApplication_Daniel_Hartley.pdf', 'PNW_Statement_Daniel_Hartley.pdf', 'T4_Daniel_Hartley_2025.pdf', 'Credit_Bureau_Daniel_Hartley.pdf', 'GovernmentID_Daniel_Hartley.pdf', 'PropertyTaxAssessment_Daniel_Hartley.pdf', 'CIBC_Payout_Statement_Daniel_Hartley.pdf'],
    expect: 'admin-approve-send',
    adminFlow: [{ replyTo: 'prelim', body: 'APPROVED — proceed to draft.' }, { replyTo: 'last', body: 'Send this to the broker, but please add a note that we will need 30 days for funding and that the rate is 9.99%. Otherwise looks good.' }],
  },
  11: {
    dir: 'Scenario 1 docs', fromName: 'Sophie Larsson', email: 'sophie.larsson+s11@gmail.com',
    subject: 'Mortgage inquiry — referred by Franco Maione',
    body: `Hi,\nMy name is Sophie Larsson. Franco Maione suggested I reach out to you about getting a short-term mortgage. I own a home in Calgary and I'm looking to refinance. Franco said you might be able to help. Can you let me know what the next steps are?\n\nThanks,\nSophie Larsson\n(403) 555-0192`,
    docs: [],
    expect: 'referral-borrower',
  },
};

(async () => {
  const id = Number(process.argv[2]);
  const cfg = SCENARIOS[id];
  if (!cfg) { console.error(`No config for scenario ${id}`); process.exit(1); }
  const ts = Date.now();
  const from = cfg.email.replace('@', `-${ts}@`);
  console.log(`=== Scenario ${id} deployed replay | ${cfg.fromName} <${from}> | expect=${cfg.expect} ===\n`);
  try {
    await postToWebhook({ From: from, FromName: cfg.fromName, FromFull: { Email: from, Name: cfg.fromName }, To: TO, Subject: cfg.subject, TextBody: cfg.body, HtmlBody: null, MessageID: `s${id}-${ts}-t0@test`, Date: new Date().toISOString(), Headers: [], Attachments: cfg.docs.map(d => att(cfg.dir, d)) });
    const deal = await pollForDeal(s, from, { timeoutMs: 120000 });
    console.log(`  dealId=${deal.id} ltv=${deal.ltv} status=${deal.status}`);
    let out = await waitStable(deal.id, 't0', 2);
    const st = await dealState(deal.id);
    const classes = await docClasses(deal.id);
    const welcome = out.find(m => !isPrelim(m) && !isEscalation(m)) || out[0];
    let admin = out.find(isPrelim) || out.find(isEscalation);
    console.log(`\n  final status=${st.status} ltv=${st.ltv} | docs(${classes.length}): ${classes.join(', ')}`);
    console.log('\n----- WELCOME -----\n' + (welcome ? strip(welcome.TextBody) : '<<none>>'));
    console.log('\n----- ADMIN -----\n' + (admin ? strip(admin.TextBody).slice(0, 1200) : '<<none>>') + '\n');

    const w = strip(welcome && welcome.TextBody).toLowerCase();
    const a = strip(admin && admin.TextBody);
    const noOverclaim = !/everything(?:\s+\w+)?\s+(?:looks|is|seems)\s+(?:complete|in order|all set)|have everything we need|file is complete|good to go/.test(w);

    console.log(`=== SCENARIO ${id} ASSERTIONS ===`);
    check('single deal (no duplicate)', (await dealsForEmail(from)) === 1);
    check('welcome email sent', !!welcome);

    if (cfg.expect === 'prelim-complete') {
      check('admin PRELIMINARY review fired', !!admin && isPrelim(admin));
      check('status under_review', st.status === 'under_review');
      check('all 8 docs on file', classes.length === 8, classes.join(','));
      check('welcome acknowledges receipt', /received|thanks for|got the/.test(w));
      check('no false mismatch callout in prelim', !/reads as|provided as a/i.test(a), (a.match(/.{0,60}reads as.{0,60}/i) || [])[0]);
    } else if (cfg.expect === 'escalation-highltv') {
      // High-LTV initial submission: Vienna asks the broker about collateral; admin is
      // SILENT at this stage by design (escalation fires after the broker declines collateral).
      check('status awaiting_collateral (LTV>80)', st.status === 'awaiting_collateral', st.status);
      check('welcome asks about COLLATERAL', /collateral|additional (security|property)|bring.*ltv|other.*(property|security)/.test(w), w.slice(0, 300));
      check('welcome flags the >80% LTV', /80%|exceed|above|outside.*threshold|higher than/.test(w), w.slice(0, 300));
      check('welcome does NOT request the full doc list', !/property tax|payout statement|government[\s-]?issued id|proof of income/.test(w), w.slice(0, 300));
      check('no completeness overclaim', noOverclaim);
    } else if (cfg.expect === 'prelim-missing-appraisal') {
      check('admin PRELIMINARY review fired', !!admin && isPrelim(admin));
      check('status under_review', st.status === 'under_review', st.status);
      check('no completeness overclaim in welcome', noOverclaim, w.slice(0, 300));
      check('welcome OR prelim flags appraisal missing', /appraisal/.test(w) || /\[missing\][^\n]*appraisal|appraisal[^\n]*\[missing\]/i.test(a), 'appraisal not flagged');
      check('no false mismatch callout in prelim', !/reads as|provided as a/i.test(a), (a.match(/.{0,60}reads as.{0,60}/i) || [])[0]);
    } else if (cfg.expect === 'prelim-partial-missing') {
      check('welcome requests the missing items (Gov ID / Property Tax / Payout)', /government[\s-]?issued id|government id|property tax|payout|mortgage (payout|statement)/.test(w), w.slice(0, 300));
      check('no completeness overclaim', noOverclaim, w.slice(0, 300));
      check('no false mismatch callout in prelim', !/reads as|provided as a/i.test(a), (a.match(/.{0,60}reads as.{0,60}/i) || [])[0]);
      check('no false 1st-vs-2nd position discrepancy', !/mortgage[_ ]?position|1st.{0,20}2nd|first.{0,20}second mortgage/i.test(w), w.slice(0, 300));
    } else if (cfg.expect === 'discrepancy-hold') {
      // Turn 0: Vienna flags the 631/619 vs 748/752 credit-score mismatch to the broker,
      // cites the loan application (not the broker's email), and HOLDS the prelim.
      check('welcome flags a discrepancy / asks to confirm', /confirm|clarif|discrepan|which (is|are) correct|noticed/.test(w), w.slice(0, 400));
      check('welcome mentions credit score figures', /631|619|748|752|credit score/.test(w), w.slice(0, 400));
      check('NO internal-workflow language to broker', !/being reviewed|under review|underwriting team|review process/i.test(w), w.slice(0, 400));
      check('prelim HELD on turn 0 (not fired prematurely)', !admin, admin ? 'prelim fired before resolution' : '');
      // "held" = prelim not sent; status is 'active' normally, or 'awaiting_collateral' on an
      // intermittent appraisal-extraction flake (market_value null → BUG-4). Both correctly hold.
      check('prelim held (status active / awaiting_collateral, not under_review)', ['active', 'awaiting_collateral'].includes(st.status), st.status);
    } else if (cfg.expect === 'identity-clash') {
      check('welcome flags the name/identity mismatch', /grace|paulson|which.*borrower|confirm.*borrower|correct borrower|mismatch|different (name|person)/i.test(w), w.slice(0, 400));
      check('greets the broker by name (not generic Hi there)', /hi nathan|hello nathan/i.test(w) && !/hi there/i.test(w.slice(0, 20)), w.slice(0, 40));
      check('does NOT request the full doc list yet', !/property tax|payout statement|proof of income/.test(w), w.slice(0, 300));
      check('status awaiting_identity_confirmation', st.status === 'awaiting_identity_confirmation', st.status);
      check('prelim NOT fired (identity gate first)', !admin);
    } else if (cfg.expect === 'conversational') {
      check('Vienna engages / offers to help (no premature prelim)', /happy to|send (over|the)|full package|glad to help|love to help|tell me more|how can|absolutely/.test(w), w.slice(0, 300));
      check('no admin prelim on a no-doc conversational opener', !admin);
    } else if (cfg.expect === 'referral-broker') {
      check('introduces Vienna / explains process', /vienna|lead underwriter|how we work|process|here.?s how/.test(w), w.slice(0, 300));
      check('asks the broker for the deal write-up/details', /write-?up|deal (details|summary)|tell me (more|about)|send (over|me) the|details (on|about)|what.*looking/.test(w), w.slice(0, 400));
      check('mentions the referral / Franco context appropriately', !/hi there!?\s*$/i.test(w.slice(0, 12)));
    } else if (cfg.expect === 'referral-borrower') {
      check('plain language — NO industry jargon to borrower', !/\bLTV\b|\bNOA\b|\bAML\b|\bPEP\b|loan-to-value|payout statement|mortgage position/i.test(w), w.slice(0, 400));
      check('includes a calendar / call booking link', /calendar\.app|book.*call|schedule.*call|calendly|15-minute|booking link/i.test(w), w.slice(0, 400));
      check('mentions the intake forms (application / net worth)', /application|net worth|forms? (attached|to (fill|complete))|two forms/i.test(w), w.slice(0, 400));
    }

    // ── optional turn 2 (broker reply, threaded to Vienna's welcome) ──
    if (cfg.turn2 && welcome) {
      console.log(`\n--- TURN 2 (broker reply) ---`);
      const mid = lastMidOf(out, m => !isPrelim(m) && !isEscalation(m)) || lastMidOf(out);
      await postToWebhook({ From: from, FromName: cfg.fromName, FromFull: { Email: from, Name: cfg.fromName }, To: TO, Subject: `Re: ${cfg.subject}`, TextBody: cfg.turn2.body, HtmlBody: null, MessageID: `s${id}-${ts}-t1@test`, Date: new Date().toISOString(), Headers: mid ? [{ Name: 'In-Reply-To', Value: `<${mid}>` }, { Name: 'References', Value: `<${mid}>` }] : [], Attachments: (cfg.turn2.docs || []).map(d => att(cfg.dir, d)) });
      const out2 = await waitStable(deal.id, 't2', out.length + 1);
      const st2 = await dealState(deal.id);
      const dealCount = await dealsForEmail(from);
      const prelims = out2.filter(isPrelim);
      console.log(`  after t2: status=${st2.status} outbound=${out2.length} prelims=${prelims.length} deals=${dealCount}`);
      check('turn-2 reply threaded to SAME deal (no duplicate)', dealCount === 1, `${dealCount} deals`);
      if (cfg.expect === 'discrepancy-hold') {
        check('after resolution: exactly ONE prelim (no double)', prelims.length === 1, `${prelims.length} prelims`);
        check('after resolution: prelim is PRELIMINARY not COMPLETE', prelims.length === 1 && /PRELIMINARY/i.test(prelims[0].Subject), prelims[0] && prelims[0].Subject);
        check('status under_review after resolution', st2.status === 'under_review', st2.status);
      } else if (cfg.expect === 'identity-clash') {
        check('after confirmation: deal proceeds (status active/under_review)', ['active', 'under_review'].includes(st2.status), st2.status);
        check('borrower name corrected to Anna (not Grace)', /anna/i.test(JSON.stringify(st2.extracted_data?.borrower_name || '')) && !/grace/i.test(JSON.stringify(st2.extracted_data?.borrower_name || '')), st2.extracted_data?.borrower_name);
      }
    }

    // If a discrepancy hold prevented the prelim, let the broker resolve it, then re-capture.
    if (cfg.adminFlow && !admin && cfg.resolve) {
      console.log(`\n--- RESOLVE TURN (broker clarifies the held discrepancy) ---`);
      const mid = lastMidOf(out, m => !isPrelim(m) && !isEscalation(m)) || lastMidOf(out);
      await postToWebhook({ From: from, FromName: cfg.fromName, FromFull: { Email: from, Name: cfg.fromName }, To: TO, Subject: `Re: ${cfg.subject}`, TextBody: cfg.resolve, HtmlBody: null, MessageID: `s${id}-${ts}-resolve@test`, Date: new Date().toISOString(), Headers: mid ? [{ Name: 'In-Reply-To', Value: `<${mid}>` }, { Name: 'References', Value: `<${mid}>` }] : [], Attachments: [] });
      out = await waitStable(deal.id, 'resolve', out.length + 1);
      admin = out.find(isPrelim) || out.find(isEscalation);
      const stR = await dealState(deal.id);
      check('broker can RESOLVE the position discrepancy → prelim fires (no stuck deal)', !!admin, `status=${stR.status}, still no prelim after broker clarified`);
    }
    if (cfg.adminFlow) check('prelim fired so admin can act', !!admin, `status=${st.status} (no prelim — discrepancy hold)`);
    // ── admin-reply flow (Franco APPROVED / SEND / DECLINE, threaded to the prelim) ──
    if (cfg.adminFlow && admin) {
      let prevOut = out;
      for (let i = 0; i < cfg.adminFlow.length; i++) {
        const step = cfg.adminFlow[i];
        const target = step.replyTo === 'prelim' ? lastMidOf(prevOut, isPrelim) : lastMidOf(prevOut);
        console.log(`\n--- ADMIN REPLY ${i + 1}: "${step.body.slice(0, 40)}..." (thread <${String(target).slice(0, 18)}>) ---`);
        await postToWebhook({ From: ADMIN, FromName: 'Franco Maione', FromFull: { Email: ADMIN, Name: 'Franco Maione' }, To: TO, Subject: `Re: ${admin.Subject}`, TextBody: step.body, HtmlBody: null, MessageID: `s${id}-${ts}-admin${i}@test`, Date: new Date().toISOString(), Headers: target ? [{ Name: 'In-Reply-To', Value: `<${target}>` }, { Name: 'References', Value: `<${target}>` }] : [], Attachments: [] });
        prevOut = await waitStable(deal.id, `admin${i + 1}`, prevOut.length + 1);
      }
      const st3 = await dealState(deal.id);
      const finalOut = await fetchOutboundFromSupabase(s, deal.id);
      const newMsgs = finalOut.slice(out.length);
      const brokerFacing = newMsgs.filter(m => !isPrelim(m) && !/ACTION REQUIRED|DRAFT|for (your )?review/i.test(m.Subject || ''));
      console.log(`  after admin flow: status=${st3.status} | new outbound subjects: ${newMsgs.map(m => (m.Subject || '').slice(0, 40)).join(' | ')}`);
      if (cfg.expect === 'admin-reject') {
        const rej = newMsgs.map(m => strip(m.TextBody)).join(' ');
        console.log('\n----- REJECTION TO BROKER -----\n' + (newMsgs.length ? strip(newMsgs[newMsgs.length - 1].TextBody).slice(0, 700) : '<<none>>'));
        check('status rejected', st3.status === 'rejected', st3.status);
        check('a broker-facing decline was sent', newMsgs.length >= 1);
        check('decline is polite + not a generic "does not meet criteria"', /unfortunate|unable to|not (a fit|able to proceed)|won.?t be able|after (careful )?review/i.test(rej) && !/does not meet (our )?criteria\.?\s*$/i.test(rej), rej.slice(0, 200));
        check('decline does NOT leak internal routing (Franco/underwriters)', !/franco|underwrit|lender rep|internal/i.test(rej), rej.slice(0, 200));
      } else if (cfg.expect === 'admin-conditions') {
        const condReq = newMsgs[newMsgs.length - 1];
        console.log('\n----- CONDITIONS REQUEST TO BROKER -----\n' + (condReq ? strip(condReq.TextBody).slice(0, 600) : '<<none>>'));
        check('conditions request sent to broker', !!condReq && newMsgs.length >= 2);
        check('conditions request names AML + PEP', condReq && /aml/i.test(strip(condReq.TextBody)) && /pep/i.test(strip(condReq.TextBody)), condReq && strip(condReq.TextBody).slice(0, 150));
        // broker fulfils the conditions
        if (cfg.conditionTurn) {
          console.log('\n--- BROKER FULFILS CONDITIONS (AML + PEP) ---');
          const cmid = lastMidOf(finalOut, m => !isPrelim(m) && !/ACTION REQUIRED|DRAFT|for review/i.test(m.Subject || '')) || lastMidOf(finalOut);
          await postToWebhook({ From: from, FromName: cfg.fromName, FromFull: { Email: from, Name: cfg.fromName }, To: TO, Subject: `Re: ${cfg.subject}`, TextBody: cfg.conditionTurn.body, HtmlBody: null, MessageID: `s${id}-${ts}-cond@test`, Date: new Date().toISOString(), Headers: cmid ? [{ Name: 'In-Reply-To', Value: `<${cmid}>` }, { Name: 'References', Value: `<${cmid}>` }] : [], Attachments: (cfg.conditionTurn.docs || []).map(d => att(cfg.dir, d)) });
          // 160s settle: completion now generates the rich lender package (~45s) before
          // the [File Complete] notice + broker closing land (~120-130s post-fulfilment).
          const out4 = await waitStable(deal.id, 'handoff', finalOut.length + 1, 240000, 160000);
          const stH = await dealState(deal.id);
          const handoffMsgs = out4.slice(finalOut.length);
          const handoff = handoffMsgs.map(m => strip(m.TextBody)).join(' ');
          console.log(`  after fulfilment: status=${stH.status} | new: ${handoffMsgs.map(m => (m.Subject || '').slice(0, 36)).join(' | ')}`);
          console.log('\n----- HANDOFF -----\n' + handoff.slice(0, 600));
          const allDocs = await docClasses(deal.id);
          check('AML + PEP now on file', allDocs.includes('aml') && allDocs.includes('pep'), allDocs.join(','));
          check('Vienna sent a handoff / completion message', /complete|submitted|funding|further questions|franco@privatemortgagelink/i.test(handoff), handoff.slice(0, 200));
          check('no duplicate deal', (await dealsForEmail(from)) === 1);
        }
      } else if (cfg.expect === 'admin-approve-send') {
        const draftToAdmin = newMsgs.find(m => /DRAFT|review|ACTION/i.test(m.Subject || '')) || (newMsgs.length >= 1 ? newMsgs[0] : null);
        const brokerFinal = newMsgs[newMsgs.length - 1];
        console.log('\n----- FINAL TO BROKER -----\n' + (brokerFinal ? strip(brokerFinal.TextBody).slice(0, 700) : '<<none>>'));
        check('a draft was produced for admin after APPROVED', !!draftToAdmin);
        check('a broker-facing email was sent after SEND', !!brokerFinal && newMsgs.length >= 2);
        check('broker-facing final does NOT leak internal routing', brokerFinal && !/franco|underwrit|internal review|lender rep/i.test(strip(brokerFinal.TextBody)), brokerFinal && strip(brokerFinal.TextBody).slice(0, 150));
        check('no duplicate deal', (await dealsForEmail(from)) === 1);
      }
    }

    console.log('\n' + (failures === 0 ? `✅ SCENARIO ${id} — ALL ASSERTIONS PASS` : `❌ SCENARIO ${id} — ${failures} FAILED`));
  } catch (e) {
    failures++; console.error('REPLAY ERROR:', e.message);
  } finally {
    if (!process.env.NO_CLEANUP) await cleanup(from);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
