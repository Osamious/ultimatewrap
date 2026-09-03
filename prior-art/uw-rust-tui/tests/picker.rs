//! End-to-end checks over the fixture catalog, driving the same
//! `ModelMenu` + `render_model_menu` pair the binary drives and asserting on
//! the rendered terminal buffer.
//!
//! This is the headless twin of `cargo run`: `cargo run` needs a real TTY, so
//! the acceptance criteria it demonstrates (two-level navigation, visually
//! distinct tier vs plan-hint labels, the Esc ladder, AND-token
//! search-as-you-type) are asserted here against real rendered cells.

use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::style::Color;

use uw::catalog::rows_from_json;
use uw::fixture::{FIXTURE_CATALOG, FIXTURE_REGISTRY};
use uw::menu::ModelMenu;
use uw::model_tier::ProviderPlanRegistry;
use uw::ui::render_model_menu;

fn open_menu() -> ModelMenu {
    let registry = ProviderPlanRegistry::from_json(FIXTURE_REGISTRY).expect("fixture registry");
    let rows = rows_from_json(FIXTURE_CATALOG, Some(&registry)).expect("fixture catalog");
    ModelMenu::new(rows, "")
}

fn open_menu_on(current_model: &str) -> ModelMenu {
    let registry = ProviderPlanRegistry::from_json(FIXTURE_REGISTRY).expect("fixture registry");
    let rows = rows_from_json(FIXTURE_CATALOG, Some(&registry)).expect("fixture catalog");
    ModelMenu::new(rows, current_model)
}

/// Render at an explicit terminal size and return the screen as lines of text.
fn screen_at(menu: &ModelMenu, w: u16, h: u16, current_model: &str) -> Vec<String> {
    let mut terminal = Terminal::new(TestBackend::new(w, h)).expect("test terminal");
    terminal
        .draw(|f| render_model_menu(f, f.area(), menu, current_model))
        .expect("draw");
    let buf = terminal.backend().buffer().clone();
    (0..buf.area.height)
        .map(|y| {
            (0..buf.area.width)
                .map(|x| buf[(x, y)].symbol())
                .collect::<String>()
                .trim_end()
                .to_string()
        })
        .collect()
}

/// Render once and return the screen as lines of text.
fn screen(menu: &ModelMenu) -> Vec<String> {
    screen_at(menu, 90, 26, "")
}

/// The foreground colours used on the row containing `needle`.
fn colors_on_row(menu: &ModelMenu, needle: &str) -> Vec<Color> {
    let mut terminal = Terminal::new(TestBackend::new(90, 26)).expect("test terminal");
    terminal
        .draw(|f| render_model_menu(f, f.area(), menu, ""))
        .expect("draw");
    let buf = terminal.backend().buffer().clone();
    for y in 0..buf.area.height {
        let text: String = (0..buf.area.width).map(|x| buf[(x, y)].symbol()).collect();
        if text.contains(needle) {
            return (0..buf.area.width).map(|x| buf[(x, y)].fg).collect();
        }
    }
    panic!("no rendered row contains {needle:?}");
}

fn contains(lines: &[String], needle: &str) -> bool {
    lines.iter().any(|l| l.contains(needle))
}

#[test]
fn level_one_lists_providers_with_counts_and_the_reserved_filter_header() {
    let menu = open_menu();
    let lines = screen(&menu);
    assert!(contains(&lines, "type to filter"), "{lines:#?}");
    assert!(contains(&lines, "cerebras  (2)"), "{lines:#?}");
    assert!(contains(&lines, "routllm  (2)"), "{lines:#?}");
    assert!(contains(&lines, "openrouter  (2)"), "{lines:#?}");
    // Providers are alphabetical, not catalog order.
    let providers: Vec<&String> = lines
        .iter()
        .filter(|l| l.contains("  (2)") || l.contains("  (1)"))
        .collect();
    let first = providers.first().expect("at least one provider row");
    assert!(first.contains("aion-labs"), "{providers:#?}");
}

#[test]
fn entering_a_provider_shows_only_its_models() {
    let mut menu = open_menu();
    menu.type_char('c');
    menu.type_char('e');
    menu.type_char('r');
    menu.enter();
    let lines = screen(&menu);
    assert!(contains(&lines, "model - cerebras"), "{lines:#?}");
    assert!(contains(&lines, "cerebras/llama-3.3-70b"), "{lines:#?}");
    assert!(contains(&lines, "cerebras/qwen-3-coder-480b"), "{lines:#?}");
    assert!(!contains(&lines, "aion-labs/aion-3.0"), "{lines:#?}");
}

#[test]
fn a_real_model_tier_and_a_provider_plan_hint_render_differently() {
    let mut menu = open_menu();
    // aion-labs: a real per-model paid claim from nested string pricing.
    menu.type_char('a');
    menu.type_char('i');
    menu.type_char('o');
    menu.enter();
    let priced = screen(&menu);
    assert!(contains(&priced, "(paid)"), "{priced:#?}");
    assert!(!contains(&priced, "[paid plan]"), "{priced:#?}");
    let priced_colors = colors_on_row(&menu, "aion-3.0");
    assert!(
        priced_colors.contains(&Color::Yellow),
        "a real paid tier is drawn in the tier colour"
    );

    // cerebras: no per-model pricing anywhere, so the vault's plan hint fills
    // in - bracketed, worded "plan", and dimmed.
    let mut menu = open_menu();
    menu.type_char('c');
    menu.type_char('e');
    menu.type_char('r');
    menu.enter();
    let hinted = screen(&menu);
    assert!(contains(&hinted, "[paid plan]"), "{hinted:#?}");
    assert!(!contains(&hinted, "(paid)"), "{hinted:#?}");
    let hint_colors = colors_on_row(&menu, "llama-3.3-70b");
    assert!(
        hint_colors.contains(&Color::DarkGray),
        "a plan hint is dimmed, not drawn in a tier colour"
    );
    assert!(
        !hint_colors.contains(&Color::Yellow),
        "a plan hint must never borrow the per-model paid colour"
    );
}

#[test]
fn and_token_search_narrows_across_provider_and_model_names() {
    let mut menu = open_menu();
    // Level 1 keys include every member model's label and id, so a model name
    // reaches its provider.
    for c in "grok".chars() {
        menu.type_char(c);
    }
    assert_eq!(menu.providers.visible_len(), 1);
    let lines = screen(&menu);
    assert!(contains(&lines, "filter: grok_"), "{lines:#?}");
    assert!(contains(&lines, "xai  (2)"), "{lines:#?}");

    // A second token ANDs; a token that matches nothing empties the view.
    // (`back()` at level 1 with a non-empty query is the Esc-ladder's own
    // clear, so it doubles as the reset here.)
    let mut menu = open_menu();
    for c in "xai fast".chars() {
        menu.type_char(c);
    }
    assert_eq!(menu.providers.visible_len(), 1);
    assert!(!menu.back());
    for c in "xai gemma".chars() {
        menu.type_char(c);
    }
    assert_eq!(menu.providers.visible_len(), 0);
    let lines = screen(&menu);
    assert!(contains(&lines, "no providers match"), "{lines:#?}");
}

#[test]
fn the_esc_ladder_runs_clear_query_then_leave_level_then_close() {
    let mut menu = open_menu();
    for c in "cer".chars() {
        menu.type_char(c);
    }
    menu.enter();
    assert!(menu.at_model_level());
    menu.type_char('q'); // filters within cerebras
    assert_eq!(menu.models.as_ref().unwrap().visible_len(), 1);

    assert!(!menu.back(), "1st esc clears the level-2 query");
    assert!(menu.at_model_level());
    assert_eq!(menu.models.as_ref().unwrap().visible_len(), 2);

    assert!(!menu.back(), "2nd esc leaves level 2");
    assert!(!menu.at_model_level());
    assert_eq!(menu.providers.query, "cer", "level 1 keeps its own query");

    assert!(!menu.back(), "3rd esc clears the level-1 query");
    assert!(menu.back(), "4th esc closes the menu");
}

/// The row-height budget must be measured the way the rows are *rendered* -
/// through `Paragraph::wrap`. Budgeting one terminal line per row overshoots on
/// a narrow terminal, and the overflow silently pushes the footer (and with it
/// the `[esc] back` affordance and the scroll note) past the modal's border.
#[test]
fn a_narrow_terminal_still_shows_the_footer_when_rows_wrap() {
    let mut menu = open_menu();
    for c in "cer".chars() {
        menu.type_char(c);
    }
    menu.enter();

    // 56 columns: the modal is ~39 wide, and
    // "Qwen 3 Coder 480B  (cerebras/qwen-3-coder-480b)  [paid plan]" is 60
    // characters, so every row here takes two terminal lines.
    let lines = screen_at(&menu, 56, 16, "");
    // The footer itself wraps at this width, so its tail is what proves it was
    // not clipped off the bottom.
    assert!(
        contains(&lines, "[esc]") && contains(&lines, "back"),
        "the footer must survive wrapped rows: {lines:#?}"
    );
    // Fewer rows fit than there are rows, so the scroll note has to say so -
    // and it has to be on screen too.
    assert!(
        contains(&lines, "of 2)"),
        "the scroll note must survive too: {lines:#?}"
    );
    // And the rows it did make room for are still drawn.
    assert!(
        lines.iter().any(|l| l.contains("cerebras/")),
        "{lines:#?}"
    );
}

/// The fixture has more providers than a short terminal can show, so the
/// "(x-y of n)" note must appear and the window must follow the cursor.
#[test]
fn a_short_terminal_scrolls_and_says_so() {
    let mut menu = open_menu();
    let lines = screen_at(&menu, 90, 14, "");
    let note = lines
        .iter()
        .find(|l| l.contains(" of 10)"))
        .unwrap_or_else(|| panic!("no scroll note rendered: {lines:#?}"));
    assert!(note.contains("(1-"), "the window starts at the top: {note}");

    // Walk the cursor past the fold; the window must follow it.
    let visible = menu.providers.visible_len();
    assert_eq!(visible, 10);
    for _ in 0..visible - 1 {
        menu.move_by(1);
    }
    let lines = screen_at(&menu, 90, 14, "");
    let note = lines
        .iter()
        .find(|l| l.contains(" of 10)"))
        .unwrap_or_else(|| panic!("no scroll note rendered: {lines:#?}"));
    assert!(note.contains("-10 of 10)"), "the window tracks the cursor: {note}");
    assert!(
        contains(&lines, "xai  (2)"),
        "the row under the cursor is on screen: {lines:#?}"
    );
    assert!(
        !contains(&lines, "aion-labs  ("),
        "and the top of the list has scrolled off: {lines:#?}"
    );
}

/// The session's current model marks exactly one row per level, and the picker
/// opens with the cursor already on it.
#[test]
fn the_current_model_is_marked_once_per_level_and_holds_the_cursor() {
    const CURRENT: &str = "cerebras/qwen-3-coder-480b";
    let mut menu = open_menu_on(CURRENT);

    // Level 1: the cursor sits on the owning group, and only that group is
    // marked.
    let selected = menu
        .providers
        .selected_row()
        .expect("a group under the cursor");
    assert_eq!(selected.provider, "cerebras");
    assert_eq!(
        menu.providers
            .rows()
            .iter()
            .filter(|g| g.is_current)
            .count(),
        1
    );
    // 120 columns so no row wraps and a marker cannot land on a continuation
    // line - the marker's *placement* is what is under test here.
    let lines = screen_at(&menu, 120, 26, CURRENT);
    assert_eq!(
        lines.concat().matches('*').count(),
        1,
        "exactly one marker on screen: {lines:#?}"
    );
    let marked = lines
        .iter()
        .find(|l| l.contains('*'))
        .unwrap_or_else(|| panic!("{lines:#?}"));
    assert!(marked.contains("cerebras  (2)"), "{lines:#?}");

    // Level 2: the marker moves to the model itself, and again only one row
    // carries it.
    menu.enter();
    let lines = screen_at(&menu, 120, 26, CURRENT);
    assert_eq!(
        lines.concat().matches('*').count(),
        1,
        "exactly one marker on screen: {lines:#?}"
    );
    let marked = lines
        .iter()
        .find(|l| l.contains('*'))
        .unwrap_or_else(|| panic!("{lines:#?}"));
    assert!(marked.contains(CURRENT), "{lines:#?}");
    assert!(
        !marked.contains("llama-3.3-70b"),
        "the sibling model is unmarked: {lines:#?}"
    );
}

/// The real-world shape (`~/.llmkeys/registry.json`'s `groq`, and the
/// fixture's `chutes`): a provider whose models are part priced, part not.
/// No aggregate per-model claim is honest there, so the group must fall back
/// to the vault's weaker plan claim instead of asserting a tier.
#[test]
fn a_group_mixing_paid_and_unknown_models_shows_a_plan_hint_not_a_tier() {
    let menu = open_menu();
    let lines = screen_at(&menu, 90, 26, "");
    let row = lines
        .iter()
        .find(|l| l.contains("chutes  (2)"))
        .unwrap_or_else(|| panic!("no chutes group row: {lines:#?}"));
    assert!(
        row.contains("[paid plan]"),
        "a mixed group falls back to the plan hint: {row}"
    );
    assert!(
        !row.contains("(paid)") && !row.contains("(free available)"),
        "and must not claim an aggregate tier it does not have: {row}"
    );

    // The weaker claim is dimmed at level 1 too, never a tier colour.
    let colors = colors_on_row(&menu, "chutes  (2)");
    assert!(colors.contains(&Color::DarkGray));
    assert!(
        !colors.contains(&Color::Yellow) && !colors.contains(&Color::Green),
        "a plan hint must never borrow a per-model tier colour"
    );

    // Drilling in, the priced member keeps its own per-model claim and the
    // unpriced one falls back - the two claims stay visibly different.
    let mut menu = open_menu();
    for c in "chutes".chars() {
        menu.type_char(c);
    }
    menu.enter();
    let lines = screen_at(&menu, 90, 26, "");
    let priced = lines
        .iter()
        .find(|l| l.contains("chutes/deepseek-v3"))
        .unwrap_or_else(|| panic!("{lines:#?}"));
    assert!(priced.contains("(paid)") && !priced.contains("[paid plan]"), "{priced}");
    let unpriced = lines
        .iter()
        .find(|l| l.contains("chutes/mystery-model"))
        .unwrap_or_else(|| panic!("{lines:#?}"));
    assert!(unpriced.contains("[paid plan]"), "{unpriced}");
}

#[test]
fn selecting_a_model_commits_the_catalog_id() {
    let mut menu = open_menu();
    for c in "xai".chars() {
        menu.type_char(c);
    }
    menu.enter();
    menu.move_by(1);
    let picked = menu.selected_row().expect("a model under the cursor");
    assert_eq!(picked.provider, "xai");
    assert!(picked.model.starts_with("xai/grok-4-fast"));
}
