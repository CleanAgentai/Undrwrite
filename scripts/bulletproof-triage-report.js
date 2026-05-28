#!/usr/bin/env node
// Aggregate bulletproof-replay-batch results into a triage markdown report.
//
// Usage:
//   node scripts/bulletproof-triage-report.js <results.json> [--output triage-report.md]
//
// Output sections:
//   1. Executive Summary
//   2. By Group (A/B/C/D/E/F pass rates)
//   3. By Severity (acceptance-blocking / correctness / cosmetic)
//   4. By Architectural Family (F1-F4 bug distribution)
//   5. Architecture-Amendment Candidates Surfaced
//   6. Layer 3 Placeholder-Pending Scenarios
//   7. Phase 6 Fix-Cycle Recommended Ordering

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const resultsPath = args.find(a => !a.startsWith('--'));
const outputIdx = args.indexOf('--output');
const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : null;
if (!resultsPath) {
  console.error('Usage: bulletproof-triage-report.js <results.json> [--output triage-report.md]');
  process.exit(2);
}

const { summary, results } = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));

// Helper: classify severity per architectural risk #4
const classifySeverity = (result) => {
  if (result.status === 'pass' || result.status === 'placeholder-pending') return 'n/a';
  // acceptance-blocking: Layer 1 canonical_map mismatch on broker-source values OR Layer 2 must_not_include violation (fabrication)
  const canonicalFails = (result.layer1_canonical || []).filter(r => r.status === 'fail');
  const brokerSourceFails = canonicalFails.filter(r => (r.spec_rationale || '').match(/broker_correction|broker_initial_intent/));
  const fabViolations = (result.layer2_outbound || []).filter(o => (o.must_not_include_results || []).some(r => r.matched));
  if (brokerSourceFails.length > 0 || fabViolations.length > 0) return 'acceptance-blocking';
  // correctness: Layer 1 gate/workflow mismatch + Layer 2 must_include miss
  const gateFails = (result.layer1_gates || []).filter(r => r.status === 'fail');
  const workflowFail = result.layer1_workflow?.status === 'fail';
  const includeMissing = (result.layer2_outbound || []).some(o => (o.must_include_results || []).some(r => !r.matched));
  if (gateFails.length > 0 || workflowFail || includeMissing) return 'correctness';
  return 'cosmetic';
};

const groupOf = (scenarioId) => (scenarioId || '').match(/^[A-F]/)?.[0] || '?';

// Group bucketing
const byGroup = {};
const bySeverity = { 'acceptance-blocking': [], correctness: [], cosmetic: [], 'n/a': [] };
const archAmendmentCandidates = [];
const placeholderPending = [];
for (const r of results) {
  const g = groupOf(r.scenarioId);
  if (!byGroup[g]) byGroup[g] = { pass: 0, fail: 0, error: 0, placeholder: 0, arch_amend: 0, total: 0 };
  byGroup[g].total++;
  const sev = classifySeverity(r);
  bySeverity[sev].push(r);
  if (r.status === 'pass') byGroup[g].pass++;
  else if (r.status === 'fail') byGroup[g].fail++;
  else if (r.status === 'error') byGroup[g].error++;
  else if (r.status === 'placeholder-pending') { byGroup[g].placeholder++; placeholderPending.push(r); }
  else if (r.status === 'architecture_amendment_surfaced') { byGroup[g].arch_amend++; archAmendmentCandidates.push(r); }
  if (r.architecture_amendment_candidate && !archAmendmentCandidates.includes(r)) archAmendmentCandidates.push(r);
}

// Architectural family attribution (rough heuristic: parse spec_rationale for F1/F2/F3/F4 anchors)
const familyAttribution = { F1: 0, F2: 0, F3: 0, F4: 0, other: 0 };
for (const r of results.filter(x => x.status === 'fail')) {
  const allRationales = [
    ...(r.layer1_canonical || []).map(x => x.spec_rationale || ''),
    ...(r.layer1_gates || []).map(x => x.spec_rationale || ''),
    ...(r.layer2_outbound || []).flatMap(x => [x.spec_rationale || '', ...(x.must_include_results || []).map(p => p.rationale), ...(x.must_not_include_results || []).map(p => p.rationale)]),
  ].join(' ');
  if (/F1\./.test(allRationales)) familyAttribution.F1++;
  else if (/F2\./.test(allRationales)) familyAttribution.F2++;
  else if (/F3\./.test(allRationales)) familyAttribution.F3++;
  else if (/F4\./.test(allRationales)) familyAttribution.F4++;
  else familyAttribution.other++;
}

// Phase 6 fix-cycle ordering: acceptance-blocking → correctness → cosmetic; within each, by family
const phase6Order = [
  ...bySeverity['acceptance-blocking'],
  ...bySeverity.correctness,
  ...bySeverity.cosmetic,
];

// Build markdown
const lines = [];
const ts = new Date().toISOString();
lines.push(`# Bulletproof Matrix Triage Report`);
lines.push(``);
lines.push(`Generated: ${ts}`);
lines.push(`Source: ${path.basename(resultsPath)}`);
lines.push(``);
lines.push(`## 1. Executive Summary`);
lines.push(``);
lines.push(`| Metric | Value |`);
lines.push(`|---|---|`);
lines.push(`| Total scenarios | ${summary.total} |`);
for (const [status, count] of Object.entries(summary.by_status || {})) {
  lines.push(`| ${status} | ${count} |`);
}
lines.push(`| Architecture-amendment-candidates | ${archAmendmentCandidates.length} |`);
lines.push(`| Placeholder-pending | ${placeholderPending.length} |`);
lines.push(`| Cumulative budget estimate | $${(summary.cumulative_budget_estimate || 0).toFixed(2)} |`);
lines.push(``);

lines.push(`## 2. By Group`);
lines.push(``);
lines.push(`| Group | Total | Pass | Fail | Error | Placeholder | Arch-Amend |`);
lines.push(`|---|---|---|---|---|---|---|`);
for (const [g, c] of Object.entries(byGroup).sort()) {
  lines.push(`| ${g} | ${c.total} | ${c.pass} | ${c.fail} | ${c.error} | ${c.placeholder} | ${c.arch_amend} |`);
}
lines.push(``);

lines.push(`## 3. By Severity`);
lines.push(``);
lines.push(`Per architectural risk #4 — architecture-amendment-candidates separated from bug-fixes.`);
lines.push(``);
for (const sev of ['acceptance-blocking', 'correctness', 'cosmetic']) {
  if (bySeverity[sev].length === 0) continue;
  lines.push(`### ${sev.toUpperCase()} (${bySeverity[sev].length} scenarios)`);
  lines.push(``);
  for (const r of bySeverity[sev]) {
    const tag = r.architecture_amendment_candidate ? ' [arch-amendment-candidate]' : '';
    lines.push(`- **${r.scenarioId}**${tag}: ${r.summary?.fail_count || 0} fail / ${r.summary?.total_assertions || 0} total`);
  }
  lines.push(``);
}

lines.push(`## 4. Architectural Family Attribution (failure distribution)`);
lines.push(``);
for (const [family, count] of Object.entries(familyAttribution)) {
  lines.push(`- ${family}: ${count} failures attributed`);
}
lines.push(``);

lines.push(`## 5. Architecture-Amendment Candidates Surfaced`);
lines.push(``);
lines.push(`Per Q-R3 two-factor detection (no Vienna mapping AND no gate-inference entry). Different Phase 6 treatment: requires Phase 1 matrix amendment before fix-cycle.`);
lines.push(``);
if (archAmendmentCandidates.length === 0) lines.push(`(none surfaced in this run)`);
for (const r of archAmendmentCandidates) {
  lines.push(`- **${r.scenarioId}**`);
  const archFields = (r.layer1_canonical || []).filter(c => c.status === 'architecture_amendment_candidate');
  for (const af of archFields) {
    lines.push(`  - Field \`${af.field}\`: ${af.normalization_rationale}`);
  }
}
lines.push(``);

lines.push(`## 6. Layer 3 Placeholder-Pending Scenarios`);
lines.push(``);
lines.push(`Rerun after Phase 4.5 decisions land (${placeholderPending.length} scenarios).`);
lines.push(``);
for (const r of placeholderPending) {
  lines.push(`- **${r.scenarioId}**: ${(r.layer3_pending || []).map(p => p.reference).join(', ')}`);
}
lines.push(``);

lines.push(`## 7. Phase 6 Fix-Cycle Recommended Ordering`);
lines.push(``);
lines.push(`Priority: acceptance-blocking → correctness → cosmetic. Within each, F-family attribution and architecture-amendment-candidates flagged.`);
lines.push(``);
for (let i = 0; i < phase6Order.length; i++) {
  const r = phase6Order[i];
  const sev = classifySeverity(r);
  const tag = r.architecture_amendment_candidate ? ' [ARCH-AMENDMENT]' : '';
  lines.push(`${i + 1}. **${r.scenarioId}** (${sev})${tag} — ${r.summary?.fail_count || 0} failures`);
}
lines.push(``);

const md = lines.join('\n');
if (outputPath) {
  fs.writeFileSync(outputPath, md);
  console.log(`triage report written to ${outputPath}`);
} else {
  process.stdout.write(md);
}
