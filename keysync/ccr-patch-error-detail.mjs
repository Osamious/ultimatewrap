// #109: surface the upstream reason instead of "All target providers failed."
//
//   node keysync/ccr-patch-error-detail.mjs --check | --apply | --revert
//
// This is recipe E of the consolidated patch script; the recipe itself (the
// defect, the two failure-envelope sites, why `providerName` and not `provider`)
// lives in menu/ccr-patches.mjs and the mechanism in keysync/ccr-patch.mjs. This
// file stays so the #109 write-up and commit 582ac0e still point at a real
// command, and delegates with the same flags.
//
// Behaviour differences from the old standalone script: --check now exits 3 when
// the patch is not applied (it always exited 0), and the pristine original comes
// from ~/.uw/ccr-pristine rather than a `.bak-error-detail` next to the target.
// Existing `.bak-*` files are left where they are.
import { run } from "./ccr-patch.mjs";

// This command is E only. A caller-supplied --only would either widen it to other
// patches or be ambiguous with ours, so it is rejected rather than reconciled.
const args = process.argv.slice(2);
if (args.some((a) => a === "--only" || a.startsWith("--only="))) {
  console.error("ccr-patch-error-detail.mjs is fixed to patch E and takes no --only; use keysync/ccr-patch.mjs --only ... for other patches");
  process.exitCode = 2;
} else process.exitCode = run(["--only", "E", ...args]);
