const postmark = require('postmark');
const config = require('../config');

const client = new postmark.ServerClient(config.postmark.apiToken);

module.exports = client;
