#!/usr/bin/env node
// Post-deploy 2-turn staging replay of the Daniel Kim shape against Path B (699029a).
//   turn 0 — intake + 5 docs (loan_app, credit, T4, appraisal, PNW)
//   turn 1 — continuation + 3 docs (TD payout, gov ID, property tax), no field changes
// Required: turn 0 fires ONE prelim; turn 1 fires NO second prelim (doc-only suppression);
// exactly ONE admin "PRELIMINARY Review" outbound across both turns.
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const { postToWebhook, pollForDeal, fetchOutboundFromSupabase } = require('../test-fixtures/bulletproof/lib/replay');

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isPrelim = (m) => /PRELIMINARY Review/i.test(m.Subject || '');
const isUpdated = (m) => /\[UPDATED\]/i.test(m.Subject || '');

// Longer-window stabilization poll (prelim gen ~70s; window 60s, max 210s).
const waitStable = async (dealId, label) => {
  const start = Date.now(), max = 210000, win = 60000;
  let last = -1, lastChange = Date.now(), out = [];
  while (Date.now() - start < max) {
    await sleep(5000);
    try { out = await fetchOutboundFromSupabase(s, dealId); } catch (e) {}
    if (out.length !== last) { last = out.length; lastChange = Date.now(); console.log(`    [${label}] outbound → ${last} @ ${((Date.now() - start) / 1000).toFixed(0)}s`); }
    else if (Date.now() - lastChange >= win) break;
  }
  return out;
};
const buildAtts = async (docrows) => {
  const out = [];
  for (const d of docrows) {
    const { data: blob } = await s.storage.from('documents').download(d.storage_path);
    const buf = Buffer.from(await blob.arrayBuffer());
    out.push({ Name: d.file_name, ContentType: 'application/pdf', Content: buf.toString('base64'), ContentLength: buf.length });
  }
  return out;
};

(async () => {
  const { data: deals } = await s.from('deals').select('id,email').like('email', 'franco@vimarealty.com').order('created_at', { ascending: false }).limit(20);
  // source = the real Daniel Kim deal
  const { data: srcDeals } = await s.from('deals').select('id').order('created_at', { ascending: false }).limit(30);
  const srcId = (srcDeals.find(d => d.id.startsWith('875af304')) || {}).id;
  const { data: msgs } = await s.from('messages').select('subject,body,created_at').eq('deal_id', srcId).eq('direction', 'inbound').order('created_at');
  const { data: docs } = await s.from('documents').select('file_name,storage_path,created_at').eq('deal_id', srcId).order('created_at');
  const turn1Re = /TD_Payout|PropertyTax|GovernmentID/i;
  const turn0Docs = docs.filter(d => !turn1Re.test(d.file_name));
  const turn1Docs = docs.filter(d => turn1Re.test(d.file_name));

  const tag = `pathb-${Date.now()}`;
  const from = `franco+${tag}@vimarealty.com`;
  const to = 'info@privatemortgagelink.com';
  console.log(`=== Daniel Kim Path B replay → deployed 699029a | from=${from} ===`);
  console.log(`turn0 docs: ${turn0Docs.map(d => d.file_name).join(', ')}`);
  console.log(`turn1 docs: ${turn1Docs.map(d => d.file_name).join(', ')}\n`);

  // TURN 0
  const intake = { From: from, FromName: 'Nathan Okafor', FromFull: { Email: from, Name: 'Nathan Okafor' }, To: to,
    Subject: msgs[0].subject || 'New File Submission — Daniel Kim', TextBody: msgs[0].body.replace(/<[^>]+>/g, ' '),
    HtmlBody: null, MessageID: `${tag}-t0@pathb.synthetic`, Date: new Date().toISOString(), Headers: [], Attachments: await buildAtts(turn0Docs) };
  console.log('[turn 0] POST intake'); await postToWebhook(intake);
  const deal = await pollForDeal(s, from, { timeoutMs: 90000 });
  console.log(`[turn 0] dealId=${deal.id}`);
  const out0 = await waitStable(deal.id, 'turn0');
  const prelims0 = out0.filter(isPrelim);
  console.log(`[turn 0] outbound=${out0.length}, PRELIM count=${prelims0.length}${prelims0.length ? ' (subj: ' + prelims0[0].Subject + ')' : ''}`);

  // TURN 1 (threaded to Vienna's last outbound)
  const prior = (await fetchOutboundFromSupabase(s, deal.id)).filter(m => m.external_message_id);
  const lastMid = prior.length ? prior[prior.length - 1].external_message_id : null;
  const clar = { From: from, FromName: 'Nathan Okafor', FromFull: { Email: from, Name: 'Nathan Okafor' }, To: to,
    Subject: `Re: ${msgs[0].subject || 'New File Submission — Daniel Kim'}`, TextBody: (msgs[1] ? msgs[1].body : 'Remaining docs attached. Exit strategy: refinance to conventional at maturity.').replace(/<[^>]+>/g, ' '),
    HtmlBody: null, MessageID: `${tag}-t1@pathb.synthetic`, Date: new Date().toISOString(),
    Headers: lastMid ? [{ Name: 'In-Reply-To', Value: `<${lastMid}>` }, { Name: 'References', Value: `<${lastMid}>` }] : [], Attachments: await buildAtts(turn1Docs) };
  console.log('\n[turn 1] POST continuation + 3 docs (threaded)'); await postToWebhook(clar);
  const out1 = await waitStable(deal.id, 'turn1');
  const prelims1 = out1.filter(isPrelim);

  // FINAL
  const { data: fresh } = await s.from('deals').select('*').eq('id', deal.id).single();
  const ed = fresh.extracted_data || {};
  console.log('\n=== RESULTS ===');
  console.log(`  total outbound: ${out1.length}`);
  console.log(`  total PRELIM outbounds across BOTH turns: ${prelims1.length}  ${prelims1.length === 1 ? '✓ (exactly one)' : prelims1.length > 1 ? '✗ DOUBLE PRELIM' : '✗ none'}`);
  console.log(`  any [UPDATED] prelim?: ${out1.some(isUpdated)}  ${out1.some(isUpdated) ? '✗ (Path B should suppress)' : '✓ (none)'}`);
  console.log(`  NEW prelims on turn 1 (after turn 0 had ${prelims0.length}): ${prelims1.length - prelims0.length}  ${prelims1.length - prelims0.length === 0 ? '✓ (turn-1 silent to admin)' : '✗'}`);
  console.log(`  deal final status: ${fresh.status}`);
  console.log(`  internal state — docs_received: ${JSON.stringify(ed.documents_received)}`);
  console.log(`  internal state — docs_still_needed: ${JSON.stringify(ed.documents_still_needed)}`);
  console.log('\n  all outbound:');
  for (const m of out1) console.log(`    [${m.created_at.slice(11, 19)}] ${isPrelim(m) ? '[PRELIM]' : '[broker]'} ${m.Subject}`);
})().catch(e => { console.error('REPLAY FAIL:', e); process.exit(1); });
