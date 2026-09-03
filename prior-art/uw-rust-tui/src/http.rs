//! The shared blocking HTTP client used for every CCR read.
//!
//! The User-Agent is not cosmetic and must not be "cleaned up" to something
//! generic. CCR's gateway branches its `/v1/models` response shape on
//! `isClaudeCodeUserAgent` (`model-discovery.ts:982-989`), a case-insensitive
//! substring match on "claude". Only the matching branch returns the
//! Anthropic-shaped `{data, first_id, has_more, last_id}` body, and only that
//! branch ever includes the 1M-context (`[1m]`) model variants, which are
//! gated on `options.claudeCode: true` (`model-discovery.ts:318-320`). A
//! non-"claude" User-Agent silently yields a smaller catalog.

/// Sent as `User-Agent` on every request. MUST contain "claude" (any case).
pub const USER_AGENT: &str = "uw/0.1 (claude-code-compatible)";

/// Build the blocking client UW uses to read CCR's catalog.
///
/// TODO(phase-0.5): nothing calls the network yet - the catalog endpoint and
/// its auth key are established in Phase 0.5/2. This exists now so the
/// User-Agent contract above has exactly one owner when that lands.
pub fn client() -> reqwest::Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .build()
}

#[cfg(test)]
mod tests {
    use super::{USER_AGENT, client};

    #[test]
    fn user_agent_matches_ccrs_claude_code_branch() {
        assert!(
            USER_AGENT.to_ascii_lowercase().contains("claude"),
            "a non-claude UA gets the OpenAI-shaped catalog, which omits [1m] variants"
        );
    }

    #[test]
    fn client_builds() {
        assert!(client().is_ok());
    }
}
