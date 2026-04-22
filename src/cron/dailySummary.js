const cron = require('node-cron');
const config = require('../config');
const dealsService = require('../services/deals');
const emailService = require('../services/email');
const aiService = require('../services/ai');

const FOLLOW_UP_AFTER_DAYS = 2;
const MAX_REMINDERS = 3;

// Send follow-up reminders to brokers who haven't replied
const runFollowUpReminders = async () => {
  console.log('\n--- Checking for stale deals needing follow-up ---');

  const activeDeals = await dealsService.getActiveDeals();
  // Only follow up on deals waiting for the broker (not Franco)
  const brokerWaiting = activeDeals.filter(d => d.status === 'active');

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
    console.log(`Deal ${deal.id} (${deal.borrower_name}) — ${Math.round(daysSilent)} days silent, sending reminder #${newReminderNumber}`);

    try {
      const reminderEmail = await aiService.generateFollowUpReminder(
        deal.extracted_data,
        daysSilent,
        newReminderNumber
      );

      const originalSubject = lastInbound.subject || deal.extracted_data?.borrower_name || 'Your Loan Inquiry';
      const reminderSubject = originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`;

      // Thread with the last outbound message so the reminder appears in the same conversation.
      // Set BOTH In-Reply-To (for Apple Mail / strict clients) AND References (full chain for Gmail / Outlook).
      const lastOutboundId = await dealsService.getLastOutboundMessageId(deal.id);
      const allMessageIds = await dealsService.getAllMessageIdsForThread(deal.id);
      const reminderHeaders = [];
      if (lastOutboundId) {
        reminderHeaders.push({ Name: 'In-Reply-To', Value: `<${lastOutboundId}>` });
      }
      if (allMessageIds.length > 0) {
        const referencesValue = allMessageIds.map(id => `<${id}>`).join(' ');
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

      await dealsService.saveMessage(deal.id, 'outbound', reminderSubject, reminderEmail, result.MessageID);
      await dealsService.update(deal.id, { reminder_count: newReminderNumber });
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
    }
  }

  console.log(`Follow-up reminders sent: ${remindersSent}`);
  return remindersLog;
};

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

    // Filter to inbound messages only
    const inbound = recentMessages.filter(m => m.direction === 'inbound');

    // Group deals by status
    const dealsByStatus = {};
    for (const deal of activeDeals) {
      if (!dealsByStatus[deal.status]) dealsByStatus[deal.status] = [];
      dealsByStatus[deal.status].push(deal);
    }

    // Build summary data for AI
    const summaryData = {
      date: new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
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

// Run every day at 9:00 PM MST
cron.schedule('0 21 * * *', runDailySummary, {
  timezone: 'America/Edmonton',
});

console.log('Daily summary cron scheduled — runs at 9:00 PM MST');

// Export for manual triggering/testing
module.exports = { runDailySummary };
