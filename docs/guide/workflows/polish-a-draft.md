<script setup>
import CritiquePassCard from '../../.vitepress/components/CritiquePassCard.vue';
import PolishRoundsTree from '../../.vitepress/components/PolishRoundsTree.vue';
import CliRunHero from '../../.vitepress/components/CliRunHero.vue';
</script>

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

<CliRunHero
  command='texra run polish --input intro.tex --instruction "Tighten prose. Preserve all math and citations."'
  :rounds="[
    { label: 'r0 — first revision', state: 'done' },
    { label: 'r1 — critique-and-revise pass', state: 'done' },
  ]"
  :outputs="['executions/c4e19b07a52d/r1/intro.tex']"
/>

<p class="hero-caption">Rounds stream as progress, then the path to the final revision prints on stdout — that printed path is the success signal.</p>

Each round writes its output into the run's task storage — an
`executions/<run-id>/` folder under TeXRA's workspace storage directory —
using the **input filename** as the document name:

```
executions/<run-id>/r0/intro.tex   # Round 0 — first revision
executions/<run-id>/r1/intro.tex   # Round 1 — critique-and-revise pass
```

<PolishRoundsTree />

<p class="hero-caption">Both rounds reuse your input filename — <code>r0/</code> holds the first revision, <code>r1/</code> the critique-and-revise pass you usually keep.</p>

To write the final revision next to your input instead:

```sh
texra run polish --input intro.tex --output intro.polished.tex
```

## Run it in VS Code

1. Open `intro.tex`.
2. Click the TeXRA icon in the Secondary Side Bar.
3. In the **Input** section, click <wa-icon library="texra" name="add"></wa-icon> **Add files** and pick `intro.tex` from the file picker.
4. Pick **polish** as the agent. Pick a model.
5. Type the instruction. Press **Execute**.
6. When the run completes, open the diff from the **Progress Board**.

Same run, same history, same output files — whichever surface you used.

## Reviewing the output

CLI — diff the rounds against your input:

```sh
diff -u intro.tex executions/<run-id>/r0/intro.tex
diff -u executions/<run-id>/r0/intro.tex executions/<run-id>/r1/intro.tex
```

VS Code — the Progress Board shows side-by-side diffs and lets you accept
the output back into the workspace.

<CompareHero />

<p class="hero-caption">The Progress Board opens the polished round as a diff — accept each change back into your draft.</p>

For a **compiled PDF comparison** (additions in blue, deletions in red),
use the LaTeXdiff feature in the TeXRA panel. See
[LaTeX Diff](../latex-diff.md).

## How the critique pass works

After Round 0 produces a revision, polish re-prompts itself to check
for common failure modes:

<CritiquePassCard />

<p class="hero-caption">Round 1 rereads its own Round 0 output and scans for five regressions before revising again.</p>

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
