use ratatui::Terminal;
use ratatui::backend::TestBackend;
use uw::catalog::rows_from_json;
use uw::fixture::{FIXTURE_CATALOG, FIXTURE_REGISTRY};
use uw::menu::ModelMenu;
use uw::model_tier::ProviderPlanRegistry;
use uw::ui::render_model_menu;

#[test]
fn dump() {
    let reg = ProviderPlanRegistry::from_json(FIXTURE_REGISTRY).unwrap();
    let rows = rows_from_json(FIXTURE_CATALOG, Some(&reg)).unwrap();
    for (w, h, sel) in [(63u16, 15u16, 0usize), (63, 13, 0), (100, 20, 0)] {
        let mut menu = ModelMenu::new(rows.clone(), "");
        for _ in 0..sel { menu.move_by(1); }
        let mut t = Terminal::new(TestBackend::new(w, h)).unwrap();
        t.draw(|f| render_model_menu(f, f.area(), &menu, "")).unwrap();
        let b = t.backend().buffer().clone();
        println!("\n===== term {w}x{h} sel={sel} =====");
        for y in 0..b.area.height {
            let s: String = (0..b.area.width).map(|x| b[(x, y)].symbol()).collect();
            println!("|{}|", s.trim_end());
        }
    }
}
