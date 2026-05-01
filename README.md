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

TeXRA brings large language models to rigorous scientific workflows. The
extension embeds research-grade agents directly in VS Code so you can draft,
review, and manage LaTeX projects—and the surrounding research code, figures,
and pull requests—without leaving your editor.

See [texra.ai](https://texra.ai) or the
[full documentation](https://texra.ai/guide/) for tutorials, agent recipes, and
a web-based launch page.

## Why TeXRA

- **Reliable scientific workflow** – orchestrate literature review, drafting,
  revision, and figure work with reproducible agent runs, structured logs, and
  built-in verification tools like `latexdiff` and `texcount`.
- **Specialized research agents** – built-in agents for correcting LaTeX,
  polishing prose, generating TikZ figures, transcribing audio, OCR, slide and
  poster authoring, intelligent merging, numerical experiments, and Lean proof
  work.
- **Multi-agent orchestration** – team presets (including a Computer Scientist
  ML preset) coordinate research, numerics, review, and search agents with
  clearer proposals and handoffs. The orchestrator delegates to the right
  specialist and keeps follow-ups flowing while sub-agents work.
- **Tool-use & MCP** – tool-use agents read and edit workspace files, run
  shell commands, drive LaTeX builds, work with Git and GitHub PRs, and
  connect to external Model Context Protocol servers.
- **Transparent reasoning loops** – inspect live reasoning, replay sessions
  from the progress board, and compare outputs across models to build trust in
  the generated work.
- **Model flexibility with guardrails** – connect to OpenAI (incl. GPT-5.5
  and GPT Pro), Anthropic (incl. Claude Opus 4.7), Google Gemini, DeepSeek,
  xAI Grok, Moonshot Kimi, Alibaba Qwen, Zhipu GLM, MiniMax, OpenRouter, and
  custom endpoints—while keeping API routing, context management, and cost
  monitoring under your control.

## Quick Start

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
   or [Open VSX](https://open-vsx.org/extension/texra-ai/texra).
2. Run **`TeXRA: Run Setup Assistant Agent`** from the command palette, or
   click **Get Started** in the status bar, to walk through environment
   checks, missing tools, and model access.
3. Run **`TeXRA: Create Sample Project`** to explore a fully configured
   workspace, or open one of the built-in walkthroughs.
4. Open the TeXRA sidebar, pick an agent, select your files, and click
   **Execute**. Use chat for follow-ups with tool-use agents, and the
   progress board to monitor and replay runs.

## Requirements

- **VS Code** 1.105+ (or a compatible editor such as VSCodium / Cursor)
- **LaTeX distribution** (TeX Live, MiKTeX, or MacTeX) for compilation and
  related tooling
- **Perl** (required by `latexindent` and `latexdiff`)
- **Optional**: GraphicsMagick/ImageMagick and Ghostscript for PDF and image
  processing; `git` for repository-aware features; `gh` and a Codex CLI for
  GitHub PR and Codex integrations

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

TeXRA loads the `.env` file automatically at startup. For detailed setup
instructions, see the [installation guide](https://texra.ai/guide/installation.html)
and the [models guide](https://texra.ai/guide/models.html).

## Customization

Configure available agents, prompts, and model parameters in VS Code settings
or the unified Settings view (History, Memory, Models, Agents, Multi-Agent,
LaTeX, Tools tabs). You can tailor directories, file types, output locations,
and more to suit your workflow. Advanced users can define custom agents in
YAML or extend the extension with new model handlers.

## Support & Feedback

Report issues and feature requests on the
[GitHub issues page](https://github.com/texra-ai/texra-issues/issues) or email
[contact@texra.ai](mailto:contact@texra.ai).

## License

© TeXRA Team 2025–2026. All rights reserved.

[Terms of Service](TERMS_OF_SERVICE.md) · [Provider List](https://texra.ai/providers)
