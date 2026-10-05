// The key tier vocabulary, defined ONCE as data (plan section 7.1, D-k). The subagent compiler reads it; the later
// `add` validation and `retier` (stage S1c) read the same table. Pure data: no imports, no I/O, so the picker may
// import it (the picker import graph may not reach keysync/ or refresh/).
//
// `freeScope` says which free scope (D-j) a key of that tier feeds:
//   "providers"  every probe-ok model of the provider is eligible (`free providers`, `free providers + deposit`)
//   "deposit"    only free-tagged probe-ok models (`free providers + deposit`)
//   null         in no free scope
// `excluded` is the tier keysync and the bench already skip (`r.tier !== "management"`).
// `provenanceVerified` marks the tier whose tool support is verified by where the key comes from (the relay), not by a probe.
export const TIERS = Object.freeze({
  "free":         Object.freeze({ freeScope: "providers", excluded: false, provenanceVerified: false }),
  "free-deposit": Object.freeze({ freeScope: "deposit", excluded: false, provenanceVerified: false }),
  "paid":         Object.freeze({ freeScope: "deposit", excluded: false, provenanceVerified: false }),
  "subscription": Object.freeze({ freeScope: null, excluded: false, provenanceVerified: true }),
  "management":   Object.freeze({ freeScope: null, excluded: true, provenanceVerified: false }),
});

export const isTier = (t) => typeof t === "string" && Object.hasOwn(TIERS, t);
export const tierList = () => Object.keys(TIERS);
/** Table reads for a tier that may be anything (a registry value, a provider name): undefined when it is not in the vocabulary. */
export const freeScopeOf = (t) => (isTier(t) ? TIERS[t].freeScope : undefined);
export const isExcludedTier = (t) => isTier(t) && TIERS[t].excluded;
export const isProvenanceVerified = (t) => isTier(t) && TIERS[t].provenanceVerified;

/** The tier of the Anthropic relay row: it has no registry row, so its tier is this one by construction. */
export const RELAY_TIER = "subscription";
/** The snapshot key id of that row. */
export const RELAY_KEY_ID = `relay.anthropic.${RELAY_TIER}`;
