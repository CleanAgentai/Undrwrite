// R9-F' mini-harness — 7 verification groups in isolation.
// Per R9-E precedent: standalone harness runs without Claude API dependency
// while Anthropic balance restoration is pending. Canonical R9-F' groups
// remain in test-trigger.js for full-harness once balance restored.

require('dotenv').config();

// Test-environment defaults so service singletons construct cleanly
// (mirrors test-trigger.js lines 11-16). The harness exercises only
// pure-source-pins + pure-helper truth tables — no live API or DB calls.
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'sk-test-dummy';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';
process.env.POSTMARK_API_TOKEN = process.env.POSTMARK_API_TOKEN || 'dummy';
process.env.POSTMARK_SENDER_EMAIL = process.env.POSTMARK_SENDER_EMAIL || 'vienna@example.com';
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'franco@privatemortgagelink.com';

const dealsService = require('../src/services/deals');
const { canonicalizeProperty, propertyFuzzyMatch, TEMPORAL_CARVEOUT_DAYS, decideExistingDealMatch } = dealsService.__test__;

(async () => {
  console.log('========== R9-F\' mini-harness — borrower-identity dedup ==========');

  const fs = require('fs');
  const path = require('path');
  const _r9fpDealsSrc = fs.readFileSync(path.join(__dirname, '../src/services/deals.js'), 'utf8');
  const _r9fpWebhookSrc = fs.readFileSync(path.join(__dirname, '../src/routes/webhook.js'), 'utf8');

  let passCount = 0;
  let failCount = 0;
  const expect = (label, cond, detail) => {
    if (cond) {
      console.log(`  PASS ${label}`);
      passCount++;
    } else {
      console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
      failCount++;
      throw new Error(`FAIL [${label}]${detail ? ' — ' + detail : ''}`);
    }
  };

  // ─── R9-F'-PROPERTY-CANONICAL-MATRIX ───
  console.log('\n--- R9-F\'-PROPERTY-CANONICAL-MATRIX ---');
  // (a) null + empty inputs
  expect('(a1) null input', canonicalizeProperty(null) === null);
  expect('(a2) empty string', canonicalizeProperty('') === null);
  expect('(a3) whitespace only', canonicalizeProperty('   ') === null);
  expect('(a4) non-string input', canonicalizeProperty(12345) === null);
  // (b) full address with postal
  {
    const c = canonicalizeProperty('1142 Tory Road NW, Edmonton, AB T6R 3K2');
    expect('(b1) FSA extraction', c.postalPrefix === 't6r', JSON.stringify(c));
    expect('(b2) street number', c.streetNumber === '1142');
    expect('(b3) street tokens contains "tory road nw"', c.streetTokens.includes('tory'));
  }
  // (c) Grace Paulson truncation variant 1
  {
    const c = canonicalizeProperty('88 Harvest Hills Blvd NE, Calgary, AB T3K 4G9');
    expect('(c1) Grace Paulson full postal', c.postalPrefix === 't3k' && c.streetNumber === '88');
  }
  // (c2) Grace Paulson truncation variant 2 — partial postal
  {
    const c = canonicalizeProperty('88 Harvest Hills Blvd NE, Calgary, AB T3K');
    expect('(c2) Grace Paulson FSA-only', c.postalPrefix === 't3k' && c.streetNumber === '88');
  }
  // (c3) Grace Paulson no postal at all
  {
    const c = canonicalizeProperty('88 Harvest Hills Blvd NE, Calgary, AB');
    expect('(c3) Grace Paulson no postal', c.postalPrefix === null && c.streetNumber === '88');
  }
  // (d) Marcus Webb variants
  {
    const c1 = canonicalizeProperty('1142 Tory Road NW, Edmonton, AB T6R 3K2');
    const c2 = canonicalizeProperty('1142 Tory Road NW, Edmonton');
    expect('(d1) Marcus Webb both have street#', c1.streetNumber === '1142' && c2.streetNumber === '1142');
    expect('(d2) Marcus Webb postal asymmetry', c1.postalPrefix === 't6r' && c2.postalPrefix === null);
  }
  // (e) whitespace + punctuation normalization
  {
    const c = canonicalizeProperty('  1142   Tory  Road  NW,,  Edmonton.,  AB  T6R 3K2  ');
    expect('(e1) whitespace normalized', c.streetNumber === '1142' && c.postalPrefix === 't6r');
  }
  // (f) case insensitive
  {
    const c1 = canonicalizeProperty('1142 TORY ROAD NW T6R 3K2');
    const c2 = canonicalizeProperty('1142 tory road nw t6r 3k2');
    expect('(f1) case insensitive equiv', c1.postalPrefix === c2.postalPrefix && c1.streetNumber === c2.streetNumber);
  }
  // (g) no street number
  {
    const c = canonicalizeProperty('Calgary, AB T3K 4G9');
    expect('(g1) no street number', c.streetNumber === null && c.postalPrefix === 't3k');
  }
  // (h) Patricia Simmons fuzzy variant — Calgary
  {
    const c1 = canonicalizeProperty('412 Coach Side Crescent SW, Calgary, AB');
    const c2 = canonicalizeProperty('412 Coach Side Crescent SW, Calgary');
    expect('(h1) Patricia same street# same tokens', c1.streetNumber === '412' && c2.streetNumber === '412');
    expect('(h2) Patricia same street tokens prefix', c1.streetTokens === c2.streetTokens);
  }

  // ─── R9-F'-FUZZY-MATCH-MATRIX ───
  console.log('\n--- R9-F\'-FUZZY-MATCH-MATRIX ---');
  // (a) exact same
  expect('(a) exact same → match', propertyFuzzyMatch(
    '1142 Tory Road NW, Edmonton, AB T6R 3K2',
    '1142 Tory Road NW, Edmonton, AB T6R 3K2'
  ) === true);
  // (b) Grace Paulson FSA+street# match across truncation
  expect('(b) Grace Paulson full vs partial → match', propertyFuzzyMatch(
    '88 Harvest Hills Blvd NE, Calgary, AB T3K 4G9',
    '88 Harvest Hills Blvd NE, Calgary, AB T3K'
  ) === true);
  // (c) Marcus Webb postal asymmetry → fallback to street# + tokens match
  expect('(c) Marcus Webb postal-asymmetry → match (fallback)', propertyFuzzyMatch(
    '1142 Tory Road NW, Edmonton, AB T6R 3K2',
    '1142 Tory Road NW, Edmonton'
  ) === true);
  // (d) different FSA same street# → no match (FSA anchor wins)
  expect('(d) different FSA same street# → no match', propertyFuzzyMatch(
    '1142 Tory Road NW, Edmonton, AB T6R 3K2',
    '1142 Tory Road NW, Calgary, AB T2P 0X4'
  ) === false);
  // (e) same FSA different street# → no match
  expect('(e) same FSA different street# → no match', propertyFuzzyMatch(
    '1142 Tory Road NW, Edmonton, AB T6R 3K2',
    '8234 Tory Road NW, Edmonton, AB T6R 3K2'
  ) === false);
  // (f) same street# different tokens, no postal in either → no match (fallback)
  expect('(f) no postal + same street# different street → no match', propertyFuzzyMatch(
    '1142 Tory Road NW, Edmonton',
    '1142 Whyte Avenue, Edmonton'
  ) === false);
  // (g) null/empty → no match
  expect('(g1) null + null → no match', propertyFuzzyMatch(null, null) === false);
  expect('(g2) null + valid → no match', propertyFuzzyMatch(null, '1142 Tory Road NW T6R 3K2') === false);
  expect('(g3) valid + null → no match', propertyFuzzyMatch('1142 Tory Road NW T6R 3K2', null) === false);
  // (h) empirical: 5 hottest dup groups internal consistency
  expect('(h1) Grace 9 variants pairwise', propertyFuzzyMatch(
    '88 Harvest Hills Blvd NE, Calgary, AB T3K 4G9',
    '88 Harvest Hills Blvd NE, Calgary'
  ) === true);
  expect('(h2) Marcus 8 variants pairwise', propertyFuzzyMatch(
    '1142 Tory Road NW, Edmonton, AB T6R 3K2',
    '1142 Tory Road NW, Edmonton, AB'
  ) === true);
  expect('(h3) Derek 7 variants pairwise', propertyFuzzyMatch(
    '5519 Henwood Road SW, Calgary, AB T3E 6K3',
    '5519 Henwood Road SW, Calgary'
  ) === true);

  // ─── R9-F'-FIND-EXISTING-DEAL-MATRIX (via pure decideExistingDealMatch) ───
  console.log('\n--- R9-F\'-FIND-EXISTING-DEAL-MATRIX ---');
  const NOW = new Date('2026-05-26T00:00:00Z').getTime();
  const mkDeal = (overrides) => ({
    id: 'deal-' + Math.random().toString(36).slice(2, 8),
    email: 'broker@example.com',
    borrower_name: 'Test Borrower',
    status: 'active',
    extracted_data: {},
    created_at: '2026-05-20T00:00:00Z',
    updated_at: '2026-05-20T00:00:00Z',
    ...overrides,
  });
  // (a) empty candidates → null
  expect('(a) empty candidates → null no_match', (() => {
    const r = decideExistingDealMatch([], { subject_property_address: '1142 Tory Road NW T6R 3K2' }, NOW);
    return r.existingDeal === null && r.reason === 'no_match';
  })());
  // (b) active + same property → match
  expect('(b) active + same property → match', (() => {
    const c = mkDeal({ status: 'active', extracted_data: { subject_property_address: '1142 Tory Road NW, Edmonton, AB T6R 3K2' } });
    const r = decideExistingDealMatch([c], { subject_property_address: '1142 Tory Road NW, Edmonton' }, NOW);
    return r.existingDeal === c && r.reason === 'property_match_active';
  })());
  // (c) active + different property → null (carve-out)
  expect('(c) active + different property → null', (() => {
    const c = mkDeal({ status: 'active', extracted_data: { subject_property_address: '1142 Tory Road NW, Edmonton, AB T6R 3K2' } });
    const r = decideExistingDealMatch([c], { subject_property_address: '8234 Whyte Avenue, Edmonton' }, NOW);
    return r.existingDeal === null && r.reason === 'no_property_match_or_carveout';
  })());
  // (d) terminal completed < 90 days + same property → match (recent_terminal)
  expect('(d) terminal <90 + same property → match (recent_terminal)', (() => {
    const c = mkDeal({
      status: 'completed',
      updated_at: '2026-04-01T00:00:00Z',  // 55 days before NOW
      extracted_data: { subject_property_address: '1142 Tory Road NW T6R 3K2' },
    });
    const r = decideExistingDealMatch([c], { subject_property_address: '1142 Tory Road NW T6R' }, NOW);
    return r.existingDeal === c && r.reason === 'property_match_recent_terminal';
  })());
  // (e) terminal completed > 90 days + same property → null (refinance carve-out)
  expect('(e) terminal >90 + same property → null (refinance)', (() => {
    const c = mkDeal({
      status: 'completed',
      updated_at: '2026-01-01T00:00:00Z',  // 145 days before NOW
      extracted_data: { subject_property_address: '1142 Tory Road NW T6R 3K2' },
    });
    const r = decideExistingDealMatch([c], { subject_property_address: '1142 Tory Road NW T6R' }, NOW);
    return r.existingDeal === null && r.reason === 'no_property_match_or_carveout';
  })());
  // (f) non-terminal preferred over terminal
  expect('(f) non-terminal priority over terminal', (() => {
    const active = mkDeal({
      id: 'deal-active',
      status: 'active',
      extracted_data: { subject_property_address: '1142 Tory Road NW T6R 3K2' },
    });
    const completed = mkDeal({
      id: 'deal-completed',
      status: 'completed',
      updated_at: '2026-04-01T00:00:00Z',
      extracted_data: { subject_property_address: '1142 Tory Road NW T6R 3K2' },
    });
    const r = decideExistingDealMatch([completed, active], { subject_property_address: '1142 Tory Road NW T6R' }, NOW);
    return r.existingDeal === active && r.reason === 'property_match_active';
  })());
  // (g) Q3a fail-open: property missing in new submission → null
  expect('(g) Q3a fail-open: new property missing → null', (() => {
    const c = mkDeal({ status: 'active', extracted_data: { subject_property_address: '1142 Tory Road NW T6R 3K2' } });
    const r = decideExistingDealMatch([c], {}, NOW);
    return r.existingDeal === null && r.reason === 'no_property_match_or_carveout';
  })());
  // (h) Q3a fail-open: property missing in candidate → null
  expect('(h) Q3a fail-open: candidate property missing → null', (() => {
    const c = mkDeal({ status: 'active', extracted_data: {} });
    const r = decideExistingDealMatch([c], { subject_property_address: '1142 Tory Road NW T6R' }, NOW);
    return r.existingDeal === null && r.reason === 'no_property_match_or_carveout';
  })());
  // (i) rejected (terminal) deal — same temporal/property rules
  expect('(i) rejected <90 + same property → match', (() => {
    const c = mkDeal({
      status: 'rejected',
      updated_at: '2026-04-01T00:00:00Z',
      extracted_data: { subject_property_address: '1142 Tory Road NW T6R 3K2' },
    });
    const r = decideExistingDealMatch([c], { subject_property_address: '1142 Tory Road NW T6R' }, NOW);
    return r.existingDeal === c && r.reason === 'property_match_recent_terminal';
  })());
  // (j) multiple non-terminal + different properties — finds the matching one
  expect('(j) multiple non-terminal, finds matching property', (() => {
    const c1 = mkDeal({ id: 'c1', status: 'active', extracted_data: { subject_property_address: '8234 Whyte Avenue Edmonton' } });
    const c2 = mkDeal({ id: 'c2', status: 'under_review', extracted_data: { subject_property_address: '1142 Tory Road NW T6R 3K2' } });
    const r = decideExistingDealMatch([c1, c2], { subject_property_address: '1142 Tory Road NW T6R' }, NOW);
    return r.existingDeal === c2 && r.reason === 'property_match_active';
  })());
  // (k) all different properties + active → null
  expect('(k) all different non-terminal properties → null', (() => {
    const c1 = mkDeal({ id: 'c1', status: 'active', extracted_data: { subject_property_address: '8234 Whyte Avenue Edmonton' } });
    const c2 = mkDeal({ id: 'c2', status: 'under_review', extracted_data: { subject_property_address: '5519 Henwood Road SW, Calgary, AB T3E 6K3' } });
    const r = decideExistingDealMatch([c1, c2], { subject_property_address: '1142 Tory Road NW T6R' }, NOW);
    return r.existingDeal === null && r.reason === 'no_property_match_or_carveout';
  })());
  // (l) property_address fallback (not subject_property_address)
  expect('(l) property_address fallback key', (() => {
    const c = mkDeal({ status: 'active', extracted_data: { property_address: '1142 Tory Road NW T6R 3K2' } });
    const r = decideExistingDealMatch([c], { property_address: '1142 Tory Road NW T6R' }, NOW);
    return r.existingDeal === c && r.reason === 'property_match_active';
  })());

  // ─── R9-F'-CALL-SITE-WIRING — 8-anchor source pin ───
  console.log('\n--- R9-F\'-CALL-SITE-WIRING ---');
  expect('(a) findExistingDealForBorrower exported from deals.js',
    /findExistingDealForBorrower:\s*async/.test(_r9fpDealsSrc));
  expect('(b) __test__ exposes canonicalizeProperty + propertyFuzzyMatch + TEMPORAL_CARVEOUT_DAYS + decideExistingDealMatch',
    /module\.exports\.__test__ = \{[\s\S]*?canonicalizeProperty[\s\S]*?propertyFuzzyMatch[\s\S]*?TEMPORAL_CARVEOUT_DAYS[\s\S]*?decideExistingDealMatch[\s\S]*?\}/.test(_r9fpDealsSrc));
  expect('(c) webhook.js calls findExistingDealForBorrower after R9-F classifyIntakeBorrower gate',
    (() => {
      const r9fIdx = _r9fpWebhookSrc.search(/_r9fIntakeClassification\s*=\s*classifyIntakeBorrower/);
      const r9fpIdx = _r9fpWebhookSrc.search(/_r9fPrimeDupCheck\s*=\s*await\s+dealsService\.findExistingDealForBorrower/);
      return r9fIdx !== -1 && r9fpIdx !== -1 && r9fpIdx > r9fIdx;
    })());
  expect('(d) webhook.js calls findExistingDealForBorrower before dealsService.create',
    (() => {
      const r9fpIdx = _r9fpWebhookSrc.search(/_r9fPrimeDupCheck\s*=\s*await\s+dealsService\.findExistingDealForBorrower/);
      // Find the FIRST dealsService.create AFTER the R9-F' wire site (in the new-client INITIAL branch)
      const afterR9fp = _r9fpWebhookSrc.slice(r9fpIdx);
      const createMatch = afterR9fp.search(/const deal = await dealsService\.create\(\{\s*email: email\.from,/);
      return r9fpIdx !== -1 && createMatch > 0;
    })());
  expect('(e) duplicate route invokes sendDuplicateAlertToAdmin + returns without create',
    /if \(_r9fPrimeDupCheck\.existingDeal\)\s*\{[\s\S]*?sendDuplicateAlertToAdmin[\s\S]*?return;\s*\}/.test(_r9fpWebhookSrc));
  expect('(f) sendDuplicateAlertToAdmin defined + admin subject contains [Potential Duplicate]',
    /const sendDuplicateAlertToAdmin = async/.test(_r9fpWebhookSrc)
    && /\[Potential Duplicate\]/.test(_r9fpWebhookSrc));
  expect('(g) duplicate route saves NO deal record (no dealsService.create or saveMessage in handoff branch)',
    (() => {
      const handoffMatch = _r9fpWebhookSrc.match(/if \(_r9fPrimeDupCheck\.existingDeal\)\s*\{[\s\S]*?return;\s*\}/);
      if (!handoffMatch) return false;
      const branch = handoffMatch[0];
      return !/dealsService\.create/.test(branch) && !/dealsService\.saveMessage/.test(branch);
    })());
  expect('(h) R9-F classifyIntakeBorrower gate still wired (prior cycle invariant)',
    /_r9fIntakeClassification\s*=\s*classifyIntakeBorrower/.test(_r9fpWebhookSrc));

  // ─── R9-F'-CROSS-CLUSTER-INTEGRATION — 10-anchor closed-set ───
  console.log('\n--- R9-F\'-CROSS-CLUSTER-INTEGRATION ---');
  expect('(a) findActiveByEmail behavior UNCHANGED',
    /findActiveByEmail:\s*async\s*\(email\)\s*=>[\s\S]*?\.not\(['"]status['"],\s*['"]in['"],\s*['"]\("completed","rejected"\)['"]\)/.test(_r9fpDealsSrc));
  expect('(b) R9-F classifyIntakeBorrower still wired',
    /classifyIntakeBorrower/.test(_r9fpWebhookSrc));
  expect('(c) R9-E startCron factory present',
    (() => {
      const cronSrc = fs.readFileSync(path.join(__dirname, '../src/cron/dailySummary.js'), 'utf8');
      return /const startCron = \(\) =>/.test(cronSrc) || /function startCron\s*\(/.test(cronSrc);
    })());
  expect('(d) R6-κ aml_pep flow preserved (aml_pep_requested_at referenced)',
    /aml_pep_requested_at/.test(_r9fpWebhookSrc));
  expect('(e) R5-F-2 claimDailySummarySlot preserved',
    /claimDailySummarySlot/.test(fs.readFileSync(path.join(__dirname, '../src/cron/dailySummary.js'), 'utf8')));
  expect('(f) Postmark email sending unaffected (sendEmail signature)',
    /emailService\.sendEmail/.test(_r9fpWebhookSrc));
  expect('(g) extracted_data property keys both supported (subject_property_address || property_address)',
    /subject_property_address\s*\|\|\s*[\w.]*property_address/.test(_r9fpDealsSrc));
  expect('(h) module.exports.findExistingDealForBorrower + __test__ exports preserved',
    /findExistingDealForBorrower:\s*async/.test(_r9fpDealsSrc) && /module\.exports\.__test__ = \{/.test(_r9fpDealsSrc));
  expect('(i) Group ZZZ admin-alert pattern reused (alert-admin-skip + emailService.sendEmail)',
    /const sendDuplicateAlertToAdmin = async[\s\S]*?emailService\.sendEmail\(\s*config\.adminEmail/.test(_r9fpWebhookSrc));
  expect('(j) Idempotency: duplicate route is pure read (findExistingDealForBorrower SELECT only) + email send (no DB mutation)',
    (() => {
      const handoffMatch = _r9fpWebhookSrc.match(/if \(_r9fPrimeDupCheck\.existingDeal\)\s*\{[\s\S]*?return;\s*\}/);
      if (!handoffMatch) return false;
      const branch = handoffMatch[0];
      return !/dealsService\.update/.test(branch) && !/dealsService\.create/.test(branch);
    })());

  // ─── R9-F'-CARVE-OUT-RESPECT — empirical fixture replay ───
  console.log('\n--- R9-F\'-CARVE-OUT-RESPECT ---');
  // Refinance fixture: same email + same property + last terminal >90 days → create proceeds
  expect('(refinance-1) Marcus Webb 100-day-old completed → create proceeds (null match)', (() => {
    const c = mkDeal({
      status: 'completed',
      updated_at: '2026-02-15T00:00:00Z',  // 100 days before NOW
      extracted_data: { subject_property_address: '1142 Tory Road NW, Edmonton, AB T6R 3K2' },
    });
    const r = decideExistingDealMatch([c], { subject_property_address: '1142 Tory Road NW, Edmonton' }, NOW);
    return r.existingDeal === null;
  })());
  expect('(refinance-2) Grace Paulson 150-day-old rejected → create proceeds (null match)', (() => {
    const c = mkDeal({
      status: 'rejected',
      updated_at: '2025-12-27T00:00:00Z',  // 150 days before NOW
      extracted_data: { subject_property_address: '88 Harvest Hills Blvd NE, Calgary, AB T3K 4G9' },
    });
    const r = decideExistingDealMatch([c], { subject_property_address: '88 Harvest Hills Blvd NE, Calgary' }, NOW);
    return r.existingDeal === null;
  })());
  // New-property fixture: same email + different property → create proceeds
  expect('(new-property-1) Marcus Webb different property → create proceeds (null match)', (() => {
    const c = mkDeal({
      status: 'active',
      extracted_data: { subject_property_address: '1142 Tory Road NW, Edmonton, AB T6R 3K2' },
    });
    const r = decideExistingDealMatch([c], { subject_property_address: '8234 Whyte Avenue, Edmonton, AB T6E 1A1' }, NOW);
    return r.existingDeal === null;
  })());
  expect('(new-property-2) Grace different FSA same street# → create proceeds (null match)', (() => {
    const c = mkDeal({
      status: 'active',
      extracted_data: { subject_property_address: '88 Harvest Hills Blvd NE, Calgary, AB T3K 4G9' },
    });
    const r = decideExistingDealMatch([c], { subject_property_address: '88 Harvest Hills Blvd NE, Edmonton, AB T6R 3K2' }, NOW);
    return r.existingDeal === null;
  })());
  // Same-day typo resubmit: same email + same property + <90 days terminal OR active → admin handoff
  expect('(typo-resubmit-1) Marcus Webb same-day active duplicate → admin handoff', (() => {
    const c = mkDeal({
      status: 'active',
      extracted_data: { subject_property_address: '1142 Tory Road NW, Edmonton, AB T6R 3K2' },
    });
    const r = decideExistingDealMatch([c], { subject_property_address: '1142 Tory Road NW, Edmonton' }, NOW);
    return r.existingDeal === c && r.reason === 'property_match_active';
  })());
  // Property-missing in either side → fail-open
  expect('(property-missing-1) new submission has no property → fail-open null', (() => {
    const c = mkDeal({
      status: 'active',
      extracted_data: { subject_property_address: '1142 Tory Road NW T6R 3K2' },
    });
    const r = decideExistingDealMatch([c], {}, NOW);
    return r.existingDeal === null;
  })());
  expect('(property-missing-2) candidate has no property → fail-open null', (() => {
    const c = mkDeal({
      status: 'active',
      extracted_data: {},
    });
    const r = decideExistingDealMatch([c], { subject_property_address: '1142 Tory Road NW T6R 3K2' }, NOW);
    return r.existingDeal === null;
  })());

  // ─── R9-F'-ADMIN-ALERT-CONTENT-ANCHORS — 12-anchor closed-set ───
  console.log('\n--- R9-F\'-ADMIN-ALERT-CONTENT-ANCHORS ---');
  const sendDupSrc = (() => {
    const start = _r9fpWebhookSrc.indexOf('const sendDuplicateAlertToAdmin');
    const end = _r9fpWebhookSrc.indexOf('};', start);
    return _r9fpWebhookSrc.slice(start, end + 2);
  })();
  expect('(1) [Potential Duplicate] subject prefix', /\[Potential Duplicate\]/.test(sendDupSrc));
  expect('(2) borrower name in subject', /\$\{newBorrowerName\}/.test(sendDupSrc));
  expect('(3) broker email in subject', /\$\{newBrokerEmail\}/.test(sendDupSrc));
  expect('(4) "NEW SUBMISSION" section header', /NEW SUBMISSION/.test(sendDupSrc));
  expect('(5) "EXISTING DEAL" section header', /EXISTING DEAL/.test(sendDupSrc));
  expect('(6) existing deal ID anchor', /\$\{existingDeal\.id\}/.test(sendDupSrc));
  expect('(7) existing deal status anchor', /\$\{existingDeal\.status\}/.test(sendDupSrc));
  expect('(8) existing deal created_at anchor', /\$\{existingDeal\.created_at\}/.test(sendDupSrc));
  expect('(9) existing deal property_address anchor', /\$\{existingProperty\}/.test(sendDupSrc));
  expect('(10) new submission property_address anchor', /\$\{newProperty\}/.test(sendDupSrc));
  expect('(11) reason classification anchor', /\$\{reason\}/.test(sendDupSrc));
  expect('(12) decision-prompt directive present', /To link these deals|If this is a new deal/.test(sendDupSrc));

  console.log(`\n========== R9-F' mini-harness: ${passCount}/${passCount + failCount} PASS ==========`);
  if (failCount > 0) process.exit(1);
})().catch(e => {
  console.error('\nR9-F\' HARNESS FAILED:', e.stack || e.message);
  process.exit(1);
});
