//! Free/paid classification for a catalog model, plus the deliberately
//! *separate* provider-plan hint that fills in where per-model pricing is
//! absent.
//!
//! Two kinds of claim live here and they must never be conflated:
//!
//!   * [`ModelTier`] - a **per-model** claim, inferred from the catalog
//!     entry's own pricing signal by [`infer_tier`]. Ported verbatim from
//!     Maestro's `harness/src/backend/discovery.rs` (the five `infer_tier`
//!     tests below are copied unchanged, which is what proves the port
//!     faithful).
//!   * [`ProviderPlanHint`] - a **per-credential** claim read from
//!     `~/.llmkeys/registry.json`'s `tier` field. It says "the key I hold for
//!     this provider is on their free/paid plan", which is a weaker and
//!     different statement than "this model costs nothing". It is only ever
//!     consulted when `infer_tier` returned [`ModelTier::Unknown`], and the UI
//!     renders it distinctly (see [`TierLabel`] and `crate::ui::tier_label`).
//!
//! The two are not the same type, do not convert into each other, and
//! [`TierLabel`] - the only place they meet - keeps them in separate variants.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Whether a discovered model costs money to call. Providers report pricing
/// in wildly different shapes (nested objects, arrays of `{unit,value}`,
/// numbers as JSON numbers or as quoted strings, or no pricing field at all
/// and a `:free` id suffix instead) - see [`infer_tier`]. `Unknown` means the
/// heuristic found nothing to go on, not that the model is definitely paid.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelTier {
    Free,
    Paid,
    #[default]
    Unknown,
}

impl ModelTier {
    /// Short label suffix for a display name, e.g. "Model A (free)".
    /// `Unknown` adds nothing - a guess is worse than no label.
    pub fn label_suffix(self) -> &'static str {
        match self {
            ModelTier::Free => " (free)",
            ModelTier::Paid => " (paid)",
            ModelTier::Unknown => "",
        }
    }
}

/// Best-effort free/paid guess for one discovered model, in order:
///   1. a `:free`, `-free`, or `/free` id suffix (three conventions seen in
///      the wild - OpenRouter/ZenMux/Kilo use `:free`, TokenRouter/TeamoRouter
///      use `-free`, OrcaRouter uses `/free`, e.g. `orcarouter/free`)
///   2. any field on the object whose name contains "pric" (matches "price"
///      AND "pricing" - they diverge at the 5th letter, `contains("price")`
///      alone misses "pricing" entirely) or "cost" (nested objects/arrays
///      included, values as JSON numbers or numeric strings both accepted -
///      confirmed both occur in the wild): all-zero -> Free, any non-zero -> Paid
///   3. neither present -> Unknown (a guess here would be worse than none)
pub fn infer_tier(id: &str, obj: &serde_json::Map<String, serde_json::Value>) -> ModelTier {
    let id_lower = id.to_ascii_lowercase();
    if id_lower.ends_with(":free") || id_lower.ends_with("-free") || id_lower.ends_with("/free") {
        return ModelTier::Free;
    }
    let mut found_any = false;
    let mut all_zero = true;
    for (key, val) in obj {
        let kl = key.to_ascii_lowercase();
        if kl.contains("pric") || kl.contains("cost") {
            scan_numeric(val, &mut found_any, &mut all_zero);
        }
    }
    match (found_any, all_zero) {
        (true, true) => ModelTier::Free,
        (true, false) => ModelTier::Paid,
        (false, _) => ModelTier::Unknown,
    }
}

/// Walks a JSON value, updating `found_any`/`all_zero` for every numeric leaf
/// (a JSON number, or a string that parses as one - some providers quote
/// their pricing values).
fn scan_numeric(v: &serde_json::Value, found_any: &mut bool, all_zero: &mut bool) {
    match v {
        serde_json::Value::Number(n) => {
            *found_any = true;
            if n.as_f64().unwrap_or(0.0) != 0.0 {
                *all_zero = false;
            }
        }
        serde_json::Value::String(s) => {
            if let Ok(f) = s.parse::<f64>() {
                *found_any = true;
                if f != 0.0 {
                    *all_zero = false;
                }
            }
        }
        serde_json::Value::Object(map) => {
            for val in map.values() {
                scan_numeric(val, found_any, all_zero);
            }
        }
        serde_json::Value::Array(arr) => {
            for val in arr {
                scan_numeric(val, found_any, all_zero);
            }
        }
        _ => {}
    }
}

// --- provider plan hint (a different kind of claim; see the module docs) ---

/// What plan the *credential* this machine holds for a provider is on, read
/// from `~/.llmkeys/registry.json`'s per-entry `tier` field.
///
/// Deliberately **not** [`ModelTier`]: there is no `Unknown` variant (absence
/// is modelled as `Option<ProviderPlanHint>`, so an unknown plan cannot be
/// pattern-matched as if it were a per-model tier claim), no `From`/`Into`
/// between the two, and the UI never renders the two with the same styling.
/// The registry's `"management"` tier maps to no hint at all - it is a
/// control-plane key, not a chat plan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderPlanHint {
    Free,
    Paid,
}

impl ProviderPlanHint {
    /// The plan hint's own label. Bracketed and word-suffixed so it can never
    /// be mistaken for [`ModelTier::label_suffix`]'s parenthesised per-model
    /// label at a glance.
    pub fn label(self) -> &'static str {
        match self {
            ProviderPlanHint::Free => "[free plan]",
            ProviderPlanHint::Paid => "[paid plan]",
        }
    }
}

/// One entry of `~/.llmkeys/registry.json`. Only the two fields UW reads are
/// declared; serde ignores the rest (`id`, `bucket`, `envVarName`, `notes`,
/// `added`), which are Phase 4's business, not Phase 3's.
#[derive(Debug, Clone, Deserialize)]
struct RegistryEntry {
    provider: String,
    tier: String,
}

/// `~/.llmkeys/registry.json` folded to one plan claim per provider.
///
/// A provider named by two credentials that disagree (the real file has
/// `groq` on both a free and a paid key) yields **no** hint: an ambiguous
/// claim is worse than none, the same principle `infer_tier` applies with
/// `Unknown`.
#[derive(Debug, Default, Clone)]
pub struct ProviderPlanRegistry {
    by_provider: BTreeMap<String, Option<ProviderPlanHint>>,
}

impl ProviderPlanRegistry {
    /// Parse the registry file's JSON text. Tolerates a UTF-8 BOM - the real
    /// file is written by PowerShell's `Out-File`, which emits one.
    pub fn from_json(text: &str) -> Result<Self, serde_json::Error> {
        let entries: Vec<RegistryEntry> = serde_json::from_str(text.trim_start_matches('\u{feff}'))?;
        let mut by_provider: BTreeMap<String, Option<ProviderPlanHint>> = BTreeMap::new();
        for e in entries {
            let hint = match e.tier.to_ascii_lowercase().as_str() {
                "free" => Some(ProviderPlanHint::Free),
                "paid" => Some(ProviderPlanHint::Paid),
                // "management" and anything unrecognised make no plan claim.
                _ => continue,
            };
            let provider = e.provider.to_ascii_lowercase();
            by_provider
                .entry(provider)
                .and_modify(|slot| {
                    if *slot != hint {
                        *slot = None; // conflicting credentials -> no claim
                    }
                })
                .or_insert(hint);
        }
        Ok(ProviderPlanRegistry { by_provider })
    }

    /// Read a registry file, keeping "there is no vault here" and "the vault
    /// is present but malformed" as *different* answers:
    ///
    ///   * `None` - unreadable/absent. An ordinary state (a fresh machine).
    ///   * `Some(Err(_))` - the file exists and does not parse. Never silently
    ///     equivalent to the above: a caller that substitutes stand-in data on
    ///     absence would otherwise present fabricated plan claims as this
    ///     machine's own, which is exactly the "an ambiguous claim is worse
    ///     than none" failure this module exists to avoid.
    ///   * `Some(Ok(_))` - a parsed registry.
    pub fn load_from(path: &std::path::Path) -> Option<Result<Self, serde_json::Error>> {
        let text = std::fs::read_to_string(path).ok()?;
        Some(Self::from_json(&text))
    }

    /// [`Self::load_from`] against the real vault path, `~/.llmkeys/registry.json`.
    pub fn load_default() -> Option<Result<Self, serde_json::Error>> {
        let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
        let path = std::path::Path::new(&home).join(".llmkeys").join("registry.json");
        Self::load_from(&path)
    }

    /// The plan claim for a provider, if the vault makes an unambiguous one.
    pub fn hint_for(&self, provider: &str) -> Option<ProviderPlanHint> {
        self.by_provider
            .get(&provider.to_ascii_lowercase())
            .copied()
            .flatten()
    }

    /// How many providers the registry makes an unambiguous claim about.
    pub fn claimed_providers(&self) -> usize {
        self.by_provider.values().filter(|v| v.is_some()).count()
    }
}

/// What a row should display in its tier column - the only type where a
/// per-model tier and a provider plan hint meet, and they stay in separate
/// variants so a renderer physically cannot style them identically by
/// accident.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TierLabel {
    /// A real per-model pricing claim.
    Model(ModelTier),
    /// No per-model signal; the vault's plan for this provider, shown as the
    /// weaker claim it is.
    Plan(ProviderPlanHint),
    /// Nothing is known and nothing is claimed.
    None,
}

/// Fallback ordering, per the plan: per-model pricing stays primary; the
/// registry's per-credential tier fills in *only* where `infer_tier` found no
/// model-level signal, and is never merged into the per-model claim.
pub fn resolve_label(tier: ModelTier, hint: Option<ProviderPlanHint>) -> TierLabel {
    match tier {
        ModelTier::Free | ModelTier::Paid => TierLabel::Model(tier),
        ModelTier::Unknown => match hint {
            Some(h) => TierLabel::Plan(h),
            None => TierLabel::None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- infer_tier: real shapes seen across ~25 providers this session ---
    //
    // Copied UNCHANGED from Maestro's harness/src/backend/discovery.rs test
    // module (assertions untouched; only the module path around them differs).
    // Their passing here is the port-fidelity proof.

    #[test]
    fn infer_tier_from_free_suffix_id() {
        let obj = serde_json::Map::new();
        // Colon convention: OpenRouter, ZenMux, Kilo.
        assert_eq!(
            infer_tier("google/gemma-4-26b-a4b-it:free", &obj),
            ModelTier::Free
        );
        // Hyphen convention: TokenRouter ("qwen/qwen3.8-max-free"), TeamoRouter.
        assert_eq!(infer_tier("qwen/qwen3.8-max-free", &obj), ModelTier::Free);
        // Slash convention: OrcaRouter's own "free" model is literally named
        // "orcarouter/free" - caught its id containing "free" but not the
        // suffix, so it rendered Unknown until this arm was added.
        assert_eq!(infer_tier("orcarouter/free", &obj), ModelTier::Free);
        assert_eq!(
            infer_tier("Model:FREE", &obj),
            ModelTier::Free,
            "case-insensitive"
        );
    }

    #[test]
    fn infer_tier_from_nested_object_pricing_with_string_numbers() {
        // AionLabs shape: {"pricing":{"prompt":"0.0000030000","completion":"0.0000060000"}}
        let obj: serde_json::Map<String, serde_json::Value> = serde_json::from_value(
            serde_json::json!({"pricing": {"prompt": "0.0000030000", "completion": "0.0000060000"}}),
        )
        .unwrap();
        assert_eq!(infer_tier("aion-labs/aion-3.0", &obj), ModelTier::Paid);
    }

    #[test]
    fn infer_tier_from_array_shaped_pricing() {
        // OrcaRouter shape: {"pricing":{"completion":[{"value":2.6,"unit":"perMTokens"}], ...}}
        let obj: serde_json::Map<String, serde_json::Value> = serde_json::from_value(
            serde_json::json!({"pricing": {"completion": [{"value": 2.6, "unit": "perMTokens"}]}}),
        )
        .unwrap();
        assert_eq!(infer_tier("mindai/macaron-v1-tall", &obj), ModelTier::Paid);
    }

    #[test]
    fn infer_tier_zero_pricing_is_free_not_unknown() {
        // Nscale/OpenRouter free-tier entries: real $0 pricing objects, no id suffix.
        let obj: serde_json::Map<String, serde_json::Value> =
            serde_json::from_value(serde_json::json!({"pricing": {"prompt": 0, "completion": 0}}))
                .unwrap();
        assert_eq!(infer_tier("some/zero-cost-model", &obj), ModelTier::Free);
    }

    #[test]
    fn infer_tier_unknown_when_nothing_price_shaped_present() {
        let obj: serde_json::Map<String, serde_json::Value> =
            serde_json::from_value(serde_json::json!({"context_length": 128000})).unwrap();
        assert_eq!(infer_tier("plain-model", &obj), ModelTier::Unknown);
    }

    // --- new: ProviderPlanHint, the deliberately-separate second claim ---

    /// Three real rows copied verbatim from `~/.llmkeys/registry.json`, plus
    /// the two `groq` rows that genuinely disagree in that file.
    const REGISTRY_SAMPLE: &str = r#"[
        {"id":"personal.routllm.free","provider":"routllm","bucket":"personal","tier":"free","envVarName":"LLM_PERSONAL_ROUTLLM_FREE","notes":"","added":"2026-08-19T18:58:32"},
        {"id":"personal.cerebras.paid","provider":"cerebras","bucket":"personal","tier":"paid","envVarName":"LLM_PERSONAL_CEREBRAS_PAID","notes":"","added":"2026-08-20T10:00:00"},
        {"id":"personal.zenmux.management","provider":"zenmux","bucket":"personal","tier":"management","envVarName":"LLM_PERSONAL_ZENMUX_MANAGEMENT","notes":"","added":"2026-08-20T10:00:00"},
        {"id":"personal.groq.free","provider":"groq","bucket":"personal","tier":"free","envVarName":"LLM_PERSONAL_GROQ_FREE","notes":"","added":"2026-08-19T21:00:00"},
        {"id":"sportsvector.groq.paid","provider":"groq","bucket":"sportsvector","tier":"paid","envVarName":"LLM_SPORTSVECTOR_GROQ_PAID","notes":"","added":"2026-08-20T09:00:00"}
    ]"#;

    fn sample() -> ProviderPlanRegistry {
        ProviderPlanRegistry::from_json(REGISTRY_SAMPLE).expect("sample registry parses")
    }

    #[test]
    fn registry_maps_free_and_paid_tiers_to_plan_hints() {
        let reg = sample();
        assert_eq!(reg.hint_for("routllm"), Some(ProviderPlanHint::Free));
        assert_eq!(reg.hint_for("cerebras"), Some(ProviderPlanHint::Paid));
        assert_eq!(reg.hint_for("CEREBRAS"), Some(ProviderPlanHint::Paid), "case-insensitive");
        assert_eq!(reg.hint_for("nobody"), None);
    }

    #[test]
    fn registry_makes_no_claim_for_management_keys_or_conflicting_ones() {
        let reg = sample();
        assert_eq!(
            reg.hint_for("zenmux"),
            None,
            "a management key is not a chat plan claim"
        );
        assert_eq!(
            reg.hint_for("groq"),
            None,
            "one free and one paid credential disagree - claim nothing"
        );
        assert_eq!(reg.claimed_providers(), 2);
    }

    #[test]
    fn registry_tolerates_a_utf8_bom() {
        let with_bom = format!("\u{feff}{REGISTRY_SAMPLE}");
        let reg = ProviderPlanRegistry::from_json(&with_bom).expect("BOM-prefixed registry parses");
        assert_eq!(reg.hint_for("routllm"), Some(ProviderPlanHint::Free));
    }

    /// A corrupt vault must not read as an absent one. Collapsing the two lets
    /// a caller quietly swap in stand-in data and present it as the user's own
    /// credentials - a fabricated claim, which is worse than no claim.
    #[test]
    fn an_absent_vault_and_a_corrupt_vault_are_different_answers() {
        let dir = std::env::temp_dir().join(format!(
            "uw-registry-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");

        let absent = dir.join("does-not-exist.json");
        assert!(
            ProviderPlanRegistry::load_from(&absent).is_none(),
            "no file at all reads as None"
        );

        let corrupt = dir.join("corrupt.json");
        std::fs::write(&corrupt, "{ this is not the registry ]").expect("write");
        let read = ProviderPlanRegistry::load_from(&corrupt);
        assert!(
            matches!(read, Some(Err(_))),
            "a present-but-unparseable vault must surface as an error, not as absence"
        );

        let good = dir.join("registry.json");
        std::fs::write(&good, REGISTRY_SAMPLE).expect("write");
        let reg = ProviderPlanRegistry::load_from(&good)
            .expect("present")
            .expect("parses");
        assert_eq!(reg.hint_for("routllm"), Some(ProviderPlanHint::Free));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plan_hint_fills_in_only_where_the_model_tier_is_unknown() {
        let reg = sample();
        let no_pricing = serde_json::Map::new();

        // routllm's model carries no pricing signal at all -> the vault's
        // per-credential plan fills in, as a *plan* claim.
        let tier = infer_tier("routllm/some-model", &no_pricing);
        assert_eq!(tier, ModelTier::Unknown);
        assert_eq!(
            resolve_label(tier, reg.hint_for("routllm")),
            TierLabel::Plan(ProviderPlanHint::Free)
        );

        // A model that DOES carry pricing keeps its own per-model claim even
        // though cerebras has a (contradicting) paid plan hint.
        let priced: serde_json::Map<String, serde_json::Value> =
            serde_json::from_value(serde_json::json!({"pricing": {"prompt": 0, "completion": 0}}))
                .unwrap();
        let tier = infer_tier("cerebras/zero-cost", &priced);
        assert_eq!(tier, ModelTier::Free);
        assert_eq!(
            resolve_label(tier, reg.hint_for("cerebras")),
            TierLabel::Model(ModelTier::Free),
            "per-model pricing stays primary; the plan hint must not override it"
        );

        // Unknown tier and no hint stays unlabelled.
        let tier = infer_tier("nobody/plain", &no_pricing);
        assert_eq!(resolve_label(tier, reg.hint_for("nobody")), TierLabel::None);
    }

    #[test]
    fn a_plan_hint_is_never_the_same_value_as_a_model_tier() {
        // The two claims are separate types with separate labels: a Free plan
        // hint and a Free model tier cannot compare equal or render alike.
        assert_ne!(
            TierLabel::Plan(ProviderPlanHint::Free),
            TierLabel::Model(ModelTier::Free)
        );
        assert_ne!(ProviderPlanHint::Free.label(), ModelTier::Free.label_suffix());
        assert_ne!(ProviderPlanHint::Paid.label(), ModelTier::Paid.label_suffix());
    }
}
