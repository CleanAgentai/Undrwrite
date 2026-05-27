#!/usr/bin/env node
// End-of-batch verification: walks every scenarios/{ID}/ directory and validates:
//   1. scenario.json parses + has required fields
//   2. events.json parses + is non-empty temporal array
//   3. Every Postmark payload has required fields
//   4. Every documentRef resolves to a real PDF on disk
//   5. Every resolved PDF is pdf-parse-extractable
//
// Run: node test-fixtures/bulletproof/verify-batch.js

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { resolveAttachmentRefs } = require('./lib/emailSynth');

const SCENARIOS_DIR = path.join(__dirname, 'scenarios');
const REQUIRED_SCENARIO_FIELDS = ['id', 'name', 'group', 'dimensions', 'families', 'bugHint', 'anchor', 'rationale'];
const REQUIRED_POSTMARK_FIELDS = ['From', 'FromName', 'To', 'Subject', 'TextBody', 'MessageID', 'Date', 'Attachments'];

const fails = [];
const summary = { scenarios: 0, events: 0, documents: 0, totalPdfBytes: 0 };

(async () => {
  const scenarioDirs = fs.readdirSync(SCENARIOS_DIR)
    .filter(d => fs.statSync(path.join(SCENARIOS_DIR, d)).isDirectory())
    .sort();

  for (const dir of scenarioDirs) {
    const fullDir = path.join(SCENARIOS_DIR, dir);
    const scenarioPath = path.join(fullDir, 'scenario.json');
    const eventsPath = path.join(fullDir, 'events.json');

    if (!fs.existsSync(scenarioPath)) { fails.push(`${dir}: missing scenario.json`); continue; }
    if (!fs.existsSync(eventsPath)) { fails.push(`${dir}: missing events.json`); continue; }

    let scenario, events;
    try { scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')); }
    catch (e) { fails.push(`${dir}: scenario.json invalid JSON: ${e.message}`); continue; }
    try { events = JSON.parse(fs.readFileSync(eventsPath, 'utf8')); }
    catch (e) { fails.push(`${dir}: events.json invalid JSON: ${e.message}`); continue; }

    for (const f of REQUIRED_SCENARIO_FIELDS) {
      if (!(f in scenario)) fails.push(`${dir}: scenario.json missing field ${f}`);
    }
    if (!Array.isArray(events) || events.length === 0) {
      fails.push(`${dir}: events.json must be non-empty array`);
      continue;
    }

    summary.scenarios++;
    summary.events += events.length;

    for (const ev of events) {
      if (!ev.postmark) { fails.push(`${dir}: event ${ev.sequenceIndex} missing postmark`); continue; }
      for (const f of REQUIRED_POSTMARK_FIELDS) {
        if (!(f in ev.postmark)) fails.push(`${dir}: event ${ev.sequenceIndex} postmark missing ${f}`);
      }

      const resolved = resolveAttachmentRefs(ev.postmark, fullDir);
      for (const att of resolved.Attachments) {
        summary.documents++;
        if (!att.Content || typeof att.Content !== 'string') {
          fails.push(`${dir}: event ${ev.sequenceIndex} attachment ${att.Name} not base64-resolved`);
          continue;
        }
        const buf = Buffer.from(att.Content, 'base64');
        summary.totalPdfBytes += buf.length;
        try {
          const parsed = await pdfParse(buf);
          if (!parsed.text || parsed.text.trim().length === 0) {
            fails.push(`${dir}: event ${ev.sequenceIndex} attachment ${att.Name} pdf-parse returned empty text`);
          }
        } catch (e) {
          fails.push(`${dir}: event ${ev.sequenceIndex} attachment ${att.Name} pdf-parse failed: ${e.message}`);
        }
      }
    }
  }

  console.log('--- VERIFY-BATCH SUMMARY ---');
  console.log(`Scenarios:    ${summary.scenarios}`);
  console.log(`Events:       ${summary.events}`);
  console.log(`Documents:    ${summary.documents}`);
  console.log(`Total PDF MB: ${(summary.totalPdfBytes / 1024 / 1024).toFixed(2)}`);
  console.log(`Failures:     ${fails.length}`);
  if (fails.length > 0) {
    console.log('\n--- FAILURES ---');
    for (const f of fails) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('\n✓ ALL FIXTURES VALIDATED');
})().catch(e => { console.error('VERIFY-BATCH ABORTED:', e); process.exit(2); });
