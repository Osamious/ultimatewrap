//! End-to-end reachability: does the "(x-y of n)" note ever claim more rows
//! than the picker actually drew, at REALISTIC terminal sizes?

use ratatui::Terminal;
use ratatui::backend::TestBackend;
use uw::catalog::rows_from_json;
use uw::fixture::{FIXTURE_CATALOG, FIXTURE_REGISTRY};
use uw::menu::ModelMenu;
use uw::model_tier::ProviderPlanRegistry;
use uw::ui::render_model_menu;

const PROVIDERS: [&str; 10] = [
    "aion-labs", "cerebras", "chutes", "nscale", "openrouter", "orcarouter",
    "plainprovider", "routllm", "tokenrouter", "xai",
];

fn screen(menu: &ModelMenu, w: u16, h: u16) -> Vec<String> {
    let mut t = Terminal::new(TestBackend::new(w, h)).unwrap();
    t.draw(|f| render_model_menu(f, f.area(), menu, "")).unwrap();
    let b = t.backend().buffer().clone();
    (0..b.area.height)
        .map(|y| (0..b.area.width).map(|x| b[(x, y)].symbol()).collect::<String>())
        .collect()
}

#[test]
fn note_matches_rows_drawn_at_realistic_sizes() {
    let reg = ProviderPlanRegistry::from_json(FIXTURE_REGISTRY).unwrap();
    let rows = rows_from_json(FIXTURE_CATALOG, Some(&reg)).unwrap();
    let mut bad: Vec<String> = Vec::new();
    let mut checked = 0;
    for w in 40u16..=140 {
        for h in 8u16..=40 {
            for sel in [0usize, 4, 9] {
                let mut menu = ModelMenu::new(rows.clone(), "");
                for _ in 0..sel { menu.move_by(1); }
                let lines = screen(&menu, w, h);
                let all = lines.join("\n");
                let Some(i) = all.find(" of 10)") else { continue };
                let pre = &all[..i];
                let Some(open) = pre.rfind('(') else { continue };
                let range = &pre[open + 1..];
                let Some((a, b)) = range.split_once('-') else { continue };
                let (Ok(a), Ok(b)) = (a.parse::<usize>(), b.parse::<usize>()) else { continue };
                let claimed = b - a + 1;
                let drawn = PROVIDERS.iter().filter(|p| all.contains(&format!("{p}  ("))).count();
                checked += 1;
                if claimed != drawn {
                    bad.push(format!("term {w}x{h} sel={sel}: note says {claimed} rows ({a}-{b}), drew {drawn}"));
                }
            }
        }
    }
    assert!(checked > 100, "probe was vacuous: only {checked} cases had a note");
    assert!(
        bad.is_empty(),
        "{}/{} disagreements, first 20:\n{}",
        bad.len(), checked,
        bad.iter().take(20).cloned().collect::<Vec<_>>().join("\n")
    );
}
