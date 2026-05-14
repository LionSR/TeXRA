# PRD: TeXRA CLI Ink-based TUI

**Status:** Draft

Replace the `texra chat` plain-ANSI line renderer with an Ink-based TUI that mirrors the VS Code Progress View's component topology, reuses the workspace's existing markdown and syntax-highlighting pipelines, and lets a keyboard-only user drive multi-agent sessions with the same fidelity they get in the extension.

The headless path (`texra run`, `--print/-p`, `--output-format json|ndjson`, non-TTY, CI) is preserved. The new TUI runs only on an interactive terminal; when stdout is piped, chrome degrades to plain streaming text (see [20-implementation.md](./20-implementation.md#headless--legacy-preserved)).

## Document map

| Doc                                            | Contents                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [00-overview.md](./00-overview.md)             | Summary, problem statement, goals (G1–G6), non-goals.                                                  |
| [10-architecture.md](./10-architecture.md)     | Tech stack (locked), file topology, multi-agent state shape, approval pipeline, event → component map. |
| [20-implementation.md](./20-implementation.md) | Wheels to drop, headless & legacy preservation, six-phase migration plan, testing strategy.            |
| [30-reference.md](./30-reference.md)           | Keymap, webview parity table, risks (R1–R11), success criteria, source-file references.                |

## Provenance

Patterns adopted from a study of Anthropic's Claude Code TUI; source-file references in [30-reference § 18](./30-reference.md#18-references).
