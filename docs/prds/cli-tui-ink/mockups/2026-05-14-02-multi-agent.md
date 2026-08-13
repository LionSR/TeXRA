---
created: 2026-05-14
updated: 2026-05-15
---

# 02 · Multi-agent

Root stream is delegating to two subagents. One subagent has spawned its own child. SubagentList is rendered. The active focused stream is the root (highlighted with `●`); pressing `Ctrl-A` cycles forward, `Ctrl-B` returns to the parent, digits `1`–`9` jump directly.

```
╭─ TeXRA ── agent: coordinator  ·  model: claude-opus-4-7  ─── 5 turns · $0.18 · 06:42 ╮
│                                                                                      │
│  ◇ coordinator                                                                       │
│    I'll dispatch three research workers in parallel: one on the 1990s                │
│    quantum-walk literature, one on continuous-time analogues, and one                │
│    on graph-spectral connections. Synthesizing as they return.                       │
│                                                                                      │
│    ╭─ Task · spawn chat-research ──── ✓ id=w-7a3 · 0.0s ──────────────╮         │
│    │ {topic: "1990s quantum walks", scope: "foundational papers"}        │         │
│    ╰─────────────────────────────────────────────────────────────────────╯         │
│                                                                                      │
├─ subagents ──────────────────────────────────────────────────────────────────────────┤
│  ● 0  coordinator        running     · model: opus-4-7  · 3 tools · $0.18 · 06:42    │
│  │                                                                                   │
│  ├─ 1  w-7a3  research   running     · model: sonnet-4.6 · 4 tools · $0.07 · 01:53  │
│  │  └─ 2  w-7a3-c  read  running     · model: haiku-4.5  · 11 tools · $0.01 · 00:42 │
│  │                                                                                   │
│  ├─ 3  w-7a4  research   running     · model: sonnet-4.6 · 2 tools · $0.04 · 01:51  │
│  │                                                                                   │
│  └─ 4  w-7a5  research   ✓ done      · model: sonnet-4.6 · 5 tools · $0.09 · 02:14  │
│                                                                                      │
├─ processes ──────────────────────────────────────────────────────────────────────────┤
│    pid 41208  latexmk -pdf main.tex            running  ·  3.2s · 47 lines           │
│    pid 41312  python make_figures.py           ✓ done   ·  1.4s · exit 0             │
│                                                                                      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  ● running · 3 subagents · queued: 0 · yolo off                                      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ›                                                                                    │
╰─ enter send · ctrl-a next · ctrl-b parent · 1-9 jump · 0 root · ctrl-c interrupt ────╯
```

## Layout notes

- **SubagentList header** `├─ subagents ──┤` is a divider, not a tab. The list is a section of the main pane, always visible while there's at least one active child. Empties → section collapses entirely.
- **Tree characters** use `├─` for non-last children, `└─` for the last child, `│` for spine continuity. Indent doubles per nesting level.
- **Active indicator** `●` on the first column. Subagent index `0` is always the root; children get `1..N` in **pre-order DFS** (the same order they appear on screen, so digit shortcuts always line up with the visible row count). The render above is the canonical example.
- **Row columns** (after the index): short id · agent label · status text · model · tool count · cost · elapsed. Width-collapsing order if narrow: drop model first, then tool count.
- **Status text** is what the subagent is currently doing — pulled from `lastToolInfo` or process state. `running` / `✓ done` / `✗ failed` / `paused` / `detached`.
- **Elapsed time** ticks once per second at the list level (not per-row), per Claude Code's `CoordinatorTaskPanel` pattern.

## Focus interaction

- `Ctrl-A` cycles forward through `[0, 1, 2, 3, 4]`.
- `Ctrl-B` jumps to the focused row's parent (or root if already at root).
- `0` always returns to the root stream.
- `1`–`9` jump directly. When you jump, the conversation pane swaps to that stream's transcript.
- Detached children (per the Phase-4 runtime patch in 20-implementation) appear promoted to top-level rows.

## Open questions for review

1. Indentation per level — is 3 chars (`├─ `) enough, or should we double to 6 chars per depth so 3-level nesting reads clearly? User: good
2. Should the focused row also dim other rows, or is the `●` indicator sufficient? User: good
3. When the SubagentList grows large (10+ subagents), should it scroll inside its section, or take over the conversation pane via `Ctrl-T`? User: yes should do something. But... not top concern
4. Process rows (from `updateActiveProcesses`) currently mix with subagent rows under the same header. Should they be a sub-section `├─ processes ──┤` instead? User: `├─ processes ──┤`

User: in addition, should consider if subagents have subagents. and if one can toggle to check what is happening with the subagents.
