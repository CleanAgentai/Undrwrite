#!/usr/bin/env node
// F3 — Q2 auto-decline and Bug-4 incomplete-data escalation now evaluate on follow-up
// emails (thread-aggregated facts), with the post-approval rule: alert, don't decline.
const { evaluateFollowUpLtvGates: g } = require('../src/routes/webhook').__test__;
const de = require('../src/services/discrepancy-engine');
let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}${d ? ` — ${d}` : ''}`); };
const m = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v : [{ value: v, source: 'email_body' }]]));

const fresh = { status: 'active', extracted_data: {} };
const approved = { status: 'active', prelim_approved_at: '2026-11-14', extracted_data: {} };

let r = g({ deal: fresh, canonicalMap: m({ requested_loan_amount: 460000, subject_property_market_value: 500000 }) });
ok('standalone 92% on a follow-up → auto-decline', r.autoDecline.decline === true, `std=${r.standaloneLtv}`);
ok('…and not admin-cleared', r.adminCleared === false);

r = g({ deal: approved, canonicalMap: m({ requested_loan_amount: 460000, subject_property_market_value: 500000 }) });
ok('same figures after approval → decline flagged but adminCleared (caller alerts, never declines)', r.autoDecline.decline === true && r.adminCleared === true);

r = g({ deal: fresh, canonicalMap: m({ requested_loan_amount: 300000, subject_property_market_value: 500000 }) });
ok('60% → no decline', r.autoDecline.decline === false);

// Bug-4: mortgage statement on file + loan present, combined can't compute, payout unconfirmed.
const incomplete = m({ requested_loan_amount: 300000, transaction_type: [{ value: 'refinance', payoutConfirmed: false, source: 'x' }] });
r = g({ deal: fresh, canonicalMap: incomplete, classifications: ['mortgage_statement'] });
ok('Bug-4 incomplete canonical on a follow-up → escalate', r.incompleteEscalate === true, `cmb=${r.combinedLtv}`);
r = g({ deal: approved, canonicalMap: incomplete, classifications: ['mortgage_statement'] });
ok('Bug-4 does not apply once the admin cleared the deal', r.incompleteEscalate === false);
r = g({ deal: fresh, canonicalMap: incomplete, classifications: [] });
ok('Bug-4 needs a mortgage statement on file', r.incompleteEscalate === false);

// Fallback standalone (model LTV) only used when canonical can't compute.
r = g({ deal: fresh, canonicalMap: m({}), fallbackStandaloneLtv: 95 });
ok('canonical absent → fallback standalone used (existing behaviour)', r.standaloneLtv === 95 && r.autoDecline.decline === true);

// Thread aggregation: correction in a later email wins over the first email's figure.
const agg = de.extractCanonicalFieldsAggregated([
  { subject: 'Refinance — Test', body: 'Loan amount: $300,000\nAppraised at $500,000' },
  { subject: 'Re: Refinance — Test', body: 'Correction: the loan amount is actually $470,000' },
], [], {});
r = g({ deal: fresh, canonicalMap: agg });
ok('thread-aggregated correction ($470k / $500k = 94%) drives the follow-up decline', r.autoDecline.decline === true, `std=${r.standaloneLtv}`);

console.log(`\n[f3-followup-ltv-gates] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
