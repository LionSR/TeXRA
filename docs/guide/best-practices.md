<script setup>
import StagedWorkflowHero from '../.vitepress/components/StagedWorkflowHero.vue';
import QaChecklistCard from '../.vitepress/components/QaChecklistCard.vue';
import ModelTierMatrixCard from '../.vitepress/components/ModelTierMatrixCard.vue';
</script>

# Best practices

## Effective prompting

Specific instructions reduce ambiguity so the model spends its tokens on your actual goal rather than guessing scope or style.

### Name the target sections and goal

Instead of `"Make this better"`, specify the section and what to tighten:

> Tighten the methodology section (`\section{Variational Ansatz}`): remove hedging and redundant transition phrases, and keep every symbol definition anchored before its first use.

### State what to preserve

Explicitly protect macros, labels, theorem numbering, and settled sections:

> Revise the introduction and discussion for clarity. Preserve all `\cite{}` keys, equation environments, `\label{}` tags, and custom macros. Do not modify the results section.

### Separate content derivations from prose polishing

Settle derivations, proofs, and the literature first (ask the assistant, or run the `derive`, `solve`, `search` or `prove` programs). Once the technical claims and equations are settled, ask for a polish or a proofread of the finished `.tex` file (the `edit` program).

## Model selection

Match model capability to task complexity: overpowered models waste money, underpowered ones produce poor results.

<ModelTierMatrixCard />

<p class="hero-caption">Find the row that matches your task, then pick one of the recommended model references.</p>

Read the [AI models guide](./models.md) for detailed comparisons.

## Project and LaTeX organization

```
project/
├── AGENTS.md
├── main.tex
├── chapters/
├── figures/
├── refs.bib
└── .texra/
```

- **Keep an `AGENTS.md` at the workspace root**: record project-wide notation conventions, custom macros, compilation commands, and forbidden edits so every conversation inherits them automatically.
- **Give a program only the files it needs**: the target `.tex` file as input and shared preamble or `.bib` files as context.
- **Format before running `latexdiff`**: run `latexindent` or `tex-fmt` before comparing revisions so line-wrapping differences do not obscure prose edits.
- **Archive milestone revisions**: use **Archive outputs to History** in the Tasks view menu to copy key revisions into `History/`, and delete stale run folders when no longer needed.

## Workflow integration

### Staged approach

A typical project moves through five stages, each suited to one or more programs or to the assistant itself:

<StagedWorkflowHero />

<p class="hero-caption">A typical project flows from research to finalization, with each stage handed to the program, or the assistant, best suited for it.</p>

### Quality assurance

Review AI-generated content after every run, using the same checks each time:

<QaChecklistCard />

<p class="hero-caption">A short review pass after each run catches the errors automation cannot see for itself.</p>

Use [LaTeX Diff](./latex-diff.md) to visualize changes between versions.

## Next steps

- [Configuration](/guide/configuration): Customize TeXRA
- [Tailoring TeXRA](/guide/customizing): Project instructions, skills, plugins and your own programs
- [Intelligent Merge](/guide/intelligent-merge): Merge document versions
