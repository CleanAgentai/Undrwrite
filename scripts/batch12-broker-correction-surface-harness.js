#!/usr/bin/env node
// BATCH-12 harness — assertEngine broker_correction verification surface.
// PRIMARY = Q10 [UPDATED] notice + broker ack; SECONDARY = extracted_data;
// NOT a Snapshot re-render (Vienna doesn't re-render post-correction; Q10 design).
const ae = require('../test-fixtures/bulletproof/lib/assertEngine.js');
let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };
const ev = (expected, captured) => ae.evaluate({ scenarioId: 'T', expected, ...captured }).layer1_canonical[0];

const exp = { verification_profile: 'broker_correction', layer1_structural: { canonical_map: { requested_loan_amount: { value: 295000, rationale: 'r' } } }, layer2_semantic: { outbound_emails: [] } };
const prelim = { Subject: 'ACTION REQUIRED: PRELIMINARY Review — Marcus Webb', HtmlBody: '<p><strong>Loan Amount Requested:</strong> $260,000</p>' };
const ack = { Subject: 'Re: Re: Refinance — Marcus Webb', HtmlBody: 'noting the updated $295,000 figure' };
const q10 = { Subject: '[UPDATED] Prelim correction — Marcus Webb: requested loan amount', HtmlBody: 'requested loan amount: 260000 → 295000' };

console.log('[1] PRIMARY — corrected value in Q10 notice + ack → pass');
let r = ev(exp, { finalDealState: { status: 'active', extracted_data: { requested_loan_amount: 295000 } }, outboundEmails: [prelim, ack, q10] });
ok('pass via primary', r.status === 'pass' && /primary/.test(r.normalization));

console.log('[2] SECONDARY — primary absent, extracted_data persisted → pass(secondary)');
r = ev(exp, { finalDealState: { status: 'active', extracted_data: { requested_loan_amount: 295000 } }, outboundEmails: [prelim] });
ok('pass via secondary', r.status === 'pass' && /secondary/.test(r.normalization));

console.log('[3] NEGATIVE — corrected value nowhere → fail (no fudge)');
r = ev(exp, { finalDealState: { status: 'active', extracted_data: { requested_loan_amount: 260000 } }, outboundEmails: [prelim] });
ok('fail when value truly absent', r.status === 'fail');

console.log('[4] money grouping — 295000 ↔ "295,000" matched');
r = ev(exp, { finalDealState: { status: 'active', extracted_data: {} }, outboundEmails: [{ Subject: '[UPDATED] Prelim correction', HtmlBody: '260000 → 295000' }] });
ok('grouped/plain money both match', r.status === 'pass');

console.log('[5] profile OFF → standard Snapshot path (not broker_correction)');
r = ev({ ...exp, verification_profile: undefined }, { finalDealState: { status: 'active', extracted_data: {} }, outboundEmails: [prelim, ack, q10] });
ok('without profile does NOT use broker_correction surface', !/broker_correction/.test(r.normalization || ''));

console.log('[6] value_includes form (PV correction) supported');
const expPV = { verification_profile: 'broker_correction', layer1_structural: { canonical_map: { property_value: { value_includes: [735000], rationale: 'r' } } }, layer2_semantic: { outbound_emails: [] } };
r = ev(expPV, { finalDealState: { status: 'under_review', extracted_data: {} }, outboundEmails: [{ Subject: '[UPDATED] Prelim correction — property value corrected', HtmlBody: 'property value: 700000 → 735000' }] });
ok('PV value_includes via primary', r.status === 'pass');

console.log(`\n[batch12-broker-correction-surface] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
