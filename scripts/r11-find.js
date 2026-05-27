// R11 empirical-grounding — Marcus Webb / Jonathan Ferrara deal.
// Franco Round 7 retest surfaced 4 in-scope bugs on Scenario 2:
//   Bug 1: mortgage_position refinance handling (R10-E refinance gap;
//          R10-G broker_correction parser scope gap for mortgage_position;
//          R10-F discrepancyHold gate may have additional symmetry gap)
//   Bug 2: lender hallucination (Scotiabank vs RBC)
//   Bug 3: cascading combined-LTV 106.8% from hallucinated balance + requested
//   Bug 4: postal-code discrepancy narrative inlined into Property Address row
//
// Empirical-grounding tasks (per cluster brief):
//   1. Pull Marcus Webb deal (find by Jonathan Ferrara broker / Marcus Webb borrower)
//   2. canonical_map.mortgage_position tuples — what sources pushed what
//   3. canonical_map.requested_loan_amount + existing_first_mortgage_balance +
//      existing_first_mortgage_lender tuples
//   4. loan_application document — AcroForm annotations OR truly blank
//   5. parseBrokerCorrections invocations on Marcus's broker reply
//   6. discrepancyHold gate behavior across turns
//   7. Postal code renderer path that produces "postal codes differ" inline

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const dEngine = require('../src/services/discrepancy-engine');
const cFields = require('../src/services/canonical-fields');

(async () => {
  console.log('R11 EMPIRICAL — Marcus Webb / Jonathan Ferrara (Scenario 2 retest)');
  console.log('='.repeat(80));

  // (A) Find Marcus Webb deal
  console.log('\nSTRATEGY A: locate Marcus Webb deal');
  console.log('-'.repeat(80));
  const { data: deals } = await supabase
    .from('deals')
    .select('id, borrower_name, status, ltv, ownership_type, extracted_data, prelim_approved_at, created_at, email')
    .or('borrower_name.ilike.%marcus%webb%,borrower_name.ilike.%marcus%')
    .order('created_at', { ascending: false })
    .limit(10);
  console.log(`  ${deals.length} candidate(s):`);
  for (const d of deals) {
    console.log(`    id=${d.id} borrower="${d.borrower_name}" status=${d.status} ltv=${d.ltv} created=${d.created_at}`);
  }
  // Pick most recent Marcus Webb match (Round 7 retest is the freshest)
  const MARCUS = deals.find(d => /marcus.*webb/i.test(d.borrower_name || ''))
    || deals[0];
  if (!MARCUS) { console.log('  ABORT — no Marcus deal found'); process.exit(1); }
  console.log(`\nSelected MARCUS_ID=${MARCUS.id}`);
  console.log(`  status: ${MARCUS.status}`);
  console.log(`  ltv: ${MARCUS.ltv}`);
  console.log(`  prelim_approved_at: ${MARCUS.prelim_approved_at || '(none)'}`);
  console.log(`  broker email: ${MARCUS.email}`);

  // (B) extracted_data inventory
  console.log('\nSTRATEGY B: extracted_data inventory (Vienna LLM extraction)');
  console.log('-'.repeat(80));
  const ed = MARCUS.extracted_data || {};
  const keysOfInterest = [
    'borrower_name', 'broker_name', 'sender_name', 'loan_type', 'purpose',
    'mortgage_position', 'requested_loan_amount', 'loan_amount_requested',
    'property_value', 'subject_property_market_value', 'existing_mortgage_balance',
    'existing_first_mortgage_balance', 'existing_first_mortgage_lender',
    'ltv_percent', 'combined_ltv_percent', 'collateral_offered', 'exit_strategy',
    'ownership_type', 'key_risks_or_notes', 'unresolved_discrepancy',
  ];
  for (const k of keysOfInterest) {
    if (ed[k] !== undefined && ed[k] !== null && ed[k] !== '') {
      console.log(`  ${k}: ${JSON.stringify(ed[k]).slice(0, 200)}`);
    }
  }

  // (C) Full message thread
  console.log('\nSTRATEGY C: message thread inventory');
  console.log('-'.repeat(80));
  const { data: msgs } = await supabase
    .from('messages')
    .select('id, direction, subject, body, created_at')
    .eq('deal_id', MARCUS.id)
    .order('created_at', { ascending: true });
  console.log(`  Total messages: ${msgs.length}`);
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    console.log(`  [${i}] ${m.direction.toUpperCase()} | ${m.created_at.slice(0,19)} | ${(m.subject||'').slice(0,90)}`);
  }

  // (D) Documents on file
  console.log('\nSTRATEGY D: documents on file');
  console.log('-'.repeat(80));
  const { data: docs } = await supabase
    .from('documents')
    .select('file_name, classification, extracted_data, storage_path')
    .eq('deal_id', MARCUS.id);
  console.log(`  ${docs.length} doc(s):`);
  for (const d of docs) {
    const textLen = (d.extracted_data?.text || '').length;
    console.log(`    [${d.classification || 'unclassified'}] ${d.file_name} (text=${textLen} chars)`);
  }

  // (E) canonical_map inventory — all LTV-relevant + mortgage-position fields
  console.log('\nSTRATEGY E: canonical_map tuples (full sources + classifications)');
  console.log('-'.repeat(80));
  const inbounds = msgs.filter(m => m.direction === 'inbound');
  const docsForDetect = docs.map(d => ({
    file_name: d.file_name,
    classification: d.classification,
    text: d.extracted_data?.text || '',
  }));
  const detect = dEngine.runDiscrepancyDetectionAggregated(
    inbounds,
    docsForDetect,
    ed.borrower_name || null,
    { emailSubject: inbounds[0]?.subject || '' },
  );
  const cmap = detect.canonical_map || {};
  const fields = [
    'mortgage_position',
    'requested_loan_amount',
    'existing_first_mortgage_balance',
    'existing_first_mortgage_lender',
    'existing_first_mortgage_payout_total',
    'subject_property_market_value',
    'subject_property_address',
    'subject_property_city',
    'subject_property_province',
    'subject_property_postal_code',
    'purpose',
    'primary_borrower_full_name',
  ];
  for (const f of fields) {
    const tuples = cmap[f] || [];
    console.log(`  ${f}: ${tuples.length} tuple(s)`);
    for (const t of tuples) {
      console.log(`    value=${JSON.stringify(t.value)} source=${t.source} classification=${t.classification || '(none)'}${t.lender_canonical ? ` lender_canonical=${t.lender_canonical}` : ''}`);
    }
  }

  // (F) Loan application document — text + AcroForm annotation inspection
  console.log('\nSTRATEGY F: loan_application document content inspection');
  console.log('-'.repeat(80));
  const loanApp = docs.find(d => d.classification === 'loan_application');
  if (loanApp) {
    const text = loanApp.extracted_data?.text || '';
    console.log(`  file: ${loanApp.file_name}`);
    console.log(`  total text length: ${text.length}`);
    // Look for AcroForm annotation markers (R10-G empirical found these for Ethan)
    const formAnnotationCount = (text.match(/=== Form fields and annotations \(extracted via pdf-lib\) ===/gi) || []).length;
    const pageAnnotationCount = (text.match(/\[Page\s*\d+\s*annotation\]/gi) || []).length;
    console.log(`  AcroForm section markers: ${formAnnotationCount}`);
    console.log(`  [Page N annotation] markers: ${pageAnnotationCount}`);
    // Detect dollar amounts to map hallucination empirics
    const dollarMatches = [...text.matchAll(/\$[\d,]+(?:\.\d{2})?/g)].slice(0, 20);
    console.log(`  dollar amounts found (first 20): ${dollarMatches.map(m => m[0]).join(' | ')}`);
    // Detect lender mentions
    const lenderMentions = [...text.matchAll(/\b(?:RBC|TD|Scotiabank|BMO|CIBC|HSBC|Tangerine|Desjardins|National Bank)\b/gi)].slice(0, 20);
    console.log(`  lender mentions (first 20): ${lenderMentions.map(m => m[0]).join(' | ')}`);
    // Detect mortgage position language
    const positionMentions = text.match(/(?:first|second|third|1st|2nd|3rd)\s+mortgage/gi);
    console.log(`  mortgage position mentions: ${positionMentions ? positionMentions.slice(0, 10).join(' | ') : '(none)'}`);
    console.log(`\n  --- full text dump (truncated to 3000 chars) ---`);
    console.log(text.slice(0, 3000));
    console.log(`  --- end text dump ---`);
  } else {
    console.log('  NO loan_application doc found');
  }

  // (G) parseBrokerCorrections + parseBrokerInitialIntent invocation trace
  console.log('\nSTRATEGY G: broker corrections + initial intent inventory');
  console.log('-'.repeat(80));
  if (inbounds.length > 0) {
    const initialBody = dEngine.stripQuotedReplyChain(inbounds[0].body || '');
    const initialIntent = cFields.parseBrokerInitialIntent(initialBody);
    console.log(`  inbound[0] initial intent (from first broker email):`);
    console.log(`    ${JSON.stringify(initialIntent, null, 2).slice(0, 600)}`);
    for (let i = 1; i < inbounds.length; i++) {
      const correctionBody = dEngine.stripQuotedReplyChain(inbounds[i].body || '');
      const corrections = cFields.parseBrokerCorrections(correctionBody);
      console.log(`  inbound[${i}] corrections:`);
      console.log(`    ${JSON.stringify(corrections, null, 2).slice(0, 600)}`);
      if (corrections.length === 0) {
        // Show the stripped body so we can see what the parser SHOULD have caught
        console.log(`    [stripped body excerpt — ${correctionBody.length} chars]`);
        console.log(`    ${correctionBody.slice(0, 500).replace(/\s+/g, ' ')}`);
      }
    }
  }

  // (H) Prelim outbound — postal-code-in-address rendering trace
  console.log('\nSTRATEGY H: prelim outbound Snapshot rendering (Bug 4 anchor)');
  console.log('-'.repeat(80));
  const prelims = msgs.filter(m =>
    m.direction === 'outbound'
    && /PRELIMINARY|ACTION REQUIRED/i.test(m.subject || '')
  );
  console.log(`  ${prelims.length} prelim outbound(s)`);
  for (const p of prelims) {
    const body = p.body || '';
    console.log(`\n  ── ${p.created_at.slice(0,19)} | ${p.subject} ──`);
    // Property Address row inspection (Bug 4)
    const addressRow = body.match(/<p>\s*<strong>\s*Property Address[\s\S]{0,400}?<\/p>/i);
    if (addressRow) {
      console.log(`  Property Address row: ${addressRow[0].replace(/\s+/g, ' ').slice(0, 400)}`);
    }
    // Mortgage Position row
    const positionRow = body.match(/<p>\s*<strong>\s*Mortgage Position[\s\S]{0,200}?<\/p>/i);
    if (positionRow) {
      console.log(`  Mortgage Position row: ${positionRow[0].replace(/\s+/g, ' ')}`);
    }
    // Existing first mortgage rows
    const existingLenderRow = body.match(/<p>\s*<strong>\s*Existing[\s\S]{0,200}?<\/p>/gi);
    if (existingLenderRow) {
      for (const r of existingLenderRow.slice(0, 5)) {
        console.log(`  Existing row: ${r.replace(/\s+/g, ' ')}`);
      }
    }
    // Loan amount
    const loanAmountRow = body.match(/<p>\s*<strong>\s*Loan Amount[\s\S]{0,200}?<\/p>/i);
    if (loanAmountRow) {
      console.log(`  Loan Amount row: ${loanAmountRow[0].replace(/\s+/g, ' ')}`);
    }
    // Combined LTV
    const combinedLtvRow = body.match(/<p>\s*<strong>\s*Combined LTV[\s\S]{0,300}?<\/p>/i);
    if (combinedLtvRow) {
      console.log(`  Combined LTV row: ${combinedLtvRow[0].replace(/\s+/g, ' ')}`);
    }
    // Risk Factors / Discrepancy Flag
    const rfMatch = body.match(/<p>\s*<strong>\s*Discrepancy Flag[\s\S]{0,800}?<\/p>/i);
    if (rfMatch) {
      console.log(`  Discrepancy Flag (Risk Factors): ${rfMatch[0].replace(/\s+/g, ' ').slice(0, 600)}`);
    }
  }

  // (I) Conversation-flow trace — every broker turn and Vienna's response shape
  console.log('\nSTRATEGY I: per-turn behavior trace (was clarification asked? Did broker respond? Was correction parsed?)');
  console.log('-'.repeat(80));
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.direction !== 'outbound') continue;
    const body = m.body || '';
    const asksClarification = /could you (?:please )?(?:confirm|clarify)|I noticed a discrepancy|I'?d like to confirm|needs clarification/i.test(body);
    const mentionsPosition = /mortgage position|first mortgage|second mortgage|1st mortgage|2nd mortgage/i.test(body);
    if (asksClarification || mentionsPosition) {
      console.log(`  outbound[${i}] ${m.created_at.slice(0,19)} clarification=${asksClarification} position=${mentionsPosition}`);
      // Find the actual clarification ask
      const askMatch = body.match(/I noticed[\s\S]{0,300}?(?:\?|\.)/i);
      if (askMatch) {
        console.log(`    ask: "${askMatch[0].replace(/\s+/g, ' ').slice(0, 350)}"`);
      }
    }
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
