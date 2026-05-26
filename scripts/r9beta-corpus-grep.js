// R9-B empirical-grounding — LTV inconsistency Deal Snapshot vs subject/
// risk-factors.
//
// Marcus S2 (996a676c): Deal Snapshot 60.7%, subject + Risk Factors 72.8%
// Derek S3 (df33cdbf):  Deal Snapshot 61.8%, subject + Deal Rating 62.4%
//
// Empirical tasks:
//   (a) Pull both preliminary review bodies in full to see each LTV-bearing
//       field verbatim
//   (b) Confirm canonical (computeCombinedLtv) vs hallucinated figures
//   (c) Trace prompt provenance — which generator emits subject vs Deal
//       Snapshot vs Risk Factors vs Deal Rating
//   (d) Look for origin of 72.8% / 62.4% (loan-amount-over-something
//       computation? Or pure confabulation?)
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const stripHtml = s => (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  console.log('R9-B EMPIRICAL GROUNDING — LTV inconsistency Deal Snapshot vs subject/risk-factors');
  console.log('═'.repeat(80));

  for (const [id, label] of [['996a676c-f227-4151-8e19-bf75e180ae85', 'Marcus (S2) — 60.7% canonical, 72.8% hallucinated'], ['df33cdbf-dd7c-4464-96f0-a1b59bfed061', 'Derek (S3) — 61.8% canonical, 62.4% hallucinated']]) {
    console.log('\n' + '═'.repeat(80));
    console.log('DEAL: ' + label + '\n  ' + id);
    console.log('═'.repeat(80));

    const { data: deal } = await supabase
      .from('deals')
      .select('extracted_data, ltv, prelim_approved_at, status')
      .eq('id', id)
      .single();
    const ed = deal.extracted_data || {};

    console.log('\nExtracted state:');
    console.log(`  loan_amount=${ed.loan_amount} | mortgage_amount_requested=${ed.mortgage_amount_requested}`);
    console.log(`  appraised_value=${ed.appraised_value} | property_value=${ed.property_value}`);
    console.log(`  existing_mortgage_balance=${ed.existing_mortgage_balance} | existing_first_mortgage_balance=${ed.existing_first_mortgage_balance}`);
    console.log(`  ltv_percent=${ed.ltv_percent} | combined_ltv=${ed.combined_ltv} | deal.ltv=${deal.ltv}`);
    console.log(`  mortgage_position=${ed.mortgage_position}`);
    console.log(`  loan_type=${ed.loan_type} | purpose=${ed.purpose}`);

    // Recompute combined LTV by hand to verify canonical figure.
    const loan = ed.loan_amount || ed.mortgage_amount_requested;
    const appr = ed.appraised_value || ed.property_value;
    const exist = ed.existing_mortgage_balance || ed.existing_first_mortgage_balance;
    const naive_ltv = appr ? (loan / appr * 100) : null;
    const combined_ltv = appr && exist ? ((exist + loan) / appr * 100) : null;
    console.log('\nRecomputed by hand:');
    console.log(`  naive LTV (loan/appraisal): ${naive_ltv?.toFixed(1)}%`);
    console.log(`  combined LTV ((existing+loan)/appraisal): ${combined_ltv?.toFixed(1)}%`);
    // Try inverse: what would 72.8 or 62.4 represent?
    const hallucinatedLtv = id.startsWith('996') ? 72.8 : 62.4;
    if (appr) {
      const implicitAmount = hallucinatedLtv * appr / 100;
      console.log(`  if hallucinated ${hallucinatedLtv}% were correct: implied amount = $${implicitAmount.toFixed(0)} on appraisal $${appr}`);
    }

    // Now pull preliminary review message
    const { data: msgs } = await supabase
      .from('messages')
      .select('subject, body, created_at')
      .eq('deal_id', id)
      .like('subject', '%PRELIMINARY%')
      .order('created_at', { ascending: true });
    for (const m of msgs || []) {
      console.log('\nPRELIMINARY REVIEW MESSAGE:');
      console.log('  subject: ' + m.subject);
      console.log('  body (full text):');
      const text = stripHtml(m.body);
      console.log('  ' + text.replace(/\n/g, '\n  '));
      // Scan for every "%" occurrence and adjacent number — surface all LTV-bearing claims.
      const pctOccurrences = [...text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
      console.log('\n  All percentage mentions:');
      for (const m of pctOccurrences) {
        const ctxStart = Math.max(0, m.index - 50);
        const ctxEnd = Math.min(text.length, m.index + m[0].length + 50);
        console.log(`    ${m[0]} @ ${m.index} — context: "${text.slice(ctxStart, ctxEnd).replace(/\n/g, ' ')}"`);
      }
    }
  }

  // Code-path discovery: which generator produces preliminary review (subject + Deal Snapshot + Risk Factors)?
  console.log('\n\n' + '═'.repeat(80));
  console.log('CODE-PATH DISCOVERY: preliminary review prompt provenance');
  console.log('═'.repeat(80));
  const { execSync } = require('child_process');
  const grep = (pattern, file, n) => {
    try {
      return execSync(`grep -n "${pattern}" ${file} 2>/dev/null | head -${n || 30} || true`).toString().trim();
    } catch (e) { return ''; }
  };
  console.log('\ngenerateLeadSummary (preliminary review generator):');
  console.log(grep('generateLeadSummary\\|generateAdminLeadSummary\\|sendPreliminaryReviewToAdmin', 'src/routes/webhook.js'));
  console.log('\nai.js — preliminary review prompt body + LTV fields:');
  console.log(grep('Deal Snapshot\\|Combined LTV\\|combinedLtv\\|computeCombinedLtv\\|Risk Factors\\|risk_factors\\|deal_rating', 'src/services/ai.js'));
  console.log('\nADMIN subject line construction:');
  console.log(grep('ACTION REQUIRED.*PRELIMINARY\\|leadSubject\\|reviewSubject\\|PRELIMINARY Review', 'src/routes/webhook.js', 20));
  console.log(grep('ACTION REQUIRED.*PRELIMINARY\\|leadSubject\\|reviewSubject\\|PRELIMINARY Review', 'src/services/ai.js', 20));
  // computeCombinedLtv finally
  console.log('\ncomputeCombinedLtv source:');
  console.log(grep('computeCombinedLtv', 'src/routes/webhook.js', 10));
  console.log(grep('computeCombinedLtv', 'src/services/ai.js', 10));
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
