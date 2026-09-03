import fs from 'node:fs';

const PROVIDERS = JSON.parse(fs.readFileSync('C:/Users/osami/.llmkeys/providers.json','utf8'));
const FORBIDDEN = ['tabitoken.com','gorouter.app'];

const ORIGIN_PATHS = [
  '/api/pricing','/api/status','/api/user/self','/api/about','/api/models',
  '/api/user/dashboard','/api/ratio_config'
];
const BASE_PATHS = [
  '/key','/credits','/me','/usage','/balance','/account','/user/info',
  '/subscription','/quota','/organization/costs','/dashboard/billing/subscription',
  '/dashboard/billing/credit_grants','/models'
];

const args = process.argv.slice(2);
const only = args[0] || null;   // substring filter on provider name
const mode = args[1] || 'all';  // 'origin' | 'base' | 'all'

function targets(p){
  const out=[];
  if(!p.baseUrl) return out;
  let u; try{ u=new URL(p.baseUrl);}catch{return out;}
  if(FORBIDDEN.some(f=>u.hostname.includes(f))) return out;
  const origin = u.origin;
  const base = p.baseUrl.replace(/\/+$/,'');
  if(mode==='origin'||mode==='all') for(const path of ORIGIN_PATHS) out.push({kind:'origin',url:origin+path,path});
  if(mode==='base'||mode==='all')   for(const path of BASE_PATHS)   out.push({kind:'base',url:base+path,path});
  return out;
}

async function probe(t){
  const ctl = new AbortController();
  const timer = setTimeout(()=>ctl.abort(), 12000);
  try{
    const r = await fetch(t.url, {method:'GET', signal:ctl.signal, redirect:'manual',
      headers:{'Accept':'application/json','User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) endpoint-census/1.0'}});
    const ct = r.headers.get('content-type')||'';
    let body='';
    try{ body = (await r.text()).slice(0,600); }catch{}
    const rl = [...r.headers.keys()].filter(h=>/ratelimit|retry-after|credit|quota|balance/i.test(h));
    return {...t, status:r.status, ct:ct.split(';')[0], len:body.length, rl, body:body.replace(/\s+/g,' ').slice(0,400)};
  }catch(e){
    return {...t, status:'ERR', ct:'', len:0, rl:[], body:String(e.message||e).slice(0,120)};
  } finally { clearTimeout(timer); }
}

const list = PROVIDERS.filter(p=> !only || p.provider.includes(only));
const results=[];
for(const p of list){
  const ts = targets(p);
  const chunk = [];
  for(let i=0;i<ts.length;i+=6){
    const batch = ts.slice(i,i+6);
    chunk.push(...await Promise.all(batch.map(probe)));
  }
  for(const r of chunk){
    if(r.status===404 || r.status==='ERR' && /ENOTFOUND|abort/i.test(r.body)) continue;
    results.push({provider:p.provider, ...r});
    console.log(`${p.provider}\t${r.status}\t${r.ct}\t${r.url}\t${r.rl.join(',')}\t${r.body.slice(0,180)}`);
  }
}
fs.writeFileSync('C:/Users/osami/.uw/keysync/probe-account-endpoints.json', JSON.stringify(results,null,1));
console.error('DONE '+results.length+' non-404 rows');
