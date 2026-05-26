const express = require('express');
const config = require('./config');
const routes = require('./routes');
const { startCron: startDailySummaryCron } = require('./cron/dailySummary');

const app = express();

// JSON body parser with 50mb limit for attachment handling
app.use(express.json({ limit: '50mb' }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Mount routes
app.use(routes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(config.port, () => {
  console.log(`Server running on port ${config.port} in ${config.nodeEnv} mode`);

  // R9-E (2026-05-26): explicitly start the daily-summary cron AFTER server
  // boot. Pre-R9-E this was a bare `require('./cron/dailySummary')` that
  // relied on a module-load side effect; the factory extraction prevents
  // test-trigger.js from accidentally registering the cron in-process and
  // poisoning the production daily_summaries idempotency claim. See
  // dailySummary.js startCron docblock for the empirical evidence chain.
  startDailySummaryCron();
});
