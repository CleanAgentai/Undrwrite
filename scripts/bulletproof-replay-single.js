#!/usr/bin/env node
// Replay a single bulletproof scenario against staging Vienna.
//
// Usage:
//   node scripts/bulletproof-replay-single.js <scenario-id> [--no-cleanup] [--verbose] [--mock]
//
// Exit codes:
//   0 — pass
//   1 — fail
//   2 — error
//   3 — placeholder-pending
//   4 — architecture-amendment-candidate surfaced

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { runScenario } = require('../test-fixtures/bulletproof/lib/replay');
const { evaluate } = require('../test-fixtures/bulletproof/lib/assertEngine');
const { cleanupRun } = require('../test-fixtures/bulletproof/lib/cleanupHelper');

const SCENARIOS_DIR = path.join(__dirname, '..', 'test-fixtures', 'bulletproof', 'scenarios');

const args = process.argv.slice(2);
const flags = {
  cleanup: !args.includes('--no-cleanup'),
  verbose: args.includes('--verbose'),
  mock: args.includes('--mock'),
};
const scenarioArg = args.find(a => !a.startsWith('--'));
if (!scenarioArg) {
  console.error('Usage: bulletproof-replay-single.js <scenario-id> [--no-cleanup] [--verbose] [--mock]');
  process.exit(2);
}

const findFixtureDir = (id) => {
  const subdirs = fs.readdirSync(SCENARIOS_DIR);
  const match = subdirs.find(d => d === id || d.startsWith(id + '-'));
  if (!match) throw new Error(`scenario directory not found for id '${id}'`);
  return path.join(SCENARIOS_DIR, match);
};

(async () => {
  const fixtureDir = findFixtureDir(scenarioArg);
  console.log(`[bulletproof-replay-single] scenario=${scenarioArg} dir=${path.basename(fixtureDir)}`);

  let captured;
  try {
    const mockCapture = flags.mock ? { finalDealState: { extracted_data: {} }, outboundEmails: [] } : null;
    captured = await runScenario(fixtureDir, { verbose: flags.verbose, mockCapture });
    console.log(`  runTag=${captured.runTag} mode=${captured.mode} duration=${captured.executionDurationMs}ms`);
  } catch (e) {
    console.error(`  REPLAY ERROR: ${e.message}`);
    process.exit(2);
  }

  const result = evaluate(captured);
  console.log(`  status: ${result.status}`);
  console.log(`  assertions: ${result.summary.pass_count} pass / ${result.summary.fail_count} fail / ${result.summary.skip_count} skip / ${result.summary.total_assertions} total`);
  if (flags.verbose) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const r of result.layer1_canonical.filter(x => x.status === 'fail' || x.status === 'architecture_amendment_candidate')) {
      console.log(`    [L1.canonical ${r.status}] ${r.field}: ${r.detail}`);
    }
    for (const r of result.layer1_gates.filter(x => x.status === 'fail' || x.status === 'inference_unknown')) {
      console.log(`    [L1.gate ${r.status}] ${r.gate}: ${r.detail}`);
    }
    if (result.layer1_workflow && result.layer1_workflow.status === 'fail') {
      console.log(`    [L1.workflow fail] expected=${result.layer1_workflow.expected} actual=${result.layer1_workflow.actual}`);
    }
    for (const r of result.layer2_outbound.filter(x => x.status === 'fail')) {
      console.log(`    [L2.outbound fail] ${r.kind}: ${r.detail}`);
    }
  }

  if (flags.cleanup && captured.mode === 'live') {
    try {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { deletedDeals } = await cleanupRun(supabase, captured.runTag, { verbose: flags.verbose });
      console.log(`  cleanup: deleted ${deletedDeals} deal(s)`);
    } catch (e) {
      console.warn(`  cleanup warning: ${e.message}`);
    }
  }

  const exitCode = {
    pass: 0,
    fail: 1,
    error: 2,
    'placeholder-pending': 3,
    architecture_amendment_surfaced: 4,
    inference_unknown_present: 0, // treat as pass for now
  }[result.status] ?? 2;
  process.exit(exitCode);
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
