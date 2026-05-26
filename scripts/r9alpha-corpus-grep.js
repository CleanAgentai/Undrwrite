// R9-A empirical-grounding — file-completion handoff workflow probe.
//
// Three sub-bugs:
//   S2-Bug-1 + S3-Bug-2 (PERSISTENT cross-scenario): final handoff requires
//     admin SEND confirmation. Standard fixed language never needs editing;
//     auto-send required.
//   S3-Bug-3: wrong closing language in handoff draft ("can proceed with
//     our review"). Correct: "The file is now complete and submitted.
//     Please direct any further questions to Franco at
//     franco@privatemortgagelink.com."
//   S3-Bug-1: informational update to admin missing on Derek BEFORE the
//     (incorrect) draft. Correct flow: informational update to admin first
//     → auto-send handoff to broker.
//
// Fixtures: Marcus Webb (S2), Mohammed Al-Farsi (S3 — admin closing Derek's
// file).
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const stripHtml = s => (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  console.log('R9-A EMPIRICAL GROUNDING — file-completion handoff workflow');
  console.log('═'.repeat(72));

  // 1. Find recent Marcus Webb + Derek Olsen deals (post-2026-05-22 R8-A retest).
  console.log('\nSTRATEGY 1: locate Marcus Webb + Derek Olsen retest fixtures');
  console.log('─'.repeat(72));
  const { data: candidates } = await supabase
    .from('deals')
    .select('id, borrower_name, status, created_at, prelim_approved_at, conditions_sent_at, aml_pep_requested_at, completed_at, admin_controlled, extracted_data')
    .or('borrower_name.ilike.%Marcus%Webb%,borrower_name.ilike.%Derek%Olsen%')
    .order('created_at', { ascending: false })
    .limit(20);
  console.log(`candidates: ${candidates?.length || 0}`);
  for (const d of candidates || []) {
    const broker = d.extracted_data?.broker_name || '(none)';
    console.log(`  ${d.id} | ${d.borrower_name} | broker=${broker} | status=${d.status} | created=${d.created_at} | prelim=${d.prelim_approved_at?.slice(0, 16) || '-'} | conditions=${d.conditions_sent_at?.slice(0, 16) || '-'} | aml_pep=${d.aml_pep_requested_at?.slice(0, 16) || '-'} | completed=${d.completed_at?.slice(0, 16) || '-'} | adminCtl=${d.admin_controlled}`);
  }

  // 2. Pick most-recent Marcus + Derek deals and pull full timeline.
  const marcus = (candidates || []).find(d => /marcus/i.test(d.borrower_name) && d.created_at > '2026-05-22');
  const derek = (candidates || []).find(d => /derek/i.test(d.borrower_name) && d.created_at > '2026-05-22');

  for (const target of [marcus, derek].filter(Boolean)) {
    console.log(`\n\n${'═'.repeat(72)}\nDEAL TIMELINE: ${target.id} (${target.borrower_name})\n${'═'.repeat(72)}`);
    const { data: msgs } = await supabase
      .from('messages')
      .select('direction, subject, body, created_at, external_message_id, is_draft, message_type')
      .eq('deal_id', target.id)
      .order('created_at', { ascending: true });
    console.log(`messages: ${msgs?.length || 0} (${msgs?.filter(m=>m.direction==='inbound').length} in + ${msgs?.filter(m=>m.direction==='outbound').length} out)`);

    for (let i = 0; i < (msgs || []).length; i++) {
      const m = msgs[i];
      const text = stripHtml(m.body);
      console.log(`\n──── #${i} ${m.direction.toUpperCase()} ${m.created_at} ${m.is_draft ? '[DRAFT]' : ''} ${m.message_type || ''}`);
      console.log(`  subject: ${m.subject}`);
      console.log(`  body[0..400]: ${text.slice(0, 400)}`);
      // R9-A flags
      const flags = [];
      if (/can proceed with our review/i.test(text)) flags.push('S3-Bug-3: "can proceed with our review" (wrong closing)');
      if (/file is now complete and submitted/i.test(text)) flags.push('S3-Bug-3 fix-language: "file is now complete and submitted" PRESENT');
      if (/franco@privatemortgagelink\.com/i.test(text)) flags.push('S3-Bug-3 fix-language: Franco email PRESENT');
      if (/file is complete|file complete|all docs received|all documents received/i.test(m.subject || '')) flags.push('FILE-COMPLETE subject anchor');
      if (m.is_draft && /complete|submitted|ready to close|handoff/i.test(text)) flags.push('S2-Bug-1 / S3-Bug-2 candidate: DRAFT (admin-SEND-confirmation gate)');
      if (flags.length > 0) console.log(`  ⚠ FLAGS: ${flags.join(' | ')}`);
    }
  }

  // 3. Code-path discovery: identify completion-handoff trigger sites.
  console.log(`\n\n${'═'.repeat(72)}\nSTRATEGY 3: code-path discovery — completion-handoff dispatch\n${'═'.repeat(72)}`);
  // Use child_process to grep
  const { execSync } = require('child_process');
  const grep = (pattern, file) => {
    try {
      return execSync(`grep -n "${pattern}" ${file} 2>/dev/null || true`).toString().trim();
    } catch (e) { return ''; }
  };
  console.log('\nwebhook.js — generateCompletionEmail / sendCompletionHandoff sites:');
  console.log(grep('generateCompletionEmail\\|sendCompletionHandoff\\|completion-handoff\\|saveDraftAndPreview.*completed\\|saveDraftAndPreview.*completion\\|approval_completed', 'src/routes/webhook.js'));
  console.log('\nai.js — generateCompletionEmail signature + closing-language:');
  console.log(grep('generateCompletionEmail\\|can proceed with our review\\|now complete and submitted\\|further questions to Franco', 'src/services/ai.js'));
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
