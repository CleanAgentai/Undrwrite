// Per-scenario replay execution loop. Stage 1.5 only per Phase 5 Q1:
// Vienna pipeline end-to-end via staging webhook + real Supabase + real LLM.
//
// Multi-event temporal handling per Q2: fast-forward to ~500ms between POSTs;
// cron-driven F4.CH chase fires via timestamp manipulation + runFollowUpReminders
// invocation. F2.AP / F2.PA gates are event-driven via admin-reply path (existing
// fixtures already exercise).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { resolveAttachmentRefs } = require('./emailSynth');

const STAGING_URL = process.env.STAGING_URL || 'https://undrwrite.onrender.com/webhook/inbound';
const POSTMARK_API_TOKEN = process.env.POSTMARK_API_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const POSTMARK_OUTBOUND_API = 'https://api.postmarkapp.com/messages/outbound';

// Tag deal isolation per Sub-phase 5.1 design
const buildRunTag = (scenarioId) => `bulletproof-${scenarioId}-${Date.now()}`;

// POST one Postmark payload to staging webhook
const postToWebhook = async (payload, fetchImpl = global.fetch) => {
  const res = await fetchImpl(STAGING_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`webhook POST failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return res;
};

// Poll Supabase for deal record matching this run's first MessageID
const pollForDeal = async (supabase, runTag, opts = {}) => {
  const { timeoutMs = 30000, intervalMs = 1000 } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data: msgs } = await supabase
      .from('messages')
      .select('deal_id, external_message_id')
      .ilike('external_message_id', `${runTag}%`)
      .limit(1);
    if (msgs && msgs.length > 0 && msgs[0].deal_id) {
      const { data: deal } = await supabase.from('deals').select('*').eq('id', msgs[0].deal_id).single();
      if (deal) return deal;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`pollForDeal timeout — runTag '${runTag}' not found after ${timeoutMs}ms`);
};

// PRIMARY: fetch outbound messages from Supabase by deal_id correlation.
// Sub-phase 5.2 machinery patch (2026-05-27): runTag-in-subject correlation
// did not work because Vienna's outbound emails are generated via aiService
// templates with deterministic subjects ("ACTION REQUIRED: PRELIMINARY
// Review — {borrower} — {ltv}% LTV") — they don't echo the inbound subject
// prefix. Empirical probe of Supabase messages table confirmed this.
// Deal_id is the durable correlation key.
//
// Returns array shaped for assertEngine matchEmail compatibility (Subject +
// TextBody + HtmlBody fields, even though Vienna stores HTML in single body
// column).
const fetchOutboundFromSupabase = async (supabase, dealId) => {
  const { data, error } = await supabase
    .from('messages')
    .select('id, deal_id, direction, subject, body, external_message_id, created_at')
    .eq('deal_id', dealId)
    .eq('direction', 'outbound')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`fetchOutboundFromSupabase: ${error.message}`);
  return (data || []).map(m => ({
    Subject: m.subject || '',
    TextBody: m.body || '',
    HtmlBody: m.body || '',
    external_message_id: m.external_message_id,
    created_at: m.created_at,
  }));
};

// PRESERVED (per Q-S2-4): Postmark API outbound fetch. Default replay path
// uses fetchOutboundFromSupabase (above); this helper retained as exported
// utility for potential future use cases where Postmark-side metadata
// (delivery status, opens, bounces) matters.
// CLOSURE CONDITION: if a future scenario needs Postmark-side outbound
// observation (e.g., bounce detection, delivery confirmation), this helper
// is available — but default Supabase correlation is preferred for assertion
// purposes.
const fetchOutboundEmails = async (runTag, opts = {}) => {
  const { sinceMinutes = 30 } = opts;
  const fromDate = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString();
  const url = `${POSTMARK_OUTBOUND_API}?count=50&offset=0&fromdate=${encodeURIComponent(fromDate)}`;
  const res = await global.fetch(url, {
    headers: { 'X-Postmark-Server-Token': POSTMARK_API_TOKEN, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Postmark outbound fetch: ${res.status}`);
  const json = await res.json();
  return (json.Messages || []).filter(m => {
    return (m.Subject || '').includes(runTag) ||
           (m.TextBody || '').includes(runTag) ||
           (m.HtmlBody || '').includes(runTag);
  });
};

// Cron-fast-forward: advance deal/messages timestamps + invoke chase
const advanceDealTime = async (supabase, dealId, hours) => {
  const newTimestamp = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  await supabase.from('messages').update({ created_at: newTimestamp }).eq('deal_id', dealId);
  await supabase.from('deals').update({ created_at: newTimestamp, updated_at: newTimestamp }).eq('id', dealId);
};

const triggerChaseCron = async () => {
  // R9-E factory pattern: require module does NOT register cron; just invoke runFollowUpReminders
  const { runFollowUpReminders } = require('../../../src/cron/dailySummary');
  return runFollowUpReminders();
};

// Rewrite event MessageIDs to scope under runTag for deal isolation
const rewriteEventMessageIds = (events, runTag) => events.map((ev, i) => ({
  ...ev,
  postmark: { ...ev.postmark, MessageID: `${runTag}-event${i}@bulletproof.synthetic` },
}));

// Primary entry: replay one scenario end-to-end.
//   fixtureDir: absolute path to scenarios/{ID}-{slug}/
//   opts: { mockCapture?, timeoutSec?, verbose? }
//     mockCapture: skip live webhook + use injected state (for smoke-testing assertEngine)
const runScenario = async (fixtureDir, opts = {}) => {
  const { mockCapture, timeoutSec = 60, verbose = false } = opts;
  const scenario = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'scenario.json'), 'utf8'));
  const events = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'events.json'), 'utf8'));
  const expectedPath = path.join(fixtureDir, 'expected.json');
  const expected = fs.existsSync(expectedPath) ? JSON.parse(fs.readFileSync(expectedPath, 'utf8')) : null;

  const runTag = buildRunTag(scenario.id);
  const startTime = Date.now();

  // Mock-capture path: skip live execution, use injected state for assertion testing
  if (mockCapture) {
    return {
      runTag,
      scenarioId: scenario.id,
      finalDealState: mockCapture.finalDealState || {},
      outboundEmails: mockCapture.outboundEmails || [],
      executionDurationMs: 0,
      mode: 'mock',
      expected,
      scenario,
    };
  }

  // Live execution path (Stage 1.5)
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !POSTMARK_API_TOKEN) {
    throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY / POSTMARK_API_TOKEN env vars');
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const taggedEvents = rewriteEventMessageIds(events, runTag);
  let dealRecord = null;

  for (let i = 0; i < taggedEvents.length; i++) {
    const ev = taggedEvents[i];
    // Resolve attachment refs (inline base64 from documents/)
    const resolved = resolveAttachmentRefs(ev.postmark, fixtureDir);
    // Sub-phase 5.2 patch: removed runTag subject injection. Correlation is
    // via deal_id (post-poll), not subject-string matching.
    if (verbose) console.log(`[replay ${scenario.id}] event ${i} (${ev.kind}) → POST webhook`);
    await postToWebhook(resolved);
    // Fast-forward delay (per Q2): ~500ms between POSTs (vs delayFromPreviousMs original)
    if (i < taggedEvents.length - 1) await new Promise(r => setTimeout(r, 500));
    // Poll for deal after first event
    if (i === 0) {
      try {
        dealRecord = await pollForDeal(supabase, runTag, { timeoutMs: timeoutSec * 1000 });
      } catch (e) {
        if (verbose) console.warn(`[replay ${scenario.id}] pollForDeal warning: ${e.message}`);
      }
    }
  }

  // Final state capture: re-fetch deal + outbound emails via deal_id correlation
  let finalDealState = dealRecord;
  if (dealRecord?.id) {
    const { data: refetched } = await supabase.from('deals').select('*').eq('id', dealRecord.id).single();
    if (refetched) finalDealState = refetched;
  }

  // Wait for Vienna to process + generate outbound
  await new Promise(r => setTimeout(r, 5000));

  let outboundEmails = [];
  if (finalDealState?.id) {
    try {
      // Sub-phase 5.2 patch: Supabase-by-deal-id correlation (replaces Postmark API polling)
      outboundEmails = await fetchOutboundFromSupabase(supabase, finalDealState.id);
    } catch (e) {
      if (verbose) console.warn(`[replay ${scenario.id}] fetchOutboundFromSupabase warning: ${e.message}`);
    }
  }

  const executionDurationMs = Date.now() - startTime;
  return {
    runTag,
    scenarioId: scenario.id,
    dealId: finalDealState?.id,
    finalDealState,
    outboundEmails,
    executionDurationMs,
    mode: 'live',
    expected,
    scenario,
  };
};

module.exports = {
  runScenario,
  buildRunTag,
  advanceDealTime,
  triggerChaseCron,
  postToWebhook,
  pollForDeal,
  fetchOutboundFromSupabase,
  fetchOutboundEmails, // preserved per Q-S2-4 for potential future Postmark-side observation
  rewriteEventMessageIds,
};
