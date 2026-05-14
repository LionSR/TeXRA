# 00 · Idle

Empty session, just started. No turns in the conversation pane yet. Status bar shows session metadata. Input bar accepts the first prompt.

```
╭─ TeXRA ── agent: writer  ·  model: claude-opus-4.7  ─────  0 turns · $0.00 · 00:00 ─╮
│                                                                                      │
│                                                                                      │
│                                                                                      │
│                                                                                      │
│                                                                                      │
│                                                                                      │
│                                                                                      │
│                                                                                      │
│                                                                                      │
│  start by typing a prompt below, or press / for slash commands, @ to mention a file  │
│                                                                                      │
│                                                                                      │
│                                                                                      │
│                                                                                      │
│                                                                                      │
│                                                                                      │
│                                                                                      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  ○ idle    queued: 0    yolo off    cwd: ~/papers/quantum-walks                      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ › _                                                                                  │
╰────── enter send · ctrl-j newline · ctrl-p palette · ctrl-f search · ? help ─────────╯
```

## Layout notes

- **Header** carries agent + model + running cumulative usage (turns, cost, elapsed). Single line, truncates from the model name first if width is tight.
- **Conversation pane** is the large empty region. When idle, it shows the centered welcome line as a soft visual cue — disappears at first user input.
- **Status bar** lives between conversation and input. Slots: status pill (`●` running / `○` idle / `‼` blocked-on-approval), follow-up queue count, YOLO badge, current working directory.
- **Input bar** has the prompt glyph `›`, the typed value, and the footer key-hint strip. Footer never wraps — hints rotate based on width.
- **Subagent list / Todos panel** are **not rendered when empty** — they only appear when there's data (per [§ design principle](../10-architecture.md)). Idle has neither.

## Open questions for review

1. Is the cumulative usage in the header the right slot, or should it live in the status bar so the header just shows agent/model?
2. Should the welcome line be there at all, or should idle just be a blank canvas with the key-hint footer doing the work?
3. `cwd` in the status bar — useful or noise? Could move to header on a second line.
