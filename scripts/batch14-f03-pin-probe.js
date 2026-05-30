require('dotenv').config();
const path=require('path');
const { runScenario }=require('../test-fixtures/bulletproof/lib/replay');
const { cleanupRun }=require('../test-fixtures/bulletproof/lib/cleanupHelper');
const { createClient }=require('@supabase/supabase-js');
(async()=>{
  const dir=path.join(__dirname,'../test-fixtures/bulletproof/scenarios/F03-corporate-refi-65ltv');
  const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_KEY);
  for(let i=0;i<4;i++){
    let cap; try{cap=await runScenario(dir,{verbose:false});}catch(e){console.log(`run${i+1} ERR`);continue;}
    const ed=cap.finalDealState?.extracted_data||{};
    // pull the persisted documents for this deal to inspect classification + text presence
    let docInfo='?';
    try{ const {data:docs}=await sb.from('documents').select('classification,extracted_data').eq('deal_id',cap.finalDealState?.id);
      docInfo=(docs||[]).map(d=>`${d.classification}:${((d.extracted_data?.text)||'').length}ch`).join(',');
    }catch{}
    console.log(`run${i+1}: status=${cap.finalDealState?.status} | ed.ltv=${ed.ltv_percent} ed.exBal=${ed.existing_first_mortgage_balance} ed.propVal=${ed.property_value} ed.txn=${ed.transaction_type} | docs[${docInfo}]`);
    try{await cleanupRun(sb,cap.runTag,{dealId:cap.finalDealState?.id});}catch{}
  }
})();
