---
created: 2026-05-14
updated: 2026-05-15
---

# 08 · Tool-card variants

The PRD's generic `<ToolUseCard>` is a base; rich tools (Bash, FileEdit, LaTeX-compile) replace the body with a custom renderer registered against the tool name. Most tools (Read, Grep, Glob, WebFetch, …) fall back to the generic compact form. Pattern source: Claude Code's `Tool.renderToolUse*Message()` family — see [§ Tool rendering](../2026-05-14-10-architecture.md#tool-rendering).

**Both the VS Code Progress View and the CLI TUI render off the same `ToolUseLog` schema** (`src/shared/schemas/progressView.ts`), unwrapped at render time by `normalizeToolUseData` per [§ Tool rendering](../2026-05-14-10-architecture.md#tool-rendering). The visual differences below are presentation-only; the captured tool-use state is identical regardless of which host the user happens to be looking through.

This mockup shows four tools mid-stream to illustrate where the variants diverge.

## 8.1 · Read (generic, collapsed by default)

```
  ╭─ Read · sec_3.2.tex ──── ✓ 84 lines · 0.3s ──── [ctrl-o expand] ──╮
  │ \begin{lemma} Let $X_n \to X$ a.e. on $[0,T]$, with $|X_n| ≤ Y$… │
  ╰────────────────────────────────────────────────────────────────────╯
```

- Header: tool · target · status · timing · expand hint.
- Body (collapsed): first line of result. On `Ctrl-O`, expands to a scrollable buffer that respects the global `verbose` flag.
- Reads / Grep / Glob / search-like tools all use this form by default.

## 8.2 · Bash (rich — live tail with elapsed time)

While running:

```
  ╭─ Bash · latexmk -pdf main.tex ── ● running · 4.7s · pid 41208 ──────╮
  │ Latexmk: Run number 1 of rule 'pdflatex'                            │
  │ Running 'pdflatex -recorder  main.tex'                              │
  │ Latexmk: Output file 'main.pdf' is empty (run 1)                    │
  │ Run number 2 of rule 'pdflatex'                                     │
  │ ...(+47 lines truncated · ctrl-o expand)                            │
  ╰─────────────────────────────────────────────────────────────────────╯
```

- Last 5 lines + truncation indicator (per Claude Code `ShellProgressMessage`).
- Live-tail behavior: each progress chunk replaces the body in-place; no jitter.
- Elapsed timer ticks once per second.

After completion (success):

```
  ╭─ Bash · latexmk -pdf main.tex ── ✓ exit 0 · 12.4s ─── [ctrl-o expand] ──╮
  │ main.pdf generated (12 pages)                                            │
  ╰──────────────────────────────────────────────────────────────────────────╯
```

After completion (failure):

```
  ╭─ Bash · latexmk -pdf main.tex ── ✗ exit 1 · 9.2s ─── [ctrl-o expand] ──╮
  │ ! Undefined control sequence \fatou                                     │
  │   l.43 \fatou                                                           │
  │       'slemma applied twice...                                          │
  │ Latexmk: Errors, so I did not complete making targets                   │
  ╰─────────────────────────────────────────────────────────────────────────╯
```

- Exit code in header. Body shows last lines emphasizing errors (red on `!`).

## 8.3 · FileEdit (rich — embeds the diff)

```
  ╭─ Edit · sec_3.2.tex ──── ✓ +14 / −9 · 3 hunks · 0.4s ── [ctrl-o expand] ──╮
  │ @@ -41,7 +41,8 @@                                                          │
  │  \begin{lemma}\label{lem:fatou}                                            │
  │ -  Then $\lim_{n\to\infty} \int X_n = \int X$.                             │
  │ +  Then $\lim_{n\to\infty} \int X_n = \int X$ by Fatou + monotone          │
  │ +  convergence on $|X_n - X|$.                                             │
  │  \end{lemma}                                                                │
  │  ─── 2 more hunks hidden · ctrl-o expand ──                                │
  ╰─────────────────────────────────────────────────────────────────────────────╯
```

- Header summary stats (`+N / −M · K hunks`).
- Body shows first hunk + ellipsis for remaining hunks.
- Same diff renderer used in the edit-approval modal ([2026-05-14-04-approval-edit.md](./2026-05-14-04-approval-edit.md)).

## 8.4 · LaTeX compile (TeXRA-specific candidate renderer)

A future TeXRA-specific rich renderer for LaTeX compilation. The generic Bash card already works (8.2), but a LaTeX-aware renderer could surface error-line jumps:

```
  ╭─ LaTeX · main.tex ── ✗ 1 error · 3 warnings · 9.2s ── [ctrl-o expand] ──╮
  │ ✗ undefined control sequence  sec_3.2.tex:43  \fatou                    │
  │   ⚠  overfull hbox            sec_3.2.tex:18  +12.4pt                   │
  │   ⚠  overfull hbox            sec_3.2.tex:51  +3.2pt                    │
  │   ⚠  underfull hbox           sec_4.1.tex:108 badness 10000             │
  ╰─────────────────────────────────────────────────────────────────────────╯
```

- Errors first, warnings after.
- Each line is a clickable target if `terminal-link` (OSC 8) is supported — falls back to plain text otherwise.
- This is a v1.x candidate, not v1. Goes in `tui/render/tools/LaTeXCompileCard.tsx`.

## Variant boundary: when to write a custom renderer vs. use the generic

| Tool kind                            | Renderer        | Why                                                                                                  |
| ------------------------------------ | --------------- | ---------------------------------------------------------------------------------------------------- |
| Read / Grep / Glob / Find / WebFetch | Generic compact | Output is text, truncation is uniform, no per-tool semantics.                                        |
| Bash / shell-exec                    | Rich live-tail  | Long-running, exit code matters, output streams.                                                     |
| Edit / MultiEdit / Write             | Rich diff       | Structure (hunks, +/−) is semantic; generic card hides it.                                           |
| Task / Agent-spawn                   | Rich badge      | Status is "spawned subagent X" — see [2026-05-14-02-multi-agent.md](./2026-05-14-02-multi-agent.md). |
| LaTeX-compile, BibTeX, latexdiff     | Rich (later)    | Domain-specific errors and warnings.                                                                 |
| Everything else                      | Generic         | Default.                                                                                             |

## Open questions for review

1. Live-tail height — fixed at 5 lines (Claude Code's choice) or grow with output up to a cap?
2. When Bash exits non-zero, should the card border tint red even when collapsed, or only when expanded?
3. For LaTeX-compile (8.4), are error-line OSC 8 hyperlinks worth the complexity, or should clicking a line use a TeXRA convention (e.g., copy `sec_3.2.tex:43` to clipboard for the user to paste into VS Code)?
4. Should the v1 PRD scope only Bash + Edit as rich renderers, or also commit to a LaTeX renderer for v1?

User: ok, do as you recommend. don't overcrowd the TUI
