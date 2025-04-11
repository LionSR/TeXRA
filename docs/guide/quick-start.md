# Quick Start Guide

This guide will help you get up and running with TeXRA quickly. In just a few minutes, you'll be able to use AI to enhance your academic research in VS Code.

## Overview

TeXRA integrates powerful AI capabilities directly into your writing workflow. Here's what you can do:

- Fix grammar and typos in academic documents
- Improve writing style and clarity
- Create or enhance technical figures
- Transform papers into different formats (lecture notes, slides, posters)

## Set Up API Keys

Before you can use TeXRA's AI features, you need to provide API keys for the services you intend to use (like Anthropic, OpenAI, Google, etc.). TeXRA stores these keys securely using VS Code's secret storage.

1.  **Open the Command Palette**: Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on macOS).
2.  **Run the Set API Key command**: Type `TeXRA: Set API Key` and select the command.
3.  **Follow the prompts**: Select the API provider (e.g., Anthropic, OpenAI) and enter your key when prompted.

Repeat this process for each AI provider you plan to use with TeXRA.

## Basic Workflow

The typical TeXRA workflow consists of these steps:

1. Select files to process (input, reference, auxiliary, figures)
2. Choose the appropriate agent (correct, polish, draw, etc.)
3. Select the AI model to use
4. Provide specific instructions
5. Execute the agent
6. Review the generated output

## Your First TeXRA Task

Let's go through an example to illustrate the basic workflow.

### Step 1: Open a Document

1. Open VS Code
2. Navigate to the TeXRA panel in the sidebar (click the quantum deer icon)
3. Open or create a LaTeX document you'd like to improve

::: tip
Make sure your document is part of a workspace (folder) for best results.
:::

### Step 2: Select Files

1. In the TeXRA panel, click the "Current" button next to "Input" to set your active document as the input file
2. (Optional) Add reference, auxiliary, or figure files if needed for your task

::: info Multiple Files
For complex documents with multiple input files, use the "Multiple" dropdown to select additional files.
:::

<!-- ![File Selection](/images/file-selection.png) -->

### Step 3: Choose Agent and Model

1. In the dropdown menus at the bottom of the instruction box, select:
   - **Agent**: `polish` (for improving writing)
   - **Model**: `sonnet37` (Claude 3.7 Sonnet) or another available model

![Agent and Model Selection](/images/agent-model-selection.png)

### Step 4: Write Instructions

In the instruction text area, provide specific guidance for the AI. For example:

```
Improve the clarity and flow of this document. Focus on making the technical
explanations more accessible. Fix any grammatical issues or awkward phrasing.
Ensure consistent terminology throughout.
```

::: tip Effective Instructions
Be specific about what you want! Vague instructions are like asking a genie for "something cool" – results may vary wildly. Include what should change and what should remain the same.
:::

### Step 5: Configure Tools

1. Click on the "Tool Config" dropdown
2. Enable "Reflect" to allow the AI to review and improve its own work
3. (Optional) Enable other tools as needed:
   - "Attach TeX Count" to include document statistics
   - "Print Input Prompt" to save the generated prompt for reference

![Tool Configuration](/images/tool-config.png)

### Step 6: Execute the Agent

1. Click the "Execute" button
2. The ProgressBoard panel (typically at the bottom) will show the progress. See the [ProgressBoard guide](./progress-board.md) for more details on interpreting the logs.
3. Wait for the process to complete - this may take a few moments depending on the document size and model choice

<!-- ![Execution Progress](/images/execution-progress.png) -->

### Step 7: Review Results

1. When the agent completes, VS Code will open the generated output file (e.g., `yourfile_polish_r0_model.tex`).
2. Review the changes made by the AI. Remember, it's smart, but hasn't passed its quals yet!
3. You can compare the original and modified versions using:
   - **VS Code's Diff View**: Right-click on the original and output files in the Explorer and select "Compare Selected" for a side-by-side source code comparison.
   - **TeXRA's LaTeXdiff feature**: Use the LaTeXdiffs section in the TeXRA panel for a compiled, visual comparison (see the [LaTeX Diff guide](./latex-diff.md)).

<!-- ![Results Review](/images/results-review.png) -->

## Common Quick Tasks

Here are some common tasks you can try with TeXRA:

### Fixing Grammar and Typos

- **Agent**: `correct`
- **Model**: `sonnet35` or `haiku35` (faster)
- **Instruction**: "Fix grammatical errors and typos without changing the content or technical terminology."

### Creating a TikZ Figure

- **Agent**: `draw`
- **Model**: `sonnet37` or `gpt4o`
- **Instruction**: "Create a TikZ figure showing a workflow diagram with three main steps: data collection, processing, and analysis. Use arrows to show the data flow between steps."

### Converting a Paper to Slides

- **Agent**: `paper2slide`
- **Model**: `sonnet37` or `opus`
- **Instruction**: "Convert this paper into presentation slides using the beamer template. Create approximately 12-15 slides highlighting the key points, methodology, and results."

### Improving Writing Style

- **Agent**: `polish`
- **Model**: `opus` or `gpt4o`
- **Instruction**: "Improve the writing style to make it more engaging and clear. Enhance the flow between paragraphs while preserving all technical content."

## Understanding the Output

When TeXRA completes a task, it produces:

1. **Output File**: The main result with the requested changes
2. **Log Files**: Detailed information about the process
3. **Diff Files**: Visual comparison between original and modified versions (if applicable)

Output files are saved in the same directory as your input file with a naming pattern:
`original_filename_agent_r0_model.extension`

For example, if your input file is `paper.tex` and you used the `polish` agent with `sonnet37` model, the output file would be named:
`paper_polish_r0_sonnet37.tex`

## Next Steps

Now that you've completed your first task with TeXRA, you can:

- Explore more [built-in agents](./built-in-agents.md) for specialized tasks
- Learn about [LaTeX diff](./latex-diff.md) for comparing document versions
- Discover how to use [intelligent merge](./intelligent-merge.md) for combining changes
- Optimize your workflow with [custom configuration](./configuration.md)

For any issues or questions, refer to the [troubleshooting](/reference/troubleshooting) section or check the [GitHub repository](https://github.com/texra-ai/texra-issues/issues).
