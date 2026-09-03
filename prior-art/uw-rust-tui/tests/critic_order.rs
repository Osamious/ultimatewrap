//! Independent re-run of the "two orderings" proof, stronger than the crate's own:
//! every permutation-ish rotation of the full fixture catalog must yield
//! identical (provider -> plan_hint, tier) results.

use uw::catalog::rows_from_json;
use uw::fixture::{FIXTURE_CATALOG, FIXTURE_REGISTRY};
use uw::menu::ProviderChoice;
use uw::model_tier::ProviderPlanRegistry;

fn reg() -> ProviderPlanRegistry {
    ProviderPlanRegistry::from_json(FIXTURE_REGISTRY).unwrap()
}

/// Pull the fixture's entries apart and rebuild the doc in an arbitrary order.
fn entries() -> Vec<serde_json::Value> {
    let v: serde_json::Value = serde_json::from_str(FIXTURE_CATALOG).unwrap();
    v["data"].as_array().unwrap().clone()
}

fn fingerprint(order: &[serde_json::Value]) -> Vec<(String, String, String)> {
    let doc = serde_json::json!({ "data": order }).to_string();
    let rows = rows_from_json(&doc, Some(&reg())).unwrap();
    let mut groups = ProviderChoice::group(&rows, "");
    groups.sort_by_key(|g| g.provider.to_lowercase());
    groups
        .iter()
        .map(|g| {
            (
                g.provider.to_lowercase(),
                format!("{:?}", g.plan_hint),
                format!("{:?}", g.tier),
            )
        })
        .collect()
}

#[test]
fn every_rotation_and_reversal_of_the_fixture_gives_identical_groups() {
    let base = entries();
    let expected = fingerprint(&base);
    let n = base.len();

    // all rotations
    for k in 0..n {
        let mut o = base.clone();
        o.rotate_left(k);
        assert_eq!(fingerprint(&o), expected, "rotation by {k} changed the result");
        o.reverse();
        assert_eq!(fingerprint(&o), expected, "reversed rotation by {k} changed the result");
    }

    // deterministic pseudo-shuffles
    for seed in 1u64..200 {
        let mut o = base.clone();
        let mut s = seed;
        for i in (1..n).rev() {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let j = (s >> 33) as usize % (i + 1);
            o.swap(i, j);
        }
        assert_eq!(fingerprint(&o), expected, "shuffle seed {seed} changed the result");
    }

    // and the mixed Paid+Unknown group really is present and hinted
    let chutes = expected.iter().find(|(p, _, _)| p == "chutes").expect("chutes group");
    assert_eq!(chutes.1, "Some(Paid)", "mixed group carries the plan hint");
    assert_eq!(chutes.2, "None", "mixed group makes no aggregate tier claim");
}

/// The invariant `ProviderChoice::group`'s doc comment now relies on:
/// every row of a provider carries that provider's hint.
#[test]
fn rows_from_json_gives_every_member_of_a_provider_the_same_hint() {
    let rows = rows_from_json(FIXTURE_CATALOG, Some(&reg())).unwrap();
    let mut seen: std::collections::HashMap<String, Option<String>> = Default::default();
    for r in &rows {
        let k = r.provider.to_lowercase();
        let h = r.plan_hint.map(|h| format!("{h:?}"));
        match seen.get(&k) {
            Some(prev) => assert_eq!(prev, &h, "provider {k} has rows with disagreeing hints"),
            None => {
                seen.insert(k, h);
            }
        }
    }
    // and the invariant is non-vacuous: at least one provider is hinted AND
    // has a row whose tier is not Unknown.
    let interesting = rows.iter().any(|r| {
        r.plan_hint.is_some() && r.tier != uw::model_tier::ModelTier::Unknown
    });
    assert!(interesting, "fixture no longer exercises hint-on-a-priced-row");
}
