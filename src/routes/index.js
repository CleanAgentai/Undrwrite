const express = require('express');
const router = express.Router();

const webhookRoutes = require('./webhook');

router.use('/webhook', webhookRoutes);

module.exports = router;
