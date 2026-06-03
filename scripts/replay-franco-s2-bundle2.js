// STEP 5 — Bundle 2 staging replay against DEPLOYED code (commit 3cbd82b).
// Faithful Franco completion flow on a fresh persona (Laura-Chen Scenario-2 shape),
// driving the AUTO-SEND completion path (sendCompletionHandoff = path 1):
//   Turn 0: intake (5 docs)                          → ack + prelim
//   Turn 1: remaining docs + EXIT STRATEGY (text)    → doc-only completion (Path B suppress)
//   Turn 2: admin APPROVED (From=adminEmail, threaded)→ prelim_approved_at; Vienna asks AML/PEP
//   Turn 3: AML + PEP forms                          → completion handoff
// Any admin draft-preview ("Reply SEND to confirm") is auto-confirmed by posting
// SEND from the admin address. Asserts the broker fixed-language closing, admin
// [File Complete] new wording + zip, sequencing, and Postmark delivery.
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const { postToWebhook, pollForDeal, fetchOutboundFromSupabase } = require('../test-fixtures/bulletproof/lib/replay');
const config = require('../src/config');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const adminEmail = config.adminEmail;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const stripT = (h) => (h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const buildAtts = async (rows) => {
  const out = [];
  for (const d of rows) { const { data: blob } = await s.storage.from('documents').download(d.storage_path); out.push({ Name: d.file_name, ContentType: 'application/pdf', Content: Buffer.from(await blob.arrayBuffer()).toString('base64') }); }
  return out;
};
const lastMid = async (dealId) => { const p = (await fetchOutboundFromSupabase(s, dealId)).filter(m => m.external_message_id); return p.length ? p[p.length - 1].external_message_id : null; };
const hdrs = (mid) => mid ? [{ Name: 'In-Reply-To', Value: `<${mid}>` }, { Name: 'References', Value: `<${mid}>` }] : [];
const waitFor = async (dealId, label, predicate, maxMs = 150000) => {
  const start = Date.now(); let out = [];
  while (Date.now() - start < maxMs) {
    await sleep(5000);
    try { out = await fetchOutboundFromSupabase(s, dealId); } catch (e) {}
    if (await predicate(out)) { console.log(`    [${label}] @ ${((Date.now() - start) / 1000).toFixed(0)}s (outbound=${out.length})`); return out; }
  }
  console.log(`    [${label}] TIMEOUT @ ${((Date.now() - start) / 1000).toFixed(0)}s (outbound=${out.length})`); return out;
};
// If the latest outbound is an admin draft preview, confirm it with SEND (from admin).
const sendDraftIfPresent = async (dealId, broker) => {
  const out = await fetchOutboundFromSupabase(s, dealId);
  const last = out[out.length - 1];
  const body = stripT(last && (last.HtmlBody || last.TextBody));
  if (/Reply SEND to confirm|Draft Email Preview/i.test(body)) {
    await postToWebhook({ From: adminEmail, FromName: 'Franco Maione', FromFull: { Email: adminEmail, Name: 'Franco Maione' }, To: 'info@privatemortgagelink.com',
      Subject: `Re: ${last.Subject}`, TextBody: 'SEND', HtmlBody: null, MessageID: `send-${Date.now()}@drive`,
      Date: new Date().toISOString(), Headers: hdrs(last.external_message_id), Attachments: [] });
    console.log(`    (admin draft preview detected → posted SEND)`);
    await sleep(15000);
    return true;
  }
  return false;
};

(async () => {
  const { data: srcDeals } = await s.from('deals').select('id').order('created_at', { ascending: false }).limit(60);
  const srcId = srcDeals.find(d => d.id.startsWith('9da89a81')).id;
  const { data: msgs } = await s.from('messages').select('subject,body').eq('deal_id', srcId).eq('direction', 'inbound').order('created_at');
  const { data: docs } = await s.from('documents').select('file_name,storage_path').eq('deal_id', srcId).order('created_at');
  const lateRe = /BMO_Payout|PropertyTax|GovernmentID|AML_Form|PEP_Form/i;
  const turn0Docs = docs.filter(d => !lateRe.test(d.file_name));
  const turn1Docs = docs.filter(d => /BMO_Payout|PropertyTax|GovernmentID/i.test(d.file_name));
  const amlpepDocs = docs.filter(d => /AML_Form|PEP_Form/i.test(d.file_name));

  const tag = `s2b2-${Date.now()}`, from = `franco+${tag}@francomaione.com`, to = 'info@privatemortgagelink.com';
  const subj0 = msgs[0].subject || 'New File Submission — Laura Chen';
  console.log(`=== Bundle 2 completion replay → DEPLOYED 3cbd82b | broker=${from} admin=${adminEmail} ===\n`);

  // TURN 0
  await postToWebhook({ From: from, FromName: 'Emily Strand', FromFull: { Email: from, Name: 'Emily Strand' }, To: to,
    Subject: subj0, TextBody: (msgs[0].body || '').replace(/<[^>]+>/g, ' '), HtmlBody: null,
    MessageID: `${tag}-t0@s2b2`, Date: new Date().toISOString(), Headers: [], Attachments: await buildAtts(turn0Docs) });
  const deal = await pollForDeal(s, from, { timeoutMs: 90000 });
  console.log(`dealId=${deal.id}`);
  let out = await waitFor(deal.id, 'turn0-prelim', o => o.some(m => /PRELIMINARY Review/i.test(m.Subject)));
  const prelim = out.find(m => /PRELIMINARY Review/i.test(m.Subject));

  // TURN 1 — remaining docs + EXIT STRATEGY
  await postToWebhook({ From: from, FromName: 'Emily Strand', FromFull: { Email: from, Name: 'Emily Strand' }, To: to,
    Subject: `Re: ${subj0}`, TextBody: 'Hi Vienna, the remaining documents are attached: BMO payout statement, property tax assessment, and government ID. The exit strategy is to refinance to a conventional mortgage at BMO maturity in January 2028; Laura has 12 years of stable employment and strong credit which should support conventional financing at renewal.\n\nEmily Strand', HtmlBody: null,
    MessageID: `${tag}-t1@s2b2`, Date: new Date().toISOString(), Headers: hdrs(await lastMid(deal.id)), Attachments: await buildAtts(turn1Docs) });
  console.log('[turn 1] remaining docs + exit strategy');
  await sleep(70000);

  // TURN 2 — admin APPROVED (threaded to prelim)
  await postToWebhook({ From: adminEmail, FromName: 'Franco Maione', FromFull: { Email: adminEmail, Name: 'Franco Maione' }, To: to,
    Subject: `Re: ${prelim.Subject}`, TextBody: 'APPROVED', HtmlBody: null,
    MessageID: `${tag}-t2@s2b2`, Date: new Date().toISOString(), Headers: hdrs(prelim.external_message_id), Attachments: [] });
  console.log('[turn 2] admin APPROVED');
  await waitFor(deal.id, 'approval', async () => { const { data: d } = await s.from('deals').select('prelim_approved_at').eq('id', deal.id).single(); return !!d.prelim_approved_at; });
  await sleep(8000);
  await sendDraftIfPresent(deal.id, from); // AML/PEP-ask may be a draft preview
  await waitFor(deal.id, 'amlpep-ask', o => o.some(m => /AML|PEP|Anti-Money|Politically/i.test((m.HtmlBody || '') + (m.TextBody || '') + m.Subject)));

  // TURN 3 — AML + PEP → completion handoff
  await postToWebhook({ From: from, FromName: 'Emily Strand', FromFull: { Email: from, Name: 'Emily Strand' }, To: to,
    Subject: `Re: ${subj0}`, TextBody: 'Hi Vienna, please find the AML and PEP forms attached.\n\nEmily Strand', HtmlBody: null,
    MessageID: `${tag}-t3@s2b2`, Date: new Date().toISOString(), Headers: hdrs(await lastMid(deal.id)), Attachments: await buildAtts(amlpepDocs) });
  console.log('[turn 3] AML + PEP forms → expect completion handoff');
  out = await waitFor(deal.id, 'completion', o => o.some(m => /\[File Complete\]|\[Conditions Fulfilled\]/i.test(m.Subject)));
  if (!out.some(m => /\[File Complete\]|\[Conditions Fulfilled\]/i.test(m.Subject))) { await sendDraftIfPresent(deal.id, from); out = await waitFor(deal.id, 'completion-2', o => o.some(m => /\[File Complete\]|\[Conditions Fulfilled\]/i.test(m.Subject))); }
  await sleep(8000);
  out = await fetchOutboundFromSupabase(s, deal.id);

  // ── INSPECT ──
  const adminInfo = out.find(m => /\[File Complete\]|\[Conditions Fulfilled\]/i.test(m.Subject));
  const aIdx = out.indexOf(adminInfo);
  const brokerClosing = aIdx >= 0 ? out.slice(aIdx + 1).find(m => /complete and submitted|further questions to Franco/i.test(stripT(m.HtmlBody || m.TextBody))) : null;
  const aBody = adminInfo ? stripT(adminInfo.HtmlBody || adminInfo.TextBody) : '(none)';
  const bBody = brokerClosing ? stripT(brokerClosing.HtmlBody || brokerClosing.TextBody) : '(none)';

  console.log('\n=== FULL OUTBOUND SEQUENCE ===');
  out.forEach((m, i) => console.log(`  ${i}. [${m.created_at.slice(11, 19)}] ${m.Subject}`));
  console.log('\n=== ADMIN [File Complete] ===\n  ' + aBody);
  console.log('\n=== BROKER CLOSING ===\n  ' + bBody);
  console.log('\n=== ASSERTIONS (deployed 3cbd82b) ===');
  console.log(`  [B1] broker = fixed language verbatim: ${/The file is now complete and submitted\. Please direct any further questions to Franco at franco@privatemortgagelink\.com\./.test(bBody)}`);
  console.log(`  [B2] broker NO snapshot/LTV/outreach/TBD: ${!/Deal Snapshot|Property Address|LTV|lender outreach|Loan Term|TBD/i.test(bBody)}`);
  console.log(`  [A1] admin NEW wording: ${/directed to you for further questions/.test(aBody) && /attached for lender submission/.test(aBody)}`);
  console.log(`  [A2] admin NO old R10-I framing: ${!/sent to the broker for lender submission/.test(aBody)}`);
  console.log(`  [S]  sequencing admin <= broker: ${adminInfo && brokerClosing ? new Date(adminInfo.created_at) <= new Date(brokerClosing.created_at) : 'n/a'}`);

  for (const [label, m] of [['BROKER closing', brokerClosing], ['ADMIN info', adminInfo]]) {
    if (!m || !m.external_message_id) { console.log(`  ${label}: no ext id`); continue; }
    const r = await fetch('https://api.postmarkapp.com/messages/outbound/' + m.external_message_id + '/details', { headers: { 'X-Postmark-Server-Token': process.env.POSTMARK_API_TOKEN, Accept: 'application/json' } });
    const j = await r.json();
    console.log(`  ${label}: To=${(j.Recipients || []).join(',')} Status=${j.Status} Attachments=${(j.Attachments || []).length} Events=${JSON.stringify((j.MessageEvents || []).map(e => e.Type))}`);
  }
  console.log(`\n  dealId=${deal.id}`);
})().catch(e => { console.error('REPLAY FAIL:', e); process.exit(1); });
