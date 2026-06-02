#!/usr/bin/env node
// Offline verification of Fix 1 (Option C refinance carve-out + lender-mismatch
// flag) and Fix 2 (decline greeting body-parse) against Franco's REAL submission
// data (deal 5d1479ea) + regression cases. Runs the fixed engine functions on
// the actual extracted PDF text + email bodies — no deployment needed.
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const pdfParse = require('pdf-parse');
const { extractFormValues } = require('../src/lib/pdfFormExtract');
const { classifyDocument } = require('../src/services/deals').__test__;
const dEngine = require('../src/services/discrepancy-engine');
const ai = require('../src/services/ai');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const loadDeal = async (emailSub) => {
  const { data: deals } = await s.from('deals').select('id,email,created_at').ilike('email', `%${emailSub}%`).order('created_at', { ascending: false }).limit(1);
  return deals[0];
};
const loadDealById = async (idPfx) => {
  const { data } = await s.from('deals').select('id,email,created_at').order('created_at', { ascending: false }).limit(100);
  return (data || []).find(d => d.id.startsWith(idPfx));
};
const buildInputs = async (dealId) => {
  const { data: msgs } = await s.from('messages').select('body,subject').eq('deal_id', dealId).eq('direction', 'inbound').order('created_at').limit(1);
  const emailBody = (msgs[0].body || '').replace(/<[^>]+>/g, ' ');
  const emailSubject = msgs[0].subject || '';
  const { data: docrows } = await s.from('documents').select('file_name,storage_path').eq('deal_id', dealId);
  const docs = [];
  for (const d of docrows) {
    const { data: blob } = await s.storage.from('documents').download(d.storage_path);
    const buf = Buffer.from(await blob.arrayBuffer());
    let base = ''; try { const p = await pdfParse(buf); base = (p.text || '').trim(); } catch (e) {}
    let form = ''; try { form = await extractFormValues(buf); } catch (e) {}
    const text = (base + form).trim();
    docs.push({ file_name: d.file_name, classification: classifyDocument(d.file_name, text), text, extracted_data: { text } });
  }
  return { emailBody, emailSubject, docs };
};
const posTuples = (cm) => (cm.mortgage_position || []).map(t => `${t.value}[${t.classification || t.source}]`).join(', ');

const evalDeal = async (label, dealRef, byId = false) => {
  const deal = byId ? await loadDealById(dealRef) : await loadDeal(dealRef);
  const { emailBody, emailSubject, docs } = await buildInputs(deal.id);
  const r = dEngine.runDiscrepancyDetection(emailBody, docs, null, { emailSubject });
  const cm = r.canonical_map;
  const filtered = dEngine.filterCanonicalMortgagePositionForObjectiveAuthoritative(JSON.parse(JSON.stringify(cm)));
  const combined = dEngine.computeCombinedLtv(cm);
  const standalone = dEngine.computeStandaloneLtv(cm);
  const escalate = dEngine.shouldEscalateOnAnyLtv({ standaloneLtv: standalone, combinedLtv: combined ? combined.combined_ltv_percent : null });
  const decline = dEngine.shouldAutoDeclineOver90({ standaloneLtv: standalone, combinedLtv: combined ? combined.combined_ltv_percent : null, combinedResolved: dEngine.isCombinedLtvResolved(cm) });
  const mismatch = dEngine.computeExistingLenderRefinanceMismatch(cm);
  console.log(`\n══════ ${label}  (${deal.id.slice(0, 8)}) ══════`);
  console.log(`  standalone LTV: ${standalone}`);
  console.log(`  combined LTV: ${combined ? combined.combined_ltv_percent + ' (existing_source=' + combined.components.existing_source + ')' : 'null'}`);
  console.log(`  shouldEscalateOnAnyLtv: ${escalate}   shouldAutoDeclineOver90: ${decline.decline}`);
  console.log(`  mortgage_position (raw): ${posTuples(cm)}`);
  console.log(`  mortgage_position (objective-filtered): ${posTuples(filtered)}`);
  console.log(`  lender-mismatch flag: ${mismatch ? JSON.stringify(mismatch) : 'none'}`);
  if (mismatch) {
    const html = ai.injectExistingLenderMismatchCallout('<h2>Deal Snapshot</h2><p>rows</p>', mismatch);
    const m = html.match(/<strong>Existing-Mortgage Lender Discrepancy:[\s\S]*?<\/p>/);
    console.log(`  callout render: ${m ? m[0].replace(/<[^>]+>/g, '') : 'FAILED'}`);
  }
  return { standalone, combined, escalate, decline: decline.decline, filteredPos: posTuples(filtered), mismatch, emailBody };
};

(async () => {
  // ===== VERIFICATION 1: Franco's actual deal 5d1479ea =====
  const v1 = await evalDeal('VERIFY 1 — Franco 5d1479ea (the auto-declined deal)', '5d1479ea', true);
  console.log('\n  FIX 2 — decline greeting body-parse:');
  console.log(`    parseBrokerFirstName(body) = ${JSON.stringify(ai.parseBrokerFirstName(v1.emailBody))}  (expect "Victoria")`);

  // ===== REGRESSION 1: prior contaminated 5ca9d5fa =====
  await evalDeal('REGRESSION 1 — prior Marcus 5ca9d5fa (now: carve-out fires + flag)', '5ca9d5fa', true);

  // ===== REGRESSION 2: bulletproof refinance fixtures (A26 clean refi w/ mortgage_statement) =====
  console.log('\n══════ REGRESSION 2 — bulletproof refinance fixtures (offline, fixture docs) ══════');
  const path = require('path');
  const fs = require('fs');
  const evalFixture = async (dir, label) => {
    const fixDir = path.join(__dirname, '../test-fixtures/bulletproof/scenarios', dir);
    if (!fs.existsSync(fixDir)) { console.log(`  ${label}: (not found ${dir})`); return; }
    const events = require(path.join(fixDir, 'events.json'));
    const ev0 = events[0].postmark;
    const docs = [];
    for (const att of (ev0.Attachments || [])) {
      if (!att.documentRef) continue;
      const buf = fs.readFileSync(path.join(fixDir, att.documentRef));
      let base = ''; try { const p = await pdfParse(buf); base = (p.text || '').trim(); } catch (e) {}
      let form = ''; try { form = await extractFormValues(buf); } catch (e) {}
      const text = (base + form).trim();
      docs.push({ file_name: att.Name, classification: classifyDocument(att.Name, text), text, extracted_data: { text } });
    }
    const r = dEngine.runDiscrepancyDetection(ev0.TextBody, docs, null, { emailSubject: ev0.Subject });
    const combined = dEngine.computeCombinedLtv(r.canonical_map);
    const standalone = dEngine.computeStandaloneLtv(r.canonical_map);
    console.log(`  ${label}: standalone=${standalone} combined=${combined ? combined.combined_ltv_percent + '(' + combined.components.existing_source + ')' : 'null'}`);
  };
  await evalFixture('A26-mortgage-position-inferred-balance-lender-match', 'A26 (clean RBC refi + mortgage_statement)');
  await evalFixture('A14-property-value-appraisal-only', 'A14');

  // ===== REGRESSION 3: carve-out gating + payout-capability guard (direct computeCombinedLtv) =====
  console.log('\n══════ REGRESSION 3 — carve-out gating + payout guard (direct computeCombinedLtv) ══════');
  const mkMap = (requested, tt) => ({
    existing_first_mortgage_balance: [{ value: 318000, source: 'loan_application', classification: 'loan_application' }],
    requested_loan_amount: [{ value: requested, source: 'email_body' }],
    subject_property_market_value: [{ value: 680000, source: 'appraisal' }],
    transaction_type: tt,
  });
  const ADD = (req) => Math.round(((318000 + req) / 680000) * 100 * 10) / 10;
  const STD = (req) => Math.round((req / 680000) * 100 * 10) / 10;
  const cases = [
    { label: 'true 2nd — refinance tuple, refinanceConfident=false + payoutConfirmed=false ($100k)', req: 100000, tt: [{ value: 'refinance', payoutConfirmed: false, refinanceConfident: false, rawPhrase: 'second mortgage behind existing' }], expect: 'additive' },
    { label: 'true 2nd — transaction_type=2nd_mortgage ($100k)', req: 100000, tt: [{ value: '2nd_mortgage' }], expect: 'additive' },
    { label: 'GUARD — confident refinance but new<existing ($100k<$318k) → additive (NOT carve-out)', req: 100000, tt: [{ value: 'refinance', payoutConfirmed: false, refinanceConfident: true, rawPhrase: 'refinancing existing RBC' }], expect: 'additive' },
    { label: 'confident refinance + payout-capable ($408k>=$318k) → carve-out fires (standalone)', req: 408000, tt: [{ value: 'refinance', payoutConfirmed: false, refinanceConfident: true, rawPhrase: 'refinancing existing RBC' }], expect: 'standalone' },
    { label: 'payout-confirmed refinance + payout-capable ($408k) → carve-out fires (standalone)', req: 408000, tt: [{ value: 'refinance', payoutConfirmed: true, refinanceConfident: false, rawPhrase: 'paying out existing' }], expect: 'standalone' },
  ];
  for (const c of cases) {
    const r = dEngine.computeCombinedLtv(mkMap(c.req, c.tt));
    const val = r ? r.combined_ltv_percent : null;
    const isAdditive = val === ADD(c.req);
    const isStandalone = val === STD(c.req);
    const pass = c.expect === 'additive' ? isAdditive : isStandalone;
    console.log(`  ${pass ? 'PASS' : 'FAIL'} — ${c.label}`);
    console.log(`        combined=${val} (${isAdditive ? 'ADDITIVE' : isStandalone ? 'STANDALONE-carveout' : '?'}); expected ${c.expect.toUpperCase()} ${c.expect === 'additive' ? ADD(c.req) : STD(c.req)}`);
  }
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
