// R9-A' empirical-grounding — Derek conversational-handler hallucination +
// documents-layer empirical question (deferred from R9-A SPLIT verdict).
//
// Two structurally distinct sub-questions:
//   (1) DOCUMENTS-LAYER: Derek df33cdbf msg #10 inbound said "Please find
//       AML and PEP forms attached" but NO AML/PEP rows landed in documents
//       table. Was Franco-testing-artifact (no actual attachments) OR real
//       attachment-parsing/classification bug (attachments present but not
//       classified)?
//   (2) CONVERSATIONAL-HALLUCINATION: regardless of (1), generateBrokerResponse
//       emitted "we now have everything we need... can proceed with our
//       review" when allDocsIn=false. Conversational handler should NOT
//       emit completion-shape language when deal is not actually classified
//       as complete.
//
// Empirical tasks:
//   (a) Pull Derek msg #10 raw inbound — look for attachment metadata,
//       Postmark headers, external_message_id
//   (b) Check what columns exist on messages table that might store
//       attachment info
//   (c) Look at Postmark webhook storage / inbound payload archival
//   (d) Trace conversational handler that emitted msg #11/13 (Vienna
//       outbound) — generateBrokerResponse prompt source
//   (e) Identify existing prompt language around "have everything we need"
//       / "can proceed with our review" / completion-shape phrases

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const stripHtml = s => (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  console.log('R9-A\' EMPIRICAL GROUNDING — Derek conversational hallucination + docs-layer');
  console.log('═'.repeat(80));

  const DEREK = 'df33cdbf-dd7c-4464-96f0-a1b59bfed061';

  // 1. Pull Derek msg #10 + neighboring messages with all available columns
  console.log('\nSTRATEGY 1: Derek msg #10 inbound — attachment metadata');
  console.log('─'.repeat(80));
  const { data: msgs } = await supabase
    .from('messages')
    .select('*')
    .eq('deal_id', DEREK)
    .order('created_at', { ascending: true });
  console.log(`total messages: ${msgs.length}`);
  console.log(`message columns: ${Object.keys(msgs[0] || {}).join(', ')}`);

  // Surface msg #10 (broker inbound claiming AML/PEP) + msgs #9/11 (surrounding)
  for (let i = 9; i <= 13 && i < msgs.length; i++) {
    const m = msgs[i];
    console.log(`\n══ msg #${i} ${m.direction.toUpperCase()} ${m.created_at.slice(0, 19)} ══`);
    console.log(`  subject: ${m.subject}`);
    console.log(`  external_message_id: ${m.external_message_id}`);
    const text = stripHtml(m.body);
    console.log(`  body[0..600]: ${text.slice(0, 600)}`);
  }

  // 2. Check for attachment-related columns or audit tables.
  console.log('\n\nSTRATEGY 2: documents table for Derek — all docs around msg #10 timestamp');
  console.log('─'.repeat(80));
  const { data: docs } = await supabase
    .from('documents')
    .select('file_name, classification, created_at, extracted_data')
    .eq('deal_id', DEREK)
    .order('created_at', { ascending: true });
  console.log(`total docs: ${docs.length}`);
  for (const d of docs) {
    const textLen = d.extracted_data?.text?.length || 0;
    console.log(`  ${d.created_at.slice(0, 19)} | ${d.classification || '(none)'} | ${d.file_name} (extracted_text=${textLen} chars)`);
  }

  // 3. Check if any other related tables exist that might store inbound
  //    attachment info (audit_log, postmark_inbound_archive, etc.)
  console.log('\n\nSTRATEGY 3: scan deals + messages for any archive/raw fields');
  console.log('─'.repeat(80));
  // Try to find raw_payload or similar columns
  const { data: dealsCols } = await supabase
    .from('deals')
    .select('*')
    .eq('id', DEREK)
    .limit(1);
  const dealKeys = Object.keys(dealsCols?.[0] || {});
  const archivalKeys = dealKeys.filter(k => /raw|archive|payload|webhook|postmark|attach/i.test(k));
  console.log(`deals archival/raw columns: ${archivalKeys.length === 0 ? '(none)' : archivalKeys.join(', ')}`);

  // 4. Conversational handler — find generateBrokerResponse prompt code
  console.log('\n\nSTRATEGY 4: code-path — generateBrokerResponse + completion-shape phrases');
  console.log('─'.repeat(80));
  const { execSync } = require('child_process');
  const grep = (pattern, file, n) => {
    try {
      return execSync(`grep -n "${pattern}" ${file} 2>/dev/null | head -${n || 30} || true`).toString().trim();
    } catch (e) { return ''; }
  };
  console.log('\nai.js — generateBrokerResponse signature + completion-shape prompt language:');
  console.log(grep('generateBrokerResponse:\\|have everything\\|can proceed with\\|proceed with our review\\|allDocsReceived\\|moving forward with the review\\|ready to start', 'src/services/ai.js', 30));
  console.log('\nwebhook.js — generateBrokerResponse call sites + allDocsIn passing:');
  console.log(grep('generateBrokerResponse\\|allDocsIn\\|allDocsReceived', 'src/routes/webhook.js', 30));
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
