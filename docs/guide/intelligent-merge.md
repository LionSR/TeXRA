# Intelligent Merge Workflow

## The Problem: Partial Agent Outputs

When you run agents like `correct` or `polish`, the AI might intelligently focus its changes on specific sections, potentially resulting in a round output (`r0/output.tex` or `r1/output.tex`) that only contains the modified parts, not the entire document. While this saves processing time and tokens, comparing this partial output directly against your full original document using `latexdiff` wouldn't produce a meaningful result.

## The Solution: Intelligent Merge Button

TeXRA's **Intelligent Merge** workflow solves this problem. It uses an LLM to combine your original **Base File** with the agent's (potentially partial) **Edited File** to generate a new, **complete** document that incorporates the AI's changes.

This generated _full_ document can then be cleanly compared against your original base file using `latexdiff`.

## The Merge Workflow

Access the merge functionality via the "LaTeXdiffs" section (<wa-icon library="texra" name="chevron-down"></wa-icon> LaTeXDiffs) in the main TeXRA interface:

1.  **Select Base File**: Choose the original document you want to merge changes _into_ using the "Base File" dropdown (<wa-icon library="texra" name="file"></wa-icon> Base).
2.  **Select Edited File**: Choose the document containing the suggested changes using the "Edited File" dropdown (<wa-icon library="texra" name="edit"></wa-icon> Edited).
3.  **Choose Merge Model**: Select an appropriate language model from the main Model dropdown (<wa-icon library="texra" name="robot"></wa-icon> Model) below the instruction box. Models capable of strong reasoning (like GPT-4, Claude 3 Opus) are recommended for complex merges.
4.  **Click Merge**: Press the "Merge" button (<wa-icon library="texra" name="merge"></wa-icon>) located in the "Edited File" row.

TeXRA will then invoke the specialized `merge` agent:

- The agent receives the base file, the edited file, and the selected model.
- It analyzes both versions to identify meaningful differences.
- It generates a new merge output (`_full.tex` inside the run's task storage folder) containing the content of the base file updated with the accepted changes from the edited file.
- The process and results can be monitored in the [ProgressBoard](./progress-board.md).

## What Happens Behind the Scenes

1. TeXRA sends both files to the selected AI model
2. The model synthesizes a complete document preserving the Base File structure while incorporating Edited File changes
3. TeXRA saves the result

## The Output: A Complete, Merged File

The merge process generates a new file in task storage:

`_full.tex`

This `_full` file contains the complete document content, incorporating the changes from the agent's output.

**Crucially, this `_full.tex` file is now ready to be compared against your original `basename.tex` using the `latexdiff` command (either via the UI button or automatically if configured) to clearly visualize the changes the agent effectively made.**

## Next Steps

- [LaTeX Diff](./latex-diff.md): Learn how to use `latexdiff` to compare the merged (`_full_`) file with your original.
- [Built-in Agents](./built-in-agents.md): Review the agents whose outputs you might want to merge.
