// Phase 1 confirmation replay: does the material-change [UPDATED] prelim reproduce
// the placeholder body? Turn 0 fires the initial prelim; turn 1 = a loan-amount
// correction + a doc → routes to 'preliminary-update' with a Q10 material delta →
// Path B fires the [UPDATED] full prelim. Inspect that body for the placeholder.
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const { postToWebhook, pollForDeal, fetchOutboundFromSupabase } = require('../test-fixtures/bulletproof/lib/replay');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PLACEHOLDER = /Full preliminary review content with deal snapshot/i;
const waitStable = async (dealId, label) => {
  const start = Date.now(); let last = -1, lastChange = Date.now(), out = [];
  while (Date.now() - start < 220000) {
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
  const srcId = srcDeals.find(d => d.id.startsWith('875af304')).id;
  const { data: msgs } = await s.from('messages').select('subject,body').eq('deal_id', srcId).eq('direction', 'inbound').order('created_at');
  const { data: docs } = await s.from('documents').select('file_name,storage_path').eq('deal_id', srcId).order('created_at');
  const turn1Re = /TD_Payout|PropertyTax|GovernmentID/i;
  const turn0Docs = docs.filter(d => !turn1Re.test(d.file_name));
  const turn1Doc = docs.filter(d => /PropertyTax/i.test(d.file_name)); // ONE doc → hasNewDocs=true

  const tag = `bug3-${Date.now()}`, from = `franco+${tag}@vimarealty.com`, to = 'info@privatemortgagelink.com';
  console.log(`=== Bug 3 material-change [UPDATED] replay → deployed | from=${from} ===\n`);

  // TURN 0
  await postToWebhook({ From: from, FromName: 'Nathan Okafor', FromFull: { Email: from, Name: 'Nathan Okafor' }, To: to,
    Subject: msgs[0].subject || 'New File Submission — Daniel Kim', TextBody: msgs[0].body.replace(/<[^>]+>/g, ' '), HtmlBody: null,
    MessageID: `${tag}-t0@bug3.synthetic`, Date: new Date().toISOString(), Headers: [], Attachments: await buildAtts(turn0Docs) });
  const deal = await pollForDeal(s, from, { timeoutMs: 90000 });
  console.log(`dealId=${deal.id}`);
  const out0 = await waitStable(deal.id, 'turn0');
  const prelim0 = out0.find(m => /PRELIMINARY Review/i.test(m.Subject));

  // TURN 1: loan-amount correction + 1 doc
  const prior = (await fetchOutboundFromSupabase(s, deal.id)).filter(m => m.external_message_id);
  const lastMid = prior.length ? prior[prior.length - 1].external_message_id : null;
  const corrBody = 'Hi Vienna,\n\nCorrection on the file: the requested loan amount should be $400,000, not $372,000 — the borrower increased the request. Updated property tax assessment attached.\n\nNathan Okafor\nBridgeview Mortgage Group';
  await postToWebhook({ From: from, FromName: 'Nathan Okafor', FromFull: { Email: from, Name: 'Nathan Okafor' }, To: to,
    Subject: `Re: ${msgs[0].subject || 'New File Submission — Daniel Kim'}`, TextBody: corrBody, HtmlBody: null,
    MessageID: `${tag}-t1@bug3.synthetic`, Date: new Date().toISOString(),
    Headers: lastMid ? [{ Name: 'In-Reply-To', Value: `<${lastMid}>` }, { Name: 'References', Value: `<${lastMid}>` }] : [], Attachments: await buildAtts(turn1Doc) });
  console.log('[turn 1] POST loan-amount correction ($372k→$400k) + 1 doc');
  const out1 = await waitStable(deal.id, 'turn1');
  const updated = out1.find(m => /\[UPDATED\]/i.test(m.Subject) && /PRELIMINARY/i.test(m.Subject));

  // RESULTS
  console.log('\n=== RESULTS ===');
  const b0 = prelim0 ? (prelim0.HtmlBody || prelim0.TextBody || '') : '';
  const b1 = updated ? (updated.HtmlBody || updated.TextBody || '') : '';
  console.log(`  TURN 0 prelim fired: ${!!prelim0}`);
  console.log(`    turn-0 body head: ${b0.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 180)}`);
  console.log(`    turn-0 has placeholder: ${PLACEHOLDER.test(b0)} (baseline — expect false, full content)`);
  console.log(`  TURN 1 [UPDATED] prelim fired: ${!!updated} (Path B material-change path) ${updated ? '— subj: ' + updated.Subject : ''}`);
  if (updated) {
    console.log(`    turn-1 [UPDATED] body head: ${b1.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 220)}`);
    console.log(`    >>> turn-1 [UPDATED] has PLACEHOLDER: ${PLACEHOLDER.test(b1)}`);
    console.log(`    turn-1 reflects corrected $400,000: ${/400,000|\$400/.test(b1)}`);
  } else {
    console.log('    (no [UPDATED] prelim fired — check whether the correction was detected as a material change)');
  }
  const allUpd = out1.filter(m => /\[UPDATED\]/i.test(m.Subject));
  console.log(`\n  VERDICT: ${updated ? (PLACEHOLDER.test(b1) ? 'PLACEHOLDER REPRODUCES on material-change [UPDATED] → fix needed' : 'full content renders → placeholder does NOT reproduce') : 'no material [UPDATED] fired — inconclusive (correction not detected?)'}`);
  console.log('  all outbound:'); out1.forEach(m => console.log(`    [${m.created_at.slice(11, 19)}] ${m.Subject}`));
})().catch(e => { console.error('REPLAY FAIL:', e); process.exit(1); });
