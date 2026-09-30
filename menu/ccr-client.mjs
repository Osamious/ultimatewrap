// Everything this project knows about claude-code-router lives here.
//
// Two facts make this worth isolating. First, CCR holds the API keys, so asking
// it to list a provider's models is how tier 2 refreshes without this process
// ever touching a key value. Second, its loopback RPC is an internal surface with
// no compatibility promise -- the auth header name and the token query parameter
// are both undocumented and both observed rather than specified.
//
// MEASURED: %APPDATA%/claude-code-router/service.json holds {"url": "...?ccr_web_token=..."},
// and POST {origin}/api/ccr/rpc with header x-ccr-web-auth returns {value: <result>}.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { CONTRACT as CC } from "./cc-contract.mjs";

// The fingerprint names a VERSION, not only a shape. "service.json + /api/ccr/rpc
// + x-ccr-web-auth" describes an interface that a CCR upgrade can keep while
// changing what the calls mean, and a fingerprint that cannot move is a check
// that cannot fail. Phase 0.5 measured 3.0.22; `ccrVersion()` reads the installed
// package.json so `uw doctor` compares against the version actually present.
function resolveInstall() {
  // require.resolve follows the real install, wherever npm put it. The literal
  // below is the last-known-good fallback and nothing more: `nvm4w/nodejs` is a
  // junction that follows the ACTIVE Node version, so it survives a version
  // switch but not an `npm i -g` relocation or a different Node manager.
  try {
    const req = createRequire(import.meta.url);
    return path.dirname(req.resolve("@musistudio/claude-code-router/package.json"));
  } catch {
    return "C:/nvm4w/nodejs/node_modules/@musistudio/claude-code-router";
  }
}

const INSTALL_DIR = resolveInstall();

export function ccrVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, "package.json"), "utf8")).version;
  } catch { return null; }
}

// The gateway library CCR bundles beside its own cli.js; recipe E patches its dist/index.js and is verified
// against one version of it, so the installed one is read the same way `ccrVersion()` reads CCR's.
const GATEWAY_LIB_DIR = path.join(INSTALL_DIR, "node_modules", "@the-next-ai", "ai-gateway");

export function gatewayLibVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(GATEWAY_LIB_DIR, "package.json"), "utf8")).version;
  } catch { return null; }
}


// WHERE THE ROUTER KEEPS ITS FILES, as CCR 3.0.22's own bundle resolves them (dist/main/cli.js, identifiers
// `$i`, `uq`, `Tpe`, `hw`, `Nx`; Windows branch -- this project is Windows-only). An env value counts only when
// it is non-blank after trimming. Precedence, first hit wins:
//
//   config folder  (holds service.json)           = <app-data base>\claude-code-router
//     app-data base = CCR_INTERNAL_APP_DATA_DIR, else APPDATA, else LOCALAPPDATA, else USERPROFILE\AppData\Roaming
//   data folder    (usage.sqlite, request-logs.sqlite) =
//     UW_CCR_DATA_DIR (ours: tests and QA)  >  CCR_INTERNAL_USER_DATA_DIR (the router's own)  >  the config folder
//
// So a run from inside a CCR sandbox (which sets the CCR_INTERNAL_* names) reads the SANDBOX's data, never
// production's. Two deliberate differences from the router: with no usable base at all it returns null (callers
// say "router data not found") where the router falls back to os.homedir(); and UW_CCR_DATA_DIR moves the
// data folder only, never service.json. Not getAppInfo().dataDir: that RPC costs ~7 s on this machine.
const envVal = (env, name) => String(env[name] ?? "").trim() || null;

/** The router's config folder (service.json lives here), or null when no app-data base can be found. */
export function configDir(env = process.env) {
  const base = envVal(env, "CCR_INTERNAL_APP_DATA_DIR") ?? envVal(env, "APPDATA") ?? envVal(env, "LOCALAPPDATA")
    ?? (envVal(env, "USERPROFILE") ? path.join(envVal(env, "USERPROFILE"), "AppData", "Roaming") : null);
  return base ? path.join(base, "claude-code-router") : null;
}

/** The router's data folder (the databases live here), normalised, or null when none can be found. Read from `env` on every call. */
export function dataDir(env = process.env) {
  const own = envVal(env, "UW_CCR_DATA_DIR") ?? envVal(env, "CCR_INTERNAL_USER_DATA_DIR");
  return own ? path.resolve(own) : configDir(env);
}
export const usageDb = (env = process.env) => { const d = dataDir(env); return d ? path.join(d, "usage.sqlite") : null; };
export const requestLogsDb = (env = process.env) => { const d = dataDir(env); return d ? path.join(d, "request-logs.sqlite") : null; };

export const CONTRACT = Object.freeze({
  product: "claude-code-router",
  // shape + version. Task A15 reports drift on either half.
  fingerprint: "3.0.22 / service.json + /api/ccr/rpc + x-ccr-web-auth",
  verifiedVersion: "3.0.22",
  servicePath: configDir() ? path.join(configDir(), "service.json") : "",
  rpcPath: "/api/ccr/rpc",
  authHeader: "x-ccr-web-auth",
  tokenParam: "ccr_web_token",
  // Getters, so they read the environment when asked (the functions above take an `env`). null = not found.
  // CCR 3.0.22 fills usage_events.client from the request header named next.
  get dataDir() { return dataDir(); },
  get usageDb() { return usageDb(); },
  get requestLogsDb() { return requestLogsDb(); },
  clientHeader: "x-ccr-client",
  probeClient: "uw-probe",
  installDir: INSTALL_DIR,
  bundledCatalogue: path.join(INSTALL_DIR, "dist", "models.json"),
  // The bundle carrying the locally-patched gateway handshake timeout. Named here
  // rather than in doctor.mjs because Q4.1 allows exactly one file to know CCR's
  // layout, and because `npm i -g` reverting that patch is the single
  // highest-severity CCR coupling this project has (report 10, P1 #10).
  gatewayBundle: path.join(INSTALL_DIR, "dist", "main", "cli.js"),
  // The bundled ai-gateway library, patched by recipe E (surface the upstream failure reason).
  gatewayLibBundle: path.join(GATEWAY_LIB_DIR, "dist", "index.js"),
  // The RPC methods this project actually calls. Probed at doctor time rather than
  // assumed: they are wire strings and not minified, which makes them the most
  // solid CCR dependency available -- and still worth checking, because an
  // unknown-method failure arrives as a refresh that quietly returns nothing.
  rpcMethods: Object.freeze(["getAppInfo", "getConfig", "probeProvider"]),
});

/**
 * Ask the running gateway which methods it answers, and which version it is.
 *
 * `getAppInfo` returns `{version, configDir, dataDir, configDbFile}` and is the
 * authoritative source for the RUNNING version. `ccrVersion()` above reads
 * package.json, which is the INSTALLED version. The two disagreeing is a real and
 * specific state -- CCR updated on disk, gateway not restarted -- and it is
 * exactly the window in which the gateway patch has been reverted on disk while
 * the live process still holds it. Everything works until the next restart.
 *
 * Never throws, and returns `null` when CCR is simply not running, because "the
 * gateway is down" is an ordinary condition and not a drift report.
 */
export async function probeRpcSurface({ timeoutMs = 15000 } = {}) {
  const service = readService();
  if (!service) return null;
  const methods = {}, states = {};
  let runningVersion = null;
  for (const m of CONTRACT.rpcMethods) {
    // probeProvider needs an argument to do anything, but an unknown METHOD and a
    // bad argument fail differently: this asks only whether the name resolves.
    const r = await rpcProbe(m, m === "probeProvider" ? [null] : [], { timeoutMs, service });
    states[m] = r.state;
    // "The name resolved" is the question. `error` means the gateway ran the
    // method and it returned ok:false -- present. Only a transport or auth
    // failure leaves the question unanswered, and those are reported as states
    // rather than folded into a bare false, which would read as "renamed".
    methods[m] = r.state === "ok" || r.state === "error";
    if (m === "getAppInfo" && r.ok && r.value && typeof r.value === "object") {
      runningVersion = r.value.version ?? null;
    }
  }
  return { methods, states, runningVersion, installedVersion: ccrVersion() };
}

/**
 * One RPC call, with the FAILURE KIND preserved.
 *
 * `rpc()` collapses everything into undefined, which is right for callers that
 * only need an answer and wrong for the doctor, whose whole job is to say WHY.
 * Measured against the live gateway, the four outcomes are genuinely different
 * problems with different owners:
 *
 *   auth     401 without the header, 200 with it. If this ever fires, UW is
 *            failing to send `x-ccr-web-auth` from service.json's ccr_web_token
 *            -- our defect, not the user's.
 *   timeout  the gateway is alive but slower than the budget. getAppInfo takes
 *            ~7.2 s on this machine, repeatably, while getConfig answers in 6 ms.
 *   refused  nothing listening: the gateway is actually down.
 *   error    HTTP reached, the method ran and returned ok:false -- probeProvider
 *            does exactly this on a null argument. The NAME resolved, which is
 *            all the surface probe is asking, so this counts as present.
 */
export async function rpcProbe(method, args = [], opts = {}) {
  const { timeoutMs = 400, fetchImpl = fetch, service = readService() } = opts;
  if (!service) return { ok: false, state: "no-service" };
  let res;
  try {
    res = await fetchImpl(`${service.origin}${CONTRACT.rpcPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [CONTRACT.authHeader]: service.token },
      body: JSON.stringify({ method, args }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const name = String(e?.name ?? "");
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return { ok: false, state: timedOut ? "timeout" : "refused",
             detail: String(e?.message ?? e).slice(0, 80) };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, state: "auth", status: res.status };
  }
  let body = null;
  try { body = await res.json(); } catch { return { ok: false, state: "bad-body", status: res.status }; }
  if (body && body.ok === false) return { ok: false, state: "error", status: res.status };
  return { ok: true, state: "ok", status: res.status, value: body?.value ?? null };
}

export function readService(file = CONTRACT.servicePath) {
  try {
    const u = new URL(JSON.parse(fs.readFileSync(file, "utf8")).url);
    return { origin: `${u.protocol}//${u.host}`, token: u.searchParams.get(CONTRACT.tokenParam) };
  } catch { return null; }
}

// Never throws. A gateway that is down, slow, or answering in a shape we do not
// recognise is an expected condition, not an error: the picker draws without it.
//
// FAILURE IS `undefined`; A GENUINE NULL RESULT IS `null`. The distinction is the
// whole of `probeRpcSurface`'s drift check, which decides whether a method exists
// by testing `r !== undefined`. While every failure path also returned `null`, a
// refused connection and an unknown method both read as "method present", so the
// check reported all three methods healthy with CCR dead and could never fail --
// and `uw doctor` is built on top of it. Callers that only care whether they got
// an answer keep working unchanged, because both values are falsy.
export async function rpc(method, args = [], opts = {}) {
  const { timeoutMs = 400, fetchImpl = fetch, service = readService() } = opts;
  if (!service) return undefined;
  try {
    const res = await fetchImpl(`${service.origin}${CONTRACT.rpcPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [CONTRACT.authHeader]: service.token },
      body: JSON.stringify({ method, args }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json();
    return body?.value ?? null;      // the gateway answered; null is its answer
  } catch { return undefined; }      // no answer at all
}

// Both levels are shape-checked, and the two failures are not the same failure.
// `rpc` never throws -- it returns undefined on no answer -- so what reaches here
// is a well-formed HTTP response carrying a malformed body, which is the case
// nothing upstream is looking for.
//
//   {Providers: 5}  threw `TypeError: number 5 is not iterable`, which escapes
//                   into the picker's startup path as a crash, not a blank stamp.
//   {models: "ab"}  was WORSE because it was silent: a STRING IS ITERABLE, so
//                   for..of walked it per character and produced the routing
//                   targets `x/a` and `x/b`. Every real target then reads as
//                   unroutable and the whole menu dims. Array.isArray is what
//                   separates a list of ids from a string that looks like one.
export function routableFromConfig(cfg) {
  const set = new Set();
  const providers = cfg?.Providers;
  if (!Array.isArray(providers)) return set;
  for (const p of providers) {
    if (!Array.isArray(p?.models)) continue;
    for (const m of p.models) set.add(`${p.name}/${m}`);
  }
  return set;
}

export function bundledCataloguePath() { return CONTRACT.bundledCatalogue; }

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Where Claude Code sends its traffic, and the key it sends it with -- read from
 * Claude Code's own settings, so a benchmark measures the path a real session
 * takes. Returns `{ base, key }`, or `null` when either half is missing.
 *
 * TWO GUARDS, both because this hands back a live credential:
 *   - the base URL must be a LOOPBACK address. The gateway key exists to
 *     authenticate to the local gateway and nothing else; if the settings file
 *     were ever edited to point at a remote host, a caller must not be able to
 *     send that key there by trusting this function.
 *   - the key helper is run, never read from a file, and its output is returned
 *     only to the caller. Nothing here logs it.
 *
 * `run` is injectable so the tests never execute anything.
 */
export function gatewayConnection({ settingsFile = CC.paths.settings, run = null } = {}) {
  let settings;
  try { settings = JSON.parse(fs.readFileSync(settingsFile, "utf8").replace(/^﻿/, "")); }
  catch { return null; }
  const base = String(settings?.env?.ANTHROPIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const helper = typeof settings?.apiKeyHelper === "string"
    ? settings.apiKeyHelper.trim().replace(/^"(.*)"$/, "$1") : "";
  if (!base || !helper) return null;
  try { if (!LOOPBACK.has(new URL(base).hostname)) return null; } catch { return null; }
  let key = "";
  try {
    key = String(run ? run(helper)
      : execFileSync(`"${helper}"`, [], { encoding: "utf8", shell: true, timeout: 10000, windowsHide: true })).trim();
  } catch { return null; }
  return key ? { base, key } : null;
}
