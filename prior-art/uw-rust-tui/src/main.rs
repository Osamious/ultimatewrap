//! UltimateWrap (UW) - Phase 3 scaffold.
//!
//! Runs the two-level provider -> model picker over a hand-authored fixture
//! catalog. There is no CCR integration in this phase (see
//! `src/fixture.rs`'s `TODO(phase-0.5)`); selecting a model prints it and
//! exits.
//!
//! Keys: up/down (or j/k via arrows only - typing filters), enter to open a
//! provider / commit a model, backspace to edit the filter, esc for the
//! ladder (clear query -> leave the model level -> close), ctrl-c to abort.

use std::io;

use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use crossterm::{ExecutableCommand, execute};
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;

use uw::menu::{ModelChoice, ModelMenu};
use uw::model_tier::ProviderPlanRegistry;
use uw::{catalog, fixture, ui};

fn main() -> io::Result<()> {
    // The real vault when it exists, the fixture subset when there is no vault
    // at all, so a machine without `~/.llmkeys` still demonstrates the fallback
    // path. A vault that exists but does not parse gets NEITHER: substituting
    // the fixture there would show this user fabricated plan claims about
    // providers they may not even hold keys for, dressed as their own data.
    // Warn and claim nothing instead.
    let registry = match ProviderPlanRegistry::load_default() {
        Some(Ok(r)) => r,
        Some(Err(e)) => {
            eprintln!(
                "uw: ~/.llmkeys/registry.json exists but could not be parsed ({e}); \
                 continuing with no provider plan hints"
            );
            ProviderPlanRegistry::default()
        }
        None => ProviderPlanRegistry::from_json(fixture::FIXTURE_REGISTRY)
            .expect("the embedded fixture registry is valid JSON"),
    };
    let rows = catalog::rows_from_json(fixture::FIXTURE_CATALOG, Some(&registry))
        .map_err(io::Error::other)?;

    match run(rows)? {
        Some(c) => println!("selected: {} ({}) from {}", c.label, c.model, c.provider),
        None => println!("no selection"),
    }
    Ok(())
}

/// Draw the picker until the user commits a model or closes the menu.
fn run(rows: Vec<ModelChoice>) -> io::Result<Option<ModelChoice>> {
    let mut menu = ModelMenu::new(rows, "");

    enable_raw_mode()?;
    let mut stdout = io::stdout();
    stdout.execute(EnterAlternateScreen)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout))?;

    let outcome = event_loop(&mut terminal, &mut menu);

    // Restore the terminal before propagating any error from the loop, so a
    // failure mid-draw cannot leave the user in raw mode.
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    outcome
}

fn event_loop(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    menu: &mut ModelMenu,
) -> io::Result<Option<ModelChoice>> {
    loop {
        terminal.draw(|f| ui::render_model_menu(f, f.area(), menu, ""))?;

        let Event::Key(key) = event::read()? else {
            continue;
        };
        // Windows reports both press and release; acting on both would apply
        // every keystroke twice.
        if key.kind != KeyEventKind::Press {
            continue;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            return Ok(None);
        }
        match key.code {
            KeyCode::Up => menu.move_by(-1),
            KeyCode::Down => menu.move_by(1),
            KeyCode::Enter => {
                if menu.at_model_level() {
                    if let Some(c) = menu.selected_row() {
                        return Ok(Some(c.clone()));
                    }
                } else {
                    menu.enter();
                }
            }
            KeyCode::Esc => {
                if menu.back() {
                    return Ok(None);
                }
            }
            KeyCode::Backspace => menu.backspace(),
            KeyCode::Char(c) => menu.type_char(c),
            _ => {}
        }
    }
}
