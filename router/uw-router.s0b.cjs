// CUSTOM_ROUTER_PATH resolver.
// Contract, read from the dist: CCR does `require(path)`, takes the module itself
// if it is a function (else .default/.router), calls it as
// (request, config, {event}) and uses the returned STRING as the model.
// It deletes the require cache entry on EVERY request, so this file — and the
// slot file it reads — are effectively re-read per request. That is the property
// that makes switching hot.
const fs = require("node:fs");
const path = require("node:path");
const SLOT = path.join(__dirname, "slot.json");

// #47: WIDENED from "only claude-opus-5, leave everything else on its normal
// route" to "claim every request", because "normal route" was never neutral.
// This is policy 1 (customer.custom-router) in CCR's chain; returning
// `undefined` is a `noop` that falls through toward policy 7
// (`builtins.builtin-agent-claude-code`), which force-rewrites `/body/model`
// to `profile.model` (the anchor) whenever it's reached -- and for a Claude
// Code SUBAGENT request specifically, policy 6 (client-model) is skipped
// outright (`request.builtInClaudeCodeSubagent === true`), so a subagent
// asking for anything but the exact anchor string had NO policy standing
// between it and the forced rewrite. MEASURED live in this project's own
// request_route_traces: `anthropic/claude-sonnet-5` requests landing on
// `customer.custom-router` -> `noop` -> `builtin-agent-claude-code` ->
// rewritten to `anthropic/claude-opus-5`, 20 times in one session, plus
// haiku-4-5 and claude-opus-4-7 (the latter alone: 108,398 tokens at the
// wrong model's cost).
//
// Claiming every request (returning a string, never `undefined`, for any
// non-empty `asked`) makes policy 7 unreachable, which is the fix: it is
// ABOVE `builtin-agent-claude-code` in the chain, and CLAIMING beats
// reaching it at all. For any model other than the opus-5 hot-switch
// trigger below, the claim is a NO-OP TRANSFORMATION -- `asked` echoed back
// verbatim -- so a request that would have resolved correctly via
// `client-model` (policy 6) resolves identically via this policy instead;
// nothing about ROUTABILITY changes, only which policy gets credit for not
// interfering.
// S0b hotfix (plan D-e, section 6.6): the slot rewrite is an EXACT match, never a
// substring test, and it is the LAST step on the return path. The ORIGINAL `asked`
// is what every other branch returns; a corrupt, empty or missing slot.json (or a
// slot with no usable model) returns `asked`, never `undefined`. Retired at G3.
const SLOT_IDS = new Set(["anthropic/claude-opus-5", "claude-opus-5"]);
module.exports = async function route(req) {
  let asked = "";
  try {
    asked = String(req?.body?.model ?? "");
    if (!asked) return undefined;
    // The zero-token hot-switch trigger: a request that IS the anchor's own id
    // (exactly, not merely containing it) redirects to whatever slot.json
    // currently pins, which is how the anchor itself is switched without
    // restarting Claude Code.
    if (SLOT_IDS.has(asked)) {
      const slot = JSON.parse(fs.readFileSync(SLOT, "utf8"));
      return typeof slot.model === "string" && slot.model ? slot.model : asked;
    }
    return asked;
  } catch {
    return asked || undefined;   // a bad slot file serves what was asked; only an unreadable request has no answer
  }
};
