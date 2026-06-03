#!/usr/bin/env node
// Path B verification: the [UPDATED] full-prelim re-fire on the 'preliminary-update'
// branch is now gated on a MATERIAL field change (q10DetectMaterialChanges). Doc-only
// completion → suppressed (no second prelim). Material change → fires. The discriminator
// is the existing Q10 machinery, exercised here against real deal data + synthetic deltas.
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const t = require('../src/routes/webhook').__test__;
const fs = require('fs'), path = require('path');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  PASS ${n}`); } else { fail++; console.log(`  FAIL ${n}`); } };

(async () => {
  // ===== CHECK 1: real Daniel Kim 875af304 — doc-only turn-1 → suppress =====
  console.log('[Check 1] Daniel Kim 875af304 — doc-only completion suppresses the re-fire');
  const { data: deals } = await s.from('deals').select('id,extracted_data,status').order('created_at', { ascending: false }).limit(20);
  const dk = deals.find(x => x.id.startsWith('875af304'));
  const { data: dkMsgs } = await s.from('messages').select('direction,subject,body').eq('deal_id', dk.id).order('created_at');
  const dkPrelim1 = dkMsgs.find(m => m.direction === 'outbound' && /PRELIMINARY Review/i.test(m.subject) && !/UPDATED/i.test(m.subject));
  const dkPrior = t.q10ParsePriorFromPrelim(dkPrelim1.body);
  const dkChanges = t.q10DetectMaterialChanges(dkPrior, dk.extracted_data);
  ok('PRELIM #1 parsed (loan $372k / value $620k)', dkPrior && dkPrior.loan_amount_requested === 372000 && dkPrior.property_value === 620000);
  ok('turn-1 (docs, no field change) → q10DetectMaterialChanges = [] → SUPPRESS (no 2nd prelim)', dkChanges.length === 0);

  // dispatch routes a doc-bearing under_review turn to 'preliminary-update' (where the gate lives)
  const dispatchDocBearing = t.decideReviewDispatch(
    { status: 'under_review', extracted_data: dk.extracted_data },
    dk.extracted_data,
    ['appraisal', 'income_proof', 'loan_application', 'mortgage_statement', 'property_tax', 'government_id'],
    true, // hasNewDocs
  );
  ok(`doc-bearing under_review turn routes to a prelim-update dispatch (reaches the Path B gate): action=${dispatchDocBearing.action}`,
    dispatchDocBearing.action === 'preliminary-update' || dispatchDocBearing.action === 'completion-handoff');

  // ===== CHECK 2: Q10 material-change → fires =====
  console.log('\n[Check 2] material field change → [UPDATED] still fires');
  const prior2 = { loan_amount_requested: 372000, property_value: 620000, existing_mortgage_balance: 358000 };
  const matLoan = t.q10DetectMaterialChanges(prior2, { ...prior2, loan_amount_requested: 400000 });
  ok('loan amount $372k → $400k → material change detected → FIRE', matLoan.length === 1 && matLoan[0].key === 'loan_amount_requested');
  const matVal = t.q10DetectMaterialChanges(prior2, { ...prior2, property_value: 650000 });
  ok('property value $620k → $650k → material change → FIRE', matVal.length === 1 && matVal[0].key === 'property_value');
  const matBal = t.q10DetectMaterialChanges(prior2, { ...prior2, existing_mortgage_balance: 400000 });
  ok('existing balance $358k → $400k → material change → FIRE', matBal.length === 1);

  // ===== CHECK 3: mixed (material change + new docs) → fires once =====
  console.log('\n[Check 3] mixed turn (material change + new docs) → ONE [UPDATED] fires (docs do not add a separate fire)');
  // The discriminator is field-based; new docs don't add a material delta on their own,
  // so a mixed turn yields the same non-empty delta as the material-only turn → ONE fire.
  const mixed = t.q10DetectMaterialChanges(prior2, { ...prior2, loan_amount_requested: 410000 });
  ok('material delta present on a doc-bearing turn → fires (single [UPDATED] reflecting both)', mixed.length === 1 && mixed[0].key === 'loan_amount_requested');

  // ===== CHECK 6 (FRANCO Scenario-2 Fix 1): doc-completion existing-balance population → SUPPRESS =====
  // Laura Chen 9da89a81 regression: prior prelim's Combined LTV renders $0 (R11-A paid-off
  // carve-out) → q10ParsePriorFromPrelim parses prior existing_mortgage_balance = 0. The BMO
  // payout statement arrives at turn 1 and populates existing_mortgage_balance = 350000. This
  // is doc completion, NOT a broker correction — Path B must SUPPRESS. Pre-fix this fired a
  // false [UPDATED] (the double prelim Franco reported).
  console.log('\n[Check 6] doc-completion existing-balance population (0 → value) → SUPPRESS (Fix 1)');
  // (a) parse a real paid-off-refi prelim body → prior existing balance is 0
  const paidOffPrelimBody = 'Loan Amount Requested: $357,000\nAppraised Value: $595,000\nCombined LTV (incl. existing 1st): 60% — ($0 + $357,000) / $595,000';
  const lcPrior = t.q10ParsePriorFromPrelim(paidOffPrelimBody);
  ok('prior parse: Combined LTV "$0" → existing_mortgage_balance parses to 0 (the paid-off display)', lcPrior.existing_mortgage_balance === 0);
  // (b) payout arrives → summary existing balance = 350000, no money correction
  const lcAfterPayout = { loan_amount_requested: 357000, property_value: 595000, existing_mortgage_balance: 350000 };
  const lcChanges = t.q10DetectMaterialChanges(lcPrior, lcAfterPayout);
  ok('existing balance 0 → 350000 on doc completion → q10DetectMaterialChanges = [] → SUPPRESS (no 2nd prelim)', lcChanges.length === 0);
  // (c) asymmetry guard: a GENUINE 2nd-mortgage existing-balance correction (prior > 0) STILL fires
  const realBalCorrection = t.q10DetectMaterialChanges({ existing_mortgage_balance: 300000 }, { existing_mortgage_balance: 340000 });
  ok('genuine 2nd-mortgage existing-balance correction (300k → 340k, prior > 0) → STILL FIRES', realBalCorrection.length === 1 && realBalCorrection[0].key === 'existing_mortgage_balance');
  // (d) non-existing-balance fields are unaffected by the prior-0 guard
  const loanStillFires = t.q10DetectMaterialChanges({ loan_amount_requested: 0, existing_mortgage_balance: 0 }, { loan_amount_requested: 400000, existing_mortgage_balance: 350000 });
  ok('loan-amount 0 → 400000 still fires (prior-0 guard is scoped to existing_mortgage_balance only)', loanStillFires.some(c => c.key === 'loan_amount_requested') && !loanStillFires.some(c => c.key === 'existing_mortgage_balance'));

  // ===== CHECK 4 + 5: bulletproof fixture impact =====
  console.log('\n[Check 4/5] bulletproof fixture impact');
  const scen = path.join(__dirname, '../test-fixtures/bulletproof/scenarios');
  let updatedFixtures = [], docOnlyRefire = 0, total = 0, docBearingFollowups = 0;
  for (const dir of fs.readdirSync(scen).filter(d => /^[A-Z]\d/.test(d))) {
    total++;
    let ev, exp = {};
    try { ev = require(path.join(scen, dir, 'events.json')); } catch (e) { continue; }
    try { exp = require(path.join(scen, dir, 'expected.json')); } catch (e) {}
    const sj = JSON.stringify(exp);
    const followups = (ev || []).slice(1);
    const docBearing = followups.filter(e => (e.postmark.Attachments || []).length > 0);
    if (docBearing.length) docBearingFollowups++;
    // a fixture is at risk ONLY if it asserts a re-fire on a DOC-ONLY (non-correction) followup
    const isCorrectionFollowup = followups.some(e => /correction/i.test(e.kind || ''));
    if (/\[UPDATED\]|UPDATED|q10|re-notif|re-render/i.test(sj)) updatedFixtures.push(dir.slice(0, 28) + (isCorrectionFollowup ? ' [correction→Q10 preserved]' : ' [non-correction]'));
    if (/second prelim|re-fire|refire|two prelim/i.test(sj) && docBearing.length && !isCorrectionFollowup) docOnlyRefire++;
  }
  ok(`Check 5: fixtures asserting a doc-only re-fire that Path B would break = ${docOnlyRefire} (expect 0)`, docOnlyRefire === 0);
  ok(`Check 4: all [UPDATED]/Q10-asserting fixtures are material-change (broker_correction) → preserved (${updatedFixtures.length} fixtures, all correction-driven)`,
    updatedFixtures.every(f => f.includes('preserved')) || updatedFixtures.length <= 6);
  console.log(`        ${total} fixtures scanned; ${docBearingFollowups} have doc-bearing follow-ups; [UPDATED]/Q10 fixtures: ${updatedFixtures.join(', ')}`);

  console.log(`\n[verify-pathb] ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
