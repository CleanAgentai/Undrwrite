const express = require('express');
const router = express.Router();
const { runDailySummary } = require('../cron/dailySummary');

const CRON_SECRET = process.env.CRON_SECRET;

// Protected manual trigger for the daily cron job.
// Use for testing follow-up reminders on demand without waiting for 9 PM MST.
// Requires the X-Cron-Secret header to match the CRON_SECRET env var.
router.post('/run-daily', async (req, res) => {
  if (!CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET is not configured on the server' });
  }

  const providedSecret = req.header('X-Cron-Secret');
  if (providedSecret !== CRON_SECRET) {
    return res.status(403).json({ error: 'Invalid or missing X-Cron-Secret header' });
  }

  res.status(202).json({ status: 'triggered — check logs for results' });

  try {
    await runDailySummary();
  } catch (err) {
    console.error('Manual cron trigger failed:', err);
  }
});

module.exports = router;
