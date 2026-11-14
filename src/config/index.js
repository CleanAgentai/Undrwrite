require('dotenv').config();

const emailProvider = (process.env.EMAIL_PROVIDER || 'postmark').toLowerCase();
// Vienna's own sending address. EMAIL_FROM wins; POSTMARK_SENDER_EMAIL kept for the
// original Postmark deployment.
const emailFrom = process.env.EMAIL_FROM || process.env.POSTMARK_SENDER_EMAIL;

module.exports = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  adminEmail: process.env.ADMIN_EMAIL,
  email: {
    provider: emailProvider,
    from: emailFrom,
    // Domain of the Message-IDs Vienna's outbound mail carries (threading).
    messageIdDomain: process.env.MESSAGE_ID_DOMAIN || (emailProvider === 'resend' ? (emailFrom || '').split('@')[1] : 'mtasv.net'),
  },
  postmark: {
    apiToken: process.env.POSTMARK_API_TOKEN,
    // Legacy name used by the sender denylist and referral parsing — always the
    // active sending address, whichever provider sends.
    senderEmail: emailFrom,
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY,
    webhookSecret: process.env.RESEND_WEBHOOK_SECRET,
  },
  claude: {
    apiKey: process.env.CLAUDE_API_KEY,
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
  },
};
