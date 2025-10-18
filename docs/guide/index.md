# Introduction to TeXRA

Welcome to TeXRA, the TeX Research Assistant that thrives on dense notes, runaway proofs, and ambitious AI scientists. This guide walks you through the extension's worldview so you can put it to work inside VS Code without sacrificing rigor or your sense of humor.

<a href="https://marketplace.visualstudio.com/items?itemName=texra-ai.texra" target="_blank" style="display: inline-block; background-color: #007ACC; color: white; padding: 10px 15px; text-decoration: none; border-radius: 4px; font-weight: bold; margin: 10px 0;">Install from VS Code Marketplace</a>

## What is TeXRA?

TeXRA turns VS Code into a co-working space for theorists. Instead of a general-purpose chatbot, you get a disciplined AI scientist who understands LaTeX structure, keeps track of every tool call, and produces artifacts you can submit, cite, or critique. You orchestrate the context—inputs, references, figures, auxiliary files—while TeXRA's agents execute the heavy lifting with reproducible prompts and outputs.

## Operating principles

TeXRA is built around three research habits:

1. **Reflection** – Agents critique and revise their own drafts, catching loose indices and sloppy prose before you do.
2. **Tool use** – Runs can trigger utilities such as `latexdiff`, `texcount`, compilation checks, or even shell commands (inside the sandbox) to ground conclusions in actual data.
3. **Planning** – Chain-of-thought prompts keep derivations structured, so intermediate lemmas and aligned math blocks survive intact.

## Capabilities tuned for theorists

- **Conversational scouting** – Use the `ask` agent for read-only reconnaissance, then escalate to `chat` when you need edits, derivations, or code execution. The duo shares state but respects your safety rails. Dive deeper in the [Ask & Chat Guide](/guide/ask-chat).
- **Document surgery** – Agents such as `correct`, `polish`, `paper2slide`, and `draw` are tuned for LaTeX-heavy material, respecting citations, environments, and the signature chaos of collaborative manuscripts.
- **Derivation muscle** – The `derive` lineage outputs math in `\begin{aligned}` environments, making it painless to drop results back into your paper or notebook.
- **Reproducible trails** – Every run leaves prompts, tool logs, diffs, and outputs in the ProgressBoard, which doubles as your lab notebook for peer review (minus the lab coats).

## Conversational tooling, explained

The `ask` and `chat` agents are your default entry point. `ask` reads, searches, and reports; `chat` edits, executes tools, and writes files. They both obey workspace sandboxes and make their actions auditable in the run log. A typical workflow: scout a derivation with `ask`, promote the plan to `chat` for execution, then return to an editing agent like `polish` for stylistic cleanup.

## Who should use TeXRA?

TeXRA is happiest in the hands of:

- **AI scientists** prototyping new workflows while keeping detailed logs.
- **Theoretical physicists and mathematicians** who need derivations to land exactly where they left them.
- **Research engineers** wrangling multi-file LaTeX projects, auxiliary data, and figure generation in one place.
- **Methodologists and reviewers** who want to audit runs without reverse engineering an opaque prompt history.

## Getting started

Ready to put TeXRA to work? Continue with these next steps:

- [Installation](/guide/installation) – Configure the extension and API keys.
- [Quick Start](/guide/quick-start) – Run your first workflow, including the ask/chat duet.
- [Built-in Agents](/guide/built-in-agents.md) – Meet the roster you can run immediately.
- [Custom Agents](/guide/custom-agents.md) – Craft derivation-specific workflows tailored to your project.

## Data privacy & security

TeXRA keeps your manuscripts local. All API calls route directly from VS Code to the model provider you configure (Anthropic, OpenAI, Google, OpenRouter, and friends). No TeXRA-operated servers ever see your files or keys. Secrets live in VS Code's secure storage, and only the models you authorize receive your content. Always review each provider's policy, but rest assured: the extension itself isn't siphoning your notes.

Questions? Spot a bug? Email [contact@texra.ai](mailto:contact@texra.ai) and we'll investigate with appropriately stern eyebrows.
