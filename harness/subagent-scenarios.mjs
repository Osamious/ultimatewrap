// Stage S2d of the subagent model policy: the END-TO-END SCENARIO SUITE (plan 12.1 S2d, 6.1b E, 12.6 quality bar). BUILT OFFLINE AND NOT RUN: a run needs the owner's typed approval (its own ceremony,
// below) and the sandbox of harness/subagent-e2e.mjs (a SECOND CCR 3.0.22 daemon beside the live one, gate G1, delegated by D-bj).
//
//   node harness/subagent-scenarios.mjs --plan                       prints the scenarios, what each must prove, how it is driven and the plan sha256; NO I/O, NO process
//   node harness/subagent-scenarios.mjs --approve-plan               OWNER ACT, interactive terminal only: type the first 12 hex characters of the plan sha256; writes harness/g1-scenarios-approval.json (ONE-USE, 24 h)
//   node harness/subagent-scenarios.mjs --run [--only 2,3,C1] [--runs N] [--real yes]     needs that approval; consumes it, then runs the suite in the sandbox
//
// What it reuses (nothing of the sandbox machinery is duplicated): the orchestrator `runE2e` of subagent-e2e.mjs starts the sandbox, proves isolation at every stage, installs the exact router bytes, tears down and
// compares the live state before and after; this file supplies the PHASES that run in the middle (`d.sessionPhases`), the VERDICT (`d.sessionVerdict`) and the approval ceremony (`d.externalApproval`).
// The judges are PURE functions of evidence (the stub's records, the router's agent log, its status, the `last` text), unit-checked against fake transcripts: a scenario FAILS when the served model is wrong, a helper
// call is rewritten or a handoff is missing from the log. The runners are written against a small primitives object (`prims`), so the tests drive them with a fake sandbox.
//
// THE CLIENT. Every scenario can be driven by a REPLAY of the request shapes a Claude Code client sends (buildRequest: main, sub, aux and bg shapes with the agent id, billing flag, session id, retry-count header and
// the messages length that G1's X3 and X5 recorded), through the sandbox gateway. A REAL headless Claude Code (`claude -p`) is used only with `--real yes`, and only for the scenarios that measure what the client itself
// does: 1 (the real spawn), 2, 3 and 11 (its retry, its Retry-After handling). It is pointed at the sandbox by ENVIRONMENT ONLY (ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, and HOME, USERPROFILE, APPDATA, CLAUDE_CONFIG_DIR all
// under the sandbox scratch root, from the same whitelisted launch environment as the sandbox daemon), so it neither reads nor writes ~/.claude/settings.json; the settings tripwire still watches that file. That claim
// cannot be verified offline: the first real run is what verifies it.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  runE2e, defaults as e2eDefaults, send as e2eSend, waitFor, writeSafe, rmSafe, installRouter, logObj, buildShadowPolicy, policyContentHash, bareOf, modelIs,
  ANCHOR, TAG_MODEL, ASKED_MODEL, NOTICE_MARK, X4_AGENT, X4_PARENT,
} from "./subagent-e2e.mjs";
import { SANDBOX_PORTS, SCRATCH_ROOT, SCRATCH_STATE_DIR, REPO_ROOT, EXECUTED_FILES as G1_FILES, hashExecutedFiles, CCR_CONFIG_DIR, buildLaunchEnv, resolveCcrInstall, ccrInstallLines, REAL_PORTS, descendantsLeafFirst, liveServicePid, parseListenPorts } from "./subagent-sandbox-spec.mjs";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCENARIOS_FILE = "harness/subagent-scenarios.mjs";
export const APPROVAL_FILE = path.join(HERE, "g1-scenarios-approval.json");           // harness/g1-* is gitignored
export const APPROVAL_MAX_AGE_MS = 24 * 3600 * 1000;
/** The router bytes the suite is written for (router/uw-router.next.cjs, the exact bytes G1 passed and the live router has). The plan text carries it, so a router change voids an approval; a test pins it to the file. */
export const ROUTER_SHA256 = "5da75baa60dadb3aa24ff281d4c5ac460f38067428f8f9067826c7bf516f1182";
export const VERDICTS = Object.freeze(["PASS", "FAIL", "FINDING", "DEGRADED"]);
const rel = (f) => path.relative(REPO_ROOT, f).replace(/\\/g, "/");
/** the orchestrator set, this file, and keysync/subagent-policy.mjs (the orchestrator runs it for `last`, see defaultLastText) */
export const EXECUTED_FILES = Object.freeze([...G1_FILES.map(rel), SCENARIOS_FILE, "keysync/subagent-policy.mjs"]);
const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const clip = (v, n = 80) => String(v ?? "").replace(/[^\x20-\x7e]/g, "?").slice(0, n);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const asArr = (x) => (Array.isArray(x) ? x : []);

// ---------------------------------------------------------------- the synthetic policies the scenarios install (router INPUT, built to the shape of compile())
/**
 * rows: stub model names (m-main, m-free, m-big) or {name, b, t}; one provider (uwstub), because the sandbox has one. `bands` gives a row its band id (default 0, one band); `exempt` lists asked selectors the router
 * leaves alone (the helper-call scenario); `minRouter` above the router's version makes the file `newer`. The content hash is the compiler's own rule, so the router verifies it.
 */
export function scenarioPolicy({ rows = ["m-free"], enforcement = "enforce", source = "all-providers", mode = "dynamic", exempt = [], minRouter = 2, now = new Date() } = {}) {
  const p = buildShadowPolicy(now);
  const named = rows.map((r) => (typeof r === "string" ? { name: r } : r));
  // under `inherit` the compiler writes NO rows and NO lists (every non-exempt subagent gets main's model); `free` rows carry the free-provider flag `fp`, and a PAID model is simply not in the file
  const kept = mode === "inherit" ? [] : named;
  p.models = kept.map((r) => ({ s: `uwstub/${r.name}`, c: 200000, f: r.fp ? 1 : 0, t: r.t ?? "v", h: 0, m: 0, n: 0, i: r.fp ? "free" : "$0/$0", p: 0, pb: 0, al: 0, fp: r.fp ? 1 : 0, ft: 0, g: r.b ?? 0, b: r.b ?? 0 }));
  const idx = p.models.map((_, i) => i);
  p.lists = { all: null, byProvider: source === "same-provider" && idx.length ? { uwstub: idx } : {}, prov: idx.length ? { uwstub: idx } : {} };
  p.substitutable = idx.length ? { uwstub: idx.length, "*": idx.length } : { "*": 0 };
  p.counts = { ...p.counts, allowed: idx.length, verified: idx.length, payloadUnknown: idx.length };
  p.owner = { ...p.owner, enforcement, source, mode };
  p.exempt = exempt;
  p.minRouter = minRouter;
  p.contentHash = policyContentHash(p);
  return p;
}
export const policyBandOf = (p, name) => p.models.find((m) => m.s === `uwstub/${name}`)?.b;

// ---------------------------------------------------------------- the scenario table
/**
 * client: "replay" (the request shapes of a real client are enough: the router sees the same headers and bodies) or "real" (what the CLIENT does is measured: needs `claude -p`; with `--real no` the replay
 * of its documented behaviour runs instead and the line says so). runs: how many times the scenario is executed; every run must pass.
 */
export const SCENARIOS = Object.freeze([
  { id: "1", key: "spawn-and-serve", client: "real", runs: 1, title: "SPAWN-AND-SERVE",
    proves: "a spawned subagent is served the model the POLICY chose (the stub's received model equals the router's `ret`, and it differs from the model the agent asked for), and `last` shows it" },
  { id: "2", key: "free-429-handoff", client: "real", runs: 1, title: "FREE MODEL RETURNS 429",
    proves: "the stub returns 429 for the chosen free model, the retry reaches the router, the router HANDS OFF to a different eligible model, the task COMPLETES, and the handoff is in the agent log and in `last`; FINDING (not PASS) when no retry signal reaches the router" },
  { id: "3", key: "all-limited", client: "real", runs: 1, title: "ALL FREE MODELS LIMITED",
    proves: "with exactly ONE model limited (it cools) six new agents are all steered to the one healthy model; then every eligible model returns 429 to ONE agent: it FAILS GRACEFULLY (no hang, at most 8 requests), `handoffNone` is counted, cooling is marked, and routing is never blocked (the next agent is still routed and reaches the stub). Main is NOT a row of the policy (main's own model comes first when it is in the set: plan 6.2, router decide)" },
  { id: "4", key: "team-agents", client: "replay", runs: 1, title: "TEAM AGENTS",
    proves: "agent ids that carry `@` (for example ccr-logs@session-f49cde2f) with a parent agent id are classified as SUBAGENTS, decided by the policy, not treated as main" },
  { id: "5", key: "model-switch", client: "replay", runs: 1, title: "/model SWITCH MID-SESSION",
    proves: "a switch of the main model changes main for NEW subagents and leaves a running subagent on its sticky model (a sticky hit), the one exception being a handoff; the cross-provider variant is NOT measurable here (one sandbox provider)" },
  { id: "6", key: "bad-policy", client: "replay", runs: 1, title: "CORRUPT, MISSING AND NEWER POLICY",
    proves: "a corrupt policy file (POLICY_CORRUPT), a newer one (POLICY_NEWER) and a missing one (silent) each serve the model ASKED for, with the matching warning, and no request fails" },
  { id: "7", key: "worker-restart", client: "replay", runs: 1, title: "WORKER RESTART",
    proves: "after the router worker is replaced (a verified stop of its core worker child: the core pid changes) and the cooling file is cleared, an agent that had been HANDED OFF (to main's model, which comes first when it is in the set) is still served the handed-off model: the sticky journal replays it; FINDING when no restart could be made" },
  { id: "8", key: "helper-calls", client: "replay", runs: 1, title: "HELPER CALLS",
    proves: "title, summary and background calls (an agent id and no tools; no agent id and no tools; an exempt alias) are NEVER rewritten: the stub's model equals the asked model on every one" },
  { id: "9", key: "rollback", client: "replay", runs: 1, title: "ROLLBACK MID-RUN",
    proves: "a rollback takes effect on the VERY NEXT request (a new agent is served the model it asked for) and the sandbox gateway pid and service.json are identical before and after" },
  { id: "10", key: "fan-out", client: "replay", runs: 1, title: "20-SUBAGENT FAN-OUT",
    proves: "with main outside the set, twenty concurrent subagents are spread across the models of the lead row's band: every one inside the band, more than one model used, none on a cooling model, none failed" },
  { id: "11", key: "daily-cap", client: "real", runs: 1, title: "DAILY-CAP 429 (Retry-After 3600)",
    proves: "ONE failure, then AVOIDANCE: the agent fails at once with no further request, and the next agent (a new agent id) is steered to a different eligible model; reported as DEGRADED (as designed), never as a seamless handoff" },
]);
export const CHAOS = Object.freeze([
  { id: "C1", key: "clock-jump", client: "replay", runs: 1, title: "WALL-CLOCK JUMP (state left by a jump)", proves: "state stamped a day in the future and a day in the past, in the shapes the router writes (cooling.json {v,models:{sel:{u,l,t,n,t0}}}, main-<sid>.json with an ISO time), is tolerated by a FRESH worker: requests are served, no router error is counted (the host clock itself is NOT changed)" },
  { id: "C2", key: "torn-journal", client: "replay", runs: 1, title: "TORN JOURNAL", proves: "a journal with garbage and a partial last line is ignored: the request is served, no error is counted, the torn lines are counted" },
  { id: "C3", key: "log-write-failure", client: "replay", runs: 1, title: "LOG AND JOURNAL WRITE FAILURE (ENOSPC emulated)", proves: "on a FRESH worker (its log file descriptors are cached, so a worker that had written the log would not notice), when the agent log and the session journal cannot be written the request is still served and `logDropped` (the log), `journalFail` (the journal) or LOG_DROPPED reports it (the disk is NOT filled: the targets are made unwritable)" },
  { id: "C4", key: "two-workers", client: "replay", runs: 1, title: "TWO WORKERS, ONE STATE DIRECTORY", proves: "with two worker status files both agree on the same sticky model; FINDING when only one worker exists (G1 X2 measured one)" },
]);
export const ALL = Object.freeze([...SCENARIOS, ...CHAOS]);

// ---------------------------------------------------------------- the judges (pure)
const R = (verdict, text) => ({ verdict, text });
const isSub = (r) => !!(r?.headers?.["x-claude-code-agent-id"]) && Array.isArray(r.toolNames) && r.toolNames.length > 0;
const isAux = (r) => !!(r?.headers?.["x-claude-code-agent-id"]) && !(Array.isArray(r?.toolNames) && r.toolNames.length > 0);
const aidOf = (r) => String(r?.headers?.["x-claude-code-agent-id"] ?? "");
const messagesOf = (rs) => asArr(rs).filter((r) => r && (r.method === undefined || r.method === "POST") && /^\/v1\/messages/.test(String(r.path ?? "/v1/messages")));
const logLinesFor = (agents, aid) => asArr(agents).filter((l) => l && typeof l.aid === "string" && l.aid && (aid.toLowerCase() === l.aid.toLowerCase() || aid.toLowerCase().startsWith(l.aid.toLowerCase()) || String(l.aid_full ?? "").toLowerCase() === aid.toLowerCase()));
const counter = (status, k) => (Number.isFinite(status?.counters?.[k]) ? status.counters[k] : 0);
const warnCodes = (status) => asArr(status?.warnings).map((w) => w?.code).filter(Boolean);
const handoffs = (agents, aid) => asArr(agents).filter((l) => l && l.act === "handoff" && (!aid || String(l.aid_full ?? l.aid ?? "").toLowerCase().startsWith(aid.toLowerCase()) || aid.toLowerCase().startsWith(String(l.aid ?? "").toLowerCase())));
const lastShows = (lastOut, text) => asArr(lastOut).some((l) => String(l).includes(text));

const J = {};
/** 1: spawn-and-serve. ev: {client, policy (the model the policy chose), asked, records, agents, lastOut} */
J["1"] = (ev) => {
  const rs = messagesOf(ev.records), subs = rs.filter(isSub);
  if (modelIs(ev.asked, ev.policy) || modelIs(ev.policy, ev.asked)) return R("FAIL", `set up wrongly: the policy's model ${clip(ev.policy)} equals the asked model ${clip(ev.asked)}`);
  if (!subs.length) return R("FAIL", `no subagent request (an agent id and tools) reached the stub among ${plural(rs.length, "request")}: the spawn never happened, nothing is proved`);
  const wrong = subs.filter((r) => !modelIs(r.model, ev.policy));
  if (wrong.length) return R("FAIL", `${wrong.length} of ${subs.length} subagent requests did not reach the policy's model ${clip(ev.policy)} (the stub received ${[...new Set(wrong.map((r) => clip(r.model)))].join(", ")})`);
  const aids = subs.map(aidOf);
  const decided = asArr(ev.agents).filter((l) => l && l.path !== "handoff" && typeof l.ret === "string" && aids.some((a) => a.toLowerCase().startsWith(String(l.aid ?? "~").toLowerCase()) && l.aid) && modelIs(l.ret, ev.policy) && !modelIs(l.asked, l.ret));
  if (!decided.length) return R("FAIL", `the stub received ${clip(ev.policy)} but the router's agent log has no line for the spawned agent with asked != returned == that model: nothing shows the router chose it`);
  if (!lastShows(ev.lastOut, bareOf(ev.policy))) return R("FAIL", `the router chose ${clip(ev.policy)} but \`last\` does not show it`);
  return R("PASS", `${plural(subs.length, "subagent request")} reached the stub on ${clip(ev.policy)}; the agent log shows asked ${clip(decided[0]?.asked)} returned ${clip(decided[0]?.ret)}; \`last\` shows it (${ev.client})`);
};
/**
 * 2: free model 429. ev: {client, aid, chosen, records, agents, lastOut, status0, status1, finalOk, free}. `free` is the FREE-MODE variant (always replayed: it is about the router's choice, not the client): a policy of two
 * free rows from which a PAID model is absent; {aid, chosen, rows (the free selectors), paid (selectors that must never be a handoff target), records, agents, status0, status1}.
 */
const judgeFreeVariant = (f) => {
  if (!f) return R("FAIL", "the free-mode variant (a paid model beside the free rows) was not run: a handoff to a paid model in free mode would pass unnoticed");
  const mine = messagesOf(f.records).filter((r) => aidOf(r) === f.aid);
  const first = mine.find((r) => modelIs(r.model, f.chosen));
  if (!first || first.sent?.status !== 429) return R("FAIL", `free-mode variant: the free model ${clip(f.chosen)} was not answered 429 (not set up)`);
  if (counter(f.status1, "retry") - counter(f.status0, "retry") < 1) return R("FINDING", "free-mode variant: no retry signal reached the router, so the free handoff was not exercised");
  const hs = handoffs(f.agents, f.aid);
  if (!hs.length) return R("FAIL", "free-mode variant: no handoff line for the agent");
  const to = hs[0].to;
  if (asArr(f.paid).some((m) => modelIs(to, m))) return R("FAIL", `free-mode variant: the handoff went to the PAID model ${clip(to)}: free mode must stay inside the free rows`);
  if (!asArr(f.rows).some((m) => modelIs(to, m)) || modelIs(to, f.chosen)) return R("FAIL", `free-mode variant: the handoff went to ${clip(to)}, which is not another free row (${asArr(f.rows).map(clip).join(", ")})`);
  return R("PASS", `free mode: the 429 on ${clip(f.chosen)} was handed to the free row ${clip(to)}, never to the paid ${asArr(f.paid).map(clip).join(", ")}`);
};
J["2"] = (ev) => {
  const free = judgeFreeVariant(ev.free);
  const mine = messagesOf(ev.records).filter((r) => aidOf(r) === ev.aid);
  const first = mine.find((r) => modelIs(r.model, ev.chosen));
  if (!first) return R("FAIL", `the agent never reached the chosen free model ${clip(ev.chosen)} at the stub (saw ${[...new Set(mine.map((r) => clip(r.model)))].join(", ") || "nothing"}): the 429 was never provoked`);
  if (first.sent?.status !== 429) return R("FAIL", `the stub did not answer 429 to the chosen model (it sent ${clip(first.sent?.status ?? "nothing")}): the scenario is not set up`);
  if (counter(ev.status1, "retry") - counter(ev.status0, "retry") < 1) {
    if (free.verdict === "FAIL") return free;
    return R("FINDING", `no retry signal reached the router (counter retry ${counter(ev.status0, "retry")} -> ${counter(ev.status1, "retry")}): the handoff cannot fire from this client path, so the seamless-handoff claim is not shown; the 429 is passed to the client as it is (${clip(ev.client)})`);
  }
  const hs = handoffs(ev.agents, ev.aid);
  if (!hs.length) return R("FAIL", `a retry signal reached the router but the agent log has no handoff line for the agent: the retry was not handed off`);
  const h = hs[0];
  if (!h.from || !h.to || modelIs(h.to, ev.chosen) || !modelIs(h.from, ev.chosen)) return R("FAIL", `the handoff line is ${clip(h.from)} -> ${clip(h.to)}: it must leave ${clip(ev.chosen)} for a different model`);
  const after = mine.filter((r) => r.seq > first.seq && !modelIs(r.model, ev.chosen));
  if (!after.length || after[after.length - 1].sent?.status !== 200) return R("FAIL", `the handoff happened (${clip(h.from)} -> ${clip(h.to)}) but the task did not COMPLETE: the last request on another model was ${after.length ? `answered ${clip(after[after.length - 1].sent?.status)}` : "never made"}`);
  if (ev.finalOk === false) return R("FAIL", "the stub served the handed-off request but the client reported the task failed");
  if (!lastShows(ev.lastOut, "HANDOFF")) return R("FAIL", `the handoff is in the agent log but \`last\` does not show a HANDOFF line`);
  if (free.verdict === "FAIL") return free;
  return R(free.verdict === "FINDING" ? "FINDING" : "PASS", `429 on ${clip(h.from)}, retry signal ${clip(h.rsrc)}, handed off to ${clip(h.to)}, completed with 200; in the agent log and in \`last\` (${clip(ev.client)}). ${free.text}`);
};
/**
 * 3: all limited. ev: {client, aid, responses:[{status, ms}], records, agents, status0, status1, nextReached, ceilingMs, maxRequests, steer}. `steer` is the part that makes the cooldown observable: with ONE healthy
 * model left, agents decided while the others are cooling must all be served that model: {models (what the stub served six new agents), healthy, cooled}.
 */
J["3"] = (ev) => {
  const mine = messagesOf(ev.records).filter((r) => aidOf(r) === ev.aid), max = ev.maxRequests ?? 8, ceil = ev.ceilingMs ?? 20000;
  const st = ev.steer;
  if (!st || asArr(st.models).length < 3) return R("FAIL", "the steering check did not run: with a cooling model nothing shows the cooldown ladder steers the next agent away");
  const bad = asArr(st.models).filter((m) => !modelIs(m, st.healthy));
  if (bad.length) return R("FAIL", `${bad.length} of ${st.models.length} agents decided while ${asArr(st.cooled).map(clip).join(", ")} were cooling were NOT served the one healthy model ${clip(st.healthy)} (they got ${[...new Set(bad.map(clip))].join(", ")}): the cooldown did not steer them`);
  if (!mine.length) return R("FAIL", "the agent never reached the stub: nothing was limited");
  if (mine.some((r) => r.sent?.status !== 429)) return R("FAIL", "the stub answered something other than 429 to the agent: the scenario is not set up");
  if (mine.length > max) return R("FAIL", `${mine.length} requests reached the stub for one agent (limit ${max}): a retry storm`);
  const slow = asArr(ev.responses).filter((x) => x && x.ms > ceil);
  if (slow.length) return R("FAIL", `${slow.length} response(s) took more than ${ceil} ms: the agent hung instead of failing`);
  if (asArr(ev.responses).length && ev.responses[ev.responses.length - 1].status !== 429) return R("FAIL", `the agent's last answer was ${clip(ev.responses[ev.responses.length - 1].status)}, not the limit it should fail with`);
  if (counter(ev.status1, "handoffNone") - counter(ev.status0, "handoffNone") < 1) return R("FAIL", `handoffNone was not counted (${counter(ev.status0, "handoffNone")} -> ${counter(ev.status1, "handoffNone")}) although no eligible model was left`);
  if (counter(ev.status1, "coolMark") - counter(ev.status0, "coolMark") < 1) return R("FAIL", "no model was marked cooling after the 429s");
  if (!ev.nextReached) return R("FAIL", "the next agent did not reach the stub: routing was BLOCKED by the cooldown");
  return R("PASS", `${plural(st.models.length, "agent")} decided during the cooldown were all steered to the healthy ${clip(st.healthy)}; then ${plural(mine.length, "request")} for the failing agent (limit ${max}), every answer under ${ceil} ms, handoffNone ${counter(ev.status1, "handoffNone")}, coolMark ${counter(ev.status1, "coolMark")}, the next agent was still routed (${clip(ev.client)})`);
};
/** 4: team agents. ev: {aid, parent, policy, records, agents, classify, status0, status1} */
J["4"] = (ev) => {
  if (!/@/.test(String(ev.aid))) return R("FAIL", "set up wrongly: the agent id carries no @");
  const mine = messagesOf(ev.records).filter((r) => aidOf(r) === ev.aid);
  if (!mine.length) return R("FAIL", `no request with agent id ${clip(ev.aid)} reached the stub`);
  if (!mine.every(isSub)) return R("FAIL", "the stub's request for the team agent does not have the subagent shape (agent id and tools)");
  const cls = asArr(ev.classify).filter((c) => c && String(c.aid ?? "").toLowerCase().startsWith(String(ev.aid).toLowerCase().slice(0, 12)));
  if (!cls.length || cls.some((c) => c.cls !== "sub")) return R("FAIL", `the classifier log classes the team agent as ${cls.map((c) => clip(c.cls, 12)).join(",") || "nothing"}, not sub`);
  if (!asArr(ev.agents).some((l) => l && String(l.aid ?? "").toLowerCase() && String(ev.aid).toLowerCase().startsWith(String(l.aid).toLowerCase()) && modelIs(l.ret, ev.policy))) return R("FAIL", `the agent log has no decision for the team agent returning ${clip(ev.policy)}`);
  if (!mine.every((r) => modelIs(r.model, ev.policy))) return R("FAIL", `the stub received ${[...new Set(mine.map((r) => clip(r.model)))].join(", ")}, not the policy's ${clip(ev.policy)}`);
  return R("PASS", `agent ${clip(ev.aid)} (parent ${clip(ev.parent)}) was classified sub, decided by the policy and served ${clip(ev.policy)}`);
};
/** 5: model switch. ev: {aid, aidNew, firstModel, laterModel, newAgentMain, switchedTo, agents, status0, status1} */
J["5"] = (ev) => {
  if (!ev.firstModel || !ev.laterModel) return R("FAIL", "the running agent's two requests did not both reach the stub");
  if (!modelIs(ev.laterModel, ev.firstModel)) return R("FAIL", `the running agent moved from ${clip(ev.firstModel)} to ${clip(ev.laterModel)} after the switch: it must stay on its sticky model`);
  // the counter is read from a FRESH status (the router flushes status.json at most every 5 s); the router's own log is the second witness: the first sticky hit of an agent writes an `act: "sticky"` line
  const hits = counter(ev.status1, "stickyHit") - counter(ev.status0, "stickyHit");
  const logged = asArr(ev.decisions).some((x) => x && x.act === "sticky" && x.aid && String(ev.aid).toLowerCase().startsWith(String(x.aid).toLowerCase()));
  if (hits < 1 && !logged) return R("FAIL", `the router counted no sticky hit for the running agent (stickyHit ${counter(ev.status0, "stickyHit")} -> ${counter(ev.status1, "stickyHit")}) and its decision log has no sticky line for it`);
  const l = asArr(ev.agents).filter((x) => x && x.aid && String(ev.aidNew).toLowerCase().startsWith(String(x.aid).toLowerCase())).pop();
  if (!l) return R("FAIL", "the router logged no decision for the new agent");
  if (!modelIs(l.main, ev.switchedTo)) return R("FAIL", `the new agent was decided with main ${clip(l.main)}, not the switched-to ${clip(ev.switchedTo)}`);
  return R("PASS", `the running agent stayed on ${clip(ev.firstModel)} (sticky hits +${hits}${logged ? ", a sticky line in the decision log" : ""}); the new agent saw main ${clip(l.main)}. Cross-provider variant: NOT measurable (one sandbox provider)`);
};
/** 6: bad policy. ev: {variants:[{variant, status, stubModel, asked, warnings}]} */
J["6"] = (ev) => {
  const want = { corrupt: "POLICY_CORRUPT", newer: "POLICY_NEWER", missing: null };
  const vs = asArr(ev.variants), bad = [];
  for (const k of Object.keys(want)) {
    const v = vs.find((x) => x?.variant === k);
    if (!v) { bad.push(`${k}: not run`); continue; }
    if (v.status !== 200) bad.push(`${k}: the request FAILED (${clip(v.status, 8)})`);
    else if (!modelIs(v.stubModel, v.asked)) bad.push(`${k}: served ${clip(v.stubModel)}, not the asked ${clip(v.asked)}`);
    if (want[k] && !asArr(v.warnings).includes(want[k])) bad.push(`${k}: the warning ${want[k]} is missing (saw ${asArr(v.warnings).map((c) => clip(c, 40)).join(",") || "none"})`);
    if (!want[k] && asArr(v.warnings).some((c) => /^POLICY_/.test(c))) bad.push(`${k}: a missing policy must be SILENT but ${asArr(v.warnings).filter((c) => /^POLICY_/.test(c)).map((c) => clip(c, 40)).join(",")} was raised`);
  }
  return bad.length ? R("FAIL", bad.join("; ")) : R("PASS", "corrupt: POLICY_CORRUPT, newer: POLICY_NEWER, missing: silent; each served the asked model with HTTP 200");
};
/** 7: worker restart. ev: {handedTo, afterModel, pidBefore, pidAfter, handoffSeen} */
J["7"] = (ev) => {
  const su = ev.setup ?? {};
  const detail = `setup: handoffNone ${clip(su.handoffNone ?? "?", 6)}, retry ${clip(su.retry ?? "?", 6)}, cooling [${asArr(su.cooling).map((x) => clip(x, 40)).join(", ") || "empty"}], the agent's answers [${asArr(su.answers).map((x) => clip(x, 30)).join(", ") || "none"}]; core pid ${clip(ev.pidBefore ?? "?", 12)} -> ${clip(ev.pidAfter ?? "?", 12)}`;
  if (!ev.handoffSeen) return R("FAIL", `the setup handoff did not happen, so there is no handed-off model to replay (${detail})`);
  if (!(ev.pidBefore && ev.pidAfter) || ev.pidBefore === ev.pidAfter) return R("FINDING", `no worker restart could be made (core pid ${clip(ev.pidBefore ?? "?", 12)} -> ${clip(ev.pidAfter ?? "?", 12)}): the journal replay is not shown here (router unit tests cover it)`);
  if (!ev.afterModel || !modelIs(ev.afterModel, ev.handedTo)) return R("FAIL", `after the restart (core pid ${ev.pidBefore} -> ${ev.pidAfter}) the agent was served ${clip(ev.afterModel)}, not the handed-off ${clip(ev.handedTo)} (${detail})`);
  return R("PASS", `core pid ${ev.pidBefore} -> ${ev.pidAfter}; the agent was still served the handed-off model ${clip(ev.handedTo)}`);
};
/**
 * 8: helper calls. ev: {calls:[{kind, asked, stubModel, status}], control}. The exempt alias is honoured ONLY under `inherit` (router decide(): exempt is read in the inherit branch), so that call runs under an inherit policy;
 * `control` is a non-exempt subagent request under the same policy: it must be MOVED to main's model, or the exempt check proves nothing: {asked, main, stubModel, status}.
 */
J["8"] = (ev) => {
  const calls = asArr(ev.calls);
  if (calls.length < 3) return R("FAIL", `only ${calls.length} helper-shaped request(s) were measured, 3 expected`);
  const c = ev.control;
  if (!c || c.status !== 200 || !modelIs(c.stubModel, c.main) || modelIs(c.stubModel, c.asked)) return R("FAIL", `the control did not move: a non-exempt subagent asking ${clip(c?.asked)} under inherit was served ${clip(c?.stubModel)}, not main's ${clip(c?.main)}: the exempt check would prove nothing`);
  const bad = calls.filter((x) => x.status !== 200 || !modelIs(x.stubModel, x.asked));
  if (bad.length) return R("FAIL", `${bad.length} of ${calls.length} helper requests were rewritten or failed: ${bad.map((x) => `${clip(x.kind)} asked ${clip(x.asked)} got ${clip(x.stubModel)} (HTTP ${clip(x.status)})`).join("; ")}`);
  return R("PASS", `${calls.length} of ${calls.length} helper requests (${[...new Set(calls.map((x) => clip(x.kind)))].join(", ")}) stayed on the model asked for; the control under the same inherit policy WAS moved to ${clip(c.stubModel)}`);
};
/** 9: rollback. ev: {beforeModel, policy, afterModel, asked, gw0, gw1, flag} */
J["9"] = (ev) => {
  if (!modelIs(ev.beforeModel, ev.policy)) return R("FAIL", `before the rollback the policy was not enforcing (served ${clip(ev.beforeModel)}, not ${clip(ev.policy)})`);
  if (!ev.flag) return R("FAIL", "the rollback flag was not written");
  if (!modelIs(ev.afterModel, ev.asked)) return R("FAIL", `the very next request after the rollback was served ${clip(ev.afterModel)}, not the asked ${clip(ev.asked)}`);
  if (!ev.gw0 || !ev.gw1 || ev.gw0.pid !== ev.gw1.pid || ev.gw0.serviceSha !== ev.gw1.serviceSha) return R("FAIL", `the gateway changed across the rollback (pid ${clip(ev.gw0?.pid, 12)} -> ${clip(ev.gw1?.pid, 12)}, service.json ${ev.gw0?.serviceSha === ev.gw1?.serviceSha ? "same" : "different"})`);
  return R("PASS", `the next request after the rollback was served ${clip(ev.afterModel)} (asked); sandbox gateway pid ${ev.gw1.pid} and service.json unchanged`);
};
/**
 * 10: fan-out, TWO bands and a REAL cooled model. ev: {band (the lead band's selectors), otherBand, cooled, a:[{aid, status, ret}] (before any cooling), b:[...] (after `cooled` was cooled)}. Phase a: twenty agents, every
 * one inside the lead band, none in the other band, more than one model used (the spread). Phase b: with a band model cooling, none of twenty is served it.
 */
J["10"] = (ev) => {
  const band = asArr(ev.band).map(bareOf), other = asArr(ev.otherBand).map(bareOf), cooled = asArr(ev.cooled).map(bareOf);
  const a = asArr(ev.a), b = asArr(ev.b);
  if (a.length < 20 || b.length < 20) return R("FAIL", `only ${a.length} and ${b.length} of 20 agents were measured`);
  if (!other.length || !cooled.length || !cooled.every((m) => band.includes(m))) return R("FAIL", "set up wrongly: the scenario needs a second band and a cooled model INSIDE the lead band");
  const failed = [...a, ...b].filter((x) => x.status !== 200);
  if (failed.length) return R("FAIL", `${failed.length} of ${a.length + b.length} agents failed`);
  const outside = a.filter((x) => !band.includes(bareOf(x.ret)));
  if (outside.length) return R("FAIL", `${outside.length} of ${a.length} agents were served outside the lead band (${[...new Set(outside.map((x) => clip(x.ret)))].join(", ")}; band ${band.join(", ")}; a banded-spread violation reaches ${other.join(", ")})`);
  const used = new Set(a.map((x) => bareOf(x.ret)));
  if (band.length > 1 && used.size < 2) return R("FAIL", `all ${a.length} agents landed on ONE model (${clip([...used][0])}) although the band holds ${band.length}: no spread`);
  const onCooled = b.filter((x) => cooled.includes(bareOf(x.ret)));
  if (onCooled.length) return R("FAIL", `${onCooled.length} of ${b.length} agents decided AFTER ${cooled.map((x) => clip(x)).join(", ")} was cooled were still served it`);
  const outsideB = b.filter((x) => !band.includes(bareOf(x.ret)));
  if (outsideB.length) return R("FAIL", `${outsideB.length} of ${b.length} agents decided during the cooldown left the lead band (${[...new Set(outsideB.map((x) => clip(x.ret)))].join(", ")})`);
  return R("PASS", `${a.length} agents spread over ${used.size} of ${band.length} lead-band models (${[...used].sort().map((x) => clip(x)).join(", ")}), none in the other band; after ${cooled.map((x) => clip(x)).join(", ")} was cooled, ${b.length} more agents all avoided it and stayed in the band`);
};
/** 11: daily cap. ev: {client, aid, failed, recordsForFirst, chosen, nextModels (the models six NEW agents were served: one agent could avoid by chance), overlay}. `failed` is read from the STUB (a 429 with Retry-After was sent to the agent), never from a client exit code. */
J["11"] = (ev) => {
  if (!ev.failed) return R("FAIL", "the stub did not answer the first agent with a 429 and a Retry-After (no subagent request, or none answered): the scenario is not set up");
  if (ev.recordsForFirst !== 1) return R("FINDING", `${clip(ev.recordsForFirst)} requests reached the stub for the first agent, 1 expected: the client does not fail at once on a long Retry-After (${clip(ev.client)})`);
  const next = asArr(ev.nextModels);
  if (!next.length) return R("FAIL", "the next agents did not reach the stub");
  const same = next.filter((m) => modelIs(m, ev.chosen));
  if (same.length) return R("FINDING", `${same.length} of ${next.length} next agents were served the SAME limited model ${clip(ev.chosen)}: nothing steered them away (${ev.overlay ? "an overlay record was fed" : "no overlay record"}): the avoidance the quality bar promises is not shown`);
  return R("DEGRADED", `ONE failure (the stub saw 1 request for the first agent), then avoidance: all ${next.length} next agents were served another model (${[...new Set(next.map((m) => clip(bareOf(m))))].join(", ")}) instead of ${clip(ev.chosen)}${ev.overlay ? " (steered by a fed overlay record: the observer does not run in the sandbox)" : ""}. This is the degraded behaviour, NOT a seamless handoff`);
};
/** C1..C4 */
J.C1 = (ev) => {
  const bad = asArr(ev.requests).filter((r) => r.status !== 200);
  if (bad.length) return R("FAIL", `${bad.length} of ${asArr(ev.requests).length} request(s) failed after the stamped state was written: ${bad.map((r) => `${clip(r.label ?? "?", 24)} HTTP ${clip(r.status ?? "none", 8)}${r.error ? ` (${clip(r.error, 60)})` : ""}`).join("; ")}`);
  if (counter(ev.status1, "error") > counter(ev.status0, "error")) return R("FAIL", `the router counted ${counter(ev.status1, "error") - counter(ev.status0, "error")} error(s) on future- and past-dated state`);
  return R("PASS", `${plural(asArr(ev.requests).length, "request")} served over future- and past-dated state, 0 router errors (the host clock itself was not changed)`);
};
J.C2 = (ev) => {
  if (ev.status !== 200) return R("FAIL", `the request failed (${clip(ev.status, 8)}) over a torn journal`);
  if (counter(ev.status1, "error") > counter(ev.status0, "error")) return R("FAIL", "the router counted an error over a torn journal");
  if (counter(ev.status1, "stickyJournalTorn") - counter(ev.status0, "stickyJournalTorn") < 1) return R("FAIL", "the torn journal lines were not counted (stickyJournalTorn did not move)");
  return R("PASS", `served over a torn journal; stickyJournalTorn +${counter(ev.status1, "stickyJournalTorn") - counter(ev.status0, "stickyJournalTorn")}, 0 errors`);
};
J.C3 = (ev) => {
  if (asArr(ev.requests).some((r) => r.status !== 200)) return R("FAIL", "a request failed while the logs could not be written");
  const dropped = counter(ev.status1, "logDropped") - counter(ev.status0, "logDropped");
  const jfail = counter(ev.status1, "journalFail") - counter(ev.status0, "journalFail");       // a failed JOURNAL write counts journalFail, a failed LOG write counts logDropped
  if (dropped < 1 && jfail < 1 && !warnCodes(ev.status1).includes("LOG_DROPPED")) return R("FAIL", `nothing reported the unwritable log and journal (logDropped ${counter(ev.status0, "logDropped")} -> ${counter(ev.status1, "logDropped")}, journalFail ${counter(ev.status0, "journalFail")} -> ${counter(ev.status1, "journalFail")}, LOG_DROPPED not raised)`);
  return R("PASS", `${plural(asArr(ev.requests).length, "request")} served with unwritable logs; logDropped +${dropped}, journalFail +${jfail}${warnCodes(ev.status1).includes("LOG_DROPPED") ? ", LOG_DROPPED raised" : ""}`);
};
J.C4 = (ev) => {
  if ((ev.workerFiles ?? 0) < 2) return R("FINDING", `only ${clip(ev.workerFiles ?? 0, 6)} worker status file(s): two workers on one state directory cannot be exercised here (G1 X2: one worker); the cross-worker paths are covered by the router journal tests`);
  const models = new Set(asArr(ev.models).map(bareOf));
  return models.size === 1 ? R("PASS", `${clip(ev.workerFiles, 6)} workers agree on one sticky model (${clip([...models][0])})`) : R("FAIL", `the workers disagree: ${[...models].map((x) => clip(x)).join(", ")}`);
};
export const judgeOf = (id) => J[id];

/** One scenario over `runs` evidence objects: every run must pass; the weakest verdict decides (FAIL over FINDING over DEGRADED over PASS). */
export function judgeRuns(scn, evidences) {
  const rows = evidences.map((ev) => { try { return J[scn.id](ev); } catch (e) { return R("FAIL", `the judge threw: ${clip(e?.message, 100)}`); } });
  const order = { FAIL: 3, FINDING: 2, DEGRADED: 1, PASS: 0 };
  const worst = rows.reduce((a, r) => (order[r.verdict] > order[a.verdict] ? r : a), rows[0] ?? R("FAIL", "no run produced evidence"));
  const passed = rows.filter((r) => r.verdict === "PASS" || r.verdict === "DEGRADED").length;
  return { id: scn.id, verdict: worst.verdict, runs: rows.length, passed, text: worst.text, rows, client: evidences.map((e) => e?.client).find(Boolean) ?? "replay" };
}
/** The one result line of a scenario (the CLIENT is named on every line; a non-PASS line says it is not G3 evidence), and the parse of it (the e2e orchestrator hands the suite verdict every line it emitted). */
export const scenarioLine = (r, scn) => `SCENARIO ${r.verdict} ${r.id} ${scn?.title ?? ""} [${r.client ?? "replay"}] (${r.passed} of ${r.runs} run${r.runs === 1 ? "" : "s"}) :: ${r.text}${r.verdict === "PASS" ? "" : " [not G3 evidence]"}`;
export const parseScenarioLine = (l) => { const m = /^SCENARIO (PASS|FAIL|FINDING|DEGRADED) (\S+) .*? \[([^\]]*)\] \((\d+) of (\d+) runs?\) :: (.*)$/s.exec(String(l)); return m ? { verdict: m[1], id: m[2], client: m[3], passed: Number(m[4]), runs: Number(m[5]), text: m[6] } : null; };
/** FINDING is an honest limit only where the plan says so: scenario 2 (no retry signal reaches the router), 7 (no restart could be made) and C4 (one worker). Scenario 11 is DEGRADED (or FAIL), never PASS or FINDING. */
export const FINDING_OK = Object.freeze(["2", "7", "C4"]);
/**
 * The suite verdict. OK needs: no FAIL anywhere (the real-client isolation check RC included), every requested scenario present, FINDING only where FINDING_OK allows it, scenario 11 DEGRADED, no router-bytes FINDING,
 * no red live-state line. `notG3` names every scenario whose line is not a PASS: those are not evidence for the G3 precondition.
 */
export function suiteVerdict(lines, ids) {
  const parsed = lines.map(parseScenarioLine).filter(Boolean), problems = [];
  for (const id of ids) { const r = parsed.find((p) => p.id === id); if (!r) problems.push(`scenario ${id} produced no result line`); }
  for (const r of parsed) {
    if (r.verdict === "FAIL") problems.push(`scenario ${r.id} FAILED: ${r.text}`);
    else if (r.verdict === "FINDING" && !FINDING_OK.includes(r.id)) problems.push(`scenario ${r.id} is a FINDING, which the plan allows only for scenarios ${FINDING_OK.join(", ")}: ${r.text}`);
    else if (r.id === "11" && r.verdict !== "DEGRADED") problems.push(`scenario 11 must be DEGRADED (one failure, then avoidance), not ${r.verdict}`);
  }
  if (lines.some((l) => /^FINDING router sha256 /.test(l))) problems.push("the router bytes under test are not the ones this suite was written for");
  const a11 = lines.find((l) => /\bA11\b/.test(l) && /^FAIL/.test(l));
  if (a11) problems.push(`the live-state check failed: ${a11}`);
  const counts = {}; for (const p of parsed) counts[p.verdict] = (counts[p.verdict] ?? 0) + 1;
  return { ok: problems.length === 0, problems, counts, notG3: parsed.filter((p) => p.verdict !== "PASS").map((p) => p.id) };
}

// ---------------------------------------------------------------- the runners (each returns EVIDENCE; they drive a primitives object, so a fake sandbox can stand in)
const SUB = (p, over) => p.send("sub", { model: ASKED_MODEL, tag: TAG_MODEL, agentTool: false, ...over });     // a real subagent has no Agent tool
// The router flushes status.json at most every 5 s (a new warning code forces a flush), so a status read straight after a request can be 5 s old: EVERY status0/status1 read goes through freshStatus (wait, one aux
// request, wait, read), which also hands back the cooling list. Scenario 6 reads `status` only for WARNING codes, which force their own flush.
const evidenceBase = async (p, withStatus = true) => ({ agents: await p.readLog("agents.jsonl"), classify: await p.readLog("classify.jsonl"), status: withStatus ? await p.freshStatus() : undefined });
/** The precondition of every scenario that reads cooling or counts a handoff: no model is cooling (a leak from an earlier scenario would be blamed on the router). Returns the fresh status it read. */
const needCoolingEmpty = async (p, label) => {
  const s = await p.freshStatus(), c = asArr(s?.cooling);
  if (c.length) throw new Error(`precondition of ${label}: cooling is not empty (${c.map((x) => clip(x?.key, 30)).join(", ")}): state of an earlier scenario leaked, this is not a router verdict`);
  return s;
};
const aidFor = (run, tag) => `uwsc-${tag}-${run}`;
const stubSub = (p, aid) => messagesOf(p.stub.records).filter((r) => aidOf(r) === aid);
const rollupLast = (p) => p.lastOut();

export const RUN = {};
RUN["1"] = async (p, o) => {
  const aid = aidFor(o.run, "s1");
  await p.policy(scenarioPolicy({ rows: ["m-free"] }));
  p.stub.setScript({}); p.stub.clear();
  const sess = `uwsc-s1-${o.run}`;
  if (o.real && p.claude) {
    let spawned = false;
    p.stub.setScript({ onMain: (rec) => { if (spawned) return undefined; spawned = true; return { subagent_type: "general-purpose", label: "s1" }; } });
    await p.claude({ prompt: "Use the Agent tool once to delegate a trivial task, then reply done.", maxTurns: 4 });
  } else {
    await p.send("main", { model: ANCHOR, session: sess });
    await SUB(p, { session: sess, agentId: aid, messages: 3 });
  }
  await p.settle();
  const base = await evidenceBase(p, false);
  const realAid = o.real && p.claude ? aidOf(messagesOf(p.stub.records).find(isSub)) : aid;
  return { client: clientLabel(o, p), policy: "uwstub/m-free", asked: o.real && p.claude ? ANCHOR : ASKED_MODEL, aid: realAid, records: [...p.stub.records], agents: base.agents, lastOut: await rollupLast(p) };
};
const REAL_PROMPT = "Use the Agent tool once to delegate a trivial task, then reply done.";
const clientLabel = (o, p) => (o.real && p.claude ? "real claude -p" : o.real ? "replay (real client unavailable: no usable claude launcher)" : "replay");
/** The stub's scripted spawn for a REAL client run: the first main-shaped request answers with ONE Agent tool call, later ones with text. setScript replaces the whole script, so every real run sets this with its own rules. */
const spawnOnce = (label = "scn") => { let done = false; return () => { if (done) return undefined; done = true; return { subagent_type: "general-purpose", label }; }; };
const firstSubAid = (p) => aidOf(messagesOf(p.stub.records).find(isSub));
const limitFree = (rec) => (modelIs(rec.model, "uwstub/m-free") && rec.headers?.["x-claude-code-agent-id"] ? 429 : undefined);
const OVERLAY_WAIT_MS = 1200;                            // above the router's one-second overlay re-read
const MAIN_OUTSIDE = "uwstub/m-lead";                    // a main model that is not a row of the scenario's policy
const NOT_IN_SET = "uwstub/m-gone";                       // a TAG naming a model the policy does not hold: the router substitutes (the asked model stays a real stub model, so CCR resolves the request)
RUN["2"] = async (p, o) => {
  p.markDirty?.();
  const aid = aidFor(o.run, "s2"), sess = `uwsc-s2-${o.run}`, real = !!(o.real && p.claude);
  await p.policy(scenarioPolicy({ rows: ["m-free", "m-big", "m-main"] }));
  p.stub.setScript({ decide: limitFree, ...(real ? { onMain: spawnOnce("s2") } : {}) }); p.stub.clear();
  if (!real) await p.send("main", { model: ANCHOR, session: sess });
  const status0 = await needCoolingEmpty(p, "scenario 2");
  let finalOk;
  if (real) finalOk = (await p.claude({ prompt: REAL_PROMPT, maxTurns: 6 }))?.code === 0;
  else {
    await SUB(p, { session: sess, agentId: aid, messages: 3 });                       // the first attempt: the stub answers 429 for the chosen free model
    await SUB(p, { session: sess, agentId: aid, messages: 3, retryCount: 1 });        // the client's retry: the same body again (the `len` signal) with the SDK retry-count header
  }
  await p.settle();
  const base = await evidenceBase(p), records = [...p.stub.records], lastOut = await rollupLast(p);
  // the FREE-MODE variant, always replayed: a fresh worker, a free policy of two free rows (the paid m-big is not in it), the same 429 on m-free
  await p.reset?.(); p.markDirty?.();
  const faid = aidFor(o.run, "s2f"), fsess = `uwsc-s2f-${o.run}`;
  await p.policy(scenarioPolicy({ mode: "free", rows: [{ name: "m-free", fp: 1 }, { name: "m-main", fp: 1 }] }));
  p.stub.setScript({ decide: limitFree }); p.stub.clear();
  await p.send("main", { model: ANCHOR, session: fsess });
  const fstatus0 = await needCoolingEmpty(p, "scenario 2 (free-mode variant)");
  await SUB(p, { session: fsess, agentId: faid, messages: 3 });
  await SUB(p, { session: fsess, agentId: faid, messages: 3, retryCount: 1 });
  await p.settle();
  const fbase = await evidenceBase(p);
  return { client: clientLabel(o, p), aid: real ? aidOf(records.find(isSub)) : aid, chosen: "uwstub/m-free", records, agents: base.agents, lastOut, status0, status1: base.status, finalOk,
    free: { aid: faid, chosen: "uwstub/m-free", rows: ["uwstub/m-free", "uwstub/m-main"], paid: ["uwstub/m-big"], records: [...p.stub.records], agents: fbase.agents, status0: fstatus0, status1: fbase.status } };
};
RUN["3"] = async (p, o) => {
  p.markDirty?.();
  const sess = `uwsc-s3-${o.run}`, real = !!(o.real && p.claude);
  // main (ANCHOR, m-main) is NOT a row: main's own model comes first when it is in the set (plan 6.2, router decide), which would hide both the steering and the failure. Two rows only, and ONE model cools in step 1:
  // two DISTINCT failing models of the sandbox's single provider within 5 minutes would also cool the provider key (router coolFail) and demote every row, so step 1 must cool exactly one.
  await p.policy(scenarioPolicy({ rows: ["m-free", "m-big"] }));
  p.stub.setScript({ decide: limitFree }); p.stub.clear();
  await p.send("main", { model: ANCHOR, session: sess });
  await needCoolingEmpty(p, "scenario 3");
  // step 1 (replay: this is the router's cooldown, not the client): ONLY m-free returns 429. One agent is limited, its retry is handed on to m-big (m-free cools); then six NEW agents (a tag the policy does not hold, so each
  // is substituted) must all be served the one healthy model
  const warm = aidFor(o.run, "s3w");
  await SUB(p, { session: sess, agentId: warm, messages: 3 });
  await SUB(p, { session: sess, agentId: warm, messages: 3, retryCount: 1 });
  const steerIds = Array.from({ length: 6 }, (_, i) => aidFor(o.run, `s3s${i}`));
  for (const id of steerIds) await SUB(p, { session: sess, agentId: id, messages: 3, model: ANCHOR, tag: NOT_IN_SET });
  await p.settle();
  const steer = { models: steerIds.map((id) => stubSub(p, id)[0]?.model).filter(Boolean), healthy: "uwstub/m-big", cooled: ["uwstub/m-free"] };
  // step 2: now EVERY model returns 429 for a subagent, and ONE agent meets it on m-big (m-free is cooling), is retried, and no eligible model is left
  p.stub.setScript({ decide: (rec) => (rec.headers?.["x-claude-code-agent-id"] ? 429 : undefined), ...(real ? { onMain: spawnOnce("s3") } : {}) }); p.stub.clear();
  const status0 = await p.freshStatus(), responses = [], aid = aidFor(o.run, "s3");
  if (real) { const t0 = p.now(); await p.claude({ prompt: REAL_PROMPT, maxTurns: 6 }); responses.push({ status: 429, ms: p.now() - t0 }); }
  else for (let i = 0; i < 5; i++) { const r = await SUB(p, { session: sess, agentId: aid, messages: 3, model: ANCHOR, tag: NOT_IN_SET, ...(i ? { retryCount: i } : {}) }); responses.push({ status: r.status, ms: r.ms }); }
  await p.settle();
  // routing is never blocked: the NEXT agent is still routed (every row is cooling, so a demoted row is used); read from the stub's records of THAT agent, never from a record count (the status flush sends an aux request of its own)
  const nextAid = aidFor(o.run, "s3n");
  await SUB(p, { session: sess, agentId: nextAid, messages: 3, model: ANCHOR, tag: NOT_IN_SET });
  await p.settle();
  const base = await evidenceBase(p);
  return { client: clientLabel(o, p), aid: real ? firstSubAid(p) : aid, steer, responses, records: [...p.stub.records], agents: base.agents, status0, status1: base.status, nextReached: stubSub(p, nextAid).length > 0 };
};
RUN["4"] = async (p, o) => {
  const sess = `uwsc-s4-${o.run}`;
  await p.policy(scenarioPolicy({ rows: ["m-free"] }));
  p.stub.setScript({}); p.stub.clear();
  await p.send("main", { model: ANCHOR, session: sess });
  await SUB(p, { session: sess, agentId: X4_AGENT, parent: X4_PARENT, messages: 3 });
  await p.settle();
  const base = await evidenceBase(p, false);
  return { aid: X4_AGENT, parent: X4_PARENT, policy: "uwstub/m-free", records: [...p.stub.records], agents: base.agents, classify: base.classify, status1: base.status };
};
RUN["5"] = async (p, o) => {
  const sess = `uwsc-s5-${o.run}`, a = aidFor(o.run, "s5a"), b = aidFor(o.run, "s5b");
  await p.policy(scenarioPolicy({ rows: ["m-free", "m-big"] }));
  p.stub.setScript({}); p.stub.clear();
  await p.send("main", { model: "uwstub/m-main", session: sess });
  await SUB(p, { session: sess, agentId: a, messages: 3 });
  await p.settle();
  const firstModel = stubSub(p, a)[0]?.model;
  const status0 = await p.freshStatus();
  await p.send("main", { model: "uwstub/m-big", session: sess });                       // the /model switch: main's requests now carry another model
  await SUB(p, { session: sess, agentId: a, messages: 5 });                              // the running agent's next turn (grown messages: no retry signal)
  await SUB(p, { session: sess, agentId: b, messages: 3, model: "uwstub/m-main", tag: undefined });
  await p.settle();
  const base = await evidenceBase(p);
  const later = stubSub(p, a);
  return { aid: a, aidNew: b, firstModel, laterModel: later[later.length - 1]?.model, switchedTo: "uwstub/m-big", agents: base.agents, decisions: await p.readLog("decisions.jsonl"), status0, status1: base.status };
};
RUN["6"] = async (p, o) => {
  const variants = [], sess = `uwsc-s6-${o.run}`;
  const one = async (variant, prepare) => {
    await prepare();
    p.stub.setScript({}); p.stub.clear();
    const seen = new Set(warnCodes(await p.status()));                                   // a warning of an earlier variant may still be on the status: only a code NEW to this variant counts
    await p.send("main", { model: ANCHOR, session: `${sess}${variant}` });
    const r = await p.send("sub", { model: ASKED_MODEL, agentId: aidFor(o.run, `s6${variant}`), session: `${sess}${variant}`, messages: 3, agentTool: false });
    await p.settle();
    const st = await p.status();
    variants.push({ variant, status: r.status, stubModel: stubSub(p, aidFor(o.run, `s6${variant}`))[0]?.model, asked: ASKED_MODEL, warnings: warnCodes(st).filter((c) => !seen.has(c)) });
  };
  await one("corrupt", () => p.writeState("policy.json", "{ this is not json"));
  await one("newer", () => p.policy(scenarioPolicy({ rows: ["m-free"], minRouter: 99 })));
  await one("missing", () => p.removeState("policy.json"));
  return { variants };
};
RUN["7"] = async (p, o) => {
  p.markDirty?.();
  const aid = aidFor(o.run, "s7"), sess = `uwsc-s7-${o.run}`;
  // main (ANCHOR, m-main) IS a row here on purpose: a handoff goes to main's own model first (plan 6.2, router decide), so the handed-off model is m-main and the journal must replay exactly that
  await p.policy(scenarioPolicy({ rows: ["m-free", "m-big", "m-main"] }));
  p.stub.setScript({ decide: limitFree }); p.stub.clear();
  await p.send("main", { model: ANCHOR, session: sess });
  await needCoolingEmpty(p, "scenario 7");
  await SUB(p, { session: sess, agentId: aid, messages: 3 });
  await SUB(p, { session: sess, agentId: aid, messages: 3, retryCount: 1 });
  await p.settle();
  const hs = handoffs(await p.readLog("agents.jsonl"), aid);
  const handedTo = hs[0]?.to;
  const st = await p.freshStatus();                                                      // what the judge prints if the setup handoff is missing: handoffNone, retry, the cooling list, the agent's answers
  const setup = { handoffNone: counter(st, "handoffNone"), retry: counter(st, "retry"), cooling: asArr(st?.cooling).map((x) => x?.key), answers: stubSub(p, aid).map((r) => `${bareOf(r.model)}:${r.sent?.status}`) };
  const restart = await p.restartWorker();                                               // a fresh worker; the dying one may rewrite cooling.json, so it is deleted again once the new one answers
  await p.send("main", { model: ANCHOR, session: sess });                                // the new worker learns main again
  p.stub.clear();
  await SUB(p, { session: sess, agentId: aid, messages: 5 });
  await p.settle();
  return { handoffSeen: hs.length > 0, handedTo, afterModel: stubSub(p, aid)[0]?.model, pidBefore: restart?.pidBefore, pidAfter: restart?.pidAfter, setup };
};
RUN["8"] = async (p, o) => {
  const sess = `uwsc-s8-${o.run}`, calls = [];
  // aux and bg shapes under a DYNAMIC policy (they are never touched, whatever the mode)
  await p.policy(scenarioPolicy({ rows: ["m-free"] }));
  p.stub.setScript({}); p.stub.clear();
  await p.send("main", { model: ANCHOR, session: sess });
  for (const [kind, shape, over] of [["aux (agent id, no tools)", "aux", { model: ASKED_MODEL, agentId: aidFor(o.run, "s8a"), session: sess }], ["bg (no agent id, no tools)", "bg", { model: ASKED_MODEL, session: sess }]]) {
    const r = await p.send(shape, over);
    await p.settle();
    calls.push({ kind, asked: over.model, status: r.status, stubModel: p.stub.last()?.model });
  }
  // the exempt alias: the router reads `exempt` ONLY under inherit, so this half runs under an INHERIT policy. Main is m-big; a non-exempt subagent (the control) must be moved to main's model, the exempt one must not
  await p.policy(scenarioPolicy({ mode: "inherit", exempt: ["uwstub/m-main"] }));
  p.stub.clear();
  await p.send("main", { model: "uwstub/m-big", session: sess });
  const cr = await SUB(p, { session: sess, agentId: aidFor(o.run, "s8c"), messages: 3, model: "uwstub/m-free", tag: undefined });
  await p.settle();
  const control = { asked: "uwstub/m-free", main: "uwstub/m-big", status: cr.status, stubModel: stubSub(p, aidFor(o.run, "s8c"))[0]?.model };
  const er = await SUB(p, { session: sess, agentId: aidFor(o.run, "s8e"), messages: 3, model: "uwstub/m-main", tag: undefined });
  await p.settle();
  calls.push({ kind: "exempt alias subagent (inherit policy)", asked: "uwstub/m-main", status: er.status, stubModel: stubSub(p, aidFor(o.run, "s8e"))[0]?.model });
  return { calls, control };
};
RUN["9"] = async (p, o) => {
  p.markDirty?.();
  const sess = `uwsc-s9-${o.run}`;
  await p.policy(scenarioPolicy({ rows: ["m-free"] }));
  p.stub.setScript({}); p.stub.clear();
  await p.send("main", { model: ANCHOR, session: sess });
  await SUB(p, { session: sess, agentId: aidFor(o.run, "s9a"), messages: 3 });
  await p.settle();
  const beforeModel = stubSub(p, aidFor(o.run, "s9a"))[0]?.model;
  const gw0 = await p.gatewayFingerprint();
  const flag = await p.rollback();
  await SUB(p, { session: sess, agentId: aidFor(o.run, "s9b"), messages: 3, tag: undefined });
  await p.settle();
  const gw1 = await p.gatewayFingerprint();
  await p.resume();
  return { beforeModel, policy: "uwstub/m-free", afterModel: stubSub(p, aidFor(o.run, "s9b"))[0]?.model, asked: ASKED_MODEL, gw0, gw1, flag };
};
RUN["10"] = async (p, o) => {
  p.markDirty?.();
  const sess = `uwsc-s10-${o.run}`;
  // TWO bands: m-free and m-big are the lead band (0), m-main is a worse band (1). Every agent asks a real stub model but names a tag the policy does not hold, so each is substituted
  await p.policy(scenarioPolicy({ rows: [{ name: "m-free", b: 0 }, { name: "m-big", b: 0 }, { name: "m-main", b: 1 }] }));
  // main is OUTSIDE the set (a model no row names): a main model that is a row comes first (plan 6.2, router decide) and every agent would land on it, hiding the spread. The main request itself may be refused by the
  // gateway (the stub has no such model); only the router's lesson from it matters, and its status is not read.
  p.stub.setScript({}); p.stub.clear();
  await p.send("main", { model: MAIN_OUTSIDE, session: sess });
  await needCoolingEmpty(p, "scenario 10");
  const wave = async (tag) => {
    const ids = Array.from({ length: 20 }, (_, i) => aidFor(o.run, `s10${tag}-${i}`));
    const res = await Promise.all(ids.map((aid) => p.send("sub", { model: "uwstub/m-main", tag: NOT_IN_SET, agentId: aid, session: sess, messages: 3, agentTool: false })));
    await p.settle();
    return ids.map((aid, i) => ({ aid, status: res[i].status, ret: stubSub(p, aid)[0]?.model }));
  };
  const a = await wave("a");
  // a REAL cooled model: m-free returns 429 for one agent, its retry is handed on, which cools m-free; then twenty more agents
  p.stub.setScript({ decide: limitFree });
  const x = aidFor(o.run, "s10x");
  await p.send("sub", { model: ASKED_MODEL, tag: "uwstub/m-free", agentId: x, session: sess, messages: 3, agentTool: false });
  await p.send("sub", { model: ASKED_MODEL, tag: "uwstub/m-free", agentId: x, session: sess, messages: 3, retryCount: 1, agentTool: false });
  await p.settle();
  const b = await wave("b");
  return { a, b, band: ["uwstub/m-free", "uwstub/m-big"], otherBand: ["uwstub/m-main"], cooled: ["uwstub/m-free"] };
};
RUN["11"] = async (p, o) => {
  p.markDirty?.();
  const a = aidFor(o.run, "s11a"), b = aidFor(o.run, "s11b"), sess = `uwsc-s11-${o.run}`, real = !!(o.real && p.claude);
  await p.policy(scenarioPolicy({ rows: ["m-free", "m-big"] }));
  p.stub.setScript({ decide: (rec) => (modelIs(rec.model, "uwstub/m-free") && rec.headers?.["x-claude-code-agent-id"] ? { status: 429, retryAfter: 3600 } : undefined), ...(real ? { onMain: spawnOnce("s11") } : {}) }); p.stub.clear();
  await needCoolingEmpty(p, "scenario 11");
  if (real) await p.claude({ prompt: REAL_PROMPT, maxTurns: 4 });
  else { await p.send("main", { model: ANCHOR, session: sess }); await SUB(p, { session: sess, agentId: a, messages: 3 }); }   // the client fails the agent AT ONCE: no second request is sent
  await p.settle();
  const firstAid = real ? firstSubAid(p) : a;
  const firstRecs = firstAid ? stubSub(p, firstAid) : [];                              // never the main request: only requests that carry the agent's own id
  const failed = firstRecs.some((r) => r.sent?.status === 429 && r.sent.retryAfter === 3600);      // read from the STUB's evidence, not from a client exit code
  const overlay = await p.feedOverlay("uwstub/m-free", "rate");                         // what the observer would write after seeing the 429 in the gateway log
  await p.sleep(OVERLAY_WAIT_MS);                                                       // the router re-reads observed.json at most once a second (overlayView): the first measured agent must come AFTER that
  const nexts = Array.from({ length: 6 }, (_, i) => `${b}-${i}`);                      // six agents: with two rows one agent would avoid the limited model by chance half the time, six all-but-never
  for (const aid of nexts) await SUB(p, { session: sess, agentId: aid, messages: 3, model: "uwstub/m-main", tag: NOT_IN_SET });   // not in the policy: a substitute is picked, and a demoted model is passed over
  await p.settle();
  return { client: clientLabel(o, p), aid: firstAid, failed, recordsForFirst: firstRecs.length, chosen: "uwstub/m-free", nextModels: nexts.map((aid) => stubSub(p, aid)[0]?.model).filter(Boolean), overlay: !!overlay };
};
const DAY_MS = 86400000;
RUN.C1 = async (p, o) => {
  p.markDirty?.();
  const sess = `uwsc-c1-${o.run}`, past = `${sess}p`, now = p.now(), requests = [];
  const iso = (ms) => new Date(ms).toISOString();
  await p.policy(scenarioPolicy({ rows: ["m-free", "m-big"] }));
  await p.freshWorker();                                                                 // the router reads a session's main file only on a MEMORY MISS: a worker that already knows the session would never see the stamp
  p.stub.setScript({}); p.stub.clear();
  const status0 = await p.freshStatus();
  // the shapes the router itself writes, stamped BEFORE the first request of each session: main-<sid>.json is {model, beta1m, t: ISO string}; cooling.json is {v:1, models:{sel:{u, l, t, n, t0}}} (u: ms until, t: ms of the failure)
  await p.writeState(`main-${sess}.json`, JSON.stringify({ model: "uwstub/m-main", beta1m: false, t: iso(now + DAY_MS) }));          // a day AHEAD, as after a forward clock jump
  await p.writeState(`main-${past}.json`, JSON.stringify({ model: "uwstub/m-main", beta1m: false, t: iso(now - 2 * DAY_MS) }));      // and two days BEHIND, as after a backward jump
  await p.writeState("cooling.json", JSON.stringify({ v: 1, models: { "uwstub/m-free": { u: now + 3 * DAY_MS, l: 3, t: now + DAY_MS, n: 1, t0: now + DAY_MS } } }));
  const go = async (label, shape, over) => { const r = await p.send(shape, over); requests.push({ label, status: r.status, error: r.error }); };
  await go("sub, future-stamped main", "sub", { model: ASKED_MODEL, tag: TAG_MODEL, agentTool: false, session: sess, agentId: aidFor(o.run, "c1a"), messages: 3 });
  await go("main", "main", { model: ANCHOR, session: sess });
  await go("sub, past-stamped main", "sub", { model: ASKED_MODEL, tag: TAG_MODEL, agentTool: false, session: past, agentId: aidFor(o.run, "c1b"), messages: 3 });
  await p.settle();
  return { requests, status0, status1: await p.freshStatus() };
};
RUN.C2 = async (p, o) => {
  const sess = `uwsc-c2-${o.run}`;
  await p.policy(scenarioPolicy({ rows: ["m-free"] }));
  p.stub.setScript({}); p.stub.clear();
  await p.send("main", { model: ANCHOR, session: sess });                               // creates the session files
  const status0 = await p.freshStatus();
  await p.appendState(`agents-${sess}.jsonl`, "this is not json\n{\"k\":\"torn\",\"m\":\"uwstub/m-free\",\"t\":1");   // garbage, then a partial last line with no newline
  const r = await SUB(p, { session: sess, agentId: aidFor(o.run, "c2"), messages: 3 });
  await p.settle();
  return { status: r.status, status0, status1: await p.freshStatus() };
};
RUN.C3 = async (p, o) => {
  const sess = `uwsc-c3-${o.run}`, requests = [];
  await p.policy(scenarioPolicy({ rows: ["m-free"] }));
  await p.freshWorker();                                                                 // appendLog caches its file descriptor: a worker that had already written agents.jsonl would not notice the file being replaced by a directory
  p.stub.setScript({}); p.stub.clear();
  await p.send("main", { model: ANCHOR, session: sess });
  const status0 = await p.freshStatus();
  await p.blockState("agents.jsonl"); await p.blockState(`agents-${sess}.jsonl`);      // a DIRECTORY where the log and the journal are expected: every append fails, as on a full disk
  try {
    for (let i = 0; i < 3; i++) requests.push(await SUB(p, { session: sess, agentId: aidFor(o.run, `c3${i}`), messages: 3 }));
    await p.settle();
  } finally { await p.unblockState("agents.jsonl"); await p.unblockState(`agents-${sess}.jsonl`); p.markDirty?.(); }      // this worker's log stays down for 30 s after a failure: the next scenario gets a fresh one
  return { requests: requests.map((r) => ({ status: r.status })), status0, status1: await p.freshStatus() };
};
RUN.C4 = async (p, o) => {
  const sess = `uwsc-c4-${o.run}`;
  await p.policy(scenarioPolicy({ rows: ["m-free", "m-big"] }));
  p.stub.setScript({}); p.stub.clear();
  await p.send("main", { model: ANCHOR, session: sess });
  const models = [];
  for (let i = 0; i < 2; i++) { await SUB(p, { session: sess, agentId: aidFor(o.run, "c4"), messages: 3 + 2 * i }); await p.settle(); models.push(stubSub(p, aidFor(o.run, "c4")).slice(-1)[0]?.model); }
  return { workerFiles: await p.workerFiles(), models: models.filter(Boolean) };
};

/** Runs the chosen scenarios (all by default), `runs` times each, and returns [{scn, result}]; a throw in one run is that scenario's FAIL, never the suite's. After a REAL client ran, its isolation is checked (id RC). */
export async function runScenarios(p, { only = null, runs = null, real = false } = {}, emit = () => {}) {
  const pick = ALL.filter((s) => !only || only.includes(s.id));
  const out = [];
  for (const scn of pick) {
    const n = runs ?? scn.runs, evs = [];
    for (let i = 1; i <= n; i++) {
      try { await p.reset?.(); evs.push(await RUN[scn.id](p, { run: i, real: real && scn.client === "real" })); }     // cooling, an overlay record and a rollback flag of an earlier scenario must not leak into this one
      catch (e) { evs.push({ __error: clip(e?.message, 160) }); p.markDirty?.(); }       // a run that threw (or a reset that could not replace the worker) may have left cooling in the worker's memory: the NEXT reset must replace it
    }
    const errs = evs.filter((e) => e && e.__error);
    const res = errs.length ? { id: scn.id, verdict: "FAIL", runs: evs.length, passed: evs.length - errs.length, text: `a run threw: ${errs[0].__error}`, rows: [] } : judgeRuns(scn, evs);
    emit(scenarioLine(res, scn));
    out.push({ scn, result: res });
  }
  if (real && p.claude && typeof p.realCheck === "function") {                        // the isolation of the real client is a result of its own: a FAIL here fails the suite whatever the scenarios said
    let rc;
    try { rc = await p.realCheck(); } catch (e) { rc = { ok: false, problems: [`the check threw: ${clip(e?.message, 120)}`] }; }
    const res = { id: "RC", verdict: rc.ok ? "PASS" : "FAIL", runs: 1, passed: rc.ok ? 1 : 0, client: "real claude -p", text: rc.ok ? "the real client left the real ~/.claude.json and ~/.claude/projects untouched, wrote under the sandbox claude-config, and no request of it reached the live gateway" : rc.problems.join("; "), rows: [] };
    const scn = { title: "REAL-CLIENT ISOLATION" };
    emit(scenarioLine(res, scn)); out.push({ scn: { id: "RC", ...scn }, result: res });
  }
  return out;
}

// ---------------------------------------------------------------- the real client (only with `--real yes`: a SEPARATE, riskier mode; every protection below is built, none has run)
const SCRATCH_CLAUDE_CONFIG = path.join(SCRATCH_ROOT, "claude-config");
const SCRATCH_CWD = path.join(SCRATCH_ROOT, "tmp");
const slugOf = (p) => String(p).replace(/[^A-Za-z0-9]/g, "-");
const samePath = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
/**
 * The isolated `claude -p` invocation. Pure: nothing is spawned. `launchEnv` MUST be the WHITELIST environment of buildLaunchEnv(process.env, {preloadGuard: false}) (the sandbox daemon's own: PATH, SystemRoot, ComSpec and
 * the like, with HOME, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP and CLAUDE_CONFIG_DIR already redirected to the scratch root); nothing of the parent environment is ever passed through a blacklist. CCR and port variables and
 * the node preload are dropped (a Claude Code needs none), the gateway and the sandbox-only key are added. cwd is a scratch directory, never the repo.
 */
export function claudeInvocation({ prompt, maxTurns = 4, key, launchEnv, scratchRoot = SCRATCH_ROOT, gatewayPort = SANDBOX_PORTS.gateway, supports = {} }) {
  if (!key || typeof key !== "string") throw new Error("claudeInvocation needs the sandbox profile key");
  if (!launchEnv || typeof launchEnv !== "object") throw new Error("claudeInvocation needs the whitelist launch environment (buildLaunchEnv): it never reads process.env itself");
  const home = path.join(scratchRoot, "home");
  const env = { ...Object.fromEntries(Object.entries(launchEnv).filter(([k]) => !/^(CCR_|UW_TRIAL31|HOST$|PORT$|NODE_OPTIONS$|ANTHROPIC_|CLAUDE_CODE_)/i.test(k))),
    HOME: home, USERPROFILE: home, APPDATA: path.join(scratchRoot, "appdata"), LOCALAPPDATA: path.join(scratchRoot, "localappdata"), TEMP: path.join(scratchRoot, "tmp"), TMP: path.join(scratchRoot, "tmp"),
    CLAUDE_CONFIG_DIR: path.join(scratchRoot, "claude-config"), ANTHROPIC_BASE_URL: `http://127.0.0.1:${gatewayPort}`, ANTHROPIC_API_KEY: key,
    DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  const args = ["-p", String(prompt), "--output-format", "json", "--max-turns", String(maxTurns), "--allowedTools", "Agent",
    ...(supports.settingSources ? ["--setting-sources", "user"] : []), ...(supports.strictMcp ? ["--strict-mcp-config"] : [])];
  return { args, env, cwd: path.join(scratchRoot, "tmp") };
}
/** The canary settings file of the sandbox claude-config: if the client ever reads settings from THERE it talks to the sandbox gateway with the sandbox-only key (and nowhere else). */
export const canarySettings = (key, gatewayPort = SANDBOX_PORTS.gateway) => JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${gatewayPort}`, ANTHROPIC_API_KEY: key } }, null, 2) + "\n";
/** The first `claude` launcher on PATH (claude.exe, or the npm shim claude.cmd); null when there is none. */
export function findClaude(env = process.env, fsx = fs) {
  for (const dir of String(env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)) for (const n of ["claude.exe", "claude.cmd"]) { const f = path.join(dir, n); try { if (fsx.statSync(f).isFile()) return f; } catch { /* next */ } }
  return null;
}
/**
 * WHICH claude: its resolved path, the sha256 of that file, its `--version` text and whether it knows the two isolation flags. Pinned in the approval and compared at the start of a real run, so a replaced launcher
 * or an update between approval and run is refused. `run(file, args)` is injectable (a test never starts a process); the real one runs the two read-only commands with the sandbox's whitelist environment.
 */
export function identifyClaude({ env = process.env, fsx = fs, run = realRunOnce } = {}) {
  const exe = findClaude(env, fsx);
  if (!exe) return null;
  let digest = "(unreadable)";
  try { digest = sha256(fsx.readFileSync(exe)); } catch { /* the identity says so */ }
  const v = run(exe, ["--version"]), h = run(exe, ["--help"]);
  return { path: exe, sha256: digest, version: clip(String(v ?? "").trim().split(/\r?\n/)[0], 80), supports: { settingSources: /--setting-sources/.test(String(h ?? "")), strictMcp: /--strict-mcp-config/.test(String(h ?? "")) } };
}
const claudeIdentityLines = (c) => (c ? [`claude launcher: ${c.path}`, `claude sha256: ${c.sha256}`, `claude version: ${c.version}`, `claude flags: --setting-sources ${c.supports?.settingSources ? "yes" : "no"}, --strict-mcp-config ${c.supports?.strictMcp ? "yes" : "no"}`] : ["claude launcher: none"]);
function realRunOnce(exe, args) {
  const cmd = /\.cmd$/i.test(exe) ? process.env.ComSpec ?? "cmd.exe" : exe, a = /\.cmd$/i.test(exe) ? ["/d", "/s", "/c", exe, ...args] : args;
  const r = spawnSync(cmd, a, { env: buildLaunchEnv(process.env, { preloadGuard: false }), shell: false, windowsHide: true, timeout: 20000, encoding: "utf8" });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}
/**
 * Detection after a real run (protections R2): path-keyed sentinels. The real ~/.claude.json must hold no project entry for the scratch cwd and the real ~/.claude/projects no folder for its slug; the child's own state
 * must exist under the sandbox claude-config (proof that the redirect WORKED); and no request carrying one of the child's session ids may appear in the LIVE gateway's request log. Returns {ok, problems}.
 */
export async function realClientProblems({ d, cwd = SCRATCH_CWD, scratchConfig = SCRATCH_CLAUDE_CONFIG, home = os.homedir(), sessionIds = [], liveRequestsFor }) {
  const problems = [];
  const cj = d.sys.readText(path.join(home, ".claude.json"));
  if (cj != null) { try { const proj = Object.keys(JSON.parse(cj)?.projects ?? {}); if (proj.some((k) => samePath(k, cwd))) problems.push(`the REAL ~/.claude.json now records the project ${clip(cwd, 120)}`); } catch { problems.push("the real ~/.claude.json could not be read, so the sentinel could not be checked"); } }
  if (d.fs.existsSync(path.join(home, ".claude", "projects", slugOf(cwd)))) problems.push(`the REAL ~/.claude/projects holds a folder for the scratch cwd (${slugOf(cwd).slice(-40)})`);
  if (!d.fs.existsSync(path.join(scratchConfig, ".claude.json")) && !d.fs.existsSync(path.join(scratchConfig, "projects"))) problems.push("the child left no .claude.json or projects folder under the sandbox claude-config: the redirect was not shown to work");
  if (!sessionIds.length) problems.push("no session id of the child was seen at the stub, so its absence from the live gateway cannot be shown");
  else {
    let n = null;
    try { n = await liveRequestsFor(sessionIds); } catch { n = null; }
    if (n === null) problems.push("the live gateway's request log could not be read, so it cannot be shown that the child never reached it");
    else if (n > 0) problems.push(`${n} request(s) carrying the child's session id reached the LIVE gateway`);
  }
  return { ok: problems.length === 0, problems };
}
/** The live gateway's request log, opened READ ONLY through the report command's own opener (lazily: nothing of keysync/ is loaded unless a real run reaches this). */
async function defaultLiveRequestsFor(sessionIds, sinceMs) {
  const rep = await import("../keysync/subagent-report.mjs");
  const cli = await import("../menu/ccr-client.mjs");
  const open = rep.openRequestLogs(cli.requestLogsDb(process.env));
  if (!open?.ok) return null;
  try {
    const rows = open.query(new Date(sinceMs - 5000).toISOString(), new Date(Date.now() + 60000).toISOString());
    const want = new Set(sessionIds.map((s) => String(s).toLowerCase()));
    return rows.filter((r) => want.has(String(r.sid ?? "").toLowerCase())).length;
  } finally { open.close?.(); }
}

const normCmd = (x) => String(x ?? "").replace(/\//g, "\\").toLowerCase();
/**
 * A path in ONE comparable form: separators turned to backslashes, `.` and `..` segments resolved, the `\\?\` prefix and trailing separators cut, lower case, and, when the path exists on disk, its REAL path first
 * (a symlink, a junction or an 8.3 name turned into the target the process was really started from). The installed CCR is found through PATH, and PATH may hold a link (nvm4w: C:\nvm4w\nodejs is a symlink to the
 * versioned nvm directory) while the process table shows the target: both sides of the dist comparison go through this function, so they agree whichever spelling either one has. A path that is not on disk is only normalised.
 */
export function canonPath(x, fsx = fs) {
  let r = String(x ?? "");
  if (!r) return "";
  try { const rp = fsx.realpathSync; const real = (rp?.native ?? rp)?.call(fsx, r); if (typeof real === "string" && real) r = real; } catch { /* not on disk: only normalised */ }
  return path.win32.normalize(r.replace(/\//g, "\\")).replace(/^\\\\\?\\/, "").replace(/\\+$/, "").toLowerCase();
}
/** An absolute path with a root of its own: a drive letter (`C:\x`) or a UNC share (`\\host\share\x`). `\x` (rooted on the current drive), `c:x` (drive-relative) and `x\y` are not. */
export const absoluteLocal = (x) => { const s = String(x ?? "").replace(/\//g, "\\"); return path.win32.isAbsolute(s) && /^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\)/.test(s); };
/** The number of path segments below the root of a CANONICAL path (the drive, or `\\host\share`): `c:` is 0, `c:\a\b` is 2. */
export const depthBelowRoot = (canon) => { const s = String(canon ?? ""); const rest = /^\\\\/.test(s) ? s.replace(/^\\\\[^\\]*\\?[^\\]*/, "") : s.replace(/^[a-z]:/i, ""); return rest.split("\\").filter(Boolean).length; };
/** `child` lies STRICTLY inside `dir` (both canonical): on a path-segment boundary, so a sibling that merely shares the prefix (dist-evil) is not inside. */
export const insideDir = (child, dir) => !!child && !!dir && child.startsWith(dir + "\\") && child.length > dir.length + 1;
/** The script a node command line runs: the first argument after the executable that is not a flag and not the value of --require, -r, --import or --loader (normalised). */
export function scriptOf(cmd) {
  const toks = [...String(cmd).matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
  for (let i = 1; i < toks.length; i++) {
    if (["--require", "-r", "--import", "--loader", "--experimental-loader"].includes(toks[i])) { i += 1; continue; }
    if (toks[i].startsWith("-")) continue;
    return normCmd(toks[i]);
  }
  return "";
}
/**
 * Does `pid` descend from `ancestor` by parent links that SURVIVE the creation-time test? Windows does not invalidate a stale ParentProcessId when a pid is reused, so a link child -> parent is trusted only when the child
 * was created AFTER that parent, both creation times are known, and every parent on the way is in the table. A process behind cmd.exe or a shell is invisible to the node/ccr table: its link cannot be proved, so it is NOT
 * proved (fail closed; for the core worker that means a refusal). Returns {ok, why}.
 */
export function descentProof(rows, pid, ancestor) {
  const by = new Map(rows.map((r) => [r.pid, r]));
  const at = (r) => (r && typeof r.created === "string" ? Date.parse(r.created) : NaN);
  let cur = pid;
  for (let i = 0; i < 32; i++) {
    const row = by.get(cur);
    if (!row) return { ok: false, why: `pid ${cur} is not in the process table` };
    const parent = by.get(row.ppid);
    if (!parent) return { ok: false, why: `its parent ${row.ppid} is not in the process table (a process behind cmd.exe or a shell is invisible to the node/ccr table, so the link cannot be proved)` };
    const a = at(row), b = at(parent);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { ok: false, why: `a creation time is missing for pid ${cur} or its parent ${row.ppid}` };
    if (!(a > b)) return { ok: false, why: `pid ${cur} was created BEFORE its recorded parent ${row.ppid}: a stale parent id after pid reuse` };
    if (parent.pid === ancestor) return { ok: true, why: "" };
    cur = parent.pid;
  }
  return { ok: false, why: "the parent chain is deeper than 32" };
}

/**
 * Why a process must NOT be stopped when the suite replaces the sandbox's router worker (an empty list = it may be). Pure over what it is given, so a fake sandbox can drive every refusal.
 * Always: not the orchestrator itself and not one of its ancestors; not in the baseline set of LIVE CCR pids; not the live service.json pid (now or at the baseline); owns none of the live ports 3456/3457/3458/4517
 * (and no live-port probe failed); a CCR command line; a known creation time.
 * mode "core": a descendant of the verified sandbox daemon by creation-time-ordered links (never the daemon itself), the holder of the sandbox core port, the daemon identified as a CCR `daemon-child` that holds the
 * sandbox web port (as the harness's teardown requires), listening on sandbox ports only. mode "descendant" (a process under the core worker): a creation-time-ordered descent from `underPid`.
 * rows: process table {pid, ppid, name, cmd, created}; realOwners: {livePort: pid | null}; probeFailed: names of probes that failed; listens: parseListenPorts() of the process.
 */
export function stopRefusals({ mode = "core", rows = [], pid, selfPid = null, ancestors = [], baselinePids = [], liveSvcPids = [], realOwners = {}, probeFailed = [], underPid = null, daemonPid = null, coreHolder = null, webHolder = null, listens = null, corePort = null, expect = null } = {}) {
  if (!Number.isInteger(pid)) return ["no process holds the sandbox core port"];
  const why = [], row = rows.find((r) => r.pid === pid);
  if (selfPid != null && pid === selfPid) why.push("it is the orchestrator itself");
  if (asArr(ancestors).includes(pid)) why.push("it is an ancestor of the orchestrator");
  if (baselinePids.includes(pid)) why.push("it is in the baseline set of LIVE CCR pids");
  if (liveSvcPids.includes(pid)) why.push("it is the pid in the live service.json");
  const held = REAL_PORTS.filter((p) => realOwners[p] === pid);
  if (held.length) why.push(`it owns live port(s) ${held.join(",")}`);
  if (probeFailed.length) why.push(`the probe of ${probeFailed.join(", ")} failed, so who owns it is not known`);
  if (!row) why.push("it is not in the process table");
  else {
    if (!/claude-code-router/i.test(String(row.cmd))) why.push(`its command line is not a CCR process (${clip(row.cmd, 60)})`);
    if (!Number.isFinite(Date.parse(String(row.created)))) why.push("its creation time is unknown");
  }
  const cmdN = row ? normCmd(row.cmd) : "";
  if (expect?.realDir && cmdN.includes(normCmd(expect.realDir))) why.push(`its command line names the REAL claude-code-router appdata path ${expect.realDir}: it belongs to the live install`);
  if (mode === "descendant") {
    const pr = descentProof(rows, pid, underPid);
    if (!pr.ok) why.push(`it is not provably a descendant of pid ${underPid}: ${pr.why}`);
    return why;
  }
  if (!Number.isInteger(daemonPid)) why.push("the sandbox daemon pid is not known");
  else {
    const dr = rows.find((r) => r.pid === daemonPid);
    if (pid === daemonPid) why.push("it is the sandbox daemon itself (only its core worker child may be replaced)");
    else { const pr = descentProof(rows, pid, daemonPid); if (!pr.ok) why.push(`it is not provably a descendant of the sandbox daemon ${daemonPid}: ${pr.why}`); }
    if (!dr || !/claude-code-router/i.test(String(dr.cmd)) || !/daemon-child/i.test(String(dr.cmd))) why.push("the sandbox daemon's command line is not the CCR daemon-child");
    if (webHolder !== daemonPid) why.push("the sandbox daemon does not hold the sandbox web port (the daemon identity is not confirmed)");
  }
  if (coreHolder !== pid) why.push("it does not hold the sandbox core port");
  if (listens?.bad?.length) why.push(`it listens outside the sandbox: ${listens.bad.join("; ")}`);
  if (!listens || corePort == null || !asArr(listens.rec).includes(corePort)) why.push(`its OWN listener list (${asArr(listens?.rec).join(",") || "empty"}) does not contain the sandbox core port ${corePort ?? "?"} (an empty list proves nothing)`);
  // the live and the sandbox daemons have IDENTICAL command lines, so the worker is told apart by what its command line names: the SCRATCH config path, never the real Roaming one, and a script under the installed CCR dist
  if (!expect?.scratchDir || !expect?.realDir || !expect?.distDir) why.push("no command-line expectation (scratch config path, real appdata path, installed CCR dist) was supplied");
  else if (row) {
    const first = `first 120 characters of its command line: ${clip(row.cmd, 120)}`;
    if (!cmdN.includes(normCmd(expect.scratchDir))) why.push(`its command line does not contain the SANDBOX config path ${expect.scratchDir} (${first})`);
    // BOTH sides in canonical form (real path, resolved `..`, lower case): the install path comes from PATH (a link), the command line from the process table (the link's target). Strictly inside, on a segment boundary.
    // Fail closed before comparing: a RELATIVE script token would be realpath'ed against the orchestrator's cwd, a drive root, `.` or an empty pin would make "inside the dist" mean "anywhere on the drive", and a dist
    // shallower than 3 segments below the drive is not a package directory.
    const canon = typeof expect.canon === "function" ? expect.canon : canonPath, rawScript = scriptOf(row.cmd), script = canon(rawScript), dist = canon(expect.distDir);
    if (!absoluteLocal(rawScript)) why.push(`its script ${clip(rawScript || "(none)", 80)} is not an absolute path (a relative one would be resolved against this process's working directory)`);
    if (!absoluteLocal(expect.distDir)) why.push(`the pinned CCR dist ${clip(expect.distDir || "(none)", 80)} is not an absolute path`);
    else if (depthBelowRoot(dist) < 3) why.push(`the pinned CCR dist ${clip(expect.distDir, 80)} is too shallow (${clip(dist || "(empty)", 60)}): fewer than 3 path segments below the drive, so it is not a package directory`);
    if (!insideDir(script, dist)) why.push(`its script ${clip(script || "(none)", 80)} is not under the installed CCR dist ${expect.distDir} (${first})`);
  }
  return why;
}

/** The primitives over a live sandbox (the e2e context `c`). Not unit-tested against a gateway: its effects are unit-checked through the injected `d` (a fake filesystem and fake spawn). */
export function sandboxPrims(c, { spawnClaude = null, lastText = async () => [], rollbackFn = null, real = false, identity = null, liveRequestsFor = defaultLiveRequestsFor } = {}) {
  const { d, key, stub } = c;
  const state = (f) => path.join(SCRATCH_STATE_DIR, f);
  const readJson = (f) => { try { return JSON.parse(d.sys.readText(state(f)) ?? "null"); } catch { return null; } };
  let dirty = false, startedAt = d.now(), lastSendEnd = d.now();        // lastSendEnd: when the last request (ours or the client's) ended: the router flushes status.json at most 5 s after its previous flush, which is no later than that
  const gw = () => ({ pid: d.sys.listenerPid(SANDBOX_PORTS.gateway), serviceSha: sha256(String(d.sys.readText(path.join(CCR_CONFIG_DIR, "service.json")) ?? "(absent)")) });
  const launchEnv = c.launchEnv ?? buildLaunchEnv(process.env, { preloadGuard: false });
  const prims = {
    send: async (shape, over) => { try { return await e2eSend(d, key, shape, over); } finally { lastSendEnd = d.now(); } }, stub, now: () => d.now(), sleep: (ms) => d.sleep(ms),
    settle: async () => { await d.sleep(400); },
    markDirty: () => { dirty = true; },
    // cooling lives in the router worker's memory (and cooling.json, which the worker re-reads only when the file changes), so after a scenario that cooled a model the only reliable reset is a fresh worker
    reset: async () => {
      for (const f of ["cooling.json", "shadow.flag"]) rmSafe(d, state(f));
      rmSafe(d, path.join(SCRATCH_STATE_DIR, "..", "observed.json"));
      if (dirty) { await prims.freshWorker(); dirty = false; }                             // a restart that did not change the pid would leave the cooling of the last scenario in memory: that is an error, not a result
    },
    policy: async (p) => writeSafe(d, state("policy.json"), JSON.stringify(p)),
    writeState: async (f, text) => writeSafe(d, state(f), text),
    appendState: async (f, text) => { const abs = state(f); const cur = d.sys.readText(abs) ?? ""; writeSafe(d, abs, cur + text); },
    removeState: async (f) => rmSafe(d, state(f)),
    blockState: async (f) => { rmSafe(d, state(f)); d.fs.mkdirSync(path.join(SCRATCH_STATE_DIR, f), { recursive: true }); },
    unblockState: async (f) => rmSafe(d, state(f)),
    readLog: async (f) => logObj(d.sys.readText(state(f))),
    status: async () => readJson("status.json"),
    // FRESH status: status.json is flushed at most every 5 s (flushStatus), but ANY request after that window flushes it, and an aux request is the cheapest one. So: wait until 5.1 s have passed since the last request, send ONE aux
    // request, wait for the async write, read. If updatedAt still has not moved the read is marked `staleRead` (the judges would then be reading old counters).
    freshStatus: async () => {
      const wait = 5100 - (d.now() - lastSendEnd);
      if (wait > 0) await d.sleep(wait);
      const before = readJson("status.json")?.updatedAt;
      await prims.send("aux", { model: ASKED_MODEL, agentId: "uwsc-flush", session: "uwsc-flush", messages: 1 });
      let s = null;
      for (const ms of [400, 800, 1600]) { await d.sleep(ms); s = readJson("status.json"); if (s && s.updatedAt !== before) return s; }
      return s ? { ...s, staleRead: true } : s;
    },
    workerFiles: async () => { try { return d.fs.readdirSync(SCRATCH_STATE_DIR).map((e) => (typeof e === "string" ? e : e.name)).filter((n) => /^status-[0-9a-z]{1,13}\.json$/.test(n)).length; } catch { return 0; } },
    gatewayFingerprint: async () => gw(),
    rollback: async () => { writeSafe(d, state("shadow.flag"), new Date(d.now()).toISOString() + "\n"); return true; },
    resume: async () => { rmSafe(d, state("shadow.flag")); },
    feedOverlay: async (model, st) => { writeSafe(d, path.join(SCRATCH_STATE_DIR, "..", "observed.json"), JSON.stringify({ schema: 1, writtenAt: new Date(d.now()).toISOString(), feed: "ok", models: { [model]: { s: st, t: 0, a: Math.floor(d.now() / 1000), l: 1 } } })); return true; },
    lastOut: lastText,
    // The config swap (two Router.fallback edits) did NOT make CCR respawn its core worker in the second replay, so the worker is replaced by a STOP of the sandbox's core worker child (the holder of the sandbox core port); CCR
    // respawns it. Nothing is stopped unless every rule of stopRefusals holds, for the worker and for each descendant that provably descends from it; otherwise the call throws. The order is: probes first, the process table
    // LAST (twice: the second read, right before the stop, must show the same targets with the same creation times and command lines), then each target is identified AND stopped in ONE step (stopVerified holds a handle, compares
    // the snapshot, kills, confirms the exit), then the table is read again to see the targets are gone.
    restartWorker: async () => {
      const sys = d.sys, core = SANDBOX_PORTS.core, refuse = (m) => { throw new Error(`REFUSED to stop the sandbox core worker, nothing was stopped: ${m}`); };
      for (const fn of ["processes", "listenerProbe", "ancestorsOf", "stopVerified"]) if (typeof sys[fn] !== "function") refuse(`the system seam has no ${fn}`);
      const b = c.baseline;
      if (!b || !Array.isArray(b.ccrPids)) refuse("the baseline of live CCR pids was not handed over (an unknown live set is never treated as empty)");
      if (b.liveServicePid !== null && !Number.isInteger(b.liveServicePid)) refuse(`the baseline's live service.json pid is unreadable (${clip(b.liveServicePid, 20)})`);
      if (b.ccrPids.length === 0) { if (b.liveServicePid !== null) refuse(`the baseline lists no live CCR pid but recorded a live service.json pid ${b.liveServicePid}`); c.out?.("process stop: the baseline recorded NO live CCR process and no live service.json before the run, so an empty live set is accepted"); }
      const liveNow = liveServicePid(sys);
      if (liveNow !== null && !Number.isInteger(liveNow)) refuse(`the live service.json cannot be read (${clip(liveNow, 20)})`);
      const liveSvcPids = [liveNow, b.liveServicePid].filter(Number.isInteger);
      const daemonPid = typeof c.daemonPid === "function" ? c.daemonPid() : c.daemonPid;
      const coreP = sys.listenerProbe(core), webP = sys.listenerProbe(SANDBOX_PORTS.web), realP = REAL_PORTS.map((p) => [p, sys.listenerProbe(p)]);
      const probeFailed = [[`sandbox core port ${core}`, coreP], [`sandbox web port ${SANDBOX_PORTS.web}`, webP], ...realP.map(([p, x]) => [`live port ${p}`, x])].filter(([, x]) => !x?.ok).map(([n]) => n);
      const pidBefore = coreP?.ok ? coreP.pid : null;
      const realOwners = Object.fromEntries(realP.map(([p, x]) => [p, x?.ok ? x.pid : undefined]));
      const listens = Number.isInteger(pidBefore) ? parseListenPorts(sys.listenPortsOf?.(pidBefore) ?? []) : null;
      const selfPid = sys.selfPid, ancestors = sys.ancestorsOf(selfPid);
      if (!Array.isArray(ancestors) || ancestors.length < 1 || !ancestors.every(Number.isInteger)) refuse(`the orchestrator's ancestors could not be read (a node process always has a parent; got ${clip(JSON.stringify(ancestors), 40)}): the orchestrator and its parents cannot be protected`);
      const install = d.ccrInstall?.(), appdata = d.env?.APPDATA;
      if (!install?.found || !install.cli) refuse("the installed CCR (its dist directory) is not known");
      if (!appdata) refuse("the real APPDATA is not known, so the live claude-code-router path cannot be excluded");
      const expect = { scratchDir: CCR_CONFIG_DIR, realDir: path.join(String(appdata), "claude-code-router"), distDir: path.dirname(install.cli), canon: (x) => canonPath(x, d.fs) };
      const evaluate = () => {                                                                // the table is read HERE, last
        const rows = sys.processes(), why = [], targets = [], skipped = [];
        const common = { rows, selfPid, ancestors, baselinePids: b.ccrPids, liveSvcPids, realOwners, probeFailed };
        why.push(...stopRefusals({ ...common, mode: "core", pid: pidBefore, daemonPid, coreHolder: pidBefore, webHolder: webP?.ok ? webP.pid : null, listens, corePort: core, expect }));
        if (Number.isInteger(pidBefore)) {
          for (const k of descendantsLeafFirst(rows, pidBefore)) {                           // every row whose recorded parent chain reaches the worker; deepest first
            if (!descentProof(rows, k, pidBefore).ok) { skipped.push(k); continue; }       // a stale parent id (pid reuse) or an unprovable link: NOT this worker's descendant, never stopped
            const w = stopRefusals({ ...common, mode: "descendant", pid: k, underPid: pidBefore, expect });
            if (w.length) why.push(`its descendant ${k}: ${w.join(", ")}`); else targets.push(k);
          }
        }
        const snap = (pid) => { const r = rows.find((x) => x.pid === pid); return { pid, ppid: r?.ppid, created: r?.created, cmd: r?.cmd }; };
        return { why, skipped, targets: [...targets, ...(Number.isInteger(pidBefore) ? [pidBefore] : [])].map(snap) };
      };
      const first = evaluate();
      if (first.why.length) refuse(`pid ${pidBefore ?? "?"}: ${first.why.join("; ")}`);
      const again = sys.listenerProbe(core);
      if (!again?.ok || again.pid !== pidBefore) refuse(`the holder of the sandbox core port changed from ${pidBefore} before the stop`);
      const second = evaluate();
      if (second.why.length) refuse(`pid ${pidBefore}, at the second read: ${second.why.join("; ")}`);
      const key = (s) => `${s.pid}|${s.ppid}|${s.created}|${s.cmd}`;
      if (first.targets.map(key).join("\n") !== second.targets.map(key).join("\n")) refuse("the targets (pid, parent, creation time, command line) changed between the two reads of the process table");
      if (first.skipped.length) c.out?.(`process stop: ignored ${first.skipped.join(", ")} (a stale parent id or an unprovable link: not a descendant of the worker, never stopped)`);
      for (const t of second.targets) sys.stopVerified(t);                                  // leaf first, the core worker last; each call identifies and stops in one step and throws on any mismatch or a process that stays
      const left = sys.processes().filter((r) => second.targets.some((t) => t.pid === r.pid && t.created === r.created));
      if (left.length) throw new Error(`the stop of pid ${left.map((r) => r.pid).join(", ")} did not take effect: it is still in the process table`);
      let pidAfter;
      for (let i = 0; i < 60 && !pidAfter; i++) { await d.sleep(500); const h = sys.listenerProbe(core); if (h?.ok && h.pid && h.pid !== pidBefore) pidAfter = h.pid; }
      if (!pidAfter) throw new Error(`the sandbox core worker (pid ${pidBefore}) was stopped but no new process took the core port within 30 s: CCR did not respawn it`);
      // the layout may have changed: the daemon must be the SAME one (the isolation proof pins its pid), and the new holder must provably descend from it
      const web = d.resolveWebPort();
      if (web.pid !== daemonPid) throw new Error(`the sandbox daemon itself was replaced (pid ${daemonPid} -> ${web.pid}) while its core worker was: the isolation proof pins the daemon pid, so the run cannot go on`);
      const proof = descentProof(sys.processes(), pidAfter, daemonPid);
      if (!proof.ok) throw new Error(`the process that took the core port (pid ${pidAfter}) does not provably descend from the sandbox daemon ${daemonPid}: ${proof.why}`);
      // the new worker must ANSWER before anything is measured (the first request after a respawn can fail), and the dying one may have rewritten cooling.json on its way out: delete it again once the new one is up
      let ready = false;
      for (let i = 0; i < 40 && !ready; i++) { const r = await prims.send("aux", { model: ASKED_MODEL, agentId: "uwsc-ready", session: "uwsc-ready", messages: 1 }); ready = r.status === 200; if (!ready) await d.sleep(500); }
      rmSafe(d, state("cooling.json"));
      return { pidBefore, pidAfter, changed: pidAfter !== pidBefore, ready };
    },
    freshWorker: async () => {
      const r = await prims.restartWorker();
      if (!r.changed) throw new Error(`the router worker was not replaced (core pid ${r.pidBefore ?? "?"} -> ${r.pidAfter ?? "?"}): state of the last scenario (cooling, open files) is still in it, so nothing after this is a router verdict`);
      if (!r.ready) throw new Error("the router worker did not answer a request within 20 s after its replacement");
      return r;
    },
    claude: real && spawnClaude && identity ? async ({ prompt, maxTurns }) => {
      writeSafe(d, path.join(SCRATCH_CLAUDE_CONFIG, "settings.json"), canarySettings(key));          // canary: the sandbox claude-config's own settings point at the sandbox gateway with the sandbox-only key
      try { return await spawnClaude(claudeInvocation({ prompt, maxTurns, key, launchEnv, supports: identity.supports }), { exe: identity.path }); } finally { lastSendEnd = d.now(); }
    } : null,
    realCheck: real && spawnClaude && identity ? async () => {
      const ids = [...new Set(stub.records.map((r) => r.headers?.["x-claude-code-session-id"]).filter(Boolean))];
      return realClientProblems({ d, sessionIds: ids, liveRequestsFor: (s) => liveRequestsFor(s, startedAt) });
    } : null,
    rollbackFn,
  };
  return prims;
}

/** The session phases run INSIDE runE2e, after its proofs: the exact router bytes are installed, then the scenarios run, each result line is emitted. */
export function sessionPhasesFor(opts, deps = {}) {
  return async (c) => {
    const info = installRouter(c.d, "next", c.approved);
    c.out(`router under test installed: exact bytes of router/uw-router.next.cjs (sha256 ${info.sha}; LF-normalised ${info.lfSha})`);
    if (info.sha !== ROUTER_SHA256) c.emit(`FINDING router sha256 ${info.sha} is not the ${ROUTER_SHA256} this suite was written for: the PASS below is about different bytes`);
    const identity = opts.real ? (deps.identity ?? null) : null;
    if (opts.real && !identity) c.out("--real yes: no usable claude launcher was pinned: the REAL scenarios (1, 2, 3, 11) are REPLAYED and say so");
    const prims = sandboxPrims(c, { ...deps, real: !!(opts.real && identity), identity });
    await runScenarios(prims, opts, (l) => c.emit(l));
    return { abort: false };
  };
}

// ---------------------------------------------------------------- the plan (a pure function of constants: no I/O, no process) and the approval ceremony
export function planLines() {
  const L = [
    "== subagent-scenarios PLAN (`node harness/subagent-scenarios.mjs --plan` prints this text and its sha256; it reads no file, starts no process and contacts no service; nothing below has been run) ==",
    "BUILT OFFLINE, NOT RUN. A run is an OWNER-GATED act in the same isolated sandbox as G1 (a second CCR 3.0.22 daemon beside the live one on its own ports and folders): the live gateway, your key vault, the real policy files, the real Claude settings and the live router are never touched.",
    `router under test: router/uw-router.next.cjs, sha256 ${ROUTER_SHA256} (a different byte voids this plan and any approval)`,
    "the fail-closed process guard is OFF (--no-preload-guard, the G1 precedent: the 3.1.1 guard false-alarms on CCR 3.0.22's own native load); the second consent token that option needs is DERIVED from the orchestrator's own plan hash, so it is not an independent confirmation. The tripwire over the real Claude settings and the tree-wide isolation proof still run.",
    "the installed CCR (ccr.cmd, its package version and dist/main/cli.js) is pinned in the approval and compared at the start of the run; a changed CCR install is refused.",
    "what a run does, in order:",
    "  1. refuse unless the approval file holds THIS plan's hash, is under 24 hours old, every file listed at the end and the CCR install are identical to when you approved, and (for --real yes) the real mode was approved too; consume the approval (ONE use)",
    "  2. start the sandbox through the orchestrator of harness/subagent-e2e.mjs (runE2e): preflight, tripwire over the real Claude settings, tree-wide isolation proof at every stage, the exact router bytes installed in the scratch tree",
    "  3. run the scenarios below, each with a fresh synthetic policy written into the SANDBOX state folder only, against the stub model server; print PASS, FAIL, FINDING or DEGRADED per scenario with its run count and the client used",
    "  4. end with the same isolation proof, the live-state comparison (before and after), an identity-verified teardown and, for a refused or failed run, redacted evidence kept OUTSIDE the scratch root",
    "THE CLIENT. DEFAULT = REPLAY: every scenario is driven by a REPLAY of the request shapes a real Claude Code sends (main, sub, aux and bg shapes with the agent id, billing flag, session id, retry-count header and messages length G1's X3 and X5 recorded; not replayed: a streamed request, and a billing-only subagent without an agent id). A real client is never started.",
    "`--real yes` is a SEPARATE, RISKIER mode with its own consent (--approve-plan --real yes): a real headless Claude Code (`claude -p`) is started for scenarios 1, 2, 3 and 11 only (the others, and the free-mode variant of 2 and the cooldown steering of 3, stay replays). It is pointed at the sandbox by environment only (the sandbox's whitelist launch environment with HOME, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP and CLAUDE_CONFIG_DIR under the scratch root, ANTHROPIC_BASE_URL and a sandbox-only key, a scratch working directory, a canary settings.json in the sandbox claude-config, --setting-sources user and --strict-mcp-config when the launcher has them). The approval pins the launcher's path, sha256 and --version. After the run the suite checks that the real ~/.claude.json and ~/.claude/projects hold nothing for the scratch directory, that the child wrote under the sandbox claude-config, and that no request carrying its session id reached the live gateway (result RC). That the real ~/.claude is never touched cannot be verified offline.",
    "scenarios (what each must prove; client: REAL = the client's own behaviour is measured with --real yes, REPLAY = the shapes are enough):",
    ...SCENARIOS.map((s) => `  ${s.id.padStart(2)} ${s.title} [${s.client === "real" ? "REAL with --real yes, else replay" : "REPLAY"}, ${s.runs} run${s.runs === 1 ? "" : "s"}]: ${s.proves}`),
    "how the scenarios read the router (stated so a result can be trusted): (a) every counter and the cooling list come from a FRESH status: the router flushes status.json at most every 5 s, so the suite waits 5.1 s after its last request, sends one helper-shaped (aux) request, waits for the write and then reads; the router's own agent and decision logs are read as a second witness where one exists (a handoff line with its rsrc and reason, the first sticky-hit line). (b) MAIN COMES FIRST: when main's own model is a row of the policy the router substitutes (and hands off to) main's model before it spreads (plan 6.2, router decide). Scenarios 3 and 10 therefore keep main OUTSIDE the set (10 names a main model no row has, so its main request may be refused by the gateway: only the router's lesson from it counts), while scenarios 2 and 7 keep it in the set on purpose (their handoff target is main's model). Whether that shortcut is wanted is an owner decision still open; the suite documents it, it does not judge it. (c) A router worker that served earlier scenarios is REPLACED before the next one when an earlier scenario left state in it (cooling in memory and, for a provider key, for two minutes; open log files; a Router.fallback config swap was tried first and did not make CCR respawn the worker, so it is not used), by a STOP of the sandbox's core worker child (the process that holds the sandbox core port): CCR respawns it, the suite waits (30 s at most) for a NEW pid on the core port, checks that the sandbox daemon is the same one and that the new holder provably descends from it, polls a request until it answers 200, and deletes cooling.json again (the dying worker can rewrite it). This is the only destructive act on a process the suite makes, and its rules are fail-closed (anything unknown refuses, the run throws, nothing is stopped): (1) the baseline of LIVE CCR pids must have been handed over (an empty one is accepted only when no live service.json was recorded, and the run says so), the live service.json must be readable (a torn one refuses) and is compared with the one recorded at the baseline; (2) every port probe is STRICT: a probe that failed is not 'no listener' and refuses; (3) the target is never the orchestrator itself and never one of its ancestors (read from the unfiltered process table, parent first; the query stops on error, and an empty or unreadable list refuses, because a node process always has a parent); (4) it is not in the baseline set of live CCR pids, not the live service.json pid, owns none of 3456/3457/3458/4517, has a CCR command line and a known creation time, listens on sandbox ports only, holds the sandbox core port, and the sandbox core port is IN its own listener list (an empty list proves nothing); the live and the sandbox daemons have IDENTICAL command lines, so the worker is told apart by what its command line names: the SCRATCH config path (harness/scratch/appdata/claude-code-router) must appear, the real Roaming claude-code-router path must not (this also applies to every descendant), and its script must lie under the installed CCR dist directory (a path prefix, not a substring anywhere); a refusal prints the first 120 characters of the command line and the missing expectation; (5) it must PROVABLY descend from the sandbox daemon: every parent link is trusted only when the child was created LATER than its parent (Windows does not invalidate a stale parent id after pid reuse) and every parent is in the node/ccr process table (a worker behind cmd.exe or a shell cannot be proved and is refused), the daemon is never the target and must be a CCR daemon-child that holds the sandbox web port; (6) a descendant of the worker with a proved link must itself pass rules 3 and 4 (CCR command line included) or the whole stop is refused; a process whose recorded parent is the worker but whose link fails the creation-time test is NOT a descendant and is never stopped; (7) the process table is read LAST, after the probes, and twice: the second read, right before the stop, must show the same targets with the same parent, creation time and command line; (8) each target is identified AND stopped in ONE step (a handle is taken, its creation time, command line and the handle's own start time are compared with the verified snapshot, any difference refuses, then the handle is killed and the exit is awaited and confirmed; no silent failure), deepest first with the core worker LAST (a descendant is never left behind, and the worker is never stopped before the processes under it), and the table is read again to see the targets are gone. The probe reads 'no listener' from the error id CmdletizationQuery_NotFound or, failing that, from English text: on another locale a free port can read as a failed probe, which refuses (fail closed). The isolation proof reports a changed core pid as a RECORD, never a failure. A scenario that needs a clean cooling list checks that it is empty first; a worker that cannot be replaced is an error of the run, not a router verdict. (d) The sandbox has ONE provider: two distinct failing models within five minutes also cool the provider key and demote every row, so scenario 3 cools exactly one model before the all-limited step.",
    "chaos checks (same sandbox):",
    ...CHAOS.map((s) => `  ${s.id} ${s.title} [REPLAY, ${s.runs} run]: ${s.proves}`),
    "verdicts: PASS; FAIL (anything wrong: the suite is NOT OK); FINDING (allowed ONLY for scenarios 2, 7 and C4: a named thing could not be shown here: no retry signal reached the router, no worker restart could be made, one worker); DEGRADED (scenario 11 ONLY: one failure then avoidance, the behaviour the quality bar promises, never a seamless handoff). Every line that is not a PASS says it is not G3 evidence, and the exit code is non-zero for a FINDING anywhere else.",
    "limits stated, not hidden: one sandbox provider (the cross-provider /model switch is not measurable); the host clock is not changed (C1 injects the state a jump leaves); the disk is not filled (C3 makes the log targets unwritable); one worker (C4 is a FINDING unless two exist); a real client run is only as good as the stub's scripted answers.",
    "the approval: `node harness/subagent-scenarios.mjs --approve-plan` (an owner act: refuses without a terminal, needs the first 12 hex characters of the plan sha256 typed; that proves the plan and the files are unchanged since, not that a human typed it); a run is `--run` with the same flags. harness/g1-* is gitignored.",
    "files hashed at approval (raw bytes and line-ending-folded bytes) and again at the start of the run:",
    ...EXECUTED_FILES.map((f) => `  ${f}`),
  ];
  return L;
}
export const planOf = () => { const lines = planLines(); return { lines, sha: sha256(lines.join("\n") + "\n") }; };

const how = "run `node harness/subagent-scenarios.mjs --plan`, read it, then `--approve-plan` in a terminal (an owner act)";
/** Why an approval does not hold, or null when it does. Pure. `pin` = {ccr: the CCR install lines now, real: the mode asked for, claude: the launcher identity now}. */
export function checkApproval(text, planSha, files, nowMs, pin = {}) {
  if (text == null) return `no approval file: ${how}`;
  let a;
  try { a = JSON.parse(text); } catch { return `the approval file is not valid JSON: ${how}`; }
  if (!a || a.schema !== 1 || typeof a.planSha256 !== "string" || typeof a.approvedAt !== "string") return `the approval file has the wrong shape: ${how}`;
  const at = Date.parse(a.approvedAt);
  if (!Number.isFinite(at)) return `the approval timestamp is unreadable: ${how}`;
  const age = nowMs - at;
  if (age > APPROVAL_MAX_AGE_MS) return `the approval is ${Math.round(age / 3600000)} h old (valid 24 h): ${how}`;
  if (age < -5 * 60 * 1000) return `the approval is dated in the future: ${how}`;
  if (a.planSha256 !== planSha) return `the approval is for a different plan (approved ${a.planSha256.slice(0, 12)}, current ${planSha.slice(0, 12)}): ${how}`;
  const changed = files.filter((f) => { const o = Array.isArray(a.files) ? a.files.find((x) => x && x.file === f.file) : null; return !o || o.raw !== f.raw || o.lf !== f.lf || f.raw === "(absent)"; }).map((f) => f.file);
  if (changed.length) return `a file the run executes changed since you approved (${changed.join(", ")}): ${how}`;
  if (pin.ccr !== undefined && (!Array.isArray(a.ccr) || a.ccr.join("\n") !== pin.ccr.join("\n"))) return `the installed CCR changed since you approved (or the approval does not pin it): ${how}`;
  if (pin.real && a.real !== true) return `--real yes is a separate mode and was not approved: run --approve-plan --real yes first`;
  if (pin.real && claudeIdentityLines(a.claude).join("\n") !== claudeIdentityLines(pin.claude).join("\n")) return `the claude launcher (path, sha256 or version) changed since you approved: ${how}`;
  return null;
}
const hashOne = (file) => {
  let buf = null;
  try { buf = fs.readFileSync(path.join(REPO_ROOT, file)); } catch { /* absent */ }
  return buf === null ? { file, raw: "(absent)", lf: "(absent)" } : { file, raw: sha256(buf), lf: sha256(Buffer.from(Buffer.from(buf).toString("latin1").replace(/\r\n/g, "\n"), "latin1")) };
};
export const hashFiles = () => [...hashExecutedFiles(), ...EXECUTED_FILES.filter((f) => !G1_FILES.map(rel).includes(f)).map(hashOne)];

/** A path the approval is written to or consumed from must be a plain file in a plain folder: a symlink or a hard link there could point the write at, or the consume away from, another file. */
export function assertPlainTarget(f, fsx = fs) {
  const link = (p) => { try { return fsx.lstatSync(p); } catch (e) { if (e?.code === "ENOENT") return null; throw new Error(`cannot inspect ${p} (${e?.code ?? "error"}): refusing`); } };
  const dir = link(path.dirname(f));
  if (dir && dir.isSymbolicLink()) throw new Error(`${path.dirname(f)} is a symbolic link or junction: refusing to use it for the approval`);
  const st = link(f);
  if (st && (st.isSymbolicLink() || !st.isFile() || st.nlink > 1)) throw new Error(`${f} is not a plain single-link file (a symbolic link or hard link could redirect the approval): refusing`);
}

export function parseArgs(argv) {
  const o = { plan: false, approve: false, run: false, only: null, runs: null, real: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--plan") o.plan = true; else if (a === "--approve-plan") o.approve = true; else if (a === "--run") o.run = true;
    else if (a === "--only") { const v = argv[++i]; const ids = String(v ?? "").split(",").filter(Boolean); if (!ids.length || ids.some((x) => !ALL.some((s) => s.id === x))) o.errors.push(`--only takes a comma list of ${ALL.map((s) => s.id).join(",")}`); else o.only = ids; }
    else if (a === "--runs") { const v = Number(argv[++i]); if (!Number.isInteger(v) || v < 1 || v > 10) o.errors.push("--runs takes an integer 1 to 10"); else o.runs = v; }
    else if (a === "--real") { const v = argv[++i]; if (v !== "yes" && v !== "no") o.errors.push("--real takes yes or no"); else o.real = v === "yes"; }
    else o.errors.push(`unknown argument ${clip(a, 40)}`);
  }
  if ([o.plan, o.approve, o.run].filter(Boolean).length !== 1) o.errors.push("give exactly one of --plan, --approve-plan, --run");
  return o;
}
export const USAGE = ["usage: node harness/subagent-scenarios.mjs --plan | --approve-plan [--real yes] | --run [--only 1,2,C1] [--runs N] [--real yes|no]", "  --plan          print the scenarios, what each must prove and the plan sha256 (no I/O, no process)", "  --approve-plan  OWNER ACT in a terminal: type the first 12 hex characters of the plan sha256 (with --real yes it also pins the claude launcher and approves the riskier real-client mode)", "  --run           needs that approval (ONE use, 24 h); runs the suite in the sandbox, replay by default"];

/** The default dependencies of a run (every effect behind a name, so the tests drive the ceremony with fakes). */
export function defaultSeams() {
  return {
    interactive: () => !!process.stdin.isTTY && !!process.stdout.isTTY,
    ask: async (q) => { const rl = (await import("node:readline")).createInterface({ input: process.stdin, output: process.stdout }); try { return await new Promise((res) => rl.question(q, res)); } finally { rl.close(); } },
    now: () => Date.now(), pid: process.pid, hashFiles, approvalFile: APPROVAL_FILE,
    ccrLines: () => { const c = resolveCcrInstall(); return c.found ? ccrInstallLines(c) : null; },
    identifyClaude: () => identifyClaude(),
    readText: (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } },
    writeText: (f, t) => { assertPlainTarget(f); fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.tmp-${process.pid}`; fs.writeFileSync(tmp, t); fs.renameSync(tmp, f); },
    rename: (a, b) => { assertPlainTarget(a); fs.renameSync(a, b); }, rm: (f) => fs.rmSync(f, { force: true }),
    runSandbox: null,
  };
}

/** The command. Returns an exit code. `seams` replaces the defaults (tests). */
export async function main(argv, io = {}, seams = {}) {
  const out = io.out ?? console.log, err = io.err ?? console.error;
  const o = parseArgs(argv);
  if (o.errors.length) { for (const e of o.errors) err(e); for (const l of USAGE) err(l); return 2; }
  const plan = planOf();
  if (o.plan) { for (const l of plan.lines) out(l); out(""); out(`plan sha256: ${plan.sha}`); return 0; }
  const d = { ...defaultSeams(), ...seams };
  const files = d.hashFiles();
  if (o.approve) {
    if (!d.interactive()) { err("--approve-plan is an owner act and needs an interactive terminal (stdin and stdout both a terminal): refusing. Run it yourself in a console after reading --plan."); return 2; }
    const missing = files.filter((f) => f.raw === "(absent)").map((f) => f.file);
    if (missing.length) { err(`refusing to approve: ${missing.join(", ")} cannot be read, so the run's files cannot be pinned`); return 1; }
    const ccr = d.ccrLines();
    if (!ccr) { err("refusing to approve: the installed CCR was not found, so it cannot be pinned"); return 1; }
    const claude = o.real ? d.identifyClaude() : null;
    if (o.real && !claude) { err("refusing to approve --real yes: no claude launcher was found on PATH, so none can be pinned"); return 1; }
    const want = plan.sha.slice(0, 12);
    out(`approving the plan whose sha256 begins ${want}${o.real ? " AND the real-client mode with this launcher:" : ""}; read it first with --plan`);
    if (o.real) for (const l of claudeIdentityLines(claude)) out(`  ${l}`);
    const typed = String(await d.ask(`type the first 12 hex characters of the plan sha256 (${want}) to approve, anything else cancels: `)).replace(/[\r\n]+$/, "");
    if (typed !== want) { err("the typed confirmation does not match the plan sha256: nothing was approved"); return 2; }
    try { d.writeText(d.approvalFile, JSON.stringify({ schema: 1, planSha256: plan.sha, approvedAt: new Date(d.now()).toISOString(), files, ccr, real: o.real, claude }, null, 2) + "\n"); }
    catch (e) { err(`the approval was not written: ${clip(e?.message, 200)}`); return 1; }
    out(`approval written: ${d.approvalFile} (plan sha256 ${plan.sha}; ONE-USE, valid 24 h${o.real ? "; real client approved" : "; replay only"}; run it with --run)`);
    return 0;
  }
  const text = d.readText(d.approvalFile);
  const ccr = d.ccrLines();
  const claude = o.real ? d.identifyClaude() : null;
  const bad = checkApproval(text, plan.sha, files, d.now(), { ccr: ccr ?? ["(CCR not found)"], real: o.real, claude });
  if (bad) { err(`refusing to run: ${bad}`); return 1; }
  if (typeof d.runSandbox !== "function") { err("refusing to run: no sandbox runner is wired; your approval was not used"); return 1; }
  const used = `${d.approvalFile}.used-${d.pid}-${d.now()}`;
  try { d.rename(d.approvalFile, used); } catch { err("the approval could not be consumed (another run may have used it first, or it is not a plain file): a run needs a fresh --approve-plan"); return 1; }
  if (d.readText(used) !== text) { err("the consumed approval is not the file that was checked: a run needs a fresh --approve-plan"); return 1; }
  try { d.rm(used); } catch { /* inert */ }
  out(`approval consumed (plan sha256 ${plan.sha}); starting the sandbox scenario suite (${o.real ? "REAL client where marked" : "replay"})`);
  return d.runSandbox({ plan, only: o.only, runs: o.runs, real: o.real, approval: JSON.parse(text), identity: claude }, { out, err });
}

/** The approval check INSIDE the orchestrator: the files it hashes and the CCR install it resolved must be the approved ones (the caller's approval was already consumed). */
export const externalApprovalFor = (approval) => async ({ fileHashes, ccr }) => {
  if (!approval) return "no approval was handed to the orchestrator";
  const a = Array.isArray(approval.files) ? approval.files : [];
  const moved = fileHashes.filter((f) => { const o = a.find((x) => x && x.file === f.file); return !o || o.raw !== f.raw || o.lf !== f.lf; }).map((f) => f.file);
  if (moved.length) return `a file the orchestrator executes is not the approved one (${moved.join(", ")})`;
  if (!Array.isArray(approval.ccr) || approval.ccr.join("\n") !== ccrInstallLines(ccr).join("\n")) return "the installed CCR (ccr.cmd, package version or dist/main/cli.js) is not the one you approved";
  return null;
};

/**
 * The real sandbox run: the e2e orchestrator with this suite's phases, verdict and (already consumed) approval. `--no-preload-guard` is what G1 had to use, so its second token, the first 12 hex characters of the
 * ORCHESTRATOR's plan hash, is read from `runE2e --plan` first (that call reads files only and starts nothing); the plan says so.
 */
export async function runSandbox({ only, runs, real, approval, identity }, io = {}, deps = {}) {
  const d0 = { ...e2eDefaults(), ...deps.d };
  const ids = (only ?? ALL.map((s) => s.id));
  const captured = [];
  await runE2e(["--plan", "--router", "next", "--no-preload-guard"], { ...d0, out: (l) => captured.push(l), err: () => {} });
  const sha = captured.map((l) => /^plan sha256: ([0-9a-f]{64})$/.exec(l)).filter(Boolean).pop()?.[1];
  if (!sha) { (io.err ?? console.error)("could not read the orchestrator's plan hash: nothing was started"); return 1; }
  if (real) {                                                                         // the launcher that runs is the launcher that was approved
    const now = (deps.identifyClaude ?? identifyClaude)();
    if (claudeIdentityLines(now).join("\n") !== claudeIdentityLines(identity).join("\n")) { (io.err ?? console.error)("refusing: the claude launcher (path, sha256 or version) is not the one pinned in the approval"); return 1; }
  }
  const d = { ...d0, out: io.out ?? d0.out, err: io.err ?? d0.err, externalApproval: externalApprovalFor(approval), sessionPhases: sessionPhasesFor({ only: ids, runs, real }, { spawnClaude: real ? (deps.spawnClaude ?? realSpawnClaude) : null, lastText: deps.lastText ?? defaultLastText, identity: real ? identity : null }),
    sessionVerdict: (lines) => suiteVerdict(lines, ids) };
  return runE2e(["--experiments-only", "--g1-approved", "--router", "next", "--no-preload-guard", "--i-understand-no-guard", sha.slice(0, 12)], d);
}
/** `last` as the owner sees it, read from the SANDBOX state folder (imported lazily: the harness imports nothing from keysync/ at load time). */
async function defaultLastText() {
  const { runSubagentPolicy } = await import("../keysync/subagent-policy.mjs");
  const lines = [];
  await runSubagentPolicy(["last", "50", "--state-dir", path.join(SCRATCH_ROOT, "state")], { out: (l) => lines.push(l), err: () => {} });
  return lines;
}
/** Kills a process AND its children (taskkill /T on Windows; a plain kill elsewhere). `run` is injectable for tests. */
export function killTree(pid, run = spawnSync) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { if (process.platform === "win32") run(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15000 }); else process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}
/** The one place a real `claude` is started: shell:false (a .cmd shim goes through cmd.exe), the isolated env of claudeInvocation, stdout AND stderr read (clipped), a hard timeout that kills the whole process tree. Never called by a test with the real spawn. */
export function realSpawnClaude(inv, { exe = null, timeoutMs = 240000, spawnImpl = spawn, kill = killTree } = {}) {
  return new Promise((resolve) => {
    const file = exe ?? findClaude(inv.env);
    if (!file) return resolve({ code: null, text: "", err: "", reason: "no claude launcher on PATH" });
    const isCmd = /\.cmd$/i.test(file), cmd = isCmd ? inv.env.ComSpec ?? "cmd.exe" : file, args = isCmd ? ["/d", "/s", "/c", file, ...inv.args] : inv.args;
    let child;
    try { child = spawnImpl(cmd, args, { env: inv.env, cwd: inv.cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { return resolve({ code: null, text: "", err: "", reason: clip(e?.message, 100) }); }
    let text = "", errText = "", done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(cut); resolve(r); };
    const cut = setTimeout(() => { kill(child.pid); finish({ code: null, text: text.slice(0, 4000), err: errText.slice(0, 2000), reason: "timed out; the process tree was killed" }); }, timeoutMs);
    child.stdout?.on("data", (b) => { if (text.length < 8000) text += String(b); });
    child.stderr?.on("data", (b) => { if (errText.length < 4000) errText += String(b); });
    child.on("error", (e) => { kill(child.pid); finish({ code: null, text, err: errText.slice(0, 2000), reason: clip(e.message, 100) }); });
    child.on("close", (code) => finish({ code, text: text.slice(0, 4000), err: errText.slice(0, 2000) }));
  });
}

/**
 * The runner the self-test command calls (keysync/subagent-selftest.mjs `opts.selftest.run`): scenario 1 (spawn) plus the aux helper call of scenario 8 on the sandbox, returning what the self-test's own assertions
 * read: `{records, agentLog, code}`. `real` is false unless the owner approved the real mode; the self-test's approval was consumed by the caller, so the orchestrator is told so (`externalApproval`, which still compares
 * the executed files and the CCR install with the approval it was handed).
 */
export async function runSelftest({ plan, expect, approval, real = false, identity = null } = {}, io = {}, deps = {}) {
  const d0 = { ...e2eDefaults(), ...deps.d };
  const captured = [];
  await runE2e(["--plan", "--router", "next", "--no-preload-guard"], { ...d0, out: (l) => captured.push(l), err: () => {} });
  const sha = captured.map((l) => /^plan sha256: ([0-9a-f]{64})$/.exec(l)).filter(Boolean).pop()?.[1];
  if (!sha) throw new Error("could not read the orchestrator's plan hash: nothing was started");
  if (real) {
    const now = (deps.identifyClaude ?? identifyClaude)();
    if (claudeIdentityLines(now).join("\n") !== claudeIdentityLines(identity).join("\n")) throw new Error("the claude launcher (path, sha256 or version) is not the one pinned in the approval");
  }
  const out = io.out ?? (() => {}), got = {};
  const phases = async (c) => {
    const info = installRouter(c.d, "next", c.approved);
    c.out(`router under test installed: exact bytes of router/uw-router.next.cjs (sha256 ${info.sha}; LF-normalised ${info.lfSha})`);
    const useReal = !!(real && identity);
    const p = sandboxPrims(c, { lastText: deps.lastText ?? defaultLastText, real: useReal, identity, spawnClaude: useReal ? (deps.spawnClaude ?? realSpawnClaude) : null });
    const ev1 = await RUN["1"](p, { run: 1, real: useReal });
    const ev8 = await RUN["8"](p, { run: 1, real: false });
    // scenario 8 also sends subagent-shaped requests (its inherit half): only its AUX helper call belongs to the self-test's helper check
    got.records = [...ev1.records, ...p.stub.records.filter(isAux)]; got.agentLog = await p.readLog("agents.jsonl");
    c.emit(scenarioLine(judgeRuns(SCENARIOS[0], [ev1]), SCENARIOS[0]));
    if (useReal && p.realCheck) { const rc = await p.realCheck(); c.emit(scenarioLine({ id: "RC", verdict: rc.ok ? "PASS" : "FAIL", runs: 1, passed: rc.ok ? 1 : 0, client: "real claude -p", text: rc.ok ? "isolation held" : rc.problems.join("; ") }, { title: "REAL-CLIENT ISOLATION" })); }
    void ev8;
    return { abort: false };
  };
  const d = { ...d0, out, err: io.err ?? (() => {}), externalApproval: externalApprovalFor(approval), sessionPhases: phases, sessionVerdict: (lines) => suiteVerdict(lines, ["1"]) };
  const code = await runE2e(["--experiments-only", "--g1-approved", "--router", "next", "--no-preload-guard", "--i-understand-no-guard", sha.slice(0, 12)], d);
  return { ...got, code, expect };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
if (isMain) process.exit(await main(process.argv.slice(2), {}, { runSandbox }));
