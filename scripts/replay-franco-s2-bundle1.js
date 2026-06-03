// STEP 4 — Bundle 1 staging replay against DEPLOYED code (commit e2019d1).
// Fresh persona, Laura-Chen Scenario-2 refinance shape (Alberta-grid address
// "4412 116 Street NW", BMO payout arriving at turn 1, no loan term stated).
//
//   Turn 0: 5 intake docs (NO payout) → initial prelim, Combined LTV $0.
//   Turn 1: BMO payout + property tax + gov ID, DOC-ONLY (no money correction).
//
// Asserts the three Bundle 1 fixes on deployed code:
//   Fix 1 — turn-1 doc-only completion populates existing balance 0→value but
//           must NOT fire a second [UPDATED] prelim (Path B suppression).
//   Fix 2 — Snapshot "Property Address" row carries the house number 4412.
//   small — no "Loan Term Requested" / "TBD" line in the prelim.
// Stops at turn 1 (the AML/PEP closing is Bundle 2, not yet fixed).
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const { postToWebhook, pollForDeal, fetchOutboundFromSupabase } = require('../test-fixtures/bulletproof/lib/replay');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const waitStable = async (dealId, label) => {
  const start = Date.now(); let last = -1, lastChange = Date.now(), out = [];
  while (Date.now() - start < 240000) {
    await sleep(5000);
    try { out = await fetchOutboundFromSupabase(s, dealId); } catch (e) {}
    if (out.length !== last) { last = out.length; lastChange = Date.now(); console.log(`    [${label}] outbound → ${last} @ ${((Date.now() - start) / 1000).toFixed(0)}s`); }
    else if (last > 0 && Date.now() - lastChange >= 60000) break;
  }
  return out;
};
const buildAtts = async (docrows) => {
  const out = [];
  for (const d of docrows) { const { data: blob } = await s.storage.from('documents').download(d.storage_path); out.push({ Name: d.file_name, ContentType: 'application/pdf', Content: Buffer.from(await blob.arrayBuffer()).toString('base64') }); }
  return out;
};

(async () => {
  const { data: srcDeals } = await s.from('deals').select('id').order('created_at', { ascending: false }).limit(30);
  const srcId = srcDeals.find(d => d.id.startsWith('9da89a81')).id;
  const { data: msgs } = await s.from('messages').select('subject,body').eq('deal_id', srcId).eq('direction', 'inbound').order('created_at');
  const { data: docs } = await s.from('documents').select('file_name,storage_path').eq('deal_id', srcId).order('created_at');
  const turn1Re = /BMO_Payout|PropertyTax|GovernmentID/i;
  const lateRe = /BMO_Payout|PropertyTax|GovernmentID|AML_Form|PEP_Form/i; // exclude ALL post-intake docs from turn 0
  const turn0Docs = docs.filter(d => !lateRe.test(d.file_name)); // 5 intake only (incl Appraisal_4412_116_Street_NW)
  const turn1Docs = docs.filter(d => turn1Re.test(d.file_name));  // payout + tax + gov id (doc-only completion)

  const tag = `s2b1-${Date.now()}`, from = `franco+${tag}@francomaione.com`, to = 'info@privatemortgagelink.com';
  console.log(`=== Bundle 1 replay → DEPLOYED | from=${from} ===`);
  console.log(`turn0 docs: ${turn0Docs.map(d => d.file_name).join(', ')}`);
  console.log(`turn1 docs: ${turn1Docs.map(d => d.file_name).join(', ')}\n`);

  // TURN 0
  await postToWebhook({ From: from, FromName: 'Emily Strand', FromFull: { Email: from, Name: 'Emily Strand' }, To: to,
    Subject: msgs[0].subject || 'New File Submission — Laura Chen', TextBody: (msgs[0].body || '').replace(/<[^>]+>/g, ' '), HtmlBody: null,
    MessageID: `${tag}-t0@s2b1.synthetic`, Date: new Date().toISOString(), Headers: [], Attachments: await buildAtts(turn0Docs) });
  const deal = await pollForDeal(s, from, { timeoutMs: 90000 });
  console.log(`dealId=${deal.id}`);
  const out0 = await waitStable(deal.id, 'turn0');
  const prelim0 = out0.find(m => /PRELIMINARY Review/i.test(m.Subject));

  // TURN 1: DOC-ONLY completion (no money correction)
  const prior = (await fetchOutboundFromSupabase(s, deal.id)).filter(m => m.external_message_id);
  const lastMid = prior.length ? prior[prior.length - 1].external_message_id : null;
  const docOnlyBody = 'Hi Vienna,\n\nPlease find the remaining documents attached: the BMO payout statement, property tax assessment, and government ID for Laura.\n\nEmily Strand\nNorthgate Lending Partners';
  await postToWebhook({ From: from, FromName: 'Emily Strand', FromFull: { Email: from, Name: 'Emily Strand' }, To: to,
    Subject: `Re: ${msgs[0].subject || 'New File Submission — Laura Chen'}`, TextBody: docOnlyBody, HtmlBody: null,
    MessageID: `${tag}-t1@s2b1.synthetic`, Date: new Date().toISOString(),
    Headers: lastMid ? [{ Name: 'In-Reply-To', Value: `<${lastMid}>` }, { Name: 'References', Value: `<${lastMid}>` }] : [], Attachments: await buildAtts(turn1Docs) });
  console.log('[turn 1] POST doc-only completion (payout + tax + gov id, no money correction)');
  const out1 = await waitStable(deal.id, 'turn1');

  // RESULTS — inspect the prelim wherever it landed (turn-0 or late in turn-1 window)
  const allOut = await fetchOutboundFromSupabase(s, deal.id);
  const prelims = allOut.filter(m => /PRELIMINARY Review/i.test(m.Subject));
  const updated = allOut.find(m => /\[UPDATED\]/i.test(m.Subject) && /PRELIMINARY/i.test(m.Subject));
  const thePrelim = prelims[0] || prelim0;
  const b0 = thePrelim ? (thePrelim.HtmlBody || thePrelim.TextBody || '') : '';
  const txt0 = b0.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const addrRow = (txt0.match(/Property Address:\s*([^]*?)(?:City\s*\/|Loan Amount|Mortgage Position)/i) || [])[1] || '';

  console.log('\n=== RESULTS (deployed e2019d1) ===');
  console.log(`  [Fix 1] total PRELIMINARY outbounds: ${prelims.length} (expect 1)`);
  console.log(`  [Fix 1] [UPDATED] prelim at turn 1: ${!!updated} (expect false — SUPPRESSED)`);
  console.log(`  [Fix 2] Snapshot Property Address row: "${addrRow.trim()}"`);
  console.log(`  [Fix 2] address row contains house number 4412: ${/4412/.test(addrRow)} (expect true)`);
  console.log(`  [small] prelim contains "Loan Term Requested": ${/Loan Term Requested/i.test(txt0)} (expect false)`);
  console.log(`  [small] prelim contains "TBD": ${/\bTBD\b/.test(txt0)} (note: City/Province TBD may legitimately remain)`);
  const fix1 = prelims.length === 1 && !updated;
  const fix2 = /4412/.test(addrRow);
  const small = !/Loan Term Requested/i.test(txt0);
  console.log(`\n  VERDICT: Fix1=${fix1 ? 'PASS' : 'FAIL'}  Fix2=${fix2 ? 'PASS' : 'FAIL'}  small=${small ? 'PASS' : 'FAIL'}`);
  console.log('  all outbound:'); out1.forEach(m => console.log(`    [${m.created_at.slice(11, 19)}] ${m.Subject}`));
  console.log(`\n  dealId for Render-log grep: ${deal.id}`);
})().catch(e => { console.error('REPLAY FAIL:', e); process.exit(1); });
