#!/usr/bin/env node
// BUG3B — staging replay of the Round-7 mortgage-position re-flagging loop.
// Covers the path the offline engine trace CANNOT: the LLM-generated outbound
// prose (where Round 7's "email shows 1st, inferred 2nd" symptom surfaced).
//
// Posts the 3-turn fixture (intake + 2 bare confirmation turns) to the deployed
// staging webhook, threads turns via In-Reply-To, captures every outbound
// message, and scans each for position-discrepancy symptoms.
require('dotenv').config();
const path = require('path');
const { runScenario } = require('../test-fixtures/bulletproof/lib/replay');

const FIX = path.join(__dirname, '../test-fixtures/bulletproof/scenarios/BUG3B-round7-1st-refi-confirm');

// Symptom scanners over outbound prose (HTML/text).
const SYMPTOMS = [
  { key: 'inferred-2nd', re: /inferred?\s+(?:as\s+)?(?:a\s+)?2nd|inferred?\s+second|appears?\s+to\s+be\s+(?:a\s+)?(?:2nd|second)/i },
  { key: 'email-shows-X-inferred-Y', re: /email\s+(?:shows?|states?|indicates?)[^.]{0,60}(?:inferred|but\s+(?:the\s+)?(?:docs?|application|statement))/i },
  { key: 'position-discrepancy-section', re: /mortgage\s+position[^.]{0,80}(?:discrepancy|differ|conflict|clarif|mismatch|inconsisten)/i },
  { key: 'second-mortgage-mention', re: /\b2nd\s+mortgage\b|\bsecond\s+mortgage\b|\bsubordinate\s+(?:financing|position)\b/i },
  { key: 'position-clarification-ask', re: /(?:confirm|clarify|verify)[^.]{0,60}(?:mortgage\s+)?position|is\s+this\s+a\s+(?:1st|first|2nd|second)/i },
];

const stripHtml = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  console.log('=== BUG3B STAGING REPLAY ===');
  console.log(`Fixture: ${FIX}`);
  console.log('Posting intake + 2 confirmation turns to staging (live webhook + real LLM + Supabase)...\n');

  const cap = await runScenario(FIX, { verbose: true, timeoutSec: 90 });

  console.log('\n=== CAPTURE ===');
  console.log(`runTag: ${cap.runTag}`);
  console.log(`dealId: ${cap.dealId}`);
  console.log(`mode: ${cap.mode}  duration: ${(cap.executionDurationMs / 1000).toFixed(0)}s`);
  console.log(`outbound messages captured: ${cap.outboundEmails.length}`);

  const ds = cap.finalDealState || {};
  console.log('\n=== FINAL DEAL STATE ===');
  console.log(`  status: ${ds.status}`);
  const ed = ds.extracted_data || {};
  console.log(`  borrower_name: ${ed.borrower_name}`);
  console.log(`  mortgage_position: ${ed.mortgage_position}`);
  console.log(`  loan_amount: ${ed.loan_amount}  property_value: ${ed.property_value}  ltv: ${ed.ltv || ed.standalone_ltv}`);
  console.log(`  transaction_type: ${ed.transaction_type}`);

  console.log('\n=== PER-MESSAGE OUTBOUND PROSE + SYMPTOM SCAN ===');
  let anySymptom = false;
  cap.outboundEmails.forEach((m, i) => {
    const text = stripHtml(m.HtmlBody || m.TextBody || '');
    const hits = SYMPTOMS.filter(s => s.re.test(text)).map(s => s.key);
    if (hits.length) anySymptom = true;
    console.log(`\n  [OUT ${i}] ${m.created_at}  subj="${m.Subject}"`);
    console.log(`    symptom hits: ${hits.length ? hits.join(', ') : '(none)'}`);
    console.log(`    prose (${text.length} chars): ${text.slice(0, 700)}${text.length > 700 ? ' …' : ''}`);
  });

  console.log('\n=== STAGING VERDICT ===');
  console.log(`  LLM-prose position symptom on ANY outbound: ${anySymptom}`);
  console.log(`  → ${anySymptom ? 'LLM-PROSE PATH REPRODUCES (capture which message above)' : 'LLM-prose path does NOT reproduce'}`);
})().catch(e => { console.error('REPLAY FAIL:', e); process.exit(1); });
