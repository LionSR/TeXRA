<script setup>
import TaskRecipeCards from '../.vitepress/components/TaskRecipeCards.vue';
import OutputArtifactsTree from '../.vitepress/components/OutputArtifactsTree.vue';
import CliRunHero from '../.vitepress/components/CliRunHero.vue';
</script>

# Quick Start Guide

You have a paper draft and a deadline. Let's get TeXRA working for you in under five minutes. On a fresh install, the **setup assistant** offers to run this whole loop for you in one conversation; this page is the reference for the Launcher you'll drive every day after.

The shortest path is: choose a credential, run setup once, then let the orchestrator handle the daily paper work.

<QuickStartHero />

<p class="hero-caption">The Launcher tab: point it at your file, pick an agent and a model, write one sentence, and press Execute.</p>

## Overview

TeXRA sits inside VS Code and helps you polish writing, fix errors, create figures, and transform documents—without leaving your editor. Here's the short version:

1. Select your file
2. Pick an agent and model
3. Write a short instruction
4. Click Execute
5. Review the diff

> 💡 **Tip:** Inside VS Code you can open the **Get started with TeXRA** walkthrough from the Get Started page
> (or by running `TeXRA: Open Getting Started Walkthrough`). It tells the same story in three beats — choose a
> credential; the setup assistant takes it from here; meet the orchestrator — and links directly
> to the relevant commands.

::: tip Prefer the terminal?
This guide walks through the VS Code extension. If you installed the
[CLI](./texra-cli.md), the same agents run from the command line — start an
interactive session with `texra chat`, or run a single agent with
`texra run polish --input draft.tex`. Run `texra agents list` to see what's
available.
:::

## Add a key or connect a subscription

A credential is the one step no agent can do for you. On a fresh install, the **Welcome to TeXRA** card in the
TeXRA panel offers the main access choices:

1. **Use your own provider API key** — Anthropic, OpenAI, Google, and more. Open the **Providers & Models** tab
   (the <wa-icon library="texra" name="settings-gear"></wa-icon> gear icon at the top of the TeXRA panel) and
   set your provider's key in the **API Configuration** table, or place a `.env` file in your workspace with
   variables like `OPENAI_API_KEY`.
2. **Use ChatGPT subscription** — Codex models through your ChatGPT plan. Open the Dashboard's **Subscriptions**
   tab and use the **ChatGPT subscription** sign-in section.
3. **Use another provider subscription** — Grok (xAI), Kimi Code, and the GLM Coding Plan also run on a plan you
   already pay for. Connect them from the same **Subscriptions** tab.
4. **Use GitHub Copilot in VS Code** — compatible models through a Copilot subscription. Open **Subscriptions →
   Copilot in VS Code** and grant access through VS Code's native consent prompt. This source does not appear in
   the CLI or desktop applications.

The full per-provider key reference — the API Configuration table, Set / Get / Remove actions, and per-provider toggles — lives in [Models → Setting API Keys](./models.md#setting-api-keys).

::: tip Signing in to TeXRA
**TeXRA: Sign In** is separate from model access: a TeXRA account (Researcher Access) unlocks the hosted
research-agent catalog — remote agents such as the orchestrator — and those agents still run on the credential
you configured above. See [Remote Agents](./remote-agents.md).
:::

Once a credential is in place, the setup assistant takes it from here: one conversation that checks your environment, applies a team for your field, and runs your first polish, ending at a diff. [First run](./first-run.md) is the manual mirror of that conversation.

::: tip CLI credentials
The terminal uses the same paths — provider env vars for your own keys,
`texra auth chatgpt login` for a ChatGPT subscription, or `/api` in a chat
to pick among connected subscriptions. See
[Authentication](./texra-cli.md#authentication) on the CLI page.
:::

## Basic Workflow

Haven't run an agent yet? [First run](./first-run.md) walks through the
whole loop — sample file, one `polish` run, read the diff — in five
minutes, side-by-side for the extension and the CLI. The sections below
cover the Launcher controls you'll use beyond that.

## The Launcher in Detail

Open the TeXRA panel from the brain icon in the sidebar, or press
`Ctrl+Alt+M` (`Cmd+Option+M` on macOS).

### Select Files

1. In the **Input** section, click <wa-icon library="texra" name="add"></wa-icon> **Add files** and pick your document from the file picker. You can also drag-and-drop it from the OS file manager. If you have several `.tex` files open and want them all, use <wa-icon library="texra" name="folder-opened"></wa-icon> **Add opened files** — it appends every editor tab whose extension matches.
2. (Optional) Use the same buttons in **Context** to add read-only references or preamble, and **Media** to add figure files.

::: info Multiple Files
Each category holds an ordered list — add as many files as the task needs and drag rows to reorder them.
:::

<FileSelectHero />

<p class="hero-caption">The file selector: Input holds the document you're editing, Context holds references and preamble, and Media holds figures.</p>

### Choose Agent, Model, and Instruction

The dropdown menus at the bottom of the instruction box pick the agent
(e.g. `polish` for improving writing) and the model (e.g. `sonnet5`).
Then write a specific instruction in the text area:

```
Improve the clarity and flow of this document. Focus on making the technical
explanations more accessible. Fix any grammatical issues or awkward phrasing.
Ensure consistent terminology throughout.
```

::: tip Effective Instructions
Be specific about what you want! Include what should change and what should remain the same.
:::

### Configure Tools

Two icon buttons sit in the file-group header rows of the file selector — one next to the **Input** label, one next to the **Media** label. They light up when a helper is active.

1. Click the <wa-icon library="texra" name="tools"></wa-icon> **Tool configuration options** button to:
   - **Attach TeX Count** — include document word-count statistics so the agent knows the document's size and structure
2. Click the <wa-icon library="texra" name="wand"></wa-icon> **Auto-extract options** button to enable, for this run:
   - **Figures** — pull figures out of the document automatically
   - **TikZ Figures** — extract TikZ figures
   - **Compile Input PDF** — compile the input to PDF first

Reflection rounds are controlled by the selected agent—most writing agents already include a follow-up critique pass.

<ToolConfigHero />

<p class="hero-caption">The two helper menus in the Input and Media file-group headers. Active helpers tint their buttons; here Attach TeX Count and Figures are on.</p>

::: tip Save Prompts for Later
For advanced debugging, enable the `texra.debug.saveModelIO` setting in `.texra/config.json` to store the generated prompt alongside other debug artifacts.
:::

### Execute and Watch the Run

Press **Execute** (<wa-icon library="texra" name="play"></wa-icon>). The ProgressBoard opens in the TeXRA view and streams the run live — see the [ProgressBoard guide](./progress-board.md) for interpreting the logs.

<GuideIntroHero />

<p class="hero-caption">The ProgressBoard streams the run live — todos, delegated subagents, and the tool-use log — with the output files alongside.</p>

### Review Results

1. When the agent completes, VS Code will open the generated output file from the run's task storage folder (e.g., `r0/draft.tex`, preserving the input filename).
2. Review the changes made by the AI. Remember, it's smart, but hasn't passed its quals yet!
3. You can compare the original and modified versions using:
   - **ProgressBoard Diff**: Click the <wa-icon library="texra" name="diff-multiple"></wa-icon> Diff button on the completed stream to compare the original file against the generated task-storage output.

     <CompareHero />

     <p class="hero-caption">VS Code's diff editor opens with your original on the left and the round-0 output (<code>r0/draft.tex</code>) on the right — removed text in red, improved text in green.</p>

     You can accept reviewed outputs from the ProgressBoard after comparing the changes.

   - **TeXRA's LaTeXdiff feature**: Use the LaTeXdiffs section in the TeXRA panel for a compiled, visual comparison. This creates a PDF with additions highlighted in blue and deletions in red.

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

## From the CLI

The same agents are one command away from the terminal. After
`npm install -g @texra-ai/cli` (Node.js >=22.9.0) or
`brew install texra-ai/tap/texra`:

```bash
# Set ANTHROPIC_API_KEY / OPENAI_API_KEY in your shell, or connect a subscription:
texra auth chatgpt login

# One-shot run (prints the revised file's path; --output copies it next to the input):
texra run polish --input draft.tex \
  --instruction "Improve clarity; preserve math and citations."

# Or open an interactive tool-use session:
texra chat
```

<CliRunHero
  command='texra run polish --input draft.tex --instruction "Improve clarity; preserve math and citations."'
  :rounds="[
    { label: 'r0 — draft revision', state: 'done' },
    { label: 'r1 — critique and revise', state: 'done' },
  ]"
  :outputs="['executions/9f3a6c81d24e/r1/draft.tex']"
/>

<p class="hero-caption">What a one-shot run looks like: rounds stream as progress, then the path to the revised document prints on stdout.</p>

Run history is shared with VS Code, so a run started in the CLI shows up in the
extension's ProgressBoard (and vice versa). See [TeXRA CLI](./texra-cli.md) for
sign-in, workspace defaults, and headless output formats.

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

Here are some common tasks you can try with TeXRA. Each is just an agent, a model, and a one-line instruction in the Launcher footer:

<TaskRecipeCards />

<p class="hero-caption">Three starter recipes — pick the agent and model, then paste the instruction. The first model listed is a good default; the others are interchangeable alternatives.</p>

## Understanding the Output

A completed run writes everything into the run's task storage folder, one
folder per round. Each round holds three artifacts, and the document keeps your
**input filename** (`draft.tex`, not `output.tex`):

<OutputArtifactsTree />

<p class="hero-caption">One folder per round under <code>r{round}/&lt;input-filename&gt;</code>: the revised <strong>Output</strong>, a <strong>Log</strong> of the run, and the <strong>Diff</strong> PDF. Round 1 (and any further reflection rounds) repeat the same trio.</p>

So if your input file is `paper.tex`, the first round's output lands at
`r0/paper.tex` — the filename you started with, never `output.tex`. The CLI
writes the same per-round tree under `executions/<run-id>/` in the
workspace store — see
[First run](./first-run.md) for the terminal walkthrough.

## Next Steps

Now that you've completed your first task with TeXRA, you can:

- Explore more [built-in agents](./built-in-agents.md) for specialized tasks
- Learn about [LaTeX diff](./latex-diff.md) for comparing document versions
- Discover how to use [intelligent merge](./intelligent-merge.md) for combining changes
- Optimize your workflow with [custom configuration](./configuration.md)

For any issues or questions, refer to the [troubleshooting](/guide/troubleshooting) section or check the [GitHub repository](https://github.com/texra-ai/texra-issues/issues).
