// R10-F empirical-grounding — Patricia Simmons broker-facing discrepancy
// flagging consistency. Goal: inventory every discrepancy that surfaced in
// the Risk Factors narrative and compare against broker-facing outreach.
// Bug 5-3 (Franco Scenario 5 retest): admin-only flagging vs broker-clarification
// inconsistent across discrepancy types.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const dEngine = require('../src/services/discrepancy-engine');

const PATRICIA_DEAL = 'a0caddfb-92c4-4607-8ec1-72f54f9ebb31';

(async () => {
  console.log('R10-F EMPIRICAL — Patricia broker-discrepancy flagging consistency');
  console.log('='.repeat(80));

  // (A) Deal state + extracted_data
  console.log('\nSTRATEGY A: Patricia deal state');
  console.log('-'.repeat(80));
  const { data: deal } = await supabase
    .from('deals')
    .select('id, status, extracted_data, prelim_approved_at, conditions_sent_at, aml_pep_requested_at')
    .eq('id', PATRICIA_DEAL)
    .single();
  console.log(`  status: ${deal?.status}`);
  console.log(`  borrower: ${deal?.extracted_data?.borrower_name}`);
  console.log(`  prelim_approved_at: ${deal?.prelim_approved_at || '(none)'}`);
  console.log(`  conditions_sent_at: ${deal?.conditions_sent_at || '(none)'}`);

  // (B) Inventory all messages with subject + direction + body excerpts
  console.log('\nSTRATEGY B: Full message thread inventory');
  console.log('-'.repeat(80));
  const { data: msgs } = await supabase
    .from('messages')
    .select('id, direction, subject, body, created_at')
    .eq('deal_id', PATRICIA_DEAL)
    .order('created_at', { ascending: true });
  console.log(`  Total messages: ${msgs.length}`);
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const isPrelim = /PRELIMINARY/i.test(m.subject || '');
    const isAction = /ACTION REQUIRED/i.test(m.subject || '');
    const isDraft = /Draft Email Preview/i.test(m.body || '');
    console.log(`  [${i}] ${m.direction.toUpperCase()} | ${m.created_at.slice(0,19)} | ${(m.subject||'').slice(0,80)}`);
    if (isPrelim || isAction) console.log(`       FLAGS: ${isPrelim ? 'PRELIM ' : ''}${isAction ? 'ACTION ' : ''}${isDraft ? 'DRAFT-PREVIEW' : ''}`);
  }

  // (C) Pull all PRELIM outbounds with full Risk Factors content
  console.log('\nSTRATEGY C: PRELIM outbound Risk Factors content');
  console.log('-'.repeat(80));
  const prelims = msgs.filter(m =>
    m.direction === 'outbound'
    && /PRELIMINARY/i.test(m.subject || '')
  );
  console.log(`  Prelim outbounds: ${prelims.length}`);
  for (const p of prelims) {
    console.log(`\n  ── ${p.created_at.slice(0,19)} | ${p.subject} ──`);
    const body = p.body || '';
    // Extract Risk Factors section
    const rfMatch = body.match(/<h2[^>]*>\s*Risk\s+Factors[\s\S]*?(?=<h2|<hr|$)/i);
    if (rfMatch) {
      console.log('  RISK FACTORS section:');
      console.log(rfMatch[0].replace(/\s+/g, ' ').slice(0, 2000));
    } else {
      // Fallback — look for "Risk Factors" anywhere
      const rfIdx = body.search(/Risk\s+Factors/i);
      if (rfIdx !== -1) {
        console.log('  Risk Factors found at idx', rfIdx);
        console.log('  excerpt:', body.slice(rfIdx, rfIdx + 1500).replace(/\s+/g, ' '));
      }
    }
    // Extract Snapshot for cross-check
    const snapMatch = body.match(/<h2[^>]*>\s*Snapshot[\s\S]*?(?=<h2|<hr|$)/i);
    if (snapMatch) {
      console.log('  SNAPSHOT (first 800 chars):');
      console.log(snapMatch[0].replace(/\s+/g, ' ').slice(0, 800));
    }
  }

  // (D) Pull all broker-facing outbounds (non-prelim, non-action-required)
  console.log('\nSTRATEGY D: Broker-facing outbound inventory (Vienna→broker)');
  console.log('-'.repeat(80));
  const brokerFacing = msgs.filter(m =>
    m.direction === 'outbound'
    && !/PRELIMINARY/i.test(m.subject || '')
    && !/ACTION REQUIRED/i.test(m.subject || '')
  );
  console.log(`  Broker-facing outbounds: ${brokerFacing.length}`);
  for (const b of brokerFacing) {
    console.log(`\n  ── ${b.created_at.slice(0,19)} | ${b.subject} ──`);
    const body = b.body || '';
    console.log('  Body (first 1500 chars):');
    console.log(body.slice(0, 1500).replace(/\s+/g, ' '));
  }

  // (E) Replay canonical_map detection to see divergent tuples
  console.log('\nSTRATEGY E: canonical_map divergence inventory');
  console.log('-'.repeat(80));
  const inbounds = msgs.filter(m => m.direction === 'inbound');
  const { data: docs } = await supabase
    .from('documents')
    .select('file_name, classification, extracted_data')
    .eq('deal_id', PATRICIA_DEAL);
  const docsForCanonical = docs.map(d => ({
    file_name: d.file_name,
    classification: d.classification,
    text: d.extracted_data?.text || '',
  }));
  const detect = dEngine.runDiscrepancyDetectionAggregated(
    inbounds,
    docsForCanonical,
    deal?.extracted_data?.borrower_name || null,
    { emailSubject: inbounds[0]?.subject || '' },
  );
  console.log(`  detect.discrepancyDetected: ${detect.discrepancyDetected}`);
  console.log(`  detect.brokerFacingDiscrepancyCount: ${detect.brokerFacingDiscrepancyCount}`);
  const cmap = detect.canonical_map || {};
  console.log(`  canonical_map field keys (${Object.keys(cmap).length}):`);
  for (const k of Object.keys(cmap).sort()) {
    const tuples = cmap[k];
    if (!Array.isArray(tuples) || tuples.length === 0) continue;
    const uniq = Array.from(new Set(tuples.map(t => JSON.stringify(t.value))));
    const divergent = uniq.length > 1;
    if (divergent) {
      console.log(`    [DIVERGENT] ${k}: ${tuples.length} tuples — values: ${uniq.join(' | ')}`);
      for (const t of tuples) {
        console.log(`        source=${t.source} value=${JSON.stringify(t.value)} classification=${t.classification || ''}`);
      }
    } else {
      console.log(`    ${k}: ${tuples.length} tuple(s), value=${uniq[0]}`);
    }
  }

  // (F) renderDiscrepancySection output (broker-facing clarification render)
  console.log('\nSTRATEGY F: renderDiscrepancySection output for broker');
  console.log('-'.repeat(80));
  if (typeof dEngine.renderDiscrepancySection === 'function') {
    const section = dEngine.renderDiscrepancySection(detect);
    console.log(`  renderDiscrepancySection length: ${section.length}`);
    console.log(`  content (first 2000 chars):`);
    console.log(section.slice(0, 2000));
  } else {
    console.log('  renderDiscrepancySection helper not found on dEngine');
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
