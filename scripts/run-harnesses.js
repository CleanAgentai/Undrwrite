#!/usr/bin/env node
// Runs every scripts/*harness*.js (or the files given as args) with a per-file
// timeout and prints one line per harness: exit code, duration, last pass/fail line.
// Usage: node scripts/run-harnesses.js [--out report.txt] [file ...]
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TIMEOUT_MS = 240000;
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? args.splice(outIdx, 2)[1] : null;
const files = args.length
  ? args
  : fs.readdirSync(__dirname).filter(f => /harness.*\.js$/.test(f) && f !== path.basename(__filename)).sort().map(f => path.join('scripts', f));

const lines = [];
let failed = 0;
for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [f], { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  const rc = r.error ? (r.error.code === 'ETIMEDOUT' ? 'TIMEOUT' : r.error.code) : r.status;
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const summary = (out.split('\n').filter(l => /pass|fail|error/i.test(l)).pop() || '').trim().slice(0, 140);
  if (rc !== 0) failed++;
  const line = `rc=${rc} ${Math.round((Date.now() - t0) / 1000)}s ${f} :: ${summary}`;
  lines.push(line);
  console.log(line);
}
const tally = `\n${files.length - failed}/${files.length} exited 0`;
console.log(tally);
if (outFile) fs.writeFileSync(outFile, lines.join('\n') + tally + '\n');
process.exit(failed ? 1 : 0);
