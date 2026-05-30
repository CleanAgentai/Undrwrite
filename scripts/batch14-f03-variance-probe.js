#!/usr/bin/env node
// BATCH-14 Track-2 — F03 non-determinism characterization. Run F03 N times, capture
// status + loan extraction + escalation each run. Self-cleans.
require('dotenv').config();
const path = require('path');
const { runScenario } = require('../test-fixtures/bulletproof/lib/replay');
const { cleanupRun } = require('../test-fixtures/bulletproof/lib/cleanupHelper');
const { createClient } = require('@supabase/supabase-js');
(async () => {
  const N = Number(process.argv[2] || 5);
  const dir = path.join(__dirname, '../test-fixtures/bulletproof/scenarios/F03-corporate-refi-65ltv');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const runs = [];
  for (let i = 0; i < N; i++) {
    let cap;
    try { cap = await runScenario(dir, { verbose: false }); } catch (e) { console.log(`run ${i+1}: ERROR ${e.message}`); continue; }
    const emails = cap.outboundEmails || [];
    const snap = emails.find(e => /Deal Snapshot/i.test(e.HtmlBody||e.TextBody||''));
    const ed = cap.finalDealState?.extracted_data || {};
    const prelim = emails.some(e => /PRELIMINARY|ACTION REQUIRED/i.test(e.Subject||''));
    const ltvSub = (emails.find(e=>/LTV/i.test(e.Subject||''))?.Subject||'').match(/([\d.]+)% LTV/);
    const r = { status: cap.finalDealState?.status, prelim, outbound: emails.length, ed_loan: ed.requested_loan_amount ?? null, snap: !!snap, ltv: ltvSub?ltvSub[1]:null };
    runs.push(r);
    console.log(`run ${String(i+1)}: status=${(r.status||'?').padEnd(20)} prelim=${prelim} outbound=${r.outbound} ed_loan=${r.ed_loan} subjLTV=${r.ltv}`);
    try { await cleanupRun(sb, cap.runTag, { dealId: cap.finalDealState?.id }); } catch {}
  }
  const esc = runs.filter(r=>r.status==='awaiting_collateral').length;
  const act = runs.filter(r=>r.status==='active').length;
  console.log(`\n[F03 variance] ${runs.length} runs: escalated=${esc} active=${act} → ${esc&&act?'SPLIT (non-deterministic)':esc?'always-escalated':'always-active'}`);
})();
