<script setup>
import CritiquePassCard from '../../.vitepress/components/CritiquePassCard.vue';
import PolishRoundsTree from '../../.vitepress/components/PolishRoundsTree.vue';
import CliRunHero from '../../.vitepress/components/CliRunHero.vue';
</script>

# Polish a draft

Once the results are in, a polish rewrites a LaTeX draft for clarity. It keeps
math, citations, and structure intact and outputs a reviewable diff. A polish
is the `edit` program with an instruction that asks for one.

## What a polish does

- Reads your input `.tex` file (and any context files you attach).
- Produces a revised draft that follows your instruction.
- Runs a second revision that rereads its own output and corrects it.

`edit` is a **program**: it writes to disk and produces a diff. It does not
call tools or verify citations.

The instruction decides how far `edit` goes. With no instruction it only
proofreads (typos, grammar, LaTeX formatting); asked to polish, it may rewrite
sentences and paragraphs; asked for new content, it adds it. So say what you
want and what to keep.

## When to use it

Polish when technical content and mathematical arguments are settled, but the prose requires tightening before submission:

- Eliminate hedging, verbosity, and repetitive phrasing.
- Sharpen precision and flow between sentences and sections.
- Enforce consistent terminology across sections.

To add content or change the mathematics, say so in the instruction, or work
with the [Orchestrator](../built-in-agents.md) or the `research` agent, which
can compute and check as they go.

## Run it from the CLI

```sh
texra run edit \
  --input intro.tex \
  --instruction "Tighten prose. Preserve all math and citations."
```

<CliRunHero
  command='texra run edit --input intro.tex --instruction "Tighten prose. Preserve all math and citations."'
  :rounds="[
    { label: 'Revision 1: first revision', state: 'done' },
    { label: 'Revision 2: review-and-correct pass', state: 'done' },
  ]"
  :outputs="['…/executions/c4e19b07a52d/r1/intro.tex']"
/>

<p class="hero-caption">Revisions stream as progress, then the full path to the final revision prints on stdout. That printed path is the success signal.</p>

Each revision writes its output into `executions/<run-id>/` in the project's storage folder under `~/.texra`, keeping the **input filename**:

<PolishRoundsTree />

<p class="hero-caption">Both revisions reuse your input filename: <code>r0/intro.tex</code> holds the first revision, and <code>r1/intro.tex</code> holds the review-and-correct pass.</p>

To write the final revision next to your input instead:

```sh
texra run edit --input intro.tex --instruction "Tighten prose." --output intro.polished.tex
```

## Run it in VS Code

1. Open the folder that holds `intro.tex`.
2. Select the TeXRA icon in the Secondary Side Bar.
3. Keep the default agent (`assistant`) and pick a model.
4. Type what you want in plain words, for example "Polish intro.tex: tighten the prose, preserve all math and citations." Select **Start task** (<wa-icon library="texra" name="arrow-up"></wa-icon>; Enter also sends it).
5. The agent proposes an `edit` run. The proposal card shows the instruction and the files; edit them if needed, then approve.
6. When the run completes, open the diff from the **ProgressBoard**.

Same program, same output files, whichever surface you used.

## Reviewing the output

CLI: diff the revisions against your input. The path printed on stdout ends
in `executions/<run-id>/r1/intro.tex`; `<run-folder>` below is the
`executions/<run-id>` folder of that path:

```sh
diff -u intro.tex <run-folder>/r0/intro.tex
diff -u <run-folder>/r0/intro.tex <run-folder>/r1/intro.tex
```

VS Code: the ProgressBoard shows side-by-side diffs and lets you accept
the output back into the workspace.

<CompareHero />

<p class="hero-caption">The ProgressBoard opens the polished revision as a diff. Accept each change back into your draft.</p>

For a **compiled PDF comparison** (additions in blue, deletions in red),
use the LaTeXdiff feature in the TeXRA panel. Read the
[LaTeX Diff](../latex-diff.md) guide.

## How the second revision works

After the first revision, `edit` asks for a second one that reviews the
changes against the original and the instruction:

<CritiquePassCard />

<p class="hero-caption">The second revision rereads the first and corrects it: it reverts changes the instruction did not ask for, restores mathematics or reasoning that went missing, fixes notation used before it is defined, and removes sentences that say nothing specific.</p>

The result is written to `r1/`. Use **the first revision** (`r0/`) for fast
iteration. Use **the second** (`r1/`) when the draft is close to final.

## Limits

- Writes one revised file per input file. For multi-file projects,
  list each file with `--input` or use the Orchestrator.
- No tool access: `edit` cannot search citations or run code. TeXRA
  compiles each revision to check it.
- A polish only rewrites what is already there; new sections, equations or
  references need an instruction that asks for them.

## See also

- [Built-in agents](../built-in-agents.md): the full catalog of agents and programs
- [LaTeX Diff](../latex-diff.md): compiled PDF comparison of revisions
- [Models](../models.md): picking a model for a polish
- [Configuration](../configuration.md): workspace defaults
- [Agent architecture](../agent-architecture.md): revisions and the optional critic review
