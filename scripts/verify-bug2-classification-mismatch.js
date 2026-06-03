#!/usr/bin/env node
// Bug 2 verification: filename-vs-content classification cross-check + admin callout.
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const deals = require('../src/services/deals');
const ai = require('../src/services/ai');
const { detectClassificationMismatch } = deals;
const fs = require('fs'), path = require('path');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  PASS ${n}`); } else { fail++; console.log(`  FAIL ${n}`); } };

(async () => {
  // ===== TEST 1: Daniel Kim's mislabeled file → mismatch + prelim callout =====
  console.log('[Test 1] Daniel Kim 875af304 — mislabeled Credit_Bureau (PNW content)');
  const { data: dl } = await s.from('deals').select('id').order('created_at', { ascending: false }).limit(40);
  const d = dl.find(x => x.id.startsWith('875af304'));
  const { data: docs } = await s.from('documents').select('file_name,classification,extracted_data').eq('deal_id', d.id);
  const dealDocs = docs.map(x => ({ file_name: x.file_name, extracted_data: { text: x.extracted_data?.text || '' } }));
  const mismatches = dealDocs.map(x => detectClassificationMismatch(x.file_name, x.extracted_data.text)).filter(Boolean);
  const creditMis = mismatches.find(m => /Credit_Bureau/i.test(m.fileName));
  ok('Credit_Bureau file flagged: filename=credit_report vs content=pnw_statement', creditMis && creditMis.fileClass === 'credit_report' && creditMis.contentClass === 'pnw_statement');
  // callout surfaces on a sample prelim body
  const sampleHtml = '<p><strong>FILE STATUS: PRELIMINARY REVIEW</strong></p><h2>Deal Snapshot</h2><p>rows</p>';
  const withCallout = ai.injectClassificationMismatchCallout(sampleHtml, mismatches);
  ok('prelim callout injected with explicit mismatch text', /Document Classification Mismatch/.test(withCallout) && /Credit_Bureau_Daniel_Kim\.pdf.*Credit Report.*Personal Net Worth Statement/s.test(withCallout.replace(/<[^>]+>/g, ' ')));
  // idempotent (re-inject doesn't duplicate)
  const twice = ai.injectClassificationMismatchCallout(withCallout, mismatches);
  ok('callout idempotent (no duplicate on re-render)', (twice.match(/Document Classification Mismatch/g) || []).length === 1);

  // ===== TEST 2: honest filename + matching content → no flag =====
  console.log('\n[Test 2] honest filenames → no flag, current behavior preserved');
  ok('honest PNW (filename pnw, PNW content) → no mismatch', detectClassificationMismatch('PNW_Statement_Daniel_Kim.pdf', docs.find(x => x.file_name.includes('PNW')).extracted_data.text) === null);
  ok('honest loan app → no mismatch', detectClassificationMismatch('LoanApplication.pdf', 'LOAN APPLICATION FORM\nBorrower information property\nLoan amount: $400,000\nmortgage') === null);
  ok('honest appraisal → no mismatch', detectClassificationMismatch('Appraisal.pdf', 'CERTIFIED APPRAISAL\nAppraised value $620,000\ncomparable sales analysis') === null);
  // ambiguous content (gov ID / tax bill — content reads as nothing) → never flags
  ok('gov ID (content ambiguous → "other") → NO false flag', detectClassificationMismatch('GovernmentID.pdf', 'DRIVERS LICENCE\nName: Daniel Kim\nDOB 1985') === null);
  ok('property tax (content ambiguous) → NO false flag', detectClassificationMismatch('PropertyTax.pdf', 'CITY OF EDMONTON\nProperty tax assessment 2026\nAssessed value $620,000') === null);

  // ===== TEST 3: generic across taxonomy (not just credit↔pnw) =====
  console.log('\n[Test 3] generic mismatch detection across the taxonomy');
  const loanAppContent = 'LOAN APPLICATION FORM\nBorrower information property\nLoan amount requested $400,000\nmortgage';
  const apprContent = 'CERTIFIED APPRAISAL REPORT\nAppraised value $650,000\ncomparable sales';
  ok('file named LoanApplication but content is an appraisal → flag (loan_application vs appraisal)', (() => { const m = detectClassificationMismatch('LoanApplication_X.pdf', apprContent); return m && m.fileClass === 'loan_application' && m.contentClass === 'appraisal'; })());
  ok('file named Appraisal but content is a loan application → flag (appraisal vs loan_application)', (() => { const m = detectClassificationMismatch('Appraisal_X.pdf', loanAppContent); return m && m.fileClass === 'appraisal' && m.contentClass === 'loan_application'; })());
  const creditContent = 'CREDIT BUREAU REPORT\nEquifax\nCredit score 720\nbeacon score';
  ok('file named Income but content is a credit report → flag', (() => { const m = detectClassificationMismatch('Income_T4.pdf', creditContent); return m && m.contentClass === 'credit_report'; })());

  // ===== TEST 4: bulletproof suite regression — classifyDocument behavior unchanged =====
  console.log('\n[Test 4] bulletproof regression — classifyDocument unchanged + how many fixtures would flag');
  const { classifyDocument, classifyByContent } = deals.__test__;
  // refactor-equivalence: classifyDocument on a no-filename file == classifyByContent
  ok('refactor equivalence: classifyDocument(neutral name, text) === classifyByContent(text)',
    classifyDocument('file.pdf', 'PERSONAL NET WORTH STATEMENT\ntotal assets total liabilities') === classifyByContent('PERSONAL NET WORTH STATEMENT\ntotal assets total liabilities'));
  // scan fixtures: count docs that would flag (should be ~0 — fixtures use honest names; synth content matches)
  const scen = path.join(__dirname, '../test-fixtures/bulletproof/scenarios');
  const pdfParse = require('pdf-parse');
  const { extractFormValues } = require('../src/lib/pdfFormExtract');
  let scanned = 0, flagged = 0; const flaggedList = [];
  for (const dir of fs.readdirSync(scen).filter(x => /^[A-Z]\d/.test(x)).slice(0, 12)) {
    const docsDir = path.join(scen, dir, 'documents');
    if (!fs.existsSync(docsDir)) continue;
    for (const f of fs.readdirSync(docsDir).filter(x => x.endsWith('.pdf'))) {
      const buf = fs.readFileSync(path.join(docsDir, f));
      let base = ''; try { const p = await pdfParse(buf); base = (p.text || '').trim(); } catch (e) {}
      let form = ''; try { form = await extractFormValues(buf); } catch (e) {}
      const text = (base + form).trim();
      scanned++;
      const m = detectClassificationMismatch(f, text);
      if (m) { flagged++; flaggedList.push(`${dir}/${f}: ${m.fileClass}≠${m.contentClass}`); }
    }
  }
  console.log(`        scanned ${scanned} fixture docs (first 12 scenarios); flagged ${flagged}`);
  if (flaggedList.length) flaggedList.slice(0, 8).forEach(x => console.log('          ⚠ ' + x));
  ok(`Test 4: fixture docs do not spuriously flag (flagged ${flagged}; expect low/0 on honest synth docs)`, flagged === 0);

  console.log(`\n[verify-bug2] ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
