// The interactive `subagent-policy wizard` and the four presets it and `preset` share (plan 7.2 items 3 and 9, D-t). Plain node readline, at most 3 QUESTIONS
// (plus one save confirmation), a default on every one, TTY only, Ctrl-C (or Ctrl-D) writes nothing. All I/O goes through the injected `ask` and `out`
// functions, so a test drives it with a fake terminal. It imports nothing from `subagent-policy.mjs` (that module imports this one): the CLI hands in
// `mainOutsideFree`, `preview` and `save`, so the wizard cannot reach any file by itself.
import readline from "node:readline";

const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v); return Object.freeze(o); };
/**
 * The ready-made choices (plan 7.2 item 3; owner requirement 3). Each is sugar over `set`: the flags are printed before anything is saved.
 * `free` is the NARROW set (only models tagged free); `free-wide` is every working model on a provider you labelled free (a far larger set that can include priced models).
 */
export const PRESETS = deepFreeze({
  "follow-main": { flags: { mode: "inherit" }, plain: "subagents run on the same model as main" },
  any: { flags: { source: "all-providers", mode: "dynamic", ctx: "any" }, plain: "any model main picks, from any provider" },
  free: { flags: { source: "all-providers", mode: "free", "free-scope": "models", ctx: "any" }, plain: "free models only: the models tagged free" },
  "free-wide": { flags: { source: "all-providers", mode: "free", "free-scope": "providers", ctx: "any" }, plain: "free providers: every working model on a provider you labelled free (a much larger set; some of its models have a price)" },
  "free-1m": { flags: { source: "all-providers", mode: "free", "free-scope": "providers", ctx: "1m" }, plain: "free models only, and only those with a 1M context" },
});
const pl = (n, w) => `${Number(n).toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;
const FLAG_ORDER = ["source", "mode", "free-scope", "ctx", "enforce"];
/** The flags of a preset (or of a wizard answer set) in one fixed order: `--source all-providers --mode free ...`. */
export const flagsText = (flags) => FLAG_ORDER.filter((k) => flags[k] !== undefined).map((k) => `--${k} ${flags[k]}`).join(" ");

/** The preset list as printed lines; `counts` (optional) maps a preset name to {eligible, providers, usable} or {error}. */
export function presetListText(cli, counts = null) {
  const L = [];
  const w = Math.max(...Object.keys(PRESETS).map((k) => k.length));
  for (const [name, p] of Object.entries(PRESETS)) {
    const c = counts?.[name];
    const n = !c ? "" : c.error ? `   (${c.error})` : c.eligible === null ? "   (no list: every subagent follows main)"
      : `   eligible ${pl(c.eligible, "model")} on ${c.providers} of ${pl(c.providerTotal, "provider")}, usable ${c.usable.toLocaleString("en-US")} of ${c.eligible.toLocaleString("en-US")}`;
    L.push(`  ${name.padEnd(w)}  ${p.plain}${n}`, `  ${" ".repeat(w)}  = set ${flagsText(p.flags)}`);
  }
  L.push("eligible = passes your choices; usable = a known context of at least 128,000, so it can stand in for a subagent.");
  L.push(`preview one:  ${cli} preset <name>        save it:  ${cli} preset <name> --confirm yes  (add --live yes when it writes your real files)`);
  return L;
}

const ABORT = Object.assign(new Error("cancelled"), { name: "AbortError", code: "ABORT_ERR" });
const MAX_TRIES = 3;

/**
 * Asks the (at most 3) questions, previews, confirms and saves. Returns {code, refusal?, asked, confirmations}. Nothing is written unless `save` is called, and
 * `save` is called only after an explicit yes (or the default yes) on the final confirmation.
 *   isTTY            false -> refuses at once with the preset list (exit 1), asks nothing
 *   ask(prompt)      resolves the answer line (rejects on Ctrl-C / end of input: nothing is written)
 *   out(line)        prints one line
 *   mainOutsideFree  async () => boolean|null: main's provider is outside every free scope (asked only for a free answer)
 *   preview(flags)   async -> exit code; prints the dry report (0 = fine, anything else stops the wizard before saving)
 *   save(flags)      async -> exit code; the real save (the CLI passes the --live decision itself)
 *   cli              the command prefix printed in the equivalent command
 *   live             true on real paths: the equivalent command then carries `--live yes` (a real save needs it)
 *   freeNarrowCount  async () => number|null: how many models are tagged free (shown in answer 3); null leaves the number out
 */
export async function runWizard({ isTTY, ask, out, mainOutsideFree, preview, save, cli, live = false, freeNarrowCount = async () => null }) {
  const res = { code: 0, asked: 0, confirmations: 0 };
  if (!isTTY) {
    res.code = 1;
    res.refusal = ["E_USAGE: the wizard needs an interactive terminal (it asks questions); nothing was written. Pick a preset instead:", ...presetListText(cli)];
    return res;
  }
  const choose = async (title, options, def, isQuestion = true) => {
    for (let tries = 0; tries < MAX_TRIES; tries++) {
      out("");
      out(title);
      for (const [k, label] of options) out(`  ${k}  ${label}${k === def ? "   (default)" : ""}`);
      if (isQuestion && tries === 0) res.asked += 1;
      const a = String((await ask(`Choose [${options.map(([k]) => k).join("/")}, Enter = ${def}]: `)) ?? "").trim();
      if (a === "") return def;
      if (options.some(([k]) => k === a)) return a;
      out(`Please answer ${options.map(([k]) => k).join(", ")} (or press Enter for ${def}).`);
    }
    throw new Error("too many unreadable answers");
  };
  const yesNo = async (prompt, def) => {
    for (let tries = 0; tries < MAX_TRIES; tries++) {
      const a = String((await ask(`${prompt} [${def ? "Y/n" : "y/N"}]: `)) ?? "").trim().toLowerCase();
      if (a === "") return def;
      if (a === "y" || a === "yes") return true;
      if (a === "n" || a === "no") return false;
      out("Please answer y or n.");
    }
    throw new Error("too many unreadable answers");
  };
  try {
    const nf = await freeNarrowCount();
    const q1 = await choose("Who should run your subagents?", [["1", "the same model as main (follow-main)"], ["2", "any model main picks, any provider (any)"],
      ["3", `free: only models tagged free (${nf === null ? "" : `${pl(nf, "model")}; `}the wide set of every model on a provider you labelled free is the preset free-wide)`]], "3");
    let flags;
    if (q1 === "1") flags = { ...PRESETS["follow-main"].flags };
    else {
      const q2 = await choose("Context floor: how much room must the subagent's model have?", [["1", "any size"], ["2", "prefer 1M (smaller only when no 1M model is usable)"], ["3", "only 1M"]], "1");
      const ctx = q2 === "2" ? "prefer-1m" : q2 === "3" ? "1m" : "any";
      flags = { ...(q1 === "2" ? PRESETS.any.flags : PRESETS.free.flags), ctx };
      if (q1 === "3" && (await mainOutsideFree()) === true) {
        res.asked += 1;
        if (!(await yesNo("Free needs different providers. Use all providers?", true))) flags.source = "same-provider";
      }
    }
    flags.enforce = "shadow";                                        // a wizard never enforces: it saves a trial
    out("");
    const pc = await preview(flags);
    out(`Equivalent command: ${cli} set ${flagsText(flags)}${live ? " --live yes" : ""}`);
    if (pc !== 0) { res.code = pc; out("Nothing was written."); return res; }
    res.confirmations += 1;
    if (!(await yesNo("Save in shadow mode?", true))) { out("Nothing was written."); return res; }
    res.code = await save(flags);
    return res;
  } catch (e) {
    if (e?.name === "AbortError" || e?.code === "ABORT_ERR" || /too many unreadable answers/.test(String(e?.message))) {
      out(e?.name === "AbortError" ? "Cancelled: nothing was written." : "No readable answer: nothing was written.");
      res.code = 1;
      return res;
    }
    throw e;
  }
}

/** The real terminal: a readline interface on stdin/stdout. Ctrl-C and Ctrl-D reject the pending question with an AbortError. */
export function ttyAsker(input = process.stdin, output = process.stdout) {
  const rl = readline.createInterface({ input, output });
  // a stream that is already destroyed or ended never emits "close" to a late listener, so a question would wait for ever: fail closed from the start
  let pending = null, closed = !!(input.destroyed || input.readableEnded);
  const fail = () => { closed = true; if (pending) { const r = pending; pending = null; r(ABORT); } };
  rl.on("SIGINT", fail); rl.on("close", fail);
  return {
    ask: (prompt) => new Promise((resolve, reject) => {
      if (closed) { reject(ABORT); return; }
      pending = (e) => reject(e);
      rl.question(prompt, (a) => { pending = null; resolve(a); });
    }),
    close: () => rl.close(),
  };
}
