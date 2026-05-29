require('dotenv').config();
const path = require('path'), fs = require('fs');
const { runScenario } = require('../test-fixtures/bulletproof/lib/replay');
const { evaluate } = require('../test-fixtures/bulletproof/lib/assertEngine');
const { cleanupRun } = require('../test-fixtures/bulletproof/lib/cleanupHelper');
const { createClient } = require('@supabase/supabase-js');
(async () => {
  const prefix = process.argv[2];
  const root = path.join(__dirname, '../test-fixtures/bulletproof/scenarios');
  const dir = fs.readdirSync(root).find(d => d.startsWith(prefix));
  const expected = JSON.parse(fs.readFileSync(path.join(root, dir, 'expected.json'), 'utf8'));
  const captured = await runScenario(path.join(root, dir), { verbose: false });
  const r = evaluate({ scenarioId: prefix, expected, finalDealState: captured.finalDealState, outboundEmails: captured.outboundEmails });
  console.log(`\n===== ${prefix} status=${r.status} =====`);
  console.log('canonical:'); r.layer1_canonical.forEach(c => console.log(`  [${c.status}] ${c.field} — ${c.detail} (${c.normalization})`));
  console.log('outbound:'); r.layer2_outbound.forEach(o => console.log(`  [${o.status}] ${o.kind} fired=${o.fired_actual} — ${o.detail||''}`));
  if (r.layer1_workflow) console.log(`workflow: [${r.layer1_workflow.status}] ${r.layer1_workflow.expected} vs ${r.layer1_workflow.actual}`);
  try { const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    console.log('[cleanup]', JSON.stringify(await cleanupRun(sb, captured.runTag, { dealId: captured.finalDealState?.id }))); } catch(e){ console.error(e.message); }
})();
