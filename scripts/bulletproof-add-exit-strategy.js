#!/usr/bin/env node
// CLUSTER-1 bundle (Sub-phase 6): insert a NEUTRAL exit_strategy line into the
// intake (event[0]) broker email so Vienna's prelim/lead-summary fires and the
// Deal Snapshot render surface is exposed for canonical-field verification.
//
// Neutrality discipline (Q-6.1-3 refinement): exit_strategy text contains NO
// lender names, NO dollar amounts, NO property addresses, NO canonical-field-
// like tokens — so it cannot perturb canonical-field extraction (the F1 test
// target).
//
// Usage: node scripts/bulletproof-add-exit-strategy.js <id1,id2,...|--all-canonical>

const fs = require('fs');
const path = require('path');
const SC = path.join(__dirname, '..', 'test-fixtures', 'bulletproof', 'scenarios');

const EXIT_LINE = 'Exit strategy: borrower intends to sell the property at end of term.';

const arg = process.argv[2] || '';
let ids;
if (arg === '--all-canonical') {
  // Scenarios whose expected.json references a render-surface canonical field
  const RS = ['requested_loan_amount', 'property_value', 'mortgage_position', 'subject_property_address', 'property_address', 'ltv_percent'];
  ids = fs.readdirSync(SC).filter(d => /^[A-F]\d/.test(d)).filter(d => {
    const ep = path.join(SC, d, 'expected.json');
    if (!fs.existsSync(ep)) return false;
    try {
      const e = JSON.parse(fs.readFileSync(ep, 'utf8'));
      const cm = e.layer1_structural?.canonical_map || {};
      return Object.keys(cm).some(k => RS.includes(k));
    } catch { return false; }
  });
} else {
  ids = arg.split(',').map(s => s.trim()).filter(Boolean);
}

let modified = 0, skipped = 0;
const report = [];
for (const id of ids) {
  const dir = fs.readdirSync(SC).find(d => d === id || d.startsWith(id + '-'));
  if (!dir) { report.push(`${id}: NOT FOUND`); continue; }
  const ep = path.join(SC, dir, 'events.json');
  const ev = JSON.parse(fs.readFileSync(ep, 'utf8'));
  const body = ev[0].postmark.TextBody || '';
  if (/exit strategy/i.test(body)) { skipped++; report.push(`${dir}: already has exit_strategy — skipped`); continue; }
  // Insert before the signature block (first "\n\nJonathan Ferrara" or "\n\n<Name>")
  let newBody;
  const sigIdx = body.indexOf('\n\nJonathan Ferrara');
  if (sigIdx >= 0) {
    newBody = body.slice(0, sigIdx) + `\n\n${EXIT_LINE}` + body.slice(sigIdx);
  } else {
    // No recognized signature — append at end
    newBody = body + `\n\n${EXIT_LINE}`;
  }
  ev[0].postmark.TextBody = newBody;
  fs.writeFileSync(ep, JSON.stringify(ev, null, 2) + '\n');
  modified++;
  report.push(`${dir}: exit_strategy inserted`);
}
console.log(`[add-exit-strategy] modified=${modified} skipped=${skipped} of ${ids.length}`);
report.forEach(r => console.log(`  ${r}`));
