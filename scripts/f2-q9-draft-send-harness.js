#!/usr/bin/env node
// F2 — admin SEND on a Q9 collateral-override draft must reach executeDraft.
// Pre-fix the pending-draft check only accepted ltv_escalated/under_review, or active +
// approval_completed, so SEND on a Q9 draft fell through ("no escalation action taken")
// or was re-read by parseAdminReply as a fresh decision.
const { isDraftAwaitingAdmin: f } = require('../src/routes/webhook').__test__;
let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };
const ov = { collateral_override_at: '2026-11-14T00:00:00Z' };

ok('Q9 approve → active + approval_doc_request (override) is a pending draft', f({ status: 'active', draft_action: 'approval_doc_request', extracted_data: ov }));
ok('Q9 reject → awaiting_collateral + rejection is a pending draft', f({ status: 'awaiting_collateral', draft_action: 'rejection', extracted_data: {} }));
ok('Q9 conditions → awaiting_collateral + conditions is a pending draft', f({ status: 'awaiting_collateral', draft_action: 'conditions', extracted_data: {} }));
ok('unchanged: ltv_escalated + rejection', f({ status: 'ltv_escalated', draft_action: 'rejection' }));
ok('unchanged: under_review + approval_doc_request', f({ status: 'under_review', draft_action: 'approval_doc_request' }));
ok('unchanged: active + approval_completed (close-out)', f({ status: 'active', draft_action: 'approval_completed' }));
ok('guard: ordinary active deal with stale draft_action is NOT a pending draft', !f({ status: 'active', draft_action: 'approval_doc_request', extracted_data: {} }));
ok('no draft → false (first admin reply on awaiting_collateral reaches the Q9 branch)', !f({ status: 'awaiting_collateral', draft_action: null }));
ok('terminal statuses never match', !f({ status: 'completed', draft_action: 'rejection' }) && !f({ status: 'rejected', draft_action: 'conditions' }));

console.log(`\n[f2-q9-draft-send] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
