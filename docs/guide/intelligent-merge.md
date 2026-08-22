<script setup>
import MergeFlowHero from '../.vitepress/components/MergeFlowHero.vue';
import MergePanelHero from '../.vitepress/components/MergePanelHero.vue';
</script>

# Intelligent Merge workflow

## The problem: partial agent outputs

When you run agents like `correct` or `polish`, the AI may focus its changes on specific sections, so the round output (e.g. `r0/draft.tex` or `r1/draft.tex` for a `draft.tex` input) may contain only the modified parts, not the entire document. This saves processing time and tokens, but comparing this partial output directly against your full original document with `latexdiff` would not produce a meaningful result.

## The solution: Intelligent Merge button

TeXRA's **Intelligent Merge** workflow solves this problem. It uses an LLM to combine your original **Base File** with the agent's (possibly partial) **Edited File** to generate a new, **complete** document that incorporates the AI's changes.

This generated _full_ document can then be compared cleanly against your original base file with `latexdiff`.

<MergeFlowHero />

<p class="hero-caption">The full <strong>Base File</strong> and the agent's partial <strong>Edited File</strong> both feed the <code>merge</code> agent, which emits a complete merged document: the valid <code>latexdiff</code> input.</p>

## The merge workflow

Open the merge action from the "LaTeXDiffs" section (<wa-icon library="texra" name="chevron-down"></wa-icon> LaTeXDiffs) in the main TeXRA interface:

<MergePanelHero />

<p class="hero-caption">The LaTeXDiffs section: pick an <strong>Edited File</strong>, then select the highlighted <wa-icon library="texra" name="merge"></wa-icon> <strong>Merge</strong> action in the Edited row. Merge writes into the agent panel's primary Input file.</p>

1.  **Select the base file**: Merge uses the primary **Input** file selected in the agent panel (the first input file) as the document to merge changes _into_. The LaTeXDiffs "Base File" dropdown (<wa-icon library="texra" name="file"></wa-icon> Base) is used by Diff, Compare, and Accept, not by Merge. If no input file is selected, TeXRA says "Choose both the input and edited files to merge."
2.  **Select the edited file**: Choose the document containing the suggested changes from the "Edited File" dropdown (<wa-icon library="texra" name="edit"></wa-icon> Edited).
3.  **Select Merge**: Select the "Merge" button (<wa-icon library="texra" name="merge"></wa-icon>) in the "Edited File" row. The merge runs on TeXRA's **helper model**, set from the Dashboard → Providers & Models tab. Models with strong reasoning (such as Claude Opus 5, GPT-5.5, or Gemini 3.1 Pro) are recommended for complex merges.

There is a second entry point. In the [ProgressBoard](./progress-board.md), each generated output file has a **Merge edits** action ("Merge edits into the workspace file") that runs the same `merge` agent against the corresponding workspace file, with no dropdowns to fill in.

::: info Extension and desktop feature
The Intelligent Merge action pairs a base file with a separate **Edited
File**, which the VS Code extension and the desktop app supply through their
file pickers and the ProgressBoard. The `texra run` CLI command takes only
`--input`/`--context` files and has no edited-file slot, so this merge
workflow is not available from the CLI.
:::

TeXRA then invokes the specialized `merge` agent:

- The agent receives the base file, the edited file, and the configured helper model.
- It analyzes both versions to identify meaningful differences.
- It generates a new merge output (`r0/<base filename>` inside the run's task storage folder) containing the content of the base file updated with the accepted changes from the edited file.
- You can monitor the process and results in the [ProgressBoard](./progress-board.md).

## What happens behind the scenes

1. TeXRA sends both files to the configured helper model
2. The model synthesizes a complete document preserving the Base File structure while incorporating Edited File changes
3. TeXRA saves the result

## The output: a complete, merged file

The merge process generates a new file in task storage, named after the base file:

`r0/<base filename>.tex`

This merged file contains the complete document content, incorporating the changes from the agent's output.

**This merged file is now ready to be compared against your original `basename.tex` with the `latexdiff` command (through the UI button, or automatically if configured) to visualize the changes the agent made.**

## Next steps

- [LaTeX Diff](./latex-diff.md): Learn how to use `latexdiff` to compare the merged file with your original.
- [Built-in agents](./built-in-agents.md): Review the agents whose outputs you might want to merge.
