//! UltimateWrap (UW) - a standalone Rust TUI companion to Claude Code + CCR.
//!
//! Phase 3 of the UW plan: the crate scaffold plus the pieces ported out of
//! Maestro (`apps/tui` has no `[lib]` target and a Cargo dependency on
//! `harness` was costed and rejected, so both are copies, not dependencies):
//!
//!   * [`model_tier`] - `infer_tier` and `ModelTier`, verbatim from
//!     `harness/src/backend/discovery.rs`, plus the deliberately separate
//!     `ProviderPlanHint` fallback read from `~/.llmkeys/registry.json`.
//!   * [`credman`] - Windows Credential Manager reads, from
//!     `harness/src/backend/credential.rs`.
//!   * [`menu`] - `FilterList<T>` / `ModelMenu`, from
//!     `apps/tui/src/app/types.rs`.
//!   * [`ui`] - the two-level picker's rendering, from
//!     `apps/tui/src/ui/modals.rs`.
//!
//! [`http`] owns the one non-obvious wire-protocol requirement: the catalog
//! client's User-Agent must contain "claude". [`catalog`] turns a catalog
//! document into picker rows; [`fixture`] stands in for real captured CCR
//! data until Phase 0.5 locates it.
//!
//! This is a library so the Phase 4/5 work (keysync, live catalog reads) has
//! something to build on, and so the ported surface is a real public API
//! rather than half-used binary internals.

pub mod catalog;
pub mod credman;
pub mod fixture;
pub mod http;
pub mod menu;
pub mod model_tier;
pub mod ui;
