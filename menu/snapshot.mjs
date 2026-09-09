// The picker's whole input, pre-joined.
//
// catalog.mjs:build() is the expensive path: it imports keysync, reads the vault
// through a PowerShell round trip, parses a 19.7 MB catalogue and joins the two.
// That work belongs to whoever refreshes the catalogue, not to whoever presses
// ctrl+g -- at which point Claude Code has already blanked the screen and the
// user is watching an empty terminal (Q1.1).
//
// The file is deliberately dumb: no functions, no derived state, only the cells a
// row draws plus the context limits Task A14 reads. Anything that needs the full
// catalogue is by definition not the picker.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeAtomic } from "./atomic.mjs";

// 3 since 2026-09-08 (R15). Bumped for three additions riding one migration:
// `provenance` and `modality` per model, `refused[]` and the new
// `discoveredAsOf` stamp per build. An old (schema-2) file loads and renders
// with every new field simply absent -- harmless for `provenance`/`modality`
// (both render as unknown), but `refused[]` absent vs `[]` is exactly the
// "nothing was refused" / "nobody looked" distinction §2.5(a) exists to keep,
// so the bump forces a rebuild rather than serving a file that cannot tell the
// two apart.
// 4 adds the free-tier `limit` field, on rows AND on models. Bumped rather than
// added silently because the picker draws a missing field as `?` ("not probed"),
// and an OLD snapshot really has not been probed -- so a stale schema-3 file
// must be rejected and rebuilt rather than read as a set of unknowns that will
// never resolve.
export const SNAPSHOT_SCHEMA = 4;

// The closed vocabulary schema 3 persists (revision 6, #59). Named here so a
// test can assert the FULL set -- both that nothing legal is missing and that
// nothing illegal has been added (`Object.freeze` on a `Set` does not stop
// `.add`; it only stops reassigning this binding, so the enforcement is the
// test's `deepEqual` against this literal, not the runtime object). A later
// edit that drops a rung, renames one, or collapses two together must fail
// there rather than drift silently into stored data. `"call-verified"` is IN
// the set -- it is a real, defined rung -- but no PRODUCER on this branch may
// assign it from a config literal (see `menu/catalog.mjs`'s `CONFIG_ASSERTED`
// comment); that constraint is asserted at the producer, this one is asserted
// at the persistence boundary.
export const PROVENANCE_RUNGS = Object.freeze(
  new Set(["call-verified", "config-asserted", "listing-verified", "catalogue-only", null]));
export const SNAPSHOT_FILE = path.join(os.homedir(), ".uw", "catalog", "snapshot.json");

// routableSet's own default is 400 ms and stays right for a latency-budgeted
// caller. This is not one: main() already parses a 19.7 MB catalogue and reads
// the vault through a PowerShell round trip, on a path the operator invoked
// deliberately and is not watching, so 400 ms was sized for a caller that does
// not exist. 5,000 is the same order as run.mjs's other non-interactive waits
// and still well under the work it sits beside.
//
// This is the one number in the task whose whole purpose is that getting it
// wrong is silent: a timeout here produces a snapshot with routability unknown
// for all 1,588 rows, which is byte-for-byte the artifact this task exists to
// remove and is indistinguishable from never having asked. Hence the explicit
// pass and the announcement below.
const ROUTABLE_TIMEOUT_MS = 5000;

/**
 * @param {object}   built
 * @param {Function}[opts.modalityOf] (provider, id) -> string | null. R15's own
 *                   addition, and it cannot be baked into `built` the way
 *                   `provenance`/`routable` are: those are resolved INSIDE
 *                   `catalog.mjs:buildFrom`, which this task's WRITES do not
 *                   include, so `modality` is resolved one layer out instead,
 *                   at serialization time, from the same discovery data
 *                   `main()` already has in hand. Defaulted `() => null`,
 *                   mirroring every other injected predicate in this file --
 *                   the default is inert, so an un-updated caller (every
 *                   existing test) keeps behaving exactly as before.
 */
export function buildSnapshot(built, { modalityOf = () => null } = {}) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA,
    generatedAt: built.generatedAt ?? null,
    // The stamp style.mjs:269-271 renders and uwpick.mjs:56 reads. Both have read
    // it since they were written and nothing ever wrote it, so the header has
    // shown a dash in every session that has ever run -- and the dash is exactly
    // the disclosure meant to reveal that no routability was resolved. The
    // mechanism built to make the failure visible was itself part of the failure.
    routableAsOf: built.routableAsOf ?? null,
    // R15's sibling stamp, same reasoning, same failure mode this file already
    // fixed once for `routableAsOf`: a renderer that reads this and nobody
    // writes it renders a permanent, indistinguishable-from-broken dash. `??
    // null`, not left to `undefined`, for the same JSON.stringify reason as
    // every other stamp here -- an absent key and an honest `null` are not the
    // same claim to a reader of the file.
    discoveredAsOf: built.discoveredAsOf ?? null,
    builtAt: new Date().toISOString(),
    rows: built.rows.map((r) => ({
      keyId: r.keyId, provider: r.provider, free: r.free,
      planCount: r.planCount, health: r.health,
      // Schema 4. The free-tier limit, aggregated over this provider's free
      // rows by `menu/payload-cap.mjs`'s `aggregate`. `?? null` for the same
      // reason `provenance` two literals down carries it: an own property,
      // always, so "not probed" survives `JSON.stringify` as a value rather
      // than vanishing as an absent key. The renderer draws `null` as `?`.
      limit: r.limit ?? null,
      // ALWAYS AN ARRAY, never a missing key (#51, §2.5(a)) -- "withheld
      // nothing" and "this build did not compute it" are different claims, and
      // `?? []` is what keeps them distinguishable through `JSON.stringify`,
      // which would otherwise drop an `undefined` array entirely rather than
      // round-trip it as `[]`.
      refused: r.refused ?? [],
      models: r.models.map((m) => ({
        id: m.id, ctx: m.ctx, pin: m.pin, pout: m.pout, badge: m.badge,
        tools: m.tools, vision: m.vision, reason: m.reason,
        // An explicit literal, so every field the picker draws has to be named
        // here to survive. That is not a hypothetical property: `routable` was
        // set by buildFrom, omitted from this list, and dropped on every build --
        // the snapshot stayed valid, the picker kept rendering, and a test
        // asserting the exact key set certified the drop as correct.
        outputKind: m.outputKind, routable: m.routable,
        // `?? null`, not bare `m.provenance` -- the same C2 defect this file
        // already fixed once for `routableAsOf` (`:49` coalesces, this literal
        // did not), just found again one field over before it could ship the
        // same way. An own property, always, even when unknown -- the
        // `Object.hasOwn` distinction this schema bump is asserted against.
        provenance: m.provenance ?? null,
        // Schema 4, and the per-MODEL half of the same field. The provider cell
        // is an aggregate of these, so this is the source of truth and `var` at
        // level 0 is what a disagreement among them renders as.
        limit: m.limit ?? null,
        modality: modalityOf(r.provider, m.id) ?? null,
        // FOUND IN REVIEW: this file's own signature defect a third time --
        // `mode` is ALWAYS set by `buildFrom` (`menu/catalog.mjs:536-539`,
        // "ALWAYS PRESENT, never a missing key") and this literal dropped it
        // anyway, on every build, exactly as `routable` was dropped once and
        // `provenance` almost was two fields above. R16 (`plan:3344`) reads
        // this snapshot expecting `mode` to already be there -- it cannot add
        // the field itself, since `snapshot.mjs` is outside R16's WRITES.
        // `?? null`, not `?? false`: `false` is a definite "this is a model"
        // claim (catalog.mjs's own distinction), and a malformed/undefined
        // input has not earned that claim.
        mode: m.mode ?? null,
      })),
    })),
  };
}

export function writeSnapshotFile(snap, file = SNAPSHOT_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify(snap));      // not pretty-printed: this is read, not edited
  return file;
}

// Four outcomes, each with its own caller-visible reason. A single boolean here
// would collapse "you have not built it yet" into "your build is corrupt", and
// those need different sentences from the picker (Q2.1, Q2.2).
export function loadSnapshot(file = SNAPSHOT_FILE) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch { return { ok: false, reason: "missing", detail: file }; }
  let snap;
  try { snap = JSON.parse(text); }
  catch (e) { return { ok: false, reason: "unreadable", detail: String(e.message).slice(0, 120) }; }
  if (snap?.schemaVersion !== SNAPSHOT_SCHEMA || !Array.isArray(snap.rows)) {
    return { ok: false, reason: "schema",
             detail: `expected schemaVersion ${SNAPSHOT_SCHEMA}, found ${JSON.stringify(snap?.schemaVersion)}` };
  }
  return { ok: true, snap };
}

export function contextIndex(snap) {
  const ix = new Map();
  for (const r of snap?.rows ?? []) {
    for (const m of r.models ?? []) {
      if (Number.isFinite(m.ctx)) ix.set(`${r.provider}/${m.id}`, m.ctx);
    }
  }
  return ix;
}

/**
 * The discovery cache -> `provenanceOf`, `modalityOf`, `discoveredAsOf`.
 *
 * PURE, and exported for that reason: this is the logic that closed a real
 * gap found in review (238 of 4,732 real rows, 18.7% of the catalogue-only
 * population), and a bug this specific could recur silently without a test
 * that drives it directly, on a synthetic catalog, without a real vault or a
 * real 19.7 MB bundle in the loop.
 *
 * @param {Map|null} discovery  provider -> record, exactly what
 *                    `loadDiscoveryCache` returns (or `null` on a degraded
 *                    read); a record is either the bare projected array or
 *                    the real cache shape `{outcome, models, at}`.
 * @param {object} catalog  from `K.loadCatalog()` (or an equivalent
 *                    `{byProvider: Map}` for a test).
 * @param {object} deps  `{buildJoinIndex, joinCatalogEntry}` from
 *                    `keysync/catalog-join.mjs`, injected rather than
 *                    imported here so this function stays synchronous and
 *                    trivially testable -- `main()` already awaits the
 *                    dynamic import once, at the one call site that needs it.
 */
export function buildProvenanceIndex(discovery, catalog, { buildJoinIndex, joinCatalogEntry }) {
  // FOUND IN REVIEW: `discovery === null` (the read failed or was never
  // attempted) and `discovery` being an EMPTY Map (the read succeeded and no
  // provider contributed) are different facts and must render differently --
  // the same absent-vs-empty distinction this file's own schema-3 header
  // comment states for `refused[]`, one field over. `null` means nobody
  // looked, so `provenanceOf`/`modalityOf` must answer `null` (unknown) for
  // EVERY row, never the positive claim `"catalogue-only"` ("the listing was
  // read and did not name this"), which is what an unguarded fall-through to
  // `discovery ?? []` below would silently produce -- the exact absent/empty
  // conflation the plan (`:3255-3257`) requires this path to avoid. An empty
  // (but non-null) Map is the honest `catalogue-only` case and falls through
  // normally. Returning here also skips `buildJoinIndex`'s full bundle pass,
  // which a no-discovery run has no use for (`menu/catalog.mjs`'s own
  // `joinIndex` is lazy for exactly this reason).
  if (discovery === null) {
    return { provenanceOf: () => null, modalityOf: () => null, discoveredAsOf: null };
  }
  // Own O(1) index -- a SEPARATE view of the same `discovery` Map `buildFrom`
  // will independently normalise via `K.discoveryIndex` (shared, R14), not a
  // second source of truth: both read the identical bare-array-or-
  // `{outcome,models,at}` tolerance, so the two can never disagree about
  // which ids a provider's listing named.
  const listingIndexOf = new Map();
  let discoveredAsOf = null;
  for (const [provider, record] of discovery ?? []) {
    const models = Array.isArray(record) ? record
      : (Array.isArray(record?.models) ? record.models : []);
    const byId = new Map();
    for (const m of models) if (typeof m?.id === "string" && m.id !== "") byId.set(m.id, m);
    listingIndexOf.set(provider, byId);
    // The freshest record actually reflected in this build, mirroring
    // `routableAsOf`'s own "as of when was this resolved" role. A record with
    // no parseable `at` contributes nothing to the stamp, the same default an
    // unstamped legacy shape gets elsewhere in this codebase.
    const at = typeof record?.at === "string" ? record.at : null;
    if (at && (!discoveredAsOf || at > discoveredAsOf)) discoveredAsOf = at;
  }
  // "listing-verified" iff the provider's own listing named this exact id OR
  // named a cosmetically different spelling that JOINS to it. FOUND IN REVIEW:
  // an exact-match-only check missed exactly the population R14's join exists
  // to serve -- the listing genuinely named the model, just under a different
  // spelling, and an exact-match index says "never named" purely because it
  // was keyed by raw spelling while `menu/catalog.mjs`'s own `listingOf`
  // (SITE 1's capability-override lookup, R14's F10 fix) is keyed by the
  // join's canonical identity. Reusing `joinCatalogEntry`/`buildJoinIndex`
  // here -- exported already, no WRITES violation -- is what makes the two
  // agree.
  //
  // A SITE-2 row is always displayed under the raw spelling the listing named
  // (R14's F11 fix), so the raw-id branch alone would already satisfy R15's
  // required observable; the join branch closes the SITE-1 gap the plan text
  // does not discuss, rather than leaving it as a named but unfixed boundary.
  const joinIdx = buildJoinIndex(catalog);
  // provider -> {canonical id -> the discovery entry that named it, raw or via
  // the join}. One index serves both `provenanceOf` (does a key exist) and
  // `modalityOf` (what capability did the listing report) -- the same fix
  // closes both fields' halves of the contradiction review found: a row whose
  // `outputKind` catalog.mjs already demoted via a joined capability must not
  // ALSO report `modality: null` and `provenance: catalogue-only` for the
  // identical reason.
  const canonicalListingOf = new Map();
  for (const [provider, byId] of listingIndexOf) {
    const canon = new Map();
    for (const [rawId, entry] of byId) {
      // FIRST-WINS on BOTH keys, not an unconditional overwrite on the raw
      // one. Found in review: an unconditional `canon.set(rawId, entry)`
      // disagreed with `menu/catalog.mjs`'s own `listingOf` (also first-wins
      // on canonical identity) whenever a provider listed both a cosmetic and
      // an exact spelling of the same model -- reachable, latent on the real
      // vault (3 canonical ids affected, 0 with a `capabilityRaw` difference
      // today), the same failure shape this whole fix exists to close, one
      // tie-break down.
      if (!canon.has(rawId)) canon.set(rawId, entry);
      const joined = joinCatalogEntry(joinIdx, provider, rawId);
      if (joined && !canon.has(joined.model)) canon.set(joined.model, entry);
    }
    canonicalListingOf.set(provider, canon);
  }
  return {
    provenanceOf: (provider, id) =>
      canonicalListingOf.get(provider)?.has(id) ? "listing-verified" : "catalogue-only",
    modalityOf: (provider, id) =>
      canonicalListingOf.get(provider)?.get(id)?.capabilityRaw ?? null,
    discoveredAsOf,
  };
}

export async function main(argv = process.argv.slice(2),
                           { rpc, file = SNAPSHOT_FILE, log = (s) => console.log(s),
                             loadDiscovery } = {}) {
  if (!argv.includes("--build")) {
    log("usage: node menu/snapshot.mjs --build");
    process.exit(2);
  }
  // EXTEND the existing dynamic import; never add a static one. snapshot.mjs is
  // inside uwpick's transitive import graph and catalog.mjs statically imports
  // keysync.mjs, so a top-level `import { routableSet } from "./catalog.mjs"`
  // would compile, pass every test, and quietly move both modules onto the
  // picker's 300 ms startup path -- invalidating the line-budget test's
  // definition of its own scope (standing constraint 25). The dynamic form is
  // what keeps the expensive half of this file out of the picker.
  const { build, routableSet, makeRoutableOf } = await import("./catalog.mjs");
  const K = await import("../keysync/keysync.mjs");
  const { set, fresh } = await routableSet({ timeoutMs: ROUTABLE_TIMEOUT_MS, rpc });

  // DISCOVERY, GUARDED (R15, B4/#27's sibling). Copy the injection pattern
  // `routableOf`/`routableAsOf` already use, NOT the unguarded await it also
  // carries: a rejection anywhere in this block must degrade to "no
  // discovery" -- null provenance, null modality, null `discoveredAsOf`, one
  // printed line -- never propagate out of `main()` and leave the snapshot
  // unwritten. `routableSet`'s own still-unguarded await is #27's job, not
  // this one's; this block does not touch it.
  //
  // FOUND IN REVIEW: the `../keysync/run.mjs` import must live INSIDE this
  // try, not before it. `run.mjs` statically pulls in `safety.mjs`,
  // `anthropic-catalog.mjs`, `refresh/discover.mjs` and `menu/denylist.mjs`;
  // any module-level failure anywhere in that graph is exactly the unguarded
  // rejection this guard exists to catch, and it would have propagated out of
  // `main()` from one line above the try block written to prevent it.
  let discovery = null, discoveryLine;
  try {
    // Injectable, defaulted to the real reader -- the same shape `rpc` already
    // has, so a test can supply a canned `{discovery, note}` without touching
    // the real, ACL-protected cache directory `loadDiscoveryCache` reads from.
    const loadDiscoveryFn = loadDiscovery
      ?? (await import("../keysync/run.mjs")).loadDiscoveryCache;
    const { registry, providers } = K.loadVault();
    const chosen = K.chooseKeys(K.filterRegistry(registry, providers));
    const result = loadDiscoveryFn(chosen.map((c) => c.provider));
    discovery = result.discovery;
    discoveryLine = `  ${result.note}`;
  } catch (e) {
    discoveryLine = `  discovery: could not be read (${e.message}); ` +
      "provenance and modality are unknown for every row";
  }

  const { buildJoinIndex, joinCatalogEntry } = await import("../keysync/catalog-join.mjs");
  const { provenanceOf, modalityOf, discoveredAsOf } =
    buildProvenanceIndex(discovery, K.loadCatalog(), { buildJoinIndex, joinCatalogEntry });

  const built = build({
    routableOf: makeRoutableOf(set, fresh),
    routableAsOf: fresh ? new Date().toISOString() : null,
    discovery: { byProvider: discovery ?? new Map() },
    provenanceOf,
  });
  // Not routed through `build()` -- catalog.mjs's signature is outside this
  // task's WRITES, so the stamp is attached here, the same object shape
  // `buildSnapshot` already reads `routableAsOf` from.
  built.discoveredAsOf = discoveredAsOf;
  const snap = buildSnapshot(built, { modalityOf });
  const written = writeSnapshotFile(snap, file);
  const models = snap.rows.reduce((n, r) => n + r.models.length, 0);
  log(`snapshot: ${written}`);
  log(`  ${snap.rows.length} providers, ${models} models, catalogue ${snap.generatedAt}`);
  log(discoveryLine);

  // Two degraded readings, two distinct lines, and both PRINT rather than throw.
  // A snapshot with unknown routability is honest and usable -- null renders
  // undimmed by design -- and one built while the gateway served nothing is an
  // accurate reading; a build that refuses to produce either leaves the picker
  // with no input at all. The announcement is the control; failing would be the
  // overreaction.
  //
  // They are separate lines because they are separate facts: `fresh: false` means
  // nobody answered, `fresh` with an empty set means someone answered "nothing".
  // The second is the more alarming screen -- every row dims while the header
  // stamp claims the answer is fresh -- and it is the one a reader would
  // otherwise diagnose as a broken build.
  if (!fresh) {
    log(`  routability: the gateway did not answer within ${ROUTABLE_TIMEOUT_MS}ms, so it is ` +
        `unknown for all ${models} rows and the header stamp will show a dash`);
  } else if (set.size === 0) {
    log("  routability: the gateway answered with no routable providers, " +
        `so every one of the ${models} rows will render dimmed`);
  } else {
    log(`  routability: ${set.size} targets routable as of ${snap.routableAsOf}`);
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("/menu/snapshot.mjs")) {
  await main();
}
