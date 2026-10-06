// The ONE table of subagent-policy codes: warnings (the router's and the compiler's), flags on a decision, the CLI's E_ exit codes and the router's
// counters. Every surface (`why`, `status`, `show`, the doctor, the picker) renders its plain wording and its fix command from here, so no
// surface can say something different (plan 7.2 item 8, QB-6). Pure data: no I/O, no clock, imports nothing. `planRef` names the plan
// section and is shown only by `why`, never in normal output.
//   plain    one sentence in plain words (what is going on, what it costs the owner)
//   fix      ONE runnable command that parses through the real argument parser (a test checks every row), or NONE when the row is informational
//   fixNote  optional plain text that goes with the fix (what else to do first, or what the command does); never a second command
//   degrades true when the router is NOT doing what the owner saved (the `verdict` turns it into DEGRADED(code))
//   planned  true when nothing in the built code emits this code yet; `why` says so (a test fails when a planned row IS emitted)

export const CLI = "node keysync/key.mjs subagent-policy";
const STATUS = `${CLI} status`;
const REBUILD = `${CLI} rebuild --live yes`;
const NONE = "nothing to do; this is informational";
/** The fix of an informational row: there is nothing to run. */
export const NO_FIX = NONE;

const extra = (fixNote, planned) => ({ ...(fixNote ? { fixNote } : {}), ...(planned ? { planned: true } : {}) });
const w = (code, plain, fix, planRef, degrades = false, fixNote = "", planned = false) => ({ code, kind: "warning", plain, fix, planRef, degrades, ...extra(fixNote, planned) });
const e = (code, plain, fix, planRef, fixNote = "") => ({ code, kind: "error", plain, fix, planRef, degrades: false, ...extra(fixNote) });
const c = (code, plain, fix = NONE, fixNote = "") => ({ code, kind: "counter", plain, fix, planRef: "5.4", degrades: false, ...extra(fixNote) });
const f = (code, plain, fix, planRef) => ({ code, kind: "flag", plain, fix, planRef, degrades: false });
const PRESET_ANY = `${CLI} preset any --confirm yes --live yes`;
const PRESET_ANY_NOTE = "this saves the 'any' choice (any model, any provider); `preset any` previews it first and saves nothing";
const PREVIEW_NOTE = "a preview only: it saves nothing";

const ROWS = [
  // ---- router warnings (status.json warnings[])
  w("POLICY_ABSENT_SKIPPED", "No compiled policy file exists, so the router leaves every subagent on the model it asked for. This is the normal state before a policy is saved.", `${CLI} preset`, "5.4", false, "", true),
  w("POLICY_CORRUPT", "The compiled policy file cannot be read, so the router ignores it and every subagent runs as it asked.", REBUILD, "5.4", true),
  w("POLICY_SCHEMA", "The compiled policy file has the wrong shape, so the router ignores it and every subagent runs as it asked.", REBUILD, "5.4", true),
  w("POLICY_OVERSIZE", "The compiled policy file is bigger than the router will read, so it is ignored and every subagent runs as it asked.", REBUILD, "5.4", true, "if the rebuild itself says the file would be too large, narrow the choice first (for example `preset free-1m`)"),
  w("POLICY_NEWER", "The compiled policy needs a newer router than the one that is running, so it is ignored and every subagent runs as it asked.", "node harness/deploy-router.mjs", "6.7", true, "redeploy a router that can read this policy (this command only prints the steps and changes nothing), or rebuild with the older compiler"),
  w("POLICY_HASH", "The compiled policy file does not match its own checksum (it was edited by hand or torn), so it is ignored.", REBUILD, "5.2", true),
  w("EMPTY_SET", "No model is allowed under the saved toggles for this session's main model, so its subagents run as they asked.", PRESET_ANY, "6.2", true, PRESET_ANY_NOTE),
  w("UNKNOWN_MAIN", "The router has not yet learned which model main uses, so it cannot choose a stand-in and subagents run as they asked.", STATUS, "6.3", false, "start a request in the main session first, then run it"),
  w("UNRESOLVABLE_CANDIDATE", "A model the policy chose is not wired in the gateway, so the router kept the model that was asked for.", REBUILD, "6.2"),
  w("UNRESOLVABLE_ASKED", "The model a subagent asked for is not wired in the gateway.", `${CLI} explain <provider/model>`, "6.2", false, "check the model name in the agent definition"),
  w("SLOT_ERROR", "The old model-slot file is unreadable, so the router returned the model as asked.", `${CLI} status`, "6.6"),
  w("INHERIT_PREMIUM_MAIN", "Subagents would run on main's model, and that model is premium-priced.", `${CLI} preset any --dry yes`, "6.2", false, PREVIEW_NOTE),
  w("INHERIT_BELOW_CTX", "The context floor asks for 1M but main's model is smaller; subagents inherit it anyway.", `${CLI} preset any --dry yes`, "6.2", false, PREVIEW_NOTE),
  w("CTX_UNDELIVERED", "A 1M-context model was chosen but the request did not carry the 1M beta header, so the model may run with less context.", NONE, "6.2"),
  w("CLASSIFIER_UNMEASURED", "Enforcement is on but the helper-call classifier has no passing accuracy record, so the router stays in shadow behaviour.", `${CLI} set --enforce shadow --live yes`, "12.5", true, "this keeps the router in shadow until the classifier check passes"),
  w("HANDOFF", "A free subagent hit a limit and its next request was handed to another model; the latest hand-over is shown.", `${CLI} last`, "6.1b E"),
  w("COOLING", "At least one model or provider key is resting after failures; the router avoids it until the rest period ends.", `${CLI} last`, "6.1b E.2"),
  w("OVERLAY_UNREADABLE", "The live model-status file could not be read, so the router ignores that hint (routing is not blocked).", `${CLI} status`, "6.1b F"),
  w("LOG_DROPPED", "Some log lines were dropped because logging was too fast or the disk was full; routing is not affected.", NONE, "5.5"),
  w("JOURNAL_CAP", "A session reached the limit of remembered subagents; the oldest are forgotten first.", NONE, "6.1b A"),
  w("SESSION_FILE_CAP", "Too many session files exist; the oldest were removed to make room.", NONE, "6.1b A"),
  w("NATIVE_MENU_PRESENT", "A provider has its own model descriptions, so Claude Code shows two model lists.", NONE, "6.4"),
  w("FREE_PROMISE_BREAK", "Free mode could not serve a request from the free set, so the model it asked for (possibly paid) ran it.", `${CLI} show --detail yes`, "6.2 h"),
  w("ROUTER_ERROR", "The router hit an internal error and returned the model as asked; repeated errors pause the policy by themselves.", `${CLI} last`, "5.4", true, "the latest decisions show what the router was doing when it failed"),
  w("AUTO_ROLLBACK", "The router paused the policy by itself because a safety check tripped; every model runs as asked.", `${CLI} resume --live yes`, "6.1b I", true),
  w("UNVERIFIED_ALLOWED", "Some allowed models have not been tool-tested yet, so a subagent on one may fail when it uses tools.", `${CLI} show --detail yes`, "5.4", false, "", true),
  w("PAYLOAD_RISK", "Some allowed models have a request-size limit under 1 MB, so a very large subagent request may be refused.", `${CLI} show --detail yes`, "5.4", false, "", true),
  w("TIERS", "The key registry could not be read, so the free-provider scopes are unavailable and free models uses the strict rule (free tag only).", `node keysync/key.mjs list`, "7"),
  w("TIER_MISMATCH", "The snapshot and your key registry disagree on a provider's tier; the registry is used.", `${CLI} rebuild --live yes`, "5.4"),
  w("FREE_LIST_STALE", "A model in the free list now reports a payment or key problem; rebuild to drop it.", REBUILD, "7", false, "", true),
  w("TIER_UNREADABLE", "The key registry could not be read, so provider-level free scopes cannot be computed.", `${CLI} status`, "7", false, "", true),
  w("DETECTOR_DRIFT", "Main requests keep arriving but no subagent is seen: Claude Code may have renamed its tool or header.", `${CLI} status`, "6.1", false, "", true),
  w("AUTOREBUILD_FAILED", "The automatic rebuild after the picker closed failed, so your saved choice is not applied yet.", REBUILD, "10.1", false, "", true),
  w("NO_ROWS_FOR_MAIN", "Main's provider has no model allowed under the toggles, so its subagents run as they asked.", PRESET_ANY, "10", false, PRESET_ANY_NOTE, true),
  // ---- compiler warnings (printed by set, show, rebuild)
  w("SOURCE_IGNORED", "The source choice does nothing under 'follow main': subagents get main's own model.", NONE, "5.1"),
  w("UNVERIFIED", "Some eligible models have not been tool-tested yet.", `${CLI} show --detail yes`, "5.3"),
  w("PREMIUM", "Some eligible models are premium-priced (Opus- or Fable-class); there is no price cap.", `${CLI} show --detail yes`, "5.3"),
  w("PAYLOAD", "Some eligible models have a request-size limit under 1 MB, or none is known (the size check does nothing for those until a limit is measured).", `${CLI} show --detail yes`, "5.2"),
  w("REPROBE", "Some free models were dropped on a temporary status (rate limit, timeout, empty answer, network failure) of an old test; they are not dead and wait for a re-test.", `${CLI} show --detail yes`, "5.3"),
  w("UNREACHABLE", "Some models passed the speed test but the tool test found them gone, with no confirmed pass; they are left out until a later test passes (an --allow pin does not override this).", `${CLI} show --detail yes`, "5.3"),
  w("DEMOTED", "Some eligible models rank below clean models because the tool test is blocked on them (rate limit, quota, upstream unavailable, slow, timeout or error for 3 or more runs in a row; payment, key or a gone answer with an earlier pass at once); none is excluded.", `${CLI} show --detail yes`, "5.3"),
  w("GATEWAY_COMPAT", "Some models are left out because their tool test failed in the gateway's own request translation, not in the model; they are tested again only when the gateway (CCR) changes (an --allow pin does not override this).", `${CLI} show --detail yes`, "5.3"),
  w("PROVIDER_PATTERN", "The same tool-test state sits on most of one provider's models, so the provider (not the models) is probably the cause; the models are demoted or left out one by one, never the provider as a whole.", `${CLI} show --detail yes`, "5.3"),
  w("CTX_UNPROVEN", "Some eligible models rest on an inferred 128k context that no test has proven; the router checks each request's size against it.", `${CLI} show --detail yes`, "5.2"),
  w("ONE_M_LISTING", "A 1M context is only claimed by the listing for some models and needs a beta header to be delivered.", NONE, "5.2"),
  w("ALIAS", "Some eligible models are pool aliases (the model behind the name can change); they never rank as tested.", NONE, "5.2"),
  w("FRAGILE", "A provider has fewer than 3 usable models, so a fan-out lands on the same few models.", `${CLI} preset any --dry yes`, "5.3", false, PREVIEW_NOTE),
  w("EMPTY_PROVIDERS", "Some providers have eligible models but none usable as a stand-in; their subagents run as they asked.", `${CLI} show --detail yes`, "5.2"),
  w("FREE_PROMISE", "Free is not a guarantee: when no free model fits a request, the model it asked for (possibly paid) runs it.", NONE, "6.2 h"),
  w("FREE_PROVIDERS", "Which providers count as free is YOUR label in the key registry; a provider labelled free that bills will bill.", `node keysync/key.mjs list`, "7"),
  w("CREDIT", "Free providers have token or credit limits; models with a price can use them up faster.", NONE, "5.3"),
  w("NO_TIER", "Some providers have no resolvable key tier, so only free-tagged models of theirs can be used.", `node keysync/key.mjs list`, "7"),
  w("PRICED_BUT_BADGED", "Some models carry a free badge but a non-zero listed price.", NONE, "5.3"),
  w("DEPOSIT_STRICT", "Some models on paid or deposit providers lack a free tag and are skipped.", NONE, "5.3"),
  w("ONLY_1M_SPELLING", "Some routes are listed only with a [1m] spelling that no request can name; they are dropped.", NONE, "5.2"),
  w("ID_REJECTED", "Some model ids failed the safety check and were dropped.", `${CLI} explain <provider/model>`, "5.2"),
  w("ACCOUNT_STATE", "Some responding models are left out because of account state (payment, key or rate limit); they are not removed from routing.", NONE, "5.3"),
  w("PROVIDERS_FALLBACK", "The gateway's live provider list could not be read, so the snapshot's routable flag was used; enforcement is refused.", `${CLI} rebuild --live yes`, "7"),
  w("PROVIDERS_FIXTURE", "The provider list came from a test file, so this run cannot enforce.", NONE, "7"),
  w("SNAPSHOT_STALE", "The model snapshot is older than 7 days; this is a warning, nothing is removed.", `node keysync/key.mjs list`, "7"),
  w("BENCH_OLDER", "The speed test results are older than the snapshot; this is a warning, nothing is removed.", NONE, "7"),
  w("SUBAGENT_OVERRIDE_SET", "CLAUDE_CODE_SUBAGENT_MODEL is set in Claude Code settings; it overrides the subagent model and defeats this policy.", `${CLI} show`, "7.2", false, "remove CLAUDE_CODE_SUBAGENT_MODEL from the env block of settings.json, then run it to confirm"),
  w("KEY_AMBIGUOUS", "A provider has several keys and no recorded choice, so its tier is unknown.", "node keysync/key.mjs prefer <provider> <id>", "7"),
  // ---- flags on one decision (agents.jsonl)
  f("FRAGILE_SET", "The lead group of equally good models was thin, so the spread had fewer than 3 models to use.", NONE, "5.3"),
  f("ALL_DEMOTED", "Every usable model in the lead group was resting, so a resting one was used.", `${CLI} last`, "6.1b E"),
  f("CTX_UNKNOWN", "The context size of the chosen model is not known.", NONE, "6.2"),
  f("INVARIANT", "A helper call (title, summary, compaction) came back on a different model than it asked for: the policy paused itself.", `${CLI} resume --live yes`, "6.1b I"),
  f("ERRORS", "The router raised 5 errors within a minute: the policy paused itself.", `${CLI} resume --live yes`, "6.1b I"),
  // ---- the CLI's closed exit codes
  e("E_USAGE", "The command line was not understood (or a real write was asked for without --live yes).", `${CLI} help`, "7"),
  e("E_TIER_INVALID", "The key tier is not one of free, free-deposit, paid, subscription, management.", "node keysync/key.mjs list", "7.1"),
  e("E_PRECONDITION", "A condition for this step is not met (for example enforcement needs live providers and a passing classifier record).", STATUS, "7"),
  e("E_EMPTY", "The saved toggles leave no model that can stand in for a subagent; nothing was written.", PRESET_ANY, "7", PRESET_ANY_NOTE),
  e("E_UNKNOWN_MODEL", "That model id is not in the snapshot.", `${CLI} explain <provider/model>`, "7"),
  e("E_OWNER_CORRUPT", "Your saved policy file is unreadable or invalid.", `${CLI} clear --live yes`, "7"),
  e("E_SNAPSHOT", "A needed input (snapshot, bench or provider list) is missing or unreadable.", "node keysync/key.mjs list", "7"),
  e("E_TIER_UNREADABLE", "The key registry or key choices could not be read.", "node keysync/key.mjs list", "7"),
  e("E_KEY_AMBIGUOUS", "A provider has several keys and no deliberate choice, so no tier can be assigned.", "node keysync/key.mjs prefer <provider> <id>", "7"),
  e("E_WRITE", "A file could not be written after retries.", STATUS, "7"),
  e("E_COMPILED_CORRUPT", "The compiled policy file is valid JSON but not a policy; the router ignores it.", REBUILD, "7"),
  // ---- the router's counters (status.json counters{})
  c("req", "Requests the router saw."), c("main", "Requests from the main session."), c("sub", "Requests from subagents."), c("aux", "Helper calls (titles, summaries): never rewritten."),
  c("keep", "Subagent requests left on the model they asked for."), c("honourTag", "Subagent requests where main's chosen model was honoured."),
  c("substitute", "Subagent requests moved to another model."), c("inherit", "Subagent requests given main's own model."),
  c("emptySet", "Requests that found no allowed model.", PRESET_ANY, PRESET_ANY_NOTE), c("unknownMain", "Requests made before the router learned main's model."),
  c("unresolvable", "Requests whose chosen model is not wired in the gateway.", REBUILD), c("rejectUnresolvable", "Requests refused because the chosen model is not wired in the gateway.", REBUILD),
  c("error", "Internal router errors (the request still went through as asked).", STATUS), c("slotError", "Old model-slot file errors."), c("injected", "Times the model list was added to main's tool description."),
  c("detectorDisagree", "Times the two ways of spotting a subagent disagreed.", STATUS), c("ctxUndelivered", "1M-context choices that lacked the beta header."), c("ctxSkip", "Candidates skipped because the request would not fit their context."),
  c("payloadSkip", "Candidates skipped because the request was bigger than their size limit."), c("payloadUnknown", "Requests where a candidate's size limit was not known."),
  c("stickyHit", "Repeat requests of a running subagent kept on its model."), c("stickyNew", "New subagents given a model."), c("stickyEvict", "Remembered subagents dropped (old or over the limit)."),
  c("policyBad", "Requests served as asked because the compiled policy was unusable.", REBUILD), c("slowReq", "Requests slower than the router's own limit (the first request after a policy change is expected)."),
  c("auxOnRelay", "Helper calls that ran on the Claude relay."), c("freeBreak", "Times free mode could not serve a request from the free set.", `${CLI} show --detail yes`),
  c("blNoAgentId", "Subagent requests that carried no agent id.", STATUS), c("agentIdOdd", "Requests whose agent id failed the safety check."),
  c("journalFail", "Failures writing the remembered-subagent journal."), c("journalCap", "Times a session hit the remembered-subagent limit."), c("logDropped", "Log lines dropped."),
  c("retry", "Retried requests seen from subagents."), c("stickyOverflow", "Remembered subagents lost to the per-session limit."), c("stickyCapEvict", "Remembered subagents evicted by the overall limit."),
  c("stickyNone", "Decisions with no model, so nothing was remembered."), c("enforced", "Requests decided while enforcing."), c("autoRollback", "Times the router paused itself.", `${CLI} resume --live yes`),
  c("handoff", "Subagents handed to another model after a limit.", `${CLI} last`), c("handoffNone", "Limits hit with no other model to hand over to.", `${CLI} last`),
  c("handoffCap", "Hand-overs refused because an agent reached its hourly limit."), c("handoffWould", "Hand-overs that would have happened (shadow mode logs them, changes nothing)."),
  c("noticeApplied", "Hand-over notices added to a subagent's prompt."), c("noticeFail", "Hand-over notices that could not be added."), c("asyncWriteFail", "Status or state files that could not be written in the background."),
  c("overlayBad", "Reads of the live model-status file that failed."), c("retryHdr", "Retries recognised from the retry header."), c("retryLen", "Retries recognised from an unchanged message count."),
  c("stickyJournalTorn", "Half-written journal lines that were skipped."), c("stickyOut", "Remembered subagents dropped because their model left the allowed set."),
  c("coolMark", "Models put to rest after a failure."), c("coolProvider", "Provider keys put to rest after two models failed."), c("coolLimited", "Failures not counted because a session reached its limit."),
  c("coolDemote", "Times a resting model was skipped for another."), c("overlayDemote", "Times the live model-status file steered a choice away from a model."), c("sessionFileSkip", "Session files not created because of the limit."),
];

export const CODES = Object.freeze(ROWS.map((r) => Object.freeze(r)));
const BY = new Map(CODES.map((r) => [r.code, r]));
export const KINDS = Object.freeze(["warning", "flag", "error", "counter"]);

/** One row by its code (exact, then upper-case so `why empty_set` works); null when it is not in the table. */
export const codeRow = (code) => BY.get(String(code)) ?? BY.get(String(code).toUpperCase()) ?? null;
/** The codes that mean "the router is not doing what you saved". */
export const degradingCodes = () => CODES.filter((r) => r.degrades).map((r) => r.code);
