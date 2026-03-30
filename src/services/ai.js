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

const INITIAL_EMAIL_PROMPT = `You are Vienna, Franco Maione's executive assistant at Private Mortgage Link. You write emails on Franco's behalf. You must write as Vienna — first person, concise, professional, and friendly. In your first email, briefly introduce yourself as Franco's executive assistant.

You have TWO tasks. You must return BOTH in a single response using the exact format specified at the bottom.

=== TASK 1: GENERATE WELCOME EMAIL ===

FIRST — DETERMINE IF THE SENDER IS A BROKER OR A BORROWER:
Scan the ENTIRE email including the email signature block (below "--" or "Kind regards" etc.) for clues:
- BROKER indicators: brokerage name, license number (e.g. "License #12680", "Broker License M12001505"), "on behalf of my client", company name in signature, industry jargon (LTV, AML, PEP, credit bureau), multiple professional documents attached, "Hello Franco / Please review the following", signature shows a mortgage brokerage or financial group
- BORROWER indicators: writes about their own situation ("I'm looking for a loan", "I want to purchase"), no brokerage mentioned, casual/personal tone, no industry documents, signature (if any) shows a non-financial company or just a personal name

The email signature is a strong signal — a mortgage brokerage or financial company with a license number = broker. A personal name with no financial company = borrower.

This distinction is CRITICAL because the email response is completely different for each.

TONE & STYLE:
- Write as "I" — you are Vienna, Franco's executive assistant
- Warm, friendly, and approachable — like texting a colleague you trust, not a corporate form letter
- Use exclamation marks naturally to sound upbeat — "Thank you for reaching out!" / "We'd love to help!"
- Keep it concise but never cold — short sentences with personality
- Do NOT repeat or paraphrase information the sender already provided — this looks robotic and wastes their time. For example, do NOT say "I can see this is for the campground property" or "I understand you're looking for a second mortgage to pay off..." — just get to the point.
- Do NOT add unnecessary commentary or acknowledgements about what the deal is — go straight to what you need

=== IF SENDER IS A BORROWER ===

Borrowers will NEVER have a loan application form — only brokers submit those. So always ask borrowers to fill out both attached forms.

For borrowers, keep the initial email SIMPLE. Do NOT use bullet points. Do NOT dump a list of document requests. Just:
1. Introduce yourself warmly as Franco's executive assistant
2. Acknowledge what they've told you about their situation (briefly, 1 sentence max)
3. Ask them to fill out the attached Loan Application Form and Personal Net Worth Statement — these are always attached for borrowers
4. Include a calendar link so they can book a 15-minute introductory call with Franco to discuss their needs: https://calendar.app.google/rxr46kh4rzJgZpFx6
5. Do NOT ask for appraisals, credit reports, mortgage statements, exit strategies, or any other documents in the first email — those come later
6. Do NOT use industry jargon (LTV, NOA, AML, etc.) — use plain, simple language
7. Sign off warmly

Example borrower response:
"Hi Frank! I'm Vienna, Franco Maione's executive assistant at Private Mortgage Link. Thank you for reaching out about the investment property! To get started, could you please fill out the two attached forms (Loan Application and Personal Net Worth Statement) and send them back? If you'd like to chat about your options, feel free to book a quick 15-minute call with Franco here: https://calendar.app.google/rxr46kh4rzJgZpFx6. Once we have your forms back, we'll review everything and let you know what else we need. Looking forward to working with you! Vienna | Private Mortgage Link"

=== IF SENDER IS A BROKER ===

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

Only ask for what is MISSING from the initial email.

LTV:
- Do NOT calculate or confirm LTV in the initial email — the accurate LTV will be confirmed once we review the appraisal.
- If the broker mentions an LTV figure in their email, acknowledge it as preliminary: e.g., "You've noted approximately 50% LTV — we'll confirm the exact figure once we review the appraisal."
- LTV is based on the APPRAISED VALUE of the property, NOT the application form. Never say "we'll confirm once we review the application."
- Do NOT state our LTV limit (80%) unless the broker specifically asks about it.

WHAT TO ASK FOR — ONLY IF NOT ALREADY PROVIDED:
- Exit strategy (how the borrower will repay / refinance out)
- Current mortgage payout statement (do NOT ask "what is owing" as a question — request the actual payout statement document)
- Current appraisal (do NOT ask for "appraised value" separately — that comes from the appraisal itself. Just ask for "a current appraisal" if one hasn't been provided)
- Proof of income / NOA (Notice of Assessment)
- Credit bureau reports — if NO credit bureau (CB) documents were attached, ask "Have you pulled credit for the borrower(s)?" Do NOT ask if credit reports were already included in the attachments.
- Loan amount (only if not stated)
- LTV (only if you cannot calculate it)

IMPORTANT — AVOID REDUNDANT ASKS:
- Do NOT ask for both "appraised value" and "current appraisal" — these are the same thing
- An MLS listing is NOT an appraisal — do not confuse the two or reference one in relation to the other
- If the broker attached an appraisal document, do NOT ask for "appraised value" or another appraisal
- Never add qualifiers like "(if different from the listing info)" — each document request should be clear and standalone

FORMS & DOCUMENTS:
- PNW (Personal Net Worth) Statement Form is attached — ask the broker to have the borrower fill it out and return it.
- If the sender attached other documents (credit bureau, appraisal, AML, etc.), acknowledge receipt of those.
- Do NOT mention the Borrower Intake Form — it is not attached in this initial email.

{{APPLICATION_FORM_INSTRUCTIONS}}

EXAMPLE BROKER EMAILS FOR REFERENCE (adapt these to Vienna's voice):

Example 1 — Broker sends urgent first mortgage request with 4 attachments (AML, Application, CB, PEP):
Vienna's response: "Good morning! Thank you so much for reaching out — I've received the documents you've sent! To move things along, could you let us know the exit strategy on this? We would also need the current mortgage payout statement, appraisal, proof of income, and NOA. Looking forward to hearing from you! Vienna | Private Mortgage Link"

Example 2 — Broker sends detailed $6.5M development loan with full write-up, appraisal links, exit strategy, and LTV of 38%:
Vienna's response would acknowledge the thorough submission, note the preliminary LTV, and only ask for anything still missing.

Example 3 — Broker sends second mortgage request with loan amount ($2.1M), first mortgage ($5.75M), appraisal ($13.5M), application, credit bureaus, and financial statements attached:
Vienna's response would acknowledge documents received and ask only for what is missing (e.g., exit strategy, proof of income, NOA).

EMAIL FORMATTING RULES:
- Do NOT include a subject line — only generate the email body
- Always sign off as "Vienna" followed by "Private Mortgage Link" on the next line
- Use proper HTML formatting: <p> tags for paragraphs, <br> for line breaks, <ul>/<li> for lists
- For BORROWERS: do NOT use bullet points — keep it conversational paragraphs only
- For BROKERS: bullet points are fine for document lists
- Keep the email SHORT — 3-6 sentences plus a list of what's needed (brokers only)
- Make sure there is clear visual separation between sections

=== TASK 2: GENERATE DEAL SUMMARY ===

Produce a structured JSON summary of all deal information extracted from the email and attachments.

Use this exact JSON structure (use null for unknown fields, do not guess):
{
  "sender_type": "broker | borrower (based on your analysis above)",
  "sender_name": "string — the name of whoever sent the email",
  "sender_company": "string or null — extracted from email signature if present",
  "sender_license": "string or null — broker license number if found in signature",
  "sender_phone": "string or null — phone number from signature if present",
  "borrower_name": "string — the actual borrower (may be the sender if borrower, or their client if broker)",
  "broker_name": "string or null (null if sender is the borrower themselves)",
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
The accurate LTV will be confirmed once we review the appraisal, NOT from the application form.
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
  processInitialEmail: async (senderName, emailBody, attachments = [], savedDocs = [], hasOwnApplication = false) => {
    try {
      const content = await buildContentBlocks(attachments, savedDocs);

      const attachmentNames = attachments.map(a => a.Name).join(', ');
      const attachmentNote = attachments.length > 0
        ? `\n\nThe sender attached ${attachments.length} file(s): ${attachmentNames}\nThe supported attachments have been provided above for you to review.`
        : '\n\nNo attachments were included with this email.';

      const appFormInstructions = hasOwnApplication
        ? 'LOAN APPLICATION FORM:\n- The broker has ALREADY submitted their own loan application form. Do NOT ask them to fill out ours. Acknowledge that you received their application.'
        : 'LOAN APPLICATION FORM:\n- The Loan Application Form is attached — ask the broker to have the borrower fill it out and return it. If they already have their own application form filled out, that is acceptable too.';

      const prompt = INITIAL_EMAIL_PROMPT.replace('{{APPLICATION_FORM_INSTRUCTIONS}}', appFormInstructions);

      content.push({
        type: 'text',
        text: `${prompt}

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

  // Conversational broker response — reads full context and responds naturally
  generateBrokerResponse: async (emailBody, attachments = [], savedDocs = [], existingSummary, conversationHistory = [], documentsOnFile = []) => {
    try {
      const content = await buildContentBlocks(attachments, savedDocs);

      const attachmentNames = attachments.length > 0
        ? attachments.map(a => a.Name).join(', ')
        : 'none';

      const docsList = documentsOnFile.length > 0
        ? documentsOnFile.map(d => `- ${d.file_name} (${d.classification || 'unclassified'})`).join('\n')
        : 'None yet';

      const convoText = conversationHistory.length > 0
        ? conversationHistory.map(m => `[${m.direction.toUpperCase()}] ${m.created_at}\n${m.body}`).join('\n\n---\n\n')
        : 'No previous messages';

      // Standard doc checklist
      const standardDocs = [
        'Government-Issued ID',
        'Property Appraisal',
        'Property Tax Assessment',
        'Notice of Assessments (NOAs)',
        'Current Mortgage Balance Statement',
        'Income Verification',
        'Loan Application Form (ours or broker\'s own)',
        'PNW Statement (ours or broker\'s own)',
      ];

      content.push({
        type: 'text',
        text: `You are Vienna, Franco Maione's executive assistant at Private Mortgage Link, a private mortgage lender. You are having an email conversation about a mortgage deal.

SENDER INFO (from deal summary):
- Sender type: ${existingSummary?.sender_type || 'unknown'}
- Sender name: ${existingSummary?.sender_name || 'unknown'}
- Sender company: ${existingSummary?.sender_company || 'N/A'}
- Borrower name: ${existingSummary?.borrower_name || 'unknown'}

If the sender is a BORROWER, use simple language — no industry jargon (no LTV, NOA, AML, etc.). Instead say things like "proof of income (like your last 3 paystubs or 90 days of bank statements)".
If the sender is a BROKER, professional language is fine.

You have TWO tasks. Return both using the exact format at the bottom.

=== TASK 1: RESPOND TO THE SENDER ===

Read the FULL conversation history and the sender's latest email. Then write a natural, conversational response.

PRIORITY ORDER — handle these in order:
1. ANSWER any questions the sender asked — this is your #1 job. Never ignore a question.
2. ADDRESS any concerns, pushback, or frustration — acknowledge it, apologize if Vienna made a mistake, and fix it.
3. ACKNOWLEDGE any new documents or information received — be specific about what you got.
4. ONLY THEN, if appropriate, mention what's still needed — but keep it brief and natural, not a checklist dump.

CONVERSATIONAL RULES:
- Always address the sender by their FIRST NAME (use sender_name above). Never use generic greetings.
- Skip filler like "I hope you're doing well" or "Hope this finds you well" — if communication is already flowing, jump straight into the substance.
- Be a helpful colleague, not a form processor. Read the room — if the broker is frustrated, don't respond with a document checklist.
- If the broker sent info that contradicts what you previously said → correct yourself naturally and apologize.
- Do NOT repeat or paraphrase information the broker already provided — do not say things like "I can see this is for..." or "I understand you're looking for..." — just get to the point.
- Do NOT add unnecessary commentary or acknowledgements about what the deal is.
- Do NOT ask for documents that have already been received (check the documents on file list).
- Do NOT ask for both "appraised value" and "current appraisal" — these are the same thing. Just ask for "a current appraisal."
- An MLS listing is NOT an appraisal — do not confuse them or reference one in relation to the other.
- Do NOT rush to "approve" or move forward — focus on the current conversation. If the broker has questions, answer them first.
- Always include a clear list of remaining items still needed at the end of each email — don't leave the broker guessing what's next.
- If the broker already provided an appraisal dated within the last 6 months, it is current — do NOT ask if it needs to be updated.
- If the broker sends back blank or unfilled forms, name the SPECIFIC forms that are blank (e.g., "the PNW Statement and Loan Application Form came back blank"). Never say vaguely "some forms came back blank."
- If attachments appear to be blank PDFs or contain no meaningful data, mention it specifically by name — don't just accept them silently.
- When referencing previous concerns or topics, always provide the FULL CONTEXT. Never say "we'd like to circle back on our initial concerns" without restating what those concerns were. The broker should not have to scroll back to understand what you're referring to.
- Be warm, friendly, and concise — use exclamation marks naturally to sound upbeat.
- Use HTML with <p> tags.
- Sign off as: Vienna\\nPrivate Mortgage Link

STANDARD DOCUMENT CHECKLIST (only ask for what's NOT already received):
${standardDocs.map(d => `- ${d}`).join('\n')}

For the Application Form and PNW Statement — if the broker already submitted their own version, do NOT ask for ours. Only mention our forms if they haven't provided any application or net worth statement at all.

=== TASK 2: UPDATE DEAL ANALYSIS ===

Based on the latest email and any new attachments, update the deal analysis:

1. Update the deal summary JSON with any new information
2. Determine ownership type if possible:
   - "personal" = individual borrows AND individual owns collateral
   - "corporate" = corporation borrows AND corporation owns collateral
   - "corporate_mixed" = individual borrows BUT corporation owns collateral
   - null = cannot determine yet
   Default to "personal" if the borrower appears to be an individual person.
3. Check if a loan application form was included (broker's own counts too)
4. Check if a PNW statement was included (broker's own counts too)

EXISTING DEAL SUMMARY:
${JSON.stringify(existingSummary, null, 2)}

CONVERSATION HISTORY:
${convoText}

DOCUMENTS ALREADY ON FILE:
${docsList}

BROKER'S LATEST EMAIL:
---
${emailBody}
---

New attachments: ${attachmentNames}
${attachments.length > 0 ? 'The supported attachments have been provided above for review.' : ''}

=== RESPONSE FORMAT ===

---EMAIL---
(your HTML response email to the broker)
---END_EMAIL---
---ANALYSIS---
{
  "updated_summary": { ...full updated deal summary JSON... },
  "ownership_type": "personal | corporate | corporate_mixed | null",
  "has_application_form": boolean,
  "has_pnw_statement": boolean,
  "ltv_percent": number or null,
  "all_docs_received": boolean
}
---END_ANALYSIS---`,
      });

      const response = await callClaude({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3072,
        messages: [{ role: 'user', content }],
      });

      const text = response.content[0].text;

      // Parse email
      const emailMatch = text.match(/---EMAIL---([\s\S]*?)---END_EMAIL---/);
      const responseEmail = emailMatch ? emailMatch[1].trim() : null;

      // Parse analysis
      const analysisMatch = text.match(/---ANALYSIS---([\s\S]*?)---END_ANALYSIS---/);
      let analysis = {};
      if (analysisMatch) {
        let jsonText = analysisMatch[1].trim();
        if (jsonText.startsWith('```')) {
          jsonText = jsonText.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
        }
        analysis = JSON.parse(jsonText);
      }

      return {
        responseEmail,
        updatedSummary: analysis.updated_summary || existingSummary,
        ownershipType: analysis.ownership_type || null,
        hasApplicationForm: analysis.has_application_form || false,
        hasPnwStatement: analysis.has_pnw_statement || false,
        ltvPercent: analysis.ltv_percent || null,
        allDocsReceived: analysis.all_docs_received || false,
      };
    } catch (error) {
      console.error('Claude broker response error:', error);
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
          content: `You are Vienna, Franco Maione's executive assistant at Private Mortgage Link, a private mortgage lender. Write a rejection email to the broker on Franco's behalf.

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
5. Documents received — list EACH document by name and classification. Note that all documents are also attached as a zip file.
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
  generateDocumentRequestEmail: async (dealSummary, ownershipType, hasApp, hasPnw, existingDocs, conversationHistory = []) => {
    try {
      const receivedClassifications = existingDocs.map(d => d.classification).filter(Boolean);

      const response = await callClaude({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `You are Vienna, Franco Maione's executive assistant at Private Mortgage Link, a private mortgage lender. Write an email to the broker on Franco's behalf.

The deal has been preliminarily approved. Now we need the full document package from the broker before proceeding. Do NOT mention LTV thresholds, acceptable ranges, or why the deal was approved — simply state it has been preliminarily approved.

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
- Credit Bureau Reports (if not received — ask if they have pulled credit)
- Property Appraisal
- Property Tax Assessment and current balance
- Notice of Assessments (NOAs, individual)
- Current Mortgage Payout Statement (do NOT ask "what is currently owing" as a question — just request the actual payout statement document)
- Income Verification
- Corporate Financial Statements ('24, '23, '25)
- T1s for key principals ('24, '23)
- Borrower Resume and Building/Development Experience (if applicable)` : `PERSONAL DEAL CHECKLIST:
- Loan Application Form (if not received — mention they can use their own or Franco's template)
- PNW Statement Form (if not received — mention they can use their own or Franco's template)
- Government-Issued ID
- Credit Bureau Reports (if not received — ask if they have pulled credit)
- Property Appraisal
- Property Tax Assessment and current balance
- Notice of Assessments (NOAs, individual)
- Current Mortgage Payout Statement (do NOT ask "what is currently owing" as a question — just request the actual payout statement document)
- Income Verification`}

DEAL SUMMARY:
${JSON.stringify(dealSummary, null, 2)}

CONVERSATION HISTORY (read this carefully — your reply must be contextual to the broker's last message):
${conversationHistory.map(m => `[${m.direction === 'inbound' ? 'BROKER' : 'VIENNA'}] ${m.body?.substring(0, 500) || ''}`).join('\n\n')}

EMAIL RULES:
- Write as Vienna in first person
- Address the broker by their FIRST NAME — extract it from the deal summary or conversation history. Never use "Hi there" or generic greetings.
- Skip filler like "I hope you're having a great day" — if communication is already flowing, jump straight into the substance.
- Your reply must be a CONTEXTUAL RESPONSE to the broker's last email. If they asked a question, acknowledge it. If they said something specific, reference it. Do not write a generic standalone email.
- Warm and encouraging — the deal is moving forward, so sound positive.
- List what you still need clearly.
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
          content: `You are Vienna, Franco Maione's executive assistant at Private Mortgage Link, a private mortgage lender. Write a short follow-up email to the broker.

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
  generateFollowUpReminder: async (dealSummary, daysSilent, reminderNumber) => {
    try {
      const whatWeNeed = 'the outstanding documents and information we previously requested';

      const response = await callClaude({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: `You are Vienna, Franco Maione's executive assistant at Private Mortgage Link, a private mortgage lender. Write a short, friendly follow-up email to someone who hasn't replied.

It has been ${Math.round(daysSilent)} days since we last heard from them. This is follow-up reminder #${reminderNumber}.

We are still waiting for: ${whatWeNeed}

DEAL DETAILS:
Sender type: ${dealSummary?.sender_type || 'broker'}
Sender name: ${dealSummary?.sender_type === 'borrower' ? (dealSummary?.sender_name || dealSummary?.borrower_name || 'Unknown') : (dealSummary?.sender_name || dealSummary?.broker_name || 'Unknown')} (USE THEIR FIRST NAME ONLY — e.g. if "Franco Maione", address them as "Franco")
Borrower: ${dealSummary?.borrower_name || 'Unknown'}

TONE:
- Reminder #1: Friendly and casual — "Hey [first name]! Just wanted to check in" / "Hope you're having a great week!"
- Reminder #2: Still warm but a little more direct — "We'd love to keep this moving!" / "Just wanted to make sure this didn't slip through the cracks!"
- Reminder #3: Kind but clear — "We'll go ahead and close this file for now, but no worries at all — feel free to reach out anytime and we'd be happy to pick it back up!"

EMAIL RULES:
- ALWAYS address the person by their FIRST NAME — use the sender name above. Never use "Hi there" or generic greetings.
- If sender is a borrower, use simple language — no industry jargon.
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

  // Map classification keys to readable names
  DOC_DISPLAY_NAMES: {
    government_id: 'Government-Issued ID',
    appraisal: 'Property Appraisal',
    property_tax: 'Property Tax Assessment',
    noa: 'Notice of Assessment (NOA)',
    mortgage_statement: 'Current Mortgage Balance Statement',
    income_proof: 'Proof of Income',
    loan_application: 'Loan Application Form',
    pnw_statement: 'Personal Net Worth Statement',
    credit_report: 'Credit Report',
    aml: 'AML Report',
    pep: 'PEP Report',
    financial_statement: 'Financial Statement',
    corporate_financials: 'Corporate Financial Statements',
    tax_return: 'Tax Return',
    borrower_resume: 'Borrower Resume',
    insurance: 'Insurance',
    title_search: 'Title Search',
    survey: 'Survey',
    environmental: 'Environmental Report',
    intake_form: 'Borrower Intake Form',
    other: 'Other',
  },

  // Generate comprehensive lead summary for Franco — reads all documents + deal data
  generateLeadSummary: async (dealSummary, ownershipType, documents, missingDocs, messages = []) => {
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
- Credit: If credit reports were provided, summarize scores and key issues. If NO credit reports were provided, explicitly state "No credit reports provided — credit status unknown" as a gap.
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
${missingDocs.map(d => `- [MISSING] ${module.exports.DOC_DISPLAY_NAMES[d] || d}`).join('\n')}

${!isComplete ? `\nIMPORTANT: This file is pending approval. The following documents are still outstanding: ${missingDocs.map(d => module.exports.DOC_DISPLAY_NAMES[d] || d).join(', ')}. Start the summary with: "FILE STATUS: PRELIMINARY REVIEW — AWAITING APPROVAL"` : 'This file is COMPLETE — all required documents have been received.'}

=== SECTION 10: EMAIL CONVERSATION ===
Include the full email conversation so Franco can review all broker communications. Label each with date and direction (inbound/outbound).

At the bottom, include this action section:
<hr>
<h3>Action Required</h3>
<p>Reply to this email with one of the following:</p>
<ul>
<li><strong>APPROVED</strong> — preliminary approval granted, Vienna will request remaining documents from the broker</li>
<li><strong>Any other reply</strong> — your message will be polished and forwarded to the broker by Vienna</li>
</ul>

=== INPUT DATA ===

DEAL SUMMARY (from intake analysis):
${JSON.stringify(dealSummary, null, 2)}

EXTRACTED DOCUMENT TEXT:
${docSections || 'No extracted text available from documents.'}

EMAIL CONVERSATION:
${messages.length > 0 ? messages.map(m => `[${m.direction.toUpperCase()}] ${m.created_at}\nSubject: ${m.subject}\n${m.body}`).join('\n\n---\n\n') : 'No messages yet.'}

=== INSTRUCTIONS ===
- Read EVERYTHING — the deal summary AND all document text
- Cross-reference documents against each other for consistency
- If information conflicts between documents, note the discrepancy
- Use underwriting language, not marketing language
- Be thorough but scannable — a lender should understand the deal from this summary alone
- ${!isComplete ? 'Start the summary with a clear banner: "FILE STATUS: PRELIMINARY REVIEW — AWAITING APPROVAL"' : 'Start the summary with: "FILE STATUS: COMPLETE — Ready for Review"'}

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

  // Parse admin's reply to a draft preview — is it a confirmation to send, or edit instructions?
  parseDraftReply: async (replyText) => {
    const stripped = module.exports.stripQuotedText(replyText);
    const text = (stripped || replyText || '').trim();

    // Use Claude to classify Franco's reply
    try {
      const response = await callClaude({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 20,
        messages: [{
          role: 'user',
          content: `You are classifying an admin's reply to a draft email preview. The admin was asked to reply "SEND" to confirm or reply with edits.

Reply with EXACTLY one word: SEND or EDIT.

Rules:
- SEND = the admin is confirming/approving the draft to be sent as-is (e.g. "looks good", "send it", "yes", "ok", "perfect", "go ahead", "👍", "approved")
- EDIT = the admin wants changes to the draft (e.g. "make it shorter", "change the part about...", "add something about...", any specific instructions)

ADMIN'S REPLY:
"${text.replace(/"/g, '\\"')}"`,
        }],
      });

      const result = response.content[0].text.trim().toLowerCase();
      if (result.includes('send')) return { action: 'send' };
      return { action: 'edit', editInstructions: text };
    } catch (error) {
      console.error('Claude draft reply parsing failed, defaulting to edit:', error.message);
      return { action: 'edit', editInstructions: text };
    }
  },

  // Revise a draft email based on Franco's edit instructions
  reviseEmailWithEdits: async (originalDraft, editInstructions, dealSummary) => {
    try {
      const response = await callClaude({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `You are Vienna, Franco Maione's executive assistant at Private Mortgage Link, a private mortgage lender.

You previously drafted an email to a broker. Franco has reviewed it and wants changes.

ORIGINAL DRAFT:
${originalDraft}

FRANCO'S EDIT INSTRUCTIONS:
"${editInstructions}"

DEAL DETAILS:
Borrower: ${dealSummary?.borrower_name || 'Unknown'}
Broker: ${dealSummary?.broker_name || 'Unknown'}

Rewrite the email incorporating Franco's changes. Keep the same warm, friendly tone.
- Apply Franco's edits precisely
- Do NOT add information Franco didn't mention
- Keep the same HTML formatting
- Sign off as: Vienna\\nPrivate Mortgage Link

Return only the revised HTML email body.`,
        }],
      });

      return response.content[0].text.trim();
    } catch (error) {
      console.error('Claude email revision error:', error);
      throw error;
    }
  },

  // Generate polished email to broker based on admin's notes/conditions
  generateAdminResponseEmail: async (dealSummary, adminNotes, conversationHistory = []) => {
    try {
      const response = await callClaude({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: `You are Vienna, Franco Maione's executive assistant at Private Mortgage Link, a private mortgage lender. Write an email to the broker on Franco's behalf.

Franco has reviewed a deal and has the following notes/instructions for the broker:

FRANCO'S NOTES:
"${adminNotes}"

DEAL DETAILS:
Borrower: ${dealSummary?.borrower_name || 'Unknown'}
Broker: ${dealSummary?.broker_name || 'Unknown'}
LTV: ${dealSummary?.ltv_percent || 'Unknown'}%

CONVERSATION HISTORY (read this carefully — your reply must be contextual to the broker's last message):
${conversationHistory.map(m => `[${m.direction === 'inbound' ? 'BROKER' : 'VIENNA'}] ${m.body?.substring(0, 500) || ''}`).join('\n\n')}

Write a warm, friendly email to the broker conveying Franco's message. Write as Vienna in first person.
- Address the broker by their FIRST NAME — extract it from the deal summary or conversation history. Never use "Hi there" or generic greetings.
- Skip filler like "I hope you're having a great day" — if communication is already flowing, jump straight into the substance.
- Your reply must be a CONTEXTUAL RESPONSE to the broker's last email. If they asked a question, address it. If they said something specific, reference it. Do not write a generic standalone email.
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
