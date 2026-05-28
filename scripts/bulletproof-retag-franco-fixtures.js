#!/usr/bin/env node
// Mini-triage Finding #1 fix: re-tag Franco-as-sender bulletproof fixtures to
// use Jonathan Ferrara broker identity. Reason: Vienna's R9-F intake classifier
// rejects emails where FromName first-token === ADMIN_FIRST_NAME ("Franco")
// without broker_name context. Spec author error — Franco is the admin, not a
// broker. Mechanical re-tag, additive (no spec semantics change).

const fs = require('fs');
const path = require('path');

const SCENARIOS_DIR = path.join(__dirname, '..', 'test-fixtures', 'bulletproof', 'scenarios');

const FRANCO_SIGNATURE = 'Franco Maione\\nLENDING & INVESTMENT SPECIALIST\\n102, 10446 122 Street NW\\nEdmonton, AB, T5N 1M3\\nOFFICE.  780-244-4769\\nCELL.  780-975-3339\\nEMAIL.  fmaione@unionfinancialcorp.com';
const JONATHAN_SIGNATURE = 'Jonathan Ferrara\\nFerrara Financial\\nLic. #M16002271';

const REPLACEMENTS = [
  { from: FRANCO_SIGNATURE, to: JONATHAN_SIGNATURE, label: 'body-signature' },
  { from: '"FromName": "Franco Maione"', to: '"FromName": "Jonathan Ferrara"', label: 'FromName' },
  { from: '"From": "fmaione@unionfinancialcorp.com"', to: '"From": "jferrara@ferrarafinancial.example.com"', label: 'From' },
];

const subdirs = fs.readdirSync(SCENARIOS_DIR).filter(d => /^[A-F]\d/.test(d));
let totalFiles = 0;
let totalReplacements = 0;
const perFile = [];

for (const dir of subdirs) {
  const eventsPath = path.join(SCENARIOS_DIR, dir, 'events.json');
  if (!fs.existsSync(eventsPath)) continue;
  let content = fs.readFileSync(eventsPath, 'utf8');
  const original = content;
  const counts = {};
  for (const { from, to, label } of REPLACEMENTS) {
    const parts = content.split(from);
    const n = parts.length - 1;
    if (n > 0) {
      content = parts.join(to);
      counts[label] = n;
      totalReplacements += n;
    }
  }
  if (content !== original) {
    fs.writeFileSync(eventsPath, content);
    totalFiles++;
    perFile.push({ dir, counts });
  }
}

console.log(`[retag] ${totalFiles} fixtures modified, ${totalReplacements} total replacements`);
for (const { dir, counts } of perFile) {
  console.log(`  ${dir}: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
}

// Verify no residual Franco-as-sender refs
console.log('\n[retag] verification scan...');
let residual = 0;
for (const dir of subdirs) {
  const eventsPath = path.join(SCENARIOS_DIR, dir, 'events.json');
  if (!fs.existsSync(eventsPath)) continue;
  const content = fs.readFileSync(eventsPath, 'utf8');
  if (content.includes('"FromName": "Franco Maione"') || content.includes('"From": "fmaione@unionfinancialcorp.com"')) {
    console.warn(`  RESIDUAL in ${dir}`);
    residual++;
  }
}
if (residual === 0) console.log('  clean — no residual Franco-as-sender refs');
process.exit(residual === 0 ? 0 : 1);
