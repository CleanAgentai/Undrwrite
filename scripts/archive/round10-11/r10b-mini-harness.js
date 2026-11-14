// R10-B mini-harness — 8 verification groups in isolation.
//
// Per R9-E/R9-F'/R10-A precedent + NEW methodology discipline (Q-leans):
// synthetic-fixture Stage 1 evidence carries "production-verification-pending"
// status until R10-B-PRODUCTION-FIXTURE-VERIFICATION replays against actual
// Round-6 inbound bodies (live Supabase). This mini-harness encodes both
// Stage 1 (synthetic fixtures) and Stage 1.5 (production replay) discipline
// as a permanent harness group going forward.

require('dotenv').config();

process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'sk-test-dummy';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';
process.env.POSTMARK_API_TOKEN = process.env.POSTMARK_API_TOKEN || 'dummy';
process.env.POSTMARK_SENDER_EMAIL = process.env.POSTMARK_SENDER_EMAIL || 'vienna@example.com';
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'franco@privatemortgagelink.com';

const aiService = require('../src/services/ai');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

(async () => {
  console.log('========== R10-B mini-harness — body-prose extractor + Round-6 fix ==========');

  const fs = require('fs');
  const path = require('path');
  const _r10bAiSrc = fs.readFileSync(path.join(__dirname, '../src/services/ai.js'), 'utf8');
  const _r10bWebhookSrc = fs.readFileSync(path.join(__dirname, '../src/routes/webhook.js'), 'utf8');

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

  const { parseBrokerFirstNameFromBodyProse, parseBrokerFirstNameFromSignature, parseBrokerFirstName } = aiService;

  // ─── R10-B-BODY-PROSE-MATRIX (15+ cases) ───
  console.log('\n--- R10-B-BODY-PROSE-MATRIX ---');
  // Round-6 production-shape patterns (canonical "My name is X from Y")
  expect('(a) Donna: "My name is Donna Blackwood from Pemberton Lending Inc." → "Donna"',
    parseBrokerFirstNameFromBodyProse("My name is Donna Blackwood from Pemberton Lending Inc.") === 'Donna');
  expect('(b) Jerome: "My name is Jerome Osei from Clearpath Mortgage Partners" → "Jerome"',
    parseBrokerFirstNameFromBodyProse("My name is Jerome Osei from Clearpath Mortgage Partners") === 'Jerome');
  expect('(c) Simone: "My name is Simone Beaumont from Valleyview Mortgage Corp" → "Simone"',
    parseBrokerFirstNameFromBodyProse("My name is Simone Beaumont from Valleyview Mortgage Corp") === 'Simone');
  expect('(d) Harpreet: "My name is Harpreet Gill from Silverstream Mortgage Group" → "Harpreet"',
    parseBrokerFirstNameFromBodyProse("My name is Harpreet Gill from Silverstream Mortgage Group") === 'Harpreet');
  // R8-A AI-prompt patterns ("I'm X with Y")
  expect('(e) Eric: "I\'m Eric Johansson with Willow Creek Mortgage Group" → "Eric"',
    parseBrokerFirstNameFromBodyProse("Hi, I'm Eric Johansson with Willow Creek Mortgage Group") === 'Eric');
  expect('(f) Nadia: "I\'m Nadia Petrov with Eastview Mortgage Group" → "Nadia"',
    parseBrokerFirstNameFromBodyProse("Hi, I'm Nadia Petrov with Eastview Mortgage Group") === 'Nadia');
  // This is X writing pattern
  expect('(g) "This is Jane Smith writing on behalf of..." → "Jane"',
    parseBrokerFirstNameFromBodyProse("This is Jane Smith writing on behalf of my client.") === 'Jane');
  // Bare patterns (no company suffix)
  expect('(h) bare "My name is Donna Blackwood," → "Donna"',
    parseBrokerFirstNameFromBodyProse("Hi, My name is Donna Blackwood, broker.") === 'Donna');
  expect('(i) bare "I\'m Marcus." → "Marcus"',
    parseBrokerFirstNameFromBodyProse("Hi, I'm Marcus.") === 'Marcus');
  // Edge cases
  expect('(j) null input → null', parseBrokerFirstNameFromBodyProse(null) === null);
  expect('(k) empty input → null', parseBrokerFirstNameFromBodyProse('') === null);
  expect('(l) non-string input → null', parseBrokerFirstNameFromBodyProse(12345) === null);
  expect('(m) body without any intro pattern → null',
    parseBrokerFirstNameFromBodyProse("Just a quick note about the file.") === null);
  // Negative filters
  expect('(n) "My name is Franco from VIMA" → null (admin filter)',
    parseBrokerFirstNameFromBodyProse("My name is Franco from VIMA Real Broker") === null);
  expect('(o) "I\'m Please writing about..." → null (common-word filter)',
    parseBrokerFirstNameFromBodyProse("Hi, I'm Please writing about something") === null);

  // ─── R10-B-SHARED-VALIDATOR-MATRIX (via signature-parse with crafted bodies) ───
  console.log('\n--- R10-B-SHARED-VALIDATOR-MATRIX ---');
  // Test the shared validator indirectly via parseBrokerFirstNameFromSignature
  // crafting bodies where the preceding-line capture would be the test input
  const validatorCase = (label, precedingLine, expected) => {
    const body = `${precedingLine}\nSome firm Lic. #MB123456`;
    const result = parseBrokerFirstNameFromSignature(body);
    expect(label, result === expected, `precedingLine="${precedingLine}", expected="${expected}", got="${result}"`);
  };
  validatorCase('(a) "Pemberton Lending Inc." → null (company-suffix line-end)', 'Pemberton Lending Inc.', null);
  validatorCase('(b) "Clearpath Mortgage Partners" → null (company-suffix line-end)', 'Clearpath Mortgage Partners', null);
  validatorCase('(c) "Valleyview Mortgage Corp" → null (company-suffix line-end)', 'Valleyview Mortgage Corp', null);
  validatorCase('(d) "Please advise on next steps." → null (common-word starter)', 'Please advise on next steps.', null);
  validatorCase('(e) "Thanks for the help" → null (common-word starter)', 'Thanks for the help', null);
  validatorCase('(f) "Looking forward to hearing back" → null (common-word starter)', 'Looking forward to hearing back', null);
  validatorCase('(g) "Mr Smith" → null (title-prefix preserved)', 'Mr Smith', null);
  validatorCase('(h) "Hi Franco," → null (greeting + admin name)', 'Hi Franco,', null);
  validatorCase('(i) "Franco Maione" → null (admin name filter)', 'Franco Maione', null);
  validatorCase('(j) "Donna Blackwood" → "Donna" (legit name)', 'Donna Blackwood', 'Donna');

  // ─── R10-B-RESOLVER-CHAIN (8+ cases on parseBrokerFirstName wrapper) ───
  console.log('\n--- R10-B-RESOLVER-CHAIN ---');
  // Production 3-line shape (body-prose primary path)
  const donna3line = `Hi,

My name is Donna Blackwood from Pemberton Lending Inc. (Lic. #MB668374).
I'd like to submit a new file.

Donna Blackwood
Pemberton Lending Inc.
Lic. #MB668374`;
  expect('(a) Donna 3-line production shape → "Donna" (body-prose primary)',
    parseBrokerFirstName(donna3line) === 'Donna');

  // Harpreet 1-line shape (body-prose primary path)
  const harpreet1line = `Hi,

My name is Harpreet Gill from Silverstream Mortgage Group (Lic. #MB991607).

Please advise on next steps.

Harpreet Gill Silverstream Mortgage Group Lic. #MB991607`;
  expect('(b) Harpreet 1-line production shape → "Harpreet" (body-prose primary)',
    parseBrokerFirstName(harpreet1line) === 'Harpreet');

  // Legacy R8-A Eric shape (body-prose OR signature both should yield)
  const ericLegacy = `Hi, I'm Eric Johansson with Willow Creek Mortgage Group (Lic. #MB884572).

Eric Johansson

Willow Creek Mortgage Group Lic. #MB884572

--

Franco Maione
`;
  expect('(c) Eric legacy R8-A shape → "Eric"',
    parseBrokerFirstName(ericLegacy) === 'Eric');

  // Legacy R8-A Marcus shape (signature path only — no "I'm X" body-prose intro)
  const marcusLegacy = `*Natalie Bergman*\n\nSummit Financial Group Lic. #MB338764\n\n-- \n\nFranco Maione\nFounder at VIMA Real Broker\n`;
  expect('(d) Marcus legacy R8-A shape (sig-only) → "Natalie"',
    parseBrokerFirstName(marcusLegacy) === 'Natalie');

  // Legacy R8-A Nadia shape (signature pattern (b) pipe-delim)
  const nadiaLegacy = `Hi, I'm Nadia Petrov with Eastview Mortgage Group, Lic. #MB440996.\n\nNadia Petrov | Eastview Mortgage Group | Lic. #MB440996 -- Franco Maione`;
  expect('(e) Nadia legacy R8-A shape → "Nadia" (body-prose first; sig fallback would also yield)',
    parseBrokerFirstName(nadiaLegacy) === 'Nadia');

  // Admin-name body-prose + admin-name signature → null both paths
  const adminBody = `Hi, My name is Franco from VIMA.\n\nFranco Maione\nVIMA Real Broker Lic. #MB000`;
  expect('(f) admin-name in body + sig → null (both filtered)',
    parseBrokerFirstName(adminBody) === null);

  // No self-ID + no valid signature → null
  const minimalBody = `Just a quick note.\n\nThanks.`;
  expect('(g) no self-ID + no valid signature → null',
    parseBrokerFirstName(minimalBody) === null);

  // Null/empty
  expect('(h) null → null', parseBrokerFirstName(null) === null);
  expect('(i) empty → null', parseBrokerFirstName('') === null);

  // ─── R10-B-WIRE-SITE (4 anchors) ───
  console.log('\n--- R10-B-WIRE-SITE ---');
  expect('(a) webhook.js R10-A body-signal override uses parseBrokerFirstName',
    /_r10aBodySignal = opts\.emailBody\s*\?\s*aiService\.parseBrokerFirstName\(opts\.emailBody\)/.test(_r10bWebhookSrc));
  expect('(b) webhook.js _c7ParsedBrokerName uses parseBrokerFirstName',
    /_c7ParsedBrokerName = aiService\.parseBrokerFirstName\(email\.textBody\)/.test(_r10bWebhookSrc));
  expect('(c) webhook.js _ahBrokerFirstName uses parseBrokerFirstName',
    /_ahBrokerFirstName = aiService\.parseBrokerFirstName\(email\.textBody\)/.test(_r10bWebhookSrc));
  expect('(d) webhook.js _r5dParsedFromSig uses parseBrokerFirstName',
    /_r5dParsedFromSig = aiService\.parseBrokerFirstName\(email\.textBody\)/.test(_r10bWebhookSrc));
  expect('(e) aiService.parseBrokerFirstName exported',
    /^\s+parseBrokerFirstName,\s*$/m.test(_r10bAiSrc));
  expect('(f) parseBrokerFirstNameFromBodyProse exported',
    /^\s+parseBrokerFirstNameFromBodyProse,\s*$/m.test(_r10bAiSrc));
  expect('(g) parseBrokerFirstNameFromSignature export preserved (R8-A backwards-compat)',
    /^\s+parseBrokerFirstNameFromSignature,\s*$/m.test(_r10bAiSrc));

  // ─── R10-B-R8-A-REGRESSION (5 legacy fixtures preserved) ───
  console.log('\n--- R10-B-R8-A-REGRESSION ---');
  expect('(a) Eric body → "Eric" (R8-A preserved)',
    parseBrokerFirstNameFromSignature(`Hi, I'm Eric Johansson with Willow Creek Mortgage Group (Lic. #MB884572). I\nhave a client.\n\nEric Johansson\n\nWillow Creek Mortgage Group Lic. #MB884572\n\n-- \n\nFranco Maione\n`) === 'Eric');
  expect('(b) Marcus body (Natalie sig + Franco footer) → "Natalie" (R8-A preserved)',
    parseBrokerFirstNameFromSignature(`*Natalie Bergman*\n\nSummit Financial Group Lic. #MB338764\n\n-- \n\nFranco Maione\n`) === 'Natalie');
  expect('(c) Nadia body (inline-sep pipe) → "Nadia" (R8-A preserved)',
    parseBrokerFirstNameFromSignature(`Hi, I'm Nadia Petrov with Eastview Mortgage Group, Lic. #MB440996.\n\nNadia Petrov | Eastview Mortgage Group | Lic. #MB440996 -- Franco Maione`) === 'Nadia');
  expect('(d) Sophie body (paren-style) → "Sophie" (R8-A preserved)',
    parseBrokerFirstNameFromSignature(`Hi, I'm Sophie Delacroix with Landmark Mortgage Corp (Lic. #MB221043).\n\nSophie Delacroix\n\nLandmark Mortgage Corp Lic. #MB221043`) === 'Sophie');
  expect('(e) Marcus Fitzpatrick body → "Marcus" (R8-A preserved)',
    parseBrokerFirstNameFromSignature(`I'm Marcus Fitzpatrick with Bluepoint Mortgage Partners (Lic. #MB562034).\n\nMarcus Fitzpatrick\n\nBluepoint Mortgage Partners Lic. #MB562034`) === 'Marcus');

  // ─── R10-B-PRODUCTION-FIXTURE-VERIFICATION (4 Round-6 production replays — NEW DISCIPLINE) ───
  console.log('\n--- R10-B-PRODUCTION-FIXTURE-VERIFICATION (live Supabase replay) ---');
  const productionFixtures = [
    { label: 'Donna deal 45bd01df', dealId: '45bd01df-4d8f-4ff4-98b0-86d80db79876', expected: 'Donna' },
    { label: 'Jerome deal a0caddfb', dealId: 'a0caddfb-92c4-4607-8ec1-72f54f9ebb31', expected: 'Jerome' },
    { label: 'Simone deal 30d1e798', dealId: '30d1e798-38b0-410a-8e9a-9999ea26c61f', expected: 'Simone' },
    { label: 'Harpreet deal c95f3a20', dealId: 'c95f3a20-162c-45cf-a98c-60b6bbb2de9a', expected: 'Harpreet' },
  ];
  for (const fx of productionFixtures) {
    const { data: msgs } = await supabase
      .from('messages')
      .select('body')
      .eq('deal_id', fx.dealId)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: true })
      .limit(1);
    const body = msgs?.[0]?.body || '';
    const result = parseBrokerFirstName(body);
    expect(`(${fx.label}) parseBrokerFirstName → "${fx.expected}"`,
      result === fx.expected,
      `got "${result}"`);
  }

  // ─── R10-B-R10A-FIXTURE-CORRECTION ───
  console.log('\n--- R10-B-R10A-FIXTURE-CORRECTION ---');
  // R10-A fixture corrected: 3-line shape (Name / Company / Lic.# on separate lines)
  // instead of pre-correction synthetic single-line shape that didn't match production
  const donnaProductionShape = `Hi,

My name is Donna Blackwood from Pemberton Lending Inc. (Lic. #MB668374).
I'd like to submit a new file.

Donna Blackwood
Pemberton Lending Inc.
Lic. #MB668374`;
  expect('(a) corrected R10-A Donna fixture (3-line sig) → "Donna" via parseBrokerFirstName',
    parseBrokerFirstName(donnaProductionShape) === 'Donna');
  // Pre-correction synthetic shape would have yielded "Donna" via signature alone
  // (preceding-line of single-line "Pemberton Lending Inc. Lic. #MB668374" was
  // "Donna Blackwood"). Verify the new shape (which broke pre-R10-B) now works
  // via body-prose primary path.

  // Same correction for Jerome
  const jeromeProductionShape = `Hi,

My name is Jerome Osei from Clearpath Mortgage Partners (Lic. #MB779485).
I'd like to submit a new file.

Jerome Osei
Clearpath Mortgage Partners
Lic. #MB779485`;
  expect('(b) corrected R10-A Jerome fixture (3-line sig) → "Jerome" via parseBrokerFirstName',
    parseBrokerFirstName(jeromeProductionShape) === 'Jerome');

  // ─── R10-B-CROSS-CLUSTER-INTEGRATION (10 anchors) ───
  console.log('\n--- R10-B-CROSS-CLUSTER-INTEGRATION ---');
  expect('(a) parseBrokerFirstNameFromSignature signature unchanged (R8-A compat)',
    /const parseBrokerFirstNameFromSignature = \(emailBody\) =>/.test(_r10bAiSrc));
  expect('(b) parseBrokerFirstNameFromSignature behavior unchanged on legacy 5 fixtures (5/5 above)',
    true);
  expect('(c) R10-A matchAll + last-to-first iteration in pattern (a) preserved',
    /precedingMatches = \[\.\.\.beforeFooter\.matchAll/.test(_r10bAiSrc)
    && /for \(let i = precedingMatches\.length - 1; i >= 0; i--\)/.test(_r10bAiSrc));
  expect('(d) R10-A classifier body-signal override preserved + upgraded to parseBrokerFirstName',
    /_r10aBodySignal[\s\S]{0,200}parseBrokerFirstName/.test(_r10bWebhookSrc));
  expect('(e) R9-F classifyIntakeBorrower categories preserved',
    /return 'reject:admin-as-borrower'/.test(_r10bWebhookSrc)
    && /return 'reject:system-sender'/.test(_r10bWebhookSrc)
    && /return 'reject:no-human-name'/.test(_r10bWebhookSrc));
  expect('(f) R9-F\' findExistingDealForBorrower wire preserved',
    /dealsService\.findExistingDealForBorrower/.test(_r10bWebhookSrc));
  expect('(g) R9-E startCron factory preserved',
    (() => {
      const cronSrc = fs.readFileSync(path.join(__dirname, '../src/cron/dailySummary.js'), 'utf8');
      return /const startCron = \(\) =>/.test(cronSrc);
    })());
  expect('(h) selectGreetingFirstName + extractFirstName unchanged (downstream paths untouched)',
    (() => {
      const greetingSrc = fs.readFileSync(path.join(__dirname, '../src/lib/greeting.js'), 'utf8');
      return /const extractFirstName = \(full\) =>/.test(greetingSrc)
        && /const selectGreetingFirstName = /.test(greetingSrc);
    })());
  expect('(i) module.exports of ai.js + webhook.js preserved',
    /module\.exports = \{[\s\S]*?parseBrokerFirstName[\s\S]*?\};?/.test(_r10bAiSrc)
    && /module\.exports = router/.test(_r10bWebhookSrc));
  expect('(j) Inline validateCapture removed from parseBrokerFirstNameFromSignature',
    !/const validateCapture = \(rawCapture\) =>/.test(_r10bAiSrc));

  console.log(`\n========== R10-B mini-harness: ${passCount}/${passCount + failCount} PASS ==========`);
  if (failCount > 0) process.exit(1);
})().catch(e => {
  console.error('\nR10-B HARNESS FAILED:', e.stack || e.message);
  process.exit(1);
});
