---
created: 2026-05-14
updated: 2026-05-15
---

# 01 · Streaming with tool use

The assistant has finished one tool call and is now streaming markdown into a live region. The completed turn above (with its tool-use card) has flushed into the `<Static>` region — it will not re-render. Only the live block is mutating per chunk.

```
╭─ TeXRA ── agent: chat  ·  model: claude-opus-4-7  ─── 3 turns · $0.04 · 02:14 ────╮
│                                                                                      │
│  ◆ you                                                                               │
│    rewrite section 3.2 so the lemma proof is tighter                                 │
│                                                                                      │
│  ◇ chat                                                                            │
│    let me first look at the current proof.                                           │
│                                                                                      │
│    ╭─ Read · sec_3.2.tex ──── ✓ 84 lines · 0.3s ──── [ctrl-o expand] ──╮            │
│    │ \begin{lemma} Let $X$ be a … (collapsed; 84 lines)              │            │
│    ╰────────────────────────────────────────────────────────────────╯            │
│                                                                                      │
│  ────────────────────────────────── static boundary ──────────────────────────────── │  ← line drawn for the mockup;
│                                                                                      │     not rendered in the real TUI
│  ◇ chat                                                                            │
│    The current proof has three steps: a measurability argument, the                  │
│    application of Fatou's lemma, and the final dominated-convergence pass.           │
│    We can compress steps 1–2 by observing that the integrand is bounded              │
│    on $[0, T]$, which lets us skip Fat█                                              │     ← cursor where streaming is
│                                                                                      │       currently emitting
├──────────────────────────────────────────────────────────────────────────────────────┤
│  ● streaming    queued: 0    yolo off    7,432 in · 1,103 out · 12.4k cached         │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ›                                                                                    │
╰────── enter send · ctrl-j newline · ctrl-c interrupt · ctrl-o expand last tool ──────╯
```

## Layout notes

- **Turn markers** `◆` (user) and `◇` (assistant) anchor each turn. Color-coded but readable in monochrome.
- **Tool-use card** uses rounded `╭ ╮` borders. Header row: tool name · target · status pill · timing · expand hint. Collapsed body shows the first content line.
- **Static boundary** is invisible in the real TUI (annotated here for the mockup): everything above scrolls with terminal scrollback; everything below is the live region that re-renders.
- **Streaming cursor** `█` shows where the model is currently emitting. Disappears the moment the turn finalizes (and that turn then joins the Static region).
- **Status bar in streaming** swaps `idle` for `● streaming` and replaces `cwd` with the current turn's running token counters.
- **Footer** swaps `palette / search` hints for `interrupt / expand last tool` while a turn is in flight.

## Open questions for review

1. Tool-use card colors — should the entire card border tint by tool category (file edit = blue, bash = orange, search = purple) or stay neutral with only the status pill carrying color? User: yes
2. The collapsed body shows the first line. Should it be the **last** line so the user sees what the tool just produced, not what it started with? User: maybe both? if too long put some ...
3. Should there be a "this turn is interruptible" indicator when streaming, or is the `ctrl-c interrupt` hint in the footer enough? User: "enter send · ctrl-j newline · ctrl-c interrupt · ctrl-o expand last tool" these are good. but in the future maybe they can shuffle to list of tips
4. Cached-token count in the status bar — useful for cost awareness, or noise? User: ok for now.
