const { countFilledDataFields } = require('./pdfFormExtract');

const MIN_TEXT_LENGTH = 200;

// Detect if pdf-parse text looks like a form template (only field labels, no real content)
// Filled AcroForm PDFs return the same template labels as blank forms — pdf-parse can't read filled values
const isFormLikeText = (text) => {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return true;

  // Most lines are short fragments (field labels like "Primary Borrower", "Date of Birth", etc.)
  const shortLines = lines.filter(l => l.trim().length < 40).length;
  const shortRatio = shortLines / lines.length;

  // Real documents have dollar amounts, long paragraphs, or sentences
  const hasMoneyAmounts = /\$[\d,]+/.test(text);
  const hasParagraphs = lines.some(l => l.trim().length > 120);

  // If >70% short lines and no financial data or paragraphs → likely a form
  return shortRatio > 0.7 && !hasMoneyAmounts && !hasParagraphs;
};

// Check if filename indicates a high-value document that should get both text + base64
const isDualPathDocument = (fileName) => {
  const name = fileName.toLowerCase();
  return /application|summary|appraisal/.test(name);
};

// Build Claude content blocks from raw attachments + already-extracted text from savedDocs
// savedDocs is the array returned by dealsService.saveAttachments (may be empty for existing client if no attachments)
const buildContentBlocks = async (attachments, savedDocs = []) => {
  const blocks = [];

  for (const att of attachments) {
    // Find the matching saved doc by filename
    const savedDoc = savedDocs.find(d => d.file_name === att.Name);
    const preExtractedText = savedDoc?.extracted_data?.text || null;

    if (att.ContentType === 'application/pdf') {
      if (preExtractedText && preExtractedText.length >= MIN_TEXT_LENGTH && !isFormLikeText(preExtractedText)) {
        // Use already-extracted text
        console.log(`  [PDF] ${att.Name}: using pre-extracted ${preExtractedText.length} chars (~${Math.round(preExtractedText.length / 4)} tokens)`);
        blocks.push({
          type: 'text',
          text: `=== Document: ${att.Name} ===\n${preExtractedText}`,
        });
        // Dual path: also send base64 for application/summary/appraisal docs so Claude sees the full layout
        if (isDualPathDocument(att.Name)) {
          const isAppraisal = /appraisal/i.test(att.Name);
          // Skip base64 for appraisals with 50K+ chars of extracted text — redundant and eats tokens
          if (isAppraisal && preExtractedText.length >= 50000) {
            console.log(`  [PDF] ${att.Name}: skipping base64 — text extraction already got ${preExtractedText.length} chars, sufficient for analysis`);
          } else {
            console.log(`  [PDF] ${att.Name}: dual-path — also sending base64 for full visual analysis`);
            blocks.push({
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: att.Content },
            });
          }
        }
      } else if (preExtractedText && isFormLikeText(preExtractedText)) {
        // Form-like PDF (AcroForm) — pdf-parse only gets template labels, not filled values.
        //
        // BLANK-FORM GATE (Bug-1 fix): before sending the PDF to the vision model "for
        // full field reading", verify the form actually carries FILLED data. The form-like
        // signal alone cannot tell a FILLED AcroForm (labels via pdf-parse, real values in
        // the form metadata) from a BLANK template (labels only, no values) — both look
        // form-like. Sending a BLANK form to vision makes the model hallucinate plausible
        // values for the empty fields (fabricated existing-mortgage balance, loan purpose,
        // etc.). Gate: form-like text AND zero filled DATA fields → do NOT send to the
        // model; emit an explicit "unfilled form" text block so extraction treats the
        // application as not-yet-provided and escalates (E15 empty-intake behavior).
        // FAIL OPEN: any read error (dataFields < 0) routes to the unchanged vision path,
        // so a genuine submission is never blocked.
        let fill = { dataFields: -1 };
        try {
          fill = await countFilledDataFields(Buffer.from(att.Content, 'base64'));
        } catch (e) {
          console.log(`  [PDF] ${att.Name}: blank-form check threw (${e.message}) — failing open to vision path`);
        }
        if (fill.dataFields === 0) {
          console.log(`  [PDF] ${att.Name}: UNFILLED form detected (0 filled data fields) — NOT sending to model; emitting unfilled-form signal (no field reading)`);
          blocks.push({
            type: 'text',
            text: `=== Document: ${att.Name} ===\n[UNFILLED FORM — this document was submitted as a blank/empty form template with NO field values entered (only blank labels and unchecked boxes). Do NOT infer, extract, read, or fabricate ANY values (loan amount, mortgage balances, loan purpose, names, dates, employer, or any figure) from it. Treat this application/form as NOT PROVIDED — the broker must submit a completed version.]`,
          });
        } else {
          console.log(`  [PDF] ${att.Name}: form-like document with ${fill.dataFields >= 0 ? fill.dataFields : 'unknown'} filled field(s), sending as base64 for full field reading`);
          blocks.push({
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: att.Content },
          });
        }
      } else {
        // Scanned/image PDF — send as base64 for Claude to read visually
        console.log(`  [PDF] ${att.Name}: scanned document, sending as base64`);
        blocks.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: att.Content },
        });
      }
      continue;
    }

    // Images — send as base64
    const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    if (imageTypes.includes(att.ContentType)) {
      console.log(`  [IMG] ${att.Name}: sending as base64 image`);
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: att.ContentType, data: att.Content },
      });
      continue;
    }

    console.log(`  [SKIP] ${att.Name}: unsupported type ${att.ContentType}, skipping`);
  }

  return blocks;
};

module.exports = { buildContentBlocks };
