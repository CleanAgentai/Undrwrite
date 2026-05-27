// R10-B empirical-grounding — broker greeting extraction hardening
//
// Franco Round-6 bugs (4 instances across 4 scenarios):
//   Bug 4-1: "Hi Pemberton!" — company-name extracted as Donna's broker first-name
//   Bug 5-1: "Hi Clearpath!" — company-name extracted as Jerome's broker first-name
//   Bug 6-1: "Hi Valleyview!" — company-name extracted as Simone's broker first-name
//   Bug 7-1: "Hi Please!" — imperative word from "Please advise on next steps."
//
// Two distinct failure modes:
//   (a) AI extractor putting company name in extracted_data.broker_name
//       (correct field for company is broker_company; AI confused them)
//   (b) Imperative word "Please" extracted as a Title-Case name candidate
//       (whether in broker_name or sender_name)
//
// extractFirstName in greeting.js: splits on whitespace, takes first token,
// validates /^[A-Z][a-zA-Z\-']*$/ — both "Pemberton" and "Please" pass.
// No filter for company-suffix shapes or imperative-word shapes.
//
// Empirical tasks:
//   (1) Inventory current deals with company-shape broker_name (any post-R10-A round)
//   (2) Inventory current deals with imperative/common-word broker_name
//   (3) Check if Round 6 Donna/Jerome/Simone deals exist (R10-A shipped 2026-05-26;
//       Franco's Round-6 Scenarios 4-7 may have hit production post-ship)
//   (4) Empirical regex calibration: company-suffix tokens that should be filtered
//   (5) Imperative-word / common-word tokens that shouldn't be greeted

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

(async () => {
  console.log('R10-B EMPIRICAL — broker greeting extraction hardening');
  console.log('='.repeat(80));

  // ────── 1. Recent deals: post-R10-A baseline ──────
  console.log('\nSTRATEGY 1: all deals post-Q5a cleanup');
  console.log('-'.repeat(80));
  const { data: all } = await supabase
    .from('deals')
    .select('id, email, borrower_name, status, created_at, extracted_data')
    .order('created_at', { ascending: false });
  console.log(`total deals: ${all?.length || 0}`);

  // ────── 2. Round 6 fixture inventory: Donna / Jerome / Simone / Round-6-shape ──────
  console.log('\n\nSTRATEGY 2: Round 6 fixture deals (Donna/Jerome/Simone/Pemberton/Clearpath/Valleyview)');
  console.log('-'.repeat(80));
  const r6Patterns = ['donna', 'jerome', 'simone', 'pemberton', 'clearpath', 'valleyview'];
  for (const p of r6Patterns) {
    const matches = (all || []).filter(d => {
      const bn = (d.borrower_name || '').toLowerCase();
      const ed = d.extracted_data || {};
      const eb = (ed.broker_name || '').toLowerCase();
      const ec = (ed.broker_company || '').toLowerCase();
      const es = (ed.sender_name || '').toLowerCase();
      return bn.includes(p) || eb.includes(p) || ec.includes(p) || es.includes(p);
    });
    if (matches.length > 0) {
      console.log(`\n  pattern "${p}": ${matches.length} matches`);
      for (const d of matches.slice(0, 5)) {
        const ed = d.extracted_data || {};
        console.log(`    ${d.id} | ${d.created_at.slice(0, 19)} | borrower="${d.borrower_name}" | broker_name="${ed.broker_name || '(none)'}" | broker_company="${ed.broker_company || '(none)'}" | sender_name="${ed.sender_name || '(none)'}"`);
      }
    } else {
      console.log(`  pattern "${p}": 0 matches`);
    }
  }

  // ────── 3. Inventory: broker_name that's actually company-shaped ──────
  console.log('\n\nSTRATEGY 3: deals with company-suffix in broker_name (failure mode a)');
  console.log('-'.repeat(80));
  const companySuffixRe = /\b(Inc\.?|LLC|Ltd\.?|Corp\.?|LLP|Lending|Mortgage|Partners|Group|Brokers?|Financial|Capital|Realty|Holdings|Solutions|Services)\b/i;
  const companyShaped = (all || []).filter(d => {
    const eb = d.extracted_data?.broker_name || '';
    return companySuffixRe.test(eb);
  });
  console.log(`deals with company-suffix in broker_name: ${companyShaped.length}`);
  for (const d of companyShaped.slice(0, 20)) {
    const ed = d.extracted_data || {};
    console.log(`  ${d.created_at.slice(0, 10)} | broker_name="${ed.broker_name}" | broker_company="${ed.broker_company || '(none)'}"`);
  }

  // ────── 4. Inventory: imperative/common-word broker_name (failure mode b) ──────
  console.log('\n\nSTRATEGY 4: deals with imperative/common-word first-token in broker_name (failure mode b)');
  console.log('-'.repeat(80));
  const commonWords = new Set([
    'Please', 'Thank', 'Thanks', 'Looking', 'Hoping', 'Trying', 'Hoping',
    'Re', 'Fwd', 'Forward', 'Reply', 'Sent', 'Sender', 'Mailer',
    'Notice', 'Notification', 'Alert', 'Update', 'Request', 'Submission',
    'Borrower', 'Broker', 'Lender', 'Mortgage', 'Loan', 'Client', 'Customer',
    'Confidential', 'Privacy', 'Disclaimer',
  ]);
  const commonShaped = (all || []).filter(d => {
    const eb = d.extracted_data?.broker_name || '';
    const firstTok = eb.trim().split(/\s+/)[0];
    return firstTok && commonWords.has(firstTok);
  });
  console.log(`deals with common-word first-token in broker_name: ${commonShaped.length}`);
  for (const d of commonShaped.slice(0, 10)) {
    const ed = d.extracted_data || {};
    console.log(`  ${d.created_at.slice(0, 10)} | broker_name="${ed.broker_name}" | sender_name="${ed.sender_name || '(none)'}"`);
  }

  // ────── 5. Same checks but on sender_name (greeting fallback path) ──────
  console.log('\n\nSTRATEGY 5: deals with company-suffix OR common-word in sender_name (greeting-fallback failure surface)');
  console.log('-'.repeat(80));
  const senderIssues = (all || []).filter(d => {
    const es = d.extracted_data?.sender_name || '';
    const firstTok = es.trim().split(/\s+/)[0];
    return (firstTok && commonWords.has(firstTok)) || companySuffixRe.test(es);
  });
  console.log(`deals with company-suffix or common-word in sender_name: ${senderIssues.length}`);
  for (const d of senderIssues.slice(0, 10)) {
    const ed = d.extracted_data || {};
    console.log(`  ${d.created_at.slice(0, 10)} | sender_name="${ed.sender_name}" | broker_name="${ed.broker_name || '(none)'}"`);
  }

  // ────── 6. Greeting-extraction surface: what extractFirstName returns ──────
  console.log('\n\nSTRATEGY 6: greeting-extraction empirical — extractFirstName outputs');
  console.log('-'.repeat(80));
  const { extractFirstName, selectGreetingFirstName } = require('../src/lib/greeting');
  const samples = [
    // Failure-mode fixtures (Franco Round-6 bug shapes)
    'Pemberton Lending Inc.',
    'Clearpath Mortgage Partners',
    'Valleyview',
    'Please',
    'Please advise on next steps',
    // Legitimate broker names
    'Donna Blackwood',
    'Jerome Osei',
    'Eric Johansson',
    // Edge cases
    'Donna Blackwood from Pemberton Lending Inc.',
    'I\'m Donna Blackwood',
  ];
  for (const s of samples) {
    const first = extractFirstName(s);
    const greeting = selectGreetingFirstName({ broker_name: s, sender_type: 'broker' });
    console.log(`  "${s.slice(0, 50)}"`);
    console.log(`    extractFirstName → "${first}"`);
    console.log(`    selectGreetingFirstName → "${greeting}"`);
  }

  // ────── 7. R8-A parseBrokerFirstNameFromSignature reachability ──────
  console.log('\n\nSTRATEGY 7: R8-A parseBrokerFirstNameFromSignature reachable as fallback');
  console.log('-'.repeat(80));
  const aiService = require('../src/services/ai');
  console.log(`  parseBrokerFirstNameFromSignature export: ${typeof aiService.parseBrokerFirstNameFromSignature}`);
  // Test on the Donna body — R10-A enhanced this to catch the Donna shape
  const donnaBody = `Hi Franco,

I'm Donna Blackwood from Pemberton Lending Inc. Lic. #MB668374.

Donna Blackwood
Pemberton Lending Inc. Lic. #MB668374`;
  console.log(`  Donna body parse: "${aiService.parseBrokerFirstNameFromSignature(donnaBody)}"`);

  // Surface for plan-first: when extracted broker_name looks company-shaped OR
  // common-word-shaped, falling back to parseBrokerFirstNameFromSignature on
  // the email body (R10-A enhanced) recovers the correct first-name.
  // Question: where to wire this fallback — inside selectGreetingFirstName,
  // OR at each call site, OR as a wrapper helper.
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
