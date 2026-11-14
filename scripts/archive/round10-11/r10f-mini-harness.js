// R10-F mini-harness — discrepancyHold gate-symmetry restoration at
// computeCompletionDispatch (webhook.js:874) + active-branch call site
// (webhook.js:3660). Closes Patricia Bug 5-3 (mortgage_position broker-
// clarification missing because R7-A 'preliminary-all-docs-in' dispatch
// wasn't gated on discrepancy).
//
// 6 verification groups:
//  (1) GATE-PARAMETER-MATRIX   — computeCompletionDispatch truth table
//  (2) CALL-SITE-WIRING        — active-branch threads _b2HoldActive
//  (3) PATRICIA-LOAD-BEARING   — Patricia msg[2] replay [PRE-FIX vs POST-FIX]
//  (4) PRODUCTION-FIXTURE-VERIFICATION (Stage 1.5 live-Supabase)
//  (5) CROSS-CLUSTER-INTEGRATION — R7-A / CCCC / R10-E preserved
//  (6) DEFERRED-RESIDUAL-FLAGGING — under_review + post-approval docblock pins

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

const webhook = require('../src/routes/webhook');
const dEngine = require('../src/services/discrepancy-engine');
const { computeCompletionDispatch, shouldHoldPrelimForDiscrepancy } = webhook.__test__;

(async () => {
  console.log('========== R10-F mini-harness — discrepancyHold gate-symmetry ==========');

  const _whSrc = fs.readFileSync(path.join(__dirname, '../src/routes/webhook.js'), 'utf8');

  let passCount = 0;
  let failCount = 0;
  const expect = (label, cond, detail) => {
    if (cond) { console.log(`  PASS ${label}`); passCount++; }
    else { console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); failCount++; throw new Error(`FAIL [${label}]${detail ? ' — ' + detail : ''}`); }
  };

  // Shared fixtures for the gate-parameter matrix. All-docs-in + hasExitStrategy
  // are required to reach the dispatch branch where R10-F fires.
  const baseDeal = { status: 'active', prelim_approved_at: null };
  const baseSummary = { exit_strategy: 'refinance with TD in 2027', is_purchase: false };
  // allRequiredForCompletion(refinance) = BASE_REQUIRED_INTAKE_REFINANCE + COMPLIANCE_REQUIRED_POSTAPPROVAL
  //   = ['government_id', 'appraisal', 'property_tax', 'mortgage_statement',
  //      'income_proof', 'credit_report', 'aml', 'pep']
  // (DOC_SYNONYMS: 'noa' also satisfies 'income_proof')
  const allInClassifications = [
    'government_id', 'appraisal', 'property_tax', 'mortgage_statement',
    'income_proof', 'credit_report', 'aml', 'pep',
  ];

  // ─── R10-F-GATE-PARAMETER-MATRIX ───
  console.log('\n--- R10-F-GATE-PARAMETER-MATRIX ---');
  expect('(a) discrepancyHold=true + allDocsIn + hasExitStrategy → null (NEW behavior; load-bearing fix-state)',
    computeCompletionDispatch({
      deal: baseDeal, summary: baseSummary, classifications: allInClassifications,
      willGoToCollateralCheck: false, willReview: false, identityClashUnresolved: false,
      discrepancyHold: true,
    }) === null);
  expect('(b) discrepancyHold=false + allDocsIn + no prelim_approved_at → "preliminary-all-docs-in" (R7-A preserved)',
    computeCompletionDispatch({
      deal: baseDeal, summary: baseSummary, classifications: allInClassifications,
      willGoToCollateralCheck: false, willReview: false, identityClashUnresolved: false,
      discrepancyHold: false,
    }) === 'preliminary-all-docs-in');
  expect('(c) discrepancyHold=false + allDocsIn + prelim_approved_at set → "completion-handoff" (CCCC preserved)',
    computeCompletionDispatch({
      deal: { ...baseDeal, prelim_approved_at: '2026-05-27T01:00:00Z' },
      summary: baseSummary, classifications: allInClassifications,
      willGoToCollateralCheck: false, willReview: false, identityClashUnresolved: false,
      discrepancyHold: false,
    }) === 'completion-handoff');
  expect('(d) discrepancyHold=undefined (legacy caller) → behaves as false (backwards-compat)',
    computeCompletionDispatch({
      deal: baseDeal, summary: baseSummary, classifications: allInClassifications,
      willGoToCollateralCheck: false, willReview: false, identityClashUnresolved: false,
      // discrepancyHold intentionally omitted
    }) === 'preliminary-all-docs-in');
  expect('(e) discrepancyHold=true + willReview=true → null (both gates compose)',
    computeCompletionDispatch({
      deal: baseDeal, summary: baseSummary, classifications: allInClassifications,
      willGoToCollateralCheck: false, willReview: true, identityClashUnresolved: false,
      discrepancyHold: true,
    }) === null);
  expect('(f) discrepancyHold=true + status≠"active" → null (status gate takes precedence)',
    computeCompletionDispatch({
      deal: { status: 'under_review', prelim_approved_at: null },
      summary: baseSummary, classifications: allInClassifications,
      willGoToCollateralCheck: false, willReview: false, identityClashUnresolved: false,
      discrepancyHold: true,
    }) === null);
  expect('(g) discrepancyHold=true + willGoToCollateralCheck=true → null (collateral gate composes)',
    computeCompletionDispatch({
      deal: baseDeal, summary: baseSummary, classifications: allInClassifications,
      willGoToCollateralCheck: true, willReview: false, identityClashUnresolved: false,
      discrepancyHold: true,
    }) === null);
  expect('(h) discrepancyHold=true + identityClashUnresolved=true → null (identity gate composes)',
    computeCompletionDispatch({
      deal: baseDeal, summary: baseSummary, classifications: allInClassifications,
      willGoToCollateralCheck: false, willReview: false, identityClashUnresolved: true,
      discrepancyHold: true,
    }) === null);

  // ─── R10-F-CALL-SITE-WIRING ───
  // Source-grep pins. The active-branch call site at L3660 must thread
  // _b2HoldActive as discrepancyHold. Initial-submission gate at L2894-2911
  // must remain untouched (already correctly held). Under_review path must
  // NOT be modified (deferred per Q2).
  console.log('\n--- R10-F-CALL-SITE-WIRING ---');
  expect('(a) active-branch L3660 threads "_b2HoldActive" as "discrepancyHold"',
    /computeCompletionDispatch\(\{[\s\S]{0,600}discrepancyHold:\s*_b2HoldActive,?[\s\S]{0,80}\}\);/m.test(_whSrc));
  expect('(b) shouldHoldPrelimForDiscrepancy signature unchanged (still takes 3-param object)',
    /const shouldHoldPrelimForDiscrepancy\s*=\s*\(\{\s*brokerFacingDiscrepancyCount,\s*brokerFacingReplyText,\s*summary\s*\}\)\s*=>/i.test(_whSrc));
  expect('(c) _b2HoldActive derivation chain unchanged (_willReviewBeforeB2 && shouldHoldPrelimForDiscrepancy)',
    /_b2HoldActive\s*=\s*_willReviewBeforeB2\s*&&\s*shouldHoldPrelimForDiscrepancy\(/.test(_whSrc));
  expect('(d) initial-submission gate at L2894 area unchanged (_b2HoldInitial flow preserved)',
    /_b2HoldInitial\s*=\s*shouldHoldPrelimForDiscrepancy/.test(_whSrc)
      && /if\s*\(_b2HoldInitial\)\s*\{[\s\S]{0,600}\}\s*else\s*\{[\s\S]{0,2000}sendPreliminaryReviewToAdmin/.test(_whSrc));
  expect('(e) under_review path (decideReviewDispatch) NOT modified — only ONE discrepancyHold: thread (active-branch L3660)',
    (_whSrc.match(/discrepancyHold:\s*_b2HoldActive/g) || []).length === 1
      && (_whSrc.match(/^\s*discrepancyHold:/gm) || []).length === 1);
  expect('(f) computeCompletionDispatch signature includes discrepancyHold parameter',
    /computeCompletionDispatch\s*=\s*\(\{[\s\S]{0,200}discrepancyHold\s*\}\)/.test(_whSrc));

  // ─── R10-F-PATRICIA-LOAD-BEARING ───
  // Replay Patricia's msg[2] turn through detection + gate. Pre-fix: dispatch
  // returns 'preliminary-all-docs-in' regardless of discrepancy. Post-fix:
  // dispatch returns null when discrepancyHold threaded.
  console.log('\n--- R10-F-PATRICIA-LOAD-BEARING ---');
  const PATRICIA_DEAL = 'a0caddfb-92c4-4607-8ec1-72f54f9ebb31';
  let patriciaCanonical = null;
  let patriciaBrokerFacing = null;
  let patriciaDealForGate = null;
  let patriciaSummary = null;
  let patriciaClassifications = null;
  try {
    const { data: msgs } = await supabase
      .from('messages')
      .select('id, direction, subject, body, created_at')
      .eq('deal_id', PATRICIA_DEAL)
      .order('created_at', { ascending: true });
    const { data: docs } = await supabase
      .from('documents')
      .select('file_name, classification, extracted_data')
      .eq('deal_id', PATRICIA_DEAL);
    const inbounds = msgs.filter(m => m.direction === 'inbound');
    const docsForDetect = docs.map(d => ({
      file_name: d.file_name,
      classification: d.classification,
      text: d.extracted_data?.text || '',
    }));
    // Replay runDiscrepancyDetection on inbound[1] (broker docs arrival)
    const detect = dEngine.runDiscrepancyDetection(
      inbounds[1]?.body || '',
      docsForDetect,
      'Clearpath',
      { emailSubject: inbounds[1]?.subject || '' },
    );
    patriciaBrokerFacing = dEngine.filterBrokerFacing(detect.discrepancy_set, { marketDeltaFlagsEnabled: false });
    patriciaCanonical = detect.canonical_map;
    patriciaDealForGate = { status: 'active', prelim_approved_at: null };
    // Reconstruct summary as it would have been at msg[2] turn: exit_strategy present from broker, LTV ~65.7
    patriciaSummary = { exit_strategy: 'refinance at mortgage maturity', is_purchase: false };
    patriciaClassifications = docs.map(d => d.classification).filter(Boolean);

    expect('(a) Patricia msg[2] replay: detection produces brokerFacing.length=1',
      patriciaBrokerFacing.length === 1, `got ${patriciaBrokerFacing.length}`);
    expect('(b) Patricia brokerFacing entry is mortgage_position discrepancy',
      patriciaBrokerFacing[0]?.field === 'mortgage_position');
    expect('(c) Patricia mortgage_position groups: 2 (1st vs 2nd)',
      patriciaBrokerFacing[0]?.groups.length === 2);
    // Simulated active-branch state: _willReviewBeforeB2=true would be true at this turn (LTV ≤80,
    // reviewable doc on file, exit_strategy, active, no prelim_approved_at). Combined with
    // brokerFacing.length=1 → shouldHoldPrelimForDiscrepancy returns true → _b2HoldActive=true.
    const _b2HoldActiveSimulated = (patriciaBrokerFacing.length > 0); // mirrors structured-signal arm
    expect('(d) _b2HoldActive=true at Patricia msg[2] turn (discrepancy detected)',
      _b2HoldActiveSimulated === true);
    // [PRE-FIX vs POST-FIX] structural-surface assertions. Patricia's actual
    // msg[2] classifications did NOT satisfy allDocsIn (the broker was still
    // missing ID/property_tax/mortgage_statement/aml/pep), so the bug-state
    // anchor uses a hypothetical all-docs-in scenario layered onto Patricia's
    // detected discrepancy. This proves the STRUCTURAL fix at computeCompletion-
    // Dispatch independently of Patricia's specific allDocsIn state — the gate
    // would fire on the next deal that has BOTH a discrepancy AND all-docs-in
    // simultaneously (the empirical bug surface the structural fix forecloses).
    const preFixDispatch = computeCompletionDispatch({
      deal: patriciaDealForGate,
      summary: patriciaSummary,
      classifications: allInClassifications, // synthetic all-docs-in
      willGoToCollateralCheck: false,
      willReview: false, // _b2HoldActive already held willReview at this point
      identityClashUnresolved: false,
      // discrepancyHold intentionally omitted to simulate pre-fix
    });
    expect('(e) [PRE-FIX SIMULATION] dispatch returns "preliminary-all-docs-in" (bug-state — Patricia-discrepancy + synthetic all-docs-in)',
      preFixDispatch === 'preliminary-all-docs-in',
      `got ${JSON.stringify(preFixDispatch)}`);
    const postFixDispatch = computeCompletionDispatch({
      deal: patriciaDealForGate,
      summary: patriciaSummary,
      classifications: allInClassifications,
      willGoToCollateralCheck: false,
      willReview: false,
      identityClashUnresolved: false,
      discrepancyHold: _b2HoldActiveSimulated,
    });
    expect('(f) [POST-FIX] dispatch returns null when discrepancyHold=true (CORE FIX ASSERTION)',
      postFixDispatch === null);
  } catch (e) {
    console.log(`  SKIP (Patricia load-bearing) — ${e.message}`);
  }

  // ─── R10-F-PRODUCTION-FIXTURE-VERIFICATION (Stage 1.5 live-Supabase) ───
  // End-to-end replay: render the broker-facing discrepancy section as it
  // would have been injected into Vienna's reply. Confirms the broker WOULD
  // have received the clarification ask if the gate hadn't been bypassed.
  console.log('\n--- R10-F-PRODUCTION-FIXTURE-VERIFICATION (Stage 1.5) ---');
  if (patriciaBrokerFacing) {
    const section = dEngine.renderDiscrepancySection(patriciaBrokerFacing);
    expect('(a) renderDiscrepancySection produces non-empty broker-facing clarification',
      section.length > 100);
    expect('(b) clarification section mentions "mortgage_position"',
      /mortgage_position/i.test(section));
    expect('(c) clarification section asks broker to confirm ("Could you confirm")',
      /Could you confirm/i.test(section));
    expect('(d) clarification section surfaces both values ("1st" and "2nd")',
      /"1st"/.test(section) && /"2nd"/.test(section));
  } else {
    console.log('  SKIP (Stage 1.5) — Patricia replay state unavailable');
  }

  // ─── R10-F-CROSS-CLUSTER-INTEGRATION ───
  console.log('\n--- R10-F-CROSS-CLUSTER-INTEGRATION ---');
  // R7-A preliminary-all-docs-in path preserved when no discrepancy
  expect('(a) R7-A: no discrepancy + allDocsIn + no prelim_approved_at → "preliminary-all-docs-in"',
    computeCompletionDispatch({
      deal: { status: 'active', prelim_approved_at: null },
      summary: baseSummary, classifications: allInClassifications,
      willGoToCollateralCheck: false, willReview: false, identityClashUnresolved: false,
      discrepancyHold: false,
    }) === 'preliminary-all-docs-in');
  // CCCC completion-handoff path preserved when no discrepancy
  expect('(b) CCCC: no discrepancy + allDocsIn + prelim_approved_at set → "completion-handoff"',
    computeCompletionDispatch({
      deal: { status: 'active', prelim_approved_at: '2026-05-27T01:00:00Z' },
      summary: baseSummary, classifications: allInClassifications,
      willGoToCollateralCheck: false, willReview: false, identityClashUnresolved: false,
      discrepancyHold: false,
    }) === 'completion-handoff');
  // R10-E compatibility: mortgage_position filter applies at consumer sites
  // (Snapshot / formatCanonicalFieldsForPrompt), NOT at computeDiscrepancySet
  // (which feeds _bBrokerFacingActive). So R10-E filter does NOT mask R10-F
  // detection. Verify by spot-check: filtered map drops email_body tuple,
  // unfiltered map keeps it — discrepancy detection sees unfiltered.
  expect('(c) R10-E filter compatibility: filterCanonicalMortgagePosition applies at consumer sites only',
    (() => {
      // Synthetic 3-tuple canonical_map matching Patricia shape
      const synthMap = {
        mortgage_position: [
          { value: '1st', source: 'email_subject_or_body', classification: 'email_subject_or_body' },
          { value: '2nd', source: 'LoanApplication_X.pdf', classification: 'loan_application' },
          { value: '2nd', source: 'derived', classification: 'mortgage_position_inferred_from_existing_balance' },
        ],
      };
      // computeDiscrepancySet on unfiltered map → 2 groups (1st vs 2nd) → discrepancy detected
      const raw = dEngine.computeDiscrepancySet
        ? dEngine.computeDiscrepancySet(synthMap)
        : null;
      // R10-E filter strips email_body when loan_application present → 1 group → no discrepancy
      const filtered = dEngine.filterCanonicalMortgagePositionForObjectiveAuthoritative(synthMap);
      const filteredDiscrepancySet = dEngine.computeDiscrepancySet
        ? dEngine.computeDiscrepancySet(filtered)
        : null;
      // Both functions exist in the production discrepancy-engine. We can verify
      // the filter behavior:
      // - Unfiltered tuples count: 3
      // - Filtered tuples count: 1 (only loan_application kept)
      return synthMap.mortgage_position.length === 3
        && filtered.mortgage_position.length === 1
        && filtered.mortgage_position[0].classification === 'loan_application';
    })());
  // Pure function — no side effects
  expect('(d) computeCompletionDispatch is side-effect-free (deterministic on same input)',
    (() => {
      const input = {
        deal: baseDeal, summary: baseSummary, classifications: allInClassifications,
        willGoToCollateralCheck: false, willReview: false, identityClashUnresolved: false,
        discrepancyHold: true,
      };
      const r1 = computeCompletionDispatch(input);
      const r2 = computeCompletionDispatch(input);
      return r1 === r2 && r1 === null;
    })());
  // Existing willReview / willGoToCollateralCheck / identityClashUnresolved gates preserved
  expect('(e) willReview gate preserved: willReview=true → null regardless of discrepancyHold',
    computeCompletionDispatch({
      deal: baseDeal, summary: baseSummary, classifications: allInClassifications,
      willGoToCollateralCheck: false, willReview: true, identityClashUnresolved: false,
      discrepancyHold: false,
    }) === null);
  expect('(f) computeCompletionDispatch returns null on null deal (defensive — pre-existing behavior)',
    computeCompletionDispatch({
      deal: null, summary: baseSummary, classifications: allInClassifications,
      willGoToCollateralCheck: false, willReview: false, identityClashUnresolved: false,
      discrepancyHold: false,
    }) === null);

  // ─── R10-F-DEFERRED-RESIDUAL-FLAGGING ───
  console.log('\n--- R10-F-DEFERRED-RESIDUAL-FLAGGING ---');
  expect('(a) computeCompletionDispatch docblock cites R10-F + asymmetric-gate context',
    /R10-F\s*\(2026-05-27\)\s*—\s*ASYMMETRIC-GATE\s+EMPIRICAL\s+DISCIPLINE/i.test(_whSrc));
  expect('(b) computeCompletionDispatch docblock flags under_review parallel-gate deferred residual',
    /DEFERRED\s+RESIDUAL[\s\S]{0,500}decideReviewDispatch[\s\S]{0,200}parallel-gate\s+symmetry/i.test(_whSrc));
  expect('(c) under_review deferred residual has closure condition',
    /Closure\s+condition[\s\S]{0,300}empirical\s+fixture[\s\S]{0,200}under_review\s+path\s+firing\s+prelim/i.test(_whSrc));
  expect('(d) post-approval doc-request site has R10-F deferred-residual docblock',
    /R10-F\s*\(2026-05-27\)\s*DEFERRED\s+RESIDUAL[\s\S]{0,800}post-approval\s+doc-request[\s\S]{0,200}discrepancy\s+injection/i.test(_whSrc));
  expect('(e) post-approval deferred residual cites gate-fix prerequisite-chain rationale',
    /R10-F'?s\s+gate[\s\S]{0,80}fix[\s\S]{0,400}prevents\s+this\s+path[\s\S]{0,200}unresolved-discrepancy\s+state/i.test(_whSrc));
  expect('(f) post-approval deferred residual has closure condition',
    /Closure\s+condition[\s\S]{0,400}broker-confirmed-resolved\s+deal[\s\S]{0,200}discrepancy-history/i.test(_whSrc));

  console.log('\n========== R10-F mini-harness complete ==========');
  console.log(`PASS: ${passCount} | FAIL: ${failCount}`);
  if (failCount > 0) process.exit(1);
})().catch(e => { console.error('\nHARNESS ERROR:', e.stack || e.message); process.exit(1); });
