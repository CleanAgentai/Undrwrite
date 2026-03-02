require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  postmark: {
    apiToken: process.env.POSTMARK_API_TOKEN,
    senderEmail: process.env.POSTMARK_SENDER_EMAIL,
  },
  claude: {
    apiKey: process.env.CLAUDE_API_KEY,
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
  },
};
