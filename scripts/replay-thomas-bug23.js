// POST-DEPLOY verification (commit 73b6489) — Bug 2 + Bug 3 on a fresh Thomas-shape deal.
// SELF-CONTAINED: email + document PDFs are embedded under scripts/fixtures/thomas-bug23/
// (extracted once from the original deal b38bc2a4). No DB deal_id dependency — portable across
// database resets / staging environments. The harness submits under a FRESH sender (dedup-safe
// new deal), runs the assertions, then deletes the deal it created (no DB artifacts left behind).
//   Turn 0: 4 intake docs (LoanApplication, Appraisal, T4, Credit_Bureau) → prelim.
//     Verify: Loan Purpose = clean canonical (Bug 2); NO broker-style closing (Bug 3);
//     T4-as-NOA classification callout still fires; all sections intact.
//   Turn 1: PNW (a genuine new doc, no material field change) → Path B must SUPPRESS [UPDATED].
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { postToWebhook, pollForDeal, fetchOutboundFromSupabase } = require('../test-fixtures/bulletproof/lib/replay');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const strip = (h) => (h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const FIX = path.join(__dirname, 'fixtures', 'thomas-bug23');
const meta = JSON.parse(fs.readFileSync(path.join(FIX, 'meta.json'), 'utf8'));
// Build attachments from on-disk PDFs (no storage download).
const buildAtts = (names) => names.map((name) => ({
  Name: name, ContentType: 'application/pdf',
  Content: fs.readFileSync(path.join(FIX, 'docs', name)).toString('base64'),
}));

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
const lastMid = async (id) => { const p = (await fetchOutboundFromSupabase(s, id)).filter(m => m.external_message_id); return p.length ? p[p.length - 1].external_message_id : null; };

// Remove every DB row + storage object this harness created for `dealId`.
const cleanup = async (dealId) => {
  try {
    const { data: docs } = await s.from('documents').select('storage_path').eq('deal_id', dealId);
    const paths = (docs || []).map(d => d.storage_path).filter(Boolean);
    if (paths.length) { try { await s.storage.from('documents').remove(paths); } catch (e) {} }
    await s.from('documents').delete().eq('deal_id', dealId);
    await s.from('messages').delete().eq('deal_id', dealId);
    try { await s.from('daily_summaries').delete().eq('deal_id', dealId); } catch (e) {}
    await s.from('deals').delete().eq('id', dealId);
    console.log(`  [cleanup] removed deal ${dealId} (${paths.length} storage objects + rows)`);
  } catch (e) { console.error(`  [cleanup] WARN: ${e.message}`); }
};

(async () => {
  const turn0Docs = meta.docs.filter(d => !/PNW/i.test(d)); // 4: LoanApp, Appraisal, T4, Credit_Bureau
  const turn1Docs = meta.docs.filter(d => /PNW/i.test(d));   // 1: PNW (doc-only completion)

  const tag = `tb23-${Date.now()}`, from = `franco+${tag}@francomaione.com`, to = 'info@privatemortgagelink.com';
  const subj0 = meta.subject || 'Mortgage File Submission — Thomas Bergqvist';
  console.log(`=== Bug 2+3 self-contained replay → 73b6489 | from=${from} ===`);
  console.log(`turn0 docs: ${turn0Docs.join(', ')}`);
  console.log(`turn1 docs: ${turn1Docs.join(', ')}\n`);

  let deal;
  try {
    // TURN 0
    await postToWebhook({ From: from, FromName: meta.fromName, FromFull: { Email: from, Name: meta.fromName }, To: to,
      Subject: subj0, TextBody: (meta.body || '').replace(/<[^>]+>/g, ' '), HtmlBody: null,
      MessageID: `${tag}-t0@tb23`, Date: new Date().toISOString(), Headers: [], Attachments: buildAtts(turn0Docs) });
    deal = await pollForDeal(s, from, { timeoutMs: 90000 });
    console.log(`dealId=${deal.id}`);
    const out0 = await waitStable(deal.id, 'turn0');
    const prelim = out0.find(m => /PRELIMINARY Review/i.test(m.Subject));
    const pbody = prelim ? (prelim.HtmlBody || prelim.TextBody || '') : '';
    const ptxt = strip(pbody);

    // TURN 1 — doc-only completion (PNW)
    const _mid1 = await lastMid(deal.id);
    await postToWebhook({ From: from, FromName: meta.fromName, FromFull: { Email: from, Name: meta.fromName }, To: to,
      Subject: `Re: ${subj0}`, TextBody: 'Hi Vienna, attaching the PNW statement to complete the file. Rosa', HtmlBody: null,
      MessageID: `${tag}-t1@tb23`, Date: new Date().toISOString(),
      Headers: _mid1 ? [{ Name: 'In-Reply-To', Value: `<${_mid1}>` }, { Name: 'References', Value: `<${_mid1}>` }] : [], Attachments: buildAtts(turn1Docs) });
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
    if (prelim && prelim.external_message_id) {
      const j = await (await fetch('https://api.postmarkapp.com/messages/outbound/' + prelim.external_message_id + '/details', { headers: { 'X-Postmark-Server-Token': process.env.POSTMARK_API_TOKEN, Accept: 'application/json' } })).json();
      console.log(`\n  Postmark admin prelim: To=${(j.Recipients || []).join(',')} Status=${j.Status} Events=${JSON.stringify((j.MessageEvents || []).map(e => e.Type))}`);
    }
    console.log(`\n  dealId=${deal.id}`);
  } finally {
    if (deal && deal.id && !process.env.KEEP_DEAL) await cleanup(deal.id);
  }
})().catch(e => { console.error('REPLAY FAIL:', e); process.exit(1); });
