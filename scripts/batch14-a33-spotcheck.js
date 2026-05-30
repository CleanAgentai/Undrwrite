require('dotenv').config();
const path=require('path'),fs=require('fs');
const { runScenario }=require('../test-fixtures/bulletproof/lib/replay');
const { cleanupRun, listBulletproofDeals }=require('../test-fixtures/bulletproof/lib/cleanupHelper');
const { createClient }=require('@supabase/supabase-js');
(async()=>{
  const dir=path.join(__dirname,'../test-fixtures/bulletproof/scenarios',fs.readdirSync(path.join(__dirname,'../test-fixtures/bulletproof/scenarios')).find(d=>d.startsWith('A33')));
  const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_KEY);
  for(let i=0;i<3;i++){
    let cap; try{cap=await runScenario(dir,{verbose:false});}catch(e){console.log(`run${i+1} ERR`);continue;}
    const emails=cap.outboundEmails||[];
    const prelim=emails.find(e=>/PRELIMINARY|ACTION REQUIRED/i.test(e.Subject||''));
    const body=prelim?(prelim.HtmlBody||prelim.TextBody||''):'';
    const balRow=(body.match(/<strong>\s*Existing 1st Mortgage Balance\s*:\s*<\/strong>\s*([^<]+)/i)||[])[1];
    console.log(`run${i+1}: status=${cap.finalDealState?.status} prelim=${!!prelim} ExistingBalRow="${(balRow||'(none)').trim()}" has410=${/410,?0?0?0/.test(body)}`);
    try{await cleanupRun(sb,cap.runTag,{dealId:cap.finalDealState?.id});}catch{}
  }
  console.log('leaked:', (await listBulletproofDeals(sb)).length);
})();
