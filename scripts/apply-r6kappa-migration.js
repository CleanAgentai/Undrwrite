// Apply R6-κ migration: ADD COLUMN aml_pep_requested_at TIMESTAMPTZ on deals.
// Usage:
//   SUPABASE_DB_URL='postgresql://...' node scripts/apply-r6kappa-migration.js
// Credentials passed inline via env. Idempotent (CREATE COLUMN IF NOT EXISTS).
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATION_PATH = path.join(__dirname, '..', 'src', 'migrations', '2026-05-21-aml-pep-requested-at.sql');

(async () => {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    console.error('SUPABASE_DB_URL env var required'); process.exit(1);
  }
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  console.log(`Applying ${MIGRATION_PATH}\n${'='.repeat(60)}`);
  // Print just the DDL statement(s), not the comment block.
  const ddl = sql.split('\n').filter(l => l.trim() && !l.trim().startsWith('--')).join('\n');
  console.log(ddl);
  console.log('='.repeat(60));

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(sql);
    console.log('\n✓ migration applied');

    // Verify column exists.
    const { rows } = await client.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = 'deals' AND column_name = 'aml_pep_requested_at'`
    );
    if (rows.length === 0) {
      console.error('✗ post-migration verification FAILED: aml_pep_requested_at column not found on deals');
      process.exit(2);
    }
    console.log(`\nverification: column present\n  ${JSON.stringify(rows[0])}`);
  } finally {
    await client.end();
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
