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

## Changes from the original single-file PRD

This split incorporates findings from a study of Anthropic's Claude Code TUI (`/src/ink/`, `/src/components/`, `/src/hooks/`). The cheap-to-add, high-payoff additions are:

- **Bracketed paste + `isPasted` flag** in input handling — prevents one approval dialog per pasted line (§10-architecture, §20-implementation Phase 1).
- **`BaseTextInput` wrapper** around `ink-text-input` with viewport tracking and declared-cursor reporting (§10-architecture).
- **Runtime terminal capability discovery** via DA1-sentinel query batches — no timeouts, no false negatives (§10-architecture, §20-implementation Phase 1).
- **Markdown token-stream LRU cache** preserved when lifting the renderer — load-bearing for streamed responses (§10-architecture, §20-implementation Phase 3).
- **Per-phase frame telemetry** (renderer / diff / write / yoga timings + flicker context) for post-launch jank investigation (§10-architecture, §20-implementation Phase 1).
- **React Compiler** auto-memoization adopted in the build — recoups wasted re-renders in heavy lists with zero API changes (§20-implementation Phase 0).
- **TTY-gate relaxed** to `stdout.isTTY` only, with explicit `--print` mode. Fixes the `texra chat | tee` regression flagged in the original §13 caveat (§20-implementation Headless).
- **Approval pipeline** uses Promise-returning launchers over the typed queue — the queue is retained for concurrent subagent approvals, but call sites `await` a Promise rather than poll a discriminated union (§10-architecture Approvals).

New risks added in §30-reference: tmux/screen OSC 52 silent drop, selection-across-scrollback gap, React Compiler build dependency.
