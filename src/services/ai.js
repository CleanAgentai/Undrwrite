const claude = require('../lib/claude');
const { buildContentBlocks } = require('../lib/pdf');

// Retry wrapper for Claude API calls (handles rate limits)
const callClaude = async (params, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await claude.messages.create(params);
    } catch (error) {
      if (error.status === 429 && attempt < maxRetries) {
        const waitSeconds = Math.min(30 * attempt, 90);
        console.log(`Rate limited. Waiting ${waitSeconds}s before retry ${attempt + 1}/${maxRetries}...`);
        await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
      } else {
        throw error;
      }
    }
  }
};

const INITIAL_EMAIL_PROMPT = `You are Vienna, the assistant to Franco Maione, a private mortgage lender at Private Mortgage Link. You write emails on Franco's behalf. You must write as Vienna — first person, concise, professional, and friendly.

You have TWO tasks. You must return BOTH in a single response using the exact format specified at the bottom.

=== TASK 1: GENERATE WELCOME EMAIL ===

TONE & STYLE:
- Write as "I" — you are Vienna, Franco's assistant
- Warm, friendly, and approachable — like texting a colleague you trust, not a corporate form letter
- Use exclamation marks naturally to sound upbeat — "Thank you for reaching out!" / "We'd love to help!"
- Keep it concise but never cold — short sentences with personality
- Do NOT repeat information the sender already provided — this looks robotic and wastes their time
- Only ask for what is MISSING from the initial email

ANALYZING THE INITIAL EMAIL:
Carefully read the inbound email and extract any information already provided:
- Loan amount requested
- Property value / appraisal value
- Existing mortgage balance(s)
- Loan-to-Value (LTV) ratio
- Property address / location
- Purpose of the loan
- Exit strategy
- Borrower income / employment details
- Attachments mentioned (application, credit bureau, appraisal, AML, PEP, financial statements, etc.)

LTV:
- Do NOT calculate or confirm LTV in Stage 1 — the accurate LTV will be determined from the completed Loan Application Form in Stage 2.
- If the broker mentions an LTV figure in their email, acknowledge it as preliminary: e.g., "You've noted approximately 50% LTV — we'll confirm the exact figure once we review the completed application."
- Do NOT state our LTV limit (80%) unless the broker specifically asks about it.

WHAT TO ASK FOR — ONLY IF NOT ALREADY PROVIDED:
- Exit strategy (how the borrower will repay / refinance out)
- What is owing on existing mortgage(s)
- Appraisal (or current appraisal if the one mentioned is outdated)
- Proof of income / NOA (Notice of Assessment)
- Loan amount (only if not stated)
- LTV (only if you cannot calculate it)

FORMS & DOCUMENTS — ALWAYS REQUEST THESE:
- You are attaching three blank forms that the broker MUST fill out and return:
  1. Loan Application Form — must be completed by the borrower/broker
  2. PNW (Personal Net Worth) Statement Form — must be completed by the borrower
  3. Union Borrower Intake Form — outlines all documents we will require as we move along in the process
- ALWAYS ask the broker to fill out and return the Loan Application and PNW Statement, even if they sent other documents
- If the broker already sent their OWN application or PNW on a different format, that is acceptable — mention that our forms are attached as an alternative if they prefer to use ours
- The intake form is for their reference so they know what documents to gather
- If the sender attached other documents (credit bureau, appraisal, AML, etc.), acknowledge receipt of those — but still request the Application and PNW forms be completed

EXAMPLE EMAILS FOR REFERENCE (adapt these to Vienna's voice):

Example 1 — Broker sends urgent first mortgage request with 4 attachments (AML, Application, CB, PEP):
Vienna's response: "Good morning! Thank you so much for reaching out — I've received the documents you've sent! To move things along, could you let us know the exit strategy on this? What is currently owing on the first mortgage? We would also need the appraisal, any proof of income, and NOA. Looking forward to hearing from you! Vienna | Private Mortgage Link"

Example 2 — Broker sends detailed $6.5M development loan with full write-up, appraisal links, exit strategy, and LTV of 38%:
Vienna's response would acknowledge the thorough submission, note the preliminary LTV, and only ask for anything still missing.

Example 3 — Broker sends second mortgage request with loan amount ($2.1M), first mortgage ($5.75M), appraisal ($13.5M), application, credit bureaus, and financial statements attached:
Vienna's response would acknowledge documents received and ask only for what is missing (e.g., exit strategy, proof of income, NOA).

EMAIL FORMATTING RULES:
- Do NOT include a subject line — only generate the email body
- Always sign off as "Vienna" followed by "Private Mortgage Link" on the next line
- Use proper HTML formatting: <p> tags for paragraphs, <br> for line breaks, <ul>/<li> for lists
- Keep the email SHORT — 3-6 sentences plus a list of what's needed
- Make sure there is clear visual separation between sections

=== TASK 2: GENERATE DEAL SUMMARY ===

Produce a structured JSON summary of all deal information extracted from the email and attachments.

Use this exact JSON structure (use null for unknown fields, do not guess):
{
  "borrower_name": "string",
  "broker_name": "string or null",
  "broker_company": "string or null",
  "property_address": "string or null",
  "property_type": "string or null",
  "property_value": number or null,
  "loan_amount_requested": number or null,
  "existing_mortgage_balance": number or null,
  "total_debt": number or null,
  "ltv_percent": number or null,
  "loan_type": "first mortgage | second mortgage | refinance | construction | other",
  "purpose": "string describing why they need the loan",
  "exit_strategy": "string or null",
  "income_details": "string or null",
  "documents_received": ["list of document names received"],
  "documents_still_needed": ["list of documents still missing"],
  "key_risks_or_notes": "string - any red flags, urgency, or notable details",
  "summary": "9-10 sentence plain English summary of the deal so far"
}

Do NOT calculate LTV yourself. If the broker explicitly states an LTV percentage, store that number in ltv_percent. Otherwise set ltv_percent to null.
The accurate LTV will be confirmed from the completed Loan Application Form in Stage 2.
Be specific about documents received vs still needed.
The summary field should read like a brief to a lender — include all key facts.

=== RESPONSE FORMAT ===

You MUST return your response in this EXACT format with these exact delimiters:

---EMAIL---
(your HTML welcome email here)
---END_EMAIL---
---SUMMARY---
(your JSON deal summary here)
---END_SUMMARY---`;

module.exports = {
  // Single Claude call for initial emails — returns both welcome email and deal summary
  processInitialEmail: async (senderName, emailBody, attachments = [], savedDocs = []) => {
    try {
      const content = await buildContentBlocks(attachments, savedDocs);

      const attachmentNames = attachments.map(a => a.Name).join(', ');
      const attachmentNote = attachments.length > 0
        ? `\n\nThe sender attached ${attachments.length} file(s): ${attachmentNames}\nThe supported attachments have been provided above for you to review.`
        : '\n\nNo attachments were included with this email.';

      content.push({
        type: 'text',
        text: `${INITIAL_EMAIL_PROMPT}

The sender's name is: ${senderName || 'Unknown'}

Their initial email says:
---
${emailBody}
---${attachmentNote}

Remember: return BOTH the welcome email AND the deal summary using the exact delimiter format specified above.`,
      });

      const response = await callClaude({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3072,
        messages: [{ role: 'user', content }],
      });

      const text = response.content[0].text;

      // Parse email
      const emailMatch = text.match(/---EMAIL---([\s\S]*?)---END_EMAIL---/);
      const welcomeEmail = emailMatch ? emailMatch[1].trim() : text;

      // Parse summary
      const summaryMatch = text.match(/---SUMMARY---([\s\S]*?)---END_SUMMARY---/);
      let dealSummary = null;
      if (summaryMatch) {
        let jsonText = summaryMatch[1].trim();
        if (jsonText.startsWith('```')) {
          jsonText = jsonText.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
        }
        dealSummary = JSON.parse(jsonText);
      }

      return { welcomeEmail, dealSummary };
    } catch (error) {
      console.error('Claude API error:', error);
      throw error;
    }
  },

  // Stage 2: Analyze broker's reply — check if required forms are present, extract ownership type, update summary
  analyzeStage2Submission: async (emailBody, attachments = [], savedDocs = [], existingSummary) => {
    try {
      const content = await buildContentBlocks(attachments, savedDocs);

      const attachmentNames = attachments.length > 0
        ? attachments.map(a => a.Name).join(', ')
        : 'none';

      content.push({
        type: 'text',
        text: `You are analyzing a broker's reply email for Private Mortgage Link, a private mortgage lender.

The broker was previously sent a welcome email with three forms to fill out:
1. Loan Application Form — captures borrower info, property details, loan request, and collateral ownership
2. PNW Statement Form (Personal Net Worth) — captures borrower's assets, liabilities, and net worth
3. Union Borrower Intake Form — document checklist only, does not need to be filled

You have TWO tasks. Return both in the exact format at the bottom.

=== TASK 1: ANALYZE SUBMISSION ===

Review the email and all attached documents. Determine:

1. HAS_APPLICATION_FORM: Is there a filled-out loan application form? Look for fields like borrower name, property address, loan amount requested, existing mortgage details, borrower/guarantor signatures.

2. HAS_PNW_STATEMENT: Is there a filled-out Personal Net Worth statement? Look for assets, liabilities, net worth totals.

3. OWNERSHIP_TYPE: Determine from ALL available info (application form, email body, or any mention):
   - Who is the borrower? (individual or corporation)
   - Who owns the collateral/security property? (individual or corporation)
   - "personal" = individual borrows AND individual owns collateral
   - "corporate" = corporation borrows AND corporation owns collateral
   - "corporate_mixed" = individual borrows BUT corporation owns collateral (requires proof of ownership)
   - null = ONLY if absolutely no indication from any source

   IMPORTANT: If the broker says "personal loan", "individual", "not corporate", or similar — treat as "personal". Default to "personal" if the borrower appears to be an individual person (not a company/corporation) unless there is explicit mention of corporate ownership.

4. Update the deal summary JSON with any new information from the email and documents.

EXISTING DEAL SUMMARY:
${JSON.stringify(existingSummary, null, 2)}

BROKER'S EMAIL:
---
${emailBody}
---

Attached files: ${attachmentNames}
The supported attachments have been provided above for review.

=== TASK 2: REMINDER EMAIL (only if LTV or ownership type cannot be determined) ===

If you CANNOT determine the LTV (not enough info to calculate) OR you CANNOT determine the ownership type (personal vs corporate), write a short email as Vienna (Franco's assistant) asking the broker for the missing information. Be concise and direct.

If you CAN determine both LTV and ownership type, skip Task 2 entirely — do not generate a reminder email.

EMAIL FORMATTING:
- Write as Vienna in first person
- Use HTML with <p> tags
- Sign off as: Vienna\\nPrivate Mortgage Link

=== RESPONSE FORMAT ===

---ANALYSIS---
{
  "has_application_form": boolean,
  "has_pnw_statement": boolean,
  "forms_complete": boolean,
  "missing_forms": ["list of missing form names, empty if complete"],
  "ownership_type": "personal | corporate | corporate_mixed | null",
  "borrower_entity_type": "individual | corporation | null",
  "collateral_owner_type": "individual | corporation | null",
  "updated_summary": { ...full updated deal summary JSON using same structure as existing... }
}
---END_ANALYSIS---
---REMINDER_EMAIL---
(HTML reminder email body — ONLY include this section if forms_complete is false)
---END_REMINDER_EMAIL---`,
      });

      const response = await callClaude({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3072,
        messages: [{ role: 'user', content }],
      });

      const text = response.content[0].text;

      // Parse analysis JSON
      const analysisMatch = text.match(/---ANALYSIS---([\s\S]*?)---END_ANALYSIS---/);
      if (!analysisMatch) throw new Error('Could not parse Stage 2 analysis response');
      let jsonText = analysisMatch[1].trim();
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
      }
      const analysis = JSON.parse(jsonText);

      // Parse reminder email (only present if forms incomplete)
      const reminderMatch = text.match(/---REMINDER_EMAIL---([\s\S]*?)---END_REMINDER_EMAIL---/);
      const reminderEmail = reminderMatch ? reminderMatch[1].trim() : null;

      return {
        formsComplete: analysis.forms_complete,
        hasApplicationForm: analysis.has_application_form,
        hasPnwStatement: analysis.has_pnw_statement,
        missingForms: analysis.missing_forms || [],
        ownershipType: analysis.ownership_type,
        borrowerEntityType: analysis.borrower_entity_type,
        collateralOwnerType: analysis.collateral_owner_type,
        updatedSummary: analysis.updated_summary,
        reminderEmail,
      };
    } catch (error) {
      console.error('Claude Stage 2 analysis error:', error);
      throw error;
    }
  },

  // Generate rejection email to broker (LTV > 95%)
  generateRejectionEmail: async (dealSummary) => {
    try {
      const response = await callClaude({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: `You are Vienna, the assistant to Franco Maione, a private mortgage lender at Private Mortgage Link. Write a rejection email to the broker on Franco's behalf.

The deal has been reviewed and unfortunately we are unable to proceed at this time. Write a short, professional rejection email.

TONE:
- Write as Vienna in first person
- Be warm and empathetic — disappointing news should still feel personal and kind
- Do not state the exact LTV percentage
- Genuinely encourage future deals — "We'd love to work together on the next one!"
- Use proper HTML formatting with <p> tags

DEAL DETAILS:
${JSON.stringify(dealSummary, null, 2)}

Return only the HTML email body. Do not include a subject line. Sign off as:
Vienna
Private Mortgage Link`,
        }],
      });

      return response.content[0].text.trim();
    } catch (error) {
      console.error('Claude rejection email error:', error);
      throw error;
    }
  },

  // Generate internal escalation notification to admin (LTV > 80%)
  generateEscalationNotification: async (dealSummary, messages, documents) => {
    try {
      const response = await callClaude({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: `Generate an internal deal review notification email for a private mortgage deal that requires manual review due to LTV exceeding 80%.

This is an internal email — not written as Franco, just a clear summary for review.

IMPORTANT: Do NOT start with raw HTML tags. Start with a clean heading text. Format as clean HTML email.

Sections to include:
1. Heading: "Deal Review Required — LTV: X%" where X is the actual LTV percentage from the deal summary (e.g. "Deal Review Required — LTV: 90%")
2. Borrower, broker, property address, loan amount, actual LTV percentage
3. Loan type and purpose
4. Exit strategy
5. Documents received — just mention the count and that they are attached as a zip file to this email
6. Key risks or notes
7. A brief recommendation on what to look for

8. FULL EMAIL CONVERSATION — include all broker emails below so Franco can review the full context. Label each with date and direction (inbound/outbound).

Note: All documents are attached to this email as a zip file for Franco's review.

At the bottom, include this action section:
<hr>
<h3>Action Required</h3>
<p>Reply to this email with one of the following:</p>
<ul>
<li><strong>APPROVED</strong> — deal will move forward and broker will be asked for full document package</li>
<li><strong>Any other reply</strong> — your message will be polished and forwarded to the broker by Vienna</li>
</ul>

DEAL SUMMARY:
${JSON.stringify(dealSummary, null, 2)}

EMAIL CONVERSATION:
${messages.map(m => `[${m.direction.toUpperCase()}] ${m.created_at}\nSubject: ${m.subject}\n${m.body}`).join('\n\n---\n\n')}

DOCUMENTS ON FILE:
${documents.map(d => `- ${d.file_name} (${d.classification || 'unclassified'})`).join('\n') || 'None yet'}

Return only the HTML email body.`,
        }],
      });

      return response.content[0].text.trim();
    } catch (error) {
      console.error('Claude escalation notification error:', error);
      throw error;
    }
  },

  // Generate Stage 3 document request email — different checklist for personal vs corporate
  generateDocumentRequestEmail: async (dealSummary, ownershipType, hasApp, hasPnw, existingDocs) => {
    try {
      const receivedClassifications = existingDocs.map(d => d.classification).filter(Boolean);

      const response = await callClaude({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `You are Vienna, the assistant to Franco Maione, a private mortgage lender at Private Mortgage Link. Write an email to the broker on Franco's behalf.

The deal has been preliminarily approved (LTV is within acceptable range). Now we need the full document package from the broker before proceeding.

OWNERSHIP TYPE: ${ownershipType}

DOCUMENTS ALREADY RECEIVED (do NOT ask for these again):
${receivedClassifications.length > 0 ? receivedClassifications.join(', ') : 'None classified yet'}

Raw file list already on file:
${existingDocs.map(d => d.file_name).join(', ') || 'None'}

FORMS STATUS:
- Loan Application Form: ${hasApp ? 'RECEIVED' : 'NOT received'}
- PNW Statement Form: ${hasPnw ? 'RECEIVED' : 'NOT received'}

REQUIRED DOCUMENTS — request ONLY what has NOT been received:

${ownershipType === 'corporate' || ownershipType === 'corporate_mixed' ? `CORPORATE DEAL CHECKLIST:
- Loan Application Form (if not received — mention they can use their own or Franco's template)
- PNW Statement Form (if not received — mention they can use their own or Franco's template)
- Government-Issued ID
- Property Appraisal
- Property Tax Assessment and current balance
- Notice of Assessments (NOAs, individual)
- Current Mortgage Balance Statement
- Income Verification
- Corporate Financial Statements ('24, '23, '25)
- T1s for key principals ('24, '23)
- Borrower Resume and Building/Development Experience (if applicable)` : `PERSONAL DEAL CHECKLIST:
- Loan Application Form (if not received — mention they can use their own or Franco's template)
- PNW Statement Form (if not received — mention they can use their own or Franco's template)
- Government-Issued ID
- Property Appraisal
- Property Tax Assessment and current balance
- Notice of Assessments (NOAs, individual)
- Current Mortgage Balance Statement
- Income Verification`}

DEAL SUMMARY:
${JSON.stringify(dealSummary, null, 2)}

EMAIL RULES:
- Write as Vienna in first person
- Warm and encouraging — the deal is moving forward, so sound excited! "Great news!" / "Things are looking good!"
- Acknowledge the deal looks good so far and list what you still need
- For the application form and PNW form, mention that they can use their own forms if they have them already filled out — our templates were provided as an alternative
- Use proper HTML formatting: <p> tags, <ul>/<li> for the document list
- Sign off as: Vienna\\nPrivate Mortgage Link

Return only the HTML email body. Do not include a subject line.`,
        }],
      });

      return response.content[0].text.trim();
    } catch (error) {
      console.error('Claude document request email error:', error);
      throw error;
    }
  },

  // Generate info request email when LTV or ownership type can't be determined
  generateInfoRequestEmail: async (dealSummary, missing, hasApp = false, hasPnw = false) => {
    try {
      const missingItems = [];
      if (missing.ltv) missingItems.push('enough information to calculate the LTV (loan amount, property value, existing mortgage balance)');
      if (missing.ownershipType) missingItems.push('whether the borrower is an individual or a corporation, and who owns the collateral property');

      const missingForms = [];
      if (!hasApp) missingForms.push('Loan Application Form');
      if (!hasPnw) missingForms.push('PNW Statement Form (Personal Net Worth)');

      const formsNote = missingForms.length > 0
        ? `\n\nAlso, the following forms have not been received yet:\n${missingForms.map(f => `- ${f}`).join('\n')}\nMention that they can use their own forms if they already have them filled out — our templates were provided as an alternative.`
        : '';

      const response = await callClaude({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: `You are Vienna, the assistant to Franco Maione, a private mortgage lender at Private Mortgage Link. Write a short follow-up email to the broker.

We need a bit more information before we can move forward. Specifically, we still need:
${missingItems.map(i => `- ${i}`).join('\n')}${formsNote}

DEAL SUMMARY:
${JSON.stringify(dealSummary, null, 2)}

EMAIL RULES:
- Write as Vienna in first person
- Warm and friendly — make it feel like a quick check-in, not a demand
- Use proper HTML formatting with <p> tags
- Sign off as: Vienna\\nPrivate Mortgage Link

Return only the HTML email body. Do not include a subject line.`,
        }],
      });

      return response.content[0].text.trim();
    } catch (error) {
      console.error('Claude info request email error:', error);
      throw error;
    }
  },

  // Generate follow-up reminder email for stale deals (broker hasn't replied)
  generateFollowUpReminder: async (dealSummary, daysSilent, reminderNumber, dealStatus) => {
    try {
      const whatWeNeed = dealStatus === 'documents_requested'
        ? 'the completed Loan Application Form and PNW Statement, along with any missing information (LTV details, ownership type)'
        : 'the outstanding documents listed in our previous email';

      const response = await callClaude({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: `You are Vienna, the assistant to Franco Maione, a private mortgage lender at Private Mortgage Link. Write a short, friendly follow-up email to a broker who hasn't replied.

It has been ${Math.round(daysSilent)} days since we last heard from them. This is follow-up reminder #${reminderNumber}.

We are still waiting for: ${whatWeNeed}

DEAL DETAILS:
Borrower: ${dealSummary?.borrower_name || 'Unknown'}
Broker: ${dealSummary?.broker_name || 'Unknown'}

TONE:
- Reminder #1: Friendly and casual — "Hey! Just wanted to check in" / "Hope you're having a great week!"
- Reminder #2: Still warm but a little more direct — "We'd love to keep this moving!" / "Just wanted to make sure this didn't slip through the cracks!"
- Reminder #3: Kind but clear — "We'll go ahead and close this file for now, but no worries at all — feel free to reach out anytime and we'd be happy to pick it back up!"

EMAIL RULES:
- Write as Vienna in first person
- Keep it SHORT — 2-3 sentences max
- Do NOT re-list every document needed — just reference "the items we previously requested"
- Use proper HTML formatting with <p> tags
- Sign off as: Vienna\\nPrivate Mortgage Link

Return only the HTML email body.`,
        }],
      });

      return response.content[0].text.trim();
    } catch (error) {
      console.error('Claude follow-up reminder error:', error);
      throw error;
    }
  },

  // Classify an image using Claude vision (for images that couldn't be classified by filename)
  classifyImage: async (base64Content, contentType, fileName) => {
    try {
      const response = await callClaude({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 50,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: contentType, data: base64Content },
            },
            {
              type: 'text',
              text: `Classify this document image. Reply with ONLY one of these categories, nothing else:
government_id, appraisal, property_tax, noa, mortgage_statement, income_proof, credit_report, insurance, corporate_financials, tax_return, borrower_resume, loan_application, pnw_statement, other

File name: ${fileName}`,
            },
          ],
        }],
      });

      const result = response.content[0].text.trim().toLowerCase();
      const validCategories = [
        'government_id', 'appraisal', 'property_tax', 'noa', 'mortgage_statement',
        'income_proof', 'credit_report', 'insurance', 'corporate_financials',
        'tax_return', 'borrower_resume', 'loan_application', 'pnw_statement', 'other',
      ];
      return validCategories.includes(result) ? result : 'other';
    } catch (error) {
      console.error('Claude image classification error:', error.message);
      return 'other';
    }
  },

  // Generate comprehensive lead summary for Franco — reads all documents + deal data
  generateLeadSummary: async (dealSummary, ownershipType, documents, missingDocs) => {
    try {
      // Build document text sections from extracted data
      const docSections = documents
        .filter(d => d.extracted_data?.text)
        .map(d => `--- ${d.classification || 'unclassified'}: ${d.file_name} ---\n${d.extracted_data.text}`)
        .join('\n\n');

      const receivedFiles = documents.map(d => `${d.file_name} (${d.classification || 'unclassified'})`);
      const isComplete = missingDocs.length === 0;

      const response = await callClaude({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: `You are a senior mortgage underwriting analyst preparing a comprehensive lead summary for Franco Maione, a private mortgage lender at Private Mortgage Link.

Your job is to read ALL available information — the deal summary, every extracted document, and the overall file — and produce a structured, lender-ready lead summary.

This summary must be usable in three ways:
1. Copied and pasted directly into an email to a lender or underwriter
2. Exported as a one-page (or two-page) PDF
3. Stored as the authoritative snapshot of the file

FORMAT: Return the summary as HTML using the exact sections below. Use <h2> for section headers, <p> for text, <table> for the deal snapshot, <ul>/<li> for lists.

=== SECTION 1: DEAL SNAPSHOT (Top of Page) ===
Present as a clean HTML table with label/value rows:
- Property Address
- City / Province
- Loan Amount Requested
- Mortgage Position (1st / 2nd / etc.)
- Appraised Value (or Tax Assessment if appraisal pending)
- LTV (combined if applicable)
- Loan Term Requested
- Borrower Type (Personal / Corporate / Trust)
- Ownership Type: ${ownershipType}

=== SECTION 2: BORROWER OVERVIEW ===
A short paragraph explaining who the borrower is:
- Personal borrower or corporate entity
- If corporate: nature of the business or holding structure
- Experience level (investor, owner-occupied, developer, etc.)
- Any relevant background that supports credibility
This is context, not a life story.

=== SECTION 3: LOAN PURPOSE ===
Clearly and plainly stated. Examples: Refinance to consolidate debt, bridge financing, equity take-out, etc.
Ambiguity here creates immediate friction — be specific.

=== SECTION 4: EXIT STRATEGY ===
This is often the most important section for a private lender.
- How will the loan be repaid at or before maturity?
- Sale, refinance, or capital event
- Expected timeline
- Why the exit is realistic
- If the exit relies on a refinance: what improves between now and maturity?
- If the exit relies on a sale: why are value and liquidity credible?
If no exit strategy has been provided, state that clearly and flag it as a critical gap.

=== SECTION 5: COLLATERAL & VALUATION ===
- Property type
- Appraisal value (date and source if available)
- CMA support (if applicable)
- Market commentary if relevant
This answers: "If this goes sideways, am I protected?"

=== SECTION 6: FINANCIAL SNAPSHOT ===
Not raw numbers — interpretation:
- Income context (strong / weak / not relied upon)
- Credit score and context (clean / bruised / not a primary driver)
- Net worth overview (from PNW statement if available)
- Any known weaknesses, stated clearly
Hidden issues destroy trust — be transparent.

=== SECTION 7: RISK FACTORS & MITIGANTS ===
- Identify the main risks upfront
- Immediately explain how each is mitigated (equity, additional collateral, structure, term, pricing)
- Underwriters appreciate honesty more than perfection

=== SECTION 8: DEAL RATING ===
Rate this deal as one of: GREAT, OKAY, or WEAK BUT WORKABLE.

GREAT: Conservative LTV (60% or less), desirable/liquid property, clear exit, consistent file, responsive/transparent borrower. Multiple layers of protection. Moves quickly, prices well.

OKAY: One or two elements are weak but not fatal. Higher LTV (up to 80%), limited debt serviceability, credit issues. Exit strategy still believable. Needs lender-specific structuring.

WEAK BUT WORKABLE: Multiple risk factors (high LTV 80%+, poor credit, little income) BUT at least one strong compensating factor (exceptional property, additional collateral, forced-sale protection). Highly lender-specific, requires careful storytelling.

Explain your rating in 2-3 sentences.

=== SECTION 9: DOCUMENTS INCLUDED ===
A checklist showing what has been received and what is missing:
${receivedFiles.map(f => `- [RECEIVED] ${f}`).join('\n')}
${missingDocs.map(d => `- [MISSING] ${d}`).join('\n')}

${!isComplete ? `\nIMPORTANT: This file is NOT yet complete. The following documents are still outstanding: ${missingDocs.join(', ')}. Clearly note this at the top of the summary with a status indicator.` : 'This file is COMPLETE — all required documents have been received.'}

=== INPUT DATA ===

DEAL SUMMARY (from intake analysis):
${JSON.stringify(dealSummary, null, 2)}

EXTRACTED DOCUMENT TEXT:
${docSections || 'No extracted text available from documents.'}

=== INSTRUCTIONS ===
- Read EVERYTHING — the deal summary AND all document text
- Cross-reference documents against each other for consistency
- If information conflicts between documents, note the discrepancy
- Use underwriting language, not marketing language
- Be thorough but scannable — a lender should understand the deal from this summary alone
- ${!isComplete ? 'Start the summary with a clear banner: "FILE STATUS: INCOMPLETE — Outstanding items listed below"' : 'Start the summary with: "FILE STATUS: COMPLETE — Ready for Review"'}

Return only the HTML. Do not include a subject line.`,
        }],
      });

      return response.content[0].text.trim();
    } catch (error) {
      console.error('Claude lead summary error:', error);
      throw error;
    }
  },

  // Strip quoted/forwarded text from email replies (lines starting with > or "On ... wrote:" blocks)
  stripQuotedText: (text) => {
    if (!text) return '';
    const lines = text.split('\n');
    const freshLines = [];
    for (const line of lines) {
      // Stop at "On <date> ... wrote:" or "---------- Forwarded message" or similar
      if (/^on .+ wrote:\s*$/i.test(line.trim())) break;
      if (/^-{3,}\s*(original message|forwarded message)/i.test(line.trim())) break;
      if (/^from:\s/i.test(line.trim()) && freshLines.length > 0 && /^(sent|to|date|subject):\s/i.test(lines[lines.indexOf(line) + 1]?.trim() || '')) break;
      // Skip individually quoted lines (> prefix)
      if (/^\s*>/.test(line)) continue;
      freshLines.push(line);
    }
    return freshLines.join('\n').trim();
  },

  // Parse admin reply to determine intent using Claude (handles nuanced replies)
  parseAdminReply: async (replyText) => {
    const stripped = module.exports.stripQuotedText(replyText);
    const text = (stripped || replyText || '').trim();

    // Fast path: single-word replies don't need AI
    if (/^(approved?|yes|go ahead|proceed|accepted?)\s*[.!]?\s*$/i.test(text)) {
      return { intent: 'approved', message: text };
    }
    if (/^(reject(ed)?|decline[d]?|den(y|ied)|pass|kill)\s*[.!]?\s*$/i.test(text)) {
      return { intent: 'rejected', message: text };
    }

    // Use Claude for anything ambiguous
    try {
      const response = await callClaude({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 20,
        messages: [{
          role: 'user',
          content: `You are classifying an admin's email reply about a mortgage deal. The admin is deciding whether to approve, reject, or send conditions/notes to the broker.

Reply with EXACTLY one word: APPROVED, REJECTED, or CONDITIONS.

Rules:
- APPROVED = the admin clearly wants the deal to move forward with NO caveats or additional requirements
- REJECTED = the admin clearly wants to turn down/kill/pass on this deal entirely
- CONDITIONS = anything else — questions, notes, partial approval with conditions, requests for more info, instructions to forward to broker

Examples:
- "Yes, go ahead but ask about the appraisal" → CONDITIONS (has caveats)
- "Approved" → APPROVED
- "I'd like to proceed, but reject the second mortgage portion" → CONDITIONS (mixed intent)
- "Pass on this one" → REJECTED
- "Not interested" → REJECTED
- "Let's do it" → APPROVED
- "Ask them for updated financials" → CONDITIONS

ADMIN'S REPLY:
"${text.replace(/"/g, '\\"')}"`,
        }],
      });

      const result = response.content[0].text.trim().toLowerCase();
      if (result.includes('approved')) return { intent: 'approved', message: text };
      if (result.includes('rejected')) return { intent: 'rejected', message: text };
      return { intent: 'conditions', message: text };
    } catch (error) {
      console.error('Claude intent parsing failed, defaulting to conditions:', error.message);
      // Safe default: treat as conditions (Franco's message gets forwarded, no irreversible action)
      return { intent: 'conditions', message: text };
    }
  },

  // Generate polished email to broker based on admin's notes/conditions
  generateAdminResponseEmail: async (dealSummary, adminNotes) => {
    try {
      const response = await callClaude({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: `You are Vienna, the assistant to Franco Maione, a private mortgage lender at Private Mortgage Link. Write an email to the broker on Franco's behalf.

Franco has reviewed a deal and has the following notes/instructions for the broker:

FRANCO'S NOTES:
"${adminNotes}"

DEAL DETAILS:
Borrower: ${dealSummary?.borrower_name || 'Unknown'}
Broker: ${dealSummary?.broker_name || 'Unknown'}
LTV: ${dealSummary?.ltv_percent || 'Unknown'}%

Write a warm, friendly email to the broker conveying Franco's message. Write as Vienna in first person.
- Keep Franco's intent and key points, but make it approachable and personable
- Do NOT add information Franco didn't mention
- Use proper HTML formatting with <p> tags
- Keep it short

Sign off as:
Vienna
Private Mortgage Link

Return only the HTML email body.`,
        }],
      });

      return response.content[0].text.trim();
    } catch (error) {
      console.error('Claude admin response email error:', error);
      throw error;
    }
  },

  // Update deal summary with new info from follow-up emails
  updateDealSummary: async (emailBody, attachments = [], existingSummary, savedDocs = []) => {
    try {
      const content = await buildContentBlocks(attachments, savedDocs);

      const attachmentNames = attachments.map(a => a.Name).join(', ');
      const attachmentNote = attachments.length > 0
        ? `\nAttached files: ${attachmentNames}`
        : '';

      content.push({
        type: 'text',
        text: `You are a deal analyst for Private Mortgage Link, a private mortgage lender.

Analyze the follow-up email and any attachments below, then UPDATE the existing deal summary with any new information.

EXISTING DEAL SUMMARY:
${JSON.stringify(existingSummary, null, 2)}

NEW EMAIL CONTENT:
---
${emailBody}
---${attachmentNote}

Return ONLY valid JSON with this structure (use null for unknown fields, do not guess):
{
  "borrower_name": "string",
  "broker_name": "string or null",
  "broker_company": "string or null",
  "property_address": "string or null",
  "property_type": "string or null",
  "property_value": number or null,
  "loan_amount_requested": number or null,
  "existing_mortgage_balance": number or null,
  "total_debt": number or null,
  "ltv_percent": number or null,
  "loan_type": "first mortgage | second mortgage | refinance | construction | other",
  "purpose": "string describing why they need the loan",
  "exit_strategy": "string or null",
  "income_details": "string or null",
  "documents_received": ["list of document names received"],
  "documents_still_needed": ["list of documents still missing"],
  "key_risks_or_notes": "string - any red flags, urgency, or notable details",
  "summary": "9-10 sentence plain English summary of the deal so far"
}

IMPORTANT:
- MERGE new information into the existing data — do not lose previously known details
- Calculate LTV if enough info is provided: (existing mortgage + requested loan) / property value * 100
- Be specific about documents received vs still needed
- The summary field should read like a brief to a lender — include all key facts`,
      });

      const response = await callClaude({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        messages: [{ role: 'user', content }],
      });

      let text = response.content[0].text.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
      }
      return JSON.parse(text);
    } catch (error) {
      console.error('Claude deal summary update error:', error);
      throw error;
    }
  },

  // Generate document review notification for Franco (when docs are incomplete in Stage 3)
  generateDocReviewNotification: async (dealSummary, messages, documents, missingDocs) => {
    try {
      const response = await callClaude({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: `Generate an internal document review email for Franco Maione, a private mortgage lender.

A broker has submitted documents for a deal but some are still missing. Franco needs to review what's been received and decide how to proceed.

IMPORTANT: Do NOT include \`\`\`html, <html>, <head>, <body>, or <!DOCTYPE> tags. Start directly with content.

Sections to include:
1. Heading: "Document Review Required — ${dealSummary?.borrower_name || 'Unknown'}"
2. Deal details: borrower, broker, LTV, loan type
3. Documents received so far (${documents.length} documents attached as zip)
4. Documents still missing: ${missingDocs.join(', ')}
5. Full email conversation for context

At the bottom, include this action section:
<hr>
<h3>Action Required</h3>
<p>Reply to this email with one of the following:</p>
<ul>
<li><strong>APPROVED</strong> — deal will be marked as complete even with missing documents</li>
<li><strong>Any other reply</strong> — your message will be polished and forwarded to the broker by Vienna</li>
</ul>

DEAL SUMMARY:
${JSON.stringify(dealSummary, null, 2)}

EMAIL CONVERSATION:
${messages.map(m => `[${m.direction.toUpperCase()}] ${m.created_at}\nSubject: ${m.subject}\n${m.body}`).join('\n\n---\n\n')}

DOCUMENTS ON FILE:
${documents.map(d => `- ${d.file_name} (${d.classification || 'unclassified'})`).join('\n') || 'None yet'}

MISSING DOCUMENTS:
${missingDocs.join(', ')}

Return only the inner HTML content.`,
        }],
      });

      let html = response.content[0].text.trim();
      html = html.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '');
      return html.trim();
    } catch (error) {
      console.error('Claude doc review notification error:', error);
      throw error;
    }
  },

  // Generate daily summary email for Franco
  generateDailySummary: async (summaryData) => {
    try {
      const response = await callClaude({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: `Generate a daily summary email for Franco Maione, a private mortgage lender.

This is an internal operations email — clean, scannable, and actionable.

Format as clean HTML. Include these sections:

1. **Overview** — Total active deals, total emails received in the past 24 hours.

2. **Deals Requiring Your Action** — List any deals with status "ltv_escalated" that need Franco's approval/rejection. Include borrower name, LTV, and how long it's been waiting.

3. **Emails Received (Past 24 Hours)** — ONLY inbound emails from brokers. For each, show: borrower name, subject, time, and a brief summary of the email content. Do NOT include outbound/sent emails.

4. **All Current Deals** — List ALL active deals with: borrower name, broker email, status, LTV if known, and days since last update.

5. **Stale Deals** — Flag any deals with no activity for 3+ days.

6. **Automated Follow-Up Reminders** — If any automated reminders were sent today by Vienna, list them (borrower name, broker email, which reminder # it was, and how many days silent). Also flag any deals that have hit the maximum 3 reminders with no response — these need your personal attention or a decision to close.

Keep it concise. Use tables or bullet points. No fluff.

IMPORTANT: Do NOT include \`\`\`html, <html>, <head>, <body>, or <!DOCTYPE> tags. Start directly with content like <h2>. Return only inner HTML.

DATA:
${JSON.stringify(summaryData, null, 2)}`,
        }],
      });

      let html = response.content[0].text.trim();
      html = html.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '');
      html = html.replace(/<!DOCTYPE[^>]*>/i, '').replace(/<\/?html[^>]*>/gi, '').replace(/<\/?head>[\s\S]*?<\/head>/gi, '').replace(/<\/?body[^>]*>/gi, '');
      return html.trim();
    } catch (error) {
      console.error('Claude daily summary error:', error);
      throw error;
    }
  },
};
