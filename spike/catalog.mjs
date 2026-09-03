// Shared catalogue builder for the UW model pickers (browser + tmux TUI).
// Extracted so the two front-ends cannot drift apart — they must agree on what
// "free" means, which models are routable, and how providers are labelled.
//
// Reads only metadata: vault registry/profiles and the bundled model catalogue.
// NEVER reads or returns API key values.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const KEYSYNC = path.join(os.homedir(), ".uw", "keysync", "keysync.mjs");
const K = await import("file://" + KEYSYNC.replace(/\\/g, "/"));

export const SLOT = path.join(os.homedir(), ".uw", "spike", "slot.json");

// The catalogue's real pricing path. keysync's own inferTier reads
// `pricing.inputPerMillion`, which does not exist in this schema — it returns
// "unknown" for all 4,298 models, which is why its free-tier sort is a no-op.
function priceOf(entry) {
  const offers = entry?.pricing?.offers;
  if (!Array.isArray(offers)) return null;
  for (const o of offers) {
    const p = o?.per1MTokens;
    if (p && Number.isFinite(Number(p.input)) && Number.isFinite(Number(p.output))) {
      return { in: Number(p.input), out: Number(p.output) };
    }
  }
  return null;
}

// GUARD G1: a zero *token* price on a model whose output is not text means it is
// billed per image/second in another unit. Blank, never "free".
const isTextOut = (e) => {
  const out = e?.modalities?.output;
  return !Array.isArray(out) || out.length === 0 || out.includes("text");
};

function badgeOf(entry) {
  const p = priceOf(entry);
  if (!p) return "";                    // no evidence -> blank, never "paid"
  if (p.in === 0 && p.out === 0) return isTextOut(entry) ? "FREE?" : "";
  return "PAID";
}

// 8 of 47 provider profiles record breakage in their hand-written notes.
const BROKEN = /502|backend down|insufficient credits|deposit required|not usable|no longer|bot-blocked/i;
const healthOf = (p) =>
  BROKEN.test(String(p?.notes ?? "")) ? "broken" : p?.requiresBalance ? "needs $" : "ok";

/** Which `provider/model` strings CCR can actually resolve right now. */
export async function routableSet() {
  try {
    const svc = JSON.parse(fs.readFileSync(
      path.join(process.env.APPDATA, "claude-code-router", "service.json"), "utf8"));
    const u = new URL(svc.url);
    const r = await fetch(`http://127.0.0.1:${u.port}/api/ccr/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json",
                 "x-ccr-web-auth": u.searchParams.get("ccr_web_token") },
      body: JSON.stringify({ method: "getConfig", args: [] }),
      signal: AbortSignal.timeout(8000),
    });
    const cfg = (await r.json()).value;
    const set = new Set();
    for (const p of cfg.Providers ?? []) for (const m of p.models ?? []) set.add(`${p.name}/${m}`);
    return set;
  } catch {
    return new Set();                   // unreachable gateway: mark nothing routable
  }
}

export function build() {
  const { registry, providers } = K.loadVault();
  const chosen = K.chooseKeys(K.filterRegistry(registry, providers));
  const cat = K.loadCatalog();

  const rows = [];
  for (const cred of chosen) {
    const prof = providers.get(cred.provider) ?? {};
    const models = (cat.byProvider.get(cred.provider) ?? []).map((e) => {
      const p = priceOf(e), caps = e?.capabilities ?? {};
      return { id: e.model, ctx: e?.limits?.contextTokens ?? null,
               pin: p ? p.in : null, pout: p ? p.out : null, badge: badgeOf(e),
               tools: !!caps.toolCalling, vision: !!caps.imageInput, reason: !!caps.reasoning };
    });
    // testModel leads: measured, catalogue-first dropped the live pass rate to 4/44.
    if (prof.testModel && !models.some((m) => m.id === prof.testModel)) {
      models.unshift({ id: prof.testModel, ctx: null, pin: null, pout: null,
                       badge: "", tools: false, vision: false, reason: false });
    }
    const priced = models.some((m) => m.badge !== "");
    rows.push({
      keyId: cred.id, provider: cred.provider, models,
      // NULLABLE: "0 free" is a measurement, "no price data" is the absence of one.
      free: priced ? models.filter((m) => m.badge === "FREE?").length : null,
      health: healthOf(prof),
    });
  }

  // The relay is NOT a vault credential — registry.json has no `anthropic` row.
  // keysync injects it separately, so building from the vault alone silently drops
  // the four Claude models, which are the ones most likely to be routable.
  if (K.ANTHROPIC_RELAY && !rows.some((r) => r.provider === "anthropic")) {
    rows.push({
      keyId: "relay.anthropic.subscription", provider: "anthropic",
      models: (K.ANTHROPIC_RELAY.models ?? []).map((id) => ({
        id, ctx: null, pin: null, pout: null, badge: "PLAN",
        tools: true, vision: true, reason: true })),
      free: null, health: "ok",
    });
  }

  rows.sort((a, b) => b.models.length - a.models.length);
  return { rows, generatedAt: cat.generatedAt };
}

export function writeSlot(target) {
  fs.writeFileSync(SLOT, JSON.stringify({ model: target }, null, 2));
}

export function readSlot() {
  try { return JSON.parse(fs.readFileSync(SLOT, "utf8")).model ?? ""; } catch { return ""; }
}
