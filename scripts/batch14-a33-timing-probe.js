require('dotenv').config();
const path=require('path'),fs=require('fs');
const { runScenario }=require('../test-fixtures/bulletproof/lib/replay');
const { cleanupRun }=require('../test-fixtures/bulletproof/lib/cleanupHelper');
const { createClient }=require('@supabase/supabase-js');
(async()=>{
  const dir=path.join(__dirname,'../test-fixtures/bulletproof/scenarios',fs.readdirSync(path.join(__dirname,'../test-fixtures/bulletproof/scenarios')).find(d=>d.startsWith('A33')));
  const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_KEY);
  for(let i=0;i<4;i++){
    let cap; try{cap=await runScenario(dir,{verbose:false});}catch(e){console.log(`run${i+1} ERR ${e.message}`);continue;}
    const emails=cap.outboundEmails||[];
    const prelim=emails.find(e=>/PRELIMINARY|ACTION REQUIRED/i.test(e.Subject||''));
    const body=prelim?(prelim.HtmlBody||prelim.TextBody||''):'';
    const has410=/410,?0?0?0/.test(body);
    const balRow=(body.match(/(?:Existing\s+(?:First\s+)?Mortgage|1st\s+Mortgage|Mortgage)\s+Balance[^<]*<\/strong>\s*([^<]+)/i)||[])[1];
    const ed=cap.finalDealState?.extracted_data||{};
    console.log(`run${i+1}: prelim=${!!prelim} status=${cap.finalDealState?.status} has410=${has410} balRow=${(balRow||'').trim()} ed.firstBal=${ed.existing_first_mortgage_balance||ed.first_mortgage_balance||null} docs=${(await (require('../src/services/deals')).getDocumentsWithText?cap.finalDealState?.id:'?')}`);
    try{await cleanupRun(sb,cap.runTag,{dealId:cap.finalDealState?.id});}catch{}
  }
})();
