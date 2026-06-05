// POST-DEPLOY verification (commit 73b6489) — Bug 2 + Bug 3 on a fresh Thomas-shape deal.
// Clones deal b38bc2a4's exact docs + run-on email body (which triggered Bug 2 and carries
// the T4-as-NOA file) under a FRESH sender address (dedup-safe new deal).
//   Turn 0: 4 intake docs (LoanApplication, Appraisal, T4, Credit_Bureau) → prelim.
//     Verify: Loan Purpose = clean canonical (Bug 2); NO broker-style closing (Bug 3);
//     T4-as-NOA classification callout still fires; all sections intact.
//   Turn 1: PNW (a genuine new doc, no material field change) → Path B must SUPPRESS [UPDATED].
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
  const srcId = srcDeals.find(d => d.id.startsWith('b38bc2a4')).id;
  const { data: msgs } = await s.from('messages').select('subject,body').eq('deal_id', srcId).eq('direction', 'inbound').order('created_at');
  const { data: docs } = await s.from('documents').select('file_name,storage_path').eq('deal_id', srcId).order('created_at');
  const turn0Docs = docs.filter(d => !/PNW/i.test(d.file_name)); // 4: LoanApp, Appraisal, T4, Credit_Bureau
  const turn1Docs = docs.filter(d => /PNW/i.test(d.file_name));   // 1: PNW (doc-only completion)

  const tag = `tb23-${Date.now()}`, from = `franco+${tag}@francomaione.com`, to = 'info@privatemortgagelink.com';
  const subj0 = msgs[0].subject || 'Mortgage File Submission — Thomas Bergqvist';
  console.log(`=== Bug 2+3 post-deploy replay → 73b6489 | from=${from} ===`);
  console.log(`turn0 docs: ${turn0Docs.map(d => d.file_name).join(', ')}`);
  console.log(`turn1 docs: ${turn1Docs.map(d => d.file_name).join(', ')}\n`);

  // TURN 0
  await postToWebhook({ From: from, FromName: 'Rosa Marchand', FromFull: { Email: from, Name: 'Rosa Marchand' }, To: to,
    Subject: subj0, TextBody: (msgs[0].body || '').replace(/<[^>]+>/g, ' '), HtmlBody: null,
    MessageID: `${tag}-t0@tb23`, Date: new Date().toISOString(), Headers: [], Attachments: await buildAtts(turn0Docs) });
  const deal = await pollForDeal(s, from, { timeoutMs: 90000 });
  console.log(`dealId=${deal.id}`);
  const out0 = await waitStable(deal.id, 'turn0');
  const prelim = out0.find(m => /PRELIMINARY Review/i.test(m.Subject));
  const pbody = prelim ? (prelim.HtmlBody || prelim.TextBody || '') : '';
  const ptxt = strip(pbody);

  // TURN 1 — doc-only completion (PNW)
  const _mid1 = await lastMid(deal.id);
  await postToWebhook({ From: from, FromName: 'Rosa Marchand', FromFull: { Email: from, Name: 'Rosa Marchand' }, To: to,
    Subject: `Re: ${subj0}`, TextBody: 'Hi Vienna, attaching the PNW statement to complete the file. Rosa', HtmlBody: null,
    MessageID: `${tag}-t1@tb23`, Date: new Date().toISOString(),
    Headers: _mid1 ? [{ Name: 'In-Reply-To', Value: `<${_mid1}>` }, { Name: 'References', Value: `<${_mid1}>` }] : [], Attachments: await buildAtts(turn1Docs) });
  console.log('[turn 1] PNW posted (doc-only completion)');
  const out1 = await waitStable(deal.id, 'turn1');

  // ── RESULTS ──
  const prelims = out1.filter(m => /PRELIMINARY Review/i.test(m.Subject));
  const updated = out1.find(m => /\[UPDATED\]/i.test(m.Subject));
  const lpRaw = pbody.match(/Loan Purpose<\/h2>\s*<p>([^]*?)<\/p>/i);
  const tail = ptxt.slice(-260);

  console.log('\n=== RESULTS (deployed 73b6489) ===');
  console.log(`  [BUG 2] Loan Purpose (verbatim): ${lpRaw ? JSON.stringify(lpRaw[1].replace(/\s+/g, ' ').trim()) : '(not <p> form)'}`);
  console.log(`  [BUG 2] == clean canonical (no run-on/(matures): ${lpRaw ? !/Existing mortgage:|\(matures/i.test(lpRaw[1]) : 'n/a'}`);
  console.log(`  [BUG 3] closing present (Looking forward / Vienna sign-off): ${/Looking forward to hearing|Vienna<br>\s*Private Mortgage Link|Vienna \| Private Mortgage/i.test(pbody)} (expect false)`);
  console.log(`  [BUG 3] prelim tail: ...${tail}`);
  console.log(`  [T4 callout] present: ${/was provided as a Proof of Income[^]*?Notice of Assessment/i.test(ptxt)}`);
  console.log(`  [Path B] total prelims: ${prelims.length} (expect 1) | [UPDATED] at turn 1: ${!!updated} (expect false)`);
  console.log('  all outbound:'); out1.forEach(m => console.log(`    [${m.created_at.slice(11, 19)}] ${m.Subject}`));

  // Postmark
  const adminPrelim = prelim;
  if (adminPrelim && adminPrelim.external_message_id) {
    const j = await (await fetch('https://api.postmarkapp.com/messages/outbound/' + adminPrelim.external_message_id + '/details', { headers: { 'X-Postmark-Server-Token': process.env.POSTMARK_API_TOKEN, Accept: 'application/json' } })).json();
    console.log(`\n  Postmark admin prelim: To=${(j.Recipients || []).join(',')} Status=${j.Status} Events=${JSON.stringify((j.MessageEvents || []).map(e => e.Type))}`);
  }
  console.log(`\n  dealId=${deal.id}`);
})().catch(e => { console.error('REPLAY FAIL:', e); process.exit(1); });
