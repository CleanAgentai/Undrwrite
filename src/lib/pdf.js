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
        // Use already-extracted text — no need to re-run pdf-parse
        console.log(`  [PDF] ${att.Name}: using pre-extracted ${preExtractedText.length} chars (~${Math.round(preExtractedText.length / 4)} tokens)`);
        blocks.push({
          type: 'text',
          text: `=== Document: ${att.Name} ===\n${preExtractedText}`,
        });
      } else if (preExtractedText && isFormLikeText(preExtractedText)) {
        // Form-like PDF (AcroForm) — pdf-parse only gets template labels, not filled values
        console.log(`  [PDF] ${att.Name}: form-like document detected, sending as base64 for full field reading`);
        blocks.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: att.Content },
        });
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
