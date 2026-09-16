# UltimateWrap (UW)

A local gateway and model-routing layer that lets [Claude Code](https://claude.com/claude-code) work
through any provider's API key — the Anthropic subscription relay plus dozens of third-party model
providers — through a local [CCR](https://github.com/musistudio/claude-code-router) gateway, with the
active model picked from inside Claude Code itself instead of hand-edited config files.

## What it does

Three pieces, each with one job:

| Piece | Job |
|---|---|
| **Key vault** | Every API key, which provider it belongs to, and how to call that provider. Lives outside the repo, never committed. |
| **`keysync`** | Reads the vault plus a model catalogue, builds CCR's provider config and Claude Code's model-picker list, and applies both. |
| **`menu`** | A terminal picker that opens inside Claude Code's model-switch handoff, reads a pre-built snapshot, and writes back the chosen model. |

## Design choices

- **Secrets never touch a config file or this repository.** Key values live encrypted in the host
  OS credential store; the JSON files UW reads and writes carry only provider metadata (IDs, base
  URLs, protocol type), never key material.
- **A build cannot reach the live environment by accident.** The sync pipeline supports a dry run
  (build and validate, write nothing), an isolated target (apply to a throwaway instance that is
  safe to break), and an explicit live target that requires an extra confirmation flag before it
  touches the real gateway or Claude Code's own settings file.

## Status

Personal tool, actively developed. Interfaces and internal layout are still moving.

## License

MIT — see [LICENSE](LICENSE).
