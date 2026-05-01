# TeXRA: AI TeX Research Assistant for VS Code

[![VS Code Marketplace](https://vsmarketplacebadges.dev/version-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Installs](https://vsmarketplacebadges.dev/installs-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Downloads](https://vsmarketplacebadges.dev/downloads-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Rating](https://vsmarketplacebadges.dev/rating-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Open VSX Version](https://img.shields.io/open-vsx/v/texra-ai/texra)](https://open-vsx.org/extension/texra-ai/texra)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/texra-ai/texra)](https://open-vsx.org/extension/texra-ai/texra)
[![License](https://img.shields.io/badge/license-Proprietary-blue)](LICENSE)

> **🎓 Free for Researchers!** TeXRA offers a **Researcher Access Program** with
> complimentary access to budget-friendly models from OpenAI, DeepSeek, Gemini,
> and more. Sign in through the Profile view to get started—no API keys
> required.

**TeXRA is a multi-agent research assistant for VS Code.** Instead of chatting
with a single model, you direct an **Orchestrator** that delegates to a team of
specialist agents—researchers, numericists, reviewers, formalizers, LaTeX
fixers, presenters—each with their own tools, prompts, and model. The result
is a coordinated lab in your editor that drafts, reviews, computes, formalizes,
and ships rigorous scientific work alongside its LaTeX, code, figures, and PRs.

See [texra.ai](https://texra.ai) or the
[full documentation](https://texra.ai/guide/) for tutorials, agent recipes, and
a web-based launch page.

## Why TeXRA

- **Orchestrator-first** – a built-in **Orchestrator** agent decomposes your
  task, delegates to the right specialists in parallel, captures their outputs
  as diffs, and presents proposals you approve before they touch your files.
  Follow-ups during delegation are queued, sub-agents can be paused, resumed,
  inspected, or terminated, and the orchestrator builds long-term memory
  across sessions.
- **Curated team presets** – ship as a **Physicist**, **Mathematician**,
  **Computer Scientist (ML)**, or **Lean Project** team in one click—each a
  preconfigured roster of workflow and tool-use agents tuned for that
  discipline. Save your own teams from the Multi-Agent settings tab.
- **A full cast of specialists** – `research`, `numerics`, `review`,
  `search`, `presenter`, `simplifier`, `latexFixer`, `creator`, `lean` /
  `leanSearch` / `leanSimplifier` / `leanBlueprint`, plus workflow agents for
  `correct`, `polish`, `criticize`, `devise`, `apply`, `merge`, OCR, audio
  transcription, paper-to-slide, and paper-to-poster.
- **Tools & MCP** – every agent runs in a sandboxed tool-use loop with
  workspace file edits, shell commands, LaTeX builds, `latexdiff` / `texcount`
  / TikZ tooling, Git and GitHub PR workflows, Codex CLI handoff, web
  research, and external Model Context Protocol servers.
- **Live, replayable runs** – the **progress board** shows every active and
  past run with streaming reasoning, sub-agent file diffs, cost and tool
  metrics, and one-click replay. Pack a run into `History/` for a clean
  audit trail.
- **Model flexibility with guardrails** – mix and match per agent: OpenAI
  (incl. GPT-5.5 and GPT Pro), Anthropic (incl. Claude Opus 4.7), Google
  Gemini, DeepSeek, xAI Grok, Moonshot Kimi, Alibaba Qwen, Zhipu GLM,
  MiniMax, OpenRouter, and custom endpoints—with context management,
  retry/backoff, parallel-tool-call limits, and cost monitoring all
  configurable.

## Built-in Agent Teams

| Team                        | What the team does                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Physicist**               | Analytical derivations, numerical experiments, literature search, slide drafting, and critical review. |
| **Mathematician**           | Proofs, Lean 4 formalization, research, and LaTeX correction.                                          |
| **Computer Scientist (ML)** | Algorithm design, experiments and ablations, literature search, critical review, and reproducibility.  |
| **Lean Project**            | Lean 4 projects—theorem search, tactic simplification, and blueprint-driven formalization.             |

Switch teams from the Multi-Agent tab in Settings, or build your own roster of
workflow and tool-use agents.

## Quick Start

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
   or [Open VSX](https://open-vsx.org/extension/texra-ai/texra).
2. Run **`TeXRA: Run Setup Assistant Agent`** from the command palette, or
   click **Get Started** in the status bar, to walk through environment
   checks, missing tools, and model access.
3. Pick an agent **team** in Settings → Multi-Agent (Physicist, Mathematician,
   CS/ML, or Lean Project), or stay with the default lineup.
4. Open the TeXRA sidebar, select the **Orchestrator**, describe your task,
   and approve the proposals it routes to specialists. Watch progress, file
   diffs, and live reasoning on the **progress board**, and follow up at any
   time—messages are queued for whichever sub-agent needs them.

New here? **`TeXRA: Create Sample Project`** spins up a fully configured
workspace to experiment in.

## Requirements

- **VS Code** 1.105+ (or a compatible editor such as VSCodium / Cursor)
- **LaTeX distribution** (TeX Live, MiKTeX, or MacTeX) for compilation and
  related tooling
- **Perl** (required by `latexindent` and `latexdiff`)
- **Optional**: GraphicsMagick/ImageMagick and Ghostscript for PDF and image
  processing; `git` for repository-aware features; `gh` and a Codex CLI for
  GitHub PR and Codex integrations; Lean 4 + `lake` for the Lean Project team

## Configuring Models

Sign in through the Profile view to use the Researcher Access Program, or set
your own API keys in VS Code settings or a workspace `.env` file:

```env
OPENAI_API_KEY=your_openai_key_here
ANTHROPIC_API_KEY=your_anthropic_key_here
GEMINI_API_KEY=your_gemini_key_here
DEEPSEEK_API_KEY=your_deepseek_key_here
XAI_API_KEY=your_xai_key_here
OPENROUTER_API_KEY=your_openrouter_key_here
```

TeXRA loads the `.env` file automatically at startup. Each agent in a team can
use a different model, so you can pair a flagship reasoner for the orchestrator
with cheaper, faster models for routine sub-tasks. See the
[installation guide](https://texra.ai/guide/installation.html) and the
[models guide](https://texra.ai/guide/models.html) for details.

## Customization

Configure agents, prompts, models, and reliability policy in VS Code settings
or the unified Settings view (History, Memory, Models, Agents, Multi-Agent,
LaTeX, Tools tabs). The Multi-Agent tab covers team presets, parallel
tool-call limits, compaction thresholds, retry/backoff, and the orchestrator
kill toggle. Power users can define new workflow or tool-use agents in YAML,
register new model handlers, or wire up additional MCP servers.

## Support & Feedback

Report issues and feature requests on the
[GitHub issues page](https://github.com/texra-ai/texra-issues/issues) or email
[contact@texra.ai](mailto:contact@texra.ai).

## License

© TeXRA Team 2025–2026. All rights reserved.

[Terms of Service](TERMS_OF_SERVICE.md) · [Provider List](https://texra.ai/providers)
