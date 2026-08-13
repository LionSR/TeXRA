---
created: 2026-05-14
updated: 2026-05-15
---

# 06 · Command palette

User pressed `Ctrl-P` with the buffer empty, then typed `mod`. The palette is filtering across three categories: slash commands, agent names, and model identifiers. Top result is highlighted (`▶`); `enter` selects it.

```
╭─ TeXRA ── agent: chat  ·  model: claude-opus-4-7  ─── 8 turns · $0.13 · 09:14 ────╮
│                                                                                      │
│  ◇ chat                                                                            │
│    ...the previous turn is still visible behind the palette, dimmed.                 │
│                                                                                      │
│         ╭─ command palette ─────────────────────────────────────────  mod ─╮         │
│         │                                                                    │         │
│         │   ─── slash commands ────────────────────────────────────────────  │         │
│         │   › /model            switch model                                 │         │
│         │     /agent            switch agent                                 │         │
│         │                                                                    │         │
│         │   ─── agents ────────────────────────────────────────────────────  │         │
│         │     moderator         review-and-merge variants                    │         │
│         │                                                                    │         │
│         │   ─── models ────────────────────────────────────────────────────  │         │
│         │     claude-opus-4-7 ✓ current · most capable for complex work      │         │
│         │     claude-sonnet-4-6   best for everyday tasks                    │         │
│         │     claude-haiku-4-5    fastest for quick answers                  │         │
│         │     gpt-5-pro-mode      cross-provider option                      │         │
│         │                                                                    │         │
│         │   ─── attachments ───────────────────────────────────────────────  │         │
│         │     [Image #1]        figure-a.png · 412×218 · pasted 09:42         │         │
│         │     [Image #2]        lemma-screenshot.png · 1280×720 · 11:04       │         │
│         │                                                                    │         │
│         │   ─── files (@ also works) ─────────────────────────────────────   │         │
│         │     sec_3.2.tex       ~/papers/quantum-walks/                      │         │
│         │     main.tex          ~/papers/quantum-walks/                      │         │
│         │                                                                    │         │
│         │   ↑ ↓ navigate                                                     │         │
│         │   Enter insert    ·    Esc cancel                                  │         │
│         ╰────────────────────────────────────────────────────────────────────╯         │
│                                                                                      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  ● idle · queued: 0 · yolo off                                                       │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ › _                                                                                  │
╰─── enter send · ctrl-j newline · ctrl-p palette · ctrl-f search · ? help ────────────╯
```

## Layout notes

- **Title bar** shows the current query right-aligned (`mod` here). Empty query shows all candidates.
- **Category dividers** `─── slash commands ───` separate five sources: slash commands, agents, models, attachments, files. Result ordering inside each section is fuzzy-score-descending.
- **Selection cursor** uses `›` (Ink's `figures.pointer`) on the focused row — same convention as Claude Code's `CustomSelect`. No alternate glyph on unfocused rows, just a blank.
- **Current-state marker** `✓ current` annotates the active model / agent so the user doesn't accidentally re-select what they're already on. Lifted from Claude Code's model-picker (`figures.tick`).
- **Glyph-free row format** — the source-of-row is conveyed by its category section divider, not a per-row icon. Reduces visual noise.
- **Footer keymap** inside the palette is **mandatory** — every modal/form carries this strip to make "what do I do next?" answerable without leaving the screen. See [§ Intuitiveness conventions](../2026-05-14-10-architecture.md#intuitiveness-conventions) for the cross-modal rule.

## Backing data

- **Slash commands** read from `tui/commands/slashRegistry.ts`. Each command declares: `name`, `aliases`, `summary`, optional `formComponent` (see [2026-05-15-09-slash-form.md](./2026-05-15-09-slash-form.md) for the structured-form variant).
- **Agents** read from the `@agent` registry (workspace agent YAML definitions).
- **Models** read from the `@model` registry, filtered by available providers (keys present).
- **Attachments** read from `cliState.attachments` — a `Map<id, AttachmentRef>` populated by paste detection (per [§ Image attachments](../2026-05-14-10-architecture.md#image-attachments)). Selecting `[Image #N]` inserts the token at the input cursor; the model receives the actual image payload at send time.
- **Files** read from `fast-glob` against the workspace cwd (also reachable via `@` autocomplete, which uses the same source).

Fuzzy match is `fzf-for-js` across all five sources, with each source's results sorted by score and grouped under its divider.

## Open questions for review

1. Mixed result ordering — should the global top hit always render first regardless of category (current mock: yes, `/model` outranks `moderator`), or should category order be fixed?
2. When the user selects a model that they don't have credentials for, what happens? Inline error in the palette, or modal dismisses and an error toast appears in the status bar?
3. Should `[Image #N]` references support inline thumbnails when the host terminal supports iTerm2 inline images / Kitty graphics? Out of scope for v1 (text-only refs) per [00-overview § Non-goals](../2026-05-14-00-overview.md#4-non-goals-explicitly-excluded), but worth confirming.
4. Should there be a way to **delete** an attachment from the palette (e.g., `d` on a focused row), or is paste-only the v1 model?

   User: Ok. do as you recommend for now
