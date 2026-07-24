---
created: 2026-05-14
updated: 2026-05-15
---

# 03 · Bash approval modal

The agent has produced a bash command and the approval policy isn't `yolo`. Modal opens centered, the conversation pane keeps its last frame frozen behind it. Status pill shows `‼ awaiting approval`.

```
╭─ TeXRA ── agent: chat  ·  model: claude-opus-4-7  ─── 4 turns · $0.06 · 03:11 ────╮
│                                                                                      │
│  ◇ chat                                                                            │
│    I want to compile the current draft to confirm the lemma renders. I'll run        │
│    latexmk on the main file.                                                         │
│                                                                                      │
│              ╭─ ‼ bash approval needed ─────────────────────────────╮              │
│              │                                                       │              │
│              │   command:                                             │              │
│              │     $ latexmk -pdf -interaction=nonstopmode main.tex   │              │
│              │                                                       │              │
│              │   cwd:    ~/papers/quantum-walks                       │              │
│              │   reason: "verify lemma 3.2 renders before continuing" │              │
│              │                                                       │              │
│              │   [ y ] approve     [ n ] reject     [ e ] reject + feedback         │
│              │                                                       │              │
│              │   ──────────────────────────────────────────────────  │              │
│              │   esc cancels · ctrl-y yolo (all bash for this turn)  │              │
│              ╰───────────────────────────────────────────────────────╯              │
│                                                                                      │
│                                                                                      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  ‼ awaiting approval (bash) · queued: 0 · yolo off                                   │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ›                                                                                    │     ← input dimmed; capture is
╰────────────── y approve · n reject · e reject + feedback · esc cancel ───────────────╯       in the modal, not here
```

## Layout notes

- **Modal framing** uses heavier border style and centers horizontally. Width is ~70% of terminal width with a minimum of 60 cols.
- **Title row** carries the urgency glyph `‼` and the approval kind. Color: amber/yellow border for bash, red for destructive ops (rm, git push --force, etc.).
- **Command block** uses `$` prefix so it's visually obvious it's a shell command (not a code fence).
- **Metadata rows** (cwd, reason) explain context. Reason is the model's own justification, pulled from the approval payload.
- **Action row** uses bracketed `[ y ]` form for the keys. Mouse / arrow nav is **not** supported in modals (intentional per [§ Non-goals](../2026-05-14-00-overview.md#4-non-goals-explicitly-excluded) — keyboard only).
- **Footer divider + secondary actions** for less-common keys. `ctrl-y yolo` is documented inline so users don't memorize the keymap.

## State transitions

- `y` → approve, modal dismisses, command runs, output streams into a `Bash` tool-use card in the conversation.
- `n` → reject, modal dismisses, the model receives "user rejected this command" and may retry.
- `e` → reject-with-feedback opens an inline `<TextInput>` underneath the modal for free text. Submit feeds the feedback to the model.
- `esc` → cancel (same as `n` but doesn't add to the rejection history).
- `ctrl-y` → yolo-for-turn: sets a per-turn bypass so subsequent bash calls in this turn auto-approve.

## Open questions for review

1. Should the **reason** row appear at all? It's the model speaking from inside the approval payload — useful but extra height.
2. Color: amber for read-ish commands, red for destructive — is that detectable enough, or should we add an explicit "destructive" badge?
3. `ctrl-y yolo (this turn)` is risky as a hidden key. Should it require typing the full word `yolo` like dangerous CLI confirmations?
4. When multiple approvals queue up (through the approval FIFO), should the modal show `(1 of 3)` so users know more are pending?
