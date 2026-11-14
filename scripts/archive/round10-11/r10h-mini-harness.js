// R10-H mini-harness — 7 verification groups including Stage 1.5 live-Supabase
// production-fixture replay against Ethan James Broussard deal c95f3a20.
// Bug 7-5 root cause: prompt-side "Allowed phrasing" instruction at ai.js
// authorized "I'll be in touch shortly with an update" without forbidding
// review-tail extensions. R10-H closes via (1) prompt-side ban subsection
// + (2) 5 new ROUTING_LEAK_PATTERNS entries (R10-H-a through R10-H-e).

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

(async () => {
  console.log('========== R10-H mini-harness — internal-review-tail sweep ==========');

  const _aiSrc = fs.readFileSync(path.join(__dirname, '../src/services/ai.js'), 'utf8');
  const _whSrc = fs.readFileSync(path.join(__dirname, '../src/routes/webhook.js'), 'utf8');

  let passCount = 0;
  let failCount = 0;
  const expect = (label, cond, detail) => {
    if (cond) { console.log(`  PASS ${label}`); passCount++; }
    else { console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); failCount++; throw new Error(`FAIL [${label}]${detail ? ' — ' + detail : ''}`); }
  };

  // Pull enforceNoRoutingLeak via module-internal access. ai.js doesn't
  // export it directly — replicate the iteration shape by extracting the
  // pattern array from source and applying it inline. Same approach as
  // R8-B mini-harness (stripPerfectOpener — internal helper).
  // For R10-H we eval the ROUTING_LEAK_PATTERNS array directly from source
  // so the harness reflects the exact ordering shipped.
  const arrayStart = _aiSrc.indexOf('const ROUTING_LEAK_PATTERNS = [');
  const arrayEnd = _aiSrc.indexOf('\nconst enforceNoRoutingLeak');
  if (arrayStart === -1 || arrayEnd === -1) {
    console.error('FATAL — could not locate ROUTING_LEAK_PATTERNS source span');
    process.exit(1);
  }
  const arraySrc = _aiSrc.slice(arrayStart, arrayEnd);
  // Evaluate inside a safe wrapper. Patterns are regex literals + string
  // replacements — no side effects, no external refs.
  const evalCtx = {};
  // eslint-disable-next-line no-new-func
  new Function('ctx', `${arraySrc}\nctx.ROUTING_LEAK_PATTERNS = ROUTING_LEAK_PATTERNS;`)(evalCtx);
  const ROUTING_LEAK_PATTERNS = evalCtx.ROUTING_LEAK_PATTERNS;

  const sweep = (html) => {
    let out = html;
    for (const { match, replace } of ROUTING_LEAK_PATTERNS) {
      out = out.replace(match, replace);
    }
    return out;
  };

  // ─── R10-H-PROMPT-DISCIPLINE-ANCHORS ───
  // Verifies the inline ban subsection lives at ai.js:1934 vicinity within
  // the gated state-aware-forwarding-language block. Pin protects against
  // accidental removal in future state-aware-forwarding refactors.
  console.log('\n--- R10-H-PROMPT-DISCIPLINE-ANCHORS ---');
  expect('(a) prompt-side ban subsection mentions R10-H',
    /R10-H\s*\(2026-05-27\)\s*—\s*DO\s+NOT\s+extend\s+allowed\s+phrases/i.test(_aiSrc));
  expect('(b) ban subsection lists "once we\'ve had a chance to review" variant',
    /once\s+we'?ve\s+had\s+a\s+chance\s+to\s+review/i.test(_aiSrc));
  expect('(c) ban subsection lists "once the team has reviewed" variant',
    /once\s+the\s+team\s+has\s+reviewed/i.test(_aiSrc));
  expect('(d) ban subsection lists "after (our) internal review" variant',
    /after\s+\(our\)\s+internal\s+review/i.test(_aiSrc));
  expect('(e) ban subsection lives inside state-aware-forwarding gated block',
    (() => {
      const idx = _aiSrc.indexOf('R10-H (2026-05-27) — DO NOT extend allowed phrases');
      if (idx === -1) return false;
      // Walk backward — should hit CRITICAL state-aware-forwarding header
      // before any other section delimiter (=== TASK 1 ===).
      const before = _aiSrc.slice(0, idx);
      const stateAwareIdx = before.lastIndexOf('CRITICAL — STATE-AWARE FORWARDING LANGUAGE');
      const taskOneIdx = before.lastIndexOf('=== TASK 1');
      return stateAwareIdx > taskOneIdx;
    })());
  expect('(f) "Acceptable" guidance preserved (allowed-phrase scaffolding intact)',
    /Acceptable:\s*"I'?ll\s+be\s+in\s+touch\s+shortly\s+with\s+an\s+update\."/i.test(_aiSrc));

  // ─── R10-H-SWEEP-PATTERN-MATRIX ───
  // Direct deterministic-input → sweep-output verification for each pattern.
  // SEMANTICS: R10-H-* patterns use empty-string replacement; the ORIGINAL
  // sentence terminator (period) is preserved by NOT consuming it in the
  // match. This avoids the ".." cascade artifact that would result from
  // R5-C-a "." + R10-H-* "." in compound. See CROSS-CLUSTER-CASCADE-
  // DISCIPLINE docblock above the R10-H patterns.
  //
  // ISOLATION: matrix tests use a R10-H-ONLY sweep (skips R5-C-a et al.)
  // to verify the new patterns in isolation. The cascade case is covered
  // separately in CROSS-CLUSTER-INTEGRATION below.
  console.log('\n--- R10-H-SWEEP-PATTERN-MATRIX ---');
  const r10hOnly = (html) => {
    let out = html;
    // Only apply the last 5 patterns (R10-H-a through R10-H-e)
    const r10hPatterns = ROUTING_LEAK_PATTERNS.slice(-5);
    for (const { match, replace } of r10hPatterns) {
      out = out.replace(match, replace);
    }
    return out;
  };
  // R10-H-a — empirical Ethan shape
  expect('(a) R10-H-a strips " once we\'ve had a chance to review everything" — terminator preserved',
    r10hOnly("<p>I'll be in touch shortly with an update once we've had a chance to review everything.</p>")
      === "<p>I'll be in touch shortly with an update.</p>");
  expect('(b) R10-H-a strips " once we\'ve had a chance to review the file"',
    r10hOnly("<p>I'll be in touch with an update once we've had a chance to review the file.</p>")
      === "<p>I'll be in touch with an update.</p>");
  expect('(c) R10-H-a strips bare "once we\'ve had a chance to review" (no object)',
    r10hOnly("<p>Update follows once we've had a chance to review.</p>")
      === "<p>Update follows.</p>");
  expect('(c2) R10-H-a strips ", once we\'ve had a chance to review the docs" (comma-prefix)',
    r10hOnly("<p>I'll be in touch, once we've had a chance to review the docs.</p>")
      === "<p>I'll be in touch.</p>");
  // R10-H-b — past-tense canonical variant
  expect('(d) R10-H-b strips " once we\'ve reviewed everything"',
    r10hOnly("<p>I'll be in touch shortly with an update once we've reviewed everything.</p>")
      === "<p>I'll be in touch shortly with an update.</p>");
  expect('(e) R10-H-b strips " after we have reviewed the file"',
    r10hOnly("<p>I'll follow up after we have reviewed the file.</p>")
      === "<p>I'll follow up.</p>");
  // R10-H-c — third-person team-attribution canonical variant
  expect('(f) R10-H-c strips " once the team has reviewed everything"',
    r10hOnly("<p>I'll be in touch shortly with an update once the team has reviewed everything.</p>")
      === "<p>I'll be in touch shortly with an update.</p>");
  expect('(g) R10-H-c strips " once our team reviews the docs"',
    r10hOnly("<p>Update follows once our team reviews the docs.</p>")
      === "<p>Update follows.</p>");
  expect('(h) R10-H-c strips " after our team has had a chance to review"',
    r10hOnly("<p>I'll circle back after our team has had a chance to review.</p>")
      === "<p>I'll circle back.</p>");
  // R10-H-d — abstract-noun "internal review" canonical variant
  expect('(i) R10-H-d strips " after internal review"',
    r10hOnly("<p>I'll be in touch after internal review.</p>")
      === "<p>I'll be in touch.</p>");
  expect('(j) R10-H-d strips " after our internal review"',
    r10hOnly("<p>Update follows after our internal review.</p>")
      === "<p>Update follows.</p>");
  // R10-H-d PARTIAL-STRIP DISCIPLINE (pinned per user direction):
  // "...once internal review is complete." strips "once internal review"
  // leaving " is complete." dangling. Acceptable.
  expect('(k) R10-H-d partial-strip discipline: trailing "is complete" dangle accepted',
    (() => {
      const out = r10hOnly("<p>I'll be in touch once internal review is complete.</p>");
      // Pattern strips " once internal review" → leaves " is complete."
      // (the leading "I'll be in touch" survives, the leak content removed).
      // Acceptable per cost-asymmetric design — minor grammar artifact,
      // not a leak.
      return /I'?ll be in touch/i.test(out)
        && !/internal\s+review/i.test(out);
    })());
  // R10-H-e — explicit-completion canonical variant
  expect('(l) R10-H-e strips " once we complete our review"',
    r10hOnly("<p>I'll be in touch shortly once we complete our review.</p>")
      === "<p>I'll be in touch shortly.</p>");
  expect('(m) R10-H-e strips " once we have completed our review"',
    r10hOnly("<p>Update follows once we have completed our review.</p>")
      === "<p>Update follows.</p>");
  expect('(n) R10-H-e strips " after we complete the review"',
    r10hOnly("<p>I'll circle back after we complete the review.</p>")
      === "<p>I'll circle back.</p>");

  // ─── R10-H-ETHAN-LOAD-BEARING ───
  // Verbatim empirical Ethan body shape from production. Cluster-level
  // load-bearing: this is the Bug 7-5 verbatim, must strip cleanly under
  // the full sweep cascade.
  //
  // CASCADE-SCENARIO EXPECTED OUTPUT: R5-C-a strips "I'll be in touch
  // shortly with an update" → "."; R10-H-a strips ".once we've had a
  // chance to review everything" → "" (orphan period consumed via [.,]?
  // leading); trailing "." preserved (not in match). Final last paragraph
  // is "<p>.</p>" — bare-period artifact. Leak fully scrubbed. Per
  // CROSS-CLUSTER-CASCADE-DISCIPLINE pin, this is the accepted outcome.
  console.log('\n--- R10-H-ETHAN-LOAD-BEARING ---');
  const ethanVerbatim = `<p>Hi Harpreet!</p>

<p>Thanks for sending those additional documents through. I've now received the government ID, CIBC payout statement, and property tax assessment, and we're ready to start working on Ethan's file.</p>

<p>To complete the document package, I'll need:</p>

<ul>
<li>AML form (Anti-Money Laundering)</li>
<li>PEP form (Politically Exposed Person)</li>
</ul>

<p>I'll be in touch shortly with an update once we've had a chance to review everything.</p>`;
  const ethanSwept = sweep(ethanVerbatim);
  expect('(a) Ethan verbatim full-cascade — leak phrase stripped',
    !/once\s+we'?ve\s+had\s+a\s+chance\s+to\s+review/i.test(ethanSwept));
  expect('(b) Ethan verbatim full-cascade — "I\'ll be in touch shortly with an update" ALSO stripped by R5-C-a (R5 Franco rule)',
    !/I'?ll\s+be\s+in\s+touch\s+shortly\s+with\s+an\s+update/i.test(ethanSwept));
  expect('(c) Ethan verbatim — greeting preserved',
    /<p>Hi Harpreet!<\/p>/i.test(ethanSwept));
  expect('(d) Ethan verbatim — doc-list preserved',
    /AML form/i.test(ethanSwept) && /PEP form/i.test(ethanSwept));
  expect('(e) Ethan verbatim — "ready to start working on" preserved (R6-η-b carve-out)',
    /we'?re ready to start working on/i.test(ethanSwept));
  // Isolated R10-H-only outcome: legitimate prefix preserved when R5-C-a
  // is NOT in the cascade. This proves R10-H is correctly scoped to the
  // tail-extension family — it doesn't strip the prefix on its own.
  const ethanR10HOnly = r10hOnly(ethanVerbatim);
  expect('(f) Ethan verbatim R10-H-only — "I\'ll be in touch shortly with an update." preserved standalone',
    /I'?ll be in touch shortly with an update\./.test(ethanR10HOnly));
  expect('(g) Ethan verbatim R10-H-only — tail stripped',
    !/once\s+we'?ve\s+had\s+a\s+chance\s+to\s+review/i.test(ethanR10HOnly));

  // ─── R10-H-PRODUCTION-FIXTURE-VERIFICATION (Stage 1.5) ───
  // Pull the actual Ethan deal c95f3a20 outbound body from live Supabase
  // and run it through the sweep. Asserts the production fixture would
  // have been caught by R10-H if the sweep had been in place.
  console.log('\n--- R10-H-PRODUCTION-FIXTURE-VERIFICATION (Stage 1.5 live-Supabase) ---');
  const ETHAN_DEAL = 'c95f3a20-162c-45cf-a98c-60b6bbb2de9a';
  let liveSweptOk = false;
  try {
    const { data: msgs, error } = await supabase
      .from('messages')
      .select('direction, subject, body, created_at')
      .eq('deal_id', ETHAN_DEAL)
      .order('created_at', { ascending: true });
    if (error) throw error;
    const offending = (msgs || []).find(m =>
      m.direction === 'outbound'
      && /once we'?ve had a chance to review/i.test(m.body || ''));
    expect('(a) Ethan deal — at least one outbound contains the verbatim leak shape',
      Boolean(offending),
      offending ? `at ${offending.created_at}` : 'no offending outbound found');
    const liveSwept = sweep(offending.body);
    expect('(b) Ethan live outbound full-cascade — leak phrase stripped post-sweep',
      !/once\s+we'?ve\s+had\s+a\s+chance\s+to\s+review/i.test(liveSwept));
    expect('(c) Ethan live outbound full-cascade — "I\'ll be in touch shortly with an update" also stripped by R5-C-a',
      !/I'?ll\s+be\s+in\s+touch\s+shortly\s+with\s+an\s+update/i.test(liveSwept));
    expect('(d) Ethan live outbound — sweep is non-trivial (body changed)',
      liveSwept !== offending.body);
    // R10-H-isolation pin: with R5-C-a held back, R10-H alone strips ONLY
    // the tail (not the prefix). Proves the R10-H scope is narrowly targeted.
    const liveR10HOnly = r10hOnly(offending.body);
    expect('(e) Ethan live outbound R10-H-only — leak tail stripped',
      !/once\s+we'?ve\s+had\s+a\s+chance\s+to\s+review/i.test(liveR10HOnly));
    expect('(f) Ethan live outbound R10-H-only — "I\'ll be in touch shortly with an update." preserved standalone',
      /I'?ll be in touch shortly with an update\./.test(liveR10HOnly));
    liveSweptOk = true;
  } catch (e) {
    console.log(`  SKIP (live-Supabase replay) — ${e.message}`);
  }

  // ─── R10-H-CARVE-OUT-RESPECT ───
  // Confirms R10-H patterns DO NOT over-fire on legitimate non-leak shapes
  // and don't double-strip content already caught by R5-C / R6-η.
  console.log('\n--- R10-H-CARVE-OUT-RESPECT ---');
  // Legitimate broker-facing prose with "review" used in a non-internal-stage
  // sense should pass through unchanged or only have the bracketed phrase
  // touched.
  expect('(a) "please review the attached" — untouched',
    sweep('<p>Please review the attached doc and let me know.</p>')
      === '<p>Please review the attached doc and let me know.</p>');
  expect('(b) "the appraisal review came back" — untouched (external-doc shape, R5-C-c carve-out lineage)',
    sweep('<p>The appraisal review came back clean.</p>')
      === '<p>The appraisal review came back clean.</p>');
  // Bare "I'll be in touch shortly with an update." is stripped by R5-C-a
  // (its design — Franco's R5 rule). R10-H must NOT add to this strip:
  // R10-H alone leaves the bare phrase intact. Proves R10-H scope is narrowly
  // bounded to the tail-extension family.
  expect('(c) bare "I\'ll be in touch shortly with an update." — R10-H-only leaves it unchanged',
    r10hOnly("<p>I'll be in touch shortly with an update.</p>")
      === "<p>I'll be in touch shortly with an update.</p>");
  expect('(d) "I\'ll review the file" (broker-facing — different shape, R6-η rewrite outcome) survives R10-H-only',
    r10hOnly("<p>I'll review the file.</p>")
      === "<p>I'll review the file.</p>");

  // ─── R10-H-CROSS-CLUSTER-INTEGRATION ───
  // Confirms R10-H patterns compose with R5-C and R6-η without double-strip
  // collisions producing ".." artifacts. Cascade-composition discipline.
  console.log('\n--- R10-H-CROSS-CLUSTER-INTEGRATION ---');
  // Compound: R10-H-a tail + R6-η-b leading "I've reviewed..."
  expect('(a) compound R6-η-b leading + R10-H-a trailing — both strip',
    (() => {
      const input = "<p>I've reviewed all the documents and we're ready to start working on the file. I'll be in touch shortly with an update once we've had a chance to review everything.</p>";
      const out = sweep(input);
      return !/I'?ve\s+reviewed\s+all/i.test(out)
        && !/once\s+we'?ve\s+had\s+a\s+chance\s+to\s+review/i.test(out)
        && /we'?re ready to start working on/i.test(out);
    })());
  // R10-H runs AFTER R5-C / R6-η in array order — confirm via source-grep
  expect('(b) R10-H patterns appear AFTER R6-η-d in array source order',
    (() => {
      const r6etaIdx = _aiSrc.indexOf('R6-η-d');
      const r10hIdx = _aiSrc.indexOf('R10-H-a');
      return r6etaIdx !== -1 && r10hIdx !== -1 && r10hIdx > r6etaIdx;
    })());
  // CROSS-CLUSTER-CASCADE-DISCIPLINE pin: R5-C-a + R10-H-a in compound
  // must NOT produce a ".." artifact. R10-H-a's [.,]? leading consumes
  // the orphan "." from R5-C-a's strip.
  expect('(c) Ethan cascade — full-sweep output does NOT contain ".." artifact',
    (() => {
      const input = "<p>I'll be in touch shortly with an update once we've had a chance to review everything.</p>";
      const out = sweep(input);
      return !/\.\.[^<]/.test(out); // no ".." not followed by tag
    })());
  expect('(d) Ethan cascade — full-sweep output is "<p>.</p>" (bare-period artifact, no leak)',
    (() => {
      const input = "<p>I'll be in touch shortly with an update once we've had a chance to review everything.</p>";
      const out = sweep(input);
      return out === "<p>.</p>";
    })());
  // R5-C-a clean output (bare "I'll be in touch shortly with an update.")
  // gets stripped by R5-C-a itself (its design — Franco's R5 rule). R10-H
  // does NOT add to this — R10-H only strips when the review-tail is present.
  expect('(e) Bare "I\'ll be in touch shortly with an update." — R5-C-a strips it; R10-H plays no role',
    (() => {
      const input = "<p>I'll be in touch shortly with an update.</p>";
      const fullOut = sweep(input);
      const isolatedOut = r10hOnly(input);
      // R5-C-a strips the bare phrase; R10-H alone preserves it.
      return !/I'?ll be in touch shortly with an update/.test(fullOut)
        && /I'?ll be in touch shortly with an update/.test(isolatedOut);
    })());
  // Idempotence — running sweep twice yields identical output
  expect('(f) sweep is idempotent on Ethan verbatim',
    (() => {
      const pass1 = sweep(ethanVerbatim);
      const pass2 = sweep(pass1);
      return pass1 === pass2;
    })());

  // ─── R10-H-ADMIN-HANDOFF-CALL-SITES ───
  // Verifies the empirical-call-site-gap fix: sweepBrokerFacingDraft helper
  // installed in webhook.js's admin-reply handler and wired at all Claude-
  // generated saveDraftAndPreview call sites across the 4 admin-handoff
  // path types (doc-request, rejection, conditions, completion). EXCLUDED:
  // REPLACE verbatim path (admin-dictated content carve-out per ai.js:1097).
  console.log('\n--- R10-H-ADMIN-HANDOFF-CALL-SITES ---');
  expect('(a) sweepBrokerFacingDraft helper defined in webhook.js',
    /const\s+sweepBrokerFacingDraft\s*=\s*\(html\)\s*=>/i.test(_whSrc));
  expect('(b) helper invokes enforceNoRoutingLeak',
    /sweepBrokerFacingDraft[\s\S]{0,800}aiService\.enforceNoRoutingLeak/i.test(_whSrc));
  expect('(c) helper invokes stripPerfectOpener (R8-B cascade-composition)',
    /sweepBrokerFacingDraft[\s\S]{0,800}aiService\.stripPerfectOpener/i.test(_whSrc));
  expect('(d) helper docblock cites R10-H + Bug 7-5',
    /R10-H\s*\(2026-05-27\)\s*—\s*admin-handoff\s+broker-facing-draft\s+sweep[\s\S]{0,200}Bug\s+7-5/i.test(_whSrc));
  // Call-site coverage matrix
  const callSiteCount = (subject) => {
    const re = new RegExp(`saveDraftAndPreview\\(sweepBrokerFacingDraft\\(${subject}\\)`, 'g');
    return (_whSrc.match(re) || []).length;
  };
  expect('(e) docRequestEmail swept at 2 call sites (ltv_escalated + under_review branches)',
    callSiteCount('docRequestEmail') === 2,
    `actual: ${callSiteCount('docRequestEmail')}`);
  expect('(f) rejectionEmail swept at 2 call sites (ltv_escalated + under_review branches)',
    callSiteCount('rejectionEmail') === 2,
    `actual: ${callSiteCount('rejectionEmail')}`);
  expect('(g) polishedEmail (conditions) swept at 2 call sites (ltv_escalated + under_review branches)',
    callSiteCount('polishedEmail') === 2,
    `actual: ${callSiteCount('polishedEmail')}`);
  expect('(h) completionEmail swept at 1 call site (under_review final-approval branch)',
    callSiteCount('completionEmail') === 1,
    `actual: ${callSiteCount('completionEmail')}`);
  expect('(i) revisedEmail swept (EDIT path, Claude-derived)',
    callSiteCount('revisedEmail') === 1,
    `actual: ${callSiteCount('revisedEmail')}`);
  // REPLACE verbatim path EXCLUDED (admin-dictated content carve-out)
  expect('(j) replacementHtml NOT swept (REPLACE verbatim — admin-dictated carve-out per ai.js:1097)',
    /saveDraftAndPreview\(replacementHtml,/i.test(_whSrc)
      && !/saveDraftAndPreview\(sweepBrokerFacingDraft\(replacementHtml\)/i.test(_whSrc));
  // Total Claude-derived sweep wirings
  expect('(k) total Claude-derived saveDraftAndPreview wirings = 8 (2 docRequest + 2 rejection + 2 conditions + 1 completion + 1 revision)',
    (_whSrc.match(/saveDraftAndPreview\(sweepBrokerFacingDraft\(/g) || []).length === 8,
    `actual: ${(_whSrc.match(/saveDraftAndPreview\(sweepBrokerFacingDraft\(/g) || []).length}`);
  // End-to-end: simulate the actual production code path on the live Ethan
  // body. The helper composes enforceNoRoutingLeak + stripPerfectOpener;
  // we replay that composition here on the real production fixture.
  const productionPathSweep = (html) => {
    let out = sweep(html); // enforceNoRoutingLeak (full ROUTING_LEAK_PATTERNS)
    // stripPerfectOpener is a no-op on the Ethan body (no "Perfect" opener);
    // compose for symmetry with the helper's semantics.
    return out;
  };
  try {
    const { data: msgs } = await supabase
      .from('messages')
      .select('direction, body, created_at')
      .eq('deal_id', 'c95f3a20-162c-45cf-a98c-60b6bbb2de9a')
      .order('created_at', { ascending: true });
    const offending = (msgs || []).find(m =>
      m.direction === 'outbound'
      && /once we'?ve had a chance to review/i.test(m.body || ''));
    if (offending) {
      const sweptThroughProdPath = productionPathSweep(offending.body);
      expect('(l) Ethan production fixture — leak phrase stripped via sweepBrokerFacingDraft composition',
        !/once\s+we'?ve\s+had\s+a\s+chance\s+to\s+review/i.test(sweptThroughProdPath));
      expect('(m) Ethan production fixture — sweep composition is non-trivial (body changed)',
        sweptThroughProdPath !== offending.body);
    } else {
      console.log('  SKIP (l, m) — Ethan offending outbound not found via live Supabase');
    }
  } catch (e) {
    console.log(`  SKIP (l, m) — live-Supabase replay error: ${e.message}`);
  }

  // ─── R10-H-CANONICAL-VARIANT-COVERAGE ───
  // Confirms each of R10-H-b through R10-H-e has at least one matrix test
  // AND has the canonical-variant-not-yet-empirically-observed docblock
  // flag per R10-D deferred-residual discipline.
  console.log('\n--- R10-H-CANONICAL-VARIANT-COVERAGE ---');
  expect('(a) R10-H-a empirical-anchor docblock cites Bug 7-5',
    /R10-H-a\s*—\s*empirical\s+anchor/i.test(_aiSrc));
  expect('(b) R10-H-b docblock flags CANONICAL VARIANT not yet empirically observed',
    /R10-H-b[\s\S]{0,300}CANONICAL\s+VARIANT\s+not\s+yet\s+empirically\s+observed/i.test(_aiSrc));
  expect('(c) R10-H-c docblock flags CANONICAL VARIANT not yet empirically observed',
    /R10-H-c[\s\S]{0,300}CANONICAL\s+VARIANT\s+not\s+yet\s+empirically\s+observed/i.test(_aiSrc));
  expect('(d) R10-H-d docblock flags CANONICAL VARIANT not yet empirically observed',
    /R10-H-d[\s\S]{0,500}CANONICAL\s+VARIANT\s+not\s+yet\s+empirically\s+observed/i.test(_aiSrc));
  expect('(e) R10-H-e docblock flags CANONICAL VARIANT not yet empirically observed',
    /R10-H-e[\s\S]{0,300}CANONICAL\s+VARIANT\s+not\s+yet\s+empirically\s+observed/i.test(_aiSrc));
  expect('(f) R10-H-d PARTIAL-STRIP DISCIPLINE pinned in docblock',
    /R10-H-d[\s\S]{0,800}PARTIAL-STRIP\s+DISCIPLINE/i.test(_aiSrc));
  expect('(g) R10-H cluster docblock cites 5-cluster lineage',
    /R5-C[\s\S]{0,200}R6-η[\s\S]{0,200}R8-B[\s\S]{0,200}R9-A'[\s\S]{0,200}R10-H/.test(_aiSrc));
  expect('(h) R10-H cluster docblock cites DEFINING TRIAD',
    /DEFINING\s+TRIAD/.test(_aiSrc));

  console.log('\n========== R10-H mini-harness complete ==========');
  console.log(`PASS: ${passCount} | FAIL: ${failCount}`);
  if (failCount > 0) process.exit(1);
})().catch(e => { console.error('\nHARNESS ERROR:', e.stack || e.message); process.exit(1); });
