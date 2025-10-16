# TeXRA: AI TeX Research Assistant for VS Code

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/texra-ai.texra)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![License](https://img.shields.io/badge/license-Proprietary-blue)](LICENSE)

TeXRA brings large language models to rigorous scientific workflows. The
extension embeds research-grade agents directly in VS Code so you can draft,
review, and manage LaTeX projects without leaving your editor.

See [texra.ai](https://texra.ai) or the
[full documentation](https://texra.ai/guide/) for tutorials and a web-based
launch page.

## Why TeXRA

- **Reliable scientific workflow** – orchestrate literature review, drafting,
  and revision with reproducible agent runs, structured logs, and built-in
  verification tools like `latexdiff` and `texcount`.
- **Specialized research agents** – deploy focused agents for correcting
  LaTeX, polishing prose, generating figures, and document transformation—without
  losing control over references and context.
- **Transparent reasoning loops** – inspect live reasoning, replay sessions,
  and compare outputs across models to build trust in the generated work.
- **Model flexibility with guardrails** – connect to OpenAI, Anthropic,
  DeepSeek, Gemini, Moonshot, Qwen, and custom endpoints while keeping
  API routing and cost monitoring under your control.

## Quick Start

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra).
2. Run **`TeXRA: Create Sample Project`** from the command palette to explore a
   fully configured workspace.
3. Open the TeXRA sidebar, pick an agent, select your files, and click
   **Execute**. Follow-up chat is available for tool-use agents.

## Requirements

- **LaTeX distribution** (TeX Live, MiKTeX, or MacTeX)
- **Perl** (required for LaTeX formatting tools)
- **Optional**: GraphicsMagick/ImageMagick and Ghostscript for PDF and image processing

## Installation

Set your API keys in VS Code settings or create a workspace `.env` file:

```env
OPENAI_API_KEY=your_openai_key_here
ANTHROPIC_API_KEY=your_anthropic_key_here
GEMINI_API_KEY=your_gemini_key_here
```

TeXRA loads the `.env` file automatically at startup. For detailed setup
instructions, see the [installation guide](https://texra.ai/guide/installation.html).

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
