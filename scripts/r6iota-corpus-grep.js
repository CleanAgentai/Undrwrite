// R6-ι probe — Sandra S8 (deal 84feed85) interest-rate-as-loan-amount
// confusion. Empirical-grounding: identify where the 10.99% figure appears
// in Vienna's outbounds and whether it's labeled as loan_amount, interest
// rate, or conflated mid-sentence.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const SANDRA_DEAL = '84feed85-81f6-43ba-8b07-1eb9379ea8dd';

(async () => {
  console.log(`Pulling timeline for Sandra S8 deal ${SANDRA_DEAL}\n${'═'.repeat(72)}`);
  const { data: msgs } = await supabase
    .from('messages')
    .select('id, direction, subject, body, created_at')
    .eq('deal_id', SANDRA_DEAL)
    .order('created_at', { ascending: true });
  console.log(`total messages: ${msgs.length} (${msgs.filter(m => m.direction === 'inbound').length} in + ${msgs.filter(m => m.direction === 'outbound').length} out)\n`);

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const text = (m.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log(`──── #${i} ${m.direction.toUpperCase()} ${m.created_at} ────`);
    console.log(`  subject: ${m.subject}`);
    console.log(`  body[0..1500]: ${text.slice(0, 1500)}`);
    // Highlight 10.99 and $68 mentions.
    const hits10 = text.match(/10[.,]99[^\d][^.]{0,80}/g) || [];
    const hits68 = text.match(/\$?\s*68[,\s]*000[^.]{0,80}|68k\b[^.]{0,80}/gi) || [];
    if (hits10.length > 0 || hits68.length > 0) {
      console.log(`  10.99 mentions (${hits10.length}):`);
      for (const h of hits10.slice(0, 3)) console.log(`    "${h.slice(0, 120)}"`);
      console.log(`  68,000 mentions (${hits68.length}):`);
      for (const h of hits68.slice(0, 3)) console.log(`    "${h.slice(0, 120)}"`);
    }
    console.log();
  }

  // Also look for the "loan amount" phrase combined with 10.99 or 1099 to find
  // the conflation site.
  console.log(`\n${'═'.repeat(72)}\nCONFLATION SCAN — "loan amount" near 10.99 / 1099\n${'═'.repeat(72)}`);
  for (const m of msgs) {
    const text = (m.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // Match phrases like "loan amount.{0,50}10\.99" or vice versa within a sentence window.
    const conflations = [];
    const phrases = [
      /loan amount[^.]{0,100}10[.,]99/i,
      /10[.,]99[^.]{0,100}loan amount/i,
      /\$10[.,]?99[^.]{0,80}/i,
      /\$1099[^.]{0,80}/i,
      /Loan Amount[^.]{0,50}\$?\s*10\.99/i,
      /loan amount[^.]{0,50}\$\s*10/i,
    ];
    for (const p of phrases) {
      const matches = text.match(p);
      if (matches) conflations.push(matches[0]);
    }
    if (conflations.length > 0) {
      console.log(`  ${m.direction} ${m.created_at}`);
      for (const c of conflations) console.log(`    "${c.slice(0, 150)}"`);
    }
  }

  // Cross-check: pull the Sandra loan_application PDF text + identify all
  // Page-1 annotations to confirm the actual extracted values + their order.
  console.log(`\n\n${'═'.repeat(72)}\nLOAN APPLICATION DOC TEXT for Sandra S8\n${'═'.repeat(72)}`);
  const { data: docs } = await supabase
    .from('documents')
    .select('file_name, classification, extracted_data')
    .eq('deal_id', SANDRA_DEAL);
  const loanApp = (docs || []).find(d => d.classification === 'loan_application');
  if (!loanApp) { console.log('  no loan_application doc'); }
  else {
    const text = loanApp.extracted_data?.text || '';
    const annotations = text.match(/\[Page\s+\d+\s+annotation\][^\n]{0,150}/g) || [];
    console.log(`  doc: ${loanApp.file_name} (text length: ${text.length})`);
    console.log(`  annotations (${annotations.length}):`);
    for (const a of annotations.slice(0, 30)) {
      console.log(`    ${a.replace(/\s+/g, ' ').trim()}`);
    }
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
