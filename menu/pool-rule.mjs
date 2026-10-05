// The ONE shared pool-alias rule (plan section 4, D-n): the last id segment is `auto`, `router`, `default` or `free`.
// A STOP-GAP until a data-driven pool classification exists. The picker label (`menu/style.mjs`) and the subagent
// funnel import this constant; `keysync/keysync.mjs` keeps its own, narrower `POOL_IDS` (it governs a different
// decision, withholding the [1m] tag), and a contract test asserts that one stays a subset of this one.
export const POOL_ALIAS_RE = /(^|\/)(auto|router|default|free)$/i;
