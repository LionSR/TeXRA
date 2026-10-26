<script setup>
import MergeFlowHero from '../.vitepress/components/MergeFlowHero.vue';
import MergePanelHero from '../.vitepress/components/MergePanelHero.vue';
</script>

# Intelligent Merge workflow

## When you need a merge

When an agent edits only one section of a long document, its output (`r0/draft.tex` or `r1/draft.tex`) may contain just the modified fragment rather than the full file. Running `latexdiff` directly between a partial fragment and the full original produces a broken diff.

**Intelligent Merge** runs the `merge` agent to splice the edited fragment back into your full **Base File**, producing a complete `.tex` document that you can compile and compare cleanly with `latexdiff`.

<MergeFlowHero />

<p class="hero-caption">The full <strong>Base File</strong> and the agent's partial <strong>Edited File</strong> both feed the <code>merge</code> agent, which emits a complete merged document: the valid <code>latexdiff</code> input.</p>

## The merge workflow

Open the merge action from the "LaTeXDiffs" section (<wa-icon library="texra" name="chevron-down"></wa-icon> LaTeXDiffs) in the main TeXRA interface:

<MergePanelHero />

<p class="hero-caption">The LaTeXDiffs section: pick an <strong>Edited File</strong>, then select the highlighted <wa-icon library="texra" name="merge"></wa-icon> <strong>Merge</strong> action in the Edited row. Merge writes into the agent panel's primary Input file.</p>

1.  **Select the base file**: Merge uses the primary **Input** file selected in the agent panel (the first input file) as the document to merge changes _into_. The LaTeXDiffs "Base File" dropdown (<wa-icon library="texra" name="file"></wa-icon> Base) is used by Diff, Compare, and Accept, not by Merge. If no input file is selected, TeXRA says "Choose both the input and edited files to merge."
2.  **Select the edited file**: Choose the document containing the suggested changes from the "Edited File" dropdown (<wa-icon library="texra" name="edit"></wa-icon> Edited).
3.  **Select Merge**: Select the "Merge" button (<wa-icon library="texra" name="merge"></wa-icon>) in the "Edited File" row. The merge runs on TeXRA's **helper model**, set from Settings → Models → Models. Models with strong reasoning (such as Claude Opus 5, GPT-6 / GPT-5.6, or Gemini 3.1 Pro) are recommended for complex merges.

There is a second entry point. In the [ProgressBoard](./progress-board.md), each generated output file has a **Merge edits** action ("Merge edits into the workspace file") that runs the same `merge` agent against the corresponding workspace file, with no dropdowns to fill in.

::: info Extension and desktop feature
The Intelligent Merge action pairs a base file with a separate **Edited
File**, which the VS Code extension and the desktop app supply through their
file pickers and the ProgressBoard. The `texra run` CLI command takes only
`--input`/`--context` files and has no edited-file slot, so this merge
workflow is not available from the CLI.
:::

## Output

The `merge` agent writes the combined document to run storage under the base file's name (`r0/<base filename>.tex`) and streams its progress in the [ProgressBoard](./progress-board.md). Once the run completes, compare `r0/<base filename>.tex` against your original file with `latexdiff` (or accept the merged file back into the workspace).

## Next steps

- [LaTeX Diff](./latex-diff.md): Learn how to use `latexdiff` to compare the merged file with your original.
- [Built-in agents](./built-in-agents.md): Review the agents whose outputs you might want to merge.
