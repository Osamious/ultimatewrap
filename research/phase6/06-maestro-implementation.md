# Research: Maestro's model menu implementation (2026-09-02)

Located at `D:\TAMUQ\Internship\QCRI 2026\Fanar Hackathon\maestro` — a Rust + TypeScript
monorepo, git remote `https://github.com/ElyasAmri/maestro`. Found via
`C:\Users\osami\Recent\maestro.lnk`.

## Where the menu lives

Entirely in the **Rust TUI crate** (`maestro-tui` v0.18.1, binary `maestro`):

| File | Role |
|---|---|
| `apps/tui/src/app/types.rs` | `FilterList`, `ModelChoice`, `ProviderChoice`, `ModelMenu`, `window_for` |
| `apps/tui/src/ui/modals.rs` | `render_model_menu` (line 313), `menu_layout` (629) |
| `apps/tui/src/input.rs` (70-115) | key handling |
| `apps/tui/src/slash.rs` (160-188) | `/model` and `/model refresh` dispatch |
| `apps/tui/src/engine.rs` (778-823) | async refresh task |
| `harness/src/backend/discovery.rs` | fetch, cache, tier/capability inference, vault fallback |
| `harness/src/backend/mod.rs`, `credential.rs` | registry + Windows Credential Manager |
| `harness/src/engine/session/mod.rs:1261` | `Session::refresh_models` |

TUI library: **ratatui 0.30 + crossterm 0.29**. No raw ANSI — a `Paragraph` inside a bordered
`Block`. Other frontends (`apps/web`, `apps/desktop`, `apps/vscode-extension`) have **no**
model menu.

## The menu UI

**Two-level nested: providers → models**, both live-filtered, each with independent filter
state (`types.rs:1064-1070`).

Level 1 row (`modals.rs:435-465`) — a single composed string, **not columns**:
```
{provider}  ({model_count})  [free available|paid]  [(auto)]  [{fixed model label}]  [*]
```

Level 2 row (`modals.rs:369-393`):
```rust
let tier = match c.tier {
    harness::backend::ModelTier::Free => "  free",
    harness::backend::ModelTier::Paid => "  paid",
    harness::backend::ModelTier::Unknown => "",
};
format!("{}{tier}  ({}){marker}", c.label, c.model)
```
Plus, for non-chat models, `"  - {reason}"` appended and the row painted `DarkGray` —
deprioritized, never hidden.

Rendering: `centered_rect(60, 50, area)` modal, `Clear`, then
`Paragraph::new(body).block(block).wrap(Wrap { trim: false })`. Selection is
`Modifier::REVERSED`. **No `Table` widget, no `Scrollbar`, no horizontal scrolling** — wide
rows soft-wrap. Explicitly "ASCII only".

Large lists: **vertical windowing, no pagination state.** `window_for` (`types.rs:695`)
derives the visible slice from the cursor alone:
```rust
let visible = visible.min(len);
let start = selected.saturating_sub(visible - 1).min(len - visible);
start..start + visible
```
`menu_layout` (`modals.rs:629`) measures the real wrapped footer height, and when rows
overflow appends `(x-y of n matching)` to the hint line, then re-computes the window against
the now-taller footer. Cursor movement **wraps** (`wrap_cursor`, `types.rs:683`, `rem_euclid`).
Documented in `docs/changelog/2026-08-19-model-menu-scrolling.md`.

A one-line filter header is **always reserved** ("type to filter" when empty) so the row
window does not shift on the first keystroke.

## Search / type filter

**Case-insensitive substring, ANDed over whitespace-separated tokens.** No fuzzy matcher, no
external library. `FilterList::refilter`, `types.rs:980-995`:
```rust
let tokens: Vec<&str> = q.split_whitespace().collect();
self.visible = self.keys.iter().enumerate()
    .filter(|(_, k)| tokens.iter().all(|t| k.contains(t)))
    .map(|(i, _)| i).collect();
self.selected = 0;
```
Match keys lowercased once at construction. **Provider-level key concatenates the group name
plus every member model's label and id** (`types.rs:1090-1098`), so typing `opus` finds the
`anthropic` group. Model-level key is `"{label} {model_id}"`.

Filters at **both** levels, independently. Keyboard (`input.rs:78-113`): every unmodified
printable char is filter text — digits and `j`/`k` included — so only
Up/Down/`Ctrl+P`/`Ctrl+N` move and only Enter commits. Esc is a ladder: clear this level's
query → leave the model level → close (`ModelMenu::back`, `types.rs:1157`). Going back
preserves the provider level's query *and* cursor.

## `/model refresh`

`slash.rs:160`:
```rust
"/model" if arg.trim() == "refresh" => {
    if !engine.supports_model_refresh() {
        app.notify = Some("/model refresh is only supported in local (in-process) mode".into());
    } else { engine.refresh_models(); app.notify = Some("refreshing models...".into()); }
}
```
Fire-and-forget `tokio::spawn` (`engine.rs:783`) so it never blocks the render loop. Calls
`Session::refresh_models` (`harness/src/engine/session/mod.rs:1261`), which reloads the same
backends config with `force = true` and swaps in a whole new `Backends` registry:
```rust
let loaded = Backends::load(self.config.config_path.as_deref(), &self.config.cwd, /* force */ true).await?;
let active_backend_vanished = new_backends.get(&active).is_none().then_some(active);
*self.backends.lock() = new_backends;
```

**What it refreshes:** `GET {base_url}/models` for every spec with `"discover_models": true`
(45 of 53 specs in this user's `.maestro/backends.json`). Auth is `bearer_auth(api_key)` plus
configured extra headers. Response accepts either `data` or `models` as the array key
(`ModelsResponse`, `discovery.rs:272-275` — "some providers (Fanar confirmed) key it `models`").

**Timeouts / failures** (`fetch_live`, `discovery.rs:288`): `connect_timeout 10s`, total
`timeout 15s` per provider. `resolve_models` never fails; the fallback chain is:
1. fresh cache (**skipped when `force`**)
2. live fetch
3. **stale cache** if the fetch failed
4. vault fallback (`~/.llmkeys`)
5. empty → that backend is skipped, warning logged, rest of the config still loads

**Providers are fetched sequentially, not concurrently** — `backend/mod.rs:461`:
`list.extend(resolve_spec(spec, force).await?)` inside a `for` loop. With 45 discovery
providers at 15 s worst case that is a long tail. Also, credential resolution errors
(`resolve_credential`) use `?` and **do abort the whole reload**, leaving the old registry in
place.

**Cache:** `~/.maestro/model_cache.json` (`cache_path()` → `net::discovery::maestro_home()`,
honouring `MAESTRO_HOME`; on Windows `USERPROFILE` first). Format is a
`BTreeMap<backend_name, CacheEntry>`, pretty-printed:
```rust
struct CacheEntry { models: Vec<DiscoveredModel>, fetched_at_unix_secs: u64 }
```
**TTL = 24 h** (`const CACHE_TTL: Duration = Duration::from_secs(24*60*60);`,
`discovery.rs:183`), `is_stale()` = age > TTL. Live file on this machine: **659 KB, 50
backends, 4,282 models**.

`write_cache` deliberately merges through raw `serde_json::Value` for other backends so
`#[serde(default)]` never poisons an entry it was not asked to touch.

The open picker is a **snapshot** — a refresh landing mid-selection does not mutate it
(`types.rs:1055-1063`). `main.rs:925` watches for the `"refreshed - "` log prefix and only
then re-pulls `app.model_choices`.

## Free-model labeling

Three-state `ModelTier { Free, Paid, Unknown }` — "`Unknown` means the heuristic found
nothing to go on, not that the model is definitely paid." Detection, `discovery.rs:332`:

```rust
fn infer_tier(id: &str, obj: &serde_json::Map<String, serde_json::Value>) -> ModelTier {
    let id_lower = id.to_ascii_lowercase();
    if id_lower.ends_with(":free") || id_lower.ends_with("-free") || id_lower.ends_with("/free") {
        return ModelTier::Free;
    }
    let mut found_any = false;
    let mut all_zero = true;
    for (key, val) in obj {
        let kl = key.to_ascii_lowercase();
        if kl.contains("pric") || kl.contains("cost") { scan_numeric(val, &mut found_any, &mut all_zero); }
    }
    match (found_any, all_zero) {
        (true, true) => ModelTier::Free,
        (true, false) => ModelTier::Paid,
        (false, _) => ModelTier::Unknown,
    }
}
```

**Name suffix first**, then a **recursive numeric scan** of any field whose name contains
`pric` or `cost` (nested objects/arrays, numbers or quoted numbers) — all-zero → Free, any
non-zero → Paid. No hardcoded free-model list.

Aggregated per provider group as `ProviderTier::FreeAvailable` if *any* member is Free, `Paid`
if *all* are Paid, else `None` (`types.rs:918-925`).

**Current cache distribution: 184 free / 2,231 paid / 1,867 unknown** — i.e. heuristics
plateau at ~44% unknown.

## Provider & model metadata

Per **model** (`DiscoveredModel`, cached): `id`, `display_name` (from `display_name` or
`name`), `tier`, `capability`.
Per **registry entry** (`BackendEntry`, `backend/mod.rs:276`): `name`, `model`, `label`,
`color` (`#rrggbb`, explicit or brand default), `provider` (the spec's `group` or its name),
`tier`, `capability`, `auto_route`, `discovered`.

`ModelCapability` = `Chat | Vision | Audio | ImageGen | Embedding | Moderation | Rerank |
Deprecated | ContextTooSmall`, inferred by `infer_capability` (`discovery.rs:402`) from
provider deprecation flags first, then id substrings/whole-token matching (`has_token` avoids
`imagen` matching `image`).

**Context window is read but NOT displayed** — used only as a gate: `infer_context_length`
grabs the first field whose name contains `"context"` (covers `context_length`,
`max_context_length`, `context_window`), and anything under
**`MIN_SAFE_CONTEXT_TOKENS = 24_000`** becomes `ContextTooSmall`. That floor is justified
from a measured 14,314-prompt-token baseline + 8,192 default `max_tokens`.

**No release date, no per-model pricing stored.** A separate `harness/src/backend/pricing.rs`
has a hardcoded substring table of USD/1M rates (claude-*, deepseek-*) for cost estimation —
**not wired into the model menu**.

## Credentials — the same vault

`harness/src/backend/credential.rs` reads Windows Credential Manager directly via
`CredReadW` / `CRED_TYPE_GENERIC` (`windows-sys 0.61`), decoding the UTF-16 blob. Precedence
in `resolve_credential` (`backend/mod.rs:542`): inline `api_key` → `api_key_env` →
`api_key_target` (Credential Manager) → error. Non-Windows is a `None` stub.

Target names in `.maestro/backends.json` are exactly `LLMKEY:{bucket}.{provider}.{tier}` —
e.g. `"api_key_target": "LLMKEY:personal_maestro.deepseek.paid"` — matching `New-KeyId` /
`[Win32CredManager]::Write("LLMKEY:$id", ...)` in `ApiKeyVault.ps1:141,164`.

Maestro also reads the vault **files** as its last discovery fallback (`vault_fallback`,
`discovery.rs:625`): strips `LLMKEY:`, looks the id up in `registry.json` for its `provider`
and `tier`, then finds that provider's `testModel` in `providers.json` and synthesizes a
single `DiscoveredModel` (tier from the registry's `free`/`paid`, capability forced to
`Chat`). Home dir is `MAESTRO_LLMKEYS_HOME` if set, else `%USERPROFILE%\.llmkeys`.

## What to take, and what not to

**Take:**
- Three-state tier where `Unknown ≠ Paid`.
- The `infer_tier` algorithm (see the rescued Rust crate — it is the same logic and it works on today's schema).
- Provider-level filter keys that include member model ids/labels, so a model name finds its provider.
- The snapshot-during-refresh discipline.
- `MIN_SAFE_CONTEXT_TOKENS` as a capability gate rather than a hidden failure.

**Do not copy:**
- **Sequential fetch** of 45 providers at up to 15 s each — an 11-minute worst case.
- **Credential resolution errors aborting the entire reload**, so one bad key blocks refresh of all others.

**And the finding that matters most for the column request:** Maestro does **not** render
real columns either. Both levels are composed single strings, soft-wrapped, no `Table`
widget, no `Scrollbar`, no horizontal scrolling, explicitly ASCII-only. The tool that already
solved this problem chose composed strings over columns.
