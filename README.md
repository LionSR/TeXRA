# TeXRA: Multi-Agent AI Research Assistant for TeX

[![VS Code Marketplace](https://vsmarketplacebadges.dev/version-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Installs](https://vsmarketplacebadges.dev/installs-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Downloads](https://vsmarketplacebadges.dev/downloads-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Rating](https://vsmarketplacebadges.dev/rating-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Open VSX Version](https://img.shields.io/open-vsx/v/texra-ai/texra)](https://open-vsx.org/extension/texra-ai/texra)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/texra-ai/texra)](https://open-vsx.org/extension/texra-ai/texra)
[![License](https://img.shields.io/badge/license-Proprietary-blue)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@texra-ai/cli?label=%40texra-ai%2Fcli)](https://www.npmjs.com/package/@texra-ai/cli)
[![npm downloads](https://img.shields.io/npm/dm/@texra-ai/cli)](https://www.npmjs.com/package/@texra-ai/cli)

> **🎓 Free for Researchers!** TeXRA offers a **Researcher Access Program** with
> complimentary access to budget-friendly models from OpenAI, DeepSeek, Gemini,
> and more—plus a hosted **Orchestrator** and a roster of remote specialist
> agents. Sign in through the Profile view to get started—no API keys
> required.
>
> The relay runs on sponsor credits. If TeXRA helps your research, please
> consider supporting it via
> [GitHub Sponsors](https://github.com/sponsors/texra-ai) or
> [Buy Me a Coffee](https://buymeacoffee.com/texra.ai) to keep the program
> open for everyone.

**TeXRA is a multi-agent research assistant for LaTeX — in VS Code and the
terminal.** Instead of chatting with a single model, you direct an
**Orchestrator** that delegates to a team of specialists—researchers,
numericists, reviewers, formalizers, LaTeX fixers, presenters—each with their
own tools, prompts, and model. The result is a coordinated lab that drafts,
reviews, computes, and formalizes rigorous scientific work alongside its LaTeX,
code, figures, and PRs.

TeXRA runs as a **VS Code extension** and as a **terminal CLI**
(`@texra-ai/cli`) that share the same agents and sign-in — see
[Use TeXRA from the terminal](#use-texra-from-the-terminal) below.

See [texra.ai](https://texra.ai) or the
[full documentation](https://texra.ai/guide/) for tutorials, agent recipes, and
a web-based launch page.

## Why TeXRA

- **Orchestrator-first** – the **Orchestrator** decomposes your task,
  delegates to specialists in parallel, captures their outputs as diffs, and
  presents proposals you approve before they touch your files. Follow-ups
  during delegation are queued, sub-agent runs can be inspected, waited on,
  resumed, or terminated, and the orchestrator builds long-term memory across
  sessions.
- **Curated team presets** – switch to **Physicist**, **Mathematician**,
  **Computer Scientist (ML)**, or **Lean Project** in one click from the
  Multi-Agent settings tab. Each preset is a preconfigured roster of workflow
  and tool-use agents tuned for that discipline; you can also save your own.
- **A full cast of specialists** – locally bundled tool-use agents include
  `research`, `numerics`, `review`, `presenter`, `latexFixer`, `latexDiff`,
  `creator`, `lean`, `chat`, and the **Setup Wizard** (`setup`); workflow
  agents include `correct`, `polish`, `merge`, `ocr`, `transcribe_audio`,
  `paper2slide`, and `paper2poster`. Signing in unlocks remote specialists—
  `orchestrator`, `search`, `simplifier`, `criticize`, `devise`, `apply`,
  `generic`, `progressCheck`, and the Lean `leanOrchestrator` /
  `leanBlueprint` / `leanSearch` / `leanSimplifier` line.
- **Tools that touch your project** – tool-use agents read and edit
  workspace files, run shell commands, drive LaTeX builds, work with Git and
  GitHub PR subscriptions, and can delegate reasoning turns to the Codex
  CLI—each tool call gated by per-stream approval (with an optional YOLO
  bypass).
- **Live, persistent runs** – the **progress board** streams reasoning, tool
  calls, sub-agent file diffs, and per-run token usage and cost for active
  and recently completed runs in your workspace. Saved task state can be
  reopened later via **Show Agent Execution History**, tool-use agents can
  be resumed via **Resume Tool-Use Agent**, and **Pack Output into History
  Folder** archives a finished run's outputs into the workspace's `History/`
  directory.
- **Odyssey mode (experimental)** – let a tool-use agent run a long task to
  completion on its own. A configurable budget auto-pauses the run for your
  approval before going further, and a dedicated panel shows progress so
  you can step in at any time. Off by default; enable it with the
  `texra.experimental.odyssey.enabled` VS Code setting.
- **Model flexibility with guardrails** – mix and match per agent: OpenAI
  (incl. GPT-5.5 and GPT Pro), Anthropic (incl. Claude Opus 4.7), Google
  Gemini, DeepSeek, xAI Grok, Moonshot Kimi, Alibaba Qwen (DashScope),
  Zhipu GLM, MiniMax, OpenRouter, and custom endpoints—with context
  management, retry/backoff, parallel-tool-call limits, and cost monitoring
  all configurable.

## Built-in Agent Teams

| Team                        | What the team does                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Physicist**               | Analytical derivations, numerical experiments, literature search, slide drafting, and critical review. |
| **Mathematician**           | Proofs, Lean 4 formalization, research, and LaTeX correction.                                          |
| **Computer Scientist (ML)** | Algorithm design, experiments and ablations, literature search, critical review, and reproducibility.  |
| **Lean Project**            | Lean 4 projects—theorem search, tactic simplification, and blueprint-driven formalization.             |

Switch teams from the Multi-Agent tab in Settings, or build your own roster of
workflow and tool-use agents. Teams that include remote specialists (e.g. the
Orchestrator, `search`, `simplifier`) require sign-in or your own API keys
configured for the providers those agents use.

## Quick Start

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
   or [Open VSX](https://open-vsx.org/extension/texra-ai/texra).
2. Launch the **Setup Wizard**. Pick whichever is easiest:
   - Click the **🚀 TeXRA: Get Started** pill in the status bar (shown
     automatically until you sign in or add an API key).
   - Click **Run the setup assistant agent** in the Getting Started banner
     at the top of the TeXRA sidebar.
   - Open VS Code's **Welcome / Walkthroughs** page and pick **TeXRA:
     Getting Started** — Step 1 is a one-click button.
   - Or, from the command palette, run
     **`TeXRA: Run Setup Assistant Agent (Setup Wizard)`**.

   The Setup Wizard diagnoses your environment, installs missing LaTeX
   tooling, helps you sign in or add an API key, and verifies you're ready
   to run agents—asking before every command and explaining what it's
   doing. It can hand off interactive `sudo` prompts and installers to your
   VS Code terminal.

3. Pick an agent **team** in Settings → Multi-Agent (Physicist,
   Mathematician, CS/ML, or Lean Project), or stay with the default lineup.
4. Open the TeXRA sidebar, select the **Orchestrator** (or any agent),
   describe your task, and approve the proposals it routes to specialists.
   Watch progress, file diffs, and live reasoning on the **progress board**,
   and follow up at any time—messages are queued for whichever sub-agent
   needs them.

New here? Use the **Create Sample Project** button in the Getting Started
banner (also available as `TeXRA: Create Sample Project` from the command
palette) to spin up a fully configured workspace.

## Use TeXRA from the terminal

TeXRA also ships as a standalone CLI for running the same agents on your `.tex`
projects without an editor — useful for scripts, CI, and remote machines.

```sh
npm install -g @texra-ai/cli   # requires Node.js >= 22
texra --help
```

Authenticate the same way as the extension — sign in for the Researcher Access
Program, or use your own provider keys (environment or a workspace `.env`, same
`<PROVIDER>_API_KEY` convention as [Configuring Models](#configuring-models)
below):

```sh
texra login      # included access; or set <PROVIDER>_API_KEY and pass --api-mode personal
texra doctor     # verify environment, sign-in, models, and LaTeX tooling
```

Run a workflow agent, or start an interactive tool-use session:

```sh
texra run polish --input paper.tex --output paper.polished.tex --print
texra chat
```

Use `--output-format json|ndjson` for scriptable output, and `texra history` to
inspect or resume stored runs. See the
[documentation](https://texra.ai/guide/) for the full command reference.

## Requirements

- **VS Code** 1.105+ (also runs in compatible editors such as Cursor,
  Windsurf, and Google Antigravity)
- **LaTeX distribution** (TeX Live, MiKTeX, or MacTeX) for compilation and
  related tooling
- **Perl** (required by `latexindent` and `latexdiff`)
- **Optional**: GraphicsMagick/ImageMagick and Ghostscript for PDF and image
  processing; `git` for repository-aware features; `gh` and a Codex CLI for
  GitHub PR and Codex integrations; Lean 4 + `lake` for the Lean Project team

The Setup Wizard checks for and helps install most of the above for you.

## Configuring Models

Sign in through the Profile view to use the Researcher Access Program (which
also unlocks the hosted Orchestrator and remote specialists), or store your
own API keys via the **`TeXRA: Set API Key`** command (kept in VS Code's
encrypted SecretStorage), or place them in a workspace `.env` file:

```env
OPENAI_API_KEY=your_openai_key_here
ANTHROPIC_API_KEY=your_anthropic_key_here
GOOGLE_API_KEY=your_google_key_here
DEEPSEEK_API_KEY=your_deepseek_key_here
XAI_API_KEY=your_xai_key_here
OPENROUTER_API_KEY=your_openrouter_key_here
```

Other supported providers follow the same `<PROVIDER>_API_KEY` convention:
`MOONSHOT_API_KEY`, `DASHSCOPE_API_KEY` (Qwen), `MINIMAX_API_KEY`,
`GLM_API_KEY`. TeXRA loads the `.env` file automatically at startup. Each
agent in a team can use a different model, so you can pair a flagship reasoner
for the orchestrator with cheaper, faster models for routine sub-tasks. See
the [installation guide](https://texra.ai/guide/installation.html) and the
[models guide](https://texra.ai/guide/models.html) for details.

## Customization

Configure agents, prompts, models, and reliability policy in VS Code settings
or the unified Settings view (Memory, History, Models, Agents, Multi-Agent,
Tools, Git, LaTeX tabs). The Multi-Agent tab covers team presets, parallel
tool-call limits, compaction thresholds, retry/backoff, and the orchestrator
kill toggle. Power users can define new workflow or tool-use agents in YAML
or register new model handlers.

## Support & Feedback

Report issues and feature requests on the
[GitHub issues page](https://github.com/texra-ai/texra-issues/issues) or email
[contact@texra.ai](mailto:contact@texra.ai).

## License

© TeXRA Team 2025–2026. All rights reserved.

[Terms of Service](TERMS_OF_SERVICE.md) · [Provider List](https://texra.ai/providers)
