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
module.exports = async function route(req) {
  try {
    const asked = String(req?.body?.model ?? "");
    if (!asked) return undefined;
    // The zero-token hot-switch trigger, unchanged: a request literally
    // naming the anchor's own "claude-opus-5" redirects to whatever
    // slot.json currently pins, which is how the anchor itself is switched
    // without restarting Claude Code.
    if (asked.includes("claude-opus-5")) {
      const slot = JSON.parse(fs.readFileSync(SLOT, "utf8"));
      return typeof slot.model === "string" && slot.model ? slot.model : undefined;
    }
    return asked;
  } catch {
    return undefined;            // fail open: never break routing on a bad file
  }
};
