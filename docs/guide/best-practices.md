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

Run derivation, proof, or literature tasks (`research`, `devise`, `prover`, `lean`, or the Orchestrator) first. Once the technical claims and equations are settled, run `polish` or `correct` on the finished `.tex` file.

## Model selection

Match model capability to task complexity: overpowered models waste money, underpowered ones produce poor results.

<ModelTierMatrixCard />

<p class="hero-caption">Find the row that matches your task, then pick one of the recommended model handles.</p>

Read the [AI models](./models.md) for detailed comparisons.

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

- **Keep an `AGENTS.md` at the workspace root**: record project-wide notation conventions, custom macros, compilation commands, and forbidden edits so every agent session inherits them automatically.
- **Attach only the files a document task needs**: put the target `.tex` file in **Input** and shared preamble or `.bib` files in **Context**.
- **Format before running `latexdiff`**: run `latexindent` or `tex-fmt` before comparing revisions so line-wrapping differences do not obscure prose edits.
- **Archive milestone revisions**: use **Archive outputs** in the ProgressBoard menu to move key revisions into `History/`, and delete stale run folders when no longer needed.

## Workflow integration

### Staged approach

A typical project moves through five stages, each owned by one or more agents:

<StagedWorkflowHero />

<p class="hero-caption">A typical project flows from research to finalization, with each stage handed to the agent best suited for it.</p>

### Quality assurance

Review AI-generated content after every run, using the same checks each time:

<QaChecklistCard />

<p class="hero-caption">A short review pass after each run catches the errors automation cannot see for itself.</p>

Use [LaTeX Diff](./latex-diff.md) to visualize changes between versions.

## Next steps

- [Configuration](/guide/configuration): Customize TeXRA
- [Custom agents](/guide/custom-agents): Create specialized agents
- [Intelligent Merge](/guide/intelligent-merge): Merge document versions
