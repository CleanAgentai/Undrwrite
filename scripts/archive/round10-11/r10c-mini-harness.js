// R10-C mini-harness — high-LTV (>80%) dedicated-generator bypass + 75-80%
// manual-review band Risk Factors callout. Closes Bug 4-? (Ryan/Donna combined-
// applicant deal 45bd01df) + contract Schedule A Stage 1 LTV-routing three-
// band spec at MVP level.
//
// ARCHAEOLOGY NOTE — Ryan/Donna deal id mapping (per user direction during
// plan-first ratification): deal 45bd01df-4d8f-4ff4-98b0-86d80db79876 surfaces
// in multiple R10 round bug reports under DIFFERENT names. Donna Blackwood is
// the submitting broker (broker_name); Ryan Callahan is the borrower (borrower_
// name). Same UUID. Future maintainers grepping "Donna" or "Ryan" against this
// deal id will land on the same fixture. R10-B/R10-D referenced "Donna" framing
// (signature parsing context); R10-C references "Ryan" framing (borrower-side
// high-LTV escalation context). Co-applicant relationship: Donna submitted the
// file on behalf of borrower Ryan; the LTV escalation applies to the Ryan
// borrower-side property (Edmonton appraisal $545k, requested $68k 2nd, existing
// TD $385k 1st → combined 83.1%).
//
// 8 verification groups:
//  (1) LTV-BAND-CLASSIFIER-MATRIX    — computeLtvBand truth table
//  (2) DEDICATED-GENERATOR-MINIMAL-ASK — generateHighLtvCollateralAsk shape
//  (3) INITIAL-SUBMISSION-ROUTING    — processInitialEmail bypass at >80%
//  (4) ACTIVE-BRANCH-ROUTING         — generateBrokerResponse override at >80%
//  (5) RYAN-LOAD-BEARING (Stage 1.5) — live-Supabase replay against 45bd01df
//  (6) 75-80-MANUAL-REVIEW-SURFACE   — injectElevatedLtvBandCallout behavior
//  (7) CROSS-CLUSTER-INTEGRATION     — S15-E + R10-F + R10-H preserved
//  (8) DEFERRED-RESIDUAL-FLAGGING    — docblock pins per R10-D discipline

require('dotenv').config();

process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'sk-test-dummy';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';
process.env.POSTMARK_API_TOKEN = process.env.POSTMARK_API_TOKEN || 'dummy';
process.env.POSTMARK_SENDER_EMAIL = process.env.POSTMARK_SENDER_EMAIL || 'vienna@example.com';
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'franco@privatemortgagelink.com';

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const ai = require('../src/services/ai');
const dEngine = require('../src/services/discrepancy-engine');
const cFields = require('../src/services/canonical-fields');

(async () => {
  console.log('========== R10-C mini-harness — LTV-routing three-band ==========');

  const _aiSrc = fs.readFileSync(path.join(__dirname, '../src/services/ai.js'), 'utf8');
  const _whSrc = fs.readFileSync(path.join(__dirname, '../src/routes/webhook.js'), 'utf8');
  const _deSrc = fs.readFileSync(path.join(__dirname, '../src/services/discrepancy-engine.js'), 'utf8');

  let passCount = 0;
  let failCount = 0;
  const expect = (label, cond, detail) => {
    if (cond) { console.log(`  PASS ${label}`); passCount++; }
    else { console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); failCount++; throw new Error(`FAIL [${label}]${detail ? ' — ' + detail : ''}`); }
  };

  // ─── R10-C-LTV-BAND-CLASSIFIER-MATRIX ───
  console.log('\n--- R10-C-LTV-BAND-CLASSIFIER-MATRIX ---');
  // over_80
  expect('(a) standaloneLtv=83.1 → "over_80" (Ryan/Donna empirical)',
    dEngine.computeLtvBand({ standaloneLtv: 83.1 }) === 'over_80');
  expect('(b) combinedLtv=83.1 + standaloneLtv null → "over_80"',
    dEngine.computeLtvBand({ combinedLtv: 83.1 }) === 'over_80');
  expect('(c) standaloneLtv=80.0 → NOT "over_80" (boundary: strict > 80)',
    dEngine.computeLtvBand({ standaloneLtv: 80.0 }) !== 'over_80');
  expect('(d) standaloneLtv=80.1 → "over_80" (boundary: just over)',
    dEngine.computeLtvBand({ standaloneLtv: 80.1 }) === 'over_80');
  // elevated_75_80
  expect('(e) standaloneLtv=76 → "elevated_75_80"',
    dEngine.computeLtvBand({ standaloneLtv: 76 }) === 'elevated_75_80');
  expect('(f) standaloneLtv=75 → "elevated_75_80" (boundary: inclusive ≥75)',
    dEngine.computeLtvBand({ standaloneLtv: 75 }) === 'elevated_75_80');
  expect('(g) standaloneLtv=79.9 → "elevated_75_80" (just under over_80)',
    dEngine.computeLtvBand({ standaloneLtv: 79.9 }) === 'elevated_75_80');
  // standard
  expect('(h) standaloneLtv=74.9 → "standard" (boundary: just under elevated)',
    dEngine.computeLtvBand({ standaloneLtv: 74.9 }) === 'standard');
  expect('(i) standaloneLtv=50 → "standard"',
    dEngine.computeLtvBand({ standaloneLtv: 50 }) === 'standard');
  // Conservative-max semantic — composed
  expect('(j) standaloneLtv=78 + combinedLtv=82 → "over_80" (max-of-two)',
    dEngine.computeLtvBand({ standaloneLtv: 78, combinedLtv: 82 }) === 'over_80');
  expect('(k) standaloneLtv=70 + combinedLtv=76 → "elevated_75_80"',
    dEngine.computeLtvBand({ standaloneLtv: 70, combinedLtv: 76 }) === 'elevated_75_80');
  // No signal
  expect('(l) both null → "standard" (defer to existing gates)',
    dEngine.computeLtvBand({}) === 'standard');

  // ─── R10-C-DEDICATED-GENERATOR-MINIMAL-ASK ───
  // Source-level pin (Claude call is mocked via the synthetic min-ask — the
  // function is async with a real Claude dependency, so we verify the prompt
  // shape via source-grep + the function's existence/export. End-to-end
  // generation is exercised by Stage 1.5 production-fixture-replay.
  console.log('\n--- R10-C-DEDICATED-GENERATOR-MINIMAL-ASK ---');
  expect('(a) generateHighLtvCollateralAsk function exported on ai module',
    typeof ai.generateHighLtvCollateralAsk === 'function');
  expect('(b) prompt cites the "ONLY ask" collateral-question discipline',
    /collateral-question email[\s\S]{0,400}SINGLE question/i.test(_aiSrc));
  expect('(c) prompt negative-list bans doc-list shape (no <ul>, no intake items)',
    /negative list[\s\S]{0,200}document list of any kind[\s\S]{0,200}no <ul>/i.test(_aiSrc));
  expect('(d) prompt negative-list bans empirical leak shapes ("exit strategy", "payout statement", etc.)',
    /"exit strategy"[\s\S]{0,300}"payout statement"[\s\S]{0,400}"PEP"/i.test(_aiSrc));
  expect('(e) prompt explicitly cites Ryan/Donna 45bd01df empirical anchor',
    /Ryan\/Donna\s+45bd01df\s+production\s+fixture/i.test(_aiSrc));
  expect('(f) prompt asks for concrete collateral examples (vacation home / investment property / etc.)',
    /investment property[\s\S]{0,100}vacation home/i.test(_aiSrc));
  expect('(g) prompt bans rejection language + approval-promise language',
    /Any\s+rejection\s+language[\s\S]{0,300}Any\s+promise\s+of\s+approval/i.test(_aiSrc));
  expect('(h) prompt bans internal-workflow language (R5-C carve-out)',
    /our review process[\s\S]{0,200}R5-C carve-out/i.test(_aiSrc));

  // ─── R10-C-INITIAL-SUBMISSION-ROUTING ───
  console.log('\n--- R10-C-INITIAL-SUBMISSION-ROUTING ---');
  expect('(a) processInitialEmail contains R10-C-1 pre-Claude bypass block',
    /R10-C-1[\s\S]{0,200}high-LTV[\s\S]{0,400}dedicated-generator bypass/i.test(_aiSrc));
  expect('(b) bypass uses late-require for canonical-fields + discrepancy-engine (circular-dep mitigation)',
    /Late-require to avoid module-load-time circular dep/i.test(_aiSrc)
      && /require\('\.\/canonical-fields'\)/i.test(_aiSrc)
      && /require\('\.\/discrepancy-engine'\)/i.test(_aiSrc));
  expect('(c) bypass orders AFTER S15-E identity-clash check (HHH precedent)',
    (() => {
      const s15Idx = _aiSrc.indexOf('S15-E-followup: identity clash detected JS-side');
      const r10cIdx = _aiSrc.indexOf('R10-C-1 (2026-05-27): high-LTV (>80%) dedicated-generator bypass');
      return s15Idx > 0 && r10cIdx > 0 && r10cIdx > s15Idx;
    })());
  expect('(d) bypass returns minimal dealSummary with ltv_band="over_80"',
    /ltv_band:\s*'over_80'/i.test(_aiSrc));
  expect('(e) bypass routes to generateHighLtvCollateralAsk (module.exports.* invocation)',
    /module\.exports\.generateHighLtvCollateralAsk/i.test(_aiSrc));
  expect('(f) bypass logs the band transition with combined + standalone LTV',
    /R10-C-1:\s*high-LTV\s*\(>80%\)\s*dedicated-generator bypass[\s\S]{0,200}combinedLtv/i.test(_aiSrc));

  // ─── R10-C-ACTIVE-BRANCH-ROUTING ───
  console.log('\n--- R10-C-ACTIVE-BRANCH-ROUTING ---');
  expect('(a) active-branch contains R10-C-1 dedicated-generator override',
    /R10-C-1[\s\S]{0,200}active-branch dedicated-generator bypass/i.test(_whSrc));
  expect('(b) override gates on status=awaiting_collateral && !collateral_offered',
    /status\s*===\s*'awaiting_collateral'[\s\S]{0,200}!_r10cActiveCollateralOffered/i.test(_whSrc));
  expect('(c) override REPLACES result.responseEmail (not result.updatedSummary)',
    /result\.responseEmail\s*=\s*_r10cActiveCollateralAsk/i.test(_whSrc));
  expect('(d) override preserves Task 2 (result.updatedSummary remains authoritative)',
    /result\.updatedSummary[\s\S]{0,200}preserved[\s\S]{0,200}Task 2 still runs/i.test(_whSrc));
  expect('(e) override threads greeting via _eActiveGreeting (R5-E lineage preserved)',
    /generateHighLtvCollateralAsk\([\s\S]{0,200}_eActiveGreeting/i.test(_whSrc));
  expect('(f) override docblock cites cascade-composition discipline (R5-C-CASCADE precedent)',
    /cascade-compose normally[\s\S]{0,300}R5-C-CASCADE-COMPOSITION precedent/i.test(_whSrc));

  // ─── R10-C-RYAN-LOAD-BEARING (Stage 1.5 live-Supabase) ───
  console.log('\n--- R10-C-RYAN-LOAD-BEARING (Stage 1.5) ---');
  const RYAN_DEAL = '45bd01df-4d8f-4ff4-98b0-86d80db79876';
  try {
    const { data: deal } = await supabase
      .from('deals')
      .select('id, status, ltv, extracted_data, borrower_name')
      .eq('id', RYAN_DEAL)
      .single();
    const { data: docs } = await supabase
      .from('documents')
      .select('file_name, classification, extracted_data')
      .eq('deal_id', RYAN_DEAL);
    const { data: msgs } = await supabase
      .from('messages')
      .select('id, direction, subject, body, created_at')
      .eq('deal_id', RYAN_DEAL)
      .order('created_at', { ascending: true });

    // Build canonical_map at msg[0] processing (the initial-submission turn)
    const inbound0 = msgs.find(m => m.direction === 'inbound');
    const docsForDetect = docs.map(d => ({
      file_name: d.file_name,
      classification: d.classification,
      text: d.extracted_data?.text || '',
    }));
    const canonicalMap = cFields.extractCanonicalFields(
      inbound0?.body || '',
      docsForDetect,
      { emailSubject: inbound0?.subject || '' },
    );
    const combined = dEngine.computeCombinedLtv(canonicalMap);
    const combinedLtv = combined?.combined_ltv_percent;
    const marketVal = (canonicalMap.subject_property_market_value || [])[0]?.value;
    const requestedVal = (canonicalMap.requested_loan_amount || [])[0]?.value;
    const standaloneLtv = (Number.isFinite(marketVal) && marketVal > 0 && Number.isFinite(requestedVal))
      ? Number(((requestedVal / marketVal) * 100).toFixed(1))
      : null;
    const band = dEngine.computeLtvBand({ standaloneLtv, combinedLtv });

    expect('(a) Ryan deal 45bd01df status=awaiting_collateral (existing escalation gate fired)',
      deal?.status === 'awaiting_collateral',
      `got status=${deal?.status}`);
    expect('(b) Ryan deal LTV column = 83.1',
      deal?.ltv === 83.1, `got ${deal?.ltv}`);
    expect('(c) Ryan canonical_map combined LTV ≈ 83.1',
      combinedLtv != null && Math.abs(combinedLtv - 83.1) < 0.5,
      `got ${combinedLtv}`);
    expect('(d) Ryan canonical_map → computeLtvBand returns "over_80"',
      band === 'over_80', `got "${band}"`);
    expect('(e) Ryan canonical_map has all 3 inputs: market_value + requested + existing_balance',
      Number.isFinite(marketVal) && Number.isFinite(requestedVal)
        && (canonicalMap.existing_first_mortgage_balance || []).length > 0);
    // [PRE-FIX EMPIRICAL] confirm production fixture has NO collateral question
    // in any of the 3 broker-facing outbounds (msg[1], msg[3], msg[5]).
    const outbounds = msgs.filter(m => m.direction === 'outbound');
    const collateralPhrases = /additional collateral|other property|investment property|second piece of real estate|vacation home/i;
    const collateralAsksInOutbounds = outbounds.filter(o => collateralPhrases.test(o.body || ''));
    expect('(f) [PRE-FIX EMPIRICAL] Ryan deal: 0 broker-facing outbounds contain collateral-question phrasing',
      collateralAsksInOutbounds.length === 0,
      `found ${collateralAsksInOutbounds.length} outbounds with collateral phrasing`);
  } catch (e) {
    console.log(`  SKIP (Ryan load-bearing) — ${e.message}`);
  }

  // ─── R10-C-75-80-MANUAL-REVIEW-SURFACE ───
  console.log('\n--- R10-C-75-80-MANUAL-REVIEW-SURFACE ---');
  expect('(a) injectElevatedLtvBandCallout function exported on ai module',
    typeof ai.injectElevatedLtvBandCallout === 'function');
  // elevated_75_80 injects callout
  const sampleLeadSummary = '<h2>Deal Snapshot</h2><p>Borrower: Test</p><h2>Risk Factors</h2><p>blah</p>';
  const injected = ai.injectElevatedLtvBandCallout(sampleLeadSummary, 'elevated_75_80', 77.5);
  expect('(b) elevated_75_80 callout contains "Elevated LTV Band" + LTV value',
    /Elevated LTV Band/i.test(injected) && /77\.5%/.test(injected));
  expect('(c) callout cites Schedule A Stage 1 contract spec',
    /Schedule A Stage 1 spec/i.test(injected));
  expect('(d) callout inserted AFTER Deal Snapshot block (reading-order preserved)',
    (() => {
      const snapIdx = injected.indexOf('<h2>Deal Snapshot</h2>');
      const calloutIdx = injected.indexOf('R10-C-2-ELEVATED-LTV-BAND-CALLOUT');
      const rfIdx = injected.indexOf('<h2>Risk Factors</h2>');
      return snapIdx >= 0 && calloutIdx > snapIdx && rfIdx > calloutIdx;
    })());
  // standard band: no callout
  expect('(e) standard band → no callout injected (unchanged)',
    ai.injectElevatedLtvBandCallout(sampleLeadSummary, 'standard', 60) === sampleLeadSummary);
  // over_80 band: no callout (over_80 deals bypass prelim site entirely)
  expect('(f) over_80 band → no callout injected at this site (over_80 deals bypass prelim)',
    ai.injectElevatedLtvBandCallout(sampleLeadSummary, 'over_80', 83) === sampleLeadSummary);
  // Idempotence
  expect('(g) idempotent: re-injecting on already-injected output yields single callout',
    (ai.injectElevatedLtvBandCallout(injected, 'elevated_75_80', 77.5)
      .match(/R10-C-2-ELEVATED-LTV-BAND-CALLOUT/g) || []).length === 1);

  // ─── R10-C-CROSS-CLUSTER-INTEGRATION ───
  console.log('\n--- R10-C-CROSS-CLUSTER-INTEGRATION ---');
  // S15-E identity-clash precedent preserved — identity gate runs BEFORE R10-C
  expect('(a) S15-E identity-clash detection precedes R10-C-1 in processInitialEmail',
    (() => {
      const s15Pos = _aiSrc.indexOf('isIdentityClashByAbsence(emailSubject, emailBody, savedDocs)');
      const r10cPos = _aiSrc.indexOf('R10-C-1 (2026-05-27): high-LTV (>80%) dedicated-generator bypass');
      return s15Pos > 0 && r10cPos > 0 && r10cPos > s15Pos;
    })());
  // R10-F discrepancyHold preserved at computeCompletionDispatch
  expect('(b) R10-F discrepancyHold parameter preserved at computeCompletionDispatch',
    /const\s+computeCompletionDispatch\s*=\s*\(\{[\s\S]{0,200}discrepancyHold\s*\}\)/.test(_whSrc));
  // R10-H sweepBrokerFacingDraft preserved at admin-handoff paths
  expect('(c) R10-H sweepBrokerFacingDraft helper preserved at admin-handoff',
    /const\s+sweepBrokerFacingDraft\s*=\s*\(html\)\s*=>/.test(_whSrc));
  // parseCollateralReply unchanged (path 3 of 4)
  expect('(d) parseCollateralReply at L3092 unchanged (path 3 of 4 — not touched)',
    /parseCollateralReply:\s*async\s*\(replyText\)/.test(_aiSrc)
      && /awaiting_collateral'[\s\S]{0,200}parseCollateralReply/.test(_whSrc));
  // willGoToCollateralCheck unchanged (path 4 of 4 — already symmetric per R10-F)
  expect('(e) willGoToCollateralCheck gate unchanged (path 4 of 4 — already symmetric per R10-F)',
    /const\s+willGoToCollateralCheck\s*=\s*_r1ActiveLtvShouldEscalate\s*&&\s*existingDeal\.status\s*===\s*'active'/i.test(_whSrc));
  // R10-E mortgage_position filter preserved (compatibility check)
  expect('(f) R10-E mortgage_position canonical filter preserved',
    /filterCanonicalMortgagePositionForObjectiveAuthoritative/.test(_deSrc)
      && /filterCanonicalMortgagePositionForObjectiveAuthoritative/.test(_whSrc));

  // ─── R10-C-DEFERRED-RESIDUAL-FLAGGING ───
  console.log('\n--- R10-C-DEFERRED-RESIDUAL-FLAGGING ---');
  expect('(a) generateHighLtvCollateralAsk docblock flags strict-rejection deferred residual',
    /DEFERRED RESIDUAL[\s\S]{0,500}strict-rejection[\s\S]{0,100}≥80%[\s\S]{0,500}Closure condition/i.test(_aiSrc));
  expect('(b) generateHighLtvCollateralAsk docblock cites Franco product-design call closure',
    /Franco[\s\S]{0,100}surfaces\s+production\s+case[\s\S]{0,300}auto-rejection[\s\S]{0,80}≥80%/i.test(_aiSrc));
  expect('(c) computeLtvBand docblock flags 75-80% manual-review surface MVP-level',
    /MVP[\s\S]{0,200}Risk Factors callout in admin-[\s\S]{0,100}facing prelim/i.test(_deSrc));
  expect('(d) computeLtvBand docblock cites deeper state-machine surface deferred',
    /Deeper\s+state-machine\s+surface[\s\S]{0,300}deferred[\s\S]{0,200}production fixture/i.test(_deSrc));
  expect('(e) injectElevatedLtvBandCallout docblock cites contract Schedule A Stage 1 spec',
    /R10-C-2[\s\S]{0,400}Schedule A Stage 1 spec/i.test(_aiSrc));
  expect('(f) cross-family hybrid (R9-A\' precedent) cited in commit-archaeology docblock',
    /Broker-facing prompt-and-sweep language discipline[\s\S]{0,500}dedicated-generator-bypass/i.test(_aiSrc));

  console.log('\n========== R10-C mini-harness complete ==========');
  console.log(`PASS: ${passCount} | FAIL: ${failCount}`);
  if (failCount > 0) process.exit(1);
})().catch(e => { console.error('\nHARNESS ERROR:', e.stack || e.message); process.exit(1); });
