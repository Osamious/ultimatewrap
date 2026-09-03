//! The two-level provider -> model picker.
//!
//! Ported from Maestro's `apps/tui/src/app/types.rs` (`FilterList<T>`,
//! `ProviderChoice`, `ProviderTier`, `ModelMenu`, and the shared `wrap_cursor`
//! / `window_for` cursor math). `apps/tui` has no `[lib]` target, so a real
//! Cargo dependency is impossible; this is a copy, adapted so `ModelChoice`
//! is built from a plain catalog shape (provider name, model id, tier, plan
//! hint) instead of Maestro's `harness::backend::Backends` registry.
//!
//! Behaviours that were carried over deliberately and must not drift:
//!   * keys are lowercased once at construction, never per keystroke;
//!   * refilter is a whitespace-token split, ANDed, substring `contains`;
//!   * the cursor resets to the first match on every refilter;
//!   * `window_for` keeps `selected` in view, shared by both levels;
//!   * the Esc ladder: clear query -> leave level 2 -> close.

use crate::model_tier::{ModelTier, ProviderPlanHint};

/// Move a cursor by `delta`, wrapping within `len`.
pub fn wrap_cursor(selected: usize, len: usize, delta: i32) -> usize {
    if len == 0 {
        return selected;
    }
    (selected as i32 + delta).rem_euclid(len as i32) as usize
}

/// Shared window math for the pickers: the range of row indices to render for
/// a viewport `visible` rows tall, keeping `selected` in view.
pub fn window_for(len: usize, selected: usize, visible: usize) -> std::ops::Range<usize> {
    if len == 0 || visible == 0 {
        return 0..0;
    }
    let visible = visible.min(len);
    let start = selected.saturating_sub(visible - 1).min(len - visible);
    start..start + visible
}

/// A list with a live text filter. `rows` is the full set; `keys` holds each
/// row's lowercased match text, computed once at construction; `visible` holds
/// indices into `rows` and is recomputed only when the query changes (not per
/// frame). `selected` indexes `visible`, never `rows`.
pub struct FilterList<T> {
    rows: Vec<T>,
    keys: Vec<String>,
    pub query: String,
    visible: Vec<usize>,
    pub selected: usize,
}

impl<T> FilterList<T> {
    /// `key` is applied once per row at construction and its result lowercased
    /// into `keys`; the closure is not retained.
    pub fn new(rows: Vec<T>, key: impl Fn(&T) -> String) -> Self {
        let keys: Vec<String> = rows.iter().map(|r| key(r).to_lowercase()).collect();
        let visible = (0..rows.len()).collect();
        FilterList {
            rows,
            keys,
            query: String::new(),
            visible,
            selected: 0,
        }
    }

    /// Case-insensitive substring match, ANDed over whitespace-separated
    /// tokens. The cursor resets to the first match: carrying a stale index
    /// across a changed view is how a filtered picker commits the wrong row.
    fn refilter(&mut self) {
        let q = self.query.to_lowercase();
        let tokens: Vec<&str> = q.split_whitespace().collect();
        self.visible = self
            .keys
            .iter()
            .enumerate()
            .filter(|(_, k)| tokens.iter().all(|t| k.contains(t)))
            .map(|(i, _)| i)
            .collect();
        self.selected = 0;
    }

    pub fn push(&mut self, c: char) {
        self.query.push(c);
        self.refilter();
    }

    pub fn pop(&mut self) {
        self.query.pop();
        self.refilter();
    }

    pub fn clear_query(&mut self) {
        self.query.clear();
        self.refilter();
    }

    /// Move the cursor by `delta`, wrapping within the *filtered* view.
    pub fn move_by(&mut self, delta: i32) {
        self.selected = wrap_cursor(self.selected, self.visible.len(), delta);
    }

    /// The row under the cursor, or `None` while nothing matches.
    pub fn selected_row(&self) -> Option<&T> {
        self.row_at(self.selected)
    }

    /// The index into `rows` of the row under the cursor.
    pub fn selected_index(&self) -> Option<usize> {
        self.visible.get(self.selected).copied()
    }

    /// The row at a position in the filtered view - the index space
    /// `window_for` speaks, and the one the renderer iterates.
    pub fn row_at(&self, pos: usize) -> Option<&T> {
        self.visible.get(pos).and_then(|&i| self.rows.get(i))
    }

    /// Every row, unfiltered.
    pub fn rows(&self) -> &[T] {
        &self.rows
    }

    /// How many rows currently match. The renderer's index space: pair it
    /// with `window_for` and `row_at`, never with `rows()`.
    pub fn visible_len(&self) -> usize {
        self.visible.len()
    }
}

/// One row of the picker's second level: a catalog model.
///
/// `tier` is the per-model pricing claim from `infer_tier`; `plan_hint` is the
/// vault's weaker per-credential claim for `provider`, carried separately and
/// only consulted when `tier` is `Unknown` (see `model_tier::resolve_label`).
#[derive(Debug, Clone)]
pub struct ModelChoice {
    /// The catalog's own model id - the value that would be committed.
    pub model: String,
    /// Human-friendly display name; defaults to `model` when the catalog
    /// offers nothing better.
    pub label: String,
    /// The grouping key for level 1.
    pub provider: String,
    /// Free/paid/unknown, carried structurally rather than baked into `label`.
    pub tier: ModelTier,
    /// The provider's plan claim from `~/.llmkeys/registry.json`, if any.
    pub plan_hint: Option<ProviderPlanHint>,
}

/// The aggregate tier claim for a whole provider group. One value rather than
/// a `(has_free, all_paid)` pair: principle "unknown stays unknown" is a
/// constraint *between* the two, which is what an enum is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderTier {
    /// At least one member is `Free`.
    FreeAvailable,
    /// Non-empty and every member is `Paid`.
    Paid,
}

/// One row of the picker's first level: a provider and the models it offers.
#[derive(Debug, Clone)]
pub struct ProviderChoice {
    /// Grouping key and display name.
    pub provider: String,
    /// Indices into the menu's own `all` vec, in registry order.
    pub model_idx: Vec<usize>,
    /// `None` when the group is all-Unknown, or mixes Paid with Unknown.
    pub tier: Option<ProviderTier>,
    /// The provider's own plan hint, shown at level 1 only when no aggregate
    /// per-model claim exists - the same fallback ordering as a single row.
    pub plan_hint: Option<ProviderPlanHint>,
    /// This group holds the session's current model - drives the `*` marker
    /// and the initial cursor position at level 1.
    pub is_current: bool,
}

impl ProviderChoice {
    /// Fold the flat choice list into provider groups. Both the provider
    /// order and each group's `model_idx` order are alphabetical (by
    /// provider name, then by each model's own `label`), case-insensitively -
    /// not first-appearance/catalog order, so the list reads the same
    /// regardless of how the catalog happens to be arranged.
    ///
    /// The group's `plan_hint` is taken from an arbitrary member, which is
    /// sound only because every row of a provider carries that provider's hint
    /// (see `catalog::rows_from_json`) - so the members agree by construction
    /// and "arbitrary" cannot mean "whichever the catalog listed first".
    /// Grouping is case-insensitive, matching the sort and the vault lookup.
    pub fn group(all: &[ModelChoice], current_model: &str) -> Vec<ProviderChoice> {
        let mut out: Vec<ProviderChoice> = Vec::new();
        // Keyed on the lowercased name, because everything else that touches a
        // provider name already is: the final sort, and the vault lookup that
        // produced `plan_hint`. Keyed on the raw string, "OpenRouter" and
        // "openrouter" would become two groups carrying the same hint.
        let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for (i, c) in all.iter().enumerate() {
            let key = c.provider.to_lowercase();
            match seen.get(&key) {
                Some(&g) => out[g].model_idx.push(i),
                None => {
                    seen.insert(key, out.len());
                    out.push(ProviderChoice {
                        provider: c.provider.clone(),
                        model_idx: vec![i],
                        tier: None,
                        plan_hint: c.plan_hint,
                        is_current: false,
                    });
                }
            }
        }
        for g in &mut out {
            g.model_idx.sort_by_key(|&i| all[i].label.to_lowercase());
            let tiers: Vec<ModelTier> = g.model_idx.iter().map(|&i| all[i].tier).collect();
            g.tier = if tiers.contains(&ModelTier::Free) {
                Some(ProviderTier::FreeAvailable)
            } else if tiers.iter().all(|t| *t == ModelTier::Paid) {
                Some(ProviderTier::Paid)
            } else {
                None
            };
        }
        // Exactly one group is marked, matching the first-match join on the
        // same key. Mark before sorting so this lookup is still over the
        // (irrelevant-order) grouping pass, not the final order.
        if let Some(ci) = all.iter().position(|c| c.model == current_model) {
            if let Some(g) = out.iter_mut().find(|g| g.model_idx.contains(&ci)) {
                g.is_current = true;
            }
        }
        out.sort_by_key(|g| g.provider.to_lowercase());
        out
    }
}

/// The model picker: two levels, providers then models, each with its own
/// independent filter.
///
/// `all` is cloned at open time and `model_idx` indexes *that* vec, so the
/// open picker is a snapshot: a catalog refresh landing mid-selection cannot
/// reach in here and re-point the cursor at a different model.
pub struct ModelMenu {
    pub providers: FilterList<ProviderChoice>,
    /// `Some` while drilled into a provider; its own independent filter.
    pub models: Option<FilterList<ModelChoice>>,
    /// The provider being viewed at level 2, as an index into
    /// `providers.rows()`.
    pub drilled: Option<usize>,
    all: Vec<ModelChoice>,
}

impl ModelMenu {
    /// Group `all` by provider and open at level 1, with the cursor on the
    /// group holding `current_model`.
    pub fn new(all: Vec<ModelChoice>, current_model: &str) -> Self {
        let groups = ProviderChoice::group(&all, current_model);
        let cursor = groups.iter().position(|g| g.is_current).unwrap_or(0);
        // Match on every member's label and id too, not just the group name -
        // so a model's own name reaches its provider without the user knowing
        // which provider it lives under.
        let mut providers = FilterList::new(groups, |g: &ProviderChoice| {
            let mut key = g.provider.clone();
            for &i in &g.model_idx {
                let c = &all[i];
                key.push(' ');
                key.push_str(&c.label);
                key.push(' ');
                key.push_str(&c.model);
            }
            key
        });
        providers.selected = cursor;
        ModelMenu {
            providers,
            models: None,
            drilled: None,
            all,
        }
    }

    /// Every model row the menu was opened over.
    pub fn all(&self) -> &[ModelChoice] {
        &self.all
    }

    /// True while the catalog itself is empty - a different state from a
    /// filter that matches nothing.
    pub fn is_empty(&self) -> bool {
        self.all.is_empty()
    }

    pub fn at_model_level(&self) -> bool {
        self.models.is_some()
    }

    /// The provider the model level belongs to.
    pub fn drilled_provider(&self) -> Option<&ProviderChoice> {
        self.drilled.and_then(|i| self.providers.rows().get(i))
    }

    pub fn move_by(&mut self, delta: i32) {
        match &mut self.models {
            Some(m) => m.move_by(delta),
            None => self.providers.move_by(delta),
        }
    }

    /// Drill into the highlighted provider. A no-op at the model level and on
    /// an empty filtered view.
    pub fn enter(&mut self) {
        if self.models.is_some() {
            return;
        }
        let Some(gi) = self.providers.selected_index() else {
            return;
        };
        let rows: Vec<ModelChoice> = self.providers.rows()[gi]
            .model_idx
            .iter()
            .map(|&i| self.all[i].clone())
            .collect();
        self.models = Some(FilterList::new(rows, |c: &ModelChoice| {
            format!("{} {}", c.label, c.model)
        }));
        self.drilled = Some(gi);
    }

    /// One rung down the `Esc` ladder: clear the current level's query, else
    /// leave the model level, else ask to close. Returns whether the menu
    /// should close. Going back keeps the provider level's query *and* cursor.
    pub fn back(&mut self) -> bool {
        if let Some(m) = &mut self.models {
            if !m.query.is_empty() {
                m.clear_query();
            } else {
                self.models = None;
                self.drilled = None;
            }
            return false;
        }
        if !self.providers.query.is_empty() {
            self.providers.clear_query();
            return false;
        }
        true
    }

    pub fn type_char(&mut self, c: char) {
        match &mut self.models {
            Some(m) => m.push(c),
            None => self.providers.push(c),
        }
    }

    pub fn backspace(&mut self) {
        match &mut self.models {
            Some(m) => m.pop(),
            None => self.providers.pop(),
        }
    }

    /// The model under the cursor, at the model level only - the sole place a
    /// commit can happen.
    pub fn selected_row(&self) -> Option<&ModelChoice> {
        self.models.as_ref().and_then(|m| m.selected_row())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn choice(provider: &str, model: &str, tier: ModelTier) -> ModelChoice {
        ModelChoice {
            model: model.to_string(),
            label: model.to_string(),
            provider: provider.to_string(),
            tier,
            plan_hint: None,
        }
    }

    fn menu() -> ModelMenu {
        ModelMenu::new(
            vec![
                choice("groq", "llama-3.3-70b", ModelTier::Free),
                choice("groq", "kimi-k2-instruct", ModelTier::Paid),
                choice("openrouter", "qwen/qwen3-max:free", ModelTier::Free),
            ],
            "",
        )
    }

    #[test]
    fn filter_ands_whitespace_tokens_and_is_case_insensitive() {
        let mut list = FilterList::new(
            vec!["Alpha Beta", "Alpha Gamma", "Delta Beta"],
            |s: &&str| s.to_string(),
        );
        list.push('a');
        list.push('l');
        assert_eq!(list.visible_len(), 2);
        list.push(' ');
        list.push('B');
        assert_eq!(list.visible_len(), 1, "tokens are ANDed, not ORed");
        assert_eq!(list.selected_row().copied(), Some("Alpha Beta"));
    }

    #[test]
    fn refilter_resets_the_cursor_to_the_first_match() {
        let mut list = FilterList::new((0..30).collect::<Vec<u32>>(), |n: &u32| n.to_string());
        list.move_by(5);
        assert_eq!(list.selected, 5);
        list.push('1');
        assert_eq!(list.selected, 0);
    }

    #[test]
    fn esc_ladder_clears_query_then_leaves_level_then_closes() {
        let mut m = menu();
        m.type_char('g');
        m.enter();
        assert!(m.at_model_level());
        m.type_char('k');
        assert!(!m.back(), "first esc clears the model-level query");
        assert!(m.models.as_ref().unwrap().query.is_empty());
        assert!(m.at_model_level(), "still at level 2");
        assert!(!m.back(), "second esc leaves the model level");
        assert!(!m.at_model_level());
        assert_eq!(m.providers.query, "g", "the provider query survives the drill-out");
        assert!(!m.back(), "third esc clears the provider query");
        assert!(m.back(), "fourth esc closes the menu");
    }

    #[test]
    fn entering_a_provider_opens_only_that_providers_models() {
        let mut m = menu();
        // Groups are sorted alphabetically: groq, openrouter.
        assert_eq!(m.providers.rows()[0].provider, "groq");
        m.enter();
        let models = m.models.as_ref().expect("drilled");
        assert_eq!(models.visible_len(), 2);
        assert_eq!(m.drilled_provider().map(|p| p.provider.as_str()), Some("groq"));
    }

    #[test]
    fn provider_tier_aggregates_free_available_and_all_paid() {
        let all = vec![
            choice("mixed", "a", ModelTier::Free),
            choice("mixed", "b", ModelTier::Paid),
            choice("allpaid", "c", ModelTier::Paid),
            choice("murky", "d", ModelTier::Paid),
            choice("murky", "e", ModelTier::Unknown),
        ];
        let groups = ProviderChoice::group(&all, "");
        let by = |name: &str| {
            groups
                .iter()
                .find(|g| g.provider == name)
                .expect("group exists")
                .tier
        };
        assert_eq!(by("mixed"), Some(ProviderTier::FreeAvailable));
        assert_eq!(by("allpaid"), Some(ProviderTier::Paid));
        assert_eq!(by("murky"), None, "paid mixed with unknown claims nothing");
    }

    #[test]
    fn window_for_keeps_the_cursor_in_view() {
        assert_eq!(window_for(30, 0, 10), 0..10);
        assert_eq!(window_for(30, 20, 10), 11..21);
        assert_eq!(window_for(30, 29, 10), 20..30);
        assert_eq!(window_for(0, 0, 10), 0..0);
    }
}
