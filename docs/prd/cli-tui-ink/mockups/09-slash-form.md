# 09 · Slash command as structured form

User pressed `/`, picked `/model`, hit `Enter`. Instead of running an action, the command opens a **structured form** — a domain-specific dialog with title, numbered options, an inline sub-state adjuster, and an explicit footer telling the user exactly what to do next. Pattern source: Claude Code's `local-jsx` command type (`/model` → `<ModelPicker>` → `<Pane><Select/><EffortLevelIndicator/><KeyHints/></Pane>`).

```
╭─ TeXRA ── agent: writer  ·  model: claude-opus-4.7  ─── 8 turns · $0.13 · 09:14 ────╮
│  (conversation above dimmed)                                                         │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  › /model                                                                            │
├──────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│   Select model                                                                       │
│   Switch between models. Applies to this session and future sessions.                │
│                                                                                      │
│   › 1. Default (recommended)  ✓     opus-4-7        most capable for complex work    │
│     2. Sonnet                        sonnet-4-6      best for everyday tasks          │
│     3. Sonnet (1M context)           sonnet-4-6 1M   billed as extra usage            │
│     4. Haiku                         haiku-4-5       fastest for quick answers        │
│                                                                                      │
│   ● High effort   ← / →  to adjust                                                   │
│                                                                                      │
│   ─── tips ───────────────────────────────────────────────────────────────────       │
│   Use /fast to turn on Fast mode (Opus 4.6 only).                                    │
│                                                                                      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│   1-4 select   ·   ↑ ↓ navigate   ·   Enter confirm   ·   Esc cancel                 │
╰──────────────────────────────────────────────────────────────────────────────────────╯
```

## Layout notes

- **Title** (`Select model`) is bold + accent color. One-line.
- **Subtitle** is dim, wraps freely. Explains what the form does and (when relevant) what its scope is — session-only vs persisted vs both.
- **Numbered option list** uses `1.`–`N.` prefixes so digit shortcuts work as direct jumps. Cursor `›` (figures.pointer) marks the focused row; `✓` after the label marks the currently-active value.
- **Inline sub-state row** (`● High effort  ← / →  to adjust`) lives in the form, not in a separate dialog. State is local to the form component (per Claude Code's `ModelPicker` pattern). The `← / →` keys adjust without leaving the option list.
- **Tips section** is optional. Used for cross-references to related commands the user might also want.
- **Footer keymap** is **mandatory** and follows the same convention as every other modal/form in the TUI:
  - `<scope-specific shortcuts>` first (e.g., `1-4 select`)
  - Standard nav (`↑ ↓ navigate`)
  - Confirm / cancel always last (`Enter confirm · Esc cancel`)

## Why a form instead of inline arguments

`/model sonnet-4-6` could in principle be a one-shot command, and aliasing it that way still works for power users. The structured form earns its cost when:

1. There are **non-obvious choices** the user needs to see before committing (the per-option taglines + pricing).
2. The command has **multi-axis state** (model + effort), which would otherwise need flag chaining (`/model sonnet --effort high`).
3. The **current state matters** (`✓ current` annotation) so the user doesn't accidentally re-select.

`/model` hits all three. Most slash commands won't — `/clear`, `/help`, `/agent <name>` stay as inline actions.

## Pattern shape

A slash command that wants a structured form declares a `formComponent` in its registry entry:

```
{
  name: 'model',
  description: 'Switch model · current: opus-4-7',
  formComponent: () => import('./forms/ModelForm.tsx'),  // lazy
}
```

When the user picks `/model` in the palette, the TUI mounts `<ModelForm>` inline (replacing the palette dropdown). The form is a stateless presentation component that receives `onDone(result)` and renders title + options + sub-state + footer. On `Enter`, it calls `onDone(selected)` and unmounts. On `Esc`, `onDone(null)`. The slash registry handles the result dispatch.

## Open questions for review

1. Should the form take over the **full conversation pane** (current mock) or render as a **modal overlay** centered with the conversation visible behind? Claude Code goes full-pane for `/model`; modal for `/help`.
2. Sub-state controls like `← / →` are inline. Should there be a convention for **two-axis** sub-state (e.g., effort × verbosity) — stacked rows? Tabs?
3. The `─── tips ───` section currently lists `/fast`. Should tips link via the palette (e.g., highlight `/fast` and pressing `t` jumps to its form), or stay as plain text?
4. Should structured forms be **reachable by direct invocation** without going through the palette (e.g., `texra chat --form model` from the shell)? Out of scope for v1, but worth noting.

   User: do as you recommend
