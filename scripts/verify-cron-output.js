require('dotenv').config({ quiet:true });
const ai = require('/Users/porterstanley/Undrwrite/src/services/ai');
const strip = h => (h||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
(async()=>{
  // ---- S13 daily summary ----
  const summaryData = {
    date: 'Thursday, June 11, 2026', totalActiveDeals: 3, inboundCount: 2,
    inboundMessages: [{dealBorrower:'Noah MacKenzie',dealEmail:'p.nowak@x.ca',dealStatus:'active',subject:'New Submission',body:'docs attached',time:new Date().toISOString()}],
    deals: [
      {borrower:'Noah MacKenzie',email:'p.nowak@x.ca',status:'active',ltv:60,reminderCount:2,isStale:true,isAtMaxReminders:false,primarySection:'stale'},
      {borrower:'Kevin Tran',email:'s.chen@x.ca',status:'under_review',ltv:58.8,reminderCount:0,primarySection:'action'},
      {borrower:'Ryan Callahan',email:'r.santos@x.ca',status:'awaiting_collateral',ltv:83.1,reminderCount:1,primarySection:'action'},
    ],
    remindersSentToday: [{borrower:'Noah MacKenzie',reminderNumber:2,missingItems:['Government-Issued ID','Property Tax Assessment','Current Mortgage Payout Statement']}],
  };
  const sum = strip(await ai.generateDailySummary(summaryData));
  console.log('===== S13 DAILY SUMMARY =====\n'+sum.slice(0,1500)+'\n');
  console.log('— has Overview/active count:', /active deal|overview|3 active/i.test(sum));
  console.log('— has Deals Requiring Action:', /requiring action|action|pending (admin |)review|escalat/i.test(sum));
  console.log('— has deals table (borrowers):', /noah|kevin|ryan/i.test(sum) && /mackenzie/i.test(sum));
  console.log('— has Stale section:', /stale/i.test(sum));
  console.log('— has AUTOMATED REMINDERS section:', /reminder/i.test(sum));
  console.log('— no non-deal/staff entries:', !/franco|vienna|admin|test account|staff/i.test(sum.replace(/franco@privatemortgagelink/gi,'')));

  // ---- S12 follow-up reminder ----
  const rem = strip(await ai.generateFollowUpReminder(
    {borrower_name:'Noah MacKenzie', broker_name:'Piotr Nowak', sender_name:'Piotr Nowak'},
    2, 1, ['government_id','property_tax','mortgage_statement'], {greetingFirstName:'Piotr'}
  ));
  console.log('\n===== S12 FOLLOW-UP REMINDER =====\n'+rem.slice(0,800)+'\n');
  console.log('— enumerates Gov ID:', /government[\s-]?issued id|government id/i.test(rem));
  console.log('— enumerates Property Tax:', /property tax/i.test(rem));
  console.log('— enumerates Payout:', /payout|mortgage (payout|statement)/i.test(rem));
  console.log('— NOT vague "items previously requested":', !/items (we |you |)previously requested|the items requested/i.test(rem));
})();
