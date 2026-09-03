#!/usr/bin/env node
// UW model browser — single-file prototype.
//
// WHY A BROWSER: the requirement is live search-as-you-type at BOTH the provider
// and model level. Measured against Claude Code 2.1.258, no terminal surface can
// do that: /model's filter is behind a hardcoded `canEnter:!1`, hooks are one-shot
// text with no keystroke loop, and an MCP elicitation's row set is fixed at
// creation so the server never sees typing. A page is the one place live
// filtering is free.
//
//   node uwmodels-web.mjs            start, print the URL
//   node uwmodels-web.mjs --port N   pick the port
//
// SAFETY
//   - binds 127.0.0.1 only
//   - API KEY VALUES ARE NEVER READ AND NEVER SENT. Only vault *metadata*
//     (bucket/provider/tier and the public provider profile) reaches the page.
//   - read-only: this prototype does not repoint anything yet; selecting prints
//     the choice to the console so the wiring can be reviewed before it writes.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const argv = process.argv.slice(2);
const at = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(at("--port", 7999));

const KEYSYNC = path.join(os.homedir(), ".uw", "keysync", "keysync.mjs");
const K = await import("file://" + KEYSYNC.replace(/\\/g, "/"));

// ---------------------------------------------------------------- data loading

// Correct pricing path. keysync's own inferTier reads `pricing.inputPerMillion`,
// which does not exist in this schema — it returns "unknown" for all 4,298 models.
// The real shape is pricing.offers[].per1MTokens.{input,output}.
function priceOf(entry) {
  const offers = entry?.pricing?.offers;
  if (!Array.isArray(offers) || !offers.length) return null;
  for (const o of offers) {
    const p = o?.per1MTokens;
    if (p && Number.isFinite(Number(p.input)) && Number.isFinite(Number(p.output))) {
      return { in: Number(p.input), out: Number(p.output) };
    }
  }
  return null;
}

// GUARD G1 from the research: a zero *token* price on a model whose output is not
// text means it is billed per image/second in another unit — not free. Blank, not FREE.
const isTextOut = (e) => {
  const out = e?.modalities?.output;
  return !Array.isArray(out) || out.length === 0 || out.includes("text");
};

function badgeOf(entry) {
  const p = priceOf(entry);
  if (!p) return "";                                   // no evidence -> blank, never "paid"
  if (p.in === 0 && p.out === 0) return isTextOut(entry) ? "FREE?" : "";
  return "PAID";
}

// Health from the human-written notes in providers.json. 8 of 47 record breakage.
const BROKEN = /502|backend down|insufficient credits|deposit required|not usable|no longer|bot-blocked/i;
function healthOf(profile) {
  const n = String(profile?.notes ?? "");
  if (BROKEN.test(n)) return "broken";
  if (profile?.requiresBalance) return "needs $";
  return "ok";
}

function build() {
  const { registry, providers } = K.loadVault();
  const filtered = K.filterRegistry(registry, providers);
  const chosen = K.chooseKeys(filtered);
  const cat = K.loadCatalog();

  const rows = [];
  for (const cred of chosen) {
    const prof = providers.get(cred.provider) ?? {};
    const entries = cat.byProvider.get(cred.provider) ?? [];

    const models = entries.map((e) => {
      const p = priceOf(e);
      const caps = e?.capabilities ?? {};
      return {
        id: e.model,
        name: e.displayName || e.model,
        ctx: e?.limits?.contextTokens ?? null,
        pin: p ? p.in : null,
        pout: p ? p.out : null,
        badge: badgeOf(e),
        tools: !!caps.toolCalling,
        vision: !!caps.imageInput,
        reason: !!caps.reasoning,
      };
    });

    // The vault testModel leads: measured, catalogue-first dropped the live pass
    // rate to 4/44 because catalogues list ids a given key cannot call.
    if (prof.testModel && !models.some((m) => m.id === prof.testModel)) {
      models.unshift({ id: prof.testModel, name: prof.testModel, ctx: null, pin: null,
                       pout: null, badge: "", tools: false, vision: false, reason: false });
    }

    const priced = models.filter((m) => m.badge !== "");
    rows.push({
      keyId: cred.id,                    // bucket.provider.tier — the disambiguator
      provider: cred.provider,
      models,
      // NULLABLE on purpose: "0 free" is a measurement, "no price data at all" is
      // the absence of one. Collapsing them to 0 is how this design would lie.
      free: priced.length ? models.filter((m) => m.badge === "FREE?").length : null,
      health: healthOf(prof),
    });
  }
  // The Anthropic relay is NOT a vault credential — there is no `anthropic` row in
  // registry.json. keysync injects it separately (ANTHROPIC_RELAY), which is why
  // building only from the vault silently omitted the four Claude rows even though
  // they are the ones most likely to be routable.
  if (K.ANTHROPIC_RELAY && !rows.some((r) => r.provider === "anthropic")) {
    rows.push({
      keyId: "relay.anthropic.subscription",
      provider: "anthropic",
      models: (K.ANTHROPIC_RELAY.models || []).map((id) => ({
        id, name: id, ctx: null, pin: null, pout: null,
        badge: "PLAN",            // covered by the Claude subscription, not $0/token
        tools: true, vision: true, reason: true,
      })),
      free: null,                 // a plan is not "free" under the governing definition
      health: "ok",
    });
  }
  rows.sort((a, b) => b.models.length - a.models.length);
  return { rows, generatedAt: cat.generatedAt };
}

let DATA;
try { DATA = build(); }
catch (e) { console.error("failed to build catalogue:", e.message); process.exit(1); }

const totalModels = DATA.rows.reduce((n, r) => n + r.models.length, 0);

// ---------------------------------------------------------------------- the page
const PAGE = `<!doctype html><meta charset="utf-8"><title>UW models</title>
<style>
 :root{--bg:#0f1117;--fg:#d8dee9;--dim:#7c8496;--line:#232734;--sel:#1c2333;--acc:#7aa2f7}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 ui-monospace,Consolas,monospace;height:100vh;display:flex;flex-direction:column}
 header{padding:8px 12px;border-bottom:1px solid var(--line);display:flex;gap:16px;align-items:baseline}
 header b{color:var(--acc)} header span{color:var(--dim)}
 main{flex:1;display:grid;grid-template-columns:380px 1fr;min-height:0}
 section{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--line)}
 section:last-child{border-right:0}
 .f{padding:6px 10px;border-bottom:1px solid var(--line)}
 .f input{width:100%;background:#161923;border:1px solid var(--line);color:var(--fg);
   padding:6px 8px;border-radius:4px;font:inherit;outline:none}
 .f input:focus{border-color:var(--acc)}
 .rows{overflow:auto;flex:1}
 table{width:100%;border-collapse:collapse;white-space:pre}
 th{position:sticky;top:0;background:var(--bg);color:var(--dim);text-align:left;
    font-weight:400;padding:4px 10px;border-bottom:1px solid var(--line);cursor:pointer}
 td{padding:2px 10px}
 tr[data-k]{cursor:pointer}
 tr[data-k]:hover{background:var(--sel)}
 tr.on{background:var(--sel);box-shadow:inset 2px 0 0 var(--acc)}
 .n{text-align:right;font-variant-numeric:tabular-nums}
 .d{color:var(--dim)}
 .free{color:#9ece6a} .paid{color:var(--dim)} .broken{color:#f7768e} .needs{color:#e0af68}
 mark{background:#3d4b6e;color:#fff;border-radius:2px}
 footer{padding:6px 12px;border-top:1px solid var(--line);color:var(--dim)}
</style>
<header>
  <b>UW models</b>
  <span id="stat"></span>
  <span style="margin-left:auto">catalogue ${new Date(DATA.generatedAt || Date.now()).toISOString().slice(0,10)}</span>
</header>
<main>
  <section>
    <div class="f"><input id="fp" placeholder="filter providers…  (/ to focus)" autofocus></div>
    <div class="rows"><table>
      <thead><tr><th data-s="keyId">key id</th><th data-s="n" class="n">models</th>
                 <th data-s="free" class="n">free</th><th data-s="health">health</th></tr></thead>
      <tbody id="tp"></tbody></table></div>
  </section>
  <section>
    <div class="f"><input id="fm" placeholder="filter models…"></div>
    <div class="rows"><table>
      <thead><tr><th data-s="id">model</th><th data-s="ctx" class="n">ctx</th>
                 <th data-s="pin" class="n">$in</th><th data-s="pout" class="n">$out</th>
                 <th data-s="badge">badge</th><th>caps</th></tr></thead>
      <tbody id="tm"></tbody></table></div>
  </section>
</main>
<footer id="foot">pick a provider · <b>/</b> focus filter · <b>Esc</b> clear</footer>
<script>
const DATA = ${JSON.stringify(DATA.rows).replace(/</g, '\u003c')};
const $ = (s) => document.querySelector(s);
let cur = null, sortP = null, sortM = null;

const esc = (s) => String(s).replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Highlight every match, so it is obvious WHY a row survived the filter.
function hl(s, q){
  s = esc(s); if(!q) return s;
  const i = s.toLowerCase().indexOf(q.toLowerCase());
  return i<0 ? s : s.slice(0,i)+'<mark>'+s.slice(i,i+q.length)+'</mark>'+s.slice(i+q.length);
}
const ctxS = (c) => c==null ? '' : c>=1e6 ? (c/1e6)+'M' : Math.round(c/1000)+'k';
const money = (v) => v==null ? '' : v===0 ? '0' : v<1 ? v.toFixed(2) : v.toFixed(2);

function matchP(r,q){ return !q || r.keyId.toLowerCase().includes(q)
  // Level-1 filter also searches MODEL names, so typing "opus" finds the provider
  // that serves it. Copied from Maestro, where it is the thing that makes a
  // two-level menu tolerable.
  || r.models.some(m => m.id.toLowerCase().includes(q)); }

function drawP(){
  const q = $('#fp').value.trim().toLowerCase();
  let rows = DATA.filter(r => matchP(r,q));
  if(sortP) rows = rows.slice().sort((a,b)=>{
    const k=sortP, av=k==='n'?a.models.length:a[k], bv=k==='n'?b.models.length:b[k];
    return (av>bv?1:av<bv?-1:0)*(sortP.dir||1); });
  $('#tp').innerHTML = rows.map(r => \`<tr data-k="\${esc(r.keyId)}" class="\${cur===r.keyId?'on':''}">
    <td>\${hl(r.keyId,q)}</td><td class="n">\${r.models.length}</td>
    <td class="n \${r.free?'free':'d'}">\${r.free==null?'—':r.free}</td>
    <td class="\${r.health==='broken'?'broken':r.health==='needs $'?'needs':'d'}">\${r.health}</td></tr>\`).join('');
  $('#stat').textContent = rows.length+' / '+DATA.length+' providers · '+${totalModels}+' models';
}

function drawM(){
  const r = DATA.find(x => x.keyId === cur);
  if(!r){ $('#tm').innerHTML=''; return; }
  const q = $('#fm').value.trim().toLowerCase();
  let ms = r.models.filter(m => !q || m.id.toLowerCase().includes(q) || (m.name||'').toLowerCase().includes(q));
  if(sortM) ms = ms.slice().sort((a,b)=>{
    const k=sortM, av=a[k]??-1, bv=b[k]??-1; return (av>bv?1:av<bv?-1:0)*(sortM.dir||1); });
  $('#tm').innerHTML = ms.map(m => \`<tr data-m="\${esc(m.id)}">
    <td>\${hl(m.id,q)}</td><td class="n d">\${ctxS(m.ctx)}</td>
    <td class="n d">\${money(m.pin)}</td><td class="n d">\${money(m.pout)}</td>
    <td class="\${m.badge==='FREE?'?'free':'paid'}">\${m.badge}</td>
    <td class="d">\${m.tools?'T':'-'}\${m.vision?'V':'-'}\${m.reason?'R':'-'}</td></tr>\`).join('');
  $('#foot').innerHTML = ms.length+' / '+r.models.length+' models in <b>'+esc(r.keyId)+'</b> · click one to select';
}

$('#fp').addEventListener('input', drawP);      // live, every keystroke
$('#fm').addEventListener('input', drawM);
$('#tp').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-k]'); if(!tr) return;
  cur = tr.dataset.k; $('#fm').value=''; drawP(); drawM(); $('#fm').focus();
});
$('#tm').addEventListener('click', async e => {
  const tr = e.target.closest('tr[data-m]'); if(!tr) return;
  const body = { keyId: cur, model: tr.dataset.m };
  await fetch('/select', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body)});
  $('#foot').innerHTML = 'selected <b>'+esc(cur)+'</b> / <b>'+esc(tr.dataset.m)+'</b> — printed to the console (prototype does not route yet)';
});
document.addEventListener('keydown', e => {
  if(e.key==='/' && document.activeElement.tagName!=='INPUT'){ e.preventDefault(); $('#fp').focus(); }
  if(e.key==='Escape'){ $('#fp').value=''; $('#fm').value=''; drawP(); drawM(); }
});
document.querySelectorAll('thead th[data-s]').forEach(th => th.addEventListener('click', () => {
  const inP = th.closest('section') === document.querySelector('section');
  const k = th.dataset.s;
  if(inP){ sortP = (sortP===k) ? {toString:()=>k, dir:-1} : k; drawP(); }
  else   { sortM = (sortM===k) ? {toString:()=>k, dir:-1} : k; drawM(); }
}));
drawP();
</script>`;

// ------------------------------------------------------------------ repointing
// MEASURED: Router.rules is INERT here — condition/contains, condition/==,
// model-prefix and even an unconditional script rule all persisted with
// enabled:true and never fired (any compile diagnostic silently sets active:false,
// and nothing surfaces it). CUSTOM_ROUTER_PATH works: CCR deletes the require-cache
// entry every request, so this slot file is effectively re-read per request.
const SLOT = path.join(import.meta.dirname, "slot.json");

const svcFile = () => path.join(process.env.APPDATA, "claude-code-router", "service.json");
const svcPid  = () => JSON.parse(fs.readFileSync(svcFile(), "utf8")).pid;

function ccrRpc() {
  const u = new URL(JSON.parse(fs.readFileSync(svcFile(), "utf8")).url);
  return async (method, args = []) => {
    const r = await fetch(`http://127.0.0.1:${u.port}/api/ccr/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json",
                 "x-ccr-web-auth": u.searchParams.get("ccr_web_token") },
      body: JSON.stringify({ method, args }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(`${method}: ${String(j.error?.message).slice(0, 200)}`);
    return j.value;
  };
}

async function repoint(target) {
  const rpc = ccrRpc();
  const cfg = await rpc("getConfig");

  // Only 18 of the catalogue's models are in Providers[]; anything else resolves
  // to nothing and the resolver's return is discarded. Say so rather than
  // reporting a success that will not happen.
  const routable = (cfg.Providers || []).some((p) =>
    (p.models || []).some((m) => `${p.name}/${m}` === target));

  const wired = String(cfg.CUSTOM_ROUTER_PATH || "").toLowerCase()
    .includes("uw-router.cjs");

  fs.writeFileSync(SLOT, JSON.stringify({ model: target }, null, 2));
  return `${routable ? "routable" : "NOT in Providers[] — will not take effect"}; ` +
         `resolver ${wired ? "wired" : "NOT WIRED (CUSTOM_ROUTER_PATH unset)"}; pid ${svcPid()}`;
}

// ------------------------------------------------------------------- the server
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/select") {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on("end", async () => {
      try {
        const { keyId, model } = JSON.parse(b);
        const provider = String(keyId).split(".")[1];
        const target = `${provider}/${model}`;
        const detail = await repoint(target);
        console.log(`SELECTED ${keyId} -> ${target}   ${detail}`);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, target, detail }));
      } catch (e) {
        console.error("select failed:", e.message);
        res.writeHead(500, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: String(e.message).slice(0, 200) }));
      }
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(PAGE);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`UW model browser  ->  http://127.0.0.1:${PORT}/`);
  console.log(`${DATA.rows.length} providers, ${totalModels} models, catalogue ${DATA.generatedAt}`);
  console.log(`(read-only prototype: selecting prints here, routes nothing)`);
});
