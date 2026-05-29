#!/usr/bin/env node
// BATCH-11 Phase 3 — discrepancyHold gate suppression-state awareness.
const { GATE_INFERENCE } = require('../test-fixtures/bulletproof/lib/assertEngine');
const infer = GATE_INFERENCE.discrepancyHold.infer;
let pass=0, fail=0; const ok=(l,c)=>{c?pass++:fail++;console.log(`  ${c?'PASS':'FAIL'} ${l}`);};
const discrepEmail = { Subject: 'Re: discrepancy on loan amount', TextBody: 'discrepancy' };

console.log('\n[1] escalation suppresses → discrepancyHold NOT inferred (B02/B03 fix)');
ok('awaiting_collateral + discrepancy outbound + no prelim → false', infer({ finalDealState:{status:'awaiting_collateral'}, outboundEmails:[discrepEmail] }) === false);
ok('rejected → false', infer({ finalDealState:{status:'rejected'}, outboundEmails:[discrepEmail] }) === false);
ok('awaiting_identity_confirmation → false', infer({ finalDealState:{status:'awaiting_identity_confirmation'}, outboundEmails:[discrepEmail] }) === false);

console.log('\n[2] genuine discrepancyHold preserved (B01)');
ok('active + discrepancy notif + no prelim → true', infer({ finalDealState:{status:'active'}, outboundEmails:[discrepEmail] }) === true);
ok('under_review + discrepancy + no prelim → true', infer({ finalDealState:{status:'under_review'}, outboundEmails:[discrepEmail] }) === true);

console.log('\n[3] no false-fire when prelim DID fire');
ok('active + discrepancy + prelim present → false (prelim fired, no hold)', infer({ finalDealState:{status:'active'}, outboundEmails:[discrepEmail, {Subject:'ACTION REQUIRED: PRELIMINARY Review'}] }) === false);
ok('active + no discrepancy outbound → false', infer({ finalDealState:{status:'active'}, outboundEmails:[{Subject:'Re: hello'}] }) === false);

console.log(`\n[batch11-phase3-harness] ${pass} pass / ${fail} fail`);
process.exit(fail===0?0:1);
