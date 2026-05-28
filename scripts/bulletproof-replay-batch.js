#!/usr/bin/env node
// Replay a batch of bulletproof scenarios (sample or full matrix).
//
// Usage:
//   node scripts/bulletproof-replay-batch.js [--sample | --full] [--scenarios B01,C03] [--include-layer-3-placeholders] [--budget-cap 50] [--output results.json] [--continue-on-fail]
//
// Sample mode (default 10 scenarios per Phase 5 Q6): 3 Group B + 2 Group C +
// 2 Group D + 2 Group A + 1 Group F (F25).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { runScenario } = require('../test-fixtures/bulletproof/lib/replay');
const { evaluate } = require('../test-fixtures/bulletproof/lib/assertEngine');
const { cleanupRun } = require('../test-fixtures/bulletproof/lib/cleanupHelper');

const SCENARIOS_DIR = path.join(__dirname, '..', 'test-fixtures', 'bulletproof', 'scenarios');

const SAMPLE_SCENARIOS = [
  'B01-discrepancyHold-active-major-loan-amount',
  'B04-preliminary-dispatch-fires',
  'B06-awaiting-collateral-activated',
  'C01-admin-handoff-intake',
  'C03-broker-initial-intent-new-deal',
  'D01-high-ltv-collateral-ask',
  'D03-elevated-ltv-callout',
  'A01-loan-amount-broker-correction-wins',
  'A07-loan-amount-page-annotation-with-broker-source',
  'F25-llm-narrative-fab-vector',
];

const parseArgs = (argv) => {
  const out = { mode: null, scenarios: null, includeLayer3: false, budgetCap: 50, output: null, continueOnFail: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sample') out.mode = 'sample';
    else if (a === '--full') out.mode = 'full';
    else if (a === '--scenarios') { out.mode = 'explicit'; out.scenarios = argv[++i].split(','); }
    else if (a === '--include-layer-3-placeholders') out.includeLayer3 = true;
    else if (a === '--budget-cap') out.budgetCap = parseFloat(argv[++i]);
    else if (a === '--output') out.output = argv[++i];
    else if (a === '--continue-on-fail') out.continueOnFail = true;
  }
  if (!out.mode) out.mode = 'sample';
  return out;
};

const opts = parseArgs(process.argv.slice(2));

const selectScenarios = () => {
  if (opts.mode === 'sample') return SAMPLE_SCENARIOS;
  if (opts.mode === 'explicit') return opts.scenarios.map(id => {
    const subdirs = fs.readdirSync(SCENARIOS_DIR);
    return subdirs.find(d => d === id || d.startsWith(id + '-'));
  }).filter(Boolean);
  // full
  return fs.readdirSync(SCENARIOS_DIR).filter(d => /^[A-F]\d/.test(d)).sort();
};

const filterByLayer3 = (scenarioDirs) => {
  if (opts.includeLayer3) return scenarioDirs;
  // Filter OUT scenarios with non-empty layer3_pending_decisions
  return scenarioDirs.filter(dir => {
    const expectedPath = path.join(SCENARIOS_DIR, dir, 'expected.json');
    if (!fs.existsSync(expectedPath)) return true;
    try {
      const exp = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
      return !exp.layer3_pending_decisions || exp.layer3_pending_decisions.length === 0;
    } catch { return true; }
  });
};

(async () => {
  let scenarios = selectScenarios();
  scenarios = filterByLayer3(scenarios);
  console.log(`[bulletproof-replay-batch] mode=${opts.mode} scenarios=${scenarios.length} budget-cap=$${opts.budgetCap}`);

  if (scenarios.length === 0) {
    console.error('no scenarios selected');
    process.exit(2);
  }

  const supabase = process.env.SUPABASE_URL ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY) : null;

  const results = [];
  let cumulativeBudget = 0;
  const PER_SCENARIO_COST_EST = 0.25; // ~$0.25 per scenario heuristic

  for (const dir of scenarios) {
    const fixtureDir = path.join(SCENARIOS_DIR, dir);
    if (cumulativeBudget + PER_SCENARIO_COST_EST > opts.budgetCap) {
      console.warn(`[batch] budget cap reached ($${cumulativeBudget.toFixed(2)} / $${opts.budgetCap}); halting`);
      break;
    }
    console.log(`[batch] running ${dir}...`);
    let captured, result;
    try {
      captured = await runScenario(fixtureDir, { verbose: false, timeoutSec: 60 });
      result = evaluate(captured);
      cumulativeBudget += PER_SCENARIO_COST_EST;
    } catch (e) {
      result = { scenarioId: dir, status: 'error', errors: [e.message] };
      captured = null;
    }
    results.push(result);
    console.log(`  → ${result.status} (pass=${result.summary?.pass_count || 0} fail=${result.summary?.fail_count || 0})`);

    if (captured && supabase) {
      try { await cleanupRun(supabase, captured.runTag, { verbose: false, dealId: captured.dealId }); } catch (e) { console.warn(`  cleanup warning: ${e.message}`); }
    }

    if (result.status === 'fail' && !opts.continueOnFail) {
      console.warn('[batch] halting on first failure (use --continue-on-fail to override)');
      break;
    }
  }

  const summary = {
    total: results.length,
    by_status: results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {}),
    cumulative_budget_estimate: cumulativeBudget,
  };
  console.log('\n[batch] SUMMARY:', JSON.stringify(summary, null, 2));

  const outputPath = opts.output || path.join(process.cwd(), `bulletproof-results-${Date.now()}.json`);
  fs.writeFileSync(outputPath, JSON.stringify({ summary, results, opts }, null, 2));
  console.log(`[batch] results written to ${outputPath}`);

  const exitCode = (summary.by_status.fail || summary.by_status.error) ? 1 : 0;
  process.exit(exitCode);
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
