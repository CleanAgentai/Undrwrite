const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const claude = require('./src/lib/claude');

const TEST_PDF = process.argv[2] || 'Candice Marcotte - Application and Summary.pdf';

const MIN_TEXT_LENGTH = 200;

const isFormLikeText = (text) => {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return true;
  const shortLines = lines.filter(l => l.trim().length < 40).length;
  const shortRatio = shortLines / lines.length;
  const hasMoneyAmounts = /\$[\d,]+/.test(text);
  const hasParagraphs = lines.some(l => l.trim().length > 120);
  return shortRatio > 0.7 && !hasMoneyAmounts && !hasParagraphs;
};

(async () => {
  const filePath = path.join(__dirname, 'forms', TEST_PDF);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const buffer = fs.readFileSync(filePath);
  const base64 = buffer.toString('base64');

  // Step 1: Try pdf-parse (same as workflow)
  let extractedText = null;
  try {
    const parsed = await pdfParse(buffer);
    console.log('=== PDF-PARSE RESULTS ===');
    console.log('Pages:', parsed.numpages);
    console.log('Total chars:', parsed.text ? parsed.text.trim().length : 0);
    console.log('Info:', JSON.stringify(parsed.info, null, 2));
    console.log('Metadata:', JSON.stringify(parsed.metadata, null, 2));
    console.log('\n=== FULL EXTRACTED TEXT ===');
    console.log(parsed.text ? parsed.text.trim() : '(no text)');
    console.log('=== END TEXT ===\n');
    if (parsed.text && parsed.text.trim().length > 0) {
      extractedText = parsed.text.trim();
    }
  } catch (err) {
    console.log('pdf-parse failed:', err.message);
  }

  // Step 2: Decide which path to take (same logic as pdf.js buildContentBlocks)
  let contentBlock;
  if (extractedText && extractedText.length >= MIN_TEXT_LENGTH && !isFormLikeText(extractedText)) {
    console.log(`Path: TEXT EXTRACTION (${extractedText.length} chars, ~${Math.round(extractedText.length / 4)} tokens)`);
    console.log('---');
    console.log(extractedText.substring(0, 500));
    console.log('---\n');
    contentBlock = {
      type: 'text',
      text: `=== Document: ${TEST_PDF} ===\n${extractedText}`,
    };
  } else if (extractedText && isFormLikeText(extractedText)) {
    console.log(`Path: BASE64 FALLBACK (form-like document detected, pdf-parse got ${extractedText.length} chars but looks like field labels)`);
    contentBlock = {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: base64 },
    };
  } else {
    console.log('Path: BASE64 FALLBACK (scanned/no text extracted)');
    contentBlock = {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: base64 },
    };
  }

  // Step 3: Send to Claude (same as workflow)
  console.log(`Sending ${TEST_PDF} to Claude...\n`);

  const response = await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        contentBlock,
        {
          type: 'text',
          text: `Analyze this document. Return JSON:
{
  "document_type": "what kind of document this is",
  "primary_borrower_name": "name if found, or null",
  "loan_type": "personal | corporate | null",
  "key_info": "brief summary of what this document contains",
  "reasoning": "one sentence explaining your classification"
}`,
        },
      ],
    }],
  });

  console.log(response.content[0].text);
})();
