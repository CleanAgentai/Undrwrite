// R6-δ probe — pull loan_application doc extracted_data.text for the 3 R6-δ
// fixtures + the R6-β-A fixtures, to identify the PML-template annotation
// shape for loan_term. Cross-corpus convention check before extractor design.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const DEAL_IDS = [
  // R6-δ fixtures:
  { label: 'Patricia S5', id: '6507de12-eaf5-4754-ac70-cfc9c42e0ecb' },
  { label: 'Kevin S6',    id: '178d714e-5924-43f4-8031-d34664f2b976' },
  { label: 'Sandra S8',   id: '84feed85-81f6-43ba-8b07-1eb9379ea8dd' },
  // R6-β-A confirmed-cascade fixture (Ryan c56c2a0f):
  { label: 'Ryan c56c2a0f (R6-β-A reference)', id: null /* will resolve */ },
];

(async () => {
  for (const seed of DEAL_IDS) {
    console.log(`\n${'═'.repeat(72)}\n${seed.label}\n${'═'.repeat(72)}`);
    let dealId = seed.id;
    if (!dealId && seed.label.startsWith('Ryan')) {
      const { data: r } = await supabase
        .from('messages')
        .select('deal_id')
        .ilike('subject', '%Ryan Callahan%')
        .order('created_at', { ascending: false })
        .limit(3);
      dealId = r?.[0]?.deal_id;
    }
    if (!dealId) { console.log('  NO deal_id'); continue; }

    const { data: docs } = await supabase
      .from('documents')
      .select('id, file_name, classification, extracted_data')
      .eq('deal_id', dealId);

    if (!docs || docs.length === 0) { console.log('  no documents on deal'); continue; }
    const loanApps = docs.filter(d => d.classification === 'loan_application');
    console.log(`  total docs: ${docs.length}; loan_application: ${loanApps.length}`);

    for (const d of loanApps) {
      const text = d.extracted_data?.text || '';
      console.log(`\n  ── ${d.file_name} ──`);
      console.log(`  text length: ${text.length}`);
      // Look for term-related anchors.
      const termHits = [];
      const patterns = [
        /Loan\s+Term[^\n]{0,80}/gi,
        /Term[^\w]{0,3}[\d]{1,3}[^\n]{0,40}/g,
        /\b\d{1,2}\s*(?:[-\s]?month|months|mo\.?|year|yrs?)\b[^\n]{0,40}/gi,
        /Requested\s+Term[^\n]{0,80}/gi,
        /Mortgage\s+Term[^\n]{0,80}/gi,
        /\[Page\s+\d+\s+annotation\][^\n]{0,200}/gi,
      ];
      for (const p of patterns) {
        const matches = text.match(p) || [];
        for (const m of matches) termHits.push(`[${p.source.slice(0,30)}]: "${m.slice(0, 100).replace(/\s+/g, ' ').trim()}"`);
      }
      console.log(`  term-anchor hits (${termHits.length}):`);
      for (const h of termHits.slice(0, 20)) console.log(`    ${h}`);

      // Also print the first 600 chars of the text as a baseline shape view.
      const baseline = text.slice(0, 1500).replace(/\s+/g, ' ').trim();
      console.log(`  first 1500 chars (whitespace-collapsed):\n    ${baseline}`);
    }
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
