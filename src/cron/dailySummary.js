const cron = require('node-cron');
const config = require('../config');
const dealsService = require('../services/deals');
const emailService = require('../services/email');
const aiService = require('../services/ai');

const runDailySummary = async () => {
  console.log('\n========== DAILY SUMMARY CRON ==========');
  console.log('Timestamp:', new Date().toISOString());

  try {
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
        created: d.created_at,
        updated: d.updated_at,
      })),
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

// Run every day at 5:00 PM MST
cron.schedule('0 17 * * *', runDailySummary, {
  timezone: 'America/Edmonton',
});

console.log('Daily summary cron scheduled — runs at 5:00 PM MST');

// Export for manual triggering/testing
module.exports = { runDailySummary };
