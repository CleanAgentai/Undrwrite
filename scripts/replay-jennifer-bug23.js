// POST-DEPLOY verification (commit 35a34ed) — Jennifer Okafor Bug 2 + Bug 3 on deployed code.
// SELF-CONTAINED: email + document PDFs are embedded under scripts/fixtures/jennifer-bug23/
// (extracted once from the original deal f9a67d03 — run-on broker email, contaminated
// Credit_Bureau=PNW, title-case-needing address "47 Lozinski Drive"). No DB deal_id dependency
// — portable across database resets / staging environments. Submits under a FRESH sender
// (dedup-safe new deal), runs the assertions, then deletes the deal it created.
//   Turn 0: 4 intake docs (LoanApp, Appraisal, T4, Credit_Bureau) → prelim.
//     Verify: NO Loan Term row (Bug 2); Property Address title-case (Bug 3); Existing 1st
//     Mortgage Balance still TBD (intentional); classification callout fires; sections intact.
//   Turn 1: PNW (genuine new doc, no material change) → Path B must SUPPRESS [UPDATED].
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { postToWebhook, pollForDeal, fetchOutboundFromSupabase } = require('../test-fixtures/bulletproof/lib/replay');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const strip = (h) => (h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const FIX = path.join(__dirname, 'fixtures', 'jennifer-bug23');
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
  const turn0Docs = meta.docs.filter(d => !/PNW/i.test(d)); // LoanApp, Appraisal, T4, Credit_Bureau
  const turn1Docs = meta.docs.filter(d => /PNW/i.test(d));   // PNW

  const tag = `jen23-${Date.now()}`, from = `franco+${tag}@francomaione.com`, to = 'info@privatemortgagelink.com';
  const subj0 = meta.subject || 'New Mortgage File — Jennifer Okafor';
  console.log(`=== Jennifer Bug 2+3 self-contained replay → 35a34ed | from=${from} ===`);
  console.log(`turn0 docs: ${turn0Docs.join(', ')}\nturn1 docs: ${turn1Docs.join(', ')}\n`);

  let deal;
  try {
    await postToWebhook({ From: from, FromName: meta.fromName, FromFull: { Email: from, Name: meta.fromName }, To: to,
      Subject: subj0, TextBody: (meta.body || '').replace(/<[^>]+>/g, ' '), HtmlBody: null,
      MessageID: `${tag}-t0@jen23`, Date: new Date().toISOString(), Headers: [], Attachments: buildAtts(turn0Docs) });
    deal = await pollForDeal(s, from, { timeoutMs: 90000 });
    console.log(`dealId=${deal.id}`);
    const out0 = await waitStable(deal.id, 'turn0');
    const prelim = out0.find(m => /PRELIMINARY Review/i.test(m.Subject));
    const pbody = prelim ? (prelim.HtmlBody || prelim.TextBody || '') : '';
    const ptxt = strip(pbody);

    const _mid1 = await lastMid(deal.id);
    await postToWebhook({ From: from, FromName: meta.fromName, FromFull: { Email: from, Name: meta.fromName }, To: to,
      Subject: `Re: ${subj0}`, TextBody: 'Hi Vienna, attaching the PNW statement to complete the file. Marcus', HtmlBody: null,
      MessageID: `${tag}-t1@jen23`, Date: new Date().toISOString(),
      Headers: _mid1 ? [{ Name: 'In-Reply-To', Value: `<${_mid1}>` }, { Name: 'References', Value: `<${_mid1}>` }] : [], Attachments: buildAtts(turn1Docs) });
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
  } finally {
    if (deal && deal.id && !process.env.KEEP_DEAL) await cleanup(deal.id);
  }
})().catch(e => { console.error('REPLAY FAIL:', e); process.exit(1); });
