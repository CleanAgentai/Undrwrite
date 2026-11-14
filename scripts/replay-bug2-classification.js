// Post-deploy replay (3afdd45): intake with Daniel Kim's docs incl the mislabeled
// Credit_Bureau file (PNW content). Confirms the prelim carries the mismatch callout.
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const { postToWebhook, pollForDeal, fetchOutboundFromSupabase } = require('../test-fixtures/bulletproof/lib/replay');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const waitStable = async (dealId) => {
  const start = Date.now(); let last = -1, lastChange = Date.now(), out = [];
  while (Date.now() - start < 200000) {
    await sleep(5000);
    try { out = await fetchOutboundFromSupabase(s, dealId); } catch (e) {}
    if (out.length !== last) { last = out.length; lastChange = Date.now(); console.log(`    outbound → ${last} @ ${((Date.now() - start) / 1000).toFixed(0)}s`); }
    else if (last > 0 && Date.now() - lastChange >= 55000) break;
  }
  return out;
};

(async () => {
  const { data: srcDeals } = await s.from('deals').select('id').order('created_at', { ascending: false }).limit(30);
  const srcId = srcDeals.find(d => d.id.startsWith('875af304')).id;
  const { data: msgs } = await s.from('messages').select('subject,body').eq('deal_id', srcId).eq('direction', 'inbound').order('created_at');
  const { data: docs } = await s.from('documents').select('file_name,storage_path,created_at').eq('deal_id', srcId).order('created_at');
  const turn1Re = /TD_Payout|PropertyTax|GovernmentID/i;
  const turn0Docs = docs.filter(d => !turn1Re.test(d.file_name)); // 5 docs incl mislabeled Credit_Bureau

  const Attachments = [];
  for (const d of turn0Docs) {
    const { data: blob } = await s.storage.from('documents').download(d.storage_path);
    Attachments.push({ Name: d.file_name, ContentType: 'application/pdf', Content: Buffer.from(await blob.arrayBuffer()).toString('base64') });
  }
  const tag = `bug2-${Date.now()}`, from = `franco+${tag}@vimarealty.com`;
  console.log(`=== Bug 2 replay → 3afdd45 | from=${from} ===`);
  console.log(`docs: ${turn0Docs.map(d => d.file_name).join(', ')}\n`);

  await postToWebhook({ From: from, FromName: 'Nathan Okafor', FromFull: { Email: from, Name: 'Nathan Okafor' }, To: 'info@privatemortgagelink.com',
    Subject: msgs[0].subject || 'New File Submission — Daniel Kim', TextBody: msgs[0].body.replace(/<[^>]+>/g, ' '), HtmlBody: null,
    MessageID: `${tag}@bug2.synthetic`, Date: new Date().toISOString(), Headers: [], Attachments });
  const deal = await pollForDeal(s, from, { timeoutMs: 90000 });
  console.log(`dealId=${deal.id}`);
  const out = await waitStable(deal.id);

  const prelim = out.find(m => /PRELIMINARY Review/i.test(m.Subject));
  const body = prelim ? (prelim.HtmlBody || prelim.TextBody || '') : '';
  const txt = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  console.log('\n=== RESULTS ===');
  console.log(`  prelim fired: ${!!prelim} (ext_id=${prelim ? prelim.external_message_id : 'n/a'})`);
  console.log(`  callout present: ${/Document Classification Mismatch/i.test(body)}`);
  const m = txt.match(/Document Classification Mismatch:[^]*?Please confirm\./i);
  console.log(`  callout text: ${m ? m[0].slice(0, 260) : '(NOT FOUND)'}`);
  // regression: do the OTHER docs render correctly?
  const { data: fresh } = await s.from('deals').select('extracted_data').eq('id', deal.id).single();
  console.log(`  docs_received: ${JSON.stringify((fresh.extracted_data || {}).documents_received)}`);
  console.log(`  ltv: ${(fresh.extracted_data || {}).ltv_percent}`);
  // Postmark delivery of the prelim
  if (prelim && prelim.external_message_id) {
    const r = await fetch('https://api.postmarkapp.com/messages/outbound/' + prelim.external_message_id + '/details', { headers: { 'X-Postmark-Server-Token': process.env.POSTMARK_API_TOKEN, Accept: 'application/json' } });
    const j = await r.json();
    console.log(`  Postmark prelim: Status=${j.Status} To=${(j.Recipients || []).join(',')} Events=${JSON.stringify((j.MessageEvents || []).map(e => e.Type))}`);
  }
})().catch(e => { console.error('REPLAY FAIL:', e); process.exit(1); });
