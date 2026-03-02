const fs = require('fs');
const path = require('path');
const claude = require('./src/lib/claude');

const TEST_PDF = 'Union Loan Application Form (1)-2.pdf';

(async () => {
  const filePath = path.join(__dirname, 'forms', TEST_PDF);
  const base64 = fs.readFileSync(filePath).toString('base64');

  console.log(`Sending ${TEST_PDF} to Claude as base64...\n`);

  const response = await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 },
        },
        {
          type: 'text',
          text: `Look at the "Primary Borrower" name field in this loan application form.

- If the Primary Borrower name is a person's name (e.g. "John Smith") → loan_type = "personal"
- If the Primary Borrower name contains LLC, Inc, Corp, Ltd, Holdings, or any business entity → loan_type = "corporate"

Return JSON only:
{
  "primary_borrower_name": "exact value from the Primary Borrower name field",
  "loan_type": "personal | corporate",
  "reasoning": "one sentence explaining why"
}`,
        },
      ],
    }],
  });

  console.log(response.content[0].text);
})();
