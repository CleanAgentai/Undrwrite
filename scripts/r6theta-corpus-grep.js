// R6-θ empirical-closure check — sweep production outbounds for the
// "COMPLETE-in-PRELIMINARY" language bug. Post-R6-ε deploy (commit d407074),
// the stripAndInjectDocumentsIncluded side-effect should remove COMPLETE-
// claiming sentences from broker-facing outbounds when the deal is still
// in PRELIMINARY review status.
//
// Bug shape: Vienna's broker-facing outbound says "the file is COMPLETE" /
// "This file is COMPLETE" / "your file is complete" while the deal hasn't
// passed admin approval (status='under_review' or 'active' without
// prelim_approved_at), implying false closure to the broker.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// R6-ε shipped at d407074 — sometime mid-2026-05-21. Sweep deals created
// after that time to test cascade closure on FRESH corpus.
const R6_EPSILON_DEPLOY_CUTOFF = '2026-05-21T15:00:00Z';

const COMPLETE_LANGUAGE_PATTERNS = [
  /\bThis file is COMPLETE\b/i,
  /\bthe file is COMPLETE\b/i,
  /\byour file is complete\b/i,
  /\bfile is COMPLETE\b/i,
  /\bThe complete package\b/i,
  /\bcomplete package includes\b/i,
  /\bputting together a complete\b/i,
];

// R6-θ scope: BROKER-FACING outbounds only. Admin-facing Snapshots
// legitimately render "This file is COMPLETE" via R6-ε's JS-rendered
// Documents Included block — those are authoritative document-state
// descriptions, not the COMPLETE-in-PRELIMINARY broker-facing bug.
const isAdminFacingSubject = (subject) => {
  if (!subject) return false;
  return (
    /^ACTION REQUIRED:/i.test(subject)
    || /^FINAL REVIEW:/i.test(subject)
    || /^\[UPDATED\] ACTION REQUIRED:/i.test(subject)
    || /^\[Conditions Fulfilled\]/i.test(subject)
    || /^\[File Complete\]/i.test(subject)
    || /Draft Email Preview/i.test(subject)
    || /^Re: \[/i.test(subject)
    || /^Re: ACTION REQUIRED/i.test(subject)
    || /^Re: FINAL REVIEW/i.test(subject)
    || /^Re: \[Conditions Fulfilled\]/i.test(subject)
    || /^Re: \[File Complete\]/i.test(subject)
    || /^Re: Re: ACTION REQUIRED/i.test(subject)
    || /^Re: \[UPDATED\]/i.test(subject)
  );
};

(async () => {
  // Recent outbounds (post-R6-ε-deploy).
  const { data: msgs } = await supabase
    .from('messages')
    .select('id, deal_id, direction, subject, body, created_at')
    .eq('direction', 'outbound')
    .gte('created_at', R6_EPSILON_DEPLOY_CUTOFF)
    .order('created_at', { ascending: false })
    .limit(500);

  // Filter to broker-facing only.
  const brokerFacing = msgs.filter(m => !isAdminFacingSubject(m.subject));
  console.log(`Post-R6-ε-deploy outbounds scanned: ${msgs.length} (broker-facing: ${brokerFacing.length}; admin-facing: ${msgs.length - brokerFacing.length} excluded — R6-θ scope is broker-facing only)`);
  console.log(`Cutoff: ${R6_EPSILON_DEPLOY_CUTOFF}\n`);

  // For each outbound, check if it contains COMPLETE language AND the deal
  // was in a state that would make it inappropriate (PRELIMINARY review or
  // pre-approval). We'll flag the candidates and surface the conversation
  // state.
  const candidates = [];
  for (const m of brokerFacing) {
    const text = (m.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    for (const p of COMPLETE_LANGUAGE_PATTERNS) {
      const hit = text.match(p);
      if (hit) {
        candidates.push({ m, pattern: p.source, hit: hit[0] });
        break; // one pattern hit per msg is enough
      }
    }
  }
  console.log(`COMPLETE-language pattern hits: ${candidates.length}\n`);

  if (candidates.length === 0) {
    console.log('✓ NO post-R6-ε-deploy outbound contains COMPLETE-language patterns. R6-θ side-effect closure empirically clean.');
    process.exit(0);
  }

  // For each candidate, check the deal's status at the time.
  for (const c of candidates) {
    const { data: deal } = await supabase
      .from('deals')
      .select('id, status, borrower_name, created_at, prelim_approved_at')
      .eq('id', c.m.deal_id)
      .single();
    const inappropriate = deal && (
      deal.status === 'under_review'
      || (deal.status === 'active' && !deal.prelim_approved_at)
    );
    console.log(`──────── ${c.m.direction.toUpperCase()} ${c.m.created_at} ${c.m.deal_id.slice(0, 8)}… ${inappropriate ? '⚠ INAPPROPRIATE' : 'OK (post-approval)'} ────────`);
    console.log(`  deal status: ${deal?.status}; prelim_approved_at: ${deal?.prelim_approved_at}; borrower: ${deal?.borrower_name}`);
    console.log(`  subject: ${c.m.subject}`);
    console.log(`  pattern: ${c.pattern}`);
    console.log(`  hit: "${c.hit}"`);
    // Print 200 chars of context around the hit.
    const text = (c.m.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const idx = text.search(new RegExp(c.pattern, 'i'));
    if (idx >= 0) {
      const ctx = text.slice(Math.max(0, idx - 100), Math.min(text.length, idx + 250));
      console.log(`  context: ...${ctx}...`);
    }
    console.log();
  }

  // Summary.
  const inappropriateCount = candidates.filter(c => true).length; // placeholder; compute below
  let inappropriateActual = 0;
  for (const c of candidates) {
    const { data: deal } = await supabase
      .from('deals')
      .select('status, prelim_approved_at')
      .eq('id', c.m.deal_id)
      .single();
    if (deal && (
      deal.status === 'under_review'
      || (deal.status === 'active' && !deal.prelim_approved_at)
    )) {
      inappropriateActual++;
    }
  }
  console.log(`\n══════════ SUMMARY ══════════`);
  console.log(`Total pattern hits: ${candidates.length}`);
  console.log(`In INAPPROPRIATE context (pre-approval): ${inappropriateActual}`);
  if (inappropriateActual === 0) {
    console.log('✓ R6-θ side-effect closure empirically clean — all hits are in POST-APPROVAL context (admin already approved, COMPLETE language is legitimate).');
  } else {
    console.log(`⚠ ${inappropriateActual} hits in PRE-APPROVAL context — R6-θ NOT closed; fresh diagnosis needed.`);
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
