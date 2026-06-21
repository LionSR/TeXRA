---
created: 2026-05-14
updated: 2026-05-15
---

# 04 · Edit approval with diff

The model proposes an edit to `sec_3.2.tex`. The approval modal shows the unified diff. Two hunks fit on screen; a third is signaled by the truncation banner and reachable via `Ctrl-O`.

```
╭─ TeXRA ── agent: chat  ·  model: claude-opus-4-7  ─── 5 turns · $0.08 · 04:02 ────╮
│  ╭─ ‼ edit approval needed ──────────────────────────────────────────────────╮     │
│  │                                                                             │     │
│  │   sec_3.2.tex      +14 / −9 · 3 hunks                                       │     │
│  │   ────────────────────────────────────────────────────────────────────     │     │
│  │                                                                             │     │
│  │   @@ -41,7 +41,8 @@                                                         │     │
│  │     \begin{lemma}\label{lem:fatou}                                         │     │
│  │       Let $X_n \to X$ a.e. on $[0,T]$, with $|X_n| \le Y$, $Y \in L^1$.    │     │
│  │   -   Then $\lim_{n\to\infty} \int X_n = \int X$.                          │     │
│  │   +   Then $\lim_{n\to\infty} \int X_n = \int X$ by Fatou + monotone       │     │
│  │   +   convergence on $|X_n - X|$.                                          │     │
│  │     \end{lemma}                                                            │     │
│  │                                                                             │     │
│  │   @@ -68,12 +69,15 @@                                                       │     │
│  │     \begin{proof}                                                          │     │
│  │   -   We invoke Fatou's lemma directly on $X_n$ and again on $-X_n$,       │     │
│  │   -   yielding two inequalities that combine to give the result.           │     │
│  │   +   By Lemma \ref{lem:fatou}, the integrand is bounded on $[0,T]$        │     │
│  │   +   and dominated by $Y \in L^1$. Apply DCT directly to conclude.        │     │
│  │       \qed                                                                  │     │
│  │     \end{proof}                                                            │     │
│  │                                                                             │     │
│  │   ─── 1 more hunk hidden · ctrl-o expand ──────────────────────────────    │     │
│  │                                                                             │     │
│  │   [ y ] approve     [ n ] reject     [ e ] reject + feedback               │     │
│  ╰─────────────────────────────────────────────────────────────────────────────╯     │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  ‼ awaiting approval (edit) · queued: 0 · yolo off                                   │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ›                                                                                    │
╰─── y approve · n reject · e reject + feedback · ctrl-o expand · esc cancel ──────────╯
```

## Layout notes

- **Header row** shows the filename + summary stats (`+14 / −9 · 3 hunks`). One line, truncates the filename from the **left** with `…` if the path is deep.
- **Hunk headers** `@@ -41,7 +41,8 @@` use the standard unified-diff form. These are dim white; the deltas are colored.
- **Color coding** — added lines: green prefix `+`, kept dim; removed lines: red prefix `−`, kept dim; context lines: no color.
- **Truncation banner** `─── N more hunk(s) hidden · ctrl-o expand ───` appears _between_ the shown hunks and the action row, not at the top. The cap (the PRD intentionally leaves the exact line count to the implementer) keeps the modal under ~50% terminal height so the conversation behind stays readable.
- **No "Show full" button** — the keymap row `ctrl-o expand` is the affordance; mouse not supported.

## Variant: long diff that exceeds even the cap

If a single hunk is itself larger than the cap, that hunk truncates internally with an inline `─── 412 lines elided · ctrl-o expand ───` banner inside the hunk, not at the bottom.

## Variant: tiny diff (whole file fits)

When the entire diff is under ~20 lines, the truncation banner is omitted and `ctrl-o` removed from the key-hint footer.

## Open questions for review

1. Should the modal width be fixed (e.g., min 80 cols) so the diff doesn't soft-wrap mid-line on narrow terminals? Today's mockup assumes wide enough.
2. Word-level highlighting within a changed line — adopt now, or defer? The webview's Monaco has it; cli-highlight does not by default. Adding it costs an extra dep (`diff-words` or similar).
3. `e` (reject + feedback) currently opens an inline TextInput. Should that field be shown right under the diff (modal grows), or should it open a separate modal layer?
4. After approval, the diff stays in the conversation as a tool-use card. Should the post-approval card collapse to a one-line summary (`✓ +14/−9 sec_3.2.tex · ctrl-o expand`) or keep showing the diff? User: collapse — `✓ +14/−9 sec_3.2.tex · ctrl-o expand` is the right default.
