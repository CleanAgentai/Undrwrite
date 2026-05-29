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

// Poll Supabase for deal record by tagged broker email. Sub-phase 5.2
// patches:
//   1st (2026-05-27): switch to +tag email subaddressing per test-staging-e2e.js
//      precedent — MessageID storage was NULL on inbound rows
//   3rd (2026-05-28): two-stage polling — (a) wait for deal existence,
//      (b) wait for extracted_data populated (signals Vienna's async pipeline
//      completed extraction). Vienna processes async after webhook 202; full
//      pipeline 20-50s typical (pdf-parse + LLM extraction + canonical
//      resolution + outbound generation).
const pollForDeal = async (supabase, taggedEmail, opts = {}) => {
  const { timeoutMs = 90000, intervalMs = 2000, waitForExtraction = true } = opts;
  const deadline = Date.now() + timeoutMs;
  let dealRecord = null;
  // Stage 1: poll for deal existence
  while (Date.now() < deadline && !dealRecord) {
    const { data: deals } = await supabase
      .from('deals')
      .select('*')
      .eq('email', taggedEmail)
      .order('created_at', { ascending: false })
      .limit(1);
    if (deals && deals.length > 0) {
      dealRecord = deals[0];
      break;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  if (!dealRecord) {
    throw new Error(`pollForDeal stage-1 timeout — deal not created for '${taggedEmail}' after ${timeoutMs}ms`);
  }
  if (!waitForExtraction) return dealRecord;
  // Stage 2: poll for extracted_data populated (Vienna's async pipeline done)
  while (Date.now() < deadline) {
    const ed = dealRecord.extracted_data;
    // "Populated" = object with at least 3 keys (heuristic: borrower_name + something + something else)
    if (ed && typeof ed === 'object' && Object.keys(ed).length >= 3) {
      return dealRecord;
    }
    await new Promise(r => setTimeout(r, intervalMs));
    const { data: refetched } = await supabase.from('deals').select('*').eq('id', dealRecord.id).single();
    if (refetched) dealRecord = refetched;
  }
  // Return whatever we have (extraction may have failed; let assertion engine surface)
  return dealRecord;
};

// Tag broker email with +runTag subaddressing for deal isolation.
// Example: jason@mercerbrokerage.example.com → jason+bulletproof-C03-1234@mercerbrokerage.example.com
const tagBrokerEmail = (email, runTag) => {
  if (!email || !email.includes('@')) return email;
  const [local, domain] = email.split('@');
  // Strip any existing +tag from local part to avoid double-tagging
  const cleanLocal = local.split('+')[0];
  return `${cleanLocal}+${runTag}@${domain}`;
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

// Rewrite events for deal isolation:
//   - MessageID gets runTag prefix (for any future correlation; may be NULL'd
//     by Vienna's webhook handler — backup correlation only)
//   - From + FromFull rewritten with +runTag subaddressing (PRIMARY correlation
//     via deals.email exact-match)
const rewriteEventMessageIds = (events, runTag) => events.map((ev, i) => {
  const taggedFrom = tagBrokerEmail(ev.postmark.From, runTag);
  return {
    ...ev,
    postmark: {
      ...ev.postmark,
      MessageID: `${runTag}-event${i}@bulletproof.synthetic`,
      From: taggedFrom,
      FromFull: ev.postmark.FromFull ? { ...ev.postmark.FromFull, Email: taggedFrom } : undefined,
    },
  };
});

// Primary entry: replay one scenario end-to-end.
//   fixtureDir: absolute path to scenarios/{ID}-{slug}/
//   opts: { mockCapture?, timeoutSec?, verbose? }
//     mockCapture: skip live webhook + use injected state (for smoke-testing assertEngine)
// BATCH-11 Phase 1: poll a deal's outbound until the count is STABLE for
// STABILITY_WINDOW (or zero-floor for silent deals), capped at MAX_WAIT. Extracted
// from the former inline final-capture loop so it can ALSO run BETWEEN events —
// letting event i's pipeline settle before event i+1 posts (fixes premature-prelim
// + correction-as-second-deal). Returns the captured outbound array.
const pollForStableOutbound = async (supabase, dealId, opts = {}) => {
  const { verbose = false, scenarioId = '', label = 'final' } = opts;
  const stabilityWindowMs = Number(process.env.BULLETPROOF_STABILITY_WINDOW_MS || 40000);
  const maxWaitMs = Number(process.env.BULLETPROOF_MAX_WAIT_MS || 150000);
  const zeroFloorMs = Number(process.env.BULLETPROOF_ZERO_OUTBOUND_FLOOR_MS || 90000);
  const pollMs = 5000;
  const start = Date.now();
  const deadline = start + maxWaitMs;
  let outboundEmails = [];
  let lastCount = -1;
  let lastChangeAt = Date.now();
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    try {
      outboundEmails = await fetchOutboundFromSupabase(supabase, dealId);
    } catch (e) {
      if (verbose) console.warn(`[replay ${scenarioId}] fetchOutbound warning (${label}): ${e.message}`);
    }
    if (outboundEmails.length !== lastCount) {
      lastCount = outboundEmails.length;
      lastChangeAt = Date.now();
      if (verbose) console.log(`[replay ${scenarioId}] (${label}) outbound count → ${lastCount} @ ${((Date.now() - start) / 1000).toFixed(0)}s`);
    } else if (lastCount > 0 && (Date.now() - lastChangeAt) >= stabilityWindowMs) {
      if (verbose) console.log(`[replay ${scenarioId}] (${label}) outbound STABLE at ${lastCount} @ ${((Date.now() - start) / 1000).toFixed(0)}s`);
      break;
    } else if (lastCount === 0 && (Date.now() - start) >= zeroFloorMs) {
      if (verbose) console.log(`[replay ${scenarioId}] (${label}) zero outbound after floor — concluding`);
      break;
    }
  }
  return outboundEmails;
};

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
  // Per-event tagged email (used for pollForDeal correlation)
  const taggedFromEmail = taggedEvents[0]?.postmark?.From;
  let dealRecord = null;

  for (let i = 0; i < taggedEvents.length; i++) {
    const ev = taggedEvents[i];
    // Resolve attachment refs (inline base64 from documents/)
    const resolved = resolveAttachmentRefs(ev.postmark, fixtureDir);
    // BATCH-11 Phase 1: thread subsequent events (corrections/replies) to the
    // existing deal via In-Reply-To. Vienna's continuation lookup is PURELY
    // thread-based (webhook.js:2024 "No thread match = new deal") — without an
    // In-Reply-To header a correction spawns a SECOND deal (the premature-prelim /
    // correction-as-second-deal root). Use Vienna's latest outbound MessageID on
    // the deal (settled by the prior inter-event poll); findByMessageId matches the
    // deal by ANY of its message IDs. Mirrors production "Re:" replies.
    if (i > 0 && dealRecord?.id) {
      try {
        const prior = await fetchOutboundFromSupabase(supabase, dealRecord.id);
        const withId = prior.filter(m => m.external_message_id);
        const latest = withId.length ? withId[withId.length - 1].external_message_id : null;
        if (latest) {
          const refs = withId.map(m => `<${m.external_message_id}>`).join(' ');
          resolved.Headers = [
            ...((resolved.Headers || []).filter(h => !/^(In-Reply-To|References)$/i.test(h.Name))),
            { Name: 'In-Reply-To', Value: `<${latest}>` },
            { Name: 'References', Value: refs },
          ];
          if (verbose) console.log(`[replay ${scenario.id}] event ${i} threaded via In-Reply-To <${latest}>`);
        } else if (verbose) {
          console.warn(`[replay ${scenario.id}] event ${i}: no prior outbound MessageID to thread to`);
        }
      } catch (e) {
        if (verbose) console.warn(`[replay ${scenario.id}] event ${i} threading warning: ${e.message}`);
      }
    }
    if (verbose) console.log(`[replay ${scenario.id}] event ${i} (${ev.kind}) → POST webhook (from=${resolved.From})`);
    await postToWebhook(resolved);
    // Poll for deal after first event via +tag email correlation
    if (i === 0) {
      try {
        dealRecord = await pollForDeal(supabase, taggedFromEmail, { timeoutMs: timeoutSec * 1000 });
        if (verbose) console.log(`[replay ${scenario.id}] dealId=${dealRecord.id} email=${dealRecord.email}`);
      } catch (e) {
        if (verbose) console.warn(`[replay ${scenario.id}] pollForDeal warning: ${e.message}`);
      }
    }
    // Inter-event poll-for-stable (BATCH-11 Phase 1): Vienna's async pipeline
    // (~30-50s) must COMPLETE for event i before event i+1 posts — otherwise a
    // broker correction (event 1) races event 0's still-running prelim render
    // → the correction's dedup can't find the still-forming deal (creates a 2nd
    // deal) AND the post-correction canonical value never renders. Wait for event
    // i's outbound to STABILIZE on the known deal before posting i+1. Falls back
    // to a short fixed wait only if the deal isn't known yet.
    if (i < taggedEvents.length - 1) {
      if (dealRecord?.id) {
        await pollForStableOutbound(supabase, dealRecord.id, { verbose, scenarioId: scenario.id, label: `inter-event-${i}` });
      } else {
        await new Promise(r => setTimeout(r, Number(process.env.BULLETPROOF_INTER_EVENT_MS || 500)));
      }
    }
  }

  // Final state capture: re-fetch deal + outbound emails via deal_id correlation
  let finalDealState = dealRecord;
  if (dealRecord?.id) {
    const { data: refetched } = await supabase.from('deals').select('*').eq('id', dealRecord.id).single();
    if (refetched) finalDealState = refetched;
  }

  // Final-capture poll-for-stable (BATCH-11 Phase 1: now via the shared helper).
  let outboundEmails = [];
  if (finalDealState?.id) {
    outboundEmails = await pollForStableOutbound(supabase, finalDealState.id, { verbose, scenarioId: scenario.id, label: 'final' });
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
  tagBrokerEmail,
  advanceDealTime,
  triggerChaseCron,
  postToWebhook,
  pollForDeal,
  fetchOutboundFromSupabase,
  fetchOutboundEmails, // preserved per Q-S2-4 for potential future Postmark-side observation
  rewriteEventMessageIds,
};
