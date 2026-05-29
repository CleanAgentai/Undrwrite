#!/usr/bin/env node
// BATCH-12 Track-A probe — E06 (purchase) mortgage_statement_required gate.
// Question: the gate inferred=true (payout-statement string present in an outbound)
// but E06 is a PURCHASE (spec expects false). Pinpoint WHERE the string appears and
// whether Vienna classified the deal as a purchase. Single-turn → cheap. Cleans up.
require('dotenv').config();
const path = require('path');
const { runScenario } = require('../test-fixtures/bulletproof/lib/replay');
const { cleanupRun } = require('../test-fixtures/bulletproof/lib/cleanupHelper');
const { createClient } = require('@supabase/supabase-js');

const RE = /current mortgage payout statement/i;

(async () => {
  const fixtureDir = path.join(__dirname, '../test-fixtures/bulletproof/scenarios/E06-transaction-purchase');
  let captured;
  try {
    captured = await runScenario(fixtureDir, { verbose: true });
  } catch (e) { console.error('REPLAY ERROR:', e.message); process.exit(1); }

  const ed = captured.finalDealState?.extracted_data || {};
  console.log('\n===== E06 finalDealState classification =====');
  console.log('  status:', captured.finalDealState?.status);
  console.log('  is_purchase:', ed.is_purchase);
  console.log('  transaction_type:', ed.transaction_type);
  console.log('  deal_type:', ed.deal_type, ' mortgage_position:', ed.mortgage_position);

  const emails = captured.outboundEmails || [];
  console.log(`\n===== ${emails.length} outbound emails =====`);
  for (let i = 0; i < emails.length; i++) {
    const e = emails[i];
    const body = e.HtmlBody || e.TextBody || '';
    const subj = e.Subject || '';
    const hit = RE.test(subj + ' ' + body);
    const isPrelim = /PRELIMINARY|action required/i.test(subj);
    const isDocAsk = /missing|need|please send|please forward|outstanding|document/i.test(subj + ' ' + body);
    console.log(`\n  [${i}] subject="${subj}"  payoutString=${hit}  prelim=${isPrelim} docAskish=${isDocAsk}`);
    if (hit) {
      // show ~160 chars of context around each match
      const src = subj + '\n' + body;
      let m, idx = 0; const re = new RegExp(RE.source, 'gi');
      while ((m = re.exec(src)) && idx < 3) {
        const s = Math.max(0, m.index - 90), en = Math.min(src.length, m.index + 90);
        console.log('     …' + src.slice(s, en).replace(/\s+/g, ' ').trim() + '…');
        idx++;
      }
    }
  }

  // cleanup
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const res = await cleanupRun(supabase, captured.runTag, { dealId: captured.finalDealState?.id, verbose: true });
    console.log('\n[cleanup]', JSON.stringify(res));
  } catch (e) { console.error('[cleanup] error:', e.message); }
})();
