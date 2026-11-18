<script setup>
import OutputArtifactsTree from '../.vitepress/components/OutputArtifactsTree.vue';
import CliRunHero from '../.vitepress/components/CliRunHero.vue';
</script>

# Quick start guide

On a fresh install, the **setup assistant** walks you through connecting a model, checking your environment, and running a first task. This page is the reference for the **New task** view in VS Code and its CLI equivalents.

<QuickStartHero />

<p class="hero-caption">The New task view: pick an agent and a model, write one sentence that names your file, and select Start task.</p>

## Overview

Editing a document typically takes five steps:

1. Pick an agent and model
2. Write a short instruction that names your file
3. Select **Start task**
4. Approve the program run the agent proposes
5. Review the diff

> 💡 **Tip:** Inside VS Code you can open the **Get started with TeXRA** walkthrough from the Get Started page
> (or by running `TeXRA: Open Getting Started Walkthrough`). It tells the same story in four steps (connect a
> model, open your paper, run the setup assistant, your first task) and links directly to the relevant commands.

::: tip Prefer the terminal?
This guide walks through the VS Code extension. If you installed the
[CLI](./texra-cli.md), the same agents run from the command line: start an
interactive session with `texra chat`, or run a single program with
`texra run edit --input draft.tex`. Run `texra agents list` to see the agents
available.
:::

## Add a key or connect a subscription

A credential is the one step no agent can do for you. On a fresh install, the **Connect a model** card in the
TeXRA panel offers the two main access choices; other subscriptions connect from Settings:

1. **Use your own API keys**: Anthropic, OpenAI, Google, and more. Open the **Models** page
   (the <wa-icon library="texra" name="settings-gear"></wa-icon> gear icon at the top of the TeXRA panel) and
   set your provider's key in the **API keys** list, or place a `.env` file in your workspace with
   variables like `OPENAI_API_KEY`.
2. **Use ChatGPT subscription**: OpenAI models through your ChatGPT plan. Open the Settings **Models**
   page and use the **Subscriptions** sign-in section.
3. **Another provider subscription** (from Settings, not the card): Grok (xAI), Kimi Code, and the GLM Coding Plan also run on a plan you
   already pay for. Connect them from the same **Models** page.

The full per-provider key reference (the API Configuration table, Set / Get / Remove actions, and per-provider toggles) lives in [Models → Setting API keys](./models.md#setting-api-keys).

::: tip No TeXRA account
There is no TeXRA sign-in. Every agent and program ships
bundled and runs on the credential you configured above.
:::

Once a credential is in place, the setup assistant takes it from here: one conversation that checks your environment and runs your first polish, ending at a diff. [First run](./first-run.md) is the manual mirror of that conversation.

::: tip CLI credentials
The terminal uses the same paths: provider env vars for your own keys,
`texra auth chatgpt login` for a ChatGPT subscription, `texra auth grok login`
for a Grok (xAI) subscription, or `/login` in a chat to pick among connected
subscriptions. Running `texra` without any of these opens the chat with a
**Connect a model** panel instead of an error. `texra setup` is the terminal counterpart of the setup
assistant: it walks you through a ChatGPT sign-in or an API key, then your
environment, agents, and first task. Read the
[Authentication section](./texra-cli.md#authentication) of the CLI guide.
:::

## The New task view in detail

Open the TeXRA panel from the TeXRA icon in the Secondary Side Bar, or run **TeXRA: New Task**
(`Ctrl+Alt+M`, `Cmd+Option+M` on macOS).

### Choose agent, model, and instruction

The dropdown menus at the bottom of the instruction box pick the agent and the
model (e.g. `anthropic/claude-sonnet-5-5`). The agent menu lists each agent
once, then your teams. Every agent chats; the default, `orchestrator`, is the
one to ask for a document edit.

Then say what you want, and on which file, in the text area:

```
Polish main.tex: improve the clarity and flow, and make the technical
explanations more accessible. Fix grammatical issues and awkward phrasing.
Keep the terminology consistent and do not change the equations.
```

::: tip Effective Instructions
Be specific about your objectives: state both what the agent should improve and what constraints (notation, theorem numbering, environment structures) it must preserve.
:::

To send figures or other media along, use **Attach** in the instruction box.

### Approve the program run

The New task view does not list programs and has no file section of its own.
For a document edit, the agent proposes a run of one of the
[programs](./built-in-agents.md#programs) (`edit` for a polish), and the
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

::: tip Save Prompts for Later
For advanced debugging, enable the `texra.debug.saveModelIO` setting in `.texra/config.json` to store the generated prompt alongside other debug artifacts.
:::

### Start the task and watch it

Select **Start task** (<wa-icon library="texra" name="arrow-up"></wa-icon>). The ProgressBoard opens in the TeXRA view and streams the run live. Read the [ProgressBoard guide](./progress-board.md) for help interpreting the logs.

<GuideIntroHero />

<p class="hero-caption">The ProgressBoard streams the run live (delegated subagents and the tool calls) with the output files alongside.</p>

### Review results

1. When the program's run completes, VS Code opens the generated output file from the run folder (e.g., `r0/draft.tex`, keeping your input filename).
2. Inspect the proposed edits; the scientific judgment stays yours. Compare the original and modified versions with either tool:
   - **ProgressBoard Diff**: Under **Generated files**, select a file's <wa-icon library="texra" name="code-compare"></wa-icon> **Compare with base** button to compare the original file against the generated run-storage output.

     <CompareHero />

     <p class="hero-caption">VS Code's diff editor opens with your original on the left and the first revision (<code>r0/draft.tex</code>) on the right: removed text in red, improved text in green.</p>

     You can accept reviewed outputs from the ProgressBoard after comparing the changes.

   - **TeXRA's LaTeXdiff feature**: Use a file's latexdiff button, or **LaTeXDiffs…** in the panel's **⋯** menu, for a compiled, visual comparison. It creates a PDF with additions highlighted in blue and deletions in red.

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

The same agents and programs run from the terminal. After
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

:::: tip
A Claude Max or Team plan includes [monthly API credits](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers) that an
Anthropic API key can spend once you link a Console organization to the plan.
A ChatGPT Pro or Business plan includes [monthly API credits](https://help.openai.com/en/articles/20001626-api-credits-benefit-for-eligible-chatgpt-subscriptions)
that an OpenAI API key can spend once you claim them for an API organization
you own.
::::

<CliRunHero
  command='texra run edit --input draft.tex --instruction "Improve clarity; preserve math and citations."'
  :rounds="[
    { label: 'r0: draft revision', state: 'done' },
    { label: 'r1: review and correct', state: 'done' },
  ]"
  :outputs="['executions/9f3a6c81d24e/r1/draft.tex']"
/>

<p class="hero-caption">What a one-shot run looks like: revisions stream as progress, then the path to the revised document prints on stdout.</p>

Run history is shared with VS Code, so a run started in the CLI shows up in the
extension's ProgressBoard (and vice versa). Read the [TeXRA CLI guide](./texra-cli.md) for
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

## Common quick tasks

Some common tasks to try with TeXRA. Ask the agent in the New task view, or run the program from the terminal:

| Task                        | Ask the agent                                                         | From the terminal                                                                  |
| :-------------------------- | :-------------------------------------------------------------------- | :--------------------------------------------------------------------------------- |
| Proofread a draft           | "Proofread draft.tex: fix typos, grammar and LaTeX formatting only."  | `texra run edit --input draft.tex`                                                 |
| Polish writing style        | "Polish draft.tex for clarity and flow; keep the math and citations." | `texra run edit --input draft.tex --instruction "Polish for clarity and flow"`     |
| Review as a first reader    | "Annotate draft.tex as a first-time reader would."                    | `texra run annotate --input draft.tex --instruction "Read as a first-time reader"` |
| Build slides from the paper | "Turn paper.tex into a slide deck."                                   | `texra run slides --input paper.tex --output slides.tex`                           |

## Understanding the output

A completed run writes everything into the run folder under run storage, one
folder per revision (`r0/`, `r1/`, …). Each revision folder holds the revised document,
which keeps your **input filename** (`draft.tex`, not `output.tex`), and the model's raw
reply (`output.xml`); the run's latexdiff PDFs go under `diff/r{revision}/` and compile
logs under `compile/`:

<OutputArtifactsTree />

<p class="hero-caption">One folder per revision: the revised document at <code>r{revision}/&lt;input-filename&gt;</code> with the model's reply; latexdiff PDFs under <code>diff/</code> and compile logs under <code>compile/</code> sit beside the revision folders. Each further revision repeats the layout in <code>r1/</code>, <code>r2/</code>, …</p>

The CLI writes the same per-revision tree under `executions/<run-id>/` in the
workspace store. Read [First run](./first-run.md) for the terminal walkthrough.

## Next steps

After your first task with TeXRA, you can:

- Explore more [built-in agents](./built-in-agents.md) for specialized tasks
- Learn about [LaTeX diff](./latex-diff.md) for comparing document versions
- Use [intelligent merge](./intelligent-merge.md) to combine changes
- Tune your workflow with [custom configuration](./configuration.md)

For issues or questions, read the [troubleshooting guide](/guide/troubleshooting) or check the [GitHub issues page](https://github.com/LionSR/TeXRA/issues).
