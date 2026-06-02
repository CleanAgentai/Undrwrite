#!/usr/bin/env node
// Real-submission verification harness.
//
// Pulls a deal's ACTUAL submitted PDFs from Supabase storage and traces each one
// through the real extraction + content-block routing the production pipeline
// uses — so a fix can be confirmed against the broker's real document, not a
// synthetic fixture. (Born from the Bug-1 false-positive: a synthetic fixture
// passed while the real submission still failed. The non-negotiable is: verify
// on the real document.)
//
// For each document it reports:
//   - pdf-parse base text length + pdf-lib annotation/form text length
//   - isFormLikeText (re-derived to mirror pdf.js routing)
//   - non-empty PDF annotation contents (count + money/purpose/lender samples) —
//     this is where annotation-filled "blank-looking" forms hide their real data
//   - VISION ROUTING via the REAL buildContentBlocks(): does this doc get sent to
//     the vision model as a base64 `document` block? (the hallucination vector)
// Then a submission-level view: broker email vs loan-app annotations (the
// source-divergence picture) + the deal's stored canonical extract.
//
// Usage:
//   node scripts/trace-deal-extraction.js                      # latest franco@francomaione.com deal
//   node scripts/trace-deal-extraction.js <email-substring>    # latest deal for that sender
//   node scripts/trace-deal-extraction.js id:<deal-id-prefix>  # specific deal by id prefix
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const pdfParse = require('pdf-parse');
const { PDFDocument, PDFName } = require('pdf-lib');
const { extractFormValues } = require('../src/lib/pdfFormExtract');
const { buildContentBlocks } = require('../src/lib/pdf');

const MIN_TEXT_LENGTH = 200;
// Mirror pdf.js isFormLikeText (internal, not exported) for routing visibility.
const isFormLikeText = (text) => {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return { result: true };
  const shortLines = lines.filter(l => l.trim().length < 40).length;
  const shortRatio = shortLines / lines.length;
  const hasMoneyAmounts = /\$[\d,]+/.test(text);
  const hasParagraphs = lines.some(l => l.trim().length > 120);
  return { result: shortRatio > 0.7 && !hasMoneyAmounts && !hasParagraphs, shortRatio: shortRatio.toFixed(2), hasMoneyAmounts, hasParagraphs };
};

const annotationContents = async (buffer) => {
  const out = [];
  try {
    const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true });
    pdf.getPages().forEach((page) => {
      const annots = page.node.Annots && page.node.Annots();
      if (!annots) return;
      const arr = annots.asArray ? annots.asArray() : [];
      arr.forEach((ref) => {
        try {
          const a = pdf.context.lookup(ref);
          if (!a || typeof a.get !== 'function') return;
          const c = a.get(PDFName.of('Contents'));
          if (!c) return;
          const t = typeof c.decodeText === 'function' ? c.decodeText() : String(c);
          if (t && String(t).trim().length > 0) out.push(String(t).trim());
        } catch (e) { /* skip */ }
      });
    });
  } catch (e) { /* no annots */ }
  return out;
};

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const resolveDeal = async (arg) => {
  if (arg && arg.startsWith('id:')) {
    const idPfx = arg.slice(3);
    const { data } = await s.from('deals').select('*').order('created_at', { ascending: false }).limit(100);
    return (data || []).find(d => d.id.startsWith(idPfx));
  }
  const emailSub = arg || 'franco@francomaione.com';
  const { data } = await s.from('deals').select('*').ilike('email', `%${emailSub}%`).order('created_at', { ascending: false }).limit(1);
  return data && data[0];
};

(async () => {
  const deal = await resolveDeal(process.argv[2]);
  if (!deal) { console.error('No deal found for arg:', process.argv[2] || '(default franco@francomaione.com)'); process.exit(1); }
  console.log(`Deal ${deal.id}  email=${deal.email}  created=${deal.created_at}  status=${deal.status}\n`);

  const { data: docs } = await s.from('documents').select('file_name,classification,storage_path,extracted_data').eq('deal_id', deal.id).order('created_at');

  console.log('=== PER-DOCUMENT ROUTING TRACE ===');
  const annByDoc = {};
  for (const d of docs) {
    const { data: blob, error } = await s.storage.from('documents').download(d.storage_path);
    if (error) { console.log(`!! ${d.file_name}: download fail (${error.message})`); continue; }
    const buffer = Buffer.from(await blob.arrayBuffer());

    let baseText = '';
    try { const p = await pdfParse(buffer); baseText = (p.text || '').trim(); } catch (e) {}
    let formText = '';
    try { formText = await extractFormValues(buffer); } catch (e) {}
    const combined = (baseText + formText).trim();
    const flt = isFormLikeText(combined);
    const ann = await annotationContents(buffer);
    annByDoc[d.file_name] = ann;

    // AUTHORITATIVE vision check: run the real buildContentBlocks on JUST this doc.
    const att = { Name: d.file_name, ContentType: 'application/pdf', Content: buffer.toString('base64') };
    const savedDoc = { file_name: d.file_name, extracted_data: { text: combined } };
    let sendsVision = false;
    try {
      const blocks = await buildContentBlocks([att], [savedDoc]);
      sendsVision = blocks.some(b => b.type === 'document');
    } catch (e) { sendsVision = `error:${e.message}`; }

    const moneyish = ann.filter(x => /[\d,]{4,}/.test(x)).slice(0, 6);
    const lenders = [...new Set(ann.filter(x => /RBC|Scotiabank|TD|CIBC|BMO|Royal Bank|Equitable/i.test(x)))].slice(0, 4);
    console.log(`\n── ${d.file_name}  [${d.classification}]`);
    console.log(`   text: base=${baseText.length} annot/form=${formText.length} combined=${combined.length}  (MIN_TEXT_LENGTH=${MIN_TEXT_LENGTH})`);
    console.log(`   isFormLikeText=${flt.result}  (shortRatio=${flt.shortRatio} hasMoney$digits=${flt.hasMoneyAmounts} hasParagraph120+=${flt.hasParagraphs})`);
    console.log(`   PDF annotations (non-empty Contents): ${ann.length}`);
    if (moneyish.length) console.log(`     money-ish: ${moneyish.join(' | ')}`);
    if (lenders.length) console.log(`     lenders: ${lenders.join(' | ')}`);
    console.log(`   >>> reaches VISION model (real buildContentBlocks → base64 document block): ${sendsVision}`);
  }

  // Submission-level source-divergence view
  console.log('\n=== SUBMISSION SOURCE-DIVERGENCE (broker email vs loan-app annotations) ===');
  const { data: inbound } = await s.from('messages').select('body').eq('deal_id', deal.id).eq('direction', 'inbound').order('created_at').limit(1);
  if (inbound && inbound[0]) {
    const b = inbound[0].body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const amt = b.match(/\$[\d,]+/g);
    const lender = b.match(/RBC|Scotiabank|TD|CIBC|BMO|Royal Bank|Equitable/gi);
    console.log(`  EMAIL: amounts=${amt ? amt.slice(0, 4).join(',') : 'none'}  lenders=${lender ? [...new Set(lender)].join(',') : 'none'}`);
  }
  const laDoc = docs.find(d => d.classification === 'loan_application' || /LoanApp/i.test(d.file_name));
  if (laDoc && annByDoc[laDoc.file_name]) {
    const ann = annByDoc[laDoc.file_name];
    const money = ann.filter(x => /[\d,]{4,}/.test(x)).slice(0, 6);
    const purpose = ann.filter(x => /consolidat|renovat|repair|improvement|purchase|refinanc/i.test(x)).slice(0, 2);
    const lenders = [...new Set(ann.filter(x => /RBC|Scotiabank|TD|CIBC|BMO|Royal Bank|Equitable/i.test(x)))].slice(0, 4);
    console.log(`  LOAN-APP ANNOTATIONS: money=${money.join(',')}  purpose=${purpose.join(' | ')}  lenders=${lenders.join(',')}`);
  } else {
    console.log('  LOAN-APP: no loan_application doc / no annotations');
  }

  // Stored canonical extract — the user-visible outcome
  console.log('\n=== STORED CANONICAL EXTRACT (deal.extracted_data) ===');
  const ed = deal.extracted_data || {};
  for (const k of ['ltv_percent', 'existing_mortgage_balance', 'loan_amount_requested', 'property_value', 'purpose', 'mortgage_position', 'transaction_type', 'unresolved_discrepancy', 'key_risks_or_notes']) {
    if (ed[k] !== undefined) console.log(`  ${k}: ${JSON.stringify(ed[k])}`);
  }

  console.log('\n=== QUICK READ ===');
  console.log(`  LTV: ${ed.ltv_percent}   (expected for a clean Marcus 1st-refi: ~60%)`);
  console.log(`  unresolved_discrepancy: ${ed.unresolved_discrepancy}   status: ${deal.status}`);
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
