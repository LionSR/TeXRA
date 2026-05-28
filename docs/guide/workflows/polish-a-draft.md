# Polish a draft

Rewrite a LaTeX paper for clarity. Keeps math, citations, and structure
intact. Outputs a reviewable diff.

## What polish does

- Reads your input `.tex` file (and any context files you attach).
- Produces a revised draft that follows your instruction.
- Runs a built-in critique pass that rereads its own output and revises it.

Polish is a **workflow agent**: it writes to disk and produces a diff.
It does not chat, compile LaTeX, or verify citations.

## When to use it

Use polish when the content is in place and the prose needs work.

- Tighten loose paragraphs before submission.
- Fix repetition, hedging, generic phrasing.
- Improve flow between sentences and sections.

Don't use polish to add content, change math, or restructure sections.
For those, use the [Orchestrator](../built-in-agents.md) or the
`research` agent.

## Run it from the CLI

```sh
texra run polish \
  --input intro.tex \
  --instruction "Tighten prose. Preserve all math and citations."
```

Each round writes its output into the run's task storage, using the
**input filename** as the document name:

```
.texra/runs/<run-id>/r0/intro.tex   # Round 0 — first revision
.texra/runs/<run-id>/r1/intro.tex   # Round 1 — critique-and-revise pass
```

To write the final revision next to your input instead:

```sh
texra run polish --input intro.tex --output intro.polished.tex
```

## Run it in VS Code

1. Open `intro.tex`.
2. Click the TeXRA icon in the activity bar.
3. With `intro.tex` open in the editor, click <wa-icon library="texra" name="folder-opened"></wa-icon> **Add opened files** in the **Input** section.
4. Pick **polish** as the agent. Pick a model.
5. Type the instruction. Press **Execute**.
6. When the run completes, open the diff from the **Progress Board**.

Same run, same history, same output files — whichever surface you used.

## Reviewing the output

CLI — diff the rounds against your input:

```sh
diff -u intro.tex .texra/runs/<run-id>/r0/intro.tex
diff -u .texra/runs/<run-id>/r0/intro.tex .texra/runs/<run-id>/r1/intro.tex
```

VS Code — the Progress Board shows side-by-side diffs and lets you accept
the output back into the workspace.

For a **compiled PDF comparison** (additions in blue, deletions in red),
use the LaTeXdiff feature in the TeXRA panel. See
[LaTeX Diff](../latex-diff.md).

## How the critique pass works

After Round 0 produces a revision, polish re-prompts itself to check
for common failure modes:

- Edits that weakened the original.
- Mathematical content that went missing.
- Notation used before being defined.
- Generic filler ("provides crucial insights into…").
- Changes outside the scope of your instruction.

The result is written to `r1/`. Use **Round 0 alone** for fast
iteration. Use **Round 1** when the draft is close to final.

## Limits

- Operates on one revision per input file. For multi-file projects,
  list each file with `--input` or use the Orchestrator.
- No tool access — polish cannot compile, search citations, or run code.
- No new sections, equations, or references — polish only rewrites
  what is already there.

## See also

- [Built-in agents](../built-in-agents.md) — the full catalog of agents
- [LaTeX Diff](../latex-diff.md) — compiled PDF comparison of revisions
- [Models](../models.md) — picking a model for polish
- [Configuration](../configuration.md) — workspace defaults and reflection
