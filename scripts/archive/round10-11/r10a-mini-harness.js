// R10-A mini-harness — 7 verification groups in isolation.
// Per R9-E/R9-F' precedent: standalone harness runs without Claude API
// dependency while Anthropic balance restoration is pending. Canonical
// R10-A groups remain in test-trigger.js for full-harness once balance restored.

require('dotenv').config();

process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'sk-test-dummy';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';
process.env.POSTMARK_API_TOKEN = process.env.POSTMARK_API_TOKEN || 'dummy';
process.env.POSTMARK_SENDER_EMAIL = process.env.POSTMARK_SENDER_EMAIL || 'vienna@example.com';
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'franco@privatemortgagelink.com';

const aiService = require('../src/services/ai');
const { classifyIntakeBorrower } = require('../src/routes/webhook').__test__;

(async () => {
  console.log('========== R10-A mini-harness — body-aware classifier + ack-on-reject ==========');

  const fs = require('fs');
  const path = require('path');
  const _r10aWebhookSrc = fs.readFileSync(path.join(__dirname, '../src/routes/webhook.js'), 'utf8');
  const _r10aAiSrc = fs.readFileSync(path.join(__dirname, '../src/services/ai.js'), 'utf8');

  let passCount = 0;
  let failCount = 0;
  const expect = (label, cond, detail) => {
    if (cond) {
      console.log(`  PASS ${label}`);
      passCount++;
    } else {
      console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
      failCount++;
      throw new Error(`FAIL [${label}]${detail ? ' — ' + detail : ''}`);
    }
  };

  // ─── R10-A-BODY-SIGNAL-OVERRIDE-MATRIX ───
  console.log('\n--- R10-A-BODY-SIGNAL-OVERRIDE-MATRIX ---');
  // Synthetic broker body matching Franco's Round-6 Donna/Jerome shape
  const donnaBody = `Hi Franco,

I'm Donna Blackwood from Pemberton Lending Inc. Lic. #MB668374. I have a client looking for a $250,000 second mortgage on her property at 88 Harvest Hills Blvd NE, Calgary, AB T3K 4G9.

Please find the loan application + credit bureau attached.

Donna Blackwood
Pemberton Lending Inc. Lic. #MB668374`;

  const jeromeBody = `Hello Franco,

I'm Jerome Osei from Clearpath Mortgage Partners (Lic. #MB779485). Client referral for Patricia Simmons — looking for first mortgage refinance, $385K.

Documents attached.

Jerome Osei
Clearpath Mortgage Partners Lic. #MB779485`;

  // (a) opts absent → existing R9-F behavior (regression-free)
  expect('(a) opts absent + admin-as-borrower input → reject:admin-as-borrower (R9-F preserved)',
    classifyIntakeBorrower({ borrower_name: 'Franco Maione', broker_name: null }) === 'reject:admin-as-borrower');

  // (b) opts.emailBody present but body has no Lic. # signal → reject preserved
  expect('(b) opts.emailBody=plain-text (no Lic. #) → reject:admin-as-borrower preserved',
    classifyIntakeBorrower(
      { borrower_name: 'Franco Maione', broker_name: null },
      { emailBody: 'Just a quick note about something.' }
    ) === 'reject:admin-as-borrower');

  // (c) opts.emailBody with Donna body + admin-as-borrower input → ACCEPT (override fires)
  expect('(c) Donna body + admin-as-borrower input → OVERRIDE to accept',
    classifyIntakeBorrower(
      { borrower_name: 'Franco Maione', broker_name: null },
      { emailBody: donnaBody }
    ) === 'accept');

  // (d) Jerome body + admin-as-borrower input → ACCEPT
  expect('(d) Jerome body + admin-as-borrower input → OVERRIDE to accept',
    classifyIntakeBorrower(
      { borrower_name: 'Franco Maione', broker_name: null },
      { emailBody: jeromeBody }
    ) === 'accept');

  // (e) Donna body + no-human-name input → ACCEPT (symmetric override)
  expect('(e) Donna body + no-human-name input (King of Dates Corp) → OVERRIDE to accept',
    classifyIntakeBorrower(
      { borrower_name: 'King of Dates Corp', broker_name: null },
      { emailBody: donnaBody }
    ) === 'accept');

  // (f) Donna body + system-sender input → still reject:system-sender (no override on system-sender)
  expect('(f) Donna body + system-sender (Postmark Team) → still reject:system-sender (NO override)',
    classifyIntakeBorrower(
      { borrower_name: 'Postmark Team', broker_name: null },
      { emailBody: donnaBody }
    ) === 'reject:system-sender');

  // (g) opts.emailBody returns null parse (no Lic. #) + admin-as-borrower → reject preserved
  expect('(g) empty Lic.-less body + admin-as-borrower → reject preserved',
    classifyIntakeBorrower(
      { borrower_name: 'Franco Maione', broker_name: null },
      { emailBody: 'I am writing on behalf of someone.' }
    ) === 'reject:admin-as-borrower');

  // (h) Body signature returns "franco" first-token (R8-A filter) → null → no override
  const adminProxyBody = `Hi,

Please review.

Franco Maione
VIMA Real Broker Lic. #MB000`;
  expect('(h) body signature first-token=Franco (R8-A admin-name filter → null) → no override',
    classifyIntakeBorrower(
      { borrower_name: 'Franco Maione', broker_name: null },
      { emailBody: adminProxyBody }
    ) === 'reject:admin-as-borrower');

  // (i) opts.emailBody=null → no override path fires
  expect('(i) opts.emailBody=null → no override; reject preserved',
    classifyIntakeBorrower(
      { borrower_name: 'Franco Maione', broker_name: null },
      { emailBody: null }
    ) === 'reject:admin-as-borrower');

  // (j) opts.emailBody='' → no override (parseBrokerFirstNameFromSignature returns null on empty)
  expect('(j) opts.emailBody="" → no override',
    classifyIntakeBorrower(
      { borrower_name: 'Franco Maione', broker_name: null },
      { emailBody: '' }
    ) === 'reject:admin-as-borrower');

  // (k) non-admin borrower (legit broker submission) + accept-shape → accept regardless of body
  expect('(k) legit borrower_name + accept verdict → accept (override path irrelevant)',
    classifyIntakeBorrower(
      { borrower_name: 'Ryan Callahan', broker_name: 'Donna Blackwood' },
      { emailBody: donnaBody }
    ) === 'accept');

  // (l) accept verdict with NO body → accept (override path not invoked)
  expect('(l) accept verdict + no body → accept',
    classifyIntakeBorrower(
      { borrower_name: 'Ryan Callahan', broker_name: 'Donna Blackwood' }
    ) === 'accept');

  // ─── R10-A-FRANCO-FIXTURE-LOAD-BEARING ───
  console.log('\n--- R10-A-FRANCO-FIXTURE-LOAD-BEARING (Donna Blackwood + Jerome Osei Round-6 replay) ---');
  // Synthetic replays of Franco's Round-6 Scenario 4 + 5 bug reports.
  // Pre-R10-A: each would return reject:admin-as-borrower (silent drop)
  // Post-R10-A: body-signal override fires → accept (deal proceeds normally)

  // Donna fixture (Round 6 Scenario 4): borrower=Ryan Callahan, broker=Donna Blackwood,
  // Postmark From-Name="Franco Maione" (broker Gmail display-name artifact)
  const donnaPostmarkFixture = { borrower_name: 'Franco Maione', broker_name: null };
  expect('(Donna pre-R10-A): would-have-been reject:admin-as-borrower without body',
    classifyIntakeBorrower(donnaPostmarkFixture) === 'reject:admin-as-borrower');
  expect('(Donna post-R10-A): body-signal override → accept',
    classifyIntakeBorrower(donnaPostmarkFixture, { emailBody: donnaBody }) === 'accept');

  // Jerome fixture (Round 6 Scenario 5): borrower=Patricia Simmons, broker=Jerome Osei,
  // Postmark From-Name="Franco Maione"
  const jeromePostmarkFixture = { borrower_name: 'Franco Maione', broker_name: null };
  expect('(Jerome pre-R10-A): would-have-been reject:admin-as-borrower without body',
    classifyIntakeBorrower(jeromePostmarkFixture) === 'reject:admin-as-borrower');
  expect('(Jerome post-R10-A): body-signal override → accept',
    classifyIntakeBorrower(jeromePostmarkFixture, { emailBody: jeromeBody }) === 'accept');

  // Donna body parsed = "Donna" (first name); Jerome body parsed = "Jerome"
  expect('(Donna body-signal verification): parseBrokerFirstNameFromSignature returns "Donna"',
    aiService.parseBrokerFirstNameFromSignature(donnaBody) === 'Donna');
  expect('(Jerome body-signal verification): parseBrokerFirstNameFromSignature returns "Jerome"',
    aiService.parseBrokerFirstNameFromSignature(jeromeBody) === 'Jerome');

  // ─── R10-A-ACKNOWLEDGMENT-WIRING ───
  console.log('\n--- R10-A-ACKNOWLEDGMENT-WIRING ---');
  // (a) sendBrokerAcknowledgmentOnReject defined as async helper
  expect('(a) sendBrokerAcknowledgmentOnReject defined as async',
    /const sendBrokerAcknowledgmentOnReject = async/.test(_r10aWebhookSrc));

  // (b) Both call sites pass opts.emailBody — count occurrences of opts.emailBody at classifyIntakeBorrower call sites
  const classifierCallSites = [..._r10aWebhookSrc.matchAll(/classifyIntakeBorrower\([\s\S]*?\)/g)].slice(0, 5);
  let bothCallSitesPassBody = 0;
  for (const m of classifierCallSites) {
    if (/emailBody:/.test(m[0])) bothCallSitesPassBody++;
  }
  expect('(b) Both classifyIntakeBorrower call sites pass opts.emailBody (referral + new-client INITIAL)',
    bothCallSitesPassBody >= 2,
    `count=${bothCallSitesPassBody}`);

  // (c) Both call sites invoke sendBrokerAcknowledgmentOnReject on admin-as-borrower reject
  const adminAsBorrowerAckCount = (_r10aWebhookSrc.match(/=== 'reject:admin-as-borrower'[\s\S]{0,200}?sendBrokerAcknowledgmentOnReject/g) || []).length;
  expect('(c) Both call sites invoke ack on reject:admin-as-borrower',
    adminAsBorrowerAckCount >= 2,
    `count=${adminAsBorrowerAckCount}`);

  // (d) Both call sites invoke ack on no-human-name reject
  const noHumanAckCount = (_r10aWebhookSrc.match(/reject:no-human-name'[\s\S]{0,200}?sendBrokerAcknowledgmentOnReject/g) || []).length;
  expect('(d) Both call sites invoke ack on reject:no-human-name',
    noHumanAckCount >= 2,
    `count=${noHumanAckCount}`);

  // (e) Both call sites do NOT invoke ack on system-sender — verified by checking the conditional excludes system-sender
  const ackBlockMatches = [..._r10aWebhookSrc.matchAll(/if \(_r9f(?:Referral|Intake)Classification === 'reject:admin-as-borrower'[\s\S]{0,300}sendBrokerAcknowledgmentOnReject/g)];
  let systemSenderExcluded = 0;
  for (const m of ackBlockMatches) {
    // Block should NOT mention system-sender (system-sender silent-drop preserved)
    if (!/reject:system-sender/.test(m[0])) systemSenderExcluded++;
  }
  expect('(e) Both call sites exclude system-sender from ack (silent-drop preserved)',
    systemSenderExcluded >= 2,
    `count=${systemSenderExcluded}`);

  // (f) Both call sites invoke ack AFTER admin alert (admin notification preserved as primary signal)
  // Verify by source-order check: admin email send appears before broker ack within each block
  const newClientBlock = _r10aWebhookSrc.match(/`\[Intake Filter\] New-client intake rejected[\s\S]*?return;\s*\}/);
  const referralBlock = _r10aWebhookSrc.match(/`\[Intake Filter\] Referral rejected[\s\S]*?return;\s*\}/);
  expect('(f-new-client) admin alert sent BEFORE broker ack in new-client INITIAL path',
    newClientBlock && newClientBlock[0].indexOf('config.adminEmail') < newClientBlock[0].indexOf('sendBrokerAcknowledgmentOnReject'));
  expect('(f-referral) admin alert sent BEFORE broker ack in referral path',
    referralBlock && referralBlock[0].indexOf('config.adminEmail') < referralBlock[0].indexOf('sendBrokerAcknowledgmentOnReject'));

  // ─── R10-A-ACK-CONTENT-ANCHORS ───
  console.log('\n--- R10-A-ACK-CONTENT-ANCHORS (10 anchors) ---');
  const ackSrc = (() => {
    const start = _r10aWebhookSrc.indexOf('const sendBrokerAcknowledgmentOnReject');
    const end = _r10aWebhookSrc.indexOf('};', start);
    return _r10aWebhookSrc.slice(start, end + 2);
  })();
  expect('(1) subject preserves original with Re: prefix when missing',
    /\(email\.subject \|\| ''\)\.startsWith\('Re:'\)/.test(ackSrc));
  expect('(2) "Hi there!" generic greeting (no admin-name leak)',
    /Hi there!/.test(ackSrc));
  expect('(3) "We received your submission" acknowledgment phrase',
    /We received your submission/.test(ackSrc));
  expect('(4) "reviewing it" status phrase',
    /reviewing it/.test(ackSrc));
  expect('(5) "You\'ll hear back shortly" follow-up promise',
    /You'll hear back shortly/.test(ackSrc));
  expect('(6) "Vienna" signature line',
    /Vienna\b/.test(ackSrc));
  expect('(7) "Private Mortgage Link" company line',
    /Private Mortgage Link/.test(ackSrc));
  expect('(8) NO classifier-decision leak (no "rejected" / "filtered" / "classified" in broker-facing body)',
    !/\b(rejected|filtered|classified)\b/.test(ackSrc));
  expect('(9) email.from is the recipient (not config.adminEmail)',
    /emailService\.sendEmail\(\s*email\.from,/.test(ackSrc));
  expect('(10) NO attachments / no CC (last 3 args [], [], absent CC)',
    /emailService\.sendEmail\([\s\S]*?email\.from,[\s\S]*?subject,[\s\S]*?textBody,[\s\S]*?null,[\s\S]*?\[\],[\s\S]*?\[\][\s\S]*?\)/.test(ackSrc));

  // ─── R10-A-R8-A-REUSE-CROSS-CLUSTER (folds in R8A-MATCHALL-ENHANCEMENT) ───
  console.log('\n--- R10-A-R8-A-REUSE-CROSS-CLUSTER (with R8A matchAll enhancement) ---');
  // Source pins on R8-A helper structural preservation
  expect('(a) ai.js parseBrokerFirstNameFromSignature top-level export preserved',
    /^\s+parseBrokerFirstNameFromSignature,\s*$/m.test(_r10aAiSrc));
  expect('(b) helper signature unchanged: (emailBody) → string|null',
    /const parseBrokerFirstNameFromSignature = \(emailBody\) =>/.test(_r10aAiSrc));
  expect('(c) Admin-name filter preserved (firstToken.toLowerCase() === \'franco\' → null)',
    /firstToken\.toLowerCase\(\) === 'franco'/.test(_r10aAiSrc));
  expect('(d) Greeting-word filter preserved (Hi/Hello/Hey/Dear/Greetings)',
    /\^\(Hi\|Hello\|Hey\|Dear\|Greetings\)\$/i.test(_r10aAiSrc));
  expect('(e) RFC-footer-strip preserved (\\n-- \\n delim search)',
    /sigDelim = emailBody\.search\(\/\\n--\\s\*\\n\/\)/.test(_r10aAiSrc));
  expect('(f) inline-separator hardening preserved (R8-A Nadia shape)',
    /line\.indexOf\(' -- '\)/.test(_r10aAiSrc));
  // R10-A matchAll enhancement source pins
  expect('(g) R10-A pattern (a) uses matchAll (not match)',
    /precedingMatches = \[\.\.\.beforeFooter\.matchAll\(\/\(\[\^\\n\]\+\)\\n\+\[\^\\n\]\*Lic\\\.\\s\*#\/gi\)\]/.test(_r10aAiSrc));
  expect('(h) R10-A pattern (a) iterates last-to-first',
    /for \(let i = precedingMatches\.length - 1; i >= 0; i--\)/.test(_r10aAiSrc));
  expect('(i) R10-A validate-each-fall-through: first valid capture wins',
    /for \(let i = precedingMatches\.length - 1[\s\S]{0,200}validateCapture\(precedingMatches\[i\]\[1\]\)[\s\S]{0,50}if \(result\) return result/.test(_r10aAiSrc));
  // R8-A 5-fixture truth table regression (load-bearing — Q1-relock structural preservation)
  const ericBody = `Hi, I'm Eric Johansson with Willow Creek Mortgage Group (Lic. #MB884572). I\nhave a client looking for a $92,000 second mortgage on her property at 1801\nVarsity Estates Dr NW, Calgary. Please find the loan application, credit\nbureau, and appraisal attached.\n\nEric Johansson\n\nWillow Creek Mortgage Group Lic. #MB884572\n\n-- \n\nFranco Maione\n`;
  expect('(j) R8-A regression: Eric body → "Eric"', aiService.parseBrokerFirstNameFromSignature(ericBody) === 'Eric');
  expect('(k) R8-A regression: Marcus body (Natalie sig + Franco footer) → "Natalie"',
    aiService.parseBrokerFirstNameFromSignature(`*Natalie Bergman*\n\nSummit Financial Group Lic. #MB338764\n\n-- \n\nFranco Maione\nFounder at VIMA Real Broker\n`) === 'Natalie');
  expect('(l) R8-A regression: Nadia body (inline-sep pipe) → "Nadia"',
    aiService.parseBrokerFirstNameFromSignature(`Hi, I'm Nadia Petrov with Eastview Mortgage Group, Lic. #MB440996. I have a client looking for a $92,000 second mortgage on her property in Calgary NW.\n\nNadia Petrov | Eastview Mortgage Group | Lic. #MB440996 -- Franco Maione Founder at VIMA Real Broker Mobile (780) 975-3339`) === 'Nadia');
  expect('(m) R8-A regression: Sophie body (paren-style) → "Sophie"',
    aiService.parseBrokerFirstNameFromSignature(`Hi, I'm Sophie Delacroix with Landmark Mortgage Corp (Lic. #MB221043). I have a client looking for a private first mortgage.\n\nSophie Delacroix\n\nLandmark Mortgage Corp Lic. #MB221043`) === 'Sophie');
  expect('(n) R8-A regression: Marcus Fitzpatrick body → "Marcus"',
    aiService.parseBrokerFirstNameFromSignature(`I'm Marcus Fitzpatrick with Bluepoint Mortgage Partners (Lic. #MB562034).\n\nMarcus Fitzpatrick\n\nBluepoint Mortgage Partners Lic. #MB562034`) === 'Marcus');
  // R10-A new fixtures: Donna + Jerome shape (Lic.# in body prose AND signature)
  const ericBodyParse = aiService.parseBrokerFirstNameFromSignature(ericBody);
  expect('(o) R10-A new: Donna body returns "Donna" (matchAll enhancement closes Round-6 bug)',
    aiService.parseBrokerFirstNameFromSignature(donnaBody) === 'Donna');
  expect('(p) R10-A new: Jerome body returns "Jerome" (matchAll enhancement closes Round-6 bug)',
    aiService.parseBrokerFirstNameFromSignature(jeromeBody) === 'Jerome');
  expect('(q) edge: admin-name-only signature returns null (Q1-relock R8-A filter active)',
    aiService.parseBrokerFirstNameFromSignature(adminProxyBody) === null);
  expect('(r) edge: null input returns null',
    aiService.parseBrokerFirstNameFromSignature(null) === null);
  expect('(s) edge: empty string returns null',
    aiService.parseBrokerFirstNameFromSignature('') === null);
  expect('(t) edge: body with only greeting + Lic.# → null (greeting filter rejects + no signature line)',
    aiService.parseBrokerFirstNameFromSignature('Hi Franco,\n\nQuick note Lic. #MB123456') === null);

  // ─── R10-A-OVER-FIRE-PROTECTION ───
  console.log('\n--- R10-A-OVER-FIRE-PROTECTION ---');
  // (a) Postmark Team → still reject:system-sender regardless of opts.emailBody
  expect('(a) Postmark Team + no body → reject:system-sender',
    classifyIntakeBorrower({ borrower_name: 'Postmark Team', broker_name: null }) === 'reject:system-sender');
  // (b) Postmark Team + body with Lic. # → STILL reject:system-sender (no override on this category)
  expect('(b) Postmark Team + body with Lic. # → STILL reject:system-sender (NO override)',
    classifyIntakeBorrower(
      { borrower_name: 'Postmark Team', broker_name: null },
      { emailBody: donnaBody }
    ) === 'reject:system-sender');
  // (c) mailer-daemon + no body → reject:system-sender
  expect('(c) mailer-daemon → reject:system-sender',
    classifyIntakeBorrower({ borrower_name: 'mailer-daemon', broker_name: null }) === 'reject:system-sender');
  // (d) noreply + body → STILL reject:system-sender
  expect('(d) noreply + body with Lic. # → STILL reject:system-sender (NO override)',
    classifyIntakeBorrower(
      { borrower_name: 'noreply', broker_name: null },
      { emailBody: donnaBody }
    ) === 'reject:system-sender');
  // (e) wire-site source pin: system-sender does NOT appear in ack conditional
  expect('(e) wire-site: system-sender absent from broker-ack conditional (silent-drop preserved)',
    !/reject:system-sender'[\s\S]{0,50}?sendBrokerAcknowledgmentOnReject/.test(_r10aWebhookSrc));

  // ─── R10-A-CROSS-CLUSTER-INTEGRATION ───
  console.log('\n--- R10-A-CROSS-CLUSTER-INTEGRATION ---');
  // (a) R9-F admin-as-borrower / system-sender / no-human-name categories preserved
  expect('(a) R9-F reject:admin-as-borrower category defined',
    /return 'reject:admin-as-borrower'/.test(_r10aWebhookSrc));
  expect('(a2) R9-F reject:system-sender category defined',
    /return 'reject:system-sender'/.test(_r10aWebhookSrc));
  expect('(a3) R9-F reject:no-human-name category defined',
    /return 'reject:no-human-name'/.test(_r10aWebhookSrc));
  // (b) R9-F' findExistingDealForBorrower wire still present and fires AFTER R10-A classifier
  const r9fpIdx = _r10aWebhookSrc.search(/_r9fPrimeDupCheck\s*=\s*await\s+dealsService\.findExistingDealForBorrower/);
  const ackBlockIdx = _r10aWebhookSrc.search(/sendBrokerAcknowledgmentOnReject\(email\)/);
  expect('(b) R9-F\' wire AFTER R10-A classifier+ack on new-client INITIAL path',
    r9fpIdx > ackBlockIdx);
  // (c) R9-E startCron factory present
  const cronSrc = fs.readFileSync(path.join(__dirname, '../src/cron/dailySummary.js'), 'utf8');
  expect('(c) R9-E startCron factory preserved',
    /const startCron = \(\) =>/.test(cronSrc));
  // (d) R6-κ aml_pep_requested_at flow preserved
  expect('(d) R6-κ aml_pep_requested_at flow preserved', /aml_pep_requested_at/.test(_r10aWebhookSrc));
  // (e) R5-F-2 claimDailySummarySlot preserved
  expect('(e) R5-F-2 claimDailySummarySlot preserved', /claimDailySummarySlot/.test(cronSrc));
  // (f) Group ZZZ admin-alert pattern preserved (existing R9-F admin alert unchanged in shape)
  expect('(f) R9-F admin alert email still present at both call sites',
    /\[Intake Filter\] New-client intake rejected/.test(_r10aWebhookSrc)
    && /\[Intake Filter\] Referral rejected/.test(_r10aWebhookSrc));
  // (g) Both call sites preserve admin alert (broker ack additive)
  expect('(g) admin alert preserved + broker ack additive (no replacement)',
    /config\.adminEmail,[\s\S]{0,100}`\[Intake Filter\] New-client intake rejected[\s\S]*?if \(_r9fIntakeClassification === 'reject:admin-as-borrower'/.test(_r10aWebhookSrc));
  // (h) Postmark email sending unchanged
  expect('(h) emailService.sendEmail signature unchanged (R10-A uses same shape)',
    /emailService\.sendEmail\(\s*email\.from/.test(_r10aWebhookSrc));
  // (i) findActiveByEmail / R10-A / R9-F' intake-gate ordering preserved
  // (R10-A is the inline-classifier; findActiveByEmail runs even earlier in the handler)
  expect('(i) R10-A classifier (was R9-F) → R9-F\' dedup ordering preserved on new-client INITIAL path',
    (() => {
      const newClientBranch = _r10aWebhookSrc.match(/_r9fIntakeClassification\s*=\s*classifyIntakeBorrower\([\s\S]*?dealsService\.create\(/);
      if (!newClientBranch) return false;
      const block = newClientBranch[0];
      return block.indexOf('classifyIntakeBorrower') < block.indexOf('findExistingDealForBorrower')
          && block.indexOf('findExistingDealForBorrower') < block.indexOf('dealsService.create');
    })());
  // (j) module.exports.classifyIntakeBorrower export unchanged (signature is purely-additive, opts default)
  expect('(j) classifyIntakeBorrower exported (existing export preserved)',
    /^\s+classifyIntakeBorrower,?\s*$/m.test(_r10aWebhookSrc));

  console.log(`\n========== R10-A mini-harness: ${passCount}/${passCount + failCount} PASS ==========`);
  if (failCount > 0) process.exit(1);
})().catch(e => {
  console.error('\nR10-A HARNESS FAILED:', e.stack || e.message);
  process.exit(1);
});
