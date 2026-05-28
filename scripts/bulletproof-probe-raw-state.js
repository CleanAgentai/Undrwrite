#!/usr/bin/env node
// Diagnostic probe (Sub-phase 5.5): run a scenario and dump RAW persisted
// extracted_data + outbound render side-by-side. No assertions, no cleanup.
// Serves CLUSTER-2 (persist vs render) + CLUSTER-3 (actual persisted keys).
//
// Usage: node scripts/bulletproof-probe-raw-state.js <scenario-id> [--cleanup]

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { runScenario } = require('../test-fixtures/bulletproof/lib/replay');
const { cleanupRun } = require('../test-fixtures/bulletproof/lib/cleanupHelper');

const SCENARIOS_DIR = path.join(__dirname, '..', 'test-fixtures', 'bulletproof', 'scenarios');
const args = process.argv.slice(2);
const id = args.find(a => !a.startsWith('--'));
const doCleanup = args.includes('--cleanup');

const findDir = (sid) => {
  const m = fs.readdirSync(SCENARIOS_DIR).find(d => d === sid || d.startsWith(sid + '-'));
  if (!m) throw new Error(`no dir for ${sid}`);
  return path.join(SCENARIOS_DIR, m);
};

(async () => {
  const captured = await runScenario(findDir(id), { verbose: false });
  console.log(`\n===== PROBE ${id} (deal ${captured.dealId}) =====`);
  console.log(`\n--- PERSISTED extracted_data (all keys) ---`);
  const ed = captured.finalDealState?.extracted_data || {};
  for (const [k, v] of Object.entries(ed)) {
    console.log(`  ${k}: ${JSON.stringify(v)}`);
  }
  console.log(`\n--- deal scalar columns of interest ---`);
  const d = captured.finalDealState || {};
  for (const col of ['status', 'admin_controlled', 'prelim_approved_at', 'ltv_percent']) {
    if (col in d) console.log(`  ${col}: ${JSON.stringify(d[col])}`);
  }
  console.log(`\n--- OUTBOUND emails (${captured.outboundEmails.length}) — subject + body excerpt ---`);
  captured.outboundEmails.forEach((e, i) => {
    const body = (e.TextBody || e.HtmlBody || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log(`  [${i}] SUBJECT: ${e.Subject}`);
    console.log(`      BODY: ${body.slice(0, 600)}`);
  });

  if (doCleanup && captured.dealId) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    await cleanupRun(supabase, captured.runTag, { dealId: captured.dealId });
    console.log(`\n  [cleaned up ${captured.dealId}]`);
  } else {
    console.log(`\n  [NO cleanup — deal ${captured.dealId} left for re-inspection]`);
  }
  process.exit(0);
})().catch(e => { console.error('PROBE FATAL:', e); process.exit(1); });
