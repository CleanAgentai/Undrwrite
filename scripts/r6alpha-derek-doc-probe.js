// R6-α probe — pull Derek dce308c8 documents to verify what loan_application
// PDF actually contains. Identifies whether hallucination origin is:
//   (a) PDF actually has $452,600 (extractor reading what's there)
//   (b) PDF has $110,000 (extractor mis-reading OR using wrong source)
//   (c) No PDF submitted; Vienna invented the figure from broker's typo'd email
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const DEREK_DEAL = 'dce308c8-2f25-4aeb-9c2b-2ad5284ae792';

(async () => {
  // 1. All documents on the Derek dce308c8 deal.
  const { data: docs } = await supabase
    .from('documents')
    .select('id, file_name, classification, extracted_data, created_at')
    .eq('deal_id', DEREK_DEAL)
    .order('created_at', { ascending: true });

  console.log(`Derek dce308c8 documents: ${docs?.length || 0}`);
  for (const d of docs || []) {
    console.log(`\n──── ${d.file_name} (${d.classification}) created=${d.created_at} ────`);
    const text = d.extracted_data?.text || '';
    console.log(`  text length: ${text.length}`);
    // Grep for the contested values.
    const hit452 = text.match(/\$\s*452[,\s]*\d{3}/g) || text.match(/452[,\s]*600|452,600|\b452K\b/g);
    const hit110 = text.match(/\$\s*110[,\s]*\d{3}/g) || text.match(/110[,\s]*000|110,000|\b110K\b/g);
    console.log(`  $452 matches: ${hit452 ? hit452.join(' | ') : '(none)'}`);
    console.log(`  $110 matches: ${hit110 ? hit110.join(' | ') : '(none)'}`);
    // Show Page-1 annotations if loan_application.
    if (d.classification === 'loan_application') {
      const annotations = text.match(/\[Page\s+\d+\s+annotation\][^\n]{0,150}/g) || [];
      console.log(`  Page-N annotations (${annotations.length}):`);
      for (const a of annotations.slice(0, 30)) console.log(`    ${a.replace(/\s+/g, ' ').trim()}`);
    }
  }

  // 2. Full message timeline for deal dce308c8.
  console.log(`\n\n${'═'.repeat(72)}\nFULL TIMELINE — deal dce308c8\n${'═'.repeat(72)}`);
  const { data: msgs } = await supabase
    .from('messages')
    .select('direction, subject, body, created_at')
    .eq('deal_id', DEREK_DEAL)
    .order('created_at', { ascending: true });
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const text = (m.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log(`\n  ── #${i} ${m.direction.toUpperCase()} ${m.created_at} ──`);
    console.log(`     subject: ${m.subject}`);
    console.log(`     body[0..800]: ${text.slice(0, 800)}`);
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
