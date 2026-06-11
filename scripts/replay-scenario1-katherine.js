// DEPLOYED Scenario-1 replay — Franco "New Broker Email" (Katherine Morrison).
// Verifies Round-9 Bug 1/2/3 fixes on the REAL staging service with the REAL PDFs.
//   Turn 0: Loretta submits 5 of 8 docs (LoanApp, PNW, T4, Appraisal, Credit).
//     Assert WELCOME: acknowledges received, NO completeness claim, requests the 3 missing.
//     Assert PRELIM: fires (LTV 61%), [MISSING] gov ID/property tax/payout, NO "T4 reads as NOA".
//   Turn 1: broker sends the remaining 3 (Gov ID, Property Tax, Scotiabank Payout).
//     Assert PRELIM(updated): NO "Gov ID reads as AML" callout; nothing still [MISSING].
// Self-contained (reads the real PDFs from the Desktop test folder); deletes its deal at the end.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { postToWebhook, pollForDeal, fetchOutboundFromSupabase } = require('../test-fixtures/bulletproof/lib/replay');
const { computeMissingIntakeItems } = require('../src/lib/dealType');

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const strip = (h) => (h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const DIR = '/Users/porterstanley/Desktop/UndrWrite Testing/Scenario 1 docs';
const att = (name) => ({ Name: name, ContentType: 'application/pdf', Content: fs.readFileSync(`${DIR}/${name}`).toString('base64') });

const INITIAL = ['LoanApplication_Katherine_Morrison.pdf','PNW_Statement_Katherine_Morrison.pdf','T4_Katherine_Morrison_2025.pdf','Appraisal_142_Sage_Meadows_Circle_NW_Calgary.pdf','Credit_Bureau_Katherine_Morrison.pdf'];
const FOLLOWUP = ['GovernmentID_Katherine_Morrison.pdf','PropertyTaxAssessment_Katherine_Morrison.pdf','Scotiabank_Payout_Statement_Katherine_Morrison.pdf'];

const BODY = `Hi,
My name is Loretta Sinclair, mortgage broker with Aspen Ridge Mortgage Group, Lic. #MB334215. I'd like to submit a new application for your review.

Borrower: Katherine Anne Morrison
Property: 142 Sage Meadows Circle NW, Calgary, AB T3R 0K4
Loan Request: $295,000 (1st mortgage, refinance)
Property Value: $484,000
LTV: Approximately 61%

Documents attached:
1. Loan Application
2. Personal Net Worth Statement
3. T4 (2025 — City of Calgary)
4. Property Appraisal
5. Credit Bureau (741/737)

Loretta Sinclair
Aspen Ridge Mortgage Group | Lic. #MB334215
(403) 628-4417`;

const waitStable = async (dealId, label, expect) => {
  // Wait until outbound count is stable for 45s after at least 1 message — but keep
  // waiting (up to 150s) while we still expect more (e.g. prelim after welcome).
  const start = Date.now(); let last = -1, lastChange = Date.now(), out = [];
  while (Date.now() - start < 200000) {
    await sleep(5000);
    try { out = await fetchOutboundFromSupabase(s, dealId); } catch (e) {}
    if (out.length !== last) { last = out.length; lastChange = Date.now(); console.log(`    [${label}] outbound → ${last} @ ${((Date.now()-start)/1000).toFixed(0)}s : [${out.map(m=>(m.Subject||'').slice(0,42)).join(' | ')}]`); }
    const stableFor = Date.now() - lastChange;
    if (last >= (expect||1) && stableFor >= 30000) break;          // got what we expected → done
    if (last >= 1 && stableFor >= 90000) break;                    // gave the extra one 90s → give up
  }
  return out;
};
const dumpState = async (dealId, label, email) => {
  const { data: d } = await s.from('deals').select('status,ltv,extracted_data').eq('id', dealId).single();
  const ed = d?.extracted_data || {};
  console.log(`  [${label}] deal.status=${d?.status} ltv=${d?.ltv} | summary: ltv_percent=${ed.ltv_percent} is_purchase=${ed.is_purchase} exit_strategy=${ed.exit_strategy?('"'+String(ed.exit_strategy).slice(0,40)+'"'):'(none)'}`);
  const { data: docs } = await s.from('documents').select('file_name,classification').eq('deal_id', dealId);
  console.log(`  [${label}] documents (${(docs||[]).length}): ${(docs||[]).map(x=>x.classification).join(', ')}`);
  const { data: msgs } = await s.from('messages').select('direction,subject,created_at').eq('deal_id', dealId).order('created_at',{ascending:true});
  console.log(`  [${label}] messages:`); (msgs||[]).forEach(m => console.log(`      ${m.direction.padEnd(8)} ${(m.subject||'').slice(0,70)}`));
  if (email) {
    const { data: allDeals } = await s.from('deals').select('id,status,created_at').eq('email', email).order('created_at',{ascending:true});
    console.log(`  [${label}] deals for ${email}: ${(allDeals||[]).map(x=>x.id.slice(0,8)+':'+x.status).join(', ')}`);
  }
};
const isPrelim = (m) => /PRELIMINARY|ACTION REQUIRED/i.test(m.Subject || '');
const cleanup = async (dealId) => {
  try {
    const { data: docs } = await s.from('documents').select('storage_path').eq('deal_id', dealId);
    const paths = (docs||[]).map(d=>d.storage_path).filter(Boolean);
    if (paths.length) { try { await s.storage.from('documents').remove(paths); } catch(e){} }
    await s.from('documents').delete().eq('deal_id', dealId);
    await s.from('messages').delete().eq('deal_id', dealId);
    try { await s.from('daily_summaries').delete().eq('deal_id', dealId); } catch(e){}
    await s.from('deals').delete().eq('id', dealId);
    console.log(`  [cleanup] removed deal ${dealId} (${paths.length} storage objects + rows)`);
  } catch (e) { console.error(`  [cleanup] WARN: ${e.message}`); }
};

let failures = 0;
const check = (name, cond, detail) => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.log(`  ✗ ${name}${detail?'\n      '+detail:''}`); } };

(async () => {
  const ts = Date.now();
  const from = `loretta.sinclair+scn1-${ts}@aspenridgemortgage.ca`;
  const to = 'info@privatemortgagelink.com';
  const subject = 'New Mortgage Submission — Katherine Morrison — 142 Sage Meadows Circle NW, Calgary';
  console.log(`=== Scenario-1 deployed replay | from=${from} ===\n`);

  let deal;
  try {
    // ───────── TURN 0 — initial 5 docs ─────────
    console.log('TURN 0 — submitting 5 of 8 docs…');
    await postToWebhook({ From: from, FromName: 'Loretta Sinclair', FromFull: { Email: from, Name: 'Loretta Sinclair' }, To: to,
      Subject: subject, TextBody: BODY, HtmlBody: null, MessageID: `scn1-${ts}-t0@aspenridge`,
      Date: new Date().toISOString(), Headers: [], Attachments: INITIAL.map(att) });
    deal = await pollForDeal(s, from, { timeoutMs: 120000 });
    console.log(`  dealId=${deal.id}  ltv=${deal.ltv}  status=${deal.status}`);
    const out0 = await waitStable(deal.id, 'turn0', 2);
    await dumpState(deal.id, 'after turn0');

    const welcome = out0.find(m => !isPrelim(m));
    const prelim0 = out0.find(isPrelim);

    console.log('\n----- WELCOME EMAIL (broker-facing) -----\n' + (welcome ? strip(welcome.TextBody) : '<<none>>'));
    console.log('\n----- ADMIN PRELIMINARY REVIEW -----\n' + (prelim0 ? strip(prelim0.TextBody) : '<<none>>') + '\n');

    console.log('=== TURN 0 ASSERTIONS ===');
    const w = strip(welcome && welcome.TextBody).toLowerCase();
    check('welcome email was sent', !!welcome);
    check('welcome: NO completeness overclaim', !!welcome && !/everything(?:\s+\w+)?\s+(?:looks|is|seems)\s+(?:complete|in order|all set)|have everything we need|file is complete|ready for review|good to go|all set to/.test(w), w.slice(0,400));
    check('welcome: requests Government ID', /government[\s-]?issued id|government id|photo id|driver/.test(w));
    check('welcome: requests Property Tax Assessment', /property tax/.test(w));
    check('welcome: requests Mortgage Payout Statement', /payout|mortgage statement|discharge/.test(w));
    check('welcome: acknowledges a received doc', /received|thanks for|got the|appreciate/.test(w));

    const p0 = strip(prelim0 && prelim0.TextBody);
    const p0l = p0.toLowerCase();
    check('admin preliminary review fired', !!prelim0);
    check('prelim: lists Government ID as MISSING', /\[missing\][^\n]*government|government[^\n]*\[missing\]/i.test(p0) || /missing[\s\S]{0,400}government/i.test(p0l));
    check('prelim: lists Property Tax as MISSING', /missing[\s\S]{0,600}property tax|property tax[\s\S]{0,200}missing/i.test(p0l) || /\[missing\][^\n]*property tax/i.test(p0));
    check('prelim: lists Payout/Mortgage Statement as MISSING', /missing[\s\S]{0,600}(payout|mortgage (?:payout|statement))/i.test(p0l) || /\[missing\][^\n]*(payout|mortgage)/i.test(p0));
    check('prelim: NO "T4 reads as NOA" callout (Bug 2)', !/reads as.{0,40}(notice of assessment|noa)|provided as.{0,60}(notice of assessment|noa)/i.test(p0l), p0l.match(/.{0,80}reads as.{0,80}/)?.[0] || '');

    // ───────── TURN 1 — remaining 3 docs ─────────
    console.log('\nTURN 1 — submitting remaining 3 docs (Gov ID, Property Tax, Payout)…');
    // Thread the reply to Vienna's welcome email — deal matching is thread-only
    // (In-Reply-To / References); a real broker reply carries these headers.
    const replyToMid = (welcome && welcome.external_message_id)
      || (out0.filter(m => m.external_message_id).slice(-1)[0] || {}).external_message_id;
    console.log(`  threading reply via In-Reply-To <${replyToMid}>`);
    await postToWebhook({ From: from, FromName: 'Loretta Sinclair', FromFull: { Email: from, Name: 'Loretta Sinclair' }, To: to,
      Subject: `Re: ${subject}`, TextBody: 'Hi Vienna — here are the remaining documents you requested: Government ID, Property Tax Assessment, and the Scotiabank payout statement. Thanks!\n\nLoretta', HtmlBody: null,
      MessageID: `scn1-${ts}-t1@aspenridge`, Date: new Date().toISOString(),
      Headers: replyToMid ? [{ Name: 'In-Reply-To', Value: `<${replyToMid}>` }, { Name: 'References', Value: `<${replyToMid}>` }] : [],
      Attachments: FOLLOWUP.map(att) });
    const out1 = await waitStable(deal.id, 'turn1', out0.length + 1);
    await dumpState(deal.id, 'after turn1', from);

    // Batch-2 verification is on DEAL STATE, not a new email: by design (Franco's
    // Path B double-prelim fix, 2026-06-03) a doc-only completion on under_review with
    // no material field change SILENTLY updates state and SUPPRESSES the [UPDATED]
    // prelim + the broker ack (NNN). So we verify the 3 batch-2 docs classified
    // correctly (Bug 3 end-to-end) and the file reached 8/8 with nothing missing.
    const { data: docs1 } = await s.from('documents').select('classification').eq('deal_id', deal.id);
    const { data: deals1 } = await s.from('deals').select('id').eq('email', from);
    const classes = (docs1 || []).map(d => d.classification);

    console.log('=== TURN 1 ASSERTIONS (Path B: doc-only completion — prelim suppression by design) ===');
    check('batch-2 attached to the SAME deal (no duplicate)', (deals1 || []).length === 1, `${(deals1||[]).length} deals for email`);
    check('all 8 documents on file', (docs1 || []).length === 8, `${(docs1||[]).length} docs: ${classes.join(', ')}`);
    check('Gov ID classified government_id, NOT aml (Bug 3, deployed)', classes.includes('government_id') && !classes.includes('aml'), classes.join(', '));
    check('Property Tax classified property_tax', classes.includes('property_tax'));
    check('Scotiabank Payout classified mortgage_statement', classes.includes('mortgage_statement'));
    check('T4 classified income_proof, NOT noa (Bug 2, deployed)', classes.includes('income_proof') && !classes.includes('noa'));
    check('full 8-doc set → computeMissingIntakeItems empty', computeMissingIntakeItems({ classifications: classes, isPurchase: false, exitStrategy: 'on file' }).length === 0);
    check('Path B: no duplicate [UPDATED] prelim (double-prelim suppressed)', out1.length === out0.length, `out0=${out0.length} out1=${out1.length}`);

    console.log('\n' + (failures === 0 ? '✅ SCENARIO-1 DEPLOYED REPLAY — ALL ASSERTIONS PASS' : `❌ ${failures} ASSERTION(S) FAILED`));
  } catch (e) {
    failures++; console.error('\nREPLAY ERROR:', e.message);
  } finally {
    if (deal && !process.env.NO_CLEANUP) await cleanup(deal.id); else if (deal) console.log('  [no-cleanup] deal '+deal.id+' left for inspection');
  }
  process.exit(failures === 0 ? 0 : 1);
})();
