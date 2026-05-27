// DO NOT USE FOR SAMPLE STORAGE — Phase 3 production-corpus sample-pull program
// was DEFERRED 2026-05-27 per PII risk (regex-based scrubbing on free-text
// broker emails is structurally insufficient; names/companies/addresses are
// open-set). See production-samples/shape-log.md for the empirical escalation
// anchor + Phase 3 disposition Option B rationale.
//
// This helper REMAINS in tree for live-query operational debugging use only
// (e.g., one-off in-memory schema/data probing during cluster work, equivalent
// to scripts/r10a-corpus-grep.js patterns). Do NOT use it to write production
// data — even scrubbed — to test-fixtures/ or any other persisted location.
//
// Closure condition: if Phase 5 triage surfaces synthetic-bias material gap,
// production-sample storage requires lib/piiScrubber.js M1-M5 extensions
// (documented in Phase 3 escalation report) BEFORE this helper can support
// any storage path.
//
// Original purpose (preserved for operational-debugging use):
// Wraps @supabase/supabase-js with query patterns used by prior corpus-grep
// scripts (r10a/r10b/...) + paginated rate-aware fetch + column allowlist
// projection (never SELECT *).
//
// Discipline:
//   - Always project specific columns; never SELECT *
//   - Default page size 25; max 100
//   - Pause between pages (100ms default) to avoid hammering Supabase
//   - Caller passes column allowlist explicitly

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

let _client = null;
const client = () => {
  if (!_client) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY in env');
    }
    _client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  }
  return _client;
};

// Paginated fetch with explicit column projection.
//   table: 'deals' | 'messages' | ...
//   columns: string list of explicitly-allowed columns
//   filter: { eq?: [col, value], ilike?: [col, pattern], gte?: [col, value], in?: [col, values] }
//   pageSize: default 25, max 100
//   maxRows: stop after this many rows total (default 100)
//   delayMs: pause between pages (default 100)
const pullPaginated = async ({ table, columns, filter = {}, pageSize = 25, maxRows = 100, delayMs = 100 }) => {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('pullPaginated: columns must be a non-empty allowlist (never SELECT *)');
  }
  if (pageSize > 100) pageSize = 100;
  const out = [];
  let offset = 0;
  while (out.length < maxRows) {
    let q = client().from(table).select(columns.join(','));
    if (filter.eq) q = q.eq(filter.eq[0], filter.eq[1]);
    if (filter.ilike) q = q.ilike(filter.ilike[0], filter.ilike[1]);
    if (filter.gte) q = q.gte(filter.gte[0], filter.gte[1]);
    if (filter.in) q = q.in(filter.in[0], filter.in[1]);
    q = q.range(offset, offset + pageSize - 1);
    const { data, error } = await q;
    if (error) throw new Error(`pullPaginated ${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  }
  return out.slice(0, maxRows);
};

// Sample N recent deal IDs (shape-reference only — no body/PII columns).
// Caller fetches messages separately if needed.
const sampleRecentDealIds = async ({ limit = 10 } = {}) => {
  const deals = await pullPaginated({
    table: 'deals',
    columns: ['id', 'created_at', 'status', 'ownership_type', 'admin_controlled'],
    pageSize: Math.min(limit, 100),
    maxRows: limit,
  });
  return deals;
};

// Fetch broker-inbound message bodies for shape reference (text only, scrubbed
// by caller before any storage). Returns: [{ id, deal_id, direction, subject, body, created_at }]
const fetchMessagesForDeal = async (dealId, { directionFilter = 'inbound' } = {}) => {
  return pullPaginated({
    table: 'messages',
    columns: ['id', 'deal_id', 'direction', 'subject', 'body', 'created_at'],
    filter: { eq: ['deal_id', dealId] },
    pageSize: 100,
    maxRows: 100,
  }).then(rows => rows.filter(r => !directionFilter || r.direction === directionFilter));
};

module.exports = {
  client,
  pullPaginated,
  sampleRecentDealIds,
  fetchMessagesForDeal,
};
