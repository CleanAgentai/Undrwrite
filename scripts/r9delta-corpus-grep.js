// R9-D empirical-grounding — Exit Strategy lender hallucination.
//
// Marcus S2 (996a676c): preliminary review Exit Strategy section said
//   "his current Scotiabank mortgage matures in October 2027"
// when broker email body stated "Existing mortgage: RBC" + submitted
// RBC_Payout_Statement_Marcus_Webb.pdf. "Scotiabank" appears nowhere in
// the submission per Franco's bug report.
//
// Empirical tasks:
//   (a) Trace "Scotiabank" origin — extracted_data fields, document text,
//       email conversation history, OR pure confabulation
//   (b) Confirm Exit Strategy is rendered by generateLeadSummary
//   (c) Identify what canonical_map.existing_first_mortgage_lender + raw
//       extracted_data fields are exposed to the prompt vs only canonical
//   (d) Empirical confirmation that R6-γ's filterCanonicalLenderForPayoutOnly
//       was applied at the Deal Snapshot consumer but NOT at the
//       generateLeadSummary prompt input (parallel-source still leaks)

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const stripHtml = s => (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  console.log('R9-D EMPIRICAL GROUNDING — Exit Strategy lender hallucination');
  console.log('═'.repeat(80));

  const MARCUS = '996a676c-f227-4151-8e19-bf75e180ae85';

  // 1. Pull Marcus extracted_data + scan for any "Scotia" / "Scotiabank" mention.
  console.log('\nSTRATEGY 1: Marcus extracted_data — lender-related fields');
  console.log('─'.repeat(80));
  const { data: deal } = await supabase
    .from('deals')
    .select('extracted_data, borrower_name')
    .eq('id', MARCUS)
    .single();
  const ed = deal.extracted_data || {};
  const lenderKeys = Object.keys(ed).filter(k => /lender|mortgage|exit|bank/i.test(k));
  console.log('lender-related fields:');
  for (const k of lenderKeys) {
    console.log(`  ${k} = ${JSON.stringify(ed[k])}`);
  }
  // Scan for "scotia" anywhere in extracted_data
  const edJson = JSON.stringify(ed);
  const scotiaMatches = [...edJson.matchAll(/scotia[a-z]*/gi)];
  console.log(`\nScotia mentions in extracted_data JSON: ${scotiaMatches.length}`);
  for (const m of scotiaMatches) {
    const ctxStart = Math.max(0, m.index - 60);
    const ctxEnd = Math.min(edJson.length, m.index + m[0].length + 60);
    console.log(`  "${m[0]}" @ ${m.index} — context: "${edJson.slice(ctxStart, ctxEnd)}"`);
  }

  // 2. Pull Marcus documents — scan each for "scotia"
  console.log('\n\nSTRATEGY 2: Marcus documents — scan each text body for "scotia"');
  console.log('─'.repeat(80));
  const { data: docs } = await supabase
    .from('documents')
    .select('file_name, classification, extracted_data')
    .eq('deal_id', MARCUS);
  for (const d of docs) {
    const text = d.extracted_data?.text || '';
    const scotiaIn = [...text.matchAll(/scotia[a-z]*/gi)];
    const rbcIn = [...text.matchAll(/\bRBC\b/gi)];
    console.log(`\n  ${d.file_name} (${d.classification}):`);
    console.log(`    text length: ${text.length} chars`);
    console.log(`    Scotia mentions: ${scotiaIn.length}`);
    for (const m of scotiaIn) {
      const ctxStart = Math.max(0, m.index - 80);
      const ctxEnd = Math.min(text.length, m.index + m[0].length + 80);
      console.log(`      "${m[0]}" @ ${m.index} — context: "${text.slice(ctxStart, ctxEnd).replace(/\n/g, ' ')}"`);
    }
    console.log(`    RBC mentions: ${rbcIn.length}`);
    for (const m of rbcIn.slice(0, 3)) {
      const ctxStart = Math.max(0, m.index - 60);
      const ctxEnd = Math.min(text.length, m.index + m[0].length + 60);
      console.log(`      RBC @ ${m.index} — context: "${text.slice(ctxStart, ctxEnd).replace(/\n/g, ' ')}"`);
    }
  }

  // 3. Pull email conversation — scan for "scotia"
  console.log('\n\nSTRATEGY 3: Marcus message conversation — scan for "scotia"');
  console.log('─'.repeat(80));
  const { data: msgs } = await supabase
    .from('messages')
    .select('direction, subject, body, created_at')
    .eq('deal_id', MARCUS)
    .order('created_at', { ascending: true });
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const text = stripHtml(m.body);
    const scotiaIn = [...text.matchAll(/scotia[a-z]*/gi)];
    const rbcIn = [...text.matchAll(/\bRBC\b/gi)];
    if (scotiaIn.length > 0 || rbcIn.length > 0) {
      console.log(`\n  #${i} ${m.direction.toUpperCase()} ${m.created_at.slice(0, 16)}`);
      console.log(`    subject: ${m.subject}`);
      console.log(`    Scotia: ${scotiaIn.length} | RBC: ${rbcIn.length}`);
      for (const sm of scotiaIn) {
        const ctxStart = Math.max(0, sm.index - 80);
        const ctxEnd = Math.min(text.length, sm.index + sm[0].length + 80);
        console.log(`      Scotia @ ${sm.index} — "${text.slice(ctxStart, ctxEnd)}"`);
      }
    }
  }

  // 4. Code-path discovery: how does generateLeadSummary handle lender attribution?
  console.log('\n\nSTRATEGY 4: code-path — generateLeadSummary lender / Exit Strategy prompt context');
  console.log('─'.repeat(80));
  const { execSync } = require('child_process');
  const grep = (pattern, file, n) => {
    try {
      return execSync(`grep -n "${pattern}" ${file} 2>/dev/null | head -${n || 30} || true`).toString().trim();
    } catch (e) { return ''; }
  };
  console.log('\nai.js — Exit Strategy + lender prompt mentions:');
  console.log(grep('Exit Strategy\\|existing_mortgage_lender\\|filterCanonicalLenderForPayoutOnly', 'src/services/ai.js', 20));
  console.log('\nwebhook.js — filterCanonicalLenderForPayoutOnly invocations:');
  console.log(grep('filterCanonicalLenderForPayoutOnly\\|canonicalLenderForReview\\|existing_first_mortgage_lender', 'src/routes/webhook.js', 20));
  console.log('\ndiscrepancy-engine.js — lender filter + canonical field:');
  console.log(grep('filterCanonicalLenderForPayoutOnly\\|existing_first_mortgage_lender\\|lender_canonical', 'src/services/discrepancy-engine.js', 15));
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
