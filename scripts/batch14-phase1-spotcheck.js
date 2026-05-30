#!/usr/bin/env node
require('dotenv').config();
const fs=require('fs'),path=require('path');
const { runScenario }=require('../test-fixtures/bulletproof/lib/replay');
const { evaluate }=require('../test-fixtures/bulletproof/lib/assertEngine');
const { cleanupRun, listBulletproofDeals }=require('../test-fixtures/bulletproof/lib/cleanupHelper');
const { createClient }=require('@supabase/supabase-js');
const SCEN=path.join(__dirname,'../test-fixtures/bulletproof/scenarios');
const dirOf=p=>fs.readdirSync(SCEN).find(d=>d.startsWith(p+'-')||d===p);
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_KEY);
const run=async(p)=>{ const cap=await runScenario(path.join(SCEN,dirOf(p)),{verbose:false});
  const emails=cap.outboundEmails||[]; const all=emails.map(e=>(e.Subject||'')+'\n'+(e.HtmlBody||e.TextBody||'')).join('\n');
  const snap=emails.filter(e=>/Deal Snapshot/i.test(e.HtmlBody||e.TextBody||'')).pop();
  const snapBody=snap?(snap.HtmlBody||snap.TextBody||''):'';
  const r={ status:cap.finalDealState?.status, prelim:/PRELIMINARY|ACTION REQUIRED/i.test(all),
    combinedRow:(snapBody.match(/Combined LTV \(incl\. existing[^<]*<\/strong>\s*([^<]+)/i)||[])[1],
    loanRow:(snapBody.match(/Loan Amount Requested[^<]*<\/strong>\s*([^<]+)/i)||[])[1],
    valRow:(snapBody.match(/Appraised Value[^<]*<\/strong>\s*([^<]+)/i)||[])[1],
    corpRow:/<strong>\s*Corporate borrower\s*:/i.test(snapBody), acctAsk:/accountant.{0,20}(prepared|financ)|Corporate Financial Statements/i.test(all),
    bug4log:/BUG-4/i.test(all) };
  let evalStatus='?'; try{ const ex=JSON.parse(fs.readFileSync(path.join(SCEN,dirOf(p),'expected.json'),'utf8')); evalStatus=evaluate({scenarioId:p,expected:ex,finalDealState:cap.finalDealState,outboundEmails:emails}).status; }catch{}
  try{await cleanupRun(sb,cap.runTag,{dealId:cap.finalDealState?.id});}catch{}
  return {...r, evalStatus};
};
(async()=>{
  const tasks=process.argv.slice(2);
  for(const t of tasks){
    const r=await run(t);
    console.log(`${t.padEnd(6)} eval=${(r.evalStatus||'').padEnd(22)} dealStatus=${(r.status||'').padEnd(20)} prelim=${r.prelim} loan=${r.loanRow||'-'} val=${r.valRow||'-'} combined=${(r.combinedRow||'-').slice(0,40)} corp=${r.corpRow} acctAsk=${r.acctAsk}`);
  }
  console.log('\nleaked bulletproof deals:', (await listBulletproofDeals(sb)).length);
})();
