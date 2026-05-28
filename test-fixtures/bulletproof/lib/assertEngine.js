// Layer 1 + Layer 2 + Layer 3 assertion engine.
//
// Option B per Q-R2: gate-inference table bridges Phase 4 spec INTENT
// (gate fires) to observable EVIDENCE (outbound behavior). Phase 4 specs
// remain authoritative; this layer translates intent-grounded spec to
// Vienna's actual observable behavior.
//
// Gate-inference table is THE single source of documentation for which
// transient Vienna gates exist + how they're observable. Entries cite
// architectural anchor per Porter Q-R2 refinement.

const { resolveSpecField, resolveStatus, ARCH_AMENDMENT_FIELDS } = require('./normalize-map');

// ────────────────────────────────────────────────────────────────────────────
// GATE_INFERENCE — explicit table documenting each transient gate's evidence
// pattern + rationale + architectural anchor. Per Porter Q-R2 refinement:
// prevents hidden coupling between spec and assertEngine + provides traceable
// rationale for triage report attribution.
//
// Each entry: { evidence_pattern, rationale, architectural_anchor, infer(captured) → bool }
// ────────────────────────────────────────────────────────────────────────────
const GATE_INFERENCE = {
  discrepancyHold: {
    evidence_pattern: 'admin_discrepancy_notification fired AND preliminary_review_admin NOT fired',
    rationale: 'R10-F asymmetric-gate semantics — discrepancyHold suppresses prelim dispatch + composes admin notification',
    architectural_anchor: 'R10-F + R11-B-1 Layer 1',
    infer: (captured) => {
      const emails = captured.outboundEmails || [];
      const hasDiscrepancyNotif = emails.some(e => /discrepancy|conflict|broker.{0,10}correct/i.test(e.Subject || '') || /discrepancy/i.test(e.TextBody || ''));
      const hasPrelim = emails.some(e => /preliminary review|PRELIMINARY/i.test(e.Subject || ''));
      return hasDiscrepancyNotif && !hasPrelim;
    },
  },
  elevated_ltv_band: {
    evidence_pattern: 'Risk Factors callout contains "75-80%" band string',
    rationale: 'R10-C-2 elevated-band callout JS-injected at sendPreliminaryReviewToAdmin',
    architectural_anchor: 'R10-C-2',
    infer: (captured) => {
      const emails = captured.outboundEmails || [];
      return emails.some(e => /75-80%|75 to 80%|elevated.{0,15}band/i.test(e.HtmlBody || e.TextBody || ''));
    },
  },
  high_ltv_detected: {
    evidence_pattern: 'workflow_state=awaiting_collateral OR collateral-question outbound fires',
    rationale: 'R10-C-1 dedicated-generator-bypass triggers F2.AC state transition + minimal-ask',
    architectural_anchor: 'R10-C-1',
    infer: (captured) => captured.finalDealState?.status === 'awaiting_collateral' ||
      (captured.outboundEmails || []).some(e => /collateral/i.test(e.Subject || '')),
  },
  awaiting_collateral: {
    evidence_pattern: 'deal.status === "awaiting_collateral" (persisted enum)',
    rationale: 'F2.AC state-derived gate persisted as status column',
    architectural_anchor: 'R10-C-1 + R10-F state-derived gate signal template',
    infer: (captured) => captured.finalDealState?.status === 'awaiting_collateral',
  },
  postal_code_discrepancy_detected: {
    evidence_pattern: 'Risk Factors callout enumerates distinct postal codes',
    rationale: 'R11-C M2 injectPostalCodeDiscrepancyCallout',
    architectural_anchor: 'R11-C M2',
    infer: (captured) => (captured.outboundEmails || []).some(e =>
      /postal.{0,30}code.{0,30}discrepan|two.{0,10}postal/i.test(e.HtmlBody || e.TextBody || '')),
  },
  file_hosting_link_detected: {
    evidence_pattern: 'admin_handoff_notification fired AND broker_facing_auto_response NOT fired',
    rationale: 'F2.FH file-hosting-link detection → admin handoff + Vienna paused per-deal',
    architectural_anchor: 'ADMIN-HANDOFF LINK-SUBMISSION (commit 86605a9)',
    infer: (captured) => {
      const emails = captured.outboundEmails || [];
      const hasAdminNotif = emails.some(e => /file hosting|external link|file\.io|wetransfer|drive\.google/i.test(e.Subject || '' + e.TextBody || ''));
      return hasAdminNotif;
    },
  },
  vienna_paused_per_deal: {
    evidence_pattern: 'admin_controlled column = true',
    rationale: 'Per-deal Vienna pause persisted via admin_controlled boolean',
    architectural_anchor: 'F2.FH state-derived gate signal',
    infer: (captured) => captured.finalDealState?.admin_controlled === true,
  },
  prelim_approved_at: {
    evidence_pattern: 'deal.prelim_approved_at IS NOT NULL (persisted timestamp)',
    rationale: 'F2.PA event-driven gate persisted as timestamp column',
    architectural_anchor: 'R10-I + 2026-05-11-prelim-approved-at migration',
    infer: (captured) => captured.finalDealState?.prelim_approved_at != null,
  },
  aml_pep_requested_at: {
    evidence_pattern: 'deal.aml_pep_requested_at IS NOT NULL (persisted timestamp)',
    rationale: 'F2.AP event-driven gate persisted as timestamp column',
    architectural_anchor: '2026-05-21-aml-pep-requested-at migration',
    infer: (captured) => captured.finalDealState?.aml_pep_requested_at != null,
  },
  broker_silence_threshold_pending: {
    evidence_pattern: 'F4.CH chase email fires (after cron-fast-forward + runFollowUpReminders)',
    rationale: 'F4.CH chase per Layer 3 #6 72h default; observable via outbound chase email',
    architectural_anchor: 'F4.CH + Layer 3 #6',
    infer: (captured) => (captured.outboundEmails || []).some(e =>
      /follow.{0,3}up|checking in|still waiting|reminder/i.test(e.Subject || '' + e.TextBody || '')),
  },
  // Catch-all for transient gates not explicitly enumerated: assertEngine
  // marks unknown gates as "inference_unknown" rather than pass/fail.
};

// ────────────────────────────────────────────────────────────────────────────
// RENDER-SURFACE verification (Sub-phase 5.5 probe finding + Q-6.1-1/2)
//
// extracted_data is a RAW pre-canonical intake snapshot — NOT the canonical
// store. Canonical resolution (R10-G source-hierarchy incl. broker corrections)
// is REQUEST-TIME and only observable on the rendered Deal Snapshot
// (renderDealSnapshot, discrepancy-engine.js) in the prelim/lead-summary
// outbound. These fields are therefore verified by parsing the ACTUAL rendered
// Snapshot HTML — NOT extracted_data, and NOT by reconstructing canonical_map
// via Vienna's own extractCanonicalFields (which would be partially circular:
// a bug in the shared resolution logic would produce matching wrong values in
// both expected and actual, defeating the assertion). Parsing rendered output
// keeps verification independent of the logic under test.
//
// Dependency: the Snapshot only renders when the prelim/lead-summary fires
// (requires exit_strategy per CLUSTER-1). Scenarios verifying these fields
// must supply exit_strategy so the render surface is exposed.
// ────────────────────────────────────────────────────────────────────────────
const SNAPSHOT_ROW_LABELS = {
  requested_loan_amount:    { label: 'Loan Amount Requested', type: 'money' },
  property_value:           { label: 'Appraised Value', type: 'money' },
  mortgage_position:        { label: 'Mortgage Position', type: 'string' },
  subject_property_address: { label: 'Property Address', type: 'string' },
  property_address:         { label: 'Property Address', type: 'string' },
  ltv_percent:              { label: 'LTV', type: 'percent' },
};
const RENDER_SURFACE_FIELDS = new Set(Object.keys(SNAPSHOT_ROW_LABELS));

const findSnapshotEmail = (captured) =>
  (captured.outboundEmails || []).find(e => /Deal Snapshot/i.test(e.HtmlBody || e.TextBody || ''));

// Parse one Snapshot row "<p><strong>LABEL:</strong> VALUE</p>". Returns the
// FIRST value (canonical-resolved value renders first; multi-value only when
// sources genuinely disagree post-filter).
const parseSnapshotRow = (body, label, type) => {
  const re = new RegExp('<strong>\\s*' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*</strong>\\s*([^<]+)', 'i');
  const m = re.exec(body || '');
  if (!m) return { present: false, value: null, raw: null };
  const raw = m[1].trim();
  if (/^TBD/i.test(raw)) return { present: true, value: null, raw };
  if (type === 'money') {
    const mm = raw.match(/\$?([\d,]+)/);
    return { present: true, value: mm ? Number(mm[1].replace(/,/g, '')) : null, raw };
  }
  if (type === 'percent') {
    const mm = raw.match(/(\d+)\s*%/);
    return { present: true, value: mm ? Number(mm[1]) : null, raw };
  }
  // string: first value before " / " (multi-value) or " (per ...)" source tag
  const clean = raw.split(/\s+\/\s+/)[0].split(/\s+\(/)[0].trim();
  return { present: true, value: clean, raw };
};

// ────────────────────────────────────────────────────────────────────────────
// Layer 1 STRUCTURAL assertion evaluator
// ────────────────────────────────────────────────────────────────────────────
const evalCanonicalMap = (expected, captured) => {
  const results = [];
  const extracted = captured.finalDealState?.extracted_data || {};
  const snapEmail = findSnapshotEmail(captured);
  for (const [specKey, expectation] of Object.entries(expected.layer1_structural?.canonical_map || {})) {
    let actualValue, classification, normRationale;
    if (RENDER_SURFACE_FIELDS.has(specKey)) {
      const { label, type } = SNAPSHOT_ROW_LABELS[specKey];
      if (!snapEmail) {
        results.push({ field: specKey, status: 'fail', detail: 'no Deal Snapshot rendered (prelim/lead-summary did not fire) — render surface unavailable', normalization: 'render_surface', normalization_rationale: `verified via rendered Snapshot row "${label}" per Sub-phase 5.5`, spec_rationale: expectation.rationale });
        continue;
      }
      const parsed = parseSnapshotRow(snapEmail.HtmlBody || snapEmail.TextBody || '', label, type);
      actualValue = parsed.value;
      classification = 'render_surface';
      normRationale = `parsed from Deal Snapshot row "${label}" (render surface; raw="${parsed.raw}")`;
    } else {
      ({ value: actualValue, classification, rationale: normRationale } = resolveSpecField(specKey, extracted));
    }
    let status, detail;
    if (classification === 'architecture_amendment_candidate') {
      status = 'architecture_amendment_candidate';
      detail = `field has no Vienna mapping; architecture-amendment-candidate per normalize-map`;
    } else if (expectation.value !== undefined) {
      // Exact match
      status = actualValue === expectation.value ? 'pass' : 'fail';
      detail = `expected=${JSON.stringify(expectation.value)} actual=${JSON.stringify(actualValue)}`;
    } else if (expectation.value_includes) {
      // All strings present in stringified actual
      const actualStr = String(actualValue || '');
      const missing = expectation.value_includes.filter(s => !actualStr.includes(s));
      status = missing.length === 0 ? 'pass' : 'fail';
      detail = missing.length === 0 ? 'all includes present' : `missing: ${missing.join(', ')}`;
    } else if (expectation.value === null && expectation.source_classification === 'missing') {
      // Field absent or null
      status = (actualValue == null) ? 'pass' : 'fail';
      detail = `expected null/missing; actual=${JSON.stringify(actualValue)}`;
    } else {
      status = 'skip';
      detail = 'no assertable expectation form';
    }
    results.push({ field: specKey, status, detail, normalization: classification, normalization_rationale: normRationale, spec_rationale: expectation.rationale });
  }
  return results;
};

const evalGateStates = (expected, captured) => {
  const results = [];
  for (const [gateName, expectation] of Object.entries(expected.layer1_structural?.gate_states || {})) {
    const inferenceEntry = GATE_INFERENCE[gateName];
    let status, detail, inferred;
    if (!inferenceEntry) {
      status = 'inference_unknown';
      detail = `gate '${gateName}' has no GATE_INFERENCE entry; cannot evaluate`;
      inferred = null;
    } else {
      try {
        inferred = inferenceEntry.infer(captured);
        const expectedValue = expectation.value;
        if (typeof expectedValue === 'boolean') {
          status = inferred === expectedValue ? 'pass' : 'fail';
          detail = `inferred=${inferred} expected=${expectedValue}`;
        } else {
          status = 'skip';
          detail = `non-boolean expectation on transient gate; not evaluable`;
        }
      } catch (e) {
        status = 'error';
        detail = `inference error: ${e.message}`;
      }
    }
    results.push({
      gate: gateName,
      status,
      detail,
      inferred,
      evidence_pattern: inferenceEntry?.evidence_pattern,
      architectural_anchor: inferenceEntry?.architectural_anchor,
      spec_rationale: expectation.rationale,
    });
  }
  return results;
};

const evalWorkflowState = (expected, captured) => {
  const expectedState = expected.layer1_structural?.workflow_state?.value;
  if (!expectedState) return null;
  const actualStatus = captured.finalDealState?.status;
  const matches = resolveStatus(expectedState, captured.finalDealState);
  return {
    expected: expectedState,
    actual: actualStatus,
    status: matches ? 'pass' : 'fail',
    rationale: expected.layer1_structural.workflow_state.rationale,
  };
};

// ────────────────────────────────────────────────────────────────────────────
// Layer 2 SEMANTIC assertion evaluator
// ────────────────────────────────────────────────────────────────────────────
const matchEmail = (email, kind) => {
  const subject = email.Subject || '';
  const body = email.TextBody || email.HtmlBody || '';
  // Heuristic kind-matching by subject/body patterns
  const kindPatterns = {
    preliminary_review_admin: /PRELIMINARY|prelim|action required/i,
    admin_discrepancy_notification: /discrepancy|conflict/i,
    broker_facing_collateral_ask: /collateral/i,
    broker_facing_lender_package: /package|lender|deal summary/i,
    broker_facing_intake_doc_ask: /missing|need|please send|please forward|outstanding/i,
    broker_facing_intake_acknowledgment: /received|got it|thank you/i,
    broker_facing_chase_email: /follow.{0,3}up|reminder|checking in|still waiting/i,
    broker_facing_clarification_response: /rate|AML|PEP|confirmation/i,
    broker_facing_intake_followup: /follow.{0,3}up|outstanding/i,
    broker_facing_aml_pep_request: /AML|PEP|anti-money|politically exposed/i,
    broker_facing_validation_error: /invalid|cannot.{0,10}process|please.{0,10}correct/i,
    broker_facing_out_of_scope_decline: /out of scope|Canadian|jurisdiction/i,
    broker_facing_disambiguation_request: /specific|exact|specify/i,
    admin_handoff_notification: /admin|handoff|paused/i,
    admin_handoff_draft_with_callout: /admin|elevated/i,
    admin_exception_review_notification: /exception|manual review/i,
    admin_construction_loan_notification: /construction|draw/i,
    admin_sanity_violation_notification: /sanity|exceeds|over.{0,10}100/i,
    preliminary_review_admin_draft_preview: /draft.{0,10}preview|PREVIEW/i,
    broker_facing_admin_handoff_draft: /admin/i,
    broker_facing_auto_response: /received|automated/i,
    broker_package_composer: /package|lender/i,
  };
  const pattern = kindPatterns[kind];
  return pattern ? pattern.test(subject + ' ' + body) : false;
};

const evalOutboundEmails = (expected, captured) => {
  const results = [];
  for (const emailSpec of expected.layer2_semantic?.outbound_emails || []) {
    const matching = (captured.outboundEmails || []).filter(e => matchEmail(e, emailSpec.kind));
    const fired = matching.length > 0;
    const result = {
      kind: emailSpec.kind,
      expected_fire: emailSpec.expected_fire,
      fired_actual: fired,
      match_count: matching.length,
      spec_rationale: emailSpec.rationale,
    };
    if (emailSpec.expected_fire === true && !fired) {
      result.status = 'fail';
      result.detail = 'expected to fire but no matching email';
    } else if (emailSpec.expected_fire === false && fired) {
      result.status = 'fail';
      result.detail = 'expected NOT to fire but matching email present';
    } else if (fired && (emailSpec.must_include || emailSpec.must_not_include)) {
      const includeResults = (emailSpec.must_include || []).map(inc => {
        const re = new RegExp(inc.pattern);
        const matched = matching.some(e => re.test((e.Subject || '') + ' ' + (e.HtmlBody || e.TextBody || '')));
        return { pattern: inc.pattern, matched, rationale: inc.rationale };
      });
      const excludeResults = (emailSpec.must_not_include || []).map(exc => {
        const re = new RegExp(exc.pattern);
        const matched = matching.some(e => re.test((e.Subject || '') + ' ' + (e.HtmlBody || e.TextBody || '')));
        return { pattern: exc.pattern, matched, rationale: exc.rationale };
      });
      const includeFails = includeResults.filter(r => !r.matched).length;
      const excludeFails = excludeResults.filter(r => r.matched).length;
      result.status = (includeFails + excludeFails === 0) ? 'pass' : 'fail';
      result.must_include_results = includeResults;
      result.must_not_include_results = excludeResults;
      result.detail = `include_fails=${includeFails} exclude_fails=${excludeFails}`;
    } else {
      result.status = 'pass';
      result.detail = 'fire-state matches expectation';
    }
    results.push(result);
  }
  return results;
};

// ────────────────────────────────────────────────────────────────────────────
// Layer 3 PLACEHOLDER handling
// ────────────────────────────────────────────────────────────────────────────
const evalLayer3 = (expected) => {
  const decisions = expected.layer3_pending_decisions || [];
  return decisions.map(d => ({
    reference: d.reference,
    scope: d.scope,
    phase5_placeholder: d.phase5_placeholder,
    carry_forward_candidate: d.carry_forward_candidate,
    satisfied: 'placeholder_assumed', // Phase 5 placeholder default applies; Phase 4.5 closure may revise
  }));
};

// ────────────────────────────────────────────────────────────────────────────
// Primary entry: evaluate captured state against expected.json spec
// ────────────────────────────────────────────────────────────────────────────
const evaluate = (capturedScenarioResult) => {
  const { expected, scenarioId, finalDealState, outboundEmails } = capturedScenarioResult;
  if (!expected) {
    return { scenarioId, status: 'error', errors: ['no expected.json found'] };
  }
  const captured = { finalDealState, outboundEmails };
  const layer1_canonical = evalCanonicalMap(expected, captured);
  const layer1_gates = evalGateStates(expected, captured);
  const layer1_workflow = evalWorkflowState(expected, captured);
  const layer2 = evalOutboundEmails(expected, captured);
  const layer3 = evalLayer3(expected);

  // Aggregate status
  const allChecks = [
    ...layer1_canonical.map(r => r.status),
    ...layer1_gates.map(r => r.status),
    layer1_workflow?.status,
    ...layer2.map(r => r.status),
  ].filter(Boolean);

  const hasFail = allChecks.includes('fail');
  const hasError = allChecks.includes('error');
  const hasArchAmendment = layer1_canonical.some(r => r.status === 'architecture_amendment_candidate');
  const hasUnknownGate = layer1_gates.some(r => r.status === 'inference_unknown');
  const hasPlaceholder = layer3.length > 0;

  let status;
  if (hasError) status = 'error';
  else if (hasFail) status = 'fail';
  else if (hasArchAmendment) status = 'architecture_amendment_surfaced';
  else if (hasPlaceholder) status = 'placeholder-pending';
  else if (hasUnknownGate) status = 'inference_unknown_present';
  else status = 'pass';

  return {
    scenarioId,
    status,
    architecture_amendment_candidate: hasArchAmendment,
    layer1_canonical,
    layer1_gates,
    layer1_workflow,
    layer2_outbound: layer2,
    layer3_pending: layer3,
    summary: {
      total_assertions: allChecks.length,
      pass_count: allChecks.filter(s => s === 'pass').length,
      fail_count: allChecks.filter(s => s === 'fail').length,
      skip_count: allChecks.filter(s => s === 'skip').length,
    },
  };
};

module.exports = {
  GATE_INFERENCE,
  evaluate,
  evalCanonicalMap,
  evalGateStates,
  evalWorkflowState,
  evalOutboundEmails,
  evalLayer3,
};
