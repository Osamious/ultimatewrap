# Research: CCR v3.0.22 capabilities for a model catalogue (2026-09-02)

Source: `C:\nvm4w\nodejs\node_modules\@musistudio\claude-code-router\dist\main\cli.js`
(minified, ~2.3MB). Offsets are byte offsets — inspect with
`dd if=cli.js bs=1 skip=N count=M`.

## Summary

| Want | CCR gives | Verdict |
|---|---|---|
| Live per-provider model discovery | `autoFetchModels`, hits `/models`\|`/v1/models` | **free** |
| Refreshable on a timer | yes — 10 min | **free** |
| Persisted results | yes — writes back to config | **free** |
| A models DB (context/pricing/caps) | `dist/models.json`, 4298 models / 217 providers | **free (big)** |
| A gateway endpoint enumerating everything | `GET /v1/models` on :3456 | **free** |
| Per-provider **grouping** in that endpoint | **no** — flat | **build it** |
| Pricing in that endpoint | **no** — dropped | **build it** |
| "List all providers + their models" RPC | **no** | **build it** |
| On-demand refresh-all trigger | **no** `refreshModels` RPC | **build it** |

## 1. Discovery — correction to a common premise

**There is no separate "live-discovered gateway-models map."** The `gatewayModels` map is
built **purely from static config** — `Sd()` at offset **875526**:

```js
function Sd(e){let t=m_e(e.Providers),r=t.map(n=>`${n.providerName}/${n.modelName}`);
for(let n of e.virtualModelProfiles??[])if(h_e(n)){ ... }
return y_e(r)}
```

`m_e` flat-maps `Providers[].models[]`. No network. Discovery is "live" only
**transitively**: `autoFetchModels` fetches and *writes models into
`config.Providers[].models[]`*, which `Sd()` then reads. That persistence hop is the entire
mechanism.

### The discovery loop (offset 2211456+)

```js
var lit=600*1e3,Ru,jB=!1,XE,gm={};
function fit(e){return e.Providers.some(t=>t.autoFetchModels&&Oe(t))}
function Hle(e,t={}){if(gm={...gm,...t},!fit(e)){o2();return}jB=!0,Wle(0)}
```

Scheduler (offset 2214436):
```js
function Wle(e){jB&&(Ru&&clearTimeout(Ru),Ru=setTimeout(()=>{Ru=void 0,
  pit().catch(...).finally(()=>{jB&&Wle(lit)})},e),Ru.unref?.())}
```

- Called from `cpe(e)` at offset **2277396** during service startup. Fires immediately
  (`Wle(0)`), then every `lit` = **600000 ms = 10 minutes**.
- Only runs if **at least one** provider has `autoFetchModels: true`; otherwise `o2()`
  clears the timer entirely.
- In-flight calls deduped via the `XE` singleton promise in `pit()`.

### Per-protocol fetch — `Cot()` at offset 2193348+

```js
async function Cot(e,t,r,n=[]){
 if(t==="openai"){for(let s of e.openaiBaseUrlCandidates){
   let a=await OB(`${s}/models`,{headers:{...HB(r)},method:"GET"},n,r,{model:""}),
   ... let d=F1(c.payload,"openai"); if(d.models.length>0)return{baseUrl:s,...d}}return{models:[]}}
 if(t==="anthropic"){for(let s of e.anthropicBaseUrlCandidates){
   let a=await OB(`${s}/v1/models`,{headers:{...Y1(r)},method:"GET"},n,r,{model:""}), ...}}
 let o=await OB(Vot(UB(e.geminiBaseUrl,"models"),r),{headers:{...WB(r)},method:"GET"},...)}
```

OpenAI → `{base}/models`; Anthropic → `{base}/v1/models`; Gemini → its own shape. It
iterates **base-URL candidates** and stops at the first non-empty list.

### Caching — `JE()` at offset 2187360

```js
var vu=new Map,fm=new Map;
async function JE(e){ble();let t=uot(e),r=vu.get(t);
 if(!e.forceRefresh&&r&&r.expiresAt>Date.now())return r.result;
 let n=fm.get(t);if(n)return n; ...}
```

- **In-memory only**. Dies with the process.
- Cache key `uot()` = JSON of `{apiKeyHash, baseUrl, mode, models, providerPluginsHash,
  protocols, skipModelDiscovery}` — API key is **SHA-256 hashed**, not stored raw.
- TTLs (offset 2187092): `tot=60s` (default/`protocols`), `rot=15s` (`connectivity`),
  `not=10s`. A **failed/empty** result is negative-cached for only 10 s.
- Capped at `FB=500` entries, evicted oldest-expiry-first by `ble()`.
- The auto-refresh loop passes `forceRefresh:true`, so its cycle **bypasses** this cache.

### Failure handling — and the latency problem

```js
}catch(l){let f=zle(l);
 t.logger?.warn?.(`[providers] Failed to refresh models for ${d}: ${f}`),
 o.push({addedModels:[],error:f,fetchedModels:[],provider:d,providerIndex:a})}
```

One provider failing does **not** abort the others. **But the loop is
`for (const [a,c] of e.Providers.entries())` with `await` inside — strictly sequential, not
parallel, with no per-provider timeout visible.** At ~44 providers, one slow provider
stalls the whole cycle. This is the main thing to improve if building on it.

## 2. `autoFetchModels` — merge and persistence

Parsed at offset 941825, accepting four spellings:
```js
autoFetchModels:oM(r.autoFetchModels??r.auto_fetch_models??r.autoRefreshModels??r.auto_refresh_models),
autoFetchKnownModels:nb(r.autoFetchKnownModels??r.auto_fetch_known_models??r.autoRefreshKnownModels??r.auto_refresh_known_models),
```

Merge algorithm (`git`, offset ~2211900):
```js
let f=xit(l,Sit(c)),p=Bu(f.models),
    g=Su(c.autoFetchKnownModels??[],c.models),
    m=!!c.autoFetchKnownModels?.length?jle(g,p):[],
    h=Su(c.models,m),
    E=Su(g,p);
```
with (offsets 2218097 / 2218336):
```js
function Bu(e){let t=new Set,r=[];for(let n of e){let o=n.trim(),i=o.toLowerCase();
  !o||t.has(i)||(t.add(i),r.push(o))}return r}          // trim + case-insensitive dedupe
function Su(...e){return Bu(e.flat())}                   // union
function jle(e,t){let r=new Set(Bu(e).map(n=>n.toLowerCase()));
  return Bu(t).filter(n=>!r.has(n.toLowerCase()))}       // set difference
```

- `m` = newly appeared models.
- `h` = `models[] ∪ newlyAdded` — **purely additive union. Models are NEVER removed.** A
  model deleted upstream stays in config forever.
- `E` = a monotonically growing "ever seen" ledger, so manually deleted models are not
  re-added.
- **First-run guard**: `m` is `[]` unless `autoFetchKnownModels` is already non-empty, so
  the first fetch only seeds the ledger.

**It persists** — `Ait()` at offset 2213100:
```js
async function Ait(e){let t=e.loadConfig??bt,r=e.saveConfig??xl,n=await t(),o=await git(n,e);
 if(!o.changed)return o;
 let i=await t(),s=mit(n,i,o);        // re-load + rebase against concurrent edits
 if(!s.changed)return s;
 let a=await r(s.config),c={...s,config:a};
 await e.onConfigChanged?.(a,c);return c}
```
Load → diff → reload → rebase → save, to avoid clobbering concurrent UI edits. It also
updates `modelDisplayNames`, `modelMetadata`, and propagates new models into profile
allowlists via `Vle()`.

Config lives in `%APPDATA%\claude-code-router\config.sqlite` (SQLite + WAL).

## 3. `ModelRegistry.resolve()` — five stages, not four

Class `Cy`, offset 998474:
```js
constructor(t){this.config=t;this.gatewayModels=new Map(Sd(t).map(r=>[r.toLowerCase(),r]))}

resolve(t,r={}){let n=Qe(t);if(!n)return;
  if(r.providerName){let c=this.findProvider(r.providerName),d=c?j3(c,n):void 0;
    if(c&&d)return gb(c,d,n)}
  let o=on(n);
  if(o){let c=this.findProvider(o.provider),d=c?j3(c,o.model):void 0;
    if(c&&d)return gb(c,d,n)}
  let i=this.gatewayModels.get(n.toLowerCase());
  if(i)return{canonicalSelector:i,kind:"gateway",model:i,selector:i};
  let s=this.providerModelMatches(n,!1);
  if(s.length===1)return gb(s[0].provider,s[0].model,n);
  if(s.length>1)return;                                   // ambiguity ABORTS
  let a=this.providerModelMatches(n,!0);
  return a.length===1?gb(a[0].provider,a[0].model,n):void 0}
```

1. explicit `opts.providerName`
2. `provider/model` selector — `on(n)` splits on the **first** `/`, both halves trimmed
3. `gatewayModels` map — exact lookup on lowercased input, returns `kind:"gateway"`
4. bare-name, **case-SENSITIVE**, across all providers
5. bare-name, **case-INSENSITIVE**, across all providers

Semantics:
- `Qe()` trims; also accepts a `"provider,model"` comma form and rewrites it to `provider/model`.
- Provider identity `QQe()` (offset 1000744) matches on **any** of `{name, id, provider, Cr(e)}`, trimmed+lowercased — so aliases work.
- Model match `j3()` (offset 1000638) is **always trimmed and case-insensitive**, returning the original-cased stored string.
- **Binds only when exactly one provider matches.** `if(s.length>1)return` returns
  `undefined` and **does not fall through** to stage 5 — a case-sensitive tie is a hard
  failure, not a retry.
- Registry instances memoized per-config-object in a `WeakMap` (`$3`) via `vt(e)`.

## 4. CCR's own `/v1/models` endpoint

Route predicate `hZ`, offset 1539656:
```js
function hZ(e,t){return(e||"GET").toUpperCase()==="GET"&&["/models","/v1/models"].includes($v(t))}
```
Both paths, GET only, on the gateway (default :3456). Handler at offset 2039283 serves
**synchronously from config**, `cache-control: no-store`. CCR uses it as its own health
check (offset 2124094).

Shape dispatch — `wZ`, offset 1540284:
```js
function wZ(e,t,r){let n=Kl(e,r),o=!!(n&&Yg(n)),i=Ml(e,r);
 return OGe(r)?mZ(e,{contextArchiveCompact:o,profile:i})
      :kZ(t)?mZ(e,{claudeCode:!0,contextArchiveCompact:o,profile:i})
      :wGe(e,i)}
```

**Anthropic shape** (`mZ`, ~1542400) for Claude Code / Claude App:
```js
return{id:l?Wv(o.id):o.id,
  capabilities:BZ(a,{...,oneMillionContext:o.oneMillionContext,...}),
  created_at:"1970-01-01T00:00:00Z",
  display_name:l?`${o.displayName} (1M context)`:o.displayName,
  max_input_tokens:d,max_tokens:u,type:"model"}
... return{data:n,first_id:n[0]?.id??null,has_more:!1,last_id:n[n.length-1]?.id??null}
```

**OpenAI shape** (`wGe`, ~1541501) for everyone else:
```js
function wGe(e,t){return{object:"list",data:vZ(e,t).map(n=>{let o=$t(n);
 return{id:n,object:"model",created:0,owned_by:kGe(n),type:"model",
   ...o?.displayName?{display_name:o.displayName}:{}}})}}
```

Enumerates (`vZ`, offset 1543853) every enabled `Providers[].models[]` as `provider/model`,
plus every `virtualModelProfiles` prefix/suffix/exactAlias expansion.

**Free metadata (Anthropic shape)**: `max_input_tokens`, `max_tokens`, `display_name`, a
human `description` ("200k context window" via `CGe`/`EGe`), and a rich `capabilities`
object from `BZ` (offset 1545314) covering reasoning, reasoning levels, imageInput,
pdfInput, structuredOutput, codeExecution, adaptiveThinking, toolCalling, batch, citations,
audioIn/Out, videoInput, 1M-context.

**What it does NOT give:**
- **No per-provider grouping.** Flat array; `owned_by` is the only provenance hint in the
  OpenAI shape, and the Anthropic shape has none.
- **No pricing** — `BZ` deliberately omits it even though models.json has it.
- **Profile-filtered** — every builder gates on `is(e,t,o.targetModel)`, so the active
  profile's `availableModels` can hide models.
- **IDs mangled for Claude clients** — `Md()` (offset 1003165) runs ids through `X3`/`XQe`,
  and on collision `e8`/`eNe` (offset 1006292):
  ```js
  function X3(e){let t=e.trim();return t.toLowerCase().startsWith("claude-")?t:`claude-${t}`}
  function e8(e,t){return `${t&&t>1?`anthropic/claude-ccr${t}-h`:WQe}${eNe(e)}`}
  function eNe(e){return Buffer.from(kn(e),"utf8").toString("hex")}
  function _l(e){let t=kn(e).toLowerCase(),
    n=/^anthropic\/claude-ccr(?:\d+)?-h([0-9a-f]+)$/.exec(t)?.[1];
    if(!(!n||n.length%2!==0))try{return Buffer.from(n,"hex").toString("utf8").trim()||void 0}catch{return}}
  ```
  This is the hex-encoding trick: arbitrary selectors are hex-encoded into
  `anthropic/claude-ccrN-h<hex>` so they pass Claude's client-side `claude-*` validation.
  `_l()` decodes.

## 5. `virtualModelProfiles`

Normalizer `$se` at offset 1918103:
```js
function $se(e){let t=[...e.virtualModelProfiles??[],...tn.getVirtualModelProfiles()];return HS(Lv(Nv(t)),e)}
function M6e(e){if(!b(e)||!b(e.match))return[];
 let t={exactAliases:ia(e.match.exactAliases),prefixes:ia(e.match.prefixes),suffixes:ia(e.match.suffixes)};
 return t.exactAliases.length===0&&t.prefixes.length===0&&t.suffixes.length===0?[]:[{...e,enabled:e.enabled!==!1,match:t}]}
```

Fields: `key`, `displayName`, `enabled`, `match:{exactAliases[],prefixes[],suffixes[]}`,
`materialization:{enabled,includeInGatewayModels}`, `baseModel:{fixedModel}`,
`execution:{mode:"decorate_only",clientToolsPolicy,matchMultimodal,maxToolCalls,maxTurns}`,
`tools[]`, `metadata.fusionVision:{baseUrl,model|modelSelector,fallbackModels[]}`.

Materialization gate (offsets 1043239 / 876256):
```js
function LM(e){return e.enabled!==!1&&e.materialization?.enabled!==!1&&e.materialization?.includeInGatewayModels!==!1}
```

Expansion is a **cross-product against every provider/model** (`Sd`, offset 875626), so
prefixes/suffixes inflate the list multiplicatively. Useful for **aliasing**
(`exactAliases` → stable `Fusion/<name>` handles) and as a **visibility switch**
(`includeInGatewayModels:false`), but **not a grouping primitive** — no categories, tags,
or ordering.

## 6. `dist/models.json` — the bundled catalogue

**19,709,726 bytes.** Header:
```json
"schemaVersion": 2, "generatedAt": "2026-08-24T12:22:28.162Z",
"generatedBy": "scripts/generate-models-json.mjs",
"sources": [ litellm, models.dev, openrouter ],
"summary": { "modelCount": 4298, "rawProviderModelCount": 10176,
  "providerCount": 217, "availabilityProviderCount": 294,
  "pricingOfferCount": 10457, "modelsWithPricing": 4078,
  "modelsWith1MContext": 827, "modelsWithToolCalling": 2842, "modelsWithReasoning": 2040 }
```

Verified: `models.length === 4298`; distinct `sourceRecords[].provider` = **294**. Top
providers by record count: openrouter 876, nano-gpt 601, llmgateway-providers 371, kilo 364,
vercel 352, fireworks_ai 313, azure 305, openai 273, bedrock 268, edenai 234.

Per-model fields: `id, provider, model, displayName, family, sources, providers, aliases,
mergedProviderModelRecords, limits, modalities, capabilities, pricing, metadata,
sourceRecords`.
- `limits`: `{contextTokens, outputTokens, supports1MContext}`
- `capabilities`: 12 booleans (attachments, audioInput/Output, imageInput/Output,
  openWeights, pdfInput, reasoning, temperature, toolCalling, videoInput, supports1MContext)
- `pricing.offers[]`: `{source, provider, model, sourceUrl, sourceUnit,
  per1MTokens:{input,output}}` — per-provider pricing, **10457 offers**
- `metadata`: `{displayNames, families, statuses, knowledgeCutoff, releaseDate,
  lastUpdated, providerModelRecordCount}`

Loading — `rQe()` at offset 986330, memoized in `Ag`, resolved from a search path (offset
984100) honouring **`CCR_MODEL_CATALOG_PATH` / `CCR_MODELS_JSON_PATH`** env overrides.
`nQe` re-indexes by provider into `{apiUrls, modelDisplayNames, modelMetadata, models,
provider, providerName, tokens}`.

Projection into config metadata — `iQe` (~987400):
```js
let p={...c!==void 0||d!==void 0?{capabilities:{...imageInput,...webSearch}}:{},
 ...i?{contextWindow:i,maxContextWindow:i}:{},
 ...s?{maxOutputTokens:s}:{},
 ...f?{pricing:f}:{},
 ...u.length>0?{supportedReasoningLevels:u}:{},
 ...l!==void 0?{supportsReasoningSummaries:l}:{}};
```
So `contextWindow`, `maxOutputTokens`, **`pricing`**, `supportedReasoningLevels`,
`supportsReasoningSummaries` are all available internally — pricing simply never reaches
`/v1/models`.

**Caveat**: a **static build artifact**, `generatedAt 2026-08-24`, refreshed only on npm
package upgrade (`prepack` runs `models:update`).

Also **30 built-in provider presets** (`lg`, offset 921247; `getProviderPresets` → `J5()`):
```js
var _5={account:Ht,aliases:["openai","chatgpt"],defaultModels:["gpt-4o"],
 endpoints:[{baseUrl:"https://api.openai.com/v1",protocols:["openai_responses","openai_chat_completions"]}],
 id:"openai",name:"OpenAI",officialApiKeyPatterns:[...],websiteUrl:"https://openai.com/"};
```
IDs: anthropic, openai, openrouter, gemini, deepseek, mistral, nvidia, siliconflow, bailian,
moonshot, moonshot-global, kimi-coding, minimax-global, minimax-cn, xiaomi (+3 token-plan
regions), zai-global-coding/general, zhipu-cn-coding/general, claudeapi, code0, fenno,
infistar-ai, qiniu-ai, runapi, teamorouter, unity2.

## 7. Router rules / transformers

Rule types — `GDe` at offset 952131:
```js
function GDe(e){if(typeof e!="string")return;let t=e.trim().toLowerCase();
 if(t==="condition"||t==="model-prefix"||t==="script")return t}
```
Only three: `condition`, `model-prefix`, `script`. `script` (`HDe`, ~952300) takes JS by
`file`/`source`, run in `route-script-worker.js` with a clamped `timeoutMs`.

Rewrite hooks in the request path (offset 2037227):
```js
let Le=CZ(this.config,t.headers,s,n,L);
Le&&(A["x-ccr-claude-model-discovery"]=Lo(Le.diagnostic),L=Le.body, ...)
let it=EZ(this.config,s,n,L,{profile:ae});
it&&(A["x-ccr-claude-app-model-rewrite"]=Lo(it.diagnostic),L=it.body,H=it.routedModel, ...)
```
`CZ` (offset 1539900) rewrites `body.model` on `POST /v1/messages` — the inbound decode of
hex-mangled ids via `cc()`/`_l()`. Response headers `x-ccr-route-reason`,
`x-ccr-route-source`, `x-ccr-route-diagnostics` expose the routing decision.

Provider entries also carry a free-form `transformer` field (passed through unvalidated at
offset 941825) plus `modelDescriptions`, `modelDisplayNames`, `modelMetadata` maps — keyed
to entries in `models[]` and dropped if the key is absent (`BDe`/`xDe`/`kDe`, ~942100).
**`modelDisplayNames` is the supported per-model label override and it IS surfaced in
`/v1/models`.**

## 8. RPC surface — all 64 methods

Server (offset 2270000) exposes exactly three paths: `/api/ccr/rpc`, `/`, `/assets/*`.
Dispatch (offset 2271000): POST only; `application/json` required (else 415); bearer/web
token auth (else 401); body `{method, args}`; unknown method 404; result wrapped
`{ok:true,value}` / `{ok:false,error:{message}}`.

Extracted from the `ict` table (offset 2270260, 4760 bytes):

```
applyClaudeAppGateway            getProfileRuntimeStatus       probeProviderCandidates
applyProfile                     getProviderAccountSnapshots   quitApp
cancelBotGatewayQrLogin          getProviderCatalogModels      resetCodexRateLimitCredit
checkProviderConnectivity        getProviderPresets            restartGateway
clearProxyNetworkCaptures        getProxyCertificateStatus     restartProxy
closeBotGatewayQrWindow          getProxyNetworkCaptures       revealProxyCertificate
detectProviderIcon               getProxyStatus                saveApiKeys
exportData                       getRequestLogBodyChunk        saveConfig
fetchProviderManifest            getRequestLogDetail           scanBotHandoffBluetoothTargets
getAgentAnalysis                 getRequestLogs                scanBotHandoffWifiTargets
getAgentTracePayload             getServiceIdentity            selectPluginDirectory
getAppInfo                       getUpdateStatus               setOnboardingFinished
getConfig                        getUsageStats                 setProxyNetworkCaptureEnabled
getGatewayStatus                 importLocalAgentProvider      startBotGatewayQrLogin
getLocalAgentProviderCandidates  installProxyCertificate       startGateway
getOnboardingFinished            listMcpServerTools            stopGateway
getOpenRouterProviderCatalog     openBotGatewayQrWindow        stopProfile
getPluginMarketplace             openBuiltInBrowser            testProviderAccountConnector
getProfileOpenCommand            openProfile                   testRouteScript
                                 probeLocalAgentProvider       validateRouteScript
                                 probeProvider                 waitBotGatewayQrLogin
                                                               updateCheck/Download/Install
```

### Model/provider-relevant, read-only

| Method | Impl (offset 2273294) | Gives |
|---|---|---|
| `getConfig` | `bt()` | Full config — all providers + `models[]` + `virtualModelProfiles`. **The real catalogue source.** |
| `getProviderCatalogModels` | `Pd(e)` | models.json lookup for **one** `{baseUrl, providerPresetId}` → `{models[], modelDisplayNames, modelMetadata, provider, providerName, matchedBy, loadedFrom}` |
| `getProviderPresets` | `J5()` | The 30 built-in presets (deep-cloned) |
| `getOpenRouterProviderCatalog` | `Ale(e)` | OpenRouter-specific catalogue |
| `fetchProviderManifest` | — | Provider manifest fetch |
| `probeProvider` / `probeProviderCandidates` | `JE`/`$1` | **On-demand discovery for one provider** — `mode:"models"` returns `{models, modelDisplayNames, modelSource, detectedProtocol, capabilities, catalogModelMetadata, normalizedBaseUrl}` |
| `checkProviderConnectivity` | `xle` | Per-model reachability, **parallel via `Promise.all`** |

`getProviderCatalogModels` is narrower than its name suggests — `Pd(e)` (offset 985256)
resolves by `providerPresetId` then `baseUrl`; no match returns `{loadedFrom, models:[]}`.
**There is no RPC that dumps all 4298 models or all 294 providers.**

## Bottom line

**Take from CCR:**
1. `dist/models.json` — 4298 models × 294 providers, context windows, 12 capability flags,
   modalities, 10457 pricing offers. Consumable without CCR running.
2. `autoFetchModels: true` per provider — free live discovery with persistence (but see the
   restart hazard below).
3. `GET /v1/models` on :3456 — ready-made enumeration in either of two shapes.
4. **`probeProvider` with `mode:"models"` — the on-demand "refresh this one provider now"
   primitive, and it means we never handle credentials ourselves.**
5. `modelDisplayNames` / `modelMetadata` / `virtualModelProfiles.exactAliases` — supported
   labelling and aliasing that flows through to the endpoint.

**Must build:**
1. Per-provider grouping — nothing groups; build it from `getConfig`'s `Providers[]`.
2. Pricing in the menu — join to models.json yourself.
3. A refresh-all trigger — no `refreshModels` RPC; fan out `probeProvider`.
4. Parallelism + timeouts — CCR's refresh loop is sequential and untimed.
5. Pruning — `Su` is a union; removed models never disappear.
6. Hex-id decoding, if consuming `/v1/models` as a Claude client.
7. Awareness that `/v1/models` is profile-filtered and models.json is frozen at 2026-08-24.
