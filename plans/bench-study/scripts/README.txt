Bench study scripts (read-only on ~/.uw/state and ~/.uw/catalog; Node only). Revision 2 (after the independent review).
Re-run from C:\Users\osami\.uw, in this order:
  node plans/bench-study/scripts/build.mjs && node plans/bench-study/scripts/sweeps.mjs && node plans/bench-study/scripts/reconcile_critic.mjs && node plans/bench-study/scripts/report.mjs && node plans/bench-study/scripts/verify.mjs
build.mjs -> data.json, models.csv, providers.csv | sweeps.mjs -> sweeps.json | reconcile_critic.mjs -> reconcile.json (467 vs the critic's 454 vs now) | report.mjs (+report_sweeps.mjs) -> REPORT.md | verify.mjs = independent second code path plus the redaction check; must print "all checks passed".
lib.mjs loads/joins snapshot + bench (freshness at snapshot benchAsOf) and holds redact(); clusters.mjs = message-cause rules (REV2 marks the rules changed after review); explore/ = throwaway exploration scripts.
../prev/ holds the revision-1 remove-candidate list and summary that the reconciliation compares against (needed by build.mjs and report.mjs).
