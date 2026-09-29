// CCR gateway plugin adapter. Loaded by CCR itself via its config `plugins[]`
// entry's `module` path (an absolute path, per CCR's own path validator --
// `dist/main/cli.js`'s `x$e`/`k$e` require either an absolute path or one
// starting with `.` and resolve `.cjs`/`.js`/`.mjs` only). CCR imports this
// file with native `import()`, so `module.exports` becomes the `default`
// export CCR's own loader reads (`_$e`, same file: `t.default ?? t.plugin ?? e`).
//
// Kept intentionally thin: the actual rule logic lives in `schema-rules.mjs`,
// a plain ESM module tested the same way as every other module in this
// project (`test/ccr-schema-sanitizer.test.mjs`, no live gateway required).
// This file's only job is the CCR-specific contract --
// `setup(context) -> {gatewayRequestTransforms: [{id, transform}]}` -- and the
// glue that turns CCR's transform payload into a plain body/no-op decision.
//
// PERMISSIONS THIS PLUGIN NEEDS in its config.sqlite entry, confirmed by
// reading `dist/main/cli.js`'s `loadConfiguredPlugin`/`applyPluginRegistration`:
//   permissions: ["trusted-code", "gateway-request-transforms"]
//   surfaces: ["gateway"]
// `trusted-code` gates loading/executing the module file at all;
// `gateway-request-transforms` gates registering the transform once loaded.
// Both are required explicitly -- CCR grants neither by default.
module.exports = {
  async setup() {
    const rules = await import("./schema-rules.mjs");
    return {
      gatewayRequestTransforms: [
        {
          id: "uw-schema-sanitizer",
          transform(payload) {
            // `payload.body` is CCR's own deep-cloned copy for this call
            // (`rL(r)` at the call site in cli.js) -- mutating it in place via
            // `sanitizeBody` is safe and never touches the caller's original.
            const result = rules.sanitizeBody(payload?.body, rules.RULES);
            // No-op MUST return nothing rather than `{body: unchangedBody}`:
            // CCR's own transform loop already treats an unchanged body as a
            // no-op via a `JSON.stringify` equality check, but returning
            // nothing here means this plugin's own `applied` entry never
            // appears in a request's transform log for a request that needed
            // no sanitization -- keeping that log meaningful for the rare
            // real case rather than noisy on every request.
            if (!result.changed) return;
            return { body: result.body };
          },
        },
      ],
    };
  },
};
