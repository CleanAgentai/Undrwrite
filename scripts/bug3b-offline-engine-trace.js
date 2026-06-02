#!/usr/bin/env node
// BUG3B — offline deterministic-engine trace for the Round-7 reproduction fixture.
// Answers Porter's observe-point #1: "Does the deterministic engine produce a
// mortgage_position discrepancy at any point?" — using the REAL extracted text
// from the fixture's filled PDFs and the REAL runDiscrepancyDetection(Aggregated)
// path, across all three turns (intake → +confirm1 → +confirm2).
//
// This does NOT touch staging/LLM. The LLM-prose path is covered by the separate
// staging replay (bug3b-staging-replay.js).
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { extractFormValues } = require('../src/lib/pdfFormExtract');
const { classifyDocument } = require('../src/services/deals').__test__;
const dEngine = require('../src/services/discrepancy-engine');

const FIX = path.join(__dirname, '../test-fixtures/bulletproof/scenarios/BUG3B-round7-1st-refi-confirm');

const extractDocText = async (relPath, name) => {
  const buffer = fs.readFileSync(path.join(FIX, relPath));
  let baseText = '';
  let formText = '';
  try { const p = await pdfParse(buffer); if (p.text) baseText = p.text.trim(); } catch (e) {}
  try { formText = await extractFormValues(buffer); } catch (e) {}
  const text = (baseText + formText).trim();
  const classification = classifyDocument(name, text);
  return { file_name: name, classification, text, extracted_data: { text } };
};

const positionTuples = (cmap) => (cmap.mortgage_position || []).map(t => `${t.value} [${t.source}${t.classification ? '/' + t.classification : ''}]`);
const positionDiscrepancies = (dset) => (dset || []).filter(d => d.field === 'mortgage_position');

(async () => {
  const events = require(path.join(FIX, 'events.json'));
  const intakeBody = events[0].postmark.TextBody;
  const confirm1Body = events[1].postmark.TextBody;
  const confirm2Body = events[2].postmark.TextBody;
  const subject = events[0].postmark.Subject;

  const docs = [
    await extractDocText('documents/loan_application.pdf', 'LoanApplication_Webb.pdf'),
    await extractDocText('documents/mortgage_statement.pdf', 'MortgageStatement_Webb.pdf'),
    await extractDocText('documents/appraisal.pdf', 'Appraisal_Webb.pdf'),
  ];

  console.log('=== DOC EXTRACTION ===');
  docs.forEach(d => console.log(`  ${d.file_name} → ${d.classification} (${d.text.length} chars)`));
  // Confirm the loan_app actually carries the 1st-position + RBC balance text
  const la = docs[0].text;
  console.log(`  loan_app mentions "1st mortgage": ${/1st mortgage/i.test(la)} | "first mortgage": ${/first mortgage/i.test(la)} | "225,000": ${/225,000/.test(la)} | "Royal Bank": ${/Royal Bank/i.test(la)}`);

  const turns = [
    { label: 'TURN 0 — intake only', msgs: [{ body: intakeBody }] },
    { label: 'TURN 1 — intake + confirm1 ("yes, it\'s a first mortgage")', msgs: [{ body: intakeBody }, { body: confirm1Body }] },
    { label: 'TURN 2 — intake + confirm1 + confirm2 ("correct, 1st position")', msgs: [{ body: intakeBody }, { body: confirm1Body }, { body: confirm2Body }] },
  ];

  console.log('\n=== SINGLE-TURN (runDiscrepancyDetection) baseline ===');
  const single = dEngine.runDiscrepancyDetection(intakeBody, docs, 'Marcus Webb', { emailSubject: subject });
  console.log(`  mortgage_position tuples: ${JSON.stringify(positionTuples(single.canonical_map))}`);
  const singlePos = positionDiscrepancies(single.discrepancy_set);
  console.log(`  POSITION DISCREPANCY: ${singlePos.length > 0}`);
  if (singlePos.length) console.log('    ' + JSON.stringify(singlePos, null, 2));

  console.log('\n=== MULTI-TURN (runDiscrepancyDetectionAggregated) ===');
  let anyPositionDiscrepancy = false;
  for (const t of turns) {
    const r = dEngine.runDiscrepancyDetectionAggregated(t.msgs, docs, 'Marcus Webb', { emailSubject: subject });
    const posDisc = positionDiscrepancies(r.discrepancy_set);
    if (posDisc.length) anyPositionDiscrepancy = true;
    console.log(`\n  ${t.label}`);
    console.log(`    mortgage_position canonical: ${JSON.stringify(positionTuples(r.canonical_map))}`);
    console.log(`    POSITION DISCREPANCY FIRES: ${posDisc.length > 0}`);
    if (posDisc.length) console.log('      ' + JSON.stringify(posDisc, null, 2));
    // also surface the objective-authoritative filtered view (what the consumer boundary sees)
    const filtered = dEngine.filterCanonicalMortgagePositionForObjectiveAuthoritative(JSON.parse(JSON.stringify(r.canonical_map)));
    console.log(`    after R10-E objective filter: ${JSON.stringify(positionTuples(filtered))}`);
  }

  console.log('\n=== OFFLINE ENGINE VERDICT ===');
  console.log(`  Any mortgage_position discrepancy across all turns: ${anyPositionDiscrepancy}`);
  console.log(`  → ${anyPositionDiscrepancy ? 'ENGINE PATH REPRODUCES' : 'engine path does NOT reproduce'}`);
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
