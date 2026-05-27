// R10-I mini-harness — formatted lender package at sendCompletionHandoff
// close-out. Closes Bug 6-? + 7-6 (Franco R10 Scenarios 6+7) + R10 round
// 9/9 closure + contract MVP-complete acceptance gate readiness per
// Section 4.2b/5.2.
//
// 6 verification groups:
//  (1) COMPOSER-HELPER-MATRIX        — composeBrokerLenderPackageEmail
//                                       function shape + defensive fallbacks
//  (2) COMPOSER-CONTENT-SCOPE        — lead-in / Snapshot insert / attachment
//                                       line / Franco-pointer / signoff;
//                                       no doc-list shape; no Risk Factors;
//                                       no internal-workflow leak language
//  (3) WIRING-AT-COMPLETION-HANDOFF  — composer invoked; _r9gPackageAttachments
//                                       wired to broker email; admin info-notice
//                                       text updated; R6-λ + LLLL preserved
//  (4) ETHAN-LOAD-BEARING (Stage 1.5) — Ethan c95f3a20 production-fixture replay
//  (5) KEVIN-DEFENSIVE (Stage 1.5)    — Kevin Tran 30d1e798 parallel fixture
//  (6) CROSS-CLUSTER-INTEGRATION      — R9-G + R9-A + R6-λ + LLLL + all R10
//                                       cluster work preserved

require('dotenv').config();

process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'sk-test-dummy';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';
process.env.POSTMARK_API_TOKEN = process.env.POSTMARK_API_TOKEN || 'dummy';
process.env.POSTMARK_SENDER_EMAIL = process.env.POSTMARK_SENDER_EMAIL || 'vienna@example.com';
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'franco@privatemortgagelink.com';

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const ai = require('../src/services/ai');
const dEngine = require('../src/services/discrepancy-engine');

(async () => {
  console.log('========== R10-I mini-harness — broker lender-package at completion-handoff ==========');

  const _aiSrc = fs.readFileSync(path.join(__dirname, '../src/services/ai.js'), 'utf8');
  const _whSrc = fs.readFileSync(path.join(__dirname, '../src/routes/webhook.js'), 'utf8');

  let passCount = 0;
  let failCount = 0;
  const expect = (label, cond, detail) => {
    if (cond) { console.log(`  PASS ${label}`); passCount++; }
    else { console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); failCount++; throw new Error(`FAIL [${label}]${detail ? ' — ' + detail : ''}`); }
  };

  // ─── R10-I-COMPOSER-HELPER-MATRIX ───
  console.log('\n--- R10-I-COMPOSER-HELPER-MATRIX ---');
  expect('(a) composeBrokerLenderPackageEmail function exported on ai module',
    typeof ai.composeBrokerLenderPackageEmail === 'function');
  const fullOut = ai.composeBrokerLenderPackageEmail({
    borrowerName: 'Test Borrower',
    brokerGreetingName: 'Alice',
    snapshotHtml: '<h2>Deal Snapshot</h2><p><strong>Property:</strong> X</p>',
    packageAttached: true,
    borrowerSafeName: 'Test_Borrower',
  });
  expect('(b) full-input composer produces HTML with all 5 sections (greeting / lead-in / snapshot / attachment / signoff)',
    /<p>Hi Alice,<\/p>/.test(fullOut)
      && /file is complete/.test(fullOut)
      && /<h2>Deal Snapshot<\/h2>/.test(fullOut)
      && /Test_Borrower_Complete_Documents\.zip/.test(fullOut)
      && /<p>Vienna<br>/.test(fullOut));
  // Defensive: null brokerGreetingName → "Hi there,"
  const nullGreetingOut = ai.composeBrokerLenderPackageEmail({
    borrowerName: 'X',
    brokerGreetingName: null,
    snapshotHtml: '<h2>Deal Snapshot</h2>',
    packageAttached: true,
    borrowerSafeName: 'X',
  });
  expect('(c) null brokerGreetingName → "Hi there," fallback (anti-collision discipline)',
    /<p>Hi there,<\/p>/.test(nullGreetingOut));
  // Defensive: packageAttached=false → attachment-mention line omitted
  const noAttachOut = ai.composeBrokerLenderPackageEmail({
    borrowerName: 'X',
    brokerGreetingName: 'Alice',
    snapshotHtml: '<h2>Deal Snapshot</h2>',
    packageAttached: false,
    borrowerSafeName: 'X',
  });
  expect('(d) packageAttached=false → attachment-mention line omitted (R9-G zip-build-failure UX)',
    !/Complete_Documents\.zip/.test(noAttachOut));
  expect('(e) composer is pure (deterministic; same inputs → same output)',
    ai.composeBrokerLenderPackageEmail({
      borrowerName: 'X', brokerGreetingName: 'A', snapshotHtml: '<p>x</p>', packageAttached: true, borrowerSafeName: 'X'
    }) === ai.composeBrokerLenderPackageEmail({
      borrowerName: 'X', brokerGreetingName: 'A', snapshotHtml: '<p>x</p>', packageAttached: true, borrowerSafeName: 'X'
    }));
  expect('(f) composer is JS-deterministic (no Claude call — synchronous return)',
    typeof ai.composeBrokerLenderPackageEmail({ borrowerName: 'X', brokerGreetingName: 'A', snapshotHtml: '<p>x</p>', packageAttached: true, borrowerSafeName: 'X' }) === 'string');

  // ─── R10-I-COMPOSER-CONTENT-SCOPE ───
  console.log('\n--- R10-I-COMPOSER-CONTENT-SCOPE ---');
  const scopedOut = ai.composeBrokerLenderPackageEmail({
    borrowerName: 'Ethan James Broussard',
    brokerGreetingName: 'Harpreet',
    snapshotHtml: '<h2>Deal Snapshot</h2><p><strong>Property Address:</strong> 819 strathmore drive sw</p><p><strong>Combined LTV (incl. existing 1st):</strong> 59.8%</p>',
    packageAttached: true,
    borrowerSafeName: 'Ethan_James_Broussard',
  });
  expect('(a) lead-in mentions "deal summary" + "lender outreach"',
    /deal summary/i.test(scopedOut) && /lender outreach/i.test(scopedOut));
  expect('(b) Snapshot HTML inserted between lead-in + attachment-mention',
    (() => {
      const leadIdx = scopedOut.indexOf('lender outreach');
      const snapIdx = scopedOut.indexOf('<h2>Deal Snapshot</h2>');
      const attIdx = scopedOut.indexOf('Complete_Documents.zip');
      return leadIdx > 0 && snapIdx > leadIdx && attIdx > snapIdx;
    })());
  expect('(c) attachment-mention names the zip file with correct safe-name pattern',
    /Ethan_James_Broussard_Complete_Documents\.zip/.test(scopedOut));
  expect('(d) Franco-pointer matches existing generateCompletionEmail exit-pattern',
    /contact Franco at franco@privatemortgagelink\.com/i.test(scopedOut));
  expect('(e) Vienna / Private Mortgage Link signoff matches existing convention',
    /<p>Vienna<br>\s*\nPrivate Mortgage Link<\/p>/i.test(scopedOut));
  expect('(f) NO doc-list-shape leak (R10-C generator-bypass discipline)',
    !/<ul>/.test(scopedOut) && !/exit strategy|payout statement|government-?issued ID|property tax assessment/i.test(scopedOut));
  expect('(g) NO Risk Factors section (broker-sanitized — admin-only content excluded)',
    !/Risk Factors/i.test(scopedOut));
  expect('(h) NO internal-workflow leak language (R5-C / R10-H carve-out compliance)',
    !/our review process|the review process|I'?ll be in touch shortly with an update|once we'?ve had a chance to review|the file is currently being reviewed/i.test(scopedOut));

  // ─── R10-I-WIRING-AT-COMPLETION-HANDOFF ───
  console.log('\n--- R10-I-WIRING-AT-COMPLETION-HANDOFF ---');
  expect('(a) sendCompletionHandoff invokes composeBrokerLenderPackageEmail',
    /aiService\.composeBrokerLenderPackageEmail\(\{/.test(_whSrc));
  expect('(b) broker emailService.sendEmail receives _r9gPackageAttachments (not [])',
    (() => {
      // Locate the broker send-email block in sendCompletionHandoff
      const ch = _whSrc.indexOf('const brokerSendResult = await emailService.sendEmail');
      if (ch === -1) return false;
      const block = _whSrc.slice(ch, ch + 800);
      return /_r9gPackageAttachments/.test(block);
    })());
  expect('(c) admin info-notice text reflects broker now has the package',
    /lender-package closing email[\s\S]{0,200}complete document package[\s\S]{0,200}broker/i.test(_whSrc));
  expect('(d) R10-H sweep cascade-composition applied (enforceNoRoutingLeak)',
    /R10-I:[\s\S]{0,300}enforceNoRoutingLeak\b/.test(_whSrc));
  expect('(e) R10-H sweep cascade-composition applied (stripPerfectOpener)',
    /R10-I:[\s\S]{0,300}stripPerfectOpener\b/.test(_whSrc));
  expect('(f) R6-λ 2-second delay preserved between admin info notice + broker send',
    /R6-λ[\s\S]{0,400}2-second delay[\s\S]{0,800}await new Promise\(\(resolve\) => setTimeout\(resolve, 2000\)\)/.test(_whSrc));
  expect('(g) LLLL threading preserved (In-Reply-To + References + earliestBrokerSubject anchor)',
    /buildPreviewThreadChain\(brokerInputs\)/.test(_whSrc)
      && /'In-Reply-To'/.test(_whSrc)
      && /'References'/.test(_whSrc)
      && /earliestBrokerSubject/.test(_whSrc));
  expect('(h) generateCompletionEmail function preserved (backward-compat per Q3 verdict)',
    typeof ai.generateCompletionEmail === 'function');
  expect('(i) Broker Snapshot uses SAME filtered canonical_map as admin (no drift; R10-E/R10-G hierarchy preserved)',
    /filterCanonicalMortgagePositionForObjectiveAuthoritative[\s\S]{0,300}filterCanonicalPurposeForBrokerAuthoritative[\s\S]{0,300}filterCanonicalLoanAmountForDocAuthoritative[\s\S]{0,300}filterCanonicalLenderForPayoutOnly/.test(_whSrc));

  // ─── R10-I-ETHAN-LOAD-BEARING (Stage 1.5 live-Supabase) ───
  console.log('\n--- R10-I-ETHAN-LOAD-BEARING (Stage 1.5) ---');
  const ETHAN_DEAL = 'c95f3a20-162c-45cf-a98c-60b6bbb2de9a';
  try {
    const { data: ethanDeal } = await supabase.from('deals').select('id, status, ownership_type, extracted_data').eq('id', ETHAN_DEAL).single();
    const { data: ethanMsgs } = await supabase.from('messages').select('direction, subject, body, created_at').eq('deal_id', ETHAN_DEAL).order('created_at', { ascending: true });
    const { data: ethanDocs } = await supabase.from('documents').select('file_name, classification, extracted_data').eq('deal_id', ETHAN_DEAL);
    const ethanInbounds = ethanMsgs.filter(m => m.direction === 'inbound');
    const ethanDocsForDetect = ethanDocs.map(d => ({ file_name: d.file_name, classification: d.classification, text: d.extracted_data?.text || '' }));
    const ethanDetect = dEngine.runDiscrepancyDetectionAggregated(
      ethanInbounds,
      ethanDocsForDetect,
      ethanDeal?.extracted_data?.borrower_name,
      { emailSubject: ethanInbounds[0]?.subject || '' }
    );
    const ethanFiltered = dEngine.filterCanonicalMortgagePositionForObjectiveAuthoritative(
      dEngine.filterCanonicalPurposeForBrokerAuthoritative(
        dEngine.filterCanonicalLoanAmountForDocAuthoritative(
          dEngine.filterCanonicalLenderForPayoutOnly(ethanDetect.canonical_map)
        )
      )
    );
    const ethanSnapshot = dEngine.renderDealSnapshot(ethanFiltered, { ownershipType: ethanDeal.ownership_type, isCommercial: false });

    expect('(a) Ethan canonical_map renders Deal Snapshot with Property Address',
      /<h2>Deal Snapshot<\/h2>/.test(ethanSnapshot) && /Property Address/i.test(ethanSnapshot));
    expect('(b) Ethan Snapshot includes Combined LTV row (≈59.8%)',
      /Combined LTV[\s\S]{0,200}59\.\d%/.test(ethanSnapshot));
    expect('(c) Ethan Snapshot includes Loan Amount Requested row',
      /Loan Amount Requested/i.test(ethanSnapshot));
    expect('(d) Ethan Snapshot includes Mortgage Position row',
      /Mortgage Position/i.test(ethanSnapshot));
    expect('(e) Ethan Snapshot defensive empirical check — no admin-internal field labels leak (no "Risk Factors", no "discrepancy" labels)',
      !/Risk Factors|Discrepancy Flag|Notes for admin/i.test(ethanSnapshot));
    // [PRE-FIX EMPIRICAL] confirm Ethan's final broker outbound is the generic close-out shape
    const ethanFinalOutbound = ethanMsgs.filter(m => m.direction === 'outbound').slice(-1)[0];
    expect('(f) [PRE-FIX EMPIRICAL] Ethan final broker outbound is generic "file is complete" with no Snapshot + no attachment-mention',
      ethanFinalOutbound && /file is now complete and submitted/i.test(ethanFinalOutbound.body || '')
        && !/<h2>Deal Snapshot<\/h2>/.test(ethanFinalOutbound.body || '')
        && !/Complete_Documents\.zip/.test(ethanFinalOutbound.body || ''));
    // [POST-FIX SIMULATION] composer with Ethan canonical_map produces lender-package
    const ethanComposerOut = ai.composeBrokerLenderPackageEmail({
      borrowerName: 'Ethan James Broussard',
      brokerGreetingName: 'Harpreet',
      snapshotHtml: ethanSnapshot,
      packageAttached: true,
      borrowerSafeName: 'Ethan_James_Broussard',
    });
    expect('(g) [POST-FIX] composer output for Ethan contains Snapshot + attachment-mention + Franco-pointer',
      /<h2>Deal Snapshot<\/h2>/.test(ethanComposerOut)
        && /Ethan_James_Broussard_Complete_Documents\.zip/.test(ethanComposerOut)
        && /franco@privatemortgagelink\.com/.test(ethanComposerOut));
  } catch (e) {
    console.log(`  SKIP (Ethan load-bearing) — ${e.message}`);
  }

  // ─── R10-I-KEVIN-DEFENSIVE (Stage 1.5 live-Supabase) ───
  console.log('\n--- R10-I-KEVIN-DEFENSIVE (Stage 1.5) ---');
  const KEVIN_DEAL = '30d1e798-38b0-410a-8e9a-9999ea26c61f';
  try {
    const { data: kevinDeal } = await supabase.from('deals').select('id, status, ownership_type, extracted_data').eq('id', KEVIN_DEAL).single();
    const { data: kevinMsgs } = await supabase.from('messages').select('direction, subject, body, created_at').eq('deal_id', KEVIN_DEAL).order('created_at', { ascending: true });
    const { data: kevinDocs } = await supabase.from('documents').select('file_name, classification, extracted_data').eq('deal_id', KEVIN_DEAL);
    const kevinInbounds = kevinMsgs.filter(m => m.direction === 'inbound');
    const kevinDocsForDetect = kevinDocs.map(d => ({ file_name: d.file_name, classification: d.classification, text: d.extracted_data?.text || '' }));
    const kevinDetect = dEngine.runDiscrepancyDetectionAggregated(
      kevinInbounds,
      kevinDocsForDetect,
      kevinDeal?.extracted_data?.borrower_name,
      { emailSubject: kevinInbounds[0]?.subject || '' }
    );
    const kevinFiltered = dEngine.filterCanonicalMortgagePositionForObjectiveAuthoritative(
      dEngine.filterCanonicalPurposeForBrokerAuthoritative(
        dEngine.filterCanonicalLoanAmountForDocAuthoritative(
          dEngine.filterCanonicalLenderForPayoutOnly(kevinDetect.canonical_map)
        )
      )
    );
    const kevinSnapshot = dEngine.renderDealSnapshot(kevinFiltered, { ownershipType: kevinDeal.ownership_type, isCommercial: false });
    expect('(a) Kevin canonical_map renders Deal Snapshot with Property Address',
      /<h2>Deal Snapshot<\/h2>/.test(kevinSnapshot) && /Property Address/i.test(kevinSnapshot));
    expect('(b) Kevin final broker outbound (PRE-FIX) is generic "file is complete"',
      (() => {
        const out = kevinMsgs.filter(m => m.direction === 'outbound').slice(-1)[0];
        return out && /file is now complete and submitted/i.test(out.body || '');
      })());
    const kevinComposerOut = ai.composeBrokerLenderPackageEmail({
      borrowerName: kevinDeal.extracted_data?.borrower_name || 'Kevin Minh Tran',
      brokerGreetingName: 'Simone',
      snapshotHtml: kevinSnapshot,
      packageAttached: true,
      borrowerSafeName: 'Kevin_Minh_Tran',
    });
    expect('(c) [POST-FIX] composer output for Kevin contains Snapshot + attachment-mention',
      /<h2>Deal Snapshot<\/h2>/.test(kevinComposerOut)
        && /Kevin_Minh_Tran_Complete_Documents\.zip/.test(kevinComposerOut));
  } catch (e) {
    console.log(`  SKIP (Kevin defensive) — ${e.message}`);
  }

  // ─── R10-I-CROSS-CLUSTER-INTEGRATION ───
  console.log('\n--- R10-I-CROSS-CLUSTER-INTEGRATION ---');
  expect('(a) R9-G admin zip build at L1551 unchanged (admin still receives zip)',
    /const _r9gZipBase64 = await dealsService\.downloadDocsAsZip/.test(_whSrc)
      && /R9-G: submission-ready document package built/.test(_whSrc));
  expect('(b) R9-G _r9gPackageAttachments still passed to admin info-notice send',
    (() => {
      // Locate admin sendEmail in sendCompletionHandoff (info notice path)
      const infoIdx = _whSrc.indexOf('const infoResult = await emailService.sendEmail');
      if (infoIdx === -1) return false;
      const block = _whSrc.slice(infoIdx, infoIdx + 500);
      return /_r9gPackageAttachments/.test(block);
    })());
  expect('(c) R9-A status="completed" atomic transition unchanged',
    /R9-A: deal status transitioned to 'completed' atomically/.test(_whSrc)
      && /await dealsService\.update\(deal\.id,\s*\{\s*status:\s*'completed'\s*\}\)/.test(_whSrc));
  expect('(d) R10-F discrepancyHold preserved at computeCompletionDispatch',
    /const\s+computeCompletionDispatch\s*=\s*\(\{[\s\S]{0,200}discrepancyHold\s*\}\)/.test(_whSrc));
  expect('(e) R10-H sweepBrokerFacingDraft helper preserved at admin-handoff paths',
    /const\s+sweepBrokerFacingDraft\s*=\s*\(html\)\s*=>/.test(_whSrc));
  expect('(f) R10-C-1 generateHighLtvCollateralAsk + computeLtvBand preserved',
    typeof ai.generateHighLtvCollateralAsk === 'function'
      && typeof dEngine.computeLtvBand === 'function');
  expect('(g) renderDealSnapshot signature unchanged (admin + broker share same renderer)',
    typeof dEngine.renderDealSnapshot === 'function');
  expect('(h) R10-I docblock cites dedicated-generator-bypass sub-pattern (R10-C 2nd instance)',
    /dedicated-generator-bypass[\s\S]{0,400}2nd instance/i.test(_aiSrc));
  expect('(i) R10-I docblock cites NEW-FEATURE existing-infrastructure reuse discipline (R9-G continuation)',
    /NEW-FEATURE EXISTING-INFRASTRUCTURE REUSE DISCIPLINE[\s\S]{0,400}continuation of[\s\S]{0,80}R9-G/i.test(_aiSrc));
  expect('(j) R10-I docblock flags deferred residuals (PDF / branding / lender-match / hosted-link / generateCompletionEmail-preservation)',
    /DEFERRED RESIDUALS[\s\S]{0,400}PDF[\s\S]{0,200}Branding[\s\S]{0,200}Lender match-fit[\s\S]{0,200}Hosted-link/i.test(_aiSrc));

  console.log('\n========== R10-I mini-harness complete ==========');
  console.log(`PASS: ${passCount} | FAIL: ${failCount}`);
  if (failCount > 0) process.exit(1);
})().catch(e => { console.error('\nHARNESS ERROR:', e.stack || e.message); process.exit(1); });
