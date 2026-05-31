#!/usr/bin/env node
// BATCH-15 classifier — actual-vs-expected bucketing for the final verification re-run.
// Reads a fullmatrix-results-N.json and produces:
//   1. PASS / MISMATCH / ERROR totals
//   2. Per-mismatch decision-relevant extract (render status, ltv, combined, mpos, failing assertions)
//   3. Auto-bucketing into a/b/c with KNOWN-list anchoring; everything unexplained → (d)-candidate
//   4. Per-feature live-fire tallies from render markers
// Discipline: (d)-candidates are surfaced for manual empirical isolation, NOT auto-labelled bugs.
const path = require('path');
const fs = require('fs');

const file = process.argv[2] || 'test-fixtures/bulletproof/bulletproof-fullmatrix-results-4.json';
const d = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
const R = d.results;

// ── known anchors from Porter's step-5 buckets ──────────────────────────────
const KNOWN_A = ['F08'];                       // high-standalone-refi correctly escalates
const KNOWN_B = ['E07', 'F04', 'F13'];         // 2nd-mortgage genuinely-additive escalates
// non-Vienna known roots / prior-batch surfaces (not new findings)
const KNOWN_NONVIENNA = {
  'F25': 'known-residual: narrative-fab vector (layer-3 placeholder)',
};

const ESC_STATUSES = ['awaiting_collateral', 'under_review', 'escalated', 'needs_review', 'on_hold'];
const num = (v) => { if (v == null) return null; const m = String(v).match(/(\d+(?:\.\d+)?)\s*%/); return m ? Number(m[1]) : null; };

const short = (l) => l.replace('layer1_', '').replace('layer2_', '').replace('layer3_', '');
const failingAssertions = (r) => {
  const out = [];
  for (const layer of ['layer1_canonical', 'layer1_gates', 'layer2_outbound', 'layer3_pending']) {
    const arr = r[layer]; if (!Array.isArray(arr)) continue;
    for (const a of arr) if (a && a.status && a.status !== 'pass') out.push(`${short(layer)}:${a.field || a.check || a.id || '?'}=${a.status}`);
  }
  const wf = r.layer1_workflow;
  if (wf && wf.status && wf.status !== 'pass') out.push(`workflow:${wf.expected}->${wf.actual}`);
  return out;
};

const pass = R.filter(r => r.status === 'pass');
const errors = R.filter(r => r.status === 'error');
const mismatches = R.filter(r => r.status !== 'pass' && r.status !== 'error');

const id = (r) => (r.scenarioId || '').split('-')[0];

// ── bucketing ───────────────────────────────────────────────────────────────
const buckets = { a: [], b: [], c: [], surface: [], d: [] };
for (const r of mismatches) {
  const sid = id(r);
  const rd = r.render || {}; const sr = rd.snapshot_rows || {}; const ex = rd.extracted || {};
  const wf = r.layer1_workflow || {};
  const st = rd.status || wf.actual;
  // standalone: prefer snapshot ltv row; else compute from extracted loan/value (escalated scenarios render no snapshot)
  let standalone = num(sr.ltv);
  if (standalone == null && ex.requested_loan_amount && ex.property_value) standalone = Math.round(1000 * ex.requested_loan_amount / ex.property_value) / 10;
  const combined = num(sr.combined_ltv);
  const mpos = sr.mortgage_position;
  const escalates = ESC_STATUSES.includes(st);
  const fa = failingAssertions(r);
  const rec = { sid, evalStatus: r.status, wfExp: wf.expected, wfAct: wf.actual, renderStatus: st, standalone, combined, mpos, nFail: r.summary?.fail_count, failing: fa };

  // anchored knowns first
  if (KNOWN_A.includes(sid)) { buckets.a.push({ ...rec, why: 'known high-standalone-refi anchor' }); continue; }
  if (KNOWN_B.includes(sid)) { buckets.b.push({ ...rec, why: 'known 2nd-mortgage anchor' }); continue; }
  if (KNOWN_NONVIENNA[sid]) { buckets.d.push({ ...rec, why: KNOWN_NONVIENNA[sid], nonVienna: true }); continue; }

  // (a) high standalone refi escalates correctly
  if (escalates && standalone != null && standalone > 90) { buckets.a.push({ ...rec, why: `standalone ${standalone}%>90 + escalates` }); continue; }
  // (b) 2nd mortgage additive combined escalates correctly
  if (escalates && (mpos === '2nd' || mpos === 'second') && combined != null && combined > 90) { buckets.b.push({ ...rec, why: `2nd-mtg combined ${combined}%>90 + escalates` }); continue; }
  // (c) Q11 multi-applicant: detect via render markers / joint applicants present + classification assertion
  if (rd.snapshot_rows?.joint_applicants || /q11|guarantor|registered.owner|co.applicant/i.test(JSON.stringify(r.layer1_canonical || []))) {
    buckets.c.push({ ...rec, why: 'multi-applicant / Q11 classification surface' }); continue;
  }
  // routing CORRECT (workflow expected===actual) but other assertions fail → render/capture surface (non-Vienna root)
  if (wf.status === 'pass' || (wf.expected != null && wf.expected === wf.actual)) {
    buckets.surface.push({ ...rec, why: 'routing correct; render/capture-surface fail (non-Vienna)' }); continue;
  }
  // routing DIVERGED and not explained by a/b/c → (d) candidate for manual isolation
  buckets.d.push({ ...rec, why: 'ROUTING DIVERGED — needs manual isolation' });
}

console.log(`\n=== BATCH-15 CLASSIFY (${path.basename(file)}, head=${d.summary?.head}) ===`);
console.log(`TOTAL ${R.length} | PASS ${pass.length} | MISMATCH ${mismatches.length} | ERROR ${errors.length}`);
console.log(`status dist: ${JSON.stringify(R.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {}))}`);
if (errors.length) { console.log('\nERRORS:'); errors.forEach(r => console.log('  ', id(r), JSON.stringify(r.errors))); }

for (const k of ['a', 'b', 'c', 'surface', 'd']) {
  const label = { a: 'HIGH-STANDALONE-REFI-CORRECTLY-ESCALATES', b: 'SECOND-MORTGAGE-CORRECTLY-ESCALATES', c: 'Q11-MULTI-APPLICANT-CLASSIFICATION', surface: 'ROUTING-CORRECT / RENDER-CAPTURE-SURFACE (non-Vienna)', d: 'GENUINE-NEW-FINDINGS (d)-candidates [ROUTING DIVERGED]' }[k];
  console.log(`\n--- bucket ${k}: ${label} (${buckets[k].length}) ---`);
  buckets[k].forEach(x => console.log(`  ${x.sid.padEnd(5)} wf=${String(x.wfExp)}->${String(x.wfAct)} render=${String(x.renderStatus).padEnd(18)} std=${x.standalone} comb=${x.combined} mpos=${x.mpos} | ${x.why}${x.nonVienna ? ' [NON-VIENNA]' : ''}\n        fails: ${x.failing.slice(0, 6).join(' ; ')}`));
}

// ── per-feature live-fire tallies from render markers ───────────────────────
const m = (r) => (r.render && r.render.markers) || {};
const tally = (pred) => R.filter(r => r.render && pred(r)).length;
console.log('\n=== PER-FEATURE LIVE-FIRE (render-marker tallies across matrix) ===');
console.log('snapshot_present (prelim fired):', tally(r => r.render.snapshot_present));
console.log('Q5 corporate_borrower row:', tally(r => r.render.snapshot_rows?.corporate_borrower));
console.log('Q5 accountant_financials_ask:', tally(r => m(r).accountant_financials_ask));
console.log('Q8 joint_applicants row:', tally(r => r.render.snapshot_rows?.joint_applicants));
console.log('Q10 [UPDATED]/correction notice:', tally(r => m(r).q10_notice));
console.log('combined_ltv row (2nd-mtg/Bug-3):', tally(r => r.render.snapshot_rows?.combined_ltv));
console.log('decline_email (Q7/Q2):', tally(r => m(r).decline_email));
console.log('collateral_ask (high-LTV):', tally(r => m(r).collateral_ask));
console.log('payout_statement_ask:', tally(r => m(r).payout_statement_ask));
console.log('clarification_pending:', tally(r => m(r).clarification_pending));

console.log('\n=== OPERATIONAL ===');
console.log('cleanup:', JSON.stringify(d.summary?.cleanup));
console.log('duration_sec:', d.summary?.duration_sec, `(~${((d.summary?.duration_sec || 0) / 3600).toFixed(2)}h)`);
console.log('budget_estimate: $' + d.summary?.budget_estimate);
