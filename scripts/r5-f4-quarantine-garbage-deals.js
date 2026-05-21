#!/usr/bin/env node
// R5 Cluster F Bug 4 (2026-05-21) — quarantine garbage deals.
//
// Purpose: forensically resolve the 15 known garbage deals created by
// non-broker inbounds that slipped through the pre-F4 denylist (Postmark
// marketing, internal team, VIMA admin staff, Christine). Sets
// status='rejected' + admin_controlled=true on the 13-deal target set
// (12 denylist + 1 Christine — corrected from plan-time 14 after empirical
// reconciliation against production); the 2 synth fixtures
// (jason+patricia-synth-*) are preserved untouched. 12 + 1 + 2 = 15 baseline.
//
// Option B cleanup per F-4 verdict:
//   - status='rejected' removes deals from active queries (daily summary,
//     reminder cron, broker-facing dispatch — see deals.js .not status-in
//     ("completed","rejected") filter sites).
//   - admin_controlled=true means if any deal in this set receives a future
//     inbound (broker or otherwise), the webhook NOTIFY-ADMIN-ONLY gate
//     routes it to Franco for manual handoff — defensive belt-and-suspenders
//     on top of the rejected-status filter.
//   - Forensic audit trail preserved (rows not deleted). Mild semantic
//     mismatch on 'rejected' for Postmark marketing — accepted cost for
//     using existing-vocabulary statuses instead of a schema change.
//
// CRITICAL CARVE-OUTS:
//   1. franco@vimarealty.com is NEVER quarantined (testing proxy, 93/108
//      production deals). Domain-wide @vimarealty.com would catch him —
//      hence explicit per-address denylist.
//   2. Synth fixtures matching /jason\+patricia.*synth/ are PRESERVED. They
//      are intentional test data, not garbage.
//
// Idempotent: dynamically queries deals matching the denylist + Christine,
// skips any already in target state. Safe to re-run. First run quarantines
// 13 deals; subsequent runs report 0 changes (since webhook filter now
// blocks the upstream source).
//
// Run: PGPW='<password>' node scripts/r5-f4-quarantine-garbage-deals.js
//      [--dry-run]  — enumerate matches WITHOUT writing
//      [--apply]    — perform the UPDATEs
//
// Connection topology (from feedback_migrations.md): aws-1-us-east-2 pooler
// on port 6543, SSL required, username postgres.{project-ref}.

const { Client } = require('pg');

const PROJECT_REF = 'keyrwvofpvbmymkldbvz';
const HOST = 'aws-1-us-east-2.pooler.supabase.com';
const PORT = 6543;

const DRY_RUN = !process.argv.includes('--apply');

// Denylist patterns (substring-match on email.from, case-insensitive).
// Mirrors src/routes/webhook.js R5-F4 expansion.
const DENYLIST_SUBSTRINGS = [
  '@fyi.postmarkapp.com',
  '@fsagent.com',
  'gabriela@vimarealty.com',
  'brandon@vimarealty.com',
  'admin@vimarealty.com',
];

// Explicit add per F-4 verdict Decision 2 — Christine is ambiguous; quarantine
// is the defensive-but-reversible default. If she IS a real broker, her next
// inbound routes to NOTIFY-ADMIN-ONLY for Franco's manual review.
const EXPLICIT_QUARANTINE_EMAILS = [
  'christinemann24@gmail.com',
];

// Synth-fixture preservation pattern. These are intentional test data.
const SYNTH_FIXTURE_PATTERN = /jason\+patricia.*synth/i;

const matchesDenylist = (email) => {
  if (!email) return false;
  const lower = email.toLowerCase();
  if (SYNTH_FIXTURE_PATTERN.test(lower)) return false;
  if (DENYLIST_SUBSTRINGS.some((sub) => lower.includes(sub.toLowerCase()))) return true;
  if (EXPLICIT_QUARANTINE_EMAILS.some((addr) => lower === addr.toLowerCase())) return true;
  return false;
};

const main = async () => {
  if (!process.env.PGPW) {
    console.error('ERROR: PGPW env var required (Supabase postgres password).');
    process.exit(1);
  }

  const client = new Client({
    host: HOST,
    port: PORT,
    database: 'postgres',
    user: `postgres.${PROJECT_REF}`,
    password: process.env.PGPW,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log(`Connected to ${HOST}:${PORT} (${PROJECT_REF}). Mode: ${DRY_RUN ? 'DRY-RUN' : 'APPLY'}.\n`);

  const { rows } = await client.query(
    `SELECT id, email, borrower_name, status, admin_controlled, created_at
     FROM deals
     ORDER BY created_at ASC`
  );

  const matches = [];
  const synthPreserved = [];
  for (const r of rows) {
    if (SYNTH_FIXTURE_PATTERN.test((r.email || '').toLowerCase())) {
      synthPreserved.push(r);
      continue;
    }
    if (matchesDenylist(r.email)) {
      matches.push(r);
    }
  }

  console.log(`Total deals scanned: ${rows.length}`);
  console.log(`Synth fixtures preserved: ${synthPreserved.length}`);
  synthPreserved.forEach((r) => {
    console.log(`  PRESERVE  ${r.id}  ${r.email}  status=${r.status}  admin_controlled=${r.admin_controlled}`);
  });
  console.log(`Denylist + explicit matches: ${matches.length}\n`);

  let toUpdate = 0;
  let alreadyQuarantined = 0;
  for (const r of matches) {
    const isQuarantined = r.status === 'rejected' && r.admin_controlled === true;
    if (isQuarantined) {
      alreadyQuarantined++;
      console.log(`  SKIP      ${r.id}  ${r.email}  (already status=rejected + admin_controlled=true)`);
    } else {
      toUpdate++;
      console.log(`  ${DRY_RUN ? 'WOULD-UPDATE' : 'UPDATING   '}  ${r.id}  ${r.email}  status=${r.status}→rejected  admin_controlled=${r.admin_controlled}→true`);
    }
  }
  console.log(`\nSummary: ${toUpdate} to update, ${alreadyQuarantined} already quarantined.\n`);

  if (DRY_RUN) {
    console.log('DRY-RUN — no writes performed. Re-run with --apply to execute.');
    await client.end();
    return;
  }

  if (toUpdate === 0) {
    console.log('Nothing to update.');
    await client.end();
    return;
  }

  const idsToUpdate = matches
    .filter((r) => !(r.status === 'rejected' && r.admin_controlled === true))
    .map((r) => r.id);

  const result = await client.query(
    `UPDATE deals
     SET status = 'rejected', admin_controlled = TRUE
     WHERE id = ANY($1::uuid[])
     RETURNING id, email, status, admin_controlled`,
    [idsToUpdate]
  );

  console.log(`UPDATED ${result.rowCount} rows:`);
  result.rows.forEach((r) => {
    console.log(`  ${r.id}  ${r.email}  status=${r.status}  admin_controlled=${r.admin_controlled}`);
  });

  await client.end();
};

if (require.main === module) {
  main().catch((err) => {
    console.error('FATAL:', err.message);
    process.exit(1);
  });
}

module.exports = {
  matchesDenylist,
  DENYLIST_SUBSTRINGS,
  EXPLICIT_QUARANTINE_EMAILS,
  SYNTH_FIXTURE_PATTERN,
};
