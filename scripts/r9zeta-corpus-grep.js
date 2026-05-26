// R9-F empirical-grounding — Deal record integrity (PERSISTENT from R4).
//
// Three sub-bugs per Franco S13:
//   (1) Borrower deduplication — name-form variations create separate records
//       instead of consolidating (Patricia Simmons / Patricia Anne Simmons;
//       Marcus Webb / Marcus James Webb; Lena Park / Lena Ji-Young Park;
//       Noah MacKenzie / Noah Alexander MacKenzie).
//   (2) Stale Deals duplicates — hundreds of rows for handful of actual
//       borrowers; each test round creates new records.
//   (3) Non-deal entries — Franco Maione (lender/admin), Sarah Mitchell +
//       David Chen (broker personas), "Westgate Aggravation owners", "King
//       of Dates Corp" (company), Ryan Kowalski + Tom Haskell + Patricia
//       Wen + Linda Okafor (non-test-borrower names).
//
// Empirical tasks:
//   (a) deals table schema — primary key, borrower identity fields, intake-
//       trigger conditions
//   (b) full deal corpus dedup inventory — group by name-form variations
//   (c) non-deal entry classification — surface lender/broker/company/junk
//   (d) intake gate code-path — which inbound emails create deal records;
//       any identity/role check
//   (e) name normalization — any existing borrower-identity matching across
//       name-form variations
//   (f) sender_type field — broker vs borrower vs admin classification

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

(async () => {
  console.log('R9-F EMPIRICAL GROUNDING — Deal record integrity (PERSISTENT R4)');
  console.log('═'.repeat(80));

  // 1. Schema discovery.
  console.log('\nSTRATEGY 1: deals table schema');
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

  // 2. Full deal corpus + dedup inventory.
  console.log('\n\nSTRATEGY 2: full deals corpus — borrower_name + sender info');
  console.log('─'.repeat(80));
  const { data: all, error: allErr } = await supabase
    .from('deals')
    .select('id, borrower_name, status, created_at, email, extracted_data')
    .order('created_at', { ascending: true });
  if (allErr) { console.error('ERR:', allErr.message); return; }
  console.log(`total deals: ${all.length}`);
  // Count by status
  const statusCount = {};
  for (const d of all) statusCount[d.status] = (statusCount[d.status] || 0) + 1;
  console.log(`status distribution: ${JSON.stringify(statusCount)}`);

  // 3. Dedup inventory — group by normalized borrower name.
  console.log('\n\nSTRATEGY 3: dedup inventory — group by NORMALIZED borrower name');
  console.log('─'.repeat(80));
  // Normalization heuristic: lowercase + collapse whitespace + take first-token + last-token (skip middle names).
  const normalizeName = (name) => {
    if (!name) return null;
    const tokens = name.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;
    if (tokens.length === 1) return tokens[0];
    // First + last tokens (drops middle names — Patricia Simmons vs Patricia Anne Simmons collapse)
    return `${tokens[0]} ${tokens[tokens.length - 1]}`;
  };
  const groups = {};
  for (const d of all) {
    const key = normalizeName(d.borrower_name) || '(null)';
    if (!groups[key]) groups[key] = [];
    groups[key].push(d);
  }
  const dupGroups = Object.entries(groups).filter(([_, ds]) => ds.length > 1);
  console.log(`\nNORMALIZED borrower-name groups with >1 deal: ${dupGroups.length}`);
  console.log(`Total deals in such groups: ${dupGroups.reduce((s, [, ds]) => s + ds.length, 0)}`);
  // Sort by count desc, take top 15
  dupGroups.sort((a, b) => b[1].length - a[1].length);
  for (const [key, ds] of dupGroups.slice(0, 20)) {
    const variants = [...new Set(ds.map(d => d.borrower_name))];
    console.log(`\n  "${key}" — ${ds.length} deals across ${variants.length} name-form(s):`);
    for (const v of variants) console.log(`    name-form: "${v}"`);
    for (const d of ds.slice(0, 3)) {
      console.log(`    ${d.id} | ${d.created_at.slice(0, 10)} | status=${d.status} | broker=${d.extracted_data?.broker_name || '(none)'}`);
    }
    if (ds.length > 3) console.log(`    ... (+${ds.length - 3} more)`);
  }

  // 4. Non-deal entry classification.
  console.log('\n\nSTRATEGY 4: non-deal entry classification');
  console.log('─'.repeat(80));
  const nonDealCandidates = [];
  for (const d of all) {
    const name = d.borrower_name || '';
    const senderName = d.extracted_data?.sender_name || '';
    const brokerName = d.extracted_data?.broker_name || '';
    const flags = [];
    // (a) Franco / admin-like names
    if (/franco|maione|vienna|underwrit/i.test(name)) flags.push('admin-or-lender-name');
    // (b) Broker-persona-like names (common broker fixtures used as borrowers)
    if (/sarah mitchell|david chen|jason mercer|mohammed al-farsi|cecilia fontaine|natalie bergman|nadia petrov|eric johansson|oliver patel|preethi subramaniam|fatima al-rashid|ryan o'?brien|amanda foster|james thornton|vanessa chow|trevor hollingsworth|mohammed/i.test(name)) flags.push('broker-persona-name');
    // (c) Company-like names
    if (/corp|inc\.?|ltd\.?|llc|owners|company|partners|group|properties|holdings/i.test(name)) flags.push('company-or-org-name');
    // (d) Junk / mock-test names (heuristic: garbled words like "Aggravation", "King of Dates")
    if (/aggravation|king of dates|undertaking|test deal|sample/i.test(name)) flags.push('junk-mock-test-name');
    // (e) Sender role: if sender_type=admin or sender_name=Franco
    if (/franco|maione/i.test(senderName) && !brokerName) flags.push('admin-direct-no-broker');
    if (flags.length > 0) {
      nonDealCandidates.push({ id: d.id, name, senderName, brokerName, status: d.status, created_at: d.created_at, flags });
    }
  }
  console.log(`non-deal candidates: ${nonDealCandidates.length}`);
  for (const c of nonDealCandidates.slice(0, 30)) {
    console.log(`  ${c.id} | "${c.name}" | sender="${c.senderName}" | broker="${c.brokerName}" | status=${c.status} | flags: ${c.flags.join('+')}`);
  }
  if (nonDealCandidates.length > 30) console.log(`  ... (+${nonDealCandidates.length - 30} more)`);

  // 5. Intake gate code-path discovery.
  console.log('\n\nSTRATEGY 5: intake gate code-path');
  console.log('─'.repeat(80));
  const { execSync } = require('child_process');
  const grep = (pattern, file, n) => {
    try {
      return execSync(`grep -nE "${pattern}" ${file} 2>/dev/null | head -${n || 30} || true`).toString().trim();
    } catch (e) { return ''; }
  };
  console.log('\nwebhook.js — deal creation + intake conditions:');
  console.log(grep("dealsService\\.create|deals\\.insert|createDeal|isAdmin |isBroker", 'src/routes/webhook.js', 30));
  console.log('\ndeals service — create/insert/upsert logic:');
  console.log(grep("create|insert|upsert|borrower_name|identity", 'src/services/deals.js', 30));
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
