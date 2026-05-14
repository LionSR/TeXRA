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

A second focused TUI sweep added five more patterns to the PRD:

- **Terminal notifications** (§10-architecture) — OSC 9 / OSC 99 / BEL / OSC 9;4 progress, capability-gated, idle-and-unfocus-gated. So a 3-subagent run that finishes while the user is in another tmux window doesn't go silent.
- **Transcript search** (§10-architecture, `Ctrl-F` in §30-reference) — substring + fuzzy fallback with a non-overlapping SGR 7 inverse overlay and `codeUnitToCell` wide-char mapping (the details that prevent rendering corruption on CJK / emoji content).
- **Agent-status tree rendering** (§10-architecture event map, `<SubagentList>` row) — `├─` / `└─` tree characters with inline status text and a single 1 s tick on the list (not per-row) for elapsed-time updates.
- **Diff truncation with `Ctrl-O` expand** (§10-architecture, `<EditApproval>`) — cap diffs at 400 lines with an explicit expand affordance, never silent truncation.
- **R13: SIGWINCH debounce** (§30-reference) — ≥50 ms coalesce around resize events to prevent flicker storms during window-edge drags.

Also adds inline image rendering in the TUI to the explicit non-goals (§00-overview) — LaTeX figure previews stay webview-only.
