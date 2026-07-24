---
created: 2026-05-14
updated: 2026-05-15
---

# Mockups

ASCII representations of the Ink TUI in representative situations. These exist for design review — the actual rendered output will differ in colors, spacing, and emoji-vs-ASCII glyphs based on the runtime terminal capability discovery (see [§ Terminal capability discovery](../2026-05-14-10-architecture.md#terminal-capability-discovery)).

Each file shows one situation and annotates the layout decisions worth feedback. Target width: 100 columns (the same width used in `cli-highlight` defaults and Claude Code's smoke matrix).

| File                                                                       | Situation                                                            | Key decision being shown                                                      |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [2026-05-14-00-idle.md](./2026-05-14-00-idle.md)                           | Empty session, ready for input                                       | Chrome layout, header content, status bar slot ordering                       |
| [2026-05-14-01-streaming.md](./2026-05-14-01-streaming.md)                 | In-flight assistant turn with one tool-use card                      | `<Static>` boundary, live region position, ToolUseCard collapsed state        |
| [2026-05-14-02-multi-agent.md](./2026-05-14-02-multi-agent.md)             | Root + 2 active subagents, one nested deeper                         | `<SubagentList>` tree characters, focus indicator, elapsed-time tick          |
| [2026-05-14-03-approval-bash.md](./2026-05-14-03-approval-bash.md)         | Bash approval modal open over the conversation                       | Modal framing, command preview, key-hint footer                               |
| [2026-05-14-04-approval-edit.md](./2026-05-14-04-approval-edit.md)         | Edit approval with unified diff, partly truncated                    | Diff coloring, truncation banner, `Ctrl-O` expand affordance                  |
| [2026-05-14-05-transcript-search.md](./2026-05-14-05-transcript-search.md) | `Ctrl-F` overlay with matches highlighted                            | Search header, match count, current-match indicator                           |
| [2026-05-14-06-command-palette.md](./2026-05-14-06-command-palette.md)     | `Ctrl-P` palette open with fuzzy filter                              | Palette position, result ranking, command-vs-agent-vs-model rows              |
| [2026-05-14-07-streaming-text.md](./2026-05-14-07-streaming-text.md)       | `texra chat \| tee` — stdout piped, no chrome                        | What scripts and `tee` see; how approvals route to stderr                     |
| [2026-05-14-08-tool-variants.md](./2026-05-14-08-tool-variants.md)         | Generic vs. rich tool cards (Read / Bash / FileEdit / LaTeX-compile) | When a tool earns a custom renderer; what the variants look like side-by-side |
| [2026-05-15-09-slash-form.md](./2026-05-15-09-slash-form.md)               | `/model` (single-screen) and `/status` (tabbed) as structured forms  | When a slash command opens a domain-specific form vs. acting inline; tabs     |
| [2026-05-15-10-session-resume.md](./2026-05-15-10-session-resume.md)       | `/resume` picker + post-resume conversation state                    | How prior sessions surface and replay into the TUI                            |

The mockups use these glyphs intentionally:

- `╭ ╮ ╰ ╯ ─ │ ├ ┤ ┬ ┴ ┼` — rounded box-drawing for outer chrome and modal borders.
- `├─ └─` — tree characters for subagent rows (per Claude Code's `AgentProgressLine.tsx`).
- `●` — active state (status pill, current selection).
- `○` — pending / idle state.
- `✓ ✗` — success / failure.
- `›` — input prompt.
- `…` — truncation marker.

Plain ASCII fallback glyphs (`+ - | < >`) are used only in [2026-05-14-07-streaming-text.md](./2026-05-14-07-streaming-text.md) since that mode strips Ink chrome entirely.

Lines prefixed `User:` inside the "Open questions for review" sections of each mockup are **captured design feedback from review** (the spec's author answering the open question inline). They are intentional review artifacts, not raw conversation pasted in by accident — and they record decisions the implementer should treat as binding.
