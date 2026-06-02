#!/usr/bin/env node
// BUG-1 harness — blank/unfilled-form gate before the vision path.
// A blank AcroForm template (labels + unchecked boxes only, 0 filled DATA fields) must
// NOT be sent to the model for "field reading" (which causes value hallucination); it is
// gated to an explicit "UNFILLED FORM" signal. Filled AcroForms still go to the vision
// path unchanged. Discriminator: countFilledDataFields (text/dropdown/radio + annotations;
// checkboxes excluded).
const fs = require('fs');
const { buildContentBlocks } = require('../src/lib/pdf');
const { countFilledDataFields, extractFormValues } = require('../src/lib/pdfFormExtract');
const pdfParse = require('pdf-parse');
const ROOT = require('path').join(__dirname, '..');

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); cond ? pass++ : fail++; };

const att = (file, name) => ({ Name: name, ContentType: 'application/pdf', Content: fs.readFileSync(file).toString('base64') });
const savedDoc = async (file, name) => {
  const buf = fs.readFileSync(file); let base = '', form = '';
  try { base = (await pdfParse(buf)).text.trim(); } catch {}
  try { form = await extractFormValues(buf); } catch {}
  return { file_name: name, extracted_data: { text: (base + form).trim() } };
};
const gate = async (file, name) => (await buildContentBlocks([att(file, name)], [await savedDoc(file, name)]))[0] || {};

(async () => {
  const BLANK = ROOT + '/forms/Loan Application Form (1).pdf';
  const E15 = ROOT + '/test-fixtures/bulletproof/scenarios/E15-doc-quality-blank-acroform/documents/loan_application.pdf';
  const FILLED = ROOT + '/forms/Union Loan Application Form (1)-2.pdf'; // filled AcroForm (Mateen sample)

  console.log('— countFilledDataFields discriminator —');
  const blankC = await countFilledDataFields(fs.readFileSync(BLANK));
  check('blank template → 0 filled data fields', blankC.dataFields === 0, `dataFields=${blankC.dataFields}, hasAcroForm=${blankC.hasAcroForm}`);
  const e15C = await countFilledDataFields(fs.readFileSync(E15));
  check('E15 blank-acroform fixture → 0 filled data fields', e15C.dataFields === 0, `dataFields=${e15C.dataFields}`);
  const filledC = await countFilledDataFields(fs.readFileSync(FILLED));
  check('filled AcroForm → >0 filled data fields', filledC.dataFields > 0, `dataFields=${filledC.dataFields}`);
  check('unreadable buffer → fail-open (-1)', (await countFilledDataFields(Buffer.from('not a pdf'))).dataFields === -1);

  console.log('— buildContentBlocks gating —');
  const gBlank = await gate(BLANK, 'loan_application.pdf');
  check('blank template → GATED (text "UNFILLED FORM", NO vision)', gBlank.type === 'text' && /UNFILLED FORM/.test(gBlank.text || ''), `type=${gBlank.type}`);
  const gE15 = await gate(E15, 'loan_application.pdf');
  check('E15 fixture → GATED', gE15.type === 'text' && /UNFILLED FORM/.test(gE15.text || ''), `type=${gE15.type}`);
  const gFilled = await gate(FILLED, 'loan_application.pdf');
  check('filled AcroForm → VISION (base64 document, unchanged)', gFilled.type === 'document', `type=${gFilled.type}`);

  console.log(`\nBUG-1 harness: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
