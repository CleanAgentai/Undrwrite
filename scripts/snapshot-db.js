#!/usr/bin/env node
// Read-only full export of Vienna's Supabase tables to backups/ (gitignored).
// Same shape as backups/vienna-snapshot-2026-05-19*.json: { exported_at, counts, <table>: rows }.
// Used as the pre-change baseline and the restore point before each deploy.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const TABLES = { deals: 'created_at', messages: 'created_at', documents: 'created_at', daily_summaries: 'date_edmonton' };
const PAGE = 1000;

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const fetchAll = async (table) => {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await s.from(table).select('*').order(TABLES[table], { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
};

(async () => {
  const out = { exported_at: new Date().toISOString(), counts: {} };
  for (const t of Object.keys(TABLES)) {
    out[t] = await fetchAll(t);
    out.counts[t] = out[t].length;
  }
  const dir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `vienna-snapshot-${out.exported_at.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(out));
  console.log(file);
  console.log(JSON.stringify(out.counts));
})().catch((e) => { console.error(e.message); process.exit(1); });
