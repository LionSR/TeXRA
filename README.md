# TeXRA: AI TeX Research Assistant for VS Code

TeXRA brings large language models to your academic writing workflow. The
extension embeds AI-powered agents directly in VS Code so you can draft,
revise, and manage LaTeX projects without leaving your editor.

See [texra.ai](https://texra.ai) or the
[full documentation](https://texra.ai/guide/) for tutorials and a web-based
launch page.

## Why TeXRA

- **AI agents for every task** – polish prose, fix LaTeX, draw TikZ, convert
  papers to slides, perform OCR, or chat with interactive tool-use agents that
  can search the web or run code. Follow up directly in the progress view.
- **Transparent streaming** – watch model reasoning stream separately from
  final responses for Claude, DeepSeek, o1, and more.
- **Progress view** – detailed logs, clickable references, syntax-highlighted
  code, re-run buttons, and status-bar updates. Helpful empty states guide new
  users, and a sample project command provides a ready-made example.
- **LaTeX-first workflow** – automatic figure extraction, PDF and image
  conversion, indentation, word counts, diffing, and multi-file selection. The
  extension detects TeX tools on all platforms and integrates with Overleaf and
  LaTeX Workshop.
- **Broad model support** – OpenAI (GPT‑5 family, GPT‑OSS), Anthropic (Claude
  Opus 4.1 and Sonnet), Google Gemini, DeepSeek, Moonshot (Kimi), DashScope
  (Qwen), GitHub Copilot, and more. Optional OpenRouter routing keeps API keys
  flexible.

## Quick Start

1. Install the extension from the VS Code Marketplace.
2. Run **`TeXRA: Create Sample Project`** from the command palette to explore a
   fully configured workspace.
3. Open the TeXRA sidebar, pick an agent, select your files, and click
   **Execute**. Follow-up chat is available for tool-use agents.

## Installation

Set your API keys in VS Code settings or a workspace `.env` file using variables
like `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY`. TeXRA loads the
file automatically at startup.

TeXRA relies on a LaTeX distribution and Perl. Optional tools such as
GraphicsMagick/ImageMagick and Ghostscript enable advanced PDF and image
handling. Refer to the
[installation guide](https://texra.ai/guide/installation.html) for platform
instructions.

## Customization

Configure available agents, prompts, and model parameters in VS Code settings.
You can tailor directories, file types, output locations, and more to suit your
workflow. Advanced users can define custom agents in YAML or extend the
extension with new model handlers.

## Support & Feedback

Report issues and feature requests on the
[GitHub issues page](https://github.com/texra-ai/texra-issues/issues) or email
[contact@texra.ai](mailto:contact@texra.ai).

## License

© TeXRA Team 2025. All rights reserved.
