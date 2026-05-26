// R9-F' empirical-grounding — borrower-identity dedup architectural investigation.
//
// Context (S13 PERSISTENT-from-R4):
//   95 of 123 deals across 19 normalized-name groups = 77% duplicate rate.
//   Three failure modes from R9-F empirical:
//     (a) Middle-name variation (Marcus Webb vs Marcus James Webb)
//     (b) Repeat submissions same exact name (test rounds creating new records)
//     (c) Cross-status repeats (completed/rejected deals don't dedup new submissions)
//
// Goals of this empirical:
//   (1) Schema discovery — deals columns + any borrower_profiles-like tables
//   (2) Identity-signal inventory across the duplicate corpus:
//       what fields are RELIABLY present that we could use for dedup?
//       (email, phone, property_address, DOB, etc.)
//   (3) Drill-into 3 hottest duplicate groups: per-deal field population
//       (which signals could have caught the duplicate?)
//   (4) Property-address signal as carve-out: legitimate refinance/2nd-mortgage
//       same-borrower-different-property should NOT dedup
//   (5) extracted_data JSONB shape inventory — what identity-relevant
//       keys appear across deals?
//   (6) Existing email-based dedup behavior — findActiveByEmail already
//       exists; gap analysis: what cases does it miss?

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const normalizeName = (name) => {
  if (!name) return null;
  const tokens = String(name).toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  if (tokens.length === 1) return tokens[0];
  return `${tokens[0]} ${tokens[tokens.length - 1]}`;
};

(async () => {
  console.log('R9-F\' EMPIRICAL — borrower-identity dedup architectural investigation');
  console.log('═'.repeat(80));

  // ────── 1. Schema discovery ──────
  console.log('\nSTRATEGY 1: deals schema columns');
  console.log('─'.repeat(80));
  const { data: schemaSample } = await supabase
    .from('deals')
    .select('*')
    .limit(1);
  if (schemaSample && schemaSample[0]) {
    const cols = Object.keys(schemaSample[0]);
    console.log(`deals columns (${cols.length}):`);
    for (const c of cols) console.log(`  - ${c}`);
  }

  // Other potential identity-related tables
  console.log('\nProbing other tables for identity infrastructure:');
  for (const tbl of ['borrower_profiles', 'borrowers', 'identities', 'people']) {
    const { error } = await supabase.from(tbl).select('id').limit(1);
    if (error && error.code === '42P01') {
      console.log(`  ${tbl}: DOES NOT EXIST`);
    } else if (error) {
      console.log(`  ${tbl}: error ${error.code} ${error.message.slice(0, 60)}`);
    } else {
      console.log(`  ${tbl}: EXISTS`);
    }
  }

  // ────── 2. Full corpus dedup inventory ──────
  console.log('\n\nSTRATEGY 2: full corpus + dedup grouping');
  console.log('─'.repeat(80));
  const { data: all } = await supabase
    .from('deals')
    .select('id, borrower_name, email, status, created_at, extracted_data')
    .order('created_at', { ascending: true });
  console.log(`total deals: ${all.length}`);
  // Status distribution
  const statusCount = {};
  for (const d of all) statusCount[d.status] = (statusCount[d.status] || 0) + 1;
  console.log(`status distribution: ${JSON.stringify(statusCount)}`);

  // Group by normalized name
  const groups = {};
  for (const d of all) {
    const key = normalizeName(d.borrower_name) || '(null)';
    if (!groups[key]) groups[key] = [];
    groups[key].push(d);
  }
  const dupGroups = Object.entries(groups).filter(([_, ds]) => ds.length > 1);
  console.log(`\nnormalized-name groups: ${Object.keys(groups).length}`);
  console.log(`groups with >1 deal: ${dupGroups.length}`);
  console.log(`deals in such groups: ${dupGroups.reduce((s, [, ds]) => s + ds.length, 0)}`);
  console.log(`dup rate: ${(dupGroups.reduce((s, [, ds]) => s + ds.length, 0) / all.length * 100).toFixed(1)}%`);

  // ────── 3. Identity-signal inventory: which extracted_data keys appear? ──────
  console.log('\n\nSTRATEGY 3: extracted_data key population inventory (full corpus)');
  console.log('─'.repeat(80));
  const keyPresence = {};
  let withExtracted = 0;
  for (const d of all) {
    if (d.extracted_data && typeof d.extracted_data === 'object') {
      withExtracted++;
      for (const k of Object.keys(d.extracted_data)) {
        const v = d.extracted_data[k];
        if (v !== null && v !== undefined && v !== '') {
          keyPresence[k] = (keyPresence[k] || 0) + 1;
        }
      }
    }
  }
  console.log(`deals with non-null extracted_data: ${withExtracted}/${all.length}`);
  // Sort keys by presence count desc, show top 30
  const sortedKeys = Object.entries(keyPresence).sort((a, b) => b[1] - a[1]);
  console.log(`extracted_data keys present (count of deals where key is non-empty):`);
  for (const [k, n] of sortedKeys.slice(0, 30)) {
    console.log(`  ${String(n).padStart(4)} | ${k}`);
  }

  // ────── 4. Identity-signal candidates: email + phone + property_address + DOB ──────
  console.log('\n\nSTRATEGY 4: identity-signal candidate population (dedup-relevant fields)');
  console.log('─'.repeat(80));
  const sigs = {
    email_column: 0,           // deals.email
    extracted_phone: 0,        // extracted_data.phone or extracted_data.borrower_phone
    extracted_property: 0,     // extracted_data.subject_property_address or property_address
    extracted_dob: 0,          // extracted_data.dob or date_of_birth
    extracted_borrower_email: 0,  // sometimes nested
  };
  for (const d of all) {
    if (d.email) sigs.email_column++;
    const ed = d.extracted_data || {};
    if (ed.phone || ed.borrower_phone || ed.contact_phone) sigs.extracted_phone++;
    if (ed.subject_property_address || ed.property_address || ed.address) sigs.extracted_property++;
    if (ed.dob || ed.date_of_birth) sigs.extracted_dob++;
    if (ed.borrower_email || ed.email_address) sigs.extracted_borrower_email++;
  }
  console.log(`signal population across ${all.length} deals:`);
  for (const [k, n] of Object.entries(sigs)) {
    console.log(`  ${String(n).padStart(4)}/${all.length} (${(n / all.length * 100).toFixed(1)}%) | ${k}`);
  }

  // ────── 5. Drill into 3 hottest duplicate groups ──────
  console.log('\n\nSTRATEGY 5: drill into top 5 duplicate groups — per-deal identity signals');
  console.log('─'.repeat(80));
  dupGroups.sort((a, b) => b[1].length - a[1].length);
  for (const [key, ds] of dupGroups.slice(0, 5)) {
    const variants = [...new Set(ds.map(d => d.borrower_name))];
    console.log(`\n  GROUP "${key}" — ${ds.length} deals across ${variants.length} name-form(s):`);
    for (const v of variants) console.log(`    name-form: "${v}"`);
    // Per-deal: status, email, phone, property_address — what could have caught the dup?
    const emails = new Set();
    const phones = new Set();
    const properties = new Set();
    for (const d of ds) {
      const ed = d.extracted_data || {};
      emails.add(d.email || '(null)');
      phones.add(ed.phone || ed.borrower_phone || ed.contact_phone || '(null)');
      properties.add(ed.subject_property_address || ed.property_address || ed.address || '(null)');
      console.log(`    ${d.id} | ${d.created_at.slice(0, 10)} | status=${d.status.padEnd(13)} | email=${(d.email || '(null)').slice(0, 30).padEnd(30)} | phone=${(ed.phone || ed.borrower_phone || '(null)').slice(0, 16).padEnd(16)} | prop=${String(ed.subject_property_address || ed.property_address || '(null)').slice(0, 40)}`);
    }
    console.log(`    >> distinct emails: ${emails.size}, distinct phones: ${phones.size}, distinct properties: ${properties.size}`);
    // Dedup-could-have-caught analysis
    if (emails.size === 1 && !emails.has('(null)')) {
      console.log('    >> [DEDUP SIGNAL] all deals share 1 email — findActiveByEmail-equivalent could have caught most/all duplicates IF status didn\'t filter them out');
    }
    if (properties.size === 1 && !properties.has('(null)')) {
      console.log('    >> [DEDUP SIGNAL] all deals share 1 property — same-property signal could distinguish "resubmission" from "new property/refinance"');
    }
    if (properties.size > 1 && !properties.has('(null)') && properties.size === ds.length) {
      console.log('    >> [CARVE-OUT SIGNAL] all deals have DISTINCT properties — these may be LEGITIMATE multiple deals (different properties = different financing needs)');
    }
  }

  // ────── 6. Cross-status repeat analysis ──────
  console.log('\n\nSTRATEGY 6: cross-status repeat analysis — completed/rejected deals being re-created');
  console.log('─'.repeat(80));
  let crossStatusRepeats = 0;
  let sameEmailDifferentName = 0;
  let sameEmailSameName = 0;
  for (const [key, ds] of dupGroups) {
    // Cross-status: at least one is in completed/rejected AND another is in non-terminal status
    const terminal = ds.filter(d => d.status === 'completed' || d.status === 'rejected');
    const nonTerminal = ds.filter(d => d.status !== 'completed' && d.status !== 'rejected');
    if (terminal.length > 0 && nonTerminal.length > 0) crossStatusRepeats++;
    // Email-based grouping within this name-group
    const emailMap = {};
    for (const d of ds) {
      const e = d.email || '(null)';
      if (!emailMap[e]) emailMap[e] = [];
      emailMap[e].push(d);
    }
    for (const [_e, dealsByEmail] of Object.entries(emailMap)) {
      if (dealsByEmail.length > 1) sameEmailSameName += dealsByEmail.length;
    }
    if (Object.keys(emailMap).length > 1) sameEmailDifferentName++;
  }
  console.log(`groups with cross-status repeats (terminal + non-terminal): ${crossStatusRepeats}/${dupGroups.length}`);
  console.log(`deals where same email submitted same borrower repeatedly: ${sameEmailSameName}`);
  console.log(`name-groups spanning multiple distinct emails: ${sameEmailDifferentName}/${dupGroups.length}`);

  // ────── 7. Existing dedup-by-email behavior gap analysis ──────
  console.log('\n\nSTRATEGY 7: findActiveByEmail behavior — current dedup gap analysis');
  console.log('─'.repeat(80));
  // findActiveByEmail filters out completed/rejected. So same email + completed deal → NEW deal record on next submission.
  // Compute: how many of the 95 duplicates would have been caught by an "email-only, all-status" findByEmail?
  const dupDealIds = new Set();
  for (const [_k, ds] of dupGroups) for (const d of ds) dupDealIds.add(d.id);
  const dupDeals = all.filter(d => dupDealIds.has(d.id));
  const byEmailAllStatus = {};
  for (const d of dupDeals) {
    const e = d.email || '(null)';
    if (!byEmailAllStatus[e]) byEmailAllStatus[e] = [];
    byEmailAllStatus[e].push(d);
  }
  const wouldDedupByEmail = Object.values(byEmailAllStatus).filter(ds => ds.length > 1).reduce((s, ds) => s + ds.length - 1, 0);
  console.log(`if findByEmail dedup'd ALL statuses (not just active), would have caught ${wouldDedupByEmail}/${dupDeals.length} duplicates`);

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('R9-F\' EMPIRICAL COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
