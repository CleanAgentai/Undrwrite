const express = require('express');
const router = express.Router();

const webhookRoutes = require('./webhook');
const cronRoutes = require('./cron');

router.use('/webhook', webhookRoutes);
router.use('/cron', cronRoutes);

module.exports = router;
