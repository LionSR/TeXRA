---
created: 2026-05-14
updated: 2026-05-15
---

# 07 · Streaming-text mode (stdout piped)

User ran `texra chat | tee transcript.txt`. stdin and stderr are still TTY so the input prompt and approval modals work normally — but stdout is piped, so Ink chrome is replaced with a plain ANSI serializer. This mode is auto-detected (no flag); `--print/-p` continues to take the full headless path (per [§ 13](../2026-05-14-20-implementation.md#13-headless--legacy-preserved)).

## What `tee` sees (stdout — `transcript.txt`)

Plain text only. No box-drawing, no cursor moves, no alt-screen. Lines end with `\n`. Color is preserved (so `cat transcript.txt` shows highlighting) but stripped from the headers since they're not interactive context anymore.

```
TeXRA · agent: chat · model: claude-opus-4-7
================================================================

you:
  rewrite section 3.2 so the lemma proof is tighter

chat:
  Let me first look at the current proof.

  [tool: Read sec_3.2.tex]
    \begin{lemma} Let $X_n \to X$ a.e. on $[0,T]$ ...
    ... (84 lines)

  The current proof has three steps: a measurability argument, the
  application of Fatou's lemma, and the final dominated-convergence pass.
  We can compress steps 1–2 by observing that the integrand is bounded
  on [0, T], which lets us skip Fatou's lemma entirely.

  [tool: Edit sec_3.2.tex]
    +14 / -9, 3 hunks (approved)

chat turn complete · 7,432 in · 1,103 out · $0.03 · 0:42

you:
  _
```

## What the user sees (stderr — terminal)

Interactive chrome stays on stderr. Approvals, status, and input prompt are still drawn here as full Ink components — the user keeps the modal experience. The only thing that changes is where conversation content goes.

```
[stderr — drawn by Ink]
  ● streaming · agent: chat · queued: 0
  ‼ awaiting approval (bash): latexmk -pdf main.tex
    [y] approve  [n] reject  [e] reject + feedback

[stdin]
  › _
```

This split is **only** active when stdin and stderr are TTY. If any of those is also piped, the whole session falls through to today's headless behavior — no streaming-text bifurcation.

## Layout notes

- **No box-drawing on stdout.** ASCII separator `===` for the header rule, two-space indents for tool blocks, blank lines between turns.
- **Tool blocks** prefix each line with `[tool: <kind> <target>]` so a `grep '\[tool:'` over the transcript pulls all tool invocations.
- **Approval results** land in the transcript as a one-line summary (`+14 / -9, 3 hunks (approved)`) — the diff itself doesn't pollute the transcript by default.
- **Turn summary footer** records the same usage data that the TUI shows in the live region, terminated with `\n` so it's grep-friendly.
- **ANSI color is preserved** in stdout output by default (so `less -R transcript.txt` shows highlighting). `NO_COLOR=1` strips it.

## Open questions for review

1. Should the transcript prefix tool blocks more aggressively (e.g., `┌── tool: Read sec_3.2.tex ──`) using ASCII-only `+--+ |` chars, or stay terse?
2. Should approval rejections land in the transcript at all (currently: yes, with `(rejected: <reason>)` suffix)?
3. Should `--print` (which forces headless) and the auto-detected streaming-text mode produce _identical_ transcripts, or should `--print` be more terse (no usage footers, no per-turn separators) since it's optimized for scripts?
4. Is the `=== `header line useful for the typical `tee` workflow, or just visual noise the user is going to grep past?

   User: ok. do as you recommend
