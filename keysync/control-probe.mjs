import fs from 'node:fs';
const P=JSON.parse(fs.readFileSync('C:/Users/osami/.llmkeys/providers.json','utf8'));
const FORB=['tabitoken.com','gorouter.app'];
const jobs=[];
for(const p of P){ if(!p.baseUrl) continue; let u; try{u=new URL(p.baseUrl)}catch{continue}
  if(FORB.some(f=>u.hostname.includes(f))) continue;
  jobs.push({prov:p.provider,url:p.baseUrl.replace(/\/+$/,'')+'/zzz-control-nonexistent-9f3a'});
  jobs.push({prov:p.provider,url:u.origin+'/api/zzz-control-nonexistent-9f3a'});
}
let i=0; const out=[];
async function w(){ while(i<jobs.length){ const j=jobs[i++];
  const c=new AbortController(); const t=setTimeout(()=>c.abort(),12000);
  try{ const r=await fetch(j.url,{signal:c.signal,redirect:'manual',headers:{'Accept':'application/json','User-Agent':'Mozilla/5.0 census/1.0'}});
    const b=(await r.text()).slice(0,120).replace(/\s+/g,' ');
    out.push(`${j.prov}\t${r.status}\t${j.url}\t${b}`);
  }catch(e){ out.push(`${j.prov}\tERR\t${j.url}\t${e.message}`);} finally{clearTimeout(t);} } }
await Promise.all(Array.from({length:24},w));
out.sort(); console.log(out.join('\n'));
