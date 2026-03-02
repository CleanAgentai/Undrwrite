require('dotenv').config();
const aiService = require('./src/services/ai');

const senderName = 'Adewale Adedapo';
const emailBody = `Hello Franco,
My name is Adewale Adedapo, a Mortgage Broker with Mortgage Architects. I obtained your contact
information through my brother, Teniola Williams, whom I have copied on this email.
I am reaching out to submit a second mortgage opportunity for one of my clients. The borrower currently has a
first mortgage balance of $5,750,000 and is seeking a second mortgage in the amount of $2,100,000. The
most recent appraisal values the property at $13,500,000.
The subject property is located at 2290 Doulton Drive, Mississauga, ON. I have attached the mortgage
application along with the credit bureaus for both applicants for your review.
I have also attached the financial statement for calmtrust and appraisal to this email.
Please let me know if you require any additional information. I look forward to hearing from you.
Kind regards,
Adewale Adedapo`;

(async () => {
  try {
    console.log('Generating response...\n');
    const response = await aiService.generateWelcomeEmail(senderName, emailBody);
    console.log('=== GENERATED EMAIL ===\n');
    console.log(response);
  } catch (error) {
    console.error('Error:', error.message);
  }
})();
