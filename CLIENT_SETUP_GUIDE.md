# Vienna AI - New Client Setup Guide

## Step 1: Collect Info from the Client

Send the client this list and have them fill it out:

- Company name
- Full name of the person reviewing deals (the decision-maker)
- Their email address (where they'll receive deal notifications and approve/reject deals)
- Company website domain (e.g., abcmortgage.com)
- What email address they want to use for sending/receiving (e.g., info@abcmortgage.com)
- Their calendar booking link (optional — included in emails to borrowers so they can book a call)
- What they want the AI assistant's name to be (default is "Vienna")
- Their Loan Application Form (PDF)
- Their Personal Net Worth Statement Form (PDF)
- Their Borrower Intake Form (PDF) — if they have one
- Any specific documents they require from brokers/borrowers beyond the standard list
- Their LTV threshold — at what LTV percentage should deals be escalated for manual review (default is 80%)

---

## Step 2: Set Up Email Sending & Receiving (Postmark)

Postmark is the email service that sends and receives emails on behalf of the client. It handles two things:
- **Outbound**: Sending emails from the AI assistant to brokers/borrowers
- **Inbound**: Receiving emails from brokers/borrowers and forwarding them to the AI for processing

### Setting up Postmark:

1. Go to postmarkapp.com and log in (or create an account)
2. Click "Create Server" — name it after the client (e.g., "ABC Mortgage")
3. Once the server is created, click on it and go to the "API Tokens" tab
4. Copy the "Server API Token" — save this, you'll need it later

### Setting up Outbound (sending emails):

5. Go to "Sender Signatures" in the left sidebar
6. Click "Add Domain"
7. Enter the client's domain (e.g., abcmortgage.com)
8. Postmark will show you DNS records you need to add — save these for Step 3
9. Once DNS records are added, click "Verify" next to each record — they should turn green

### Setting up Inbound (receiving emails):

10. Go to "Inbound" in the left sidebar under the server
11. You'll see an inbound email address like: abc123@inbound.postmarkapp.com — save this address
12. Click "Settings" and set the webhook URL to your deployed application URL + /webhooks/inbound
    - Example: https://your-app.onrender.com/webhooks/inbound
    - This tells Postmark: "whenever an email arrives, send it to this URL for the AI to process"
13. Under "Inbound domain forwarding", you can optionally set up the client's domain so emails to info@abcmortgage.com get routed through Postmark

---

## Step 3: Set Up the Client's Domain (DNS Records)

These records go into the client's domain settings (GoDaddy, Namecheap, Cloudflare, etc.). They verify that emails from the client's domain are legitimate and prevent them from going to spam.

Ask the client for access to their domain DNS settings, then add these records:

**Record 1 — SPF (prevents spam flagging)**
- Type: TXT
- Host/Name: @
- Value: v=spf1 include:spf.mtasv.net ~all

**Record 2 — DKIM (email authentication)**
- Type: CNAME
- Host/Name: (provided by Postmark in Step 2)
- Value: (provided by Postmark in Step 2)

**Record 3 — Return Path**
- Type: CNAME
- Host/Name: (provided by Postmark in Step 2)
- Value: (provided by Postmark in Step 2)

**Record 4 — DMARC (email security policy)**
- Type: TXT
- Host/Name: _dmarc
- Value: v=DMARC1; p=none; rua=mailto:(client's admin email)

**Record 5 — Inbound Email Routing**

Option A: If the client does NOT use Google Workspace or Microsoft 365 for this domain:
- Type: MX
- Host/Name: @
- Value: inbound.postmarkapp.com
- Priority: 10

Option B: If the client DOES use Google Workspace (most clients will):

Most clients already use Google Workspace for their company email. In this case, do NOT change their MX records — that would break their existing email. Instead, set up a forwarding rule so Google sends a copy of incoming emails to Postmark.

**How to set up Google Workspace forwarding:**

1. Log in to Google Admin Console at admin.google.com (the client will need to give you admin access or do this with you)
2. Go to Apps > Google Workspace > Gmail
3. Click on "Routing" (under Default routing)
4. Click "Add another rule" or "Configure"
5. Fill in the rule:
   - Description: "Forward to Vienna AI"
   - Email messages to affect: Select "Inbound"
   - Envelope filter: Click "Only affect specific envelope recipients" and enter the intake email address (e.g., info@abcmortgage.com)
   - Under "Also deliver to": Click "Add more recipients" and add the Postmark inbound address from Step 2 (e.g., abc123@inbound.postmarkapp.com)
6. IMPORTANT — Under "Spam handling": Select "Bypass spam filter for this message" — this ensures that even if Google thinks an email is spam, it still gets forwarded to the AI
7. Click "Save"
8. Wait 5-10 minutes for the rule to take effect
9. Test by sending an email to the intake address and checking that it arrives in both Google and triggers the AI

**If the client uses Microsoft 365:**
- Go to Exchange Admin Center > Mail Flow > Rules
- Create a new rule to forward/BCC emails from the intake address to the Postmark inbound address
- Make sure to bypass spam filtering for the rule

---

## Step 4: Set Up the Database (Supabase)

Supabase stores all deal data, documents, and conversation history.

1. Go to supabase.com and create a new project
2. Name it after the client
3. Once created, go to Settings > API and copy:
   - Project URL
   - Service Role Key (the secret one, not the public one)
4. Go to the SQL Editor and run the table creation script (provided separately)
5. Set up the storage bucket for document uploads

---

## Step 5: Set Up the AI (Claude API)

Claude is the AI that reads emails, analyzes documents, and generates responses.

1. Go to console.anthropic.com
2. Create an API key (or use a shared one)
3. Save the API key — you'll need it in Step 6

---

## Step 6: Deploy the Application

This is where the actual AI system runs.

1. Go to render.com (or your hosting provider)
2. Create a new Web Service
3. Connect it to the code repository
4. Set the following environment variables:

   - POSTMARK_API_TOKEN = (from Step 2)
   - POSTMARK_SENDER_EMAIL = (client's sending email, e.g., info@abcmortgage.com)
   - CLAUDE_API_KEY = (from Step 5)
   - SUPABASE_URL = (from Step 4)
   - SUPABASE_SERVICE_KEY = (from Step 4)
   - ADMIN_EMAIL = (client's decision-maker email from Step 1)

5. Deploy

---

## Step 7: Customize for the Client

1. Replace the PDF forms in the /forms folder with the client's own forms:
   - Loan Application Form
   - PNW Statement Form
   - Borrower Intake Form (if applicable)
2. Update the AI assistant name if they don't want "Vienna"
3. Update the calendar booking link
4. Adjust the LTV threshold if different from 80%
5. Adjust follow-up reminder timing if needed (default: 2 days between reminders, max 3 reminders)
6. Update the daily summary email time if needed (default: 9 PM MST)

---

## Step 8: Test Everything

Run through these tests before going live:

1. Send a test email as a broker (with attachments) — verify the AI responds correctly, acknowledges docs, asks for what's missing
2. Send a test email as a borrower (no attachments, casual tone) — verify the AI responds simply, attaches both forms, includes calendar link
3. Test the escalation flow — send a deal with LTV over the threshold, verify the admin gets the notification with zip file
4. Test the draft approval flow — reply to the escalation as the admin, verify the draft preview is sent, reply "send" and verify the broker receives the email
5. Test follow-up reminders — create a deal and wait (or trigger manually) to verify reminders go out
6. Check that emails are not going to spam — verify SPF, DKIM, and DMARC are all passing in Postmark

---

## Monthly Costs Per Client (Approximate)

- Email sending (Postmark): $15/month
- Database (Supabase): Free for small volume, $25/month for higher volume
- AI processing (Claude): Usage-based, typically $100-500/month depending on deal volume and number of PDF documents processed
- Hosting (Render): $7-25/month

Total: approximately $140-565/month per client depending on volume
