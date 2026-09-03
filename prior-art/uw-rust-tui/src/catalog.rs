//! Turning a catalog document into picker rows.
//!
//! The document shape mirrors CCR's Anthropic-branch `/v1/models` response
//! (`{data: [...], first_id, has_more, last_id}` - see `crate::http`), with
//! each entry's unrecognised keys handed to `infer_tier` verbatim, because
//! providers put pricing under a dozen different names and nesting depths.

use serde::Deserialize;

use crate::menu::ModelChoice;
use crate::model_tier::{ProviderPlanRegistry, infer_tier};

/// One catalog entry. `rest` collects every key the struct does not name -
/// that is what carries `pricing` / `cost` / `price_per_token` / ... in
/// whatever shape the upstream provider chose.
#[derive(Debug, Deserialize)]
struct CatalogEntry {
    id: String,
    #[serde(default)]
    display_name: Option<String>,
    /// The grouping key. When the document omits it, the segment before the
    /// first `/` in `id` is used - CCR's route ids are `provider/model`-shaped.
    #[serde(default)]
    provider: Option<String>,
    #[serde(flatten)]
    rest: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct CatalogDoc {
    data: Vec<CatalogEntry>,
}

/// Parse a catalog document into picker rows, attaching each row's per-model
/// tier and - separately - its provider's plan hint from the vault registry.
///
/// The two claims are attached independently here and stay independent all the
/// way to the renderer; `model_tier::resolve_label` is the only thing that
/// decides which one is shown.
pub fn rows_from_json(
    text: &str,
    registry: Option<&ProviderPlanRegistry>,
) -> Result<Vec<ModelChoice>, serde_json::Error> {
    let doc: CatalogDoc = serde_json::from_str(text.trim_start_matches('\u{feff}'))?;
    Ok(doc
        .data
        .into_iter()
        .map(|e| {
            let provider = e.provider.unwrap_or_else(|| {
                e.id.split_once('/')
                    .map(|(p, _)| p.to_string())
                    .unwrap_or_else(|| e.id.clone())
            });
            let tier = infer_tier(&e.id, &e.rest);
            // Attached unconditionally: every row of a provider carries that
            // provider's plan claim, whether or not the row also has a
            // per-model one. `model_tier::resolve_label` is the single place
            // that decides which of the two is *shown* (and it already gates
            // the hint on `ModelTier::Unknown`), so gating a second time here
            // would only make the stored value depend on the row - and then a
            // group's hint would depend on which of its rows came first in the
            // catalog.
            let plan_hint = registry.and_then(|r| r.hint_for(&provider));
            ModelChoice {
                label: e.display_name.clone().unwrap_or_else(|| e.id.clone()),
                model: e.id,
                provider,
                tier,
                plan_hint,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::rows_from_json;
    use crate::fixture::{FIXTURE_CATALOG, FIXTURE_REGISTRY};
    use crate::model_tier::{ModelTier, ProviderPlanHint, ProviderPlanRegistry, TierLabel, resolve_label};

    fn rows() -> Vec<crate::menu::ModelChoice> {
        let reg = ProviderPlanRegistry::from_json(FIXTURE_REGISTRY).expect("fixture registry");
        rows_from_json(FIXTURE_CATALOG, Some(&reg)).expect("fixture catalog")
    }

    fn find<'a>(rows: &'a [crate::menu::ModelChoice], id: &str) -> &'a crate::menu::ModelChoice {
        rows.iter().find(|r| r.model == id).expect("row present")
    }

    #[test]
    fn fixture_covers_every_infer_tier_shape() {
        let rows = rows();
        assert_eq!(find(&rows, "google/gemma-4-26b-a4b-it:free").tier, ModelTier::Free);
        assert_eq!(find(&rows, "tokenrouter/qwen3.8-max-free").tier, ModelTier::Free);
        assert_eq!(find(&rows, "orcarouter/free").tier, ModelTier::Free);
        assert_eq!(find(&rows, "aion-labs/aion-3.0").tier, ModelTier::Paid);
        assert_eq!(find(&rows, "mindai/macaron-v1-tall").tier, ModelTier::Paid);
        assert_eq!(find(&rows, "nscale/zero-cost-model").tier, ModelTier::Free);
        assert_eq!(find(&rows, "plainprovider/plain-model").tier, ModelTier::Unknown);
    }

    #[test]
    fn provider_defaults_to_the_id_prefix() {
        let rows = rows();
        assert_eq!(find(&rows, "aion-labs/aion-3.0").provider, "aion-labs");
    }

    #[test]
    fn plan_hint_attaches_only_to_rows_with_no_model_pricing_signal() {
        let rows = rows();

        // routllm / cerebras / xai entries carry no pricing signal at all, so
        // the vault's per-credential plan is the only thing left to say.
        let r = find(&rows, "routllm/auto");
        assert_eq!(r.tier, ModelTier::Unknown);
        assert_eq!(r.plan_hint, Some(ProviderPlanHint::Free));
        assert_eq!(
            resolve_label(r.tier, r.plan_hint),
            TierLabel::Plan(ProviderPlanHint::Free)
        );

        let c = find(&rows, "cerebras/llama-3.3-70b");
        assert_eq!(c.plan_hint, Some(ProviderPlanHint::Paid));
        let x = find(&rows, "xai/grok-4-fast");
        assert_eq!(x.plan_hint, Some(ProviderPlanHint::Paid));

        // A priced row from a provider the vault says nothing about has no
        // hint to carry in the first place.
        let priced = find(&rows, "aion-labs/aion-3.0");
        assert_eq!(priced.plan_hint, None);

        // A priced row from a provider the vault DOES claim still carries the
        // hint - the row is not where the decision is made - but resolves to
        // its own per-model claim, which is where the decision is made.
        let both = find(&rows, "chutes/deepseek-v3");
        assert_eq!(both.tier, ModelTier::Paid);
        assert_eq!(both.plan_hint, Some(ProviderPlanHint::Paid));
        assert_eq!(
            resolve_label(both.tier, both.plan_hint),
            TierLabel::Model(ModelTier::Paid),
            "per-model pricing stays primary even with a hint present on the row"
        );

        // A provider the vault says nothing about stays unlabelled.
        let plain = find(&rows, "plainprovider/plain-model");
        assert_eq!(plain.plan_hint, None);
        assert_eq!(resolve_label(plain.tier, plain.plan_hint), TierLabel::None);
    }

    /// A group's plan hint is read off one arbitrary member, so every member
    /// must carry it - otherwise the hint a provider shows depends on which of
    /// its models the catalog happened to list first, which is precisely what
    /// `ProviderChoice::group`'s doc comment promises cannot happen.
    #[test]
    fn a_groups_plan_hint_does_not_depend_on_catalog_order() {
        let reg = ProviderPlanRegistry::from_json(FIXTURE_REGISTRY).expect("fixture registry");

        // The same two chutes models - one priced, one not - in both orders.
        let priced = r#"{ "id": "chutes/deepseek-v3", "display_name": "DeepSeek V3",
              "pricing": { "prompt": "0.0000002700", "completion": "0.0000011000" } }"#;
        let unpriced =
            r#"{ "id": "chutes/mystery-model", "display_name": "Chutes Mystery Model" }"#;
        let doc = |a: &str, b: &str| format!(r#"{{ "data": [ {a}, {b} ] }}"#);

        let hint_of = |text: &str| {
            let rows = rows_from_json(text, Some(&reg)).expect("catalog");
            let groups = crate::menu::ProviderChoice::group(&rows, "");
            assert_eq!(groups.len(), 1, "both rows are one provider");
            groups[0].plan_hint
        };

        assert_eq!(
            hint_of(&doc(priced, unpriced)),
            hint_of(&doc(unpriced, priced)),
            "the group's plan hint must not depend on which model came first"
        );
        assert_eq!(
            hint_of(&doc(priced, unpriced)),
            Some(ProviderPlanHint::Paid)
        );
    }

    /// Two spellings of one provider are one provider. Grouping used to key on
    /// the raw string while the sort and the vault lookup both lowercased.
    #[test]
    fn providers_differing_only_in_case_are_one_group() {
        let reg = ProviderPlanRegistry::from_json(FIXTURE_REGISTRY).expect("fixture registry");
        let doc = r#"{ "data": [
            { "id": "a", "provider": "Chutes", "display_name": "A" },
            { "id": "b", "provider": "chutes", "display_name": "B" },
            { "id": "c", "provider": "CHUTES", "display_name": "C" }
        ] }"#;
        let rows = rows_from_json(doc, Some(&reg)).expect("catalog");
        let groups = crate::menu::ProviderChoice::group(&rows, "");
        assert_eq!(groups.len(), 1, "{groups:#?}");
        assert_eq!(groups[0].model_idx.len(), 3);
        assert_eq!(
            groups[0].plan_hint,
            Some(ProviderPlanHint::Paid),
            "all three spellings resolve to the same vault entry"
        );
    }

    /// A document shaped exactly like CCR's real `/v1/models` response.
    ///
    /// Fields are the seven `createClaudeAppGatewayModelsResponse` emits
    /// (`packages/core/src/gateway/features/model-discovery.ts`): there is no
    /// `provider` key and no price/cost key anywhere. Non-native models appear
    /// under `anthropic/claude-ccr-h<hex>` (`CLAUDE_APP_ENCODED_ROUTE_PREFIX`,
    /// `packages/core/src/agents/claude-app/gateway-routes.ts`); the two hex
    /// blobs below decode to `groq/llama-3.3-70b-versatile` and
    /// `cerebras/qwen-3-coder-480b`. (Anthropic-native models additionally
    /// appear under their own plain `claude-*` ids; they are left out here so
    /// the encoded-route collapse is the only thing the test measures.)
    const REAL_CCR_SHAPED_DOC: &str = r#"{
      "data": [
        { "id": "anthropic/claude-ccr-h67726f712f6c6c616d612d332e332d3730622d766572736174696c65",
          "capabilities": { "max_input_tokens": 131072 }, "created_at": "1970-01-01T00:00:00Z",
          "display_name": "Llama 3.3 70B Versatile", "max_input_tokens": 131072,
          "max_tokens": 32768, "type": "model" },
        { "id": "anthropic/claude-ccr-h63657265627261732f7177656e2d332d636f6465722d34383062",
          "capabilities": { "max_input_tokens": 131072 }, "created_at": "1970-01-01T00:00:00Z",
          "display_name": "Qwen 3 Coder 480B", "max_input_tokens": 131072,
          "max_tokens": 32768, "type": "model" }
      ],
      "first_id": "anthropic/claude-ccr-h67726f712f6c6c616d612d332e332d3730622d766572736174696c65",
      "has_more": false,
      "last_id": "anthropic/claude-ccr-h63657265627261732f7177656e2d332d636f6465722d34383062"
    }"#;

    /// KNOWN, TRACKED GAP - not a passing-by-accident test, and not a bug to
    /// fix here.
    ///
    /// Against real CCR data this parser produces one bogus `anthropic` group
    /// with every tier `Unknown`: the encoded route id contains a `/`, so the
    /// `id.split_once('/')` provider fallback fires and yields the literal
    /// `"anthropic"` for every non-native model, and no entry carries pricing
    /// for `infer_tier` to read. Recovering the real provider needs the
    /// inverse of `encodeClaudeAppGatewayRouteModel` (reference:
    /// `decodeClaudeAppGatewayRouteId`, `gateway-routes.ts:319`), and pricing
    /// must come from whatever source Phase 0.5.B.3 identifies. Both are
    /// deferred to Phase 5 by the plan; this test pins today's behaviour so
    /// that phase inherits the finding instead of rediscovering it.
    #[test]
    #[ignore = "known Phase 5 gap: CCR route ids need hex-decoding and carry no pricing"]
    fn real_ccr_shaped_catalog_collapses_into_one_bogus_group() {
        let reg = ProviderPlanRegistry::from_json(FIXTURE_REGISTRY).expect("fixture registry");
        let rows = rows_from_json(REAL_CCR_SHAPED_DOC, Some(&reg)).expect("real-shaped catalog");

        assert!(
            rows.iter().all(|r| r.tier == ModelTier::Unknown),
            "no entry carries pricing, so infer_tier can only say Unknown"
        );

        assert!(
            rows.iter().all(|r| r.provider == "anthropic"),
            "every encoded route collapses to the literal id prefix, losing groq/cerebras"
        );

        let groups = crate::menu::ProviderChoice::group(&rows, "");
        assert_eq!(
            groups.len(),
            1,
            "two different real providers become one bogus \"anthropic\" group"
        );
        assert_eq!(groups[0].provider, "anthropic");
        assert_eq!(
            groups[0].tier, None,
            "and it can make no aggregate claim either"
        );
    }
}
