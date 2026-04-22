const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const claude = require('./src/lib/claude');
const { buildContentBlocks } = require('./src/lib/pdf');

const TEST_PDF = process.argv[2] || 'Candice Marcotte - Application and Summary.pdf';

(async () => {
  // Resolve path — check forms/ first, then treat as absolute/relative path
  let filePath = path.join(__dirname, 'forms', TEST_PDF);
  if (!fs.existsSync(filePath)) {
    filePath = path.isAbsolute(TEST_PDF) ? TEST_PDF : path.join(process.cwd(), TEST_PDF);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${TEST_PDF}`);
    process.exit(1);
  }

  const fileName = path.basename(filePath);
  const buffer = fs.readFileSync(filePath);
  const base64 = buffer.toString('base64');

  console.log(`\n=== TEST: ${fileName} ===`);
  console.log(`Size: ${(buffer.length / 1024).toFixed(1)} KB\n`);

  // Step 1: pdf-parse text extraction (mirrors dealsService.saveDocument)
  let extractedText = null;
  try {
    const parsed = await pdfParse(buffer);
    if (parsed.text && parsed.text.trim().length > 0) {
      extractedText = parsed.text.trim();
      console.log(`pdf-parse: extracted ${extractedText.length} chars (${parsed.numpages} pages)`);
    } else {
      console.log('pdf-parse: no text extracted (likely scanned)');
    }
  } catch (err) {
    console.log('pdf-parse failed:', err.message);
  }

  // Step 2: build the same attachment + savedDocs shape that production uses
  const attachments = [{
    Name: fileName,
    ContentType: 'application/pdf',
    Content: base64,
  }];

  const savedDocs = extractedText
    ? [{ file_name: fileName, extracted_data: { text: extractedText } }]
    : [];

  // Step 3: invoke production buildContentBlocks — same as webhook.js
  console.log('\n--- buildContentBlocks (production logic) ---');
  const contentBlocks = await buildContentBlocks(attachments, savedDocs);
  console.log(`Returned ${contentBlocks.length} content block(s)`);
  contentBlocks.forEach((b, i) => {
    if (b.type === 'text') {
      console.log(`  Block ${i + 1}: text (${b.text.length} chars, ~${Math.round(b.text.length / 4)} tokens)`);
    } else if (b.type === 'document') {
      const kb = (b.source.data.length * 3 / 4) / 1024;
      console.log(`  Block ${i + 1}: document base64 (~${kb.toFixed(0)} KB)`);
    } else if (b.type === 'image') {
      console.log(`  Block ${i + 1}: image base64`);
    }
  });

  // Step 4: send to Claude — same model as production
  console.log(`\n--- Sending to Claude ---`);
  const response = await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        ...contentBlocks,
        {
          type: 'text',
          text: `Analyze this document. Return JSON:
{
  "document_type": "what kind of document this is (e.g. loan application, appraisal, credit bureau, NOA, etc.)",
  "primary_borrower_name": "name if found, or null",
  "loan_type": "personal | corporate | null",
  "key_info": "brief summary of what this document contains — include any extracted numbers (loan amount, property value, credit scores, etc.)",
  "reasoning": "one sentence explaining your classification"
}`,
        },
      ],
    }],
  });

  console.log('\n=== Claude response ===');
  console.log(response.content[0].text);
  console.log('\n=== Usage ===');
  console.log(`Input tokens:  ${response.usage.input_tokens}`);
  console.log(`Output tokens: ${response.usage.output_tokens}`);
})();
