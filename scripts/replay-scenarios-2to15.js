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
const att = (dir, name) => ({ Name: name, ContentType: 'application/pdf', Content: fs.readFileSync(path.join(ROOT, dir, name)).toString('base64') });
const isPrelim = (m) => /PRELIMINARY|ACTION REQUIRED/i.test(m.Subject || '');
const isEscalation = (m) => /ESCALAT|LTV|>80|COLLATERAL|HIGH.?LTV/i.test(m.Subject || '');

let failures = 0;
const check = (name, cond, detail) => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.log(`  ✗ ${name}${detail ? '\n      ' + String(detail).slice(0, 300) : ''}`); } };

const waitStable = async (dealId, label, expect, maxMs = 200000) => {
  const start = Date.now(); let last = -1, lastChange = Date.now(), out = [];
  while (Date.now() - start < maxMs) {
    await sleep(5000);
    try { out = await fetchOutboundFromSupabase(s, dealId); } catch (e) {}
    if (out.length !== last) { last = out.length; lastChange = Date.now(); console.log(`    [${label}] outbound → ${last} @ ${((Date.now() - start) / 1000).toFixed(0)}s : [${out.map(m => (m.Subject || '').slice(0, 38)).join(' | ')}]`); }
    const stableFor = Date.now() - lastChange;
    if (last >= (expect || 1) && stableFor >= 30000) break;
    if (last >= 1 && stableFor >= 90000) break;
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
    docs: ['LoanApplication_Anna_Bergstrom.pdf', 'T4_Anna_Bergstrom_2025.pdf', 'Credit_Bureau_Anna_Bergstrom.pdf', 'Appraisal_1801_Varsity_Estates_Dr_NW_Calgary.pdf', 'BMO_Payout_Statement_Anna_Bergstrom.pdf'],
    expect: 'identity-clash',
    turn2: { body: 'Yes, Anna Bergstrom is the correct borrower — apologies, the documents were mislabeled. Confirming the deal is for Anna Bergstrom at 1801 Varsity Estates Dr NW.', docs: [] },
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
    const out = await waitStable(deal.id, 't0', 2);
    const st = await dealState(deal.id);
    const classes = await docClasses(deal.id);
    const welcome = out.find(m => !isPrelim(m) && !isEscalation(m)) || out[0];
    const admin = out.find(isPrelim) || out.find(isEscalation);
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
    } else if (cfg.expect === 'discrepancy-hold') {
      // Turn 0: Vienna flags the 631/619 vs 748/752 credit-score mismatch to the broker,
      // cites the loan application (not the broker's email), and HOLDS the prelim.
      check('welcome flags a discrepancy / asks to confirm', /confirm|clarif|discrepan|which (is|are) correct|noticed/.test(w), w.slice(0, 400));
      check('welcome mentions credit score figures', /631|619|748|752|credit score/.test(w), w.slice(0, 400));
      check('NO internal-workflow language to broker', !/being reviewed|under review|underwriting team|review process/i.test(w), w.slice(0, 400));
      check('prelim HELD on turn 0 (not fired prematurely)', !admin, admin ? 'prelim fired before resolution' : '');
      check('status still active (awaiting clarification)', st.status === 'active', st.status);
    } else if (cfg.expect === 'identity-clash') {
      check('welcome flags the name/identity mismatch', /grace|paulson|which.*borrower|confirm.*borrower|correct borrower|mismatch|different (name|person)/i.test(w), w.slice(0, 400));
      check('greets the broker by name (not generic Hi there)', /hi nathan|hello nathan/i.test(w) && !/hi there/i.test(w.slice(0, 20)), w.slice(0, 40));
      check('does NOT request the full doc list yet', !/property tax|payout statement|proof of income/.test(w), w.slice(0, 300));
      check('status awaiting_identity_confirmation', st.status === 'awaiting_identity_confirmation', st.status);
      check('prelim NOT fired (identity gate first)', !admin);
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

    console.log('\n' + (failures === 0 ? `✅ SCENARIO ${id} — ALL ASSERTIONS PASS` : `❌ SCENARIO ${id} — ${failures} FAILED`));
  } catch (e) {
    failures++; console.error('REPLAY ERROR:', e.message);
  } finally {
    if (!process.env.NO_CLEANUP) await cleanup(from);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
