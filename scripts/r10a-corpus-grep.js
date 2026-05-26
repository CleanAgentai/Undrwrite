// R10-A empirical-grounding — body-aware classifier signal investigation.
//
// Franco bug reports (Round 6 Scenario 4 + 5):
//   - Donna Blackwood (Pemberton Lending Inc, Lic. #MB668374) submitted Ryan Callahan
//   - Jerome Osei (Clearpath Mortgage Partners, Lic. #MB779485) submitted Patricia Simmons
//   - Postmark From-Name="Franco Maione" (broker Gmail display-name artifact)
//   - R9-F classifyIntakeBorrower → reject:admin-as-borrower → silent drop
//   - Body clearly identifies the broker; classifier doesn't read body
//
// Tasks:
//   (1) Schema: any postmark archive table? (probably not)
//   (2) Find Donna/Jerome related messages (likely silent-dropped → not in DB)
//   (3) License number pattern empirical across messages.body corpus
//   (4) "I'm X from Y" / broker self-identification body pattern empirical
//   (5) "From [Name], [Company]" pattern empirical
//   (6) Current reject categories: which had admin-as-borrower false positives
//       in past data

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

(async () => {
  console.log('R10-A EMPIRICAL — body-aware classifier signal investigation');
  console.log('='.repeat(80));

  // ────── 1. Check for postmark archive tables ──────
  console.log('\nSTRATEGY 1: postmark archive table probe');
  console.log('-'.repeat(80));
  for (const tbl of ['postmark_inbound_archive', 'postmark_archive', 'inbound_archive', 'webhook_archive', 'raw_inbound', 'raw_payloads']) {
    const { error } = await supabase.from(tbl).select('id').limit(1);
    if (error && error.code === '42P01') console.log(`  ${tbl}: DOES NOT EXIST`);
    else if (error && error.code === 'PGRST205') console.log(`  ${tbl}: DOES NOT EXIST (PGRST205)`);
    else if (error) console.log(`  ${tbl}: error ${error.code}`);
    else console.log(`  ${tbl}: EXISTS`);
  }

  // ────── 2. Donna / Jerome related messages (likely silent-dropped) ──────
  console.log('\n\nSTRATEGY 2: messages mentioning Donna Blackwood / Jerome Osei / Pemberton / Clearpath');
  console.log('-'.repeat(80));
  for (const pattern of ['%Donna Blackwood%', '%Jerome Osei%', '%Pemberton%', '%Clearpath%', '%MB668374%', '%MB779485%']) {
    const { data, error } = await supabase
      .from('messages')
      .select('id, deal_id, direction, subject, created_at')
      .or(`body.ilike.${pattern},subject.ilike.${pattern}`)
      .limit(5);
    if (error) {
      console.log(`  ${pattern}: error ${error.message.slice(0, 60)}`);
      continue;
    }
    console.log(`  ${pattern}: ${(data || []).length} matches`);
    for (const m of (data || []).slice(0, 3)) {
      console.log(`    ${m.created_at.slice(0, 10)} | dir=${m.direction} | subj="${(m.subject || '').slice(0, 60)}"`);
    }
  }

  // ────── 3. License number pattern empirical ──────
  console.log('\n\nSTRATEGY 3: license number pattern across messages.body corpus');
  console.log('-'.repeat(80));
  const { data: allMsgs } = await supabase
    .from('messages')
    .select('id, deal_id, direction, subject, body')
    .eq('direction', 'inbound')
    .limit(500);
  console.log(`inbound messages sampled: ${allMsgs?.length || 0}`);

  // Pattern variants to test for license number signal
  const licPatterns = [
    { name: 'Lic. #MB######', re: /Lic\.?\s*#?\s*MB\s*\d{4,8}/i },
    { name: 'License #...', re: /License\s*#?\s*[A-Z]{0,3}\s*\d{4,8}/i },
    { name: 'bare MB######', re: /\bMB\s*\d{6}\b/i },
    { name: 'Broker License: ...', re: /Broker\s+Licen[cs]e\s*#?:?\s*[\w-]+/i },
    { name: 'License Number ...', re: /License\s+Number\s*#?:?\s*[\w-]+/i },
    { name: 'FSCO ###', re: /FSCO\s*#?\s*\d{4,8}/i },
    { name: 'License No. ...', re: /License\s+No\.?\s*[\w-]+/i },
  ];
  for (const p of licPatterns) {
    const matches = (allMsgs || []).filter(m => p.re.test(m.body || ''));
    console.log(`  ${matches.length.toString().padStart(4)} | pattern: ${p.name}`);
    // Show first 3 matches with context
    for (const m of matches.slice(0, 3)) {
      const match = (m.body || '').match(p.re);
      const idx = match ? (m.body || '').indexOf(match[0]) : -1;
      const ctx = idx >= 0 ? (m.body || '').slice(Math.max(0, idx - 20), idx + match[0].length + 30) : '';
      console.log(`         e.g.: "...${ctx.replace(/\s+/g, ' ')}..."`);
    }
  }

  // ────── 4. "I'm X from Y" broker self-identification pattern ──────
  console.log('\n\nSTRATEGY 4: broker self-identification body patterns');
  console.log('-'.repeat(80));
  const idPatterns = [
    { name: "I'm [Name] from/with [Company]", re: /I[''']?m\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:from|with|at|of)\s+([A-Z][\w\s&'.,-]{2,50}?)(?:\.|,| Lic| \(|$)/m },
    { name: "My name is [Name]", re: /My\s+name\s+is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/m },
    { name: "From [Name], [Company]", re: /^From:?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}),\s+([A-Z][\w\s&'.,-]{2,50})/m },
    { name: "This is [Name] from [Company]", re: /This\s+is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:from|with|at)\s+([A-Z][\w\s&'.,-]{2,50})/m },
    { name: "[Name] here from [Company]", re: /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+here\s+(?:from|with|at)\s+([A-Z][\w\s&'.,-]{2,50})/m },
    { name: "—[Name]\\n[Company]", re: /(?:^|\n)[-—]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s*\n+\s*([A-Z][\w\s&'.,-]{2,50})/ },
  ];
  for (const p of idPatterns) {
    const matches = (allMsgs || []).filter(m => p.re.test(m.body || ''));
    console.log(`  ${matches.length.toString().padStart(4)} | pattern: ${p.name}`);
    for (const m of matches.slice(0, 2)) {
      const match = (m.body || '').match(p.re);
      console.log(`         e.g.: "${(match?.[0] || '').slice(0, 100).replace(/\s+/g, ' ')}..."`);
    }
  }

  // ────── 5. Both signals together (license + broker self-ID) ──────
  console.log('\n\nSTRATEGY 5: messages with BOTH license number AND broker self-identification');
  console.log('-'.repeat(80));
  const hasLicense = (b) => /Lic\.?\s*#?\s*MB\s*\d{4,8}|License\s*#?\s*[A-Z]{0,3}\s*\d{4,8}/i.test(b || '');
  const hasSelfId = (b) => /I[''']?m\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:from|with|at|of)\s+/.test(b || '');
  const bothSignals = (allMsgs || []).filter(m => hasLicense(m.body) && hasSelfId(m.body));
  console.log(`messages with BOTH signals: ${bothSignals.length} / ${(allMsgs || []).length}`);
  console.log(`messages with license only: ${(allMsgs || []).filter(m => hasLicense(m.body) && !hasSelfId(m.body)).length}`);
  console.log(`messages with self-id only: ${(allMsgs || []).filter(m => !hasLicense(m.body) && hasSelfId(m.body)).length}`);
  console.log(`messages with neither:      ${(allMsgs || []).filter(m => !hasLicense(m.body) && !hasSelfId(m.body)).length}`);

  // ────── 6. Postmark From-Name="Franco Maione" surface — broker submissions with admin-name display ──────
  console.log('\n\nSTRATEGY 6: deals where extracted_data.sender_name contains "Franco" — admin-name display surface');
  console.log('-'.repeat(80));
  const { data: francoDeals } = await supabase
    .from('deals')
    .select('id, email, borrower_name, status, extracted_data, created_at')
    .order('created_at', { ascending: false });
  const francoSenderName = (francoDeals || []).filter(d => {
    const sn = d.extracted_data?.sender_name || '';
    return /franco/i.test(sn);
  });
  console.log(`deals with extracted_data.sender_name matching /franco/: ${francoSenderName.length}`);
  for (const d of francoSenderName.slice(0, 10)) {
    console.log(`  ${d.created_at.slice(0, 10)} | "${d.borrower_name}" | email=${d.email} | sender_name="${d.extracted_data?.sender_name}" | broker_name="${d.extracted_data?.broker_name || '(none)'}"`);
  }

  // ────── 7. Existing classifier reject category check — historical false-positive surface ──────
  console.log('\n\nSTRATEGY 7: deals with borrower_name=Franco* (would-be-classifier-reject in current logic)');
  console.log('-'.repeat(80));
  const wouldReject = (francoDeals || []).filter(d => {
    const bn = (d.borrower_name || '').trim();
    return bn.toLowerCase().startsWith('franco');
  });
  console.log(`existing deals with borrower_name starting with "Franco": ${wouldReject.length}`);
  console.log('(These would have been rejected by R9-F if submitted post-R9-F; some may be legitimate broker-submitted-via-bad-display-name cases.)');
  for (const d of wouldReject.slice(0, 10)) {
    console.log(`  ${d.created_at.slice(0, 10)} | "${d.borrower_name}" | email=${d.email} | status=${d.status}`);
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
