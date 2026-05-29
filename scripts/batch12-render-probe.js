#!/usr/bin/env node
// BATCH-12 Track-B render probe — confirms a Franco-9 render surface actually
// appears on deployed code before we write the expected.json expectation.
// Usage: node scripts/batch12-render-probe.js <scenario-dir-prefix> <checkKey>
//   checkKey: q8 | q5 | q10
require('dotenv').config();
const fs = require('fs'), path = require('path');
const { runScenario } = require('../test-fixtures/bulletproof/lib/replay');
const { cleanupRun } = require('../test-fixtures/bulletproof/lib/cleanupHelper');
const { createClient } = require('@supabase/supabase-js');

const CHECKS = {
  q8: [['Joint Applicants row', /<strong>\s*Joint Applicants\s*:\s*<\/strong>/i]],
  q5: [['Corporate borrower row', /<strong>\s*Corporate borrower\s*:\s*<\/strong>/i],
       ['accountant financials ask', /accountant.{0,20}(prepared|financ)|Corporate Financial Statements/i]],
  q10:[['[UPDATED] correction notice', /\[UPDATED\].{0,40}correction|Prelim correction/i]],
};

(async () => {
  const prefix = process.argv[2], checkKey = process.argv[3];
  const root = path.join(__dirname, '../test-fixtures/bulletproof/scenarios');
  const dir = fs.readdirSync(root).find(d => d.startsWith(prefix));
  if (!dir) { console.error('no scenario', prefix); process.exit(1); }
  let captured;
  try { captured = await runScenario(path.join(root, dir), { verbose: true }); }
  catch (e) { console.error('REPLAY ERROR:', e.message); process.exit(1); }

  const ed = captured.finalDealState?.extracted_data || {};
  const emails = captured.outboundEmails || [];
  const allBody = emails.map(e => (e.Subject||'') + '\n' + (e.HtmlBody||e.TextBody||'')).join('\n----\n');
  console.log(`\n===== ${prefix} (${dir}) status=${captured.finalDealState?.status} emails=${emails.length} =====`);
  for (let i=0;i<emails.length;i++) console.log(`  [${i}] ${emails[i].Subject||''}`);
  console.log('\n--- checks (' + checkKey + ') ---');
  for (const [label, re] of (CHECKS[checkKey]||[])) {
    const hit = re.test(allBody);
    console.log(`  ${hit ? 'RENDERS ✓' : 'ABSENT ✗'}  ${label}`);
    if (hit) { const m = re.exec(allBody); const s=Math.max(0,m.index-30), e=Math.min(allBody.length,m.index+140); console.log('     …'+allBody.slice(s,e).replace(/\s+/g,' ').trim()+'…'); }
  }
  if (checkKey === 'q10' || checkKey === 'q8') {
    console.log('  extracted_data keys of note:', JSON.stringify({ loan: ed.requested_loan_amount||ed.loan_amount_requested, pv: ed.property_value, joint: ed.joint_multi_borrower, q10at: ed._q10_admin_renotified_at, q10fields: ed._q10_renotified_fields }));
  }
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const res = await cleanupRun(supabase, captured.runTag, { dealId: captured.finalDealState?.id, verbose: false });
    console.log('\n[cleanup]', JSON.stringify(res));
  } catch (e) { console.error('[cleanup] error:', e.message); }
})();
