// R9-F' Q5-a cleanup — purge test-fixture deals from production daily.
//
// Context: pre-R9-F', test-fixture submissions on franco@vimarealty.com
// (Franco's broker-test fixture email) and synth-test plus-addresses
// (jason+patricia-synth-...) accumulated as duplicate deal records on
// the production DB because findActiveByEmail's status filter let
// post-terminal repeats through.
//
// Action: DELETE all deals matching test-fixture patterns +
// cascade-delete their messages + documents + storage objects.
// Uses dealsService.deleteDeal for each row — same tested cascade
// pattern as Group FFFF orphan teardown.
//
// Safety: pre-count breakdown by pattern + bounds check before any
// destructive operation. Expected ~88-93 rows. Aborts if count is
// outside [50, 150] range (would indicate broader-than-test-fixture
// pattern or post-cleanup re-run).
//
// Run AFTER R9-F' code ships clean. Not part of the code commit
// itself. Safe to re-run (idempotent — second run sees zero matches
// and exits cleanly).

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const dealsService = require('../src/services/deals');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const FIXTURE_EMAIL_EQ = 'franco@vimarealty.com';
const SYNTH_PATTERN = '%+%-synth-%';

// Safety bounds around the empirical ~88-93 expected. Wider than expected
// to absorb minor variance from in-progress test cycles + the post-R9-F'
// retroactive baseline. Outside [50, 150] = abort.
const SAFETY_MIN = 50;
const SAFETY_MAX = 150;

(async () => {
  console.log('R9-F\' Q5-a CLEANUP — test-fixture deal purge');
  console.log('═'.repeat(80));

  // ────── 1. Pre-cleanup snapshot ──────
  console.log('\nSTEP 1: pre-cleanup snapshot + safety bounds verification');
  console.log('─'.repeat(80));

  const { data: fixtureEmailMatches } = await supabase
    .from('deals')
    .select('id, email, borrower_name, status, created_at')
    .eq('email', FIXTURE_EMAIL_EQ);

  const { data: synthEmailMatches } = await supabase
    .from('deals')
    .select('id, email, borrower_name, status, created_at')
    .like('email', SYNTH_PATTERN);

  const fixtureCount = fixtureEmailMatches?.length || 0;
  const synthCount = synthEmailMatches?.length || 0;
  const totalCount = fixtureCount + synthCount;

  console.log(`  franco@vimarealty.com matches: ${fixtureCount}`);
  console.log(`  ${SYNTH_PATTERN} matches:      ${synthCount}`);
  console.log(`  TOTAL test-fixture matches:    ${totalCount}`);
  console.log(`  safety bounds:                 [${SAFETY_MIN}, ${SAFETY_MAX}]`);
  console.log(`  expected (R9-F' empirical):    ~88-93`);

  if (totalCount === 0) {
    console.log('\nZero matches — cleanup already run OR test-fixture patterns gone. Exiting cleanly.');
    return;
  }
  if (totalCount < SAFETY_MIN) {
    console.error(`\nFAIL: count ${totalCount} below safety minimum ${SAFETY_MIN}. Aborting destructive delete.`);
    console.error('Possible causes: cleanup partially applied previously; test-fixture pattern data already purged; pattern criterion needs adjustment.');
    process.exit(1);
  }
  if (totalCount > SAFETY_MAX) {
    console.error(`\nFAIL: count ${totalCount} above safety maximum ${SAFETY_MAX}. Aborting destructive delete.`);
    console.error('Possible causes: pattern criterion too broad (catching legitimate production deals); new test cycle inflated counts; review patterns + re-run.');
    process.exit(1);
  }

  // ────── 2. Per-status breakdown (forensic) ──────
  console.log('\n\nSTEP 2: per-status breakdown of rows to delete');
  console.log('─'.repeat(80));
  const allMatches = [...(fixtureEmailMatches || []), ...(synthEmailMatches || [])];
  const statusDist = {};
  for (const d of allMatches) {
    statusDist[d.status] = (statusDist[d.status] || 0) + 1;
  }
  console.log(`  status distribution: ${JSON.stringify(statusDist)}`);
  console.log(`  earliest created_at: ${allMatches.map(d => d.created_at).sort()[0]}`);
  console.log(`  latest created_at:   ${allMatches.map(d => d.created_at).sort().slice(-1)[0]}`);

  // ────── 3. Iterative deleteDeal (uses tested cascade) ──────
  console.log('\n\nSTEP 3: cascade-delete via dealsService.deleteDeal (storage → documents → messages → deal row)');
  console.log('─'.repeat(80));
  let deleted = 0;
  let failed = 0;
  for (const d of allMatches) {
    try {
      await dealsService.deleteDeal(d.id);
      deleted++;
      if (deleted % 10 === 0) console.log(`  progress: ${deleted}/${allMatches.length} deleted`);
    } catch (err) {
      failed++;
      console.error(`  FAIL deal ${d.id}: ${err.message}`);
    }
  }
  console.log(`  TOTAL: ${deleted} deleted, ${failed} failed`);

  // ────── 4. Post-cleanup verification ──────
  console.log('\n\nSTEP 4: post-cleanup verification — zero test-fixture rows remain');
  console.log('─'.repeat(80));
  const { data: postFixture } = await supabase
    .from('deals')
    .select('id')
    .eq('email', FIXTURE_EMAIL_EQ);
  const { data: postSynth } = await supabase
    .from('deals')
    .select('id')
    .like('email', SYNTH_PATTERN);
  console.log(`  post-cleanup franco@vimarealty.com: ${postFixture?.length || 0} (expect 0)`);
  console.log(`  post-cleanup ${SYNTH_PATTERN}:    ${postSynth?.length || 0} (expect 0)`);
  if ((postFixture?.length || 0) !== 0 || (postSynth?.length || 0) !== 0) {
    console.error('FAIL: test-fixture rows remain post-cleanup. Investigate.');
    process.exit(1);
  }

  // ────── 5. Full daily_summaries-style audit ──────
  console.log('\n\nSTEP 5: full deals corpus audit (remaining rows)');
  console.log('─'.repeat(80));
  const { data: remaining } = await supabase
    .from('deals')
    .select('id, email, borrower_name, status, created_at')
    .order('created_at', { ascending: true });
  console.log(`  total remaining deals: ${remaining?.length || 0}`);
  if (remaining && remaining.length > 0) {
    // Show first 20 for spot-check
    for (const d of remaining.slice(0, 20)) {
      console.log(`    ${d.created_at.slice(0, 10)} | ${d.status.padEnd(13)} | "${d.borrower_name || '(none)'}" | ${d.email}`);
    }
    if (remaining.length > 20) console.log(`    ... (+${remaining.length - 20} more)`);
  }

  console.log('\nR9-F\' Q5-a CLEANUP COMPLETE');
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
