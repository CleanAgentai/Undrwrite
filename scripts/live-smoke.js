#!/usr/bin/env node
// Live smoke test against the deployed Vienna (Fly). Replays one bulletproof
// scenario's events with the broker From rewritten to a Postmark blackhole
// address (accepted + discarded, no bounce), then reads back what Vienna did:
// the deal row and every outbound message (Supabase), plus Postmark's own
// outbound log for the same recipients.
//
// Usage: node scripts/live-smoke.js [SCENARIO_ID=D02-standard-prelim-review-control] [--keep]
// The test deal is deleted afterwards unless --keep is passed.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { postToWebhook, pollForDeal, fetchOutboundFromSupabase } = require('../test-fixtures/bulletproof/lib/replay');
const { resolveAttachmentRefs } = require('../test-fixtures/bulletproof/lib/emailSynth');

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const scenario = args.find(a => !a.startsWith('--')) || 'D02-standard-prelim-review-control';
const dir = path.join(__dirname, '..', 'test-fixtures', 'bulletproof', 'scenarios', scenario);
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const runTag = `smoke${Date.now()}`;
  const broker = `broker+${runTag}@blackhole.postmarkapp.com`;
  const events = JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8'));
  let dealId = null;
  for (const ev of events) {
    if (Number(ev.delayFromPreviousMs) > 0) await sleep(Number(ev.delayFromPreviousMs));
    const payload = resolveAttachmentRefs(JSON.parse(JSON.stringify(ev.postmark)), dir);
    if (ev.kind && !/admin/i.test(ev.kind)) payload.From = broker;
    payload.MessageID = `${runTag}-${ev.sequenceIndex}`;
    const res = await postToWebhook(payload);
    console.log(`event ${ev.sequenceIndex} (${ev.kind}) → HTTP ${res.status}`);
    if (!dealId) {
      const d = await pollForDeal(s, broker, { timeoutMs: 180000, waitForExtraction: true });
      if (!d) throw new Error('no deal created within 180s');
      dealId = d.id;
    }
  }
  // Wait until Vienna goes quiet: the prelim (LLM summary + zip) takes 1-2 min after
  // the welcome. Settled = outbound count unchanged for 150s (cap 6 min).
  let lastCount = -1, stableSince = Date.now();
  for (const deadline = Date.now() + 360000; Date.now() < deadline; await sleep(5000)) {
    const n = (await fetchOutboundFromSupabase(s, dealId)).length;
    if (n !== lastCount) { lastCount = n; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= 150000) break;
  }
  const { data: deal } = await s.from('deals').select('id,status,ltv,borrower_name,extracted_data').eq('id', dealId).single();
  const outbound = await fetchOutboundFromSupabase(s, dealId);
  console.log(`\nDEAL ${deal.id} status=${deal.status} ltv=${deal.ltv} borrower=${deal.borrower_name}`);
  for (const m of outbound) console.log(`  OUT ${m.created_at || ''} ${m.Subject || m.subject}`);

  // Delivery check at the provider: Resend (list recent sends) or Postmark (outbound search).
  if ((process.env.EMAIL_PROVIDER_CHECK || 'resend') === 'resend' && process.env.RESEND_API_KEY) {
    const list = await fetch('https://api.resend.com/emails?limit=100', { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } }).then(r => r.json());
    const mine = (list.data || []).filter(e => [].concat(e.to || []).some(t => t.toLowerCase() === broker.toLowerCase() || /blackhole/.test(t)) && new Date(e.created_at) > new Date(Date.now() - 15 * 60000));
    console.log(`\nResend sends (last 15 min, test addresses): ${mine.map(e => `${e.last_event}:${(e.subject || '').slice(0, 60)}`).join(' | ') || 'none'}`);
  }

  if (!keep) {
    await s.from('messages').delete().eq('deal_id', dealId);
    await s.from('documents').delete().eq('deal_id', dealId);
    await s.from('deals').delete().eq('id', dealId);
    console.log(`cleaned up deal ${dealId}`);
  }
})().catch((e) => { console.error('SMOKE FAILED:', e.message); process.exit(1); });
