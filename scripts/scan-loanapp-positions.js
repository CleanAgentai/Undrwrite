require('dotenv').config({ quiet:true });
const fs=require('fs'), path=require('path');
const { extractFormValues } = require('/Users/porterstanley/Undrwrite/src/lib/pdfFormExtract');
const ROOT='/Users/porterstanley/Desktop/UndrWrite Testing';
(async()=>{
  const apps=[];
  function walk(d){ for(const e of fs.readdirSync(d)){ const p=path.join(d,e); if(fs.statSync(p).isDirectory()) walk(p); else if(/loanapplication.*\.pdf$/i.test(e)) apps.push(p); } }
  walk(ROOT);
  console.log('Scenario loan-app mortgage-position annotations:\n');
  for(const p of apps.sort()){
    const ft=String(await extractFormValues(fs.readFileSync(p))||'');
    const second=/\bSecond\s+Mortgage\b/i.test(ft);
    const first=/\bFirst\s+Mortgage\b/i.test(ft);
    const scn=(p.match(/Scenario (\d+)/)||p.match(/Scenario (\d+) docs/)||[,'?'])[1];
    const pos = second?'2nd':first?'1st':'(none)';
    console.log(`  ${(second?'⚠️ 2nd':first?'   1st':'   ---').padEnd(8)} S${scn.padEnd(3)} ${path.basename(p)}`);
  }
})();
