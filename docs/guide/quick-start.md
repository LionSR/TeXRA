# Quick Start Guide

Get your first AI-assisted edit in under 5 minutes.

## Prerequisites

You need an API key from one of the supported providers (Anthropic, OpenAI, Google, etc.). If you do not have one yet, create an account with your preferred provider and generate an API key.

## Step 1: Set Your API Key

1. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on macOS) to open the Command Palette
2. Type `TeXRA: Set API Key` and select the command
3. Choose your API provider and paste your key

Alternatively, place a `.env` file in your workspace root with your key (e.g., `ANTHROPIC_API_KEY=sk-...`). TeXRA loads it automatically.

## Step 2: Open a LaTeX File

Open any `.tex` file in VS Code. For a ready-made example, run `TeXRA: Create Sample Project` from the Command Palette to generate a `texra-sample/draft.tex` file.

## Step 3: Run Your First Agent

1. **Open the TeXRA panel**: Click the TeXRA icon in the Activity Bar (left sidebar) or press `Ctrl+Alt+M` (`Cmd+Option+M` on macOS)
2. **Set your input file**: Click the file icon button next to "Input" to use your active editor file
3. **Select Workflow mode**: Click the "Workflow" radio button (Chat mode is for interactive tool-use agents)
4. **Choose an agent**: Select `polish` from the agent dropdown
5. **Choose a model**: Select `gemini3p` or `sonnet45T` (or any available model)
6. **Enter an instruction**: Type something like "Improve clarity and fix any grammatical issues."
7. **Click Execute** (the play button)

The ProgressBoard panel shows real-time progress. When complete, VS Code opens the output file (e.g., `draft_polish_r0_gemini3p.tex`).

## Step 4: Review the Results

Compare the original and output files:

- **Quick diff**: Right-click both files in the Explorer and select "Compare Selected"
- **Visual diff**: Use the LaTeXDiffs section in the TeXRA panel to generate a PDF with additions in blue and deletions in red

Accept changes you like, discard the rest, and iterate.

---

That is the core workflow. The sections below cover additional details and common tasks.

## In-Editor Walkthrough

Inside VS Code, open the **Run your first TeXRA workflow** walkthrough from the Get Started page (or run `TeXRA: Open Getting Started Walkthrough`). It mirrors this guide and links directly to the relevant commands.

## Detailed Reference

This section provides more detail on each part of the interface.

### File Selection

The TeXRA panel has four file input categories:

| Category | Purpose | Examples |
|----------|---------|----------|
| **Input** | Primary file(s) the agent processes | `.tex` documents |
| **Reference** | Context files (not modified) | `.bib` files, style guides |
| **Auxiliary** | Supporting files | `preamble.tex`, `.cls`, `.sty` |
| **Media** | Visual or audio assets | Images, PDFs |

Click the file icon (<i class="codicon codicon-file-code"></i>) to use the current editor file, or the add button (<i class="codicon codicon-add"></i>) to browse. Click the chevron (<i class="codicon codicon-chevron-down"></i>) to expand and add multiple files.

![File Selection](/images/file-selection.png)

### Agent and Model Selection

At the bottom of the instruction box:
- **Agent dropdown**: Determines the task (`polish`, `correct`, `draw`, `paper2slide`, etc.)
- **Model dropdown**: The AI model (`gemini3p`, `sonnet45T`, `opus45T`, `gpt52`, etc.)

![Agent and Model Selection](/images/agent-model-selection.png)

### Chat vs Workflow Mode

The radio buttons above the instruction box switch between two modes:
- **Chat**: Interactive agents that execute commands and scripts
- **Workflow**: Document-editing agents that produce file outputs

For your first task, use Workflow mode with the `polish` or `correct` agent.

### Writing Effective Instructions

Include:
- What should change ("Fix grammatical errors")
- What should stay the same ("Preserve technical terminology")
- Scope ("Focus on the introduction")

### Tool Configuration

Click the tools icon (<i class="codicon codicon-tools"></i>) next to Input for optional settings:
- **Attach TeX Count**: Include word/character statistics
- **Attach Diagnostics**: Include LaTeX compilation logs

![Tool Configuration](/images/tool-config.png)

### Reviewing Results

Output files are named `originalname_agent_r0_model.tex` and saved next to your input file.

**VS Code Diff**: Right-click the original and output files in the Explorer, then select "Compare Selected". Use the arrow icons between panels to accept or reject individual changes.

![VS Code Compare View](/images/vscode-compare.png)

**LaTeXDiff**: Expand the LaTeXDiffs section in the TeXRA panel to generate a visual PDF comparison with additions in blue and deletions in red.

<div class="quick-pdf-viewer">
  <div class="pdf-tabs">
    <button type="button" class="pdf-tab active" data-pdf="/examples/draft.pdf">Original</button>
    <button type="button" class="pdf-tab" data-pdf="/examples/draft_polish_r0_gemini25p_diff.pdf">Round 0 Changes</button>
    <button type="button" class="pdf-tab" data-pdf="/examples/draft_polish_r1_gemini25p_diff.pdf">Round 1 Changes</button>
    <button type="button" class="pdf-tab" data-pdf="/examples/draft_polish_r1_gemini25p_diffr1r0.pdf">Round 0 vs Round 1</button>
  </div>
  <iframe src="/examples/draft.pdf" id="pdf-frame" class="quick-pdf-frame"></iframe>
  <a href="/examples/draft.pdf" target="_blank" id="pdf-link" class="quick-pdf-link">Open full example</a>
</div>

<div class="quick-legend">
  <div class="legend-item"><span class="del">Red strikethrough</span>: Removed content</div>
  <div class="legend-item"><span class="add">Blue underlined</span>: Added/improved content</div>
</div>

For details on how LaTeX diff works, see the [LaTeX Diff guide](./latex-diff.md).

<style>
.quick-pdf-viewer {
  position: relative;
  width: 100%;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  overflow: hidden;
  box-shadow: 0 4px 8px rgba(0,0,0,0.1);
  margin: 1rem 0 1.5rem;
}
.quick-pdf-frame {
  width: 100%;
  height: 350px;
  border: none;
}
.quick-pdf-link {
  position: absolute;
  top: 10px;
  right: 10px;
  color: white;
  padding: 5px 10px;
  border-radius: 4px;
  text-decoration: none;
  font-size: 0.85rem;
  z-index: 10;
}
.quick-pdf-link:hover {
  background: var(--vp-c-brand);
}
.pdf-tabs {
  display: flex;
  border-bottom: 1px solid var(--vp-c-divider);
  overflow-x: auto;
  white-space: nowrap;
}
.pdf-tab {
  padding: 0.5rem 1rem;
  cursor: pointer;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 4px 4px 0 0;
  font-size: 0.9rem;
  background: none;
  font-family: inherit;
  text-align: center;
}
.pdf-tab:hover {
  background-color: var(--vp-c-bg-soft);
}
.pdf-tab.active {
  background-color: var(--vp-c-bg-soft);
  border-color: var(--vp-c-divider);
  border-bottom-color: var(--vp-c-bg-soft);
  color: var(--vp-c-brand);
  font-weight: 500;
  margin-bottom: -1px;
}
.quick-legend {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  font-size: 0.9rem;
  margin-top: 0.5rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 4px;
  padding: 0.75rem;
  background-color: var(--vp-c-bg-soft);
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.quick-legend .del {
  color: #ff5252;
  text-decoration: line-through;
  font-weight: 500;
}
.quick-legend .add {
  color: #0066cc;
  text-decoration: underline;
  font-weight: 500;
}
</style>

## Common Quick Tasks

Here are some common tasks you can try with TeXRA:

### Fixing Grammar and Typos

- **Agent**: `correct`
- **Model**: `gemini3p`, `gpt41`, `gpt51`, or `gpt52`
- **Instruction**: "Fix grammatical errors and typos without changing the content or technical terminology."

### Converting a Paper to Slides

- **Agent**: `paper2slide`
- **Model**: `sonnet45T`, `gpt51`, or `gpt52`
- **Instruction**: "Convert this paper into presentation slides using the beamer template. Create approximately 12-15 slides highlighting the key points, methodology, and results."

### Improving Writing Style

- **Agent**: `polish`
- **Model**: `opus45T` or `sonnet45T`
- **Instruction**: "Improve the writing style to make it more engaging and clear. Enhance the flow between paragraphs while preserving all technical content."

## Understanding the Output

When TeXRA completes a task, it produces:

1. **Output File**: The main result with the requested changes
2. **Log Files**: Detailed information about the process
3. **Diff Files**: Visual comparison between original and modified versions (if applicable)

Output files are saved in the same directory as your input file with a naming pattern:
`original_filename_agent_r0_model.extension`

For example, if your input file is `paper.tex` and you used the `polish` agent with `sonnet45T` model, the output file would be named:
`paper_polish_r0_sonnet45T.tex`

## Next Steps

Now that you have completed your first task with TeXRA, you can:

- Explore more [built-in agents](./built-in-agents.md) for specialized tasks
- Learn about [LaTeX diff](./latex-diff.md) for comparing document versions
- Discover how to use [intelligent merge](./intelligent-merge.md) for combining changes
- Optimize your workflow with [custom configuration](./configuration.md)

For any issues or questions, refer to the [troubleshooting](/reference/troubleshooting) section or check the [GitHub repository](https://github.com/texra-ai/texra-issues/issues).
