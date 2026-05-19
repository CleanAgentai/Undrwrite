#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Cluster B Commit 2b — Market-Value Calibration Sample for Franco
// ─────────────────────────────────────────────────────────────────────────
// Generates a printable report of every market-value / numeric-tolerance
// discrepancy candidate in the corpus, formatted for Franco's calibration
// decision. Run: node scripts/b-calibration-sample.js
//
// IMPORTANT — INTERIM-STATE FRAMING (Req-3): the report's HEADER states
// up-front that these flags are currently admin-only, NOT broker-facing,
// pending Franco's calibration. Any interim re-test showing no broker-facing
// market-value clarification is INTENDED conservative behavior, not a
// regression. Franco's calibration answer enables the broker-facing emission.
//
// Output: written to scripts/b-calibration-sample.txt for Franco's review.

process.chdir(require('path').join(__dirname, '..'));
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const cf = require('../src/services/canonical-fields');
const dEngine = require('../src/services/discrepancy-engine');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

(async () => {
  // Pull corpus from Supabase (same shape as /tmp/b_corpus.json)
  const { data: deals } = await sb.from('deals').select('id, status, created_at, borrower_name, email').gte('created_at', '2026-04-01T00:00:00Z').order('created_at', { ascending: true });
  const submissions = [];
  for (const d of deals) {
    const { data: msgs } = await sb.from('messages').select('subject, body, direction').eq('deal_id', d.id).eq('direction', 'inbound').order('created_at', { ascending: true }).limit(1);
    if (!msgs || msgs.length === 0) continue;
    const inbound = msgs[0];
    if (/^re:|^fwd:|action required|file complete|preliminary review|complete review/i.test(inbound.subject || '')) continue;
    const { data: docs } = await sb.from('documents').select('file_name, classification, extracted_data').eq('deal_id', d.id).order('created_at', { ascending: true });
    if (!docs || docs.length < 3) continue;
    submissions.push({
      deal_id: d.id,
      borrower: d.borrower_name,
      status: d.status,
      subject: inbound.subject,
      body: inbound.body,
      docs: docs.map(doc => ({ file_name: doc.file_name, classification: doc.classification, text: doc?.extracted_data?.text || '' })),
    });
  }

  // Run engine on each + filter to market-value-delta cases
  const marketDeltaCases = [];
  const cleanSmallDelta = [];

  for (const sub of submissions) {
    const r = dEngine.runDiscrepancyDetection(sub.body, sub.docs, sub.borrower, { emailSubject: sub.subject });
    if (r.commercial || r.identity_clash_yielded) continue;
    // Check market_value tuples
    const mvTuples = r.canonical_map.subject_property_market_value || [];
    const distinctValues = [...new Set(mvTuples.map(t => t.value).filter(v => v != null))];
    if (distinctValues.length < 2) {
      // No multi-value case; nothing to calibrate
      continue;
    }
    const sorted = distinctValues.sort((a, b) => b - a);
    const high = sorted[0];
    const low = sorted[sorted.length - 1];
    const deltaAbs = high - low;
    const deltaPct = (deltaAbs / high) * 100;
    const hedgeInBody = /[~≈]\s*\$|approximately|approx\.|around|roughly|about|~|ish\b|give or take|in the neighborhood of|ballpark/i.test(sub.body || '');
    const flaggedByEngine = r.discrepancy_set.some(e => e.field === 'subject_property_market_value');

    const record = {
      deal_id: sub.deal_id,
      borrower: sub.borrower,
      subject: (sub.subject || '').slice(0, 120),
      values: mvTuples.map(t => ({ value: t.value, source: t.source })),
      delta_abs: deltaAbs,
      delta_pct: deltaPct,
      hedge_in_body: hedgeInBody,
      flagged: flaggedByEngine,
      loan_amount: r.canonical_map.requested_loan_amount && r.canonical_map.requested_loan_amount[0]?.value,
    };
    if (flaggedByEngine) marketDeltaCases.push(record);
    else cleanSmallDelta.push(record);
  }

  // Build the report
  const out = [];
  out.push('═══════════════════════════════════════════════════════════════════════════════');
  out.push('CLUSTER B — MARKET-VALUE CALIBRATION SAMPLE FOR FRANCO');
  out.push('═══════════════════════════════════════════════════════════════════════════════');
  out.push('');
  out.push('INTERIM-STATE NOTICE — READ FIRST');
  out.push('───────────────────────────────────────────────────────────────────────────────');
  out.push('Market-value and numeric-tolerance discrepancies are, BY DELIBERATE DESIGN,');
  out.push('currently surfaced ADMIN-ONLY (visible in the Deal Snapshot block on every');
  out.push('review email). They are intentionally NOT broker-facing pending YOUR');
  out.push('calibration answer to the questions at the bottom of this report.');
  out.push('');
  out.push('This means: any interim re-test showing Vienna NOT asking the broker to');
  out.push('confirm a property-value mismatch is INTENDED conservative behavior, NOT a');
  out.push('regression. Your calibration answer is what enables broker-facing emission.');
  out.push('');
  out.push('The objective gates (postal code / lender name / property address / borrower');
  out.push('name / grounding / same-category / phantom) ship broker-facing as-validated —');
  out.push('they are definitional, not threshold-based, and need no calibration.');
  out.push('');
  out.push('Only the numeric-tolerance dimension (the 5% market-value / 1% balance');
  out.push('threshold) carries the circular concern — the threshold is both the gate');
  out.push('AND the labeling criterion in our internal verification. Whether a 10-25%');
  out.push("delta is a material discrepancy vs normal variance is the lender's call.");
  out.push('You are the production arbiter of that materiality bar.');
  out.push('');
  out.push('═══════════════════════════════════════════════════════════════════════════════');
  out.push(`CURRENTLY FLAGGED AS DISCREPANCY (above the 5% threshold): ${marketDeltaCases.length} cases`);
  out.push('═══════════════════════════════════════════════════════════════════════════════');
  out.push('');

  for (const r of marketDeltaCases) {
    out.push(`Deal ${r.deal_id.slice(0,8)} — ${r.borrower}`);
    out.push(`  Subject:           ${r.subject}`);
    for (const v of r.values) {
      out.push(`  Source:            $${Number(v.value).toLocaleString('en-US')} (per ${v.source})`);
    }
    out.push(`  Delta:             $${r.delta_abs.toLocaleString('en-US')} (${r.delta_pct.toFixed(1)}%)`);
    out.push(`  Loan amount:       ${r.loan_amount ? '$' + Number(r.loan_amount).toLocaleString('en-US') : 'unknown'}`);
    out.push(`  Hedge in email:    ${r.hedge_in_body ? 'YES (~, approximately, around, etc.)' : 'no'}`);
    out.push(`  Your call:         [ material ] [ normal variance ] [ hedge-equivalent ] [ other:                  ]`);
    out.push('');
  }

  if (cleanSmallDelta.length > 0) {
    out.push('═══════════════════════════════════════════════════════════════════════════════');
    out.push(`CURRENTLY CLASSIFIED AS WITHIN-TOLERANCE (cleared by 5% threshold): ${cleanSmallDelta.length} cases`);
    out.push('───── For reference: should any of these have been flagged? ────');
    out.push('═══════════════════════════════════════════════════════════════════════════════');
    out.push('');
    for (const r of cleanSmallDelta) {
      out.push(`Deal ${r.deal_id.slice(0,8)} — ${r.borrower}`);
      out.push(`  Values:            ${r.values.map(v => '$' + Number(v.value).toLocaleString('en-US') + ' (' + v.source + ')').join(' / ')}`);
      out.push(`  Delta:             $${r.delta_abs.toLocaleString('en-US')} (${r.delta_pct.toFixed(1)}%)`);
      out.push(`  Hedge in email:    ${r.hedge_in_body ? 'YES' : 'no'}`);
      out.push(`  Your call:         [ should-have-flagged ] [ correctly-cleared ]`);
      out.push('');
    }
  }

  out.push('═══════════════════════════════════════════════════════════════════════════════');
  out.push('CALIBRATION QUESTIONS');
  out.push('═══════════════════════════════════════════════════════════════════════════════');
  out.push('');
  out.push('1. Is 5% the right threshold for "material discrepancy" on property values?');
  out.push('   Should it move up (10%, 15%) or down (3%, 2%)?');
  out.push('');
  out.push('2. Should there be a DOLLAR FLOOR alongside the percentage?');
  out.push('   e.g., "flag only if delta > $25K AND > 5%" — would clear small-dollar');
  out.push('   percentage flags on cheaper properties.');
  out.push('');
  out.push('3. Do HEDGED email values ("~$830K", "approximately $620K") get different');
  out.push('   treatment than precise ones? The current 5% threshold applies uniformly.');
  out.push('   The prompt-side UUU rule uses 10% tolerance specifically for hedged values;');
  out.push('   should the JS gate align with that (looser tolerance when hedged)?');
  out.push('');
  out.push('4. Are there SPECIAL CASES that override either direction?');
  out.push('   e.g., stale appraisal, cross-region disagreement, broker explicitly noted');
  out.push('   "appraisal lower than expected" — should these be treated differently?');
  out.push('');
  out.push('5. Once calibrated, do these flags go BROKER-FACING as discrepancy bullets in');
  out.push('   Vienna\'s reply email, or stay admin-only as PRELIMINARY-CLARIFICATION');
  out.push('   banner items on the admin review (you see them on the Snapshot but the');
  out.push('   broker is not asked)?');
  out.push('');
  out.push('GRACE R4-S1 NOTE: deal 5f8e4921 (Grace Marie Paulson, R4-S1 retest, 2026-05-18)');
  out.push('   is in the FLAGGED list above. This is the exact scenario where your R4');
  out.push('   report expected the broker-facing property-value clarification. Under the');
  out.push('   current interim state, Vienna would NOT emit that ask broker-facing —');
  out.push('   admin would see the discrepancy in the Snapshot but the broker round-trip');
  out.push('   wouldn\'t fire on the value mismatch. Your calibration answer above is what');
  out.push('   tells us whether to enable that broker-facing ask, and at what threshold.');
  out.push('');
  out.push('═══════════════════════════════════════════════════════════════════════════════');
  out.push('END OF SAMPLE');
  out.push('═══════════════════════════════════════════════════════════════════════════════');

  const reportPath = path.join(__dirname, 'b-calibration-sample.txt');
  fs.writeFileSync(reportPath, out.join('\n'));
  console.log(`Calibration sample written: ${reportPath}`);
  console.log(`  Flagged: ${marketDeltaCases.length} cases`);
  console.log(`  Clean (within tolerance): ${cleanSmallDelta.length} cases`);
  process.exit(0);
})();
