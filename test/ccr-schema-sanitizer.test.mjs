// #118: CCR gateway plugin that sanitizes JSON-Schema constraints on tool
// definitions before they reach upstream providers. Pure logic tests -- no
// live gateway required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeToolSchema, sanitizeBody, RULES, HUGE_BOUND_THRESHOLD, SAFE_BOUND_REPLACEMENT } from "../keysync/ccr-plugins/schema-rules.mjs";

const MAX_SAFE = 9007199254740991;

const readSchema = () => ({
  type: "object",
  properties: {
    file_path: { type: "string" },
    offset: { type: "integer", minimum: 0, maximum: MAX_SAFE },
    limit: { type: "integer", exclusiveMinimum: 0, maximum: MAX_SAFE },
  },
  required: ["file_path"],
});

test("RULES exports at least one rule with a fix function", () => {
  assert.ok(Array.isArray(RULES) && RULES.length > 0);
  for (const rule of RULES) {
    assert.equal(typeof rule.fix, "function");
  }
});

test("HUGE_BOUND_THRESHOLD and SAFE_BOUND_REPLACEMENT are sensible", () => {
  assert.ok(HUGE_BOUND_THRESHOLD >= 1e15);
  assert.ok(SAFE_BOUND_REPLACEMENT < HUGE_BOUND_THRESHOLD);
  assert.ok(SAFE_BOUND_REPLACEMENT > 0);
});

test("sanitizeToolSchema clamps MAX_SAFE_INTEGER maximum for any provider (rules are global)", () => {
  const schema = readSchema();
  const changed = sanitizeToolSchema({ input_schema: schema }, "aihubmix", RULES);
  assert.equal(changed, true);
  assert.equal(schema.properties.offset.maximum, SAFE_BOUND_REPLACEMENT);
  assert.equal(schema.properties.limit.maximum, SAFE_BOUND_REPLACEMENT);
  assert.equal(schema.properties.offset.minimum, 0, "minimum untouched");
});

test("sanitizeToolSchema applies globally even for an unlisted provider name", () => {
  const schema = readSchema();
  const changed = sanitizeToolSchema({ input_schema: schema }, "openrouter", RULES);
  assert.equal(changed, true);
  assert.equal(schema.properties.offset.maximum, SAFE_BOUND_REPLACEMENT);
});

test("sanitizeToolSchema skips tools with no input_schema", () => {
  const changed = sanitizeToolSchema({ name: "bare" }, "aihubmix", RULES);
  assert.equal(changed, false);
});

test("sanitizeToolSchema handles nested objects recursively", () => {
  const schema = {
    type: "object",
    properties: {
      outer: {
        type: "object",
        properties: {
          inner: { type: "integer", maximum: MAX_SAFE },
        },
      },
    },
  };
  const changed = sanitizeToolSchema({ input_schema: schema }, "aihubmix", RULES);
  assert.equal(changed, true);
  assert.equal(schema.properties.outer.properties.inner.maximum, SAFE_BOUND_REPLACEMENT);
});

test("sanitizeToolSchema handles arrays of objects", () => {
  const schema = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: { count: { type: "integer", maximum: MAX_SAFE } },
        },
      },
    },
  };
  const changed = sanitizeToolSchema({ input_schema: schema }, "aihubmix", RULES);
  assert.equal(changed, true);
  assert.equal(schema.properties.items.items.properties.count.maximum, SAFE_BOUND_REPLACEMENT);
});

test("sanitizeBody returns changed:false when body has no tools", () => {
  const result = sanitizeBody({ model: "aihubmix/x" }, RULES);
  assert.equal(result.changed, false);
});

test("sanitizeBody returns changed:false for null/empty body", () => {
  assert.equal(sanitizeBody(null, RULES).changed, false);
  assert.equal(sanitizeBody({}, RULES).changed, false);
});

test("sanitizeBody extracts provider from model selector and applies rules", () => {
  const body = {
    model: "aihubmix/coding-glm-5.1-free",
    tools: [{ name: "Read", input_schema: readSchema() }],
  };
  const result = sanitizeBody(body, RULES);
  assert.equal(result.changed, true);
  assert.equal(body.tools[0].input_schema.properties.offset.maximum, SAFE_BOUND_REPLACEMENT);
});

test("sanitizeBody applies rules regardless of provider name (global rules)", () => {
  const body = {
    model: "kiraai/test",
    tools: [{ name: "Read", input_schema: readSchema() }],
  };
  const result = sanitizeBody(body, RULES);
  assert.equal(result.changed, true);
  assert.equal(body.tools[0].input_schema.properties.offset.maximum, SAFE_BOUND_REPLACEMENT);
});

test("sanitizeBody handles provider/model with multiple slashes", () => {
  const body = {
    model: "some-provider/sub/model-name",
    tools: [{ name: "Read", input_schema: readSchema() }],
  };
  const result = sanitizeBody(body, RULES);
  assert.equal(result.changed, true);
});

test("idempotent: running twice produces the same result", () => {
  const schema = readSchema();
  sanitizeToolSchema({ input_schema: schema }, "aihubmix", RULES);
  const first = JSON.stringify(schema);
  sanitizeToolSchema({ input_schema: schema }, "aihubmix", RULES);
  assert.equal(JSON.stringify(schema), first);
});

test("does not clamp values that are already below the threshold", () => {
  const schema = {
    type: "object",
    properties: { count: { type: "integer", maximum: 500 } },
  };
  const changed = sanitizeToolSchema({ input_schema: schema }, "aihubmix", RULES);
  assert.equal(changed, false);
  assert.equal(schema.properties.count.maximum, 500);
});
