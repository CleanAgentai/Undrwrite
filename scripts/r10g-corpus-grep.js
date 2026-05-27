// R10-G empirical-grounding — blank-template hallucination prevention.
//
// Franco Round-6 Scenario 7 bug surface (Ethan Broussard deal c95f3a20):
//   Bug 7-2: Vienna stated loan_amount=$74,000; broker stated $73,880;
//            $74,000 not in any submitted document. Fabricated from blank
//            Union Lending loan application template.
//   Bug 7-3: Vienna stated purpose="Debt consolidation and emergency home
//            repairs"; broker stated "home renovation"; blank template had
//            no purpose filled in. Fabricated; caused deal rated OKAY +
//            generated false risk factor.
//   Bug 7-4: Broker replied "$73,880 correct"; Vienna ignored, prelim
//            asserts "broker confirmed the application amount" — OPPOSITE
//            of what broker actually said.
//
// Three sub-bugs may be one root cause or distinct:
//   (1) Blank-template extractor hallucination (LLM extracting placeholder
//       text as if real data)
//   (2) Broker correction ignored in downstream canonical resolution
//   (3) Correction misrepresented in prelim narrative ("broker confirmed"
//       when broker corrected)
//
// Empirical tasks:
//   (A) Full Ethan deal inventory — extracted_data, messages, documents
//   (B) loan_application document text — verify literal blank template vs
//       template-with-$74k vs filled-correctly
//   (C) All messages (inbound + outbound) — trace correction flow
//   (D) Prelim outbound content — find "broker confirmed" + $74,000 fabrication
//   (E) Canonical-map source hierarchy — what fields feed prelim narrative
//   (F) Code-path discovery — prelim generator + broker-correction handling

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const DEAL_ID = 'c95f3a20-162c-45cf-a98c-60b6bbb2de9a';

(async () => {
  console.log('R10-G EMPIRICAL — blank-template hallucination prevention');
  console.log('Ethan Broussard deal:', DEAL_ID);
  console.log('='.repeat(80));

  // (A) Full deal record
  console.log('\nSTRATEGY A: deal record + extracted_data');
  console.log('-'.repeat(80));
  const { data: deal } = await supabase
    .from('deals')
    .select('*')
    .eq('id', DEAL_ID)
    .single();
  if (!deal) { console.error('Deal not found'); process.exit(1); }
  console.log(`borrower_name: ${deal.borrower_name}`);
  console.log(`status: ${deal.status}`);
  console.log(`ltv: ${deal.ltv}`);
  console.log(`created_at: ${deal.created_at}`);
  console.log('\nextracted_data:');
  for (const [k, v] of Object.entries(deal.extracted_data || {})) {
    const s = typeof v === 'string' ? `"${v.slice(0, 200)}"` : JSON.stringify(v).slice(0, 200);
    console.log(`  ${k}: ${s}`);
  }

  // (B) Documents
  console.log('\n\nSTRATEGY B: documents on file');
  console.log('-'.repeat(80));
  const { data: docs } = await supabase
    .from('documents')
    .select('id, file_name, classification, extracted_data, storage_path')
    .eq('deal_id', DEAL_ID);
  console.log(`document count: ${docs?.length || 0}`);
  for (const d of docs || []) {
    console.log(`\n  ${d.file_name} | classification=${d.classification}`);
    console.log(`    storage_path: ${d.storage_path}`);
    if (d.extracted_data) {
      const ed = d.extracted_data;
      console.log(`    extracted_data keys: ${Object.keys(ed).join(', ')}`);
      // Show text snippet if available
      if (ed.text) {
        const text = String(ed.text);
        console.log(`    text length: ${text.length}`);
        console.log(`    text first 800 chars:`);
        console.log(`      ${text.slice(0, 800).replace(/\n/g, '\n      ')}`);
        // Search for key figures
        const has74000 = /74,?000|\$74\b/.test(text);
        const has73880 = /73,?880|\$73,?880/.test(text);
        const hasDebtConsol = /debt consolidation/i.test(text);
        const hasHomeRenov = /home renovation/i.test(text);
        const hasEmergRepair = /emergency.*repair|home repair/i.test(text);
        console.log(`    contains "74,000"/"$74": ${has74000}`);
        console.log(`    contains "73,880"/"$73,880": ${has73880}`);
        console.log(`    contains "debt consolidation": ${hasDebtConsol}`);
        console.log(`    contains "home renovation": ${hasHomeRenov}`);
        console.log(`    contains "emergency repair"/"home repair": ${hasEmergRepair}`);
      } else {
        console.log(`    (no text field in extracted_data)`);
      }
    }
  }

  // (C) Messages — full thread
  console.log('\n\nSTRATEGY C: full message thread (inbound + outbound)');
  console.log('-'.repeat(80));
  const { data: msgs } = await supabase
    .from('messages')
    .select('id, direction, subject, body, created_at')
    .eq('deal_id', DEAL_ID)
    .order('created_at', { ascending: true });
  for (const m of msgs || []) {
    console.log(`\n--- ${m.direction.toUpperCase()} | ${m.created_at.slice(0, 19)} ---`);
    console.log(`subject: ${m.subject}`);
    // Search for key signals
    const body = m.body || '';
    const sigs = {
      '$74,000': /\$?74,?000|seventy-four thousand/i.test(body),
      '$73,880': /\$?73,?880|seventy-three thousand eight hundred/i.test(body),
      '"debt consolidation"': /debt consolidation/i.test(body),
      '"home renovation"': /home renovation/i.test(body),
      '"emergency"': /emergency/i.test(body),
      '"broker confirmed"': /broker confirmed|confirmed (by|with) (the )?broker/i.test(body),
      '"correct amount is"': /correct (amount|loan) (is|was)|correct.*\$73|correct.*73,880/i.test(body),
      'OKAY rating': /\bOKAY\b|rated OK|risk.*low/i.test(body),
    };
    console.log(`  signals: ${Object.entries(sigs).filter(([, v]) => v).map(([k]) => k).join(' | ') || '(none)'}`);
    console.log(`  body (first 1000 chars):`);
    console.log(`    ${body.slice(0, 1000).replace(/\n/g, '\n    ')}`);
  }

  // (D) Code-path: prelim generator
  console.log('\n\nSTRATEGY D: prelim generator code-path');
  console.log('-'.repeat(80));
  const { execSync } = require('child_process');
  const grep = (pattern, file, n = 15) => {
    try {
      return execSync(`grep -nE "${pattern}" ${file} 2>/dev/null | head -${n} || true`).toString().trim();
    } catch { return ''; }
  };
  console.log('generateLeadSummary + prelim narrative anchor sites:');
  console.log(grep('generateLeadSummary|sendPreliminaryReviewToAdmin|broker confirmed|loan_amount_requested', 'src/routes/webhook.js', 30));
  console.log('\nai.js — loan_amount + purpose extraction + prelim prompt:');
  console.log(grep('loan_amount|purpose.*extract|prelim.*prompt|broker confirmed', 'src/services/ai.js', 30));

  // (E) Canonical-map: does it have a "broker_stated" override mechanism?
  console.log('\n\nSTRATEGY E: canonical-map source-hierarchy for loan_amount + purpose');
  console.log('-'.repeat(80));
  console.log(grep('canonical_map\\..*loan_amount|loan_amount.*canonical|broker.*stated|broker.*override', 'src/services/canonical-fields.js', 30));
  console.log('\ndiscrepancy-engine.js — sources + resolution:');
  console.log(grep('loan_amount|requested_loan_amount|broker.*source|canonical', 'src/services/discrepancy-engine.js', 30));

  // (F) Blank-template detection: any existing pre-R10-G logic?
  console.log('\n\nSTRATEGY F: blank-template detection signals');
  console.log('-'.repeat(80));
  console.log(grep('blank|template|placeholder|empty.*pdf|hollow', 'src/services/ai.js', 15));
  console.log(grep('blank|template|placeholder|empty.*pdf|hollow', 'src/services/canonical-fields.js', 15));
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
