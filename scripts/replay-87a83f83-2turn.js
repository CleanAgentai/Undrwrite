#!/usr/bin/env node
// Post-deploy 2-turn staging replay of Franco's 87a83f83 (the silence-after-
// clarification deal) against the deployed crash fix (ad49b10). Reconstructs:
//   turn 0 — intake + 5 initial docs
//   turn 1 — broker clarification + 3 docs (Property Tax, Gov ID, RBC Payout)
// threaded to Vienna's turn-0 reply. Captures the full chain + final state.
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const { postToWebhook, pollForDeal, fetchOutboundFromSupabase } = require('../test-fixtures/bulletproof/lib/replay');

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Inline stabilization poll (replay.js's pollForStableOutbound is not exported).
const waitStableOutbound = async (dealId, { windowMs = 40000, maxMs = 150000, floorMs = 90000 } = {}) => {
  const start = Date.now();
  let last = -1, lastChange = Date.now(), out = [];
  while (Date.now() - start < maxMs) {
    await sleep(5000);
    try { out = await fetchOutboundFromSupabase(s, dealId); } catch (e) {}
    if (out.length !== last) { last = out.length; lastChange = Date.now(); console.log(`    outbound → ${last} @ ${((Date.now() - start) / 1000).toFixed(0)}s`); }
    else if (last > 0 && Date.now() - lastChange >= windowMs) break;
    else if (last === 0 && Date.now() - start >= floorMs) { console.log('    zero-outbound floor reached'); break; }
  }
  return out;
};

const buildAttachments = async (docrows) => {
  const out = [];
  for (const d of docrows) {
    const { data: blob } = await s.storage.from('documents').download(d.storage_path);
    const buf = Buffer.from(await blob.arrayBuffer());
    out.push({ Name: d.file_name, ContentType: 'application/pdf', Content: buf.toString('base64'), ContentLength: buf.length });
  }
  return out;
};

(async () => {
  const { data: deals } = await s.from('deals').select('id').eq('email', 'franco@francomaione.com').order('created_at', { ascending: false }).limit(1);
  const srcId = deals[0].id;
  const { data: msgs } = await s.from('messages').select('subject,body,created_at').eq('deal_id', srcId).eq('direction', 'inbound').order('created_at');
  const { data: docs } = await s.from('documents').select('file_name,storage_path,created_at,classification').eq('deal_id', srcId).order('created_at');
  // Split docs by turn: the clarification docs are Property Tax / Gov ID / RBC Payout (mortgage_statement)
  const turn1Names = /PropertyTax|GovernmentID|RBC_Payout/i;
  const turn0Docs = docs.filter(d => !turn1Names.test(d.file_name));
  const turn1Docs = docs.filter(d => turn1Names.test(d.file_name));

  const tag = `f1verify-${Date.now()}`;
  const from = `franco+${tag}@francomaione.com`;
  const to = 'info@privatemortgagelink.com';

  console.log(`=== 2-TURN REPLAY of ${srcId.slice(0, 8)} → deployed ad49b10 ===`);
  console.log(`tag From: ${from}`);
  console.log(`turn0 docs: ${turn0Docs.map(d => d.file_name).join(', ')}`);
  console.log(`turn1 docs: ${turn1Docs.map(d => d.file_name).join(', ')}\n`);

  // ---- TURN 0: intake ----
  const intake = {
    From: from, FromName: 'Franco Maione', FromFull: { Email: from, Name: 'Franco Maione' },
    To: to, Subject: msgs[0].subject || 'New Mortgage submission',
    TextBody: msgs[0].body.replace(/<[^>]+>/g, ' '), HtmlBody: null,
    MessageID: `${tag}-t0@f1.synthetic`, Date: new Date().toISOString(), Headers: [],
    Attachments: await buildAttachments(turn0Docs),
  };
  console.log('[turn 0] POST intake'); await postToWebhook(intake);
  const deal = await pollForDeal(s, from, { timeoutMs: 90000 });
  console.log(`[turn 0] dealId=${deal.id}`);
  const out0 = await waitStableOutbound(deal.id);
  console.log(`[turn 0] Vienna outbound: ${out0.length}`);
  const viennaReplyId = out0.filter(m => m.external_message_id).slice(-1)[0]?.external_message_id;
  console.log(`[turn 0] Vienna reply MessageID: ${viennaReplyId || '(none — cannot thread!)'}`);

  // ---- TURN 1: clarification + 3 docs, threaded ----
  const clarification = {
    From: from, FromName: 'Franco Maione', FromFull: { Email: from, Name: 'Franco Maione' },
    To: to, Subject: `Re: ${msgs[0].subject || 'New Mortgage submission'}`,
    TextBody: msgs[1].body.replace(/<[^>]+>/g, ' '), HtmlBody: null,
    MessageID: `${tag}-t1@f1.synthetic`, Date: new Date().toISOString(),
    Headers: viennaReplyId ? [{ Name: 'In-Reply-To', Value: `<${viennaReplyId}>` }, { Name: 'References', Value: `<${viennaReplyId}>` }] : [],
    Attachments: await buildAttachments(turn1Docs),
  };
  console.log('\n[turn 1] POST clarification + 3 docs (threaded)'); await postToWebhook(clarification);
  const out1 = await waitStableOutbound(deal.id, { floorMs: 100000 });
  console.log(`[turn 1] total outbound after clarification: ${out1.length} (was ${out0.length} after turn 0)`);

  // ---- FINAL STATE ----
  const { data: fresh } = await s.from('deals').select('*').eq('id', deal.id).single();
  const ed = fresh.extracted_data || {};
  console.log('\n=== FINAL DEAL STATE ===');
  console.log(`  status: ${fresh.status}`);
  console.log(`  ltv_percent: ${ed.ltv_percent}  loan: ${ed.loan_amount_requested}  position: ${ed.mortgage_position}`);
  console.log(`  unresolved_discrepancy: ${ed.unresolved_discrepancy}  identity_clash: ${ed.identity_clash}  name_collides_with_admin: ${ed.name_collides_with_admin}`);
  console.log(`  key_risks: ${JSON.stringify((ed.key_risks_or_notes || '').slice(0, 140))}`);

  const allOut = await fetchOutboundFromSupabase(s, deal.id);
  console.log(`\n=== ALL OUTBOUND (${allOut.length}) ===`);
  for (const m of allOut) {
    const text = (m.HtmlBody || m.TextBody || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const kind = /unable to proceed|exceeds our maximum/i.test(text) ? 'DECLINE'
      : /additional collateral/i.test(text) ? 'COLLATERAL-ASK'
      : /ACTION REQUIRED|PRELIMINARY/i.test(m.Subject || '') ? 'ADMIN-PRELIM'
      : /discrepancy|clarify|confirm which/i.test(text) ? 'CLARIFY/RE-ASK'
      : 'OTHER';
    const toAdmin = /privatemortgagelink\.com/i.test(''); // body doesn't carry recipient; infer by subject
    console.log(`  [${m.created_at.slice(11, 19)}] (${kind}) subj="${m.Subject}"`);
    console.log(`     ${text.slice(0, 200)}`);
  }

  console.log('\n=== TURN-1 RESPONSE? ===');
  console.log(out1.length > out0.length
    ? `  YES — ${out1.length - out0.length} new outbound after clarification (silence is FIXED). Classify above.`
    : `  NO new outbound after clarification — silence persists despite crash fix. Investigate.`);
})().catch(e => { console.error('REPLAY FAIL:', e); process.exit(1); });
