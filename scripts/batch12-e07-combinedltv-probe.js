#!/usr/bin/env node
// BATCH-12 Track-A probe — E07 (2nd mortgage) combined_ltv_computed gate.
// results-2.json showed inferred=false (Combined LTV row absent) but the spec
// expectation was non-boolean (skip). E06 proved the dataset is stale; confirm
// on deployed code whether the "Combined LTV (incl. existing 1st):" row renders.
require('dotenv').config();
const path = require('path');
const { runScenario } = require('../test-fixtures/bulletproof/lib/replay');
const { cleanupRun } = require('../test-fixtures/bulletproof/lib/cleanupHelper');
const { createClient } = require('@supabase/supabase-js');

(async () => {
  const fixtureDir = path.join(__dirname, '../test-fixtures/bulletproof/scenarios/E07-transaction-second-mortgage');
  let captured;
  try { captured = await runScenario(fixtureDir, { verbose: true }); }
  catch (e) { console.error('REPLAY ERROR:', e.message); process.exit(1); }

  const ed = captured.finalDealState?.extracted_data || {};
  console.log('\n===== E07 classification =====');
  console.log('  status:', captured.finalDealState?.status, ' mortgage_position:', ed.mortgage_position, ' existing_balance:', ed.existing_mortgage_balance);
  const emails = captured.outboundEmails || [];
  for (let i = 0; i < emails.length; i++) {
    const e = emails[i]; const body = e.HtmlBody || e.TextBody || '';
    const combHit = /Combined LTV \(incl\. existing/i.test(body);
    console.log(`\n  [${i}] subject="${e.Subject||''}"  combinedLtvRow=${combHit}`);
    if (combHit) {
      const m = /Combined LTV \(incl\. existing[^<]*<\/strong>\s*([^<]+)/i.exec(body);
      console.log('     row value:', m ? m[1].trim() : '(present, value parse failed)');
    }
    // also show the LTV / Appraised / Loan rows for context
    for (const lbl of ['Loan Amount Requested','Appraised Value','Mortgage Position','LTV']) {
      const mm = new RegExp('<strong>\\s*'+lbl+'\\s*:\\s*</strong>\\s*([^<]+)','i').exec(body);
      if (mm) console.log(`     ${lbl}: ${mm[1].trim()}`);
    }
  }
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const res = await cleanupRun(supabase, captured.runTag, { dealId: captured.finalDealState?.id, verbose: true });
    console.log('\n[cleanup]', JSON.stringify(res));
  } catch (e) { console.error('[cleanup] error:', e.message); }
})();
