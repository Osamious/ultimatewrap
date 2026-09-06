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

const APPDATA = process.env.APPDATA ?? "";

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

export const CONTRACT = Object.freeze({
  product: "claude-code-router",
  // shape + version. Task A15 reports drift on either half.
  fingerprint: "3.0.22 / service.json + /api/ccr/rpc + x-ccr-web-auth",
  verifiedVersion: "3.0.22",
  servicePath: path.join(APPDATA, "claude-code-router", "service.json"),
  rpcPath: "/api/ccr/rpc",
  authHeader: "x-ccr-web-auth",
  tokenParam: "ccr_web_token",
  installDir: INSTALL_DIR,
  bundledCatalogue: path.join(INSTALL_DIR, "dist", "models.json"),
  // The bundle carrying the locally-patched gateway handshake timeout. Named here
  // rather than in doctor.mjs because Q4.1 allows exactly one file to know CCR's
  // layout, and because `npm i -g` reverting that patch is the single
  // highest-severity CCR coupling this project has (report 10, P1 #10).
  gatewayBundle: path.join(INSTALL_DIR, "dist", "main", "cli.js"),
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
