# Intelligent Merge Workflow

## The Problem: Partial Agent Outputs

When you run agents like `correct` or `polish`, the AI might intelligently focus its changes on specific sections, potentially resulting in an output file (`*_r0_*.tex` or `*_r1_*.tex`) that only contains the modified parts, not the entire document. While this saves processing time and tokens, comparing this partial output directly against your full original document using `latexdiff` wouldn't produce a meaningful result.

## The Solution: Intelligent Merge Button

TeXRA's **Intelligent Merge** workflow solves this problem. It uses an LLM to combine your original **Base File** with the agent's (potentially partial) **Edited File** to generate a new, **complete** document that incorporates the AI's changes.

This generated _full_ document can then be cleanly compared against your original base file using `latexdiff`.

## The Merge Workflow

Access the merge functionality via the "LaTeXdiffs" section (<i class="codicon codicon-chevron-down"></i> LaTeXDiffs) in the main TeXRA interface:

1.  **Select Base File**: Choose the original document you want to merge changes _into_ using the "Base File" dropdown (<i class="codicon codicon-file"></i> Base).
2.  **Select Edited File**: Choose the document containing the suggested changes using the "Edited File" dropdown (<i class="codicon codicon-edit"></i> Edited).
3.  **Choose Merge Model**: Select an appropriate language model from the main Model dropdown (<i class="codicon codicon-robot"></i> Model) below the instruction box. Models capable of strong reasoning (like GPT-4, Claude 3 Opus) are recommended for complex merges.
4.  **Click Merge**: Press the "Merge" button (<i class="codicon codicon-merge"></i>) located in the "Edited File" row.

TeXRA will then invoke the specialized `merge` agent:

- The agent receives the base file, the edited file, and the selected model.
- It analyzes both versions to identify meaningful differences.
- It generates a new file (e.g., `base_merge_r0_model.tex`) containing the content of the base file updated with the accepted changes from the edited file.
- The process and results can be monitored in the [ProgressBoard](./progress-board.md).

## What Happens Behind the Scenes

When you click the Merge button (prepare for some AI wizardry):

1.  TeXRA sends the content of both the Base File and the Edited File to a selected AI model (defaults can be configured in settings, `sonnet37` is often a good choice).
2.  The model is instructed to intelligently synthesize a new, complete document that preserves the structure and unchanged content of the Base File while incorporating the modifications present in the Edited File.
3.  TeXRA saves this synthesized result.

## The Output: A Complete, Merged File

The merge process generates a new file, typically named following the pattern:

`basename_agent_rX_full_model.tex`

(e.g., `paper_polish_r0_full_sonnet37.tex`)

This `_full_` file contains the complete document content, incorporating the changes from the agent's output.

**Crucially, this `_full_*.tex` file is now ready to be compared against your original `basename.tex` using the `latexdiff` command (either via the UI button or automatically if configured) to clearly visualize the changes the agent effectively made.**

## Next Steps

- [LaTeX Diff](./latex-diff.md): Learn how to use `latexdiff` to compare the merged (`_full_`) file with your original.
- [Built-in Agents](./built-in-agents.md): Review the agents whose outputs you might want to merge.
