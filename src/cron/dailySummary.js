const cron = require('node-cron');
const config = require('../config');
const dealsService = require('../services/deals');
const emailService = require('../services/email');
const aiService = require('../services/ai');

const FOLLOW_UP_AFTER_DAYS = 2;
const MAX_REMINDERS = 3;

// Single source of truth for "Franco's timezone." Used by both the cron
// schedule (so we fire at 9 PM Edmonton wall time regardless of DST) and the
// date formatter in the summary header (so the header shows the date Franco
// is sitting in, not the runtime container's UTC date). Bug 13.1 fix.
const ADMIN_TIMEZONE = 'America/Edmonton';

// Format a Date as "Monday, May 4, 2026" in the admin's timezone. Pre-fix this
// inline call had no timeZone option and rendered in the runtime TZ (UTC on
// Render), so a 9 PM MDT May 4 cron fire produced a "Tuesday May 5" header
// because 9 PM MDT = 03:00 UTC May 5. Now deterministic in ADMIN_TIMEZONE.
const formatAdminDate = (date) => date.toLocaleDateString('en-US', {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: ADMIN_TIMEZONE,
});

// Send follow-up reminders to brokers who haven't replied
const runFollowUpReminders = async () => {
  console.log('\n--- Checking for stale deals needing follow-up ---');

  const activeDeals = await dealsService.getActiveDeals();
  // Only follow up on deals waiting for the broker (not Franco).
  // Fix 7 + Group HHH: 'awaiting_collateral' and 'awaiting_identity_confirmation'
  // are also broker-waiting states — Vienna asked the collateral / identity-clash
  // question and is waiting for the broker's reply. Same generic reminder copy as
  // 'active' (Porter's clarifying answer); no tailored gate-specific copy.
  const brokerWaiting = activeDeals.filter(d =>
    d.status === 'active'
    || d.status === 'awaiting_collateral'
    || d.status === 'awaiting_identity_confirmation'
  );

  let remindersSent = 0;
  const remindersLog = []; // Track which deals got reminders for the daily summary

  for (const deal of brokerWaiting) {
    const reminderCount = deal.reminder_count || 0;
    if (reminderCount >= MAX_REMINDERS) {
      console.log(`Deal ${deal.id} (${deal.borrower_name}) — max reminders reached (${reminderCount}), skipping`);
      continue;
    }

    const lastInbound = await dealsService.getLastInboundMessage(deal.id);
    if (!lastInbound) continue;

    const daysSilent = (Date.now() - new Date(lastInbound.created_at).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSilent < FOLLOW_UP_AFTER_DAYS) continue;

    // Check that we haven't already sent a reminder today (avoid double-sends on CRON overlap)
    const lastOutbound = await dealsService.getMessages(deal.id);
    const lastOut = lastOutbound.filter(m => m.direction === 'outbound').pop();
    if (lastOut) {
      const hoursSinceLastOut = (Date.now() - new Date(lastOut.created_at).getTime()) / (1000 * 60 * 60);
      if (hoursSinceLastOut < 20) {
        console.log(`Deal ${deal.id} (${deal.borrower_name}) — outbound sent ${Math.round(hoursSinceLastOut)}h ago, skipping`);
        continue;
      }
    }

    const newReminderNumber = reminderCount + 1;
    console.log(`Deal ${deal.id} (${deal.borrower_name}) — ${Math.round(daysSilent)} days silent, attempting reminder #${newReminderNumber}`);

    // Bug A fix: claim the reminder slot atomically BEFORE doing any other work
    // (Claude API call, email send, etc.). Conditional UPDATE serializes concurrent
    // workers via Postgres row lock — only ONE worker can transition reminder_count
    // from `reminderCount` to `newReminderNumber`; the others get 0 rows back and
    // skip. Production diagnosis: 9 cron fires at 9 PM sent 9 emails to the same
    // broker because the prior 20-hour outbound check was non-atomic. The 20h
    // guard above stays as defense-in-depth (cuts API calls in the no-race path);
    // this claim is the actual lock.
    const { claimed } = await dealsService.claimReminderSlot(deal.id, reminderCount, newReminderNumber);
    if (!claimed) {
      console.log(`Deal ${deal.id} (${deal.borrower_name}) — concurrent worker claimed reminder slot first, skipping`);
      continue;
    }

    try {
      // Group LLL (S12.4): compute missingDocs for this deal and pass to the reminder
      // generator so Vienna can enumerate outstanding items by name (instead of vague
      // "the items we previously requested"). Mirrors webhook.js's missingDocs aggregation
      // logic (line 176-186 + Group C exit_strategy push). Inline duplicate of
      // DOC_SYNONYMS rather than cross-module import — see TODO below.
      const dealDocs = await dealsService.getDocumentsByDeal(deal.id);
      const classifications = dealDocs.map(d => d.classification).filter(Boolean);
      const reminderLoanType = (deal.extracted_data?.loan_type || '').toLowerCase();
      const reminderIsPurchase = /purchas/.test(reminderLoanType) || /purchas/.test(deal.extracted_data?.purpose || '');
      // TODO: extract DOC_SYNONYMS to a shared util if a third consumer surfaces.
      // Currently inlined here and in src/routes/webhook.js (single entry — NOA satisfies income_proof).
      const DOC_SYNONYMS_LOCAL = { income_proof: ['income_proof', 'noa'] };
      const isDocSatisfied = (req, cs) => (DOC_SYNONYMS_LOCAL[req] || [req]).some(c => cs.includes(c));

      // Group EEEE (S12.2): prefer the per-deal intake_asked_items snapshot
      // (stamped at intake time by webhook.js INITIAL branch) over recomputing
      // from current baseRequired. Cross-policy drift caused pre-JJJ/pre-TTT
      // deals to get reminders enumerating items Vienna never asked for.
      // Snapshot may include the non-classification string 'exit_strategy' —
      // filter that separately against extracted_data.exit_strategy. Q6-EEEE:
      // null/empty snapshot falls back to current baseRequired (preserves
      // existing behavior for pre-EEEE deals + deferred-intake states).
      let missingDocs;
      if (Array.isArray(deal.intake_asked_items) && deal.intake_asked_items.length > 0) {
        missingDocs = deal.intake_asked_items.filter(req => req === 'exit_strategy'
          ? !deal.extracted_data?.exit_strategy
          : !isDocSatisfied(req, classifications));
      } else {
        const baseRequired = reminderIsPurchase
          ? ['government_id', 'appraisal', 'property_tax', 'income_proof', 'credit_report', 'purchase_contract']
          : ['government_id', 'appraisal', 'property_tax', 'mortgage_statement', 'income_proof', 'credit_report'];
        missingDocs = baseRequired.filter(req => !isDocSatisfied(req, classifications));
        if (!deal.extracted_data?.exit_strategy) missingDocs.push('exit_strategy');
      }

      const reminderEmail = await aiService.generateFollowUpReminder(
        deal.extracted_data,
        daysSilent,
        newReminderNumber,
        missingDocs
      );

      // Use the LAST OUTBOUND subject (what the recipient actually has in their inbox)
      // as the basis for the reminder — NOT the last inbound subject. For referrals, the
      // last inbound is Franco's email to Vienna, which the referred person never saw —
      // using that subject breaks thread continuity in their inbox.
      const reminderBaseSubject =
        lastOut?.subject ||
        lastInbound.subject ||
        deal.extracted_data?.borrower_name ||
        'Your Loan Inquiry';
      const reminderSubject = reminderBaseSubject.startsWith('Re:') ? reminderBaseSubject : `Re: ${reminderBaseSubject}`;

      // Thread with the last outbound message so the reminder appears in the same conversation.
      // Set BOTH In-Reply-To (for Apple Mail / strict clients) AND References (full chain for Gmail / Outlook).
      // Postmark sets outbound Message-IDs as <uuid@mtasv.net> — verified from actual email source.
      // We store just the UUID in external_message_id, so we must append the @mtasv.net suffix
      // when constructing threading headers so they match what recipient clients actually cached.
      const formatMessageId = (id) => (id.includes('@') ? `<${id}>` : `<${id}@mtasv.net>`);
      const lastOutboundId = await dealsService.getLastOutboundMessageId(deal.id);
      const allMessageIds = await dealsService.getAllMessageIdsForThread(deal.id);
      const reminderHeaders = [];
      if (lastOutboundId) {
        reminderHeaders.push({ Name: 'In-Reply-To', Value: formatMessageId(lastOutboundId) });
      }
      if (allMessageIds.length > 0) {
        const referencesValue = allMessageIds.map(formatMessageId).join(' ');
        reminderHeaders.push({ Name: 'References', Value: referencesValue });
      }

      const result = await emailService.sendEmail(
        deal.email,
        reminderSubject,
        reminderEmail.replace(/<[^>]*>/g, ''),
        reminderEmail,
        [],
        reminderHeaders
      );

      // Counter was already incremented via claimReminderSlot — do NOT call
      // dealsService.update with reminder_count here (would be a redundant write).
      await dealsService.saveMessage(deal.id, 'outbound', reminderSubject, reminderEmail, result.MessageID);
      remindersSent++;
      remindersLog.push({
        borrower: deal.borrower_name,
        email: deal.email,
        daysSilent: Math.round(daysSilent),
        reminderNumber: newReminderNumber,
      });
      console.log(`Reminder #${newReminderNumber} sent to ${deal.email}`);
    } catch (err) {
      console.error(`Failed to send reminder for deal ${deal.id}:`, err.message);
      // Roll back the slot since the email never went out. If rollback fails
      // (someone else has touched the counter since), accept that the broker
      // gets one fewer reminder — self-corrects on next cron via MAX_REMINDERS.
      try {
        const { released } = await dealsService.releaseReminderSlot(deal.id, newReminderNumber, reminderCount);
        if (!released) {
          console.warn(`Deal ${deal.id} — rollback skipped (counter changed by another worker); broker will get one fewer reminder, self-corrects on next cron`);
        }
      } catch (rollbackErr) {
        console.error(`Deal ${deal.id} — rollback failed: ${rollbackErr.message}; counter may be high, broker will get one fewer reminder`);
      }
    }
  }

  console.log(`Follow-up reminders sent: ${remindersSent}`);
  return remindersLog;
};

// Group MMM (S13.1): admin replies leak into "Emails Received" because they're
// saved with direction='inbound' under existing deals (webhook admin-reply path
// needs them in conversation history for HITL drafting). Subject heuristic —
// admin replies inherit Vienna's controlled outbound-to-admin subject prefixes
// after a leading "Re: " chain. Reliable because the prefixes are all enumerated
// in this codebase. Handles nested "Re: Re: ..." chains (multi-turn admin draft
// preview cycles) and optional "[UPDATED]" prefix from Fix 2's update path.
//
// Vienna's outbound-to-admin subject prefixes (the authoritative source — keep
// the regex in sync if any new prefix is added):
//   - "ACTION REQUIRED:" (preliminary review, escalation)
//   - "[UPDATED] ACTION REQUIRED:" (Fix 2 update path)
//   - "FINAL REVIEW:" (all-docs FINAL REVIEW HITL)
//   - "[Conditions Fulfilled]" (Group BBB handoff notice + draft preview)
//   - "[Broker Update]" (passive admin notification)
//
// HHH cross-reference RETIRED: Group HHH (S15.1) shipped without adding a new
// admin-bound subject — awaiting_identity_confirmation is a silent-pending state
// like Fix 7's awaiting_collateral. Admin sees no notification during the gate.
// No regex update needed.
//
// Group DDDD (S6.2): heuristic extracted to src/lib/adminReply.js so webhook.js
// can use it for conversation-log message attribution (admin replies stored as
// inbound were being mis-attributed to broker in generateLeadSummary's render).
const { ADMIN_REPLY_SUBJECT_RE, isAdminReplySubject } = require('../lib/adminReply');

const runDailySummary = async () => {
  console.log('\n========== DAILY SUMMARY CRON ==========');
  console.log('Timestamp:', new Date().toISOString());

  try {
    // Send follow-up reminders first and capture which deals got them
    const remindersLog = await runFollowUpReminders();

    const activeDeals = await dealsService.getActiveDeals();
    const recentMessages = await dealsService.getRecentMessages(24);

    if (activeDeals.length === 0 && recentMessages.length === 0) {
      console.log('No active deals or recent messages — skipping daily summary');
      return;
    }

    // Filter to inbound messages only — Group MMM also excludes admin replies
    // (subject heuristic above) so Franco's own approve/decline/conditions/referral
    // replies don't leak into the "Emails Received" section as if they were broker
    // inbound. The admin replies still live in conversation history for HITL
    // drafting; this filter is read-side only.
    const inbound = recentMessages.filter(m =>
      m.direction === 'inbound' && !isAdminReplySubject(m.subject)
    );

    // Group deals by status
    const dealsByStatus = {};
    for (const deal of activeDeals) {
      if (!dealsByStatus[deal.status]) dealsByStatus[deal.status] = [];
      dealsByStatus[deal.status].push(deal);
    }

    // Build summary data for AI
    const summaryData = {
      date: formatAdminDate(new Date()),
      totalActiveDeals: activeDeals.length,
      dealsByStatus,
      recentActivity: {
        inboundCount: inbound.length,
        inboundMessages: inbound.map(m => ({
          dealBorrower: m.deals?.borrower_name || 'Unknown',
          dealEmail: m.deals?.email,
          dealStatus: m.deals?.status,
          subject: m.subject,
          body: m.body,
          time: m.created_at,
        })),
      },
      dealsAwaitingAction: activeDeals
        .filter(d => d.status === 'ltv_escalated')
        .map(d => ({
          borrower: d.borrower_name,
          email: d.email,
          ltv: d.ltv,
          created: d.created_at,
        })),
      activeDeals: activeDeals.map(d => ({
        borrower: d.borrower_name,
        email: d.email,
        status: d.status,
        ltv: d.ltv,
        reminderCount: d.reminder_count || 0,
        created: d.created_at,
        updated: d.updated_at,
      })),
      automatedReminders: {
        sentToday: remindersLog,
        dealsAtMaxReminders: activeDeals
          .filter(d => (d.reminder_count || 0) >= MAX_REMINDERS)
          .map(d => ({ borrower: d.borrower_name, email: d.email, status: d.status })),
      },
    };

    const summaryEmail = await aiService.generateDailySummary(summaryData);

    await emailService.sendEmail(
      config.adminEmail,
      `Daily Summary — ${summaryData.date}`,
      summaryEmail.replace(/<[^>]*>/g, ''),
      summaryEmail
    );

    console.log('Daily summary sent to', config.adminEmail);
  } catch (error) {
    console.error('Daily summary cron failed:', error);
  }
};

// Run every day at 9:00 PM in the admin's timezone (handles DST automatically
// via IANA TZ — 9 PM MST in winter, 9 PM MDT in summer).
cron.schedule('0 21 * * *', runDailySummary, {
  timezone: ADMIN_TIMEZONE,
});

console.log(`Daily summary cron scheduled — runs at 9:00 PM ${ADMIN_TIMEZONE}`);

// Export for manual triggering/testing. formatAdminDate is exposed for the
// harness to pin Bug 13.1 (timezone wrap on date header).
module.exports = { runDailySummary, runFollowUpReminders, formatAdminDate, ADMIN_TIMEZONE, isAdminReplySubject };
