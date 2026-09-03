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

module.exports = async function route(req) {
  try {
    const asked = String(req?.body?.model ?? "");
    // Only take over the model this session actually sends; leave everything
    // else (subagents, background traffic) on its normal route.
    if (!asked.includes("claude-opus-5")) return undefined;
    const slot = JSON.parse(fs.readFileSync(SLOT, "utf8"));
    return typeof slot.model === "string" && slot.model ? slot.model : undefined;
  } catch {
    return undefined;            // fail open: never break routing on a bad file
  }
};
