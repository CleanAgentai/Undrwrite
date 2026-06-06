// POST-DEPLOY verification (commit 35a34ed) — Jennifer Okafor Bug 2 + Bug 3 on deployed code.
// Clones deal f9a67d03's docs + email (run-on broker email, contaminated Credit_Bureau=PNW,
// title-case-needing address "47 Lozinski Drive") under a FRESH sender (dedup-safe new deal).
//   Turn 0: 4 intake docs (LoanApp, Appraisal, T4, Credit_Bureau) → prelim.
//     Verify: NO Loan Term row (Bug 2); Property Address title-case (Bug 3); Existing 1st
//     Mortgage Balance still TBD (intentional); classification callout fires; sections intact.
//   Turn 1: PNW (genuine new doc, no material change) → Path B must SUPPRESS [UPDATED].
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const { postToWebhook, pollForDeal, fetchOutboundFromSupabase } = require('../test-fixtures/bulletproof/lib/replay');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const strip = (h) => (h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

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
const buildAtts = async (rows) => {
  const out = [];
  for (const d of rows) { const { data: blob } = await s.storage.from('documents').download(d.storage_path); out.push({ Name: d.file_name, ContentType: 'application/pdf', Content: Buffer.from(await blob.arrayBuffer()).toString('base64') }); }
  return out;
};
const lastMid = async (id) => { const p = (await fetchOutboundFromSupabase(s, id)).filter(m => m.external_message_id); return p.length ? p[p.length - 1].external_message_id : null; };

(async () => {
  const { data: srcDeals } = await s.from('deals').select('id').order('created_at', { ascending: false }).limit(30);
  const srcId = srcDeals.find(d => d.id.startsWith('f9a67d03')).id;
  const { data: msgs } = await s.from('messages').select('subject,body').eq('deal_id', srcId).eq('direction', 'inbound').order('created_at');
  const { data: docs } = await s.from('documents').select('file_name,storage_path').eq('deal_id', srcId).order('created_at');
  const turn0Docs = docs.filter(d => !/PNW/i.test(d.file_name)); // LoanApp, Appraisal, T4, Credit_Bureau
  const turn1Docs = docs.filter(d => /PNW/i.test(d.file_name));   // PNW

  const tag = `jen23-${Date.now()}`, from = `franco+${tag}@francomaione.com`, to = 'info@privatemortgagelink.com';
  const subj0 = msgs[0].subject || 'New Mortgage File — Jennifer Okafor';
  console.log(`=== Jennifer Bug 2+3 post-deploy replay → 35a34ed | from=${from} ===`);
  console.log(`turn0 docs: ${turn0Docs.map(d => d.file_name).join(', ')}\nturn1 docs: ${turn1Docs.map(d => d.file_name).join(', ')}\n`);

  await postToWebhook({ From: from, FromName: 'Marcus Lindqvist', FromFull: { Email: from, Name: 'Marcus Lindqvist' }, To: to,
    Subject: subj0, TextBody: (msgs[0].body || '').replace(/<[^>]+>/g, ' '), HtmlBody: null,
    MessageID: `${tag}-t0@jen23`, Date: new Date().toISOString(), Headers: [], Attachments: await buildAtts(turn0Docs) });
  const deal = await pollForDeal(s, from, { timeoutMs: 90000 });
  console.log(`dealId=${deal.id}`);
  const out0 = await waitStable(deal.id, 'turn0');
  const prelim = out0.find(m => /PRELIMINARY Review/i.test(m.Subject));
  const pbody = prelim ? (prelim.HtmlBody || prelim.TextBody || '') : '';
  const ptxt = strip(pbody);

  const _mid1 = await lastMid(deal.id);
  await postToWebhook({ From: from, FromName: 'Marcus Lindqvist', FromFull: { Email: from, Name: 'Marcus Lindqvist' }, To: to,
    Subject: `Re: ${subj0}`, TextBody: 'Hi Vienna, attaching the PNW statement to complete the file. Marcus', HtmlBody: null,
    MessageID: `${tag}-t1@jen23`, Date: new Date().toISOString(),
    Headers: _mid1 ? [{ Name: 'In-Reply-To', Value: `<${_mid1}>` }, { Name: 'References', Value: `<${_mid1}>` }] : [], Attachments: await buildAtts(turn1Docs) });
  console.log('[turn 1] PNW posted (doc-only completion)');
  const out1 = await waitStable(deal.id, 'turn1');

  const prelims = out1.filter(m => /PRELIMINARY Review/i.test(m.Subject));
  const updated = out1.find(m => /\[UPDATED\]/i.test(m.Subject));
  const addrRow = (pbody.match(/Property Address:<\/strong>\s*([^<]*)/i) || ptxt.match(/Property Address:\s*(.*?)\s*City/i) || ['', '(?)'])[1].trim();

  console.log('\n=== RESULTS (deployed 35a34ed) ===');
  console.log(`  [BUG 3] Property Address (verbatim): ${JSON.stringify(addrRow)}`);
  console.log(`  [BUG 3] title-case (has uppercase letters, not all-lower): ${/[A-Z]/.test(addrRow)}`);
  console.log(`  [BUG 2] Loan Term row present: ${/Loan Term/i.test(ptxt)} (expect false)`);
  console.log(`  [Existing balance] row shows TBD (intentional): ${/Existing 1st Mortgage Balance:?\s*<?\/?strong>?\s*TBD/i.test(pbody) || /Existing 1st Mortgage Balance: TBD/i.test(ptxt)}`);
  console.log(`  [T4/credit callout] present: ${/was provided as a[^]*?content reads as a/i.test(ptxt)}`);
  console.log(`  [Path B] total prelims: ${prelims.length} (expect 1) | [UPDATED] turn1: ${!!updated} (expect false)`);
  console.log('  all outbound:'); out1.forEach(m => console.log(`    [${m.created_at.slice(11, 19)}] ${m.Subject}`));
  if (prelim && prelim.external_message_id) {
    const j = await (await fetch('https://api.postmarkapp.com/messages/outbound/' + prelim.external_message_id + '/details', { headers: { 'X-Postmark-Server-Token': process.env.POSTMARK_API_TOKEN, Accept: 'application/json' } })).json();
    console.log(`  Postmark admin prelim: To=${(j.Recipients || []).join(',')} Status=${j.Status} Events=${JSON.stringify((j.MessageEvents || []).map(e => e.Type))}`);
  }
  console.log(`  dealId=${deal.id}`);
})().catch(e => { console.error('REPLAY FAIL:', e); process.exit(1); });
