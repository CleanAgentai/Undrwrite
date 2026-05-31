#!/usr/bin/env node
// BATCH 15 — final faithful 125-scenario verification re-run against staging
// (8de2dad Franco-closure bundle: Bug1/2/3/3-ext/4/5 + Franco-9 + Q1-rule-refinement
//  + Q5-render + Q5-doc-ask + Q8-ext + Q10 + Q11-registered-property-owner + C01 + LIST-C).
// Superset of bulletproof-replay-batch.js: same select/cleanup/budget/continue-on-fail
// semantics, PLUS a compact raw-render capture per scenario so results-4.json carries the
// assertion-level data AND the Snapshot/Q5/Q8/Q10/Bug-3 render markers the per-feature
// live-fire tallies need. Sequential single pass. Self-cleans per scenario
// (cleanupRun: dealId + Phase-4 runTag-email sweep) + final sweep.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { runScenario } = require('../test-fixtures/bulletproof/lib/replay');
const { evaluate } = require('../test-fixtures/bulletproof/lib/assertEngine');
const { cleanupRun, listBulletproofDeals } = require('../test-fixtures/bulletproof/lib/cleanupHelper');
const { createClient } = require('@supabase/supabase-js');

const SCEN_DIR = path.join(__dirname, '..', 'test-fixtures', 'bulletproof', 'scenarios');
const OUT = path.join(__dirname, '..', 'test-fixtures', 'bulletproof', 'bulletproof-fullmatrix-results-4.json');
const BUDGET_CAP = Number(process.argv[2] || 60);
const PER_SCEN_EST = 0.25;

// ── compact raw-render capture ──────────────────────────────────────────────
const row = (body, label, t = 'string') => {
  const re = new RegExp('<strong>\\s*' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*</strong>\\s*([^<]+)', 'i');
  const m = re.exec(body || ''); if (!m) return null;
  const raw = m[1].trim();
  if (/^TBD/i.test(raw)) return 'TBD';
  if (t === 'money') { const mm = raw.match(/\$?([\d,]+)/); return mm ? Number(mm[1].replace(/,/g, '')) : raw; }
  return raw;
};
const captureRender = (cap) => {
  const emails = cap.outboundEmails || [];
  const allText = emails.map(e => (e.Subject || '') + '\n' + (e.HtmlBody || e.TextBody || '')).join('\n----\n');
  const snaps = emails.filter(e => /Deal Snapshot/i.test(e.HtmlBody || e.TextBody || ''));
  const snap = snaps.length ? (snaps[snaps.length - 1].HtmlBody || snaps[snaps.length - 1].TextBody || '') : '';
  const ed = cap.finalDealState?.extracted_data || {};
  return {
    status: cap.finalDealState?.status || null,
    outbound_count: emails.length,
    outbound_subjects: emails.map(e => e.Subject || ''),
    snapshot_present: !!snap,
    snapshot_rows: snap ? {
      loan: row(snap, 'Loan Amount Requested', 'money'),
      appraised_value: row(snap, 'Appraised Value', 'money'),
      ltv: row(snap, 'LTV'),
      mortgage_position: row(snap, 'Mortgage Position'),
      combined_ltv: /Combined LTV \(incl\. existing/i.test(snap) ? (row(snap, 'Combined LTV (incl. existing 1st)') || 'present') : null,
      joint_applicants: /<strong>\s*Joint Applicants\s*:/i.test(snap) ? (row(snap, 'Joint Applicants') || 'present') : null,
      corporate_borrower: /<strong>\s*Corporate borrower\s*:/i.test(snap) ? (row(snap, 'Corporate borrower') || 'present') : null,
      city_province: row(snap, 'City / Province'),
    } : null,
    markers: {
      q10_notice: /\[UPDATED\][^<\n]{0,60}correction|Prelim correction/i.test(allText),
      clarification_pending: /\(clarification pending\)/i.test(allText) || /BROKER CLARIFICATION PENDING/i.test(allText),
      decline_email: /out of scope|not.{0,10}Canadian jurisdiction|cannot.{0,10}process|declin/i.test(allText),
      collateral_ask: /additional collateral/i.test(allText),
      accountant_financials_ask: /accountant.{0,20}(prepared|financ)|Corporate Financial Statements/i.test(allText),
      payout_statement_ask: /current mortgage payout statement/i.test(allText),
      missing_doc_lines: /\[MISSING\]/.test(allText),
    },
    extracted: {
      requested_loan_amount: ed.requested_loan_amount ?? ed.loan_amount_requested ?? null,
      property_value: ed.property_value ?? null,
      is_purchase: ed.is_purchase ?? null,
      transaction_type: ed.transaction_type ?? null,
      joint_multi_borrower: ed.joint_multi_borrower ?? null,
      q10_renotified_fields: ed._q10_renotified_fields ?? null,
      collateral_override_at: ed.collateral_override_at ?? null,
    },
  };
};

(async () => {
  const all = fs.readdirSync(SCEN_DIR).filter(d => fs.statSync(path.join(SCEN_DIR, d)).isDirectory() && /^[A-F]\d/.test(d)).sort();
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  console.log(`[batch13] ${all.length} scenarios, budget-cap=$${BUDGET_CAP}, out=${path.basename(OUT)}`);
  const t0 = Date.now();
  const results = [];
  let budget = 0, cleaned = 0, cleanupFails = 0;

  for (let i = 0; i < all.length; i++) {
    const dir = all[i];
    const id = dir.split('-')[0];
    if (budget + PER_SCEN_EST > BUDGET_CAP) { console.warn(`[batch13] budget cap reached ($${budget.toFixed(2)}); halting at ${i}/${all.length}`); break; }
    let cap, result, render = null, cleanupOk = false;
    try {
      cap = await runScenario(path.join(SCEN_DIR, dir), { verbose: false, timeoutSec: 60 });
      result = evaluate(cap);
      render = captureRender(cap);
      budget += PER_SCEN_EST;
    } catch (e) {
      result = { scenarioId: id, status: 'error', errors: [e.message] };
      cap = null;
    }
    if (cap && supabase) {
      try { const c = await cleanupRun(supabase, cap.runTag, { dealId: cap.finalDealState?.id || cap.dealId, verbose: false }); cleanupOk = (c.deletedDeals || 0) > 0; if (cleanupOk) cleaned++; else cleanupFails++; }
      catch (e) { cleanupFails++; }
    }
    results.push({ ...result, render, cleanup_ok: cleanupOk });
    const el = Math.round((Date.now() - t0) / 1000);
    console.log(`[batch13] ${String(i + 1).padStart(3)}/${all.length} ${id.padEnd(5)} ${(result.status || '').padEnd(26)} pass=${result.summary?.pass_count || 0} fail=${result.summary?.fail_count || 0} clean=${cleanupOk} [${el}s $${budget.toFixed(2)}]`);
  }

  const summary = {
    total: results.length,
    by_status: results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {}),
    cleanup: { auto_cleaned: cleaned, cleanup_misses: cleanupFails, pct: results.length ? Math.round(100 * cleaned / results.length) : 0 },
    budget_estimate: budget,
    duration_sec: Math.round((Date.now() - t0) / 1000),
    head: '8de2dad',
  };
  fs.writeFileSync(OUT, JSON.stringify({ summary, results }, null, 2));
  console.log('\n[batch13] SUMMARY', JSON.stringify(summary, null, 1));

  // final sweep
  try { const remaining = await listBulletproofDeals(supabase); console.log(`[batch13] post-run sweep: ${remaining.length} bulletproof deals remaining`); if (remaining.length) console.log('  ids:', remaining.join(',')); }
  catch (e) { console.warn('sweep check err', e.message); }
  console.log(`[batch13] results → ${OUT}`);
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
