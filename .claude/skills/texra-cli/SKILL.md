---
name: texra-cli
description: Terminal-UI and CLI-design discipline for the `texra` terminal client (packages/cli/). Use when changing the Ink TUI, the transcript/live-region rendering, terminal capability negotiation, headless `texra run` / `--print` output, or CLI flags, help text, and exit codes.
---

# TeXRA CLI and terminal UI

The `texra` CLI lives in `packages/cli/`. It ships an Ink (React) TUI under
`packages/cli/src/chat/tui/` plus headless `texra run` / `--print` modes.

The rules below are load-bearing: most were learned from terminal bugs that are
invisible in a normal test run and only reproduce on a real TTY. Where a rule
says "don't fix this back to X," X is a previously-shipped regression.

## Rendering model

The TUI deliberately does **not** take over the viewport (no alternate screen).
The root transcript appends finalized content to native scrollback and repaints
only a small live region at the bottom. Focused child streams use the same
ownership model: the active viewport selects exactly one stream to feed native
scrollback, and the live region paints only that stream's in-flight tail.

Keep those viewports distinct — the terminal already implements scrolling,
search, and mouse-scroll for finalized history, so don't reinvent them.

- **Root scrollback owns finalized root history.** In the root viewport, every
  finalized root transcript entry prints exactly once through Ink `<Static>`
  (`panes/StaticConversationTranscript.tsx`) so native scrollback / search /
  mouse-scroll keep working. Never render a finalized root turn in the root live
  region, and never reprint root `<Static>` items unless the repaint starts from
  a known origin — dedupe by the entry's own stable id, not a stream-scoped key
  (see `appendStaticTranscriptItems`). Focused child streams are separate
  viewports that temporarily select the child as the `<Static>` scrollback
  owner; root and child histories must not share append-only Static state.

- **Keep the live region minimal for the active viewport.** In root mode, only
  in-flight content belongs in the redrawn `<Box>` below `<Static>`: the
  streaming tail, spinners, side panels, input bar, and the active approval
  modal. In child focus, the same live region renders only the focused child's
  pending entries through the bounded row-budgeted path; full child history
  belongs to that child's Static scrollback owner. Ctrl-T opens the focused
  stream's full output in a scrollable, closable `TranscriptReader`
  (`panes/TranscriptReader.tsx`) rendered in the live region — `Esc` closes it
  and restores the conversation exactly as it was; `↑/↓` scrolls line by line
  and `PgUp/PgDn` pages. The reader
  never takes over the viewport (the TUI avoids the alternate screen), so it is
  sized by the same row budget as every other foreground surface.
  Cap root panels (`BOTTOM_PANEL_MAX_ROWS` in `panes/ConversationRegion.tsx`) so
  chrome never pushes the input off-screen. Don't park finalized content in the
  live region "for now."

- **Width changes and scoped returns invalidate wrapped lines.** Soft-wrap is
  width-dependent: recompute live-region layout from `useWindowSize()` columns
  on every render; never cache wrapped output across a width change. On a width
  change the vendored `ink` patch (`patches/ink@7.1.1.patch`) deliberately does
  a **full repaint** — `ansiEscapes.clearTerminal` then reprint live chrome
  (including the session header) plus `fullStaticOutput` (finalized history,
  reflowed), with the live region drawn below — debounced so a drag-storm
  collapses into one redraw.

  Any transcript viewport switch (`root` ↔ scoped child, or child ↔ child) uses
  the same known-origin pattern: clear scrollback, drop cached static output,
  then repaint the new viewport. Root viewports reprint root `<Static>` history;
  child viewports reprint only the focused child's `<Static>` history.

  Line-count erasing of the live region can't survive reflow, because the
  emulator owns the reflow/scroll geometry and a write-only stdout can't observe
  it, so any fixed erase count either strands residue or walks up and eats the
  live session header. Don't "fix" this back to line-count erasing; the
  no-repaint rule applies to steady-state rendering, not resize or transcript
  viewport switches.

## Component and process rules

- **Stateless renderers.** Tool / diff / markdown components are props-in →
  JSX-out (the render-time-workarounds ban from AGENTS.md "UI anti-patterns",
  applied to the TUI). No `Date.now()`, synthetic ids, or dedup at render time.
  Any view-level toggle (collapse/expand, focus) belongs in shared signal state
  (`state/cliState.ts`), not per-component local state.

- **Per-transcript-entry render-null error boundaries.** Every transcript entry
  is wrapped in `EntryErrorBoundary` (`panes/ConversationPane.tsx`,
  `panes/StaticConversationTranscript.tsx`), so one malformed entry degrades to
  blank instead of blanking the session. New transcript renderers must live
  inside it.

- **Capability-gate terminal features.** Negotiate support via the DA1-sentinel
  discovery (`state/terminalCapabilities.ts`) before emitting Kitty-keyboard,
  OSC color, or notification sequences. No "assume a modern terminal" feature
  use. (Bracketed paste is deliberately unconditional.)

- **Sync-teardown terminal restoration on every exit path.** `exitNow()` and
  every signal handler does synchronous `writeSync` mode-disable (mouse, kitty,
  bracketed paste, cursor) before any async drain, wired to
  SIGINT/SIGTERM/SIGHUP. Implemented in `runChatTui.tsx`; route new mode toggles
  through that same synchronous path.

- **Defer non-terminal content to the host.** The TUI does not render PDFs,
  LaTeX figures, or inline images (iTerm2 / Kitty / Sixel). Hand previews to the
  webview/desktop or the OS opener. The terminal is for chat, text, and diffs;
  rebuilding a document viewer in cells is out of scope.

- **Headless parity is sacred.** The TUI runs only on an interactive TTY.
  `texra run`, `--print/-p`, and `--output-format json|ndjson` must stay
  byte-identical — never let Ink rendering, ANSI chrome, or spinners leak into
  the piped / non-TTY path.

## Not yet built — adopt when touched

Animations should share one Clock (single timer, idle when unsubscribed,
offscreen rows unsubscribe via a ref-only check) instead of per-component
intervals; raw mode should be reference-counted (enable on 0→1, disable on 0,
snapshot/restore across Ctrl-Z) instead of toggled directly; the resize
clear+reprint should wrap in DEC 2026 sync-output (BSU/ESU, gated on the
existing DECRQM 2027 probe) if a blank flash is ever observed; prefer a
`/dev/tty` fallback over refusing the TUI when stdin is piped but a real
terminal is present, and handle EPIPE globally.

Full rationale and citations:
`docs/proposals/2026-07-03-ink-practices-from-claude-code.md`.

## CLI design (clig.dev)

The CLI follows the [Command Line Interface Guidelines](https://clig.dev).
Design to the guide's philosophy rather than ad-hoc choices: human-first design;
composable parts (stdin/stdout, exit codes, signals); consistency across
programs; saying just enough; ease of discovery; conversation as the norm;
robustness; empathy.

- **The basics.** Use the arg-parsing library; zero exit on success, non-zero on
  failure; primary/machine-readable output to stdout, logs and errors to stderr.
- **Help & documentation.** `-h`/`--help` everywhere, concise by default and full
  on request; lead with examples; link to web docs; suggest a command when the
  user mistypes.
- **Output & errors.** Human-readable by default, machine-readable (JSON) where
  it doesn't hurt usability; rewrite errors for humans; make bug reports easy;
  use color with intention and disable it off-TTY / `NO_COLOR` / `TERM=dumb`.
- **Arguments & flags.** Prefer flags to args; full-length plus short forms;
  standard names; `-` for stdin/stdout; confirm destructive actions.
- **Interactivity.** Only prompt on a TTY; honor `--no-input`; never require a
  prompt.
- **Subcommands, robustness, future-proofing, signals.** Consistent naming;
  validate input and stay responsive; keep changes additive; handle Ctrl-C.
- **Configuration & environment.** Precedence flags > env > project > user >
  system; honor general-purpose vars (`NO_COLOR`/`FORCE_COLOR`, `PAGER`, …).

Lean on `citty` (parsing/help) and `picocolors` (color) rather than
hand-rolling.

## Running a local build

`npm run texra-local:build` bundles the CLI and copies resources/docs into
`packages/cli/dist`; `npm run texra-local:link` symlinks `texra-local` into
`~/.local/bin` (one-time). The symlink points at
`packages/cli/dist/bin/texra.js`, which each build overwrites in place, so it
always runs the latest local build — re-run `texra-local:build` to refresh.
Override the install dir with `TEXRA_LOCAL_BIN_DIR=/some/dir`.
