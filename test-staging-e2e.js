// Staging E2E — Patricia synthetic webhook against deployed undrwrite.onrender.com
//
// Bug A is the deploy-verification signal: pre-fix, no admin email fires when a
// broker submits a complete file with explicit LTV in the FIRST email; post-fix,
// the new-client gate fires the preliminary-review HITL to Franco. We POST a
// Patricia-shape inbound payload, wait, then check Postmark outbound + Supabase.

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const STAGING_URL = 'https://undrwrite.onrender.com/webhook/inbound';
const POSTMARK_API_TOKEN = process.env.POSTMARK_API_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!POSTMARK_API_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing required env: POSTMARK_API_TOKEN / SUPABASE_URL / SUPABASE_SERVICE_KEY');
  process.exit(1);
}

// Unique tag for this run so we can find OUR deal/messages in shared tables.
const RUN_TAG = `patricia-synth-${Date.now()}`;
const BROKER_EMAIL = `jason+${RUN_TAG}@mercerbrokerage.com`;
const MESSAGE_ID = `${RUN_TAG}@synthetic.test`;

console.log(`\n========== STAGING E2E — ${RUN_TAG} ==========`);
console.log(`Target: ${STAGING_URL}`);
console.log(`Broker From: ${BROKER_EMAIL}`);
console.log(`Synthetic MessageID: ${MESSAGE_ID}\n`);

// Load real PDF content for the appraisal attachment. Filename starts with
// "Appraisal_" so deals.js classifyDocument routes it to 'appraisal' via the
// filename branch (content doesn't matter for classification, but we want a
// real PDF byte stream so pdf-parse / pdf-lib don't choke).
const pdfBytes = fs.readFileSync(path.join(__dirname, 'forms', 'Loan Application Form (1).pdf'));
const pdfBase64 = pdfBytes.toString('base64');

// Postmark inbound payload shape — matches what email.js parseInboundEmail consumes.
const payload = {
  From: BROKER_EMAIL,
  FromName: 'Jason Mercer',
  To: process.env.POSTMARK_SENDER_EMAIL || 'info@privatemortgagelink.com',
  Subject: `2nd mortgage submission — Patricia Simmons (${RUN_TAG})`,
  TextBody: `Hi Franco,

Submitting a second mortgage opportunity for Patricia Simmons.

Property: 287 Glencairn Ave, Toronto, ON
Property value (appraised): $920,000
Existing first mortgage balance: $445,000 (Scotiabank, current)
Loan amount requested: $160,000 (second mortgage)
Combined LTV: approximately 65.7%

Borrower: Patricia Simmons, employed at Stantec for 8 years as a senior planner. Recently completed her NOA.

Exit strategy: refinance into a single first at maturity once renovation is complete.

I've attached the property appraisal and Patricia's most recent NOA. Will follow up with the rest of the package early this week.

Thanks,
Jason Mercer
Mercer Mortgage Group
Lic. #M12001505`,
  HtmlBody: null,
  MessageID: MESSAGE_ID,
  Date: new Date().toISOString(),
  Headers: [],
  Attachments: [
    {
      Name: 'Appraisal_Simmons_Glencairn.pdf',
      Content: pdfBase64,
      ContentType: 'application/pdf',
      ContentLength: pdfBytes.length,
    },
    {
      Name: 'NOA_Simmons_2024.pdf',
      Content: pdfBase64, // Reuse same PDF; filename routes classification.
      ContentType: 'application/pdf',
      ContentLength: pdfBytes.length,
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// 1) POST the payload to the deployed webhook.
// ─────────────────────────────────────────────────────────────────────────────
async function fireWebhook() {
  console.log('[1/3] POSTing payload to webhook...');
  const t0 = Date.now();
  const res = await fetch(STAGING_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  console.log(`     HTTP ${res.status} in ${Date.now() - t0}ms — ${body.slice(0, 100)}`);
  if (res.status !== 200) {
    throw new Error(`Webhook rejected payload: HTTP ${res.status}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) Poll Postmark outbound API for the PRELIMINARY Review email to Franco.
// ─────────────────────────────────────────────────────────────────────────────
async function pollPostmarkOutbound(timeoutMs = 90000) {
  console.log(`\n[2/3] Polling Postmark outbound for "PRELIMINARY Review — Patricia Simmons" email...`);
  console.log(`     Timeout: ${timeoutMs / 1000}s`);
  const expectedSubjectFragment = 'PRELIMINARY Review';
  const start = Date.now();
  const adminEmail = 'franco@privatemortgagelink.com';
  let attempts = 0;

  while (Date.now() - start < timeoutMs) {
    attempts++;
    const url = `https://api.postmarkapp.com/messages/outbound?count=20&offset=0&recipient=${encodeURIComponent(adminEmail)}`;
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'X-Postmark-Server-Token': POSTMARK_API_TOKEN,
      },
    });
    if (!res.ok) {
      console.error(`     Postmark API error: HTTP ${res.status}`);
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }
    const data = await res.json();
    const matches = (data.Messages || []).filter(m =>
      m.Subject && m.Subject.includes(expectedSubjectFragment) && m.Subject.includes('Patricia Simmons')
    );
    if (matches.length > 0) {
      const m = matches[0];
      console.log(`     ✓ FOUND after ${attempts} attempts (${Math.round((Date.now() - start) / 1000)}s)`);
      console.log(`       Subject: ${m.Subject}`);
      console.log(`       To:      ${m.To?.[0]?.Email || m.Recipients?.[0]?.Email || JSON.stringify(m.To)}`);
      console.log(`       Status:  ${m.Status}`);
      console.log(`       Sent:    ${m.ReceivedAt}`);
      console.log(`       MessageID: ${m.MessageID}`);
      return m;
    }
    process.stdout.write(`     attempt ${attempts}: not found yet (${data.Messages?.length || 0} recent messages to ${adminEmail})\r`);
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error(`TIMEOUT — no PRELIMINARY Review email to ${adminEmail} found in ${timeoutMs / 1000}s. Either deploy hasn't landed (still serving old code), or the trigger gate didn't fire.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) Verify Supabase deal record reached status='under_review'.
// ─────────────────────────────────────────────────────────────────────────────
async function checkSupabase() {
  console.log(`\n[3/3] Checking Supabase deals table for our deal...`);
  const url = `${SUPABASE_URL}/rest/v1/deals?email=eq.${encodeURIComponent(BROKER_EMAIL)}&order=created_at.desc&limit=1`;
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase API error: HTTP ${res.status} — ${await res.text()}`);
  }
  const rows = await res.json();
  if (rows.length === 0) {
    throw new Error(`No deal found for broker email ${BROKER_EMAIL}. Webhook may not have created a deal.`);
  }
  const deal = rows[0];
  console.log(`     ✓ FOUND deal ${deal.id}`);
  console.log(`       email:           ${deal.email}`);
  console.log(`       borrower_name:   ${deal.borrower_name}`);
  console.log(`       status:          ${deal.status}`);
  console.log(`       ltv:             ${deal.ltv}`);
  console.log(`       has_application: ${deal.has_application_form}`);
  console.log(`       has_pnw:         ${deal.has_pnw_statement}`);
  console.log(`       created:         ${deal.created_at}`);
  console.log(`       updated:         ${deal.updated_at}`);

  const checks = {
    'status is under_review (Bug A trigger fired)':         deal.status === 'under_review',
    'ltv extracted from email body':                         typeof deal.ltv === 'number' && deal.ltv > 0 && deal.ltv <= 80,
    'borrower name extracted (not "Jason Mercer")':          deal.borrower_name && /Patricia/i.test(deal.borrower_name),
  };
  console.log(`\n     Assertions:`);
  let allOk = true;
  for (const [label, ok] of Object.entries(checks)) {
    console.log(`       ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) allOk = false;
  }
  if (!allOk) throw new Error('Supabase assertions failed');
  return deal;
}

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  try {
    await fireWebhook();
    const message = await pollPostmarkOutbound();
    const deal = await checkSupabase();

    console.log(`\n${'─'.repeat(50)}`);
    console.log('STAGING E2E PASSED — Bug A trigger fires on initial submission');
    console.log(`${'─'.repeat(50)}\n`);
    console.log('Verified:');
    console.log('  ✓ Webhook accepted Postmark inbound payload (HTTP 200)');
    console.log('  ✓ Vienna ran processInitialEmail (Claude extracted LTV)');
    console.log('  ✓ Bug A new-client gate fired sendPreliminaryReviewToAdmin');
    console.log('  ✓ Postmark outbound API confirms PRELIMINARY Review email to Franco');
    console.log('  ✓ Supabase deal record exists with status=under_review');
    console.log('\nDeploy is live. The 21 commits are running on https://undrwrite.onrender.com');
    process.exit(0);
  } catch (err) {
    console.error(`\n${'─'.repeat(50)}`);
    console.error('STAGING E2E FAILED');
    console.error(`${'─'.repeat(50)}`);
    console.error(err.message);
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    process.exit(1);
  }
})();
