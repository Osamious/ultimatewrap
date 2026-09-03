# Research: Claude Code 2.1.258 `/model` picker internals (2026-09-02)

Method: `strings -n 6` over `C:\Users\osami\.local\bin\claude.exe` — a Bun-bundled JS
executable; strings yields readable minified source with original chunk names
(`B:/~BUN/root/chunk-*.js`). Everything below is READ from the binary unless marked
INFERRED. Minified identifiers quoted as-is.

## 1. Search / filter — the code exists but is hard-disabled

The picker component is
`kZ({initial, sessionModel, onSelect, onSetDefault, onCancel, isStandaloneCommand,
showFastModeNotice, headerText, options, skipSettingsWrite})`. It calls a search hook:

```js
{isSearchMode:$o, isSearchModeRef:yo, query:Qo, cursorOffset:An, handleKeyDown:Yo, handlePaste:fn}
  = gSe({canEnter:!1, onEnter:()=>_("model_picker_search")})
```

Note `canEnter:!1`. The hook:

```js
function gSe({canEnter:I,onEnter:E}){
  ...
  return ft({"settings:search":()=>{if(oe.current)return!1;Te()}},{context:"Settings",isActive:I&&!D}),
  {isSearchMode:D, ..., handleKeyDown:(Me)=>{
      if(Me.defaultPrevented)return;
      if(oe.current){ve(Me);return}
      if(!I)return;                                   // <-- gate
      if(Me.key==="/"&&!Me.ctrl&&!Me.meta)Me.preventDefault(),Te()
  }, handlePaste:Ce}
}
```

With `I === false`: the keybinding registers as `isActive: false && !D` → never active, and
the literal `"/"` handler is unreachable. **Search mode can never be entered from the model
picker.** `isSearchMode` stays false and `query` stays `""` for the dialog's life.

The dead-but-present machinery:
- Filter is **substring, case-insensitive, over label + description — not fuzzy**:
  ```js
  vn = V(()=>{ if(!Qo)return _n; let Gi=Qo.toLowerCase();
    return _n.filter((ms)=>(typeof ms.label==="string"?ms.label:"").toLowerCase().includes(Gi)
                        || Et(ms.description??"").toLowerCase().includes(Gi))},[_n,Qo])
  ```
- Unreachable UI strings: `"Search models…"`, `` `No models match "${Qo}"` ``, footer
  `"Type to filter"` / `enter,down → "list"` / `escape → "clear"`.
- Trigger key would be `/`: in the `Settings` keybinding context, `"/":"settings:search"`.

A subsequence ("fuzzy") matcher `u5t(I,E)` exists immediately above `gSe` in the same
chunk, but has only 2 occurrences binary-wide and is **not** used by the model filter.

Complete ModelPicker keybinding context:
```js
{context:"ModelPicker",bindings:{left:"modelPicker:decreaseEffort",right:"modelPicker:increaseEffort",s:"modelPicker:thisSessionOnly"}}
```
Plus generic `Select`: `up/down/j/k/ctrl+n/ctrl+p/pageup/pagedown/home/end/enter/escape`.
**No type-to-jump binding of any kind.**

## 2. Rendering limits

Row budget in `kZ`, with `var v7e=14`:
```js
let Wo = $o||Qo!==""?4:0;        // search chrome — always 0
let Ko = Dt?3:0;                 // fast-mode notice
let nn = Xe!==null?3:0;          // session-override notice
let xo = Math.max(2,Math.min(10,Math.floor((Ne-v7e-Wo-Ko-nn)/2)));   // Ne = terminal rows
let Vn = Math.min(xo, vn.length);
let zo = Math.max(0, vn.length-Vn);
```
**Hard cap of 10 visible rows, floor of 2, regardless of terminal height.** 2 terminal lines
budgeted per row.

The `Select` clamps again:
```js
var Vs=8, As=0.6;
function nze(tb,Ld){ let Ud=Ld===void 0?"compact":Ld, {rows:ob}=Fi(we()),
  rb=Ud==="expanded"?3:Ud==="compact"?1:2, ib=Math.max(1,Math.floor((ob-Vs)/rb)); return Math.min(tb,ib) }
```
called as `nze(Ym, ev?"compact-vertical":Zt)` where `ev` is true for the model picker
(`Zt==="compact" && !inlineDescriptions && !options.some(isInput) && options.some(hasDescription)`;
`Kd(o)=o.type==="input"`, `zd(o)=o.description`). Second clamp: `floor((rows-8)/2)`.

**Viewport, not pagination.** The reducer `jc` maintains
`visibleFromIndex`/`visibleToIndex`/`visibleOptionCount` and scrolls one row at a time,
**wrapping** at both ends (`focus-next-option` past the last resets to `visibleFromIndex:0`).
`focus-next-page`/`focus-previous-page` jump by `visibleOptionCount`.

Overflow indicator:
`zo>0 && e(o,{paddingLeft:3,children:e(Uh,{count:zo,unit:"model"})})` — a "+N more" line.
Scroll affordance is the pointer glyph on the first/last visible row swapping to
`N.arrowUp` / `N.arrowDown`.

### Label + description layout

`kZ` passes no `layout` and no `inlineDescriptions`, so `Zt="compact"`, `Wn=false`. The
render takes the `hv` branch (`hv = !Wn && !options.some(isInput) && options.some(hasDescription)`
→ true), a **two-column single row**: `Ci` is `flexDirection:"row"` containing
`[pointer, label-cell, description-cell]`:
```js
let et = ve?0:Qn+2;                                            // numeric index column
let Do = Math.max(...ee.map(hs=>2+et+se(Cv(hs.label))+(b.value===hs.value?2:0)));
let Mo = Math.min(Do, Math.floor(Co*As));                      // Co = terminal columns, As = 0.6
...
let Rd = Mo-2-et-Ad;
if(se(Vo)>Rd) Vo=st(Vo,Rd), eo=Vo;                             // LABEL TRUNCATED
...
e(o,{flexGrow:1,marginLeft:2,children:e(n,{wrap:"wrap",...,children:e(Kr,{children:ge.option.description||" "})})})
```

- **Label: truncated**, to a column capped at **60% of terminal width**
  (`Math.floor(Co*0.6)`), via `st(text,width)`. `st`'s body is in another chunk — **no
  evidence found** whether it appends an ellipsis or hard-cuts.
- **Description: NOT truncated — `wrap:"wrap"`.** A long description wraps onto extra
  terminal lines, exceeding the 2-lines-per-row budget the viewport math assumes.
- Rows prefixed with a numeric index (`` `${Id}.`.padEnd(...) ``) unless `hideIndexes`;
  `kZ` does not pass it, so indices show.
- **Horizontal scrolling: none.** Zero matches for `scroll:left`, `scrollLeft`,
  `horizontalScroll` anywhere in the binary.

One ordering effect: `sEe` moves all disabled rows to the bottom —
`return [...B.filter(j=>j.disabled!==!0), ...U]` — so a disabled curated row loses its
declared position.

## 3. `replaceBuiltInOptions` — the +2 explained exactly

Applied in `fXr`, called from `dXr` (the option-list builder):

```js
function fXr(e,n){
  let r=V8(); if(!r)return e;
  let {picker:o}=r, d=r.source==="policySettings", p=new Set, y=[];
  for(let T of o.options){
    let I=T.model.trim();
    if(I===""||p.has(I)||!Nun(I))continue;                     // dedupe + eligibility filter
    p.add(I);
    let F=pXr(I,T.label?.trim()||void 0,T.description?.trim()||void 0,d), B=BN(I);
    if(B?.reason==="disabled"){...; y.push({...F,disabled:!0,description:B.description}); continue}
    y.push(F)
  }
  if(y.length===0)return e;                                     // ALL rows rejected -> silent fallback
  if(n!==null)n.curatedRows=y.length, n.curatedReplaced=o.replaceBuiltInOptions===!0;
  if(o.replaceBuiltInOptions===!0)return[...e.filter((T)=>T.value===null),...y];    // KEY LINE
  let k=[...e]; for(let T of y) if(!k.some((I)=>QL(I,T))) k.push(T); return k
}
```

`e.filter(T=>T.value===null)` is what survives.

**Extra row 1 = the Default row**, the sole `value:null` row, built by `Gie`:
```js
function Gie(e){ if(wt())return{value:null,label:"Default (recommended)",description:K4t(e)};
  ... return{value:null,label:o?"Default":"Default (recommended)",description:`Use the default model (currently ${n7e(n)})${p}${j9r(r)}`} }
```
Both the served-catalog builder (`aXr`) and the offline fallback lineup (`oXr`) emit
exactly one.

**Extra row 2 = the currently-selected model, force-appended AFTER `fXr` runs.** `dXr` ends:
```js
o=fXr(o,n);
let T=null, I=Mp(), F=UC();
if(I!==void 0&&I!==null)T=I; else if(F!==void 0&&F!==null)T=F;
if(T===null||o.some((B)=>B.value===T))return wH(o,n);
else if(T==="opusplan")return wH([...o,eXr()],n);
else if(bY(T)){...}
else if(T==="opus"){... [...o,zZe(!1)] ...}
else if(T==="opus[1m]"&&ka()){ let B=qZe(!1); return wH(o.some(...)?o:[...o,B],n) }
else { ...; return o.push(zie(T)??{value:T,label:T,description:"Custom model"}), wH(o,n) }
```
The observed label `"Opus 5 (1M context)"` matches the generic `zie(T)` path:
```js
let o=e.endsWith("[1m]")&&r.context?.supports_1m_suffix?" (1M context)":"";
return r.display_name+o
```
(`display_name` `"Opus 5"` + `" (1M context)"`). The dedicated `qZe` builder would label it
`"Opus (1M context)"`.

**So: Default + 87 curated + current-model = 89; Default + 18 curated + current = 20.** Both
measurements reproduce exactly. Order: `Default`, curated rows in declared order, then the
current-model row appended last.

INFERRED corollary: if the session's current model is already one of the curated rows (or
is Default/null), the delta is **+1**, not +2.

### Two silent-failure modes

- Each curated row must pass `Nun(I)`; failures are `continue`d **with no warning**:
  ```js
  function Nun(e){if(N7(e)||!Or(e)||BN(e)?.reason==="absent")return!1; let n=tn(e); if(n===e)return!0;
    let r=Ve(n.toLowerCase()); return(r.includes("opus")?eI():r.includes("sonnet")?DM():!0)&&!Qoe(r)}
  ```
  `Or`/`N7` are cross-chunk imports — **no evidence found** on their exact predicates.
- **If every curated row fails, `if(y.length===0)return e`** — the whole `modelPicker`
  block is silently ignored and the built-in lineup renders as if unset.

Source precedence: `var ovr=["policySettings","flagSettings","userSettings"]`, and `V8()`
takes the first that defines `modelPicker` — **winner-take-all, no merge**.

## 4. `behavesAs`

Schema description, verbatim:
> "For a model this version of Claude Code does not know: the ID of a model it does know
> (e.g. \"claude-opus-4-8\") whose client-side handling — prompt profile, capability and
> effort defaults — applies to it. Changes neither the row's label nor the model ID sent.
> Without it, a model-catalog row for a model this version does not know is not offered
> until Claude Code is updated."

Companion `model` field: *"Model to select, taken verbatim: an alias (\"opus\"), an
Anthropic model ID, or a provider-format ID (Vertex, Bedrock, gateway). Same values
--model accepts."*

Readers:
```js
function rwr(e){let n=ed(e); if(n==="")return;
  let r=V8()?.picker.options.find((o)=>ed(o.model)===n)?.behavesAs?.trim();
  return r===void 0||r===""?void 0:r}
function Rne(){return V8()?.picker.options.some((e)=>(e.behavesAs?.trim()??"")!=="")??!1}
```
wired via `Rx({... settingsBehavesAs:rwr, hasSettingsBehavesAs:Rne, ...})`.

Resolution engine (`KJe`/`une`/`kx`/`dne`) returns
`{status:"known"|"unknown"|"mapped", target, source, hops}`:
```js
function dne(e,n,r){ let o=[], d=pne(n,r),
  p = e===null?void 0:yx(d,(T)=>F7(e,T)?.behaves_as);        // source "served"
  if(p!==void 0)o.push({target:p,source:"served"});
  if(Cp(r)){ let T=yx(d,(y)=>r.lookup.settingsBehavesAs(y)); // source "settings"
    if(T!==void 0)o.push({target:T,source:"settings"}) }
  return o }
```
**Two sources**: the `modelPicker` row, and a `behaves_as` field on the *server-served*
catalog row (served-catalog zod schema at L442066 includes `behaves_as:i().nullish()`).
Chain-following capped at `var lne=8` hops with a cycle set; memoized to `var cne=256`.

**Where it takes effect — load-bearing.** `Px` is folded into `Ve`, the central
model-normalization function:
```js
function Px(e){ let n=i$().modelKnowledge; if(n===void 0)return e;
  let r=xa(); if(r===null&&!Cp(Rp(n)))return e;
  let o=KJe(r,e); return o.status==="mapped"?o.target:e }

function Ve(e,n){ let r=Fx(e,n);
  if(n?.identity===!0||dTe(r)||E0(e,r))return r;
  let o=Px(e); if(o===e)return r; return Fx(o,n) }
```
So `behavesAs` affects **everything downstream of `Ve`**: catalog row resolution,
`supportsEffort`/`supportsMax`/`supportsXHigh`/`supportsUltra`, default effort (`E8`),
pricing, and — contrary to being a "prompt profile" knob — **context window**, since
`Bvn(e,n=Ve(e))` → `za(...)` → `aTe(...)` all go through the resolved id. It does **not**
change the wire model ID or the row label.

It also controls offerability of served rows:
`function DFe(e,n){return U8(n)&&Mx(e,n).status!=="unknown"}`.

Error text:
> `"${e}" isn't described by this version's model catalog; update Claude Code, or map it
> with behavesAs on a modelPicker row (or modelOverrides, if it is a provider id of a model
> this version knows).`

### Context window with no `behavesAs` — the 200k default, VERIFIED

```js
var Rme=200000, WN=200000, oL=32000, Dne=128000;
function uL(e,n){
  if(Xc(e))return 1e6;                                  // id matches /\[1m\]/i
  if(n?.includes(aH.header)&&aT(e))return 1e6;          // 1m beta header
  let r=Bvn(e); if(r!==void 0)return ivt(e)??r.believed; // catalog-declared
  if(Dy(e))return 1e6;
  let o=ivt(e); if(o!==null)return o;
  let d=a.CLAUDE_CODE_MAX_CONTEXT_TOKENS; if(d!==void 0&&d>0&&aL(e))return d;
  return Rme                                            // 200000 fallback
}
```
Two related details: `Bvn` caps *believed* at 200k even when the catalog declares more
(`if(r>Rme&&!Lne(e))return{declared:r,believed:Rme}`), and the `[1m]` test `Xc(e)` runs on
the **raw** id before any `behavesAs` resolution — so an id ending in `[1m]` gets 1M
regardless of mapping. A distinct `source:"unknown-model"` branch exists in the auto-compact
sizer `vk`, escapable via `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT`.

## 5. `ANTHROPIC_CUSTOM_MODEL_OPTION` and gateway discovery

**`ANTHROPIC_CUSTOM_MODEL_OPTION`** — one extra row, added early in `dXr`:
```js
let d=a.ANTHROPIC_CUSTOM_MODEL_OPTION;
if(d&&!o.some((B)=>B.value===d))
  o.push({value:d, label:a.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME??d,
          description:a.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION??`Custom model (${d})`});
```
Env family (from the allowlist `ukt`): `ANTHROPIC_CUSTOM_MODEL_OPTION`, `_NAME`,
`_DESCRIPTION`, `_SUPPORTED_CAPABILITIES`. **One row only**, added before `fXr`, so
`replaceBuiltInOptions:true` removes it.

**Gateway discovery** — a real dynamic-list mechanism. Gate:
```js
function Tp(){ if(!a.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY)return!1;
  if(Oe()!=="firstParty")return!1;   // not Bedrock/Vertex
  if(oi())return!1;                  // ANTHROPIC_BASE_URL must NOT be a real first-party host
  if(!a.ANTHROPIC_BASE_URL)return!1; return!0 }
```
Fetch (`urr`, called once during startup init alongside `Rrr(E),crr(E),Vm(E,I)`):
```js
let x=`${n.replace(/\/+$/,"")}/v1/models?limit=1000`;
let U=await fetch(x,{method:"GET",headers:k,redirect:"error",signal:AbortSignal.timeout(Bte),...});
...
let F=B.data.data.filter((ne)=>/(claude|anthropic)/i.test(ne.id));
if(F.length===0){t("[gatewayDiscovery] 0 usable models after filter");return}
... cached as {baseUrl, fetchedAt, models} to gateway-models.json
```
Headers: `Authorization: Bearer <ANTHROPIC_AUTH_TOKEN | apiKeyHelper>`, `x-api-key`,
`anthropic-version: 2023-06-01`, plus `ANTHROPIC_CUSTOM_HEADERS`. Rows built by `bme()`:
```js
let r=e.models.map((o)=>({value:o.id, label:zE(o.display_name??"")||zE(o.id),
                          description:gHe(aB(o.description??""),Hte)||"From gateway"}));
```

**Four hard constraints, all READ:**
1. Requires `ANTHROPIC_BASE_URL` pointing at a non-first-party gateway, plus
   `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`.
2. The gateway must serve `GET /v1/models?limit=1000` in Anthropic's shape.
3. **Every model id must match `/(claude|anthropic)/i`** or it is filtered out.
4. The fetch is async at startup and writes a cache; `bme()` reads the cache and requires
   `cache.baseUrl === ANTHROPIC_BASE_URL`. INFERRED: the picker in run *N* shows the list
   fetched in run *N-1* — new models appear one restart late.

`bme()` and `C0()` are only consulted when `r===null` in `dXr` (no served catalog), and both
are added before `fXr`, so `replaceBuiltInOptions:true` erases them.

`C0()` reads `ie().additionalModelOptionsCache`, populated from the API bootstrap response
field `additional_model_options` — **server-controlled by Anthropic, not a user extension
point.**

## 6. Extension points — exhaustive sweep

| Surface | Verdict |
|---|---|
| `modelPicker` setting | The flat list. Managed > `--settings`/SDK > user settings; winner-take-all. |
| `ANTHROPIC_CUSTOM_MODEL_OPTION` (+`_NAME`/`_DESCRIPTION`) | One extra row. |
| `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` (+`_NAME`/`_DESCRIPTION`/`_SUPPORTED_CAPABILITIES`) | **Replaces** the corresponding built-in row with a custom id/label/description. Four slots max. |
| Gateway discovery | §5. Dynamic, one restart behind, id-filtered. |
| `availableModels` / `enforceAvailableModels` | Filter only, applied *after* `modelPicker` via `wH`. **`wH` re-resolves each row through `zie(y)` and drops rows not in the catalog** (`if(k===null)return[]`) — enabling `availableModels` can silently delete curated rows. |
| `modelOverrides` | Anthropic-id → provider-id remap. Does not add rows. |
| Hooks | `PreModelSwitch` / `PostModelSwitch` exist. `PreModelSwitch` (`Rmt`) can only return `{decision:"block"\|"ask"\|"proceed"}` — a **veto, not a list contributor**. No hook event supplies picker rows. |
| Custom slash commands | `/model` is a hardcoded built-in: `{type:"local-jsx",name:"model",...,requires:{ink:!0},immediate:!0,thinClientDispatch:"control-request"}`. User/plugin commands are all `type:"prompt"` (markdown); every `local-jsx` command is a hardcoded built-in. **A custom command cannot render UI and cannot shadow `/model`.** |
| MCP | No MCP surface touches the model picker. MCP **elicitation** can render its own selection UI (`enum` + `enumNames`, or `oneOf` with `const`/`title`, plus `array` for multi-select) — but explicitly **flat-only**: *"Elicitation requestedSchema must describe an object with flat primitive properties"*; unknown constraints throw. `ElicitRequestURLParamsSchema` exists, i.e. elicitation can hand the user a URL. |
| Nested / two-level menu | **No evidence found.** No column, group, submenu, or tree concept anywhere in the Select module. The only second dimension is the effort slider (`left`/`right`), which modifies the focused row rather than descending into it. |

**Bottom line: a two-level menu is not possible inside the `/model` picker.** The only
in-CC surfaces that render a selection list are hardcoded `local-jsx` built-ins (not
extensible), MCP elicitation (flat-only, unrelated), and `AskUserQuestion`-style prompts.
INFERRED: the closest approximation is encoding hierarchy into the flat label text
(`"Anthropic › Opus 5"`), accepting the 60%-width truncation and the 10-row viewport.

## 7. Where the selection is persisted

**Save as default** → `~/.claude/settings.json` key `model`:
```js
function NIe(e,t){ Qt("userSettings",{model:e??void 0},void 0,t), _("model_set_default") }
```
Called as `if(oe) NIe(o,i);`. Confirmation:
`` `${Jne}${dg(Tm(o))}${oe?" and saved as your default for new sessions":" for this session only"}` ``

**This session only** (`s` key) → **in-memory app state only**, no settings write:
```js
K((ke)=>({...ke, mainLoopModel:o, mainLoopModelForSession:null,
          ...n!==void 0&&{sessionEffort:VR(n.level),ultracode:n.ultracode}, ...}))
```
`kZ` also accepts `skipSettingsWrite` (used by the cloud-session variant, header *"Models
reported by the cloud session. Your pick applies to that session."*).

Side effects: `Pm(D,Y.getState(),o,"picker")` records the switch; `Hmt` fires
`PostModelSwitch` with `{from_model,to_model,requested_model,source}`.

**Re-read live?** The list is rebuilt on every open — `kZ` does
`let tt=V(()=>Ce??Oun(ct),[Ce,ct])`, and `Oun`→`sEe`→`dXr`→`V8()`→`Zq("modelPicker")`→`be(source)`.
But `be()` reads the **cached** settings store (`e.store.mergedSettings`,
`e.store.perSource`), refreshed only by an explicit `ql()` / `invalidateAll()`. A
`freshnessWatcher` exists (`setFreshnessBackend`, `setFreshnessWatcherStarted`, with `ql(e)`
on several config-write paths), so an **in-app** settings write invalidates the cache.
Whether an **external** edit does — **no evidence found**.

Unrelated third surface: FleetView has its own `/`-prefixed model autocomplete
(`{kind:"model",name:"model",description:"Set model for this FleetView session (not persisted)"}`)
whose entries come from `jF()` = `sEe(e).filter(n=>!n.disabled)` — same option pipeline,
different UI, explicitly not persisted.
