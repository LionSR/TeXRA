<script setup>
import OutputArtifactsTree from '../.vitepress/components/OutputArtifactsTree.vue';
import CliRunHero from '../.vitepress/components/CliRunHero.vue';
</script>

# Quick start guide

On a fresh install, the **setup assistant** walks you through connecting a model, checking your environment, and running a first task. This page is the reference for the **New task** view in VS Code and its CLI equivalents.

<QuickStartHero />

<p class="hero-caption">The New task view: pick a model, write one sentence that names your file, and select Start task.</p>

## Overview

Editing a document typically takes five steps:

1. Pick a model
2. Write a short instruction that names your file
3. Select **Start task**
4. Approve the program run the assistant proposes
5. Review the diff

::: tip Get started walkthrough
Inside VS Code you can open the **Get started with TeXRA** walkthrough from the Get Started page
(or by running `TeXRA: Open Getting Started Walkthrough`). It tells the same story in four steps (connect a
model, open your paper, run the setup assistant, your first task) and links directly to the relevant commands.
:::

::: tip Prefer the terminal?
This guide walks through the VS Code extension. If you installed the
[CLI](./texra-cli.md), the same assistant runs from the command line: start an
interactive session with `texra chat`, or run a single program with
`texra run edit --input draft.tex`.
:::

## Add a key or connect a subscription

On a fresh install, the **Connect a model** card in the TeXRA panel offers two quick choices (other subscriptions connect from Settings):

1. **Use your own API keys**: Open **Settings → Models → API keys** (gear icon at the top of the panel) and paste a provider key, or add keys to a project `.env` file.
2. **Use ChatGPT subscription**: Sign in under **Settings → Models → Subscriptions**.
3. **Other provider subscriptions**: Connect Grok (xAI), Kimi Code, or the GLM Coding Plan from the same **Models** page.

See [Models → Setting API keys](./models.md#setting-api-keys) for the full provider list. There is no TeXRA account — everything runs directly on your configured credentials.

Once connected, the **setup assistant** checks your environment and runs a quick test edit ending at a diff. [First run](./first-run.md) covers the same steps manually.

::: tip CLI credentials
The terminal uses the same paths: provider env vars for your own keys,
`texra auth chatgpt login` for a ChatGPT subscription, `texra auth grok login`
for a Grok (xAI) subscription, or `/login` in a chat to manage the ChatGPT and
Grok sign-ins. Running `texra` without any of these opens the chat with a
**Connect a model** panel instead of an error. `texra setup` is the terminal counterpart of the setup
assistant: it walks you through a ChatGPT sign-in or an API key, then your
environment and first task. Read the
[Authentication section](./texra-cli.md#authentication) of the CLI guide.
:::

## The New task view in detail

Open the TeXRA panel from the TeXRA icon in the Secondary Side Bar, or run **TeXRA: New Task**
(`Ctrl+Alt+M`, `Cmd+Option+M` on macOS).

### Choose a model and write the instruction

The menu at the bottom of the instruction box picks the model (e.g.
**Sonnet 5.5**, whose id is `anthropic/claude-sonnet-5-5`). There is no agent
to pick: one assistant takes every task, and splits a larger job across helper
agents and [programs](./programs.md) itself.

Then say what you want, and on which file, in the text area:

```
Polish main.tex: improve the clarity and flow, and make the technical
explanations more accessible. Fix grammatical issues and awkward phrasing.
Keep the terminology consistent and do not change the equations.
```

::: tip Effective Instructions
Be specific about your objectives: state both what the assistant should improve and what constraints (notation, theorem numbering, environment structures) it must preserve.
:::

To send figures or other media along, use **Attach** in the instruction box.

### Approve the program run

The New task view does not list programs and has no file section of its own.
For a document edit, the assistant proposes a run of one of the
[programs](./programs.md) (`edit` for a polish), and the
proposal card shows the program, the instruction and the files. Approve it,
or select **Edit** to change it first: the launch form opens on the proposal
with a **Documents and attachments** section.

1. In the **Input** group, use <wa-icon library="texra" name="add"></wa-icon> **Add input files** to pick the documents the program revises. If you have several `.tex` files open and want them all, use <wa-icon library="texra" name="folder-opened"></wa-icon> **Add opened files as input**.
2. (Optional) Use the same buttons in **Context** to add read-only references or preamble, and **Media** to add figure files.

::: info Multiple Files
Each category holds an ordered list. Add as many files as the task needs and drag rows to reorder them.
:::

<FileSelectHero />

<p class="hero-caption">The file selector of a proposal you are editing: Input holds the document the program revises, Context holds references and preamble, and Media holds figures.</p>

### Start the task and watch it

Select **Start task** (<wa-icon library="texra" name="arrow-up"></wa-icon>). The Tasks view opens in the TeXRA panel and streams progress live. Read the [Tasks view guide](./progress-board.md) for details.

<GuideIntroHero />

<p class="hero-caption">The Tasks view streams progress live (helper agents and tool calls) alongside the output files.</p>

### Review results

1. When the program completes, VS Code opens the final revision from run storage (for `edit`, `r1/draft.tex`, keeping your input filename).
2. Inspect the proposed edits; the scientific judgment stays yours. Compare original and modified versions with either tool:
   - **Tasks view diff**: Under **Generated files**, select <wa-icon library="texra" name="code-compare"></wa-icon> **Compare with base** to diff the original against the generated output.

     <CompareHero />

     <p class="hero-caption">VS Code's diff editor opens the generated revision beside your original: additions in green, removals in red.</p>

     You can accept reviewed outputs from the Tasks view after comparing the changes.

   - **latexdiff**: Use a file's latexdiff button, or **latexdiff…** in the panel's **⋯** menu, for a compiled PDF with additions in blue and deletions in red.

<div class="quick-pdf-viewer">
  <div class="pdf-tabs">
    <button type="button" class="pdf-tab active" data-pdf="/examples/draft.pdf">Original</button>
    <button type="button" class="pdf-tab" data-pdf="/examples/draft_polish_r0_gemini25p_diff.pdf">Revision 1 Changes</button>
    <button type="button" class="pdf-tab" data-pdf="/examples/draft_polish_r1_gemini25p_diff.pdf">Revision 2 Changes</button>
    <button type="button" class="pdf-tab" data-pdf="/examples/draft_polish_r1_gemini25p_diffr1r0.pdf">Revision 1 vs Revision 2</button>
  </div>
  <iframe src="/examples/draft.pdf" id="pdf-frame" class="quick-pdf-frame"></iframe>
  <a href="/examples/draft.pdf" target="_blank" id="pdf-link" class="quick-pdf-link">Open full example</a>
</div>

<div class="quick-legend">
  <div class="legend-item"><span class="del">Red strikethrough</span>: Removed content</div>
  <div class="legend-item"><span class="add">Blue underlined</span>: Added/improved content</div>
</div>

For details on how LaTeX diff works, read the [LaTeX diff guide](./latex-diff.md).

## From the CLI

The same assistant and programs run from the terminal. After
`npm install -g @texra-ai/cli` (Node.js 22.22.2 or later in 22.x, or Node.js 24.15 or later) or
`brew install texra-ai/tap/texra`:

```bash
# Set ANTHROPIC_API_KEY / OPENAI_API_KEY in your shell, or connect a subscription:
texra auth chatgpt login

# Or let the guided setup handle credentials, environment, and your first task:
texra setup

# One-shot run (prints the revised file's path; --output copies it to a file you name):
texra run edit --input draft.tex \
  --instruction "Improve clarity; preserve math and citations."

# Or open an interactive chat:
texra chat
```

::: tip Included API credits on paid plans
Claude Max/Team and ChatGPT Pro/Business subscriptions include monthly API credits that an ordinary provider API key can spend; see [Getting API keys](./installation.md#setting-up-api-keys).
:::

<CliRunHero
  command='texra run edit --input draft.tex --instruction "Improve clarity; preserve math and citations."'
  :rounds="[
    { label: 'Revision 1: draft', state: 'done' },
    { label: 'Revision 2: review and correct', state: 'done' },
  ]"
  :outputs="['…/executions/9f3a6c81d24e/r1/draft.tex']"
/>

<p class="hero-caption">What a one-shot run looks like: revisions stream as progress, then the full path to the revised document prints on stdout.</p>

Task history is shared across the CLI, VS Code extension, and desktop app, so a
task started in the CLI shows up in the Tasks view (and vice versa). Read the
[TeXRA CLI guide](./texra-cli.md) for sign-in, project defaults, and headless
output formats.

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

## Common quick tasks

Some common tasks to try with TeXRA. Ask the assistant in the New task view, or run the program from the terminal:

| Task                        | Ask the assistant                                                     | From the terminal                                                                  |
| :-------------------------- | :-------------------------------------------------------------------- | :--------------------------------------------------------------------------------- |
| Proofread a draft           | "Proofread draft.tex: fix typos, grammar and LaTeX formatting only."  | `texra run edit --input draft.tex`                                                 |
| Polish writing style        | "Polish draft.tex for clarity and flow; keep the math and citations." | `texra run edit --input draft.tex --instruction "Polish for clarity and flow"`     |
| Review as a first reader    | "Annotate draft.tex as a first-time reader would."                    | `texra run annotate --input draft.tex --instruction "Read as a first-time reader"` |
| Build slides from the paper | "Turn paper.tex into a slide deck."                                   | `texra run slides --input paper.tex --output slides.tex`                           |

## Understanding the output

A completed task writes everything into its run folder, one folder per revision (`r0/`, `r1/`, …). Each revision holds the revised document (keeping your **input filename**, e.g. `draft.tex`) and raw reply (`output.xml`); `latexdiff` files go under `diff/r{revision}/`, compiled PDFs under `output/r{revision}/`, and compile logs under `compile/`:

<OutputArtifactsTree />

<p class="hero-caption">One folder per revision: revised document at <code>r{revision}/&lt;input-filename&gt;</code> with the model's reply; <code>latexdiff</code> files under <code>diff/</code>, compiled PDFs under <code>output/</code>, and compile logs under <code>compile/</code>.</p>

The CLI writes the same per-revision tree under `executions/<run-id>/` in the
project's storage folder under `~/.texra`, which VS Code shares. Read [First run](./first-run.md) for the terminal walkthrough.

## Next steps

After your first task with TeXRA, you can:

- Explore the [programs](./programs.md) for specialized tasks
- Learn about [LaTeX diff](./latex-diff.md) for comparing document versions
- Use [intelligent merge](./intelligent-merge.md) to combine changes
- Tune your workflow with [custom configuration](./configuration.md)

For issues or questions, read the [troubleshooting guide](/guide/troubleshooting) or check the [GitHub issues page](https://github.com/LionSR/TeXRA/issues).
