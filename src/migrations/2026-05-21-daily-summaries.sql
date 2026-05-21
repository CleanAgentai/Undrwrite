-- R5 Cluster F Bug 2 + Bug 3 (2026-05-21): persist daily-summary firings to
-- a queryable record. Solves two needs in one storage primitive:
--
-- 1. F-2 IDEMPOTENCY — UNIQUE constraint on date_edmonton is the atomic
--    second-fire prevention. ON CONFLICT (date_edmonton) DO NOTHING means
--    multiple workers / restart-tick races collide at the DB layer; only
--    one INSERT succeeds, all others silent-skip. Covers both Vector A
--    (multi-worker race at 21:00) and Vector B (Render restart between
--    21:00:00-21:00:59 re-firing the in-window minute).
--
-- 2. FORENSIC AUDIT TRAIL — daily-summary outbounds were previously sent
--    via emailService.sendEmail without any persistence (cron/dailySummary.js
--    L347-352 pre-fix). Past 30 days had ZERO records — could not detect
--    F-2-style duplicate fires from DB query. Going forward this table
--    holds a per-day snapshot enabling future audits.
--
-- date_edmonton format: 'YYYY-MM-DD' computed in America/Edmonton TZ via
-- Intl.DateTimeFormat. Single source of truth — formatAdminDate's TZ +
-- shouldFireDailySummaryNow's TZ + this column all use ADMIN_TIMEZONE
-- from dailySummary.js (no drift risk).
--
-- status enum: 'pending' (INSERT succeeded, send in flight), 'sent'
-- (post-send UPDATE applied), 'failed' (send failed, error_message populated).
-- A crashed worker between INSERT and finalize leaves status='pending'
-- forever for that date — visible as a flag in audit queries.
--
-- Snapshot fields (active_deals_count, reminders_sent, html_length) record
-- the size of the summary content WITHOUT storing the full HTML body
-- (audit bloat). Enough to diff "today vs yesterday" trends without bloat.
--
-- Idempotent via CREATE TABLE IF NOT EXISTS + ALTER ... ADD COLUMN IF NOT
-- EXISTS for any future schema additions. Safe to re-apply.

CREATE TABLE IF NOT EXISTS daily_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date_edmonton TEXT NOT NULL UNIQUE,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',
  message_id TEXT,
  html_length INT,
  active_deals_count INT,
  reminders_sent INT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS daily_summaries_date_edmonton_idx ON daily_summaries(date_edmonton);
