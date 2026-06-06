// ONE-TIME extraction — pulls the email + document PDFs from the two source deals
// (b38bc2a4 Thomas, f9a67d03 Jennifer) onto disk so the replay harnesses become
// self-contained (no DB deal_id dependency). Run once before the DB wipe; the
// fixtures it writes are committed and the harnesses read from them thereafter.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const TARGETS = [
  { prefix: 'b38bc2a4', dir: 'thomas-bug23', fromName: 'Rosa Marchand' },
  { prefix: 'f9a67d03', dir: 'jennifer-bug23', fromName: 'Marcus Lindqvist' },
];

(async () => {
  const { data: srcDeals } = await s.from('deals').select('id,created_at').order('created_at', { ascending: false }).limit(60);
  for (const t of TARGETS) {
    const match = srcDeals.find(d => d.id.startsWith(t.prefix));
    if (!match) { console.error(`!! source deal ${t.prefix} NOT FOUND — aborting`); process.exit(1); }
    const srcId = match.id;
    const { data: msgs } = await s.from('messages').select('subject,body').eq('deal_id', srcId).eq('direction', 'inbound').order('created_at');
    const { data: docs } = await s.from('documents').select('file_name,storage_path').eq('deal_id', srcId).order('created_at');

    const base = path.join(__dirname, 'fixtures', t.dir);
    const docsDir = path.join(base, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });

    const docNames = [];
    for (const d of docs) {
      const { data: blob, error } = await s.storage.from('documents').download(d.storage_path);
      if (error || !blob) { console.error(`!! download failed for ${d.file_name} (${d.storage_path}): ${error && error.message}`); process.exit(1); }
      const buf = Buffer.from(await blob.arrayBuffer());
      // Sanitize file name for on-disk safety; harness re-uses these exact names as attachment Name.
      const safe = d.file_name.replace(/[^\w.\-]+/g, '_');
      fs.writeFileSync(path.join(docsDir, safe), buf);
      docNames.push(safe);
    }

    const meta = {
      source_deal_prefix: t.prefix,
      fromName: t.fromName,
      subject: msgs[0].subject || '',
      body: (msgs[0].body || ''),
      docs: docNames, // in created_at order; harness splits turn0 (non-PNW) vs turn1 (PNW) by name
    };
    fs.writeFileSync(path.join(base, 'meta.json'), JSON.stringify(meta, null, 2));
    console.log(`[${t.dir}] srcId=${srcId} | subject=${JSON.stringify(meta.subject)} | docs=${docNames.length}: ${docNames.join(', ')}`);
  }
  console.log('\nDONE — fixtures written under scripts/fixtures/');
})().catch(e => { console.error('EXTRACT FAIL:', e); process.exit(1); });
