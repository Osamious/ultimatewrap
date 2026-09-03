// Decisive test that does not depend on request logging (which is sampled at 5%)
// or on x-ccr-* headers (absent). A real Anthropic reply carries msg_01… ids plus
// service_tier/inference_geo. Anything routed to tokenharbor/deepseek cannot.
import fs from "node:fs"; import path from "node:path";
const svcF = path.join(process.env.APPDATA,"claude-code-router","service.json");
const u = new URL(JSON.parse(fs.readFileSync(svcF,"utf8")).url);
const rpc = async (m,a=[]) => { const r=await fetch(`http://127.0.0.1:${u.port}/api/ccr/rpc`,{method:"POST",
  headers:{"Content-Type":"application/json","x-ccr-web-auth":u.searchParams.get("ccr_web_token")},
  body:JSON.stringify({method:m,args:a})}); const j=await r.json();
  if(!j.ok) throw new Error(JSON.stringify(j.error).slice(0,300)); return j.value; };

const TARGET="tokenharbor/deepseek-v4-flash:free";
const cfg0=await rpc("getConfig"), KEY=cfg0.APIKEY, PORT=cfg0.gateway?.port??3456;

async function shot(rule,label){
  const c=await rpc("getConfig");
  c.Router=c.Router||{};
  c.Router.rules=(c.Router.rules||[]).filter(r=>r.id!=="uw-fp");
  if(rule) c.Router.rules.push({id:"uw-fp",enabled:true,...rule});
  await rpc("saveConfig",[c,{applyProfile:false}]);
  const after=await rpc("getConfig");
  const live=(after.Router?.rules||[]).filter(r=>r.id==="uw-fp").length;

  let body="";
  try{
    const res=await fetch(`http://127.0.0.1:${PORT}/v1/messages`,{method:"POST",
      headers:{"content-type":"application/json","x-api-key":KEY,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({model:"claude-opus-5",max_tokens:8,messages:[{role:"user",content:"say OK"}]}),
      signal:AbortSignal.timeout(60000)});
    body=await res.text();
  }catch(e){ body=`ERROR ${e.message}`; }
  const anthropic = /"id":"msg_01/.test(body) && /service_tier/.test(body);
  const id=(body.match(/"id":"([^"]{0,24})/)||[])[1]||"-";
  console.log(`${label}\n   rule persisted: ${live}   looks-anthropic: ${anthropic}   id: ${id}`);
}

await shot(null,"1 BASELINE (no rule)");
await shot({type:"condition",condition:{left:"request.body.model",operator:"contains",right:"claude-opus-5"},target:TARGET},
           "2 condition/contains");
await shot({type:"model-prefix",pattern:"claude-opus-5",target:TARGET},"3 model-prefix");
await shot({type:"condition",condition:{left:"request.body.model",operator:"==",right:"claude-opus-5"},target:TARGET},
           "4 condition/== exact");
await shot(null,"5 CLEANUP");
