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
`texra run annotate --input draft.tex`.
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

### Approve what it proposes

The assistant edits your files itself and asks before each change under your
approval policy. For a job one of the [programs](./programs.md) packages
(`annotate` for a referee's comments, `prove` for Lean proofs) it proposes a
program run: the proposal card shows the program, the instruction and the
files. Approve it, or select **Edit** to change the files first.

### Start the task and watch it

Select **Start task** (<wa-icon library="texra" name="arrow-up"></wa-icon>). The Tasks view opens in the TeXRA panel and streams progress live. Read the [Tasks view guide](./progress-board.md) for details.

<GuideIntroHero />

<p class="hero-caption">The Tasks view streams progress live (helper agents and tool calls).</p>

### Review results

The files in your project are the result. Open them in the editor, or run
`git diff`, to see what changed; ask the assistant for a `latexdiff` PDF when
you want the changes marked up in the compiled document.

## From the CLI

The same assistant and programs run from the terminal. After
`npm install -g @texra-ai/cli` (Node.js 22.22.2 or later in 22.x, or Node.js 24.15 or later) or
`brew install texra-ai/tap/texra`:

```bash
# Set ANTHROPIC_API_KEY / OPENAI_API_KEY in your shell, or connect a subscription:
texra auth chatgpt login

# Or let the guided setup handle credentials, environment, and your first task:
texra setup

# One-shot run: the assistant edits draft.tex in place and prints its answer.
texra run chat \
  --instruction "Improve the clarity of draft.tex; preserve math and citations." --print

# Or open an interactive chat:
texra chat
```

::: tip Included API credits on paid plans
Claude Max/Team and ChatGPT Pro/Business subscriptions include monthly API credits that an ordinary provider API key can spend; see [Getting API keys](./installation.md#setting-up-api-keys).
:::

Task history is shared across the CLI, VS Code extension, and desktop app, so a
task started in the CLI shows up in the Tasks view (and vice versa). Read the
[TeXRA CLI guide](./texra-cli.md) for sign-in, project defaults, and headless
output formats.

## Common quick tasks

Some common tasks to try with TeXRA. Ask the assistant in the New task view, or run the program from the terminal:

| Task                     | Ask the assistant                                                     | From the terminal                                                                               |
| :----------------------- | :-------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------- |
| Proofread a draft        | "Proofread draft.tex: fix typos, grammar and LaTeX formatting only."  | `texra run chat --instruction "Proofread draft.tex: typos, grammar and LaTeX formatting only."` |
| Polish writing style     | "Polish draft.tex for clarity and flow; keep the math and citations." | `texra run chat --instruction "Polish draft.tex for clarity and flow."`                         |
| Review as a first reader | "Annotate draft.tex as a first-time reader would."                    | `texra run annotate --input draft.tex --instruction "Read as a first-time reader"`              |
| Build slides             | "Turn paper.tex into a Beamer slide deck, slides.tex."                | `texra run chat --instruction "Turn paper.tex into a Beamer slide deck, slides.tex."`           |

## Understanding the output

A task changes the files in your project, so your editor and `git diff` show
its result. Each task also has a run folder under `executions/<run-id>/` in
the project's storage folder under `~/.texra`, shared by the CLI, VS Code
and the desktop app, which holds its conversation and logs. Read
[First run](./first-run.md) for the terminal walkthrough.

## Next steps

After your first task with TeXRA, you can:

- Explore the [programs](./programs.md) for specialized tasks
- Learn about [LaTeX diff](./latex-diff.md) for comparing document versions
- Tune your workflow with [custom configuration](./configuration.md)

For issues or questions, read the [troubleshooting guide](/guide/troubleshooting) or check the [GitHub issues page](https://github.com/LionSR/TeXRA/issues).
