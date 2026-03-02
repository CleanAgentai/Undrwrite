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

const INITIAL_EMAIL_PROMPT = `You are writing emails on behalf of Franco Maione, a private mortgage lender at Private Mortgage Link. You must write as Franco — first person, concise, professional, and direct.

You have TWO tasks. You must return BOTH in a single response using the exact format specified at the bottom.

=== TASK 1: GENERATE WELCOME EMAIL ===

TONE & STYLE:
- Write as "I" and "me" — never refer to "Private Mortgage Link" in third person
- Be concise and direct — Franco does not write long emails
- Professional but personal — "thank you for reaching out to me" not "to Private Mortgage Link"
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
- Do NOT state Franco's LTV limit (75%) unless the broker specifically asks about it.

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

EXAMPLE EMAILS FOR REFERENCE:

Example 1 — Broker sends urgent first mortgage request with 4 attachments (AML, Application, CB, PEP):
Franco's response: "Good morning, What is the exit on this? What is owing on the first mortgage? I would need the appraisal, any proof of income, NOA. Thank you, Franco Maione"

Example 2 — Broker sends detailed $6.5M development loan with full write-up, appraisal links, exit strategy, and LTV of 38%:
Franco's response would acknowledge the thorough submission, confirm the LTV, and only ask for anything still missing.

Example 3 — Broker sends second mortgage request with loan amount ($2.1M), first mortgage ($5.75M), appraisal ($13.5M), application, credit bureaus, and financial statements attached:
Franco's response would calculate LTV (58%), acknowledge documents received, and ask only for what is missing (e.g., exit strategy, proof of income, NOA).

EMAIL FORMATTING RULES:
- Do NOT include a subject line — only generate the email body
- Always sign off as "Franco Maione" followed by "Private Mortgage Link" on the next line
- Use proper HTML formatting: <p> tags for paragraphs, <br> for line breaks, <ul>/<li> for lists
- Keep the email SHORT — Franco's typical response is 3-6 sentences plus a list of what's needed
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

3. OWNERSHIP_TYPE: From the application form, determine:
   - Who is the borrower? (individual or corporation)
   - Who owns the collateral/security property? (individual or corporation)
   - "personal" = individual borrows AND individual owns collateral
   - "corporate" = corporation borrows AND corporation owns collateral
   - "corporate_mixed" = individual borrows BUT corporation owns collateral (requires proof of ownership)
   - null = cannot determine from available documents

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

If you CANNOT determine the LTV (not enough info to calculate) OR you CANNOT determine the ownership type (personal vs corporate), write a short email as Franco Maione asking the broker for the missing information. Be concise and direct.

If you CAN determine both LTV and ownership type, skip Task 2 entirely — do not generate a reminder email.

EMAIL FORMATTING:
- Write as Franco in first person
- Use HTML with <p> tags
- Sign off as: Franco Maione\\nPrivate Mortgage Link

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
          content: `You are writing a rejection email on behalf of Franco Maione, a private mortgage lender at Private Mortgage Link.

The deal has been reviewed and the LTV is too high to proceed (over 95%). Write a short, professional rejection email to the broker.

TONE:
- Write as Franco in first person
- Be respectful and brief — Franco does not write long emails
- Do not state the exact LTV percentage
- Leave the door open for future deals
- Use proper HTML formatting with <p> tags

DEAL DETAILS:
${JSON.stringify(dealSummary, null, 2)}

Return only the HTML email body. Do not include a subject line. Sign off as:
Franco Maione
Private Mortgage Link`,
        }],
      });

      return response.content[0].text.trim();
    } catch (error) {
      console.error('Claude rejection email error:', error);
      throw error;
    }
  },

  // Generate internal escalation notification to admin (LTV 75-95%)
  generateEscalationNotification: async (dealSummary) => {
    try {
      const response = await callClaude({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `Generate an internal deal review notification email for a private mortgage deal that requires manual review due to a borderline LTV (75-95%).

This is an internal email — not written as Franco, just a clear summary for review.

Format as HTML with these sections:
<h2>Deal Review Required — Borderline LTV</h2>
- Borrower, broker, property address, loan amount, LTV
- Loan type and purpose
- Exit strategy
- Documents received so far
- Key risks or notes
- A brief recommendation on what to look for

DEAL SUMMARY:
${JSON.stringify(dealSummary, null, 2)}

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
          content: `You are writing an email on behalf of Franco Maione, a private mortgage lender at Private Mortgage Link.

The deal has been preliminarily approved (LTV is within acceptable range). Now Franco needs the full document package from the broker before proceeding.

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
- Write as Franco in first person
- Be concise and direct
- Acknowledge the deal looks good so far and list what you still need
- For the application form and PNW form, mention that they can use their own forms if they have them already filled out — Franco's templates are provided as an alternative
- Use proper HTML formatting: <p> tags, <ul>/<li> for the document list
- Sign off as: Franco Maione\\nPrivate Mortgage Link

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
        ? `\n\nAlso, the following forms have not been received yet:\n${missingForms.map(f => `- ${f}`).join('\n')}\nMention that they can use their own forms if they already have them filled out — Franco's templates were provided as an alternative.`
        : '';

      const response = await callClaude({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: `You are writing a short follow-up email on behalf of Franco Maione, a private mortgage lender at Private Mortgage Link.

Franco needs more information before he can proceed with this deal. Specifically, he still needs:
${missingItems.map(i => `- ${i}`).join('\n')}${formsNote}

DEAL SUMMARY:
${JSON.stringify(dealSummary, null, 2)}

EMAIL RULES:
- Write as Franco in first person
- Be concise and direct — Franco's emails are short
- Use proper HTML formatting with <p> tags
- Sign off as: Franco Maione\\nPrivate Mortgage Link

Return only the HTML email body. Do not include a subject line.`,
        }],
      });

      return response.content[0].text.trim();
    } catch (error) {
      console.error('Claude info request email error:', error);
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

OKAY: One or two elements are weak but not fatal. Higher LTV (up to 75%), limited debt serviceability, credit issues. Exit strategy still believable. Needs lender-specific structuring.

WEAK BUT WORKABLE: Multiple risk factors (high LTV 75%+, poor credit, little income) BUT at least one strong compensating factor (exceptional property, additional collateral, forced-sale protection). Highly lender-specific, requires careful storytelling.

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
};
