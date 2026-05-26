// R9-E mini-harness — runs the 6 R9-E verification groups in isolation.
// Mirrors the structure of the R9-E block appended to test-trigger.js but
// runs without Claude API dependencies. Used during R9-E cycle execution
// because test-trigger.js's live-Claude tests (Fix 6, Fix 7) are blocked
// by an Anthropic billing-balance issue at the time of this cycle. The
// canonical R9-E groups remain in test-trigger.js for the full harness
// once Claude credits are restored.

require('dotenv').config();

// Set test-environment defaults so service singletons construct cleanly
// (mirrors test-trigger.js lines 11-16). The harness only exercises
// pure-source-pins and stubbed empirical replays — no live API calls.
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'sk-test-dummy';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';
process.env.POSTMARK_API_TOKEN = process.env.POSTMARK_API_TOKEN || 'dummy';
process.env.POSTMARK_SENDER_EMAIL = process.env.POSTMARK_SENDER_EMAIL || 'vienna@example.com';
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'franco@privatemortgagelink.com';

const dealsService = require('../src/services/deals');

(async () => {
  console.log('========== R9-E mini-harness — startCron() factory extraction ==========');

  const fs = require('fs');
  const path = require('path');
  const _r9eCronSrc = fs.readFileSync(path.join(__dirname, '../src/cron/dailySummary.js'), 'utf8');
  const _r9eIndexSrc = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');

  // ─── R9-E-FACTORY-EXTRACTION ───
  console.log('\n--- R9-E-FACTORY-EXTRACTION ---');
  if (!/(const startCron = \(\) =>|function startCron\s*\()/.test(_r9eCronSrc)) {
    throw new Error('FAIL [R9-E-FACTORY-EXTRACTION (a)]: startCron definition missing');
  }
  console.log('  PASS (a): startCron function definition present');

  const _r9eStartCronIdx = _r9eCronSrc.search(/(const startCron = \(\) =>|function startCron\s*\()/);
  const _r9eCronScheduleIdx = _r9eCronSrc.indexOf('cron.schedule(CRON_SCHEDULE, runDailySummary');
  if (_r9eStartCronIdx === -1 || _r9eCronScheduleIdx === -1) {
    throw new Error(`FAIL [R9-E-FACTORY-EXTRACTION (b)]: startCron/cron.schedule positions invalid`);
  }
  if (_r9eCronScheduleIdx <= _r9eStartCronIdx) {
    throw new Error(`FAIL [R9-E-FACTORY-EXTRACTION (b)]: cron.schedule must appear AFTER startCron definition`);
  }
  console.log('  PASS (b): cron.schedule inside startCron body');

  const _r9eAllScheduleCalls = (_r9eCronSrc.match(/cron\.schedule\(/g) || []).length;
  if (_r9eAllScheduleCalls !== 1) {
    throw new Error(`FAIL [R9-E-FACTORY-EXTRACTION (c)]: expected 1 cron.schedule call, got ${_r9eAllScheduleCalls}`);
  }
  console.log('  PASS (c): exactly 1 cron.schedule call site (inside startCron)');

  if (!/module\.exports = \{[\s\S]*?\bstartCron\b[\s\S]*?\};?/m.test(_r9eCronSrc)) {
    throw new Error('FAIL [R9-E-FACTORY-EXTRACTION (d)]: startCron not exported');
  }
  console.log('  PASS (d): startCron exported');

  if (!/let _r9eCronHandle = null;?/.test(_r9eCronSrc)) {
    throw new Error('FAIL [R9-E-FACTORY-EXTRACTION (e)]: _r9eCronHandle declaration missing');
  }
  if (!/if \(_r9eCronHandle\)[\s\S]{0,200}return _r9eCronHandle/.test(_r9eCronSrc)) {
    throw new Error('FAIL [R9-E-FACTORY-EXTRACTION (e)]: idempotent guard missing');
  }
  console.log('  PASS (e): idempotent guard with module-level handle + early-return');

  // ─── R9-E-PRODUCTION-WIRING ───
  console.log('\n--- R9-E-PRODUCTION-WIRING ---');

  if (!/require\(['"]\.\/cron\/dailySummary['"]\)/.test(_r9eIndexSrc)) {
    throw new Error('FAIL [R9-E-PRODUCTION-WIRING (a)]: src/index.js must require ./cron/dailySummary');
  }
  if (!/\bstartCron\b/.test(_r9eIndexSrc)) {
    throw new Error('FAIL [R9-E-PRODUCTION-WIRING (a)]: src/index.js must reference startCron');
  }
  console.log('  PASS (a): src/index.js requires ./cron/dailySummary with startCron reference');

  const _r9eListenIdx = _r9eIndexSrc.search(/app\.listen\(/);
  if (_r9eListenIdx === -1) throw new Error('FAIL [R9-E-PRODUCTION-WIRING (b)]: app.listen not found');
  const _r9eAfterListen = _r9eIndexSrc.slice(_r9eListenIdx);
  if (!/startDailySummaryCron\(\)|startCron\(\)/.test(_r9eAfterListen)) {
    throw new Error('FAIL [R9-E-PRODUCTION-WIRING (b)]: startCron must be invoked inside app.listen callback');
  }
  console.log('  PASS (b): startCron invoked inside app.listen callback');

  if (/^\s*require\(['"]\.\/cron\/dailySummary['"]\)\s*;?\s*$/m.test(_r9eIndexSrc)) {
    throw new Error('FAIL [R9-E-PRODUCTION-WIRING (c)]: bare side-effect require remains');
  }
  console.log('  PASS (c): bare side-effect require form is GONE');

  // ─── R9-E-TEST-IMPORT-SIDE-EFFECT-ABSENCE (LOAD-BEARING) ───
  console.log('\n--- R9-E-TEST-IMPORT-SIDE-EFFECT-ABSENCE (LOAD-BEARING) ---');
  {
    const _r9eNodeCron = require('node-cron');
    const _r9eOrigSchedule = _r9eNodeCron.schedule;
    let _r9eScheduleCallCount = 0;
    _r9eNodeCron.schedule = function () {
      _r9eScheduleCallCount++;
      return { _r9eStub: true, stop: () => {} };
    };

    try {
      delete require.cache[require.resolve('../src/cron/dailySummary')];

      const _r9eFreshDs = require('../src/cron/dailySummary');
      if (_r9eScheduleCallCount !== 0) {
        throw new Error(`FAIL (i): require triggered cron.schedule — count=${_r9eScheduleCallCount}`);
      }
      console.log('  PASS (i): require ./src/cron/dailySummary did NOT register cron schedule (count=0)');

      if (typeof _r9eFreshDs.startCron !== 'function') {
        throw new Error(`FAIL (ii): startCron not exported, typeof=${typeof _r9eFreshDs.startCron}`);
      }
      console.log('  PASS (ii): startCron exported and callable');

      const _r9eHandle1 = _r9eFreshDs.startCron();
      if (_r9eScheduleCallCount !== 1) {
        throw new Error(`FAIL (iii): first startCron() count=${_r9eScheduleCallCount}`);
      }
      console.log('  PASS (iii): first startCron() registered cron schedule (count=1)');

      if (!_r9eHandle1 || _r9eHandle1._r9eStub !== true) {
        throw new Error('FAIL (iv): startCron() must return handle');
      }
      console.log('  PASS (iv): startCron() returned the cron handle');

      const _r9eHandle2 = _r9eFreshDs.startCron();
      if (_r9eScheduleCallCount !== 1) {
        throw new Error(`FAIL (v): second startCron() count=${_r9eScheduleCallCount}`);
      }
      console.log('  PASS (v): second startCron() was idempotent (count remained 1)');

      if (_r9eHandle2 !== _r9eHandle1) {
        throw new Error('FAIL (vi): second startCron() returned different handle');
      }
      console.log('  PASS (vi): second startCron() returned same handle');
    } finally {
      _r9eNodeCron.schedule = _r9eOrigSchedule;
      delete require.cache[require.resolve('../src/cron/dailySummary')];
    }
  }

  // ─── R9-E-REGRESSION-MOCK-POLLUTION-PREVENTION (LOAD-BEARING) ───
  console.log('\n--- R9-E-REGRESSION-MOCK-POLLUTION-PREVENTION (LOAD-BEARING) ---');
  {
    let _r9eClaimSpyCalls = 0;
    const _r9eOrigClaim = dealsService.claimDailySummarySlot;
    dealsService.claimDailySummarySlot = async (dateEdmonton) => {
      _r9eClaimSpyCalls++;
      return { claimed: true, id: `r9e-spy-${dateEdmonton}` };
    };

    const _r9eNodeCron2 = require('node-cron');
    const _r9eOrigSchedule2 = _r9eNodeCron2.schedule;
    let _r9eScheduleCallsReg = 0;
    _r9eNodeCron2.schedule = function () {
      _r9eScheduleCallsReg++;
      return { stop: () => {} };
    };

    try {
      delete require.cache[require.resolve('../src/cron/dailySummary')];
      require('../src/cron/dailySummary');

      if (_r9eScheduleCallsReg !== 0) {
        throw new Error(`FAIL (i): require triggered cron.schedule — count=${_r9eScheduleCallsReg}`);
      }
      console.log('  PASS (i): require alone does NOT register cron schedule (mock pollution surface closed)');

      if (_r9eClaimSpyCalls !== 0) {
        throw new Error(`FAIL (ii): claimDailySummarySlot called, count=${_r9eClaimSpyCalls}`);
      }
      console.log('  PASS (ii): claimDailySummarySlot NOT called post-require');

      console.log('  PASS [structural closure]: fix proves the bug surface is structurally closed');
    } finally {
      dealsService.claimDailySummarySlot = _r9eOrigClaim;
      _r9eNodeCron2.schedule = _r9eOrigSchedule2;
      delete require.cache[require.resolve('../src/cron/dailySummary')];
    }
  }

  // ─── R9-E-CROSS-CLUSTER-INTEGRATION ───
  console.log('\n--- R9-E-CROSS-CLUSTER-INTEGRATION ---');

  if (!/dealsService\.claimDailySummarySlot\(dateKey\)/.test(_r9eCronSrc)) {
    throw new Error('FAIL (a): R5-F-2 claimDailySummarySlot not wired in runDailySummary');
  }
  console.log('  PASS (a): R5-F-2 claimDailySummarySlot wired in runDailySummary');

  if (!/computeDealClassification = \(deal, lastInboundAt\)/.test(_r9eCronSrc)) {
    throw new Error('FAIL (b): R5-F-3 computeDealClassification missing');
  }
  console.log('  PASS (b): R5-F-3 computeDealClassification preserved');

  if (!/const shouldFireDailySummaryNow = \(now, timezone\) =>/.test(_r9eCronSrc)) {
    throw new Error('FAIL (c): shouldFireDailySummaryNow missing');
  }
  if (!/return hour === 21 && minute === 0/.test(_r9eCronSrc)) {
    throw new Error('FAIL (c): IIII gate predicate missing');
  }
  console.log('  PASS (c): IIII shouldFireDailySummaryNow gate preserved');

  const _r9eAdminTzDefs = (_r9eCronSrc.match(/const ADMIN_TIMEZONE = 'America\/Edmonton'/g) || []).length;
  if (_r9eAdminTzDefs !== 1) {
    throw new Error(`FAIL (d): ADMIN_TIMEZONE definitions=${_r9eAdminTzDefs}`);
  }
  console.log('  PASS (d): ADMIN_TIMEZONE single-source preserved');

  if (!/CRON_SCHEDULE\s*=\s*REMINDER_TESTING_MODE \? '\*\/30 \* \* \* \*' : '0 21 \* \* \*'/.test(_r9eCronSrc)) {
    throw new Error('FAIL (e): CRON_SCHEDULE pattern changed');
  }
  console.log('  PASS (e): CRON_SCHEDULE production + testing patterns unchanged');

  if (!/cron\.schedule\(CRON_SCHEDULE, runDailySummary, \{\s*timezone: ADMIN_TIMEZONE,?\s*\}\)/.test(_r9eCronSrc)) {
    throw new Error('FAIL (f): cron.schedule timezone option missing');
  }
  console.log('  PASS (f): cron.schedule timezone option preserved');

  if (!/const runFollowUpReminders = async \(\) =>/.test(_r9eCronSrc)) {
    throw new Error('FAIL (g): runFollowUpReminders signature changed');
  }
  console.log('  PASS (g): runFollowUpReminders signature unchanged');

  for (const _exp of ['runDailySummary', 'runFollowUpReminders', 'formatAdminDate', 'ADMIN_TIMEZONE', 'shouldFireDailySummaryNow', 'edmontonDateKey', 'computeDealClassification']) {
    const _re = new RegExp(`module\\.exports = \\{[\\s\\S]*?\\b${_exp}\\b[\\s\\S]*?\\};?`, 'm');
    if (!_re.test(_r9eCronSrc)) {
      throw new Error(`FAIL (h): ${_exp} no longer exported`);
    }
  }
  console.log('  PASS (h): all pre-R9-E exports preserved + startCron added');

  // ─── R9-E-COMMENT-FIX ───
  console.log('\n--- R9-E-COMMENT-FIX ---');

  if (!/(deploy required|redeploy required)/i.test(_r9eCronSrc)) {
    throw new Error('FAIL (a): "deploy required" / "redeploy required" missing');
  }
  console.log('  PASS (a): "deploy required" / "redeploy required" string present');

  if (/No deploy needed/i.test(_r9eCronSrc)) {
    throw new Error('FAIL (b): "No deploy needed" string still present');
  }
  console.log('  PASS (b): "No deploy needed" string is GONE');

  console.log('\n========== R9-E mini-harness: ALL GROUPS PASS ==========');
})().catch(e => {
  console.error('\nR9-E HARNESS FAILED:', e.stack || e.message);
  process.exit(1);
});
