# 06 · Command palette

User pressed `Ctrl-P` with the buffer empty, then typed `mod`. The palette is filtering across three categories: slash commands, agent names, and model identifiers. Top result is highlighted (`▶`); `enter` selects it.

```
╭─ TeXRA ── agent: writer  ·  model: claude-opus-4.7  ─── 8 turns · $0.13 · 09:14 ────╮
│                                                                                      │
│  ◇ writer                                                                            │
│    ...the previous turn is still visible behind the palette, dimmed.                 │
│                                                                                      │
│                                                                                      │
│              ╭─ command palette ─────────────────────────  mod ─╮                    │
│              │                                                   │                    │
│              │   ▶ /model           switch model                 │  ← top hit
│              │     /agent           switch agent                 │
│              │                                                   │
│              │   ─── agents ───────────────────────────────────  │
│              │     ⬡ moderator      review-and-merge variants    │  ← agents matching
│              │                                                   │     fuzzy 'mod'
│              │   ─── models ───────────────────────────────────  │
│              │     ▤ claude-opus-4-7         current             │
│              │     ▤ claude-haiku-4-5-20251001                   │
│              │     ▤ gpt-5-pro-mode                              │
│              │                                                   │
│              │   ─────────────────────────────────────────────── │
│              │   ↑ ↓ navigate · enter select · esc cancel        │
│              ╰───────────────────────────────────────────────────╯                    │
│                                                                                      │
│                                                                                      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  ● idle · queued: 0 · yolo off                                                       │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ › _                                                                                  │
╰─── enter send · ctrl-j newline · ctrl-p palette · ctrl-f search · ? help ────────────╯
```

## Layout notes

- **Title bar** shows the current query right-aligned (`mod` here). Empty query shows all candidates.
- **Category dividers** `─── agents ───` keep the three streams (commands / agents / models) visually distinct. Result ordering inside each section is fuzzy-score-descending.
- **Result glyphs** disambiguate the type at a glance: `/` for slash commands, `⬡` for agents, `▤` for models. Color-coded but glyph-only is readable.
- **Selection cursor** `▶` marks the current row. `↑` `↓` move it within a section, then across sections.
- **Current state markers** — the user's current model and agent are annotated (`current`) on their row so the user doesn't accidentally re-select what they're already on.
- **Footer key hints** inside the modal explain the keyboard nav. Footer outside (the main key-hint strip) is unchanged.

## Backing data

- **Slash commands** read from `tui/commands/slashRegistry.ts`. Each command declares: `name`, `aliases`, `summary`, `handler`.
- **Agents** read from the `@agent` registry (workspace agent YAML definitions).
- **Models** read from the `@model` registry, filtered by available providers (keys present).

Fuzzy match is `fzf-for-js` across all three sources, with each source's results sorted by score and grouped under its divider.

## Open questions for review

1. Should the palette show **only** the top match per category (compact mode) when the query is non-empty, or always show full sections (current mock)?
2. Mixed result ordering — should the global top hit always render first regardless of category (current mock: yes, `/model` outranks `moderator`), or should category order be fixed (commands first, then agents, then models)?
3. Should there be a fourth section for **files** (mapped to `@`-prefix mentions), or should files only appear in the `@` autocomplete and stay out of the palette?
4. When the user selects a model that they don't have credentials for, what happens? Inline error in the palette, or modal dismisses and an error toast appears in the status bar?
