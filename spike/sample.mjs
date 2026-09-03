import fs from "node:fs"; import path from "node:path";
const u = new URL(JSON.parse(fs.readFileSync(path.join(process.env.APPDATA,"claude-code-router","service.json"),"utf8")).url);
const rpc = async (m,a=[]) => { const r = await fetch(`http://127.0.0.1:${u.port}/api/ccr/rpc`,{method:"POST",
  headers:{"Content-Type":"application/json","x-ccr-web-auth":u.searchParams.get("ccr_web_token")},
  body:JSON.stringify({method:m,args:a})}); const j=await r.json();
  if(!j.ok) throw new Error(JSON.stringify(j.error).slice(0,200)); return j.value; };
const rate = Number(process.argv[2]);
const cfg = await rpc("getConfig");
cfg.observability.requestLogSuccessSampleRate = rate;
const pid0 = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA,"claude-code-router","service.json"),"utf8")).pid;
await rpc("saveConfig",[cfg,{applyProfile:false}]);
const pid1 = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA,"claude-code-router","service.json"),"utf8")).pid;
console.log(`sampleRate -> ${rate}  (pid ${pid0}->${pid1} ${pid0===pid1?"no restart":"RESTARTED"})`);
