// Pure, provider-scoped JSON-Schema sanitization rules for tool definitions
// forwarded through CCR's gateway-request-transform plugin hook (#118, #119).
//
// WHY THIS EXISTS: Claude Code's built-in tools carry JSON-Schema constraints
// some third-party backends cannot parse. MEASURED 2026-09-19 against
// aihubmix's own gateway:
//   - `Read`/`Artifact`/`DesignSync`/`ReportFindings` carry
//     `maximum: 9007199254740991` (Number.MAX_SAFE_INTEGER) on numeric
//     properties -- aihubmix's glm-5.x-family backend 400s the instant one of
//     these tools is present (#118), REGARDLESS of tool count: `Read` alone,
//     with every other field held identical to a succeeding request, was
//     enough to reproduce it.
//   - `Artifact`'s richer schema (`anyOf`, `propertyNames`, `const`, lookahead
//     regex) separately breaks aihubmix's xiaomi-mimo backend (#119) even
//     with the huge bound already replaced -- a DIFFERENT defect, deliberately
//     NOT addressed by the rule below. Confirmed live: `gemini-3.8-flash-free`,
//     same session, same full 94-tool set including both `Read` and
//     `Artifact`, answers normally -- so this is a per-vendor JSON-Schema
//     strictness gap behind aihubmix's one endpoint, not a Claude Code defect.
//
// DESIGN: a small rule pipeline, not a single hardcoded fix, because the
// mechanism (a backend rejecting a specific JSON-Schema shape) recurs across
// providers and tools. Each rule is independently scoped (by provider, via
// the model selector's own prefix) and independently testable. Adding a rule
// for #119 later means adding one entry here, not touching the transform
// wiring in schema-sanitizer.cjs.
//
// SCOPE, DELIBERATELY NARROW: only numeric `maximum`/`minimum` bounds are
// touched by the shipped rule. These are advisory hints to the MODEL, not the
// sole enforcement layer -- Claude Code's own tool executor still validates
// every real call independently of what bound the model was told, so loosening
// an absurd bound costs nothing real. Rules that would drop `anyOf`,
// `propertyNames`, `const` or similar (the #119 class) ARE genuinely lossy --
// they remove information the model uses to construct a valid call, not just
// a redundant hint -- and are deliberately not shipped here; see #119.

// A bound this large describes no real quantity a tool schema in this project
// has ever needed (file line counts, byte offsets, timeouts) -- anything at or
// above it is Claude Code's own generic numeric-safety ceiling
// (`Number.MAX_SAFE_INTEGER`), not a constraint about the tool's actual
// domain, and is exactly the value MEASURED to break aihubmix's glm-5.x route.
export const HUGE_BOUND_THRESHOLD = 1e15;
// Large enough that no real tool argument will ever reach it (and Claude
// Code's own tool executor enforces the REAL constraint regardless of what a
// model was told here); small enough for any reasonable JSON-Schema-in-
// function-calling validator to represent and parse without special-casing.
export const SAFE_BOUND_REPLACEMENT = 1_000_000_000;

const NUMERIC_BOUND_KEYS = ["maximum", "minimum", "exclusiveMaximum", "exclusiveMinimum"];

/**
 * Provider-agnostic (`providers: null`) unless stated otherwise. Runs first
 * because it is the one rule proven safe for every provider today -- see the
 * module doc above for the measured aihubmix result.
 */
export const RULES = [
  {
    id: "clamp-huge-integer-bounds",
    description: "Numeric JSON-Schema bounds at or above 1e15 are Claude Code's " +
      "own generic safety ceiling, not a real per-tool constraint -- clamp them " +
      "so a backend with a narrower integer parser can still parse the schema.",
    providers: null,   // applies everywhere; see module doc for why this is safe
    fix(node) {
      let changed = false;
      for (const key of NUMERIC_BOUND_KEYS) {
        const v = node[key];
        if (typeof v === "number" && Math.abs(v) >= HUGE_BOUND_THRESHOLD) {
          node[key] = Math.sign(v) * SAFE_BOUND_REPLACEMENT;
          changed = true;
        }
      }
      return changed;
    },
  },
];

/**
 * The provider name a request selector claims, or null for a bare model name
 * with no provider prefix (never seen in practice on this project's picker
 * rows, but a rule scoped by provider must still answer `false` rather than
 * throw when asked about one).
 */
export function providerFromSelector(model) {
  const s = String(model ?? "");
  const i = s.indexOf("/");
  return i > 0 ? s.slice(0, i) : null;
}

function ruleApplies(rule, providerName) {
  if (rule.providers == null) return true;
  if (rule.providers instanceof RegExp) return rule.providers.test(String(providerName ?? ""));
  return Array.isArray(rule.providers) && rule.providers.includes(providerName);
}

/**
 * Every object in a JSON-Schema document that could itself carry constraint
 * keywords -- not just `properties`' values. Pool aliases and small tools
 * rarely nest this deep, but `Artifact`'s `writes` field (an array of nested
 * objects, #119) does, and a walker that stops at the top level would silently
 * skip every rule for exactly the tools this project has already measured as
 * broken.
 */
function* schemaNodes(schema) {
  if (!schema || typeof schema !== "object") return;
  yield schema;
  if (schema.properties && typeof schema.properties === "object") {
    for (const child of Object.values(schema.properties)) yield* schemaNodes(child);
  }
  if (schema.items) {
    if (Array.isArray(schema.items)) { for (const child of schema.items) yield* schemaNodes(child); }
    else yield* schemaNodes(schema.items);
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(schema[key])) for (const child of schema[key]) yield* schemaNodes(child);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    yield* schemaNodes(schema.additionalProperties);
  }
  if (schema.propertyNames && typeof schema.propertyNames === "object") {
    yield* schemaNodes(schema.propertyNames);
  }
}

/**
 * Mutates `tool.input_schema` in place (the caller already owns a fresh deep
 * clone of the body -- see `sanitizeBody`) and reports whether anything
 * changed, so the transform can skip returning a body CCR would then have to
 * diff back out via its own `JSON.stringify` equality check.
 */
export function sanitizeToolSchema(tool, providerName, rules = RULES) {
  const schema = tool?.input_schema;
  if (!schema || typeof schema !== "object") return false;
  let changed = false;
  for (const node of schemaNodes(schema)) {
    for (const rule of rules) {
      if (ruleApplies(rule, providerName) && rule.fix(node)) changed = true;
    }
  }
  return changed;
}

/**
 * The whole request body, as CCR's transform hook hands it in -- still in
 * Claude Code's own Anthropic-shaped wire format (`body.model` is the raw
 * `provider/model` selector, `body.tools[].input_schema` is the Anthropic
 * tool-use schema), before CCR's own per-provider translation runs. Fixing it
 * here means every provider CCR later translates to benefits from one place,
 * rather than one sanitizer per outbound protocol.
 *
 * Returns `{changed: false}` (never a body) when nothing needed fixing, so
 * the caller can skip the plugin-hook body-replacement path entirely --
 * matching CCR's own `p!==c` no-op check, but decided here where the answer
 * is already known instead of by a second `JSON.stringify` comparison there.
 */
export function sanitizeBody(body, rules = RULES) {
  if (!body || typeof body !== "object" || !Array.isArray(body.tools) || !body.tools.length) {
    return { changed: false };
  }
  const providerName = providerFromSelector(body.model);
  let changed = false;
  for (const tool of body.tools) {
    if (sanitizeToolSchema(tool, providerName, rules)) changed = true;
  }
  return changed ? { changed: true, body } : { changed: false };
}
