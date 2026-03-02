const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');

const client = new Anthropic({
  apiKey: config.claude.apiKey,
});

module.exports = client;
