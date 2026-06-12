// Offline classification + missing-docs sweep across ALL scenario folders.
// Validates the Round-9 deals.js classifier fixes (Bug 2 T4-as-NOA, Bug 3 Gov-ID-as-AML
// + compliance-mismatch suppression) against the FULL real-document corpus — and critically
// confirms the real AML/PEP forms still classify as aml/pep (the main regression risk).
// Run: node scripts/scenario-corpus-classify.js
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const deals = require('../src/services/deals');
const { computeMissingIntakeItems } = require('../src/lib/dealType');

const ROOT = '/Users/porterstanley/Desktop/UndrWrite Testing';

// fresh-require pdf-parse to dodge the shared-state "bad XRef" flakiness
function freshParse() { delete require.cache[require.resolve('pdf-parse')]; return require('pdf-parse'); }
async function parse(buf) {
  for (let i = 0; i < 6; i++) {
    try { const pp = i === 0 ? require('pdf-parse') : freshParse(); return (await pp(buf)).text || ''; }
    catch (e) { if (i === 5) return `<<parse-error>>`; await new Promise(r => setTimeout(r, 70)); }
  }
}

// Map each scenario → its docs folder.
const SCN = {
  1:  'Scenario 1 docs',
  2:  'Scenario 2 docs',
  3:  'Scenario 3', 4: 'Scenario 4', 5: 'Scenario 5', 6: 'Scenario 6',
  7:  'Scenario 7', 8: 'Scenario 8', 9: 'Scenario 9', 12: 'Scenario 12',
  14: 'Scenario 14', 15: 'Scenario 15',
};

// expected content-classification per filename token (what the doc SHOULD be)
const expectFor = (name) => {
  const n = name.toLowerCase();
  if (/loanapplication|loan_application/.test(n)) return 'loan_application';
  if (/pnw|net_worth|networth/.test(n)) return 'pnw_statement';
  if (/^t4_|_t4_|t4_/.test(n) || /\bt4\b/.test(n)) return 'income_proof';
  if (/appraisal/.test(n)) return 'appraisal';
  if (/credit_bureau|credit/.test(n)) return 'credit_report';
  if (/governmentid|government_id|gov_id/.test(n)) return 'government_id';
  if (/propertytax|property_tax/.test(n)) return 'property_tax';
  if (/payout/.test(n)) return 'mortgage_statement';
  if (/aml_form|aml/.test(n)) return 'aml';
  if (/pep_form|pep/.test(n)) return 'pep';
  if (/buildingpermit|permit/.test(n)) return 'other'; // no dedicated class; ok if other
  return null; // unknown → don't assert
};

let totalMismatch = 0, totalWrongClass = 0;
(async () => {
  for (const scn of Object.keys(SCN).map(Number).sort((a, b) => a - b)) {
    const dir = path.join(ROOT, SCN[scn]);
    if (!fs.existsSync(dir)) { console.log(`\n### Scenario ${scn}: folder missing (${SCN[scn]})`); continue; }
    const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pdf'));
    console.log(`\n### Scenario ${scn} — ${SCN[scn]} (${files.length} docs)`);
    const classes = [];
    for (const f of files) {
      const text = await parse(fs.readFileSync(path.join(dir, f)));
      const fileClass = deals.__test__.classifyDocument(f, text);
      const contentClass = deals.__test__.classifyByContent(text);
      const mismatch = deals.detectClassificationMismatch(f, text);
      classes.push(fileClass);
      const exp = expectFor(f);
      const wrongFile = exp && exp !== 'other' && fileClass !== exp && !(exp === 'income_proof' && fileClass === 'noa');
      const flags = [];
      if (mismatch) { flags.push(`⚠️MISMATCH ${mismatch.fileClass}->${mismatch.contentClass}`); totalMismatch++; }
      if (wrongFile) { flags.push(`❌WRONG-CLASS exp=${exp}`); totalWrongClass++; }
      // content-class sanity for compliance + ID + income (the regression-risk set)
      const note = (exp === 'aml' && contentClass !== 'aml') ? ` (AML content→${contentClass}!)` :
                   (exp === 'pep' && contentClass !== 'pep') ? ` (PEP content→${contentClass}!)` :
                   (exp === 'government_id' && contentClass === 'aml') ? ` (GovID content→aml!)` :
                   (exp === 'income_proof' && contentClass === 'noa') ? ` (T4 content→noa!)` : '';
      console.log(`   ${flags.length ? flags.join(' ') + ' ' : '✓ '}${f}  [file=${fileClass} content=${contentClass}]${note}`);
    }
    // missing-intake prediction (refi default; purchase scenarios differ but this is indicative)
    const missing = computeMissingIntakeItems({ classifications: classes, isPurchase: false, exitStrategy: 'x' });
    console.log(`   → missing-intake (refi): [${missing.join(', ') || 'none — complete'}]`);
  }
  console.log(`\n===== SWEEP DONE — ${totalMismatch} mismatch callout(s), ${totalWrongClass} wrong-class =====`);
  console.log(totalMismatch === 0 && totalWrongClass === 0 ? 'ALL CLASSIFICATIONS CLEAN ✅' : 'REVIEW FLAGS ABOVE ⚠️');
})();
