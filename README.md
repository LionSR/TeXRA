# TeXRA

[![VS Code Marketplace](https://vsmarketplacebadges.dev/version-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Installs](https://vsmarketplacebadges.dev/installs-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Downloads](https://vsmarketplacebadges.dev/downloads-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Rating](https://vsmarketplacebadges.dev/rating-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Open VSX Version](https://img.shields.io/open-vsx/v/texra-ai/texra)](https://open-vsx.org/extension/texra-ai/texra)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/texra-ai/texra)](https://open-vsx.org/extension/texra-ai/texra)
[![npm version](https://img.shields.io/npm/v/@texra-ai/cli?label=%40texra-ai%2Fcli)](https://www.npmjs.com/package/@texra-ai/cli)
[![CLI downloads](https://img.shields.io/npm/dm/@texra-ai/cli?label=CLI%20downloads)](https://www.npmjs.com/package/@texra-ai/cli)

An open-source AI theorist for VS Code and the terminal. It attempts real
theory work: deriving results, checking derivations, formalizing proofs in
Lean 4. It takes on open problems in long autonomous runs, splitting large
jobs across helper agents and programs. Apache 2.0, and you bring your own model keys or
subscriptions.

Development on `main` targets **TeXRA 1.0** (work in progress, not the
currently published release), which reorganizes the interface around
**projects**, stores application state in SQLite, and runs asynchronous
execution on Effect (see the [1.0 development direction](AGENTS.md#texra-10-direction)).
Version 1.0 starts with fresh application state and does not migrate previous
JSON settings, session histories, or execution checkpoints; research files in
your project are untouched.

## Install

```sh
# VS Code (or Cursor, Windsurf, Antigravity)
code --install-extension texra-ai.texra

# Terminal: requires Node.js 22.22.2 or later in 22.x, or Node.js 24.15 or later
npm install -g @texra-ai/cli

# Or via Homebrew (macOS / Linux)
brew install texra-ai/tap/texra
```

Set `<PROVIDER>_API_KEY` to use your own credentials, sign in with a
ChatGPT or Grok subscription, or add the API key for a Kimi Code or
GLM Coding Plan subscription.

Everything ships bundled. There is no TeXRA account; model calls run directly
against your configured provider credentials.

TeXRA is sustained by the community. If TeXRA helps your
research, consider supporting it via
[GitHub Sponsors](https://github.com/sponsors/texra-ai) or
[Buy Me a Coffee](https://buymeacoffee.com/texra.ai) to keep it open
for everyone.

## Run

In VS Code: open a `.tex` file, click the TeXRA icon, and say what you want.
The Setup Wizard runs on first launch and checks your environment.

In the terminal:

```sh
texra chat                                  # interactive tool-use session
texra run edit --input paper.tex            # one-shot document program
texra run review --input paper.tex --print  # audit the manuscript's mathematics
```

Run history and settings are shared between both surfaces.

## The assistant and programs

**One assistant** takes every task: it reads and edits your project, runs
commands, searches arXiv, the web and Zotero, computes in Wolfram, works on
Lean 4 proofs, and splits a large job across helper agents it sets up for each
piece.

**Programs** are packaged jobs started by name: ask the assistant, or run
`texra run <program> --input <file>`.

- Document programs revise or create LaTeX and hand back reviewable diffs:
  `edit`, `annotate`, `enhance`, `apply`, `merge`, `transcribe`, `slides`,
  `poster`.
- Task programs hand one job to a helper agent with that job's checklist:
  `review`, `search`, `derive`, `solve`, `experiment`, `code`,
  `review-code`, `simplify`, `test`, `fix-latex`, `latexdiff`.
- Lean programs check their work with Lean: `prove`, `blueprint`.

Tailor it with a project `AGENTS.md`, skills, and plugins that carry skills,
MCP servers and programs of your own.

Every tool call is gated by per-stream approval. Optional YOLO mode
skips approval for autonomous runs.

## Models

Bring your own keys for OpenAI, Anthropic, Google Gemini, DeepSeek,
xAI Grok, Moonshot Kimi, Alibaba Qwen, Zhipu GLM, MiniMax, or any OpenAI-compatible endpoint. Each helper agent or program the assistant
starts can run a different model — pair a flagship reasoner for planning with
cheaper, faster models for routine sub-tasks.

In the extension, run **`TeXRA: Set API Key`** (stored in the owner-only
`~/.texra/secrets/` folder every TeXRA host shares) or add a workspace `.env`:

```env
OPENAI_API_KEY=…
ANTHROPIC_API_KEY=…
GOOGLE_API_KEY=…
```

In the CLI, export the same variables in your shell.

## Requirements

- **VS Code 1.125+** (also runs in Cursor, Windsurf, Antigravity), or
  **Node.js 22.22.2 or later in 22.x, or Node.js 24.15 or later** for the CLI
- **LaTeX distribution** (TeX Live, MiKTeX, or MacTeX)
- **Perl** (for `latexindent` and `latexdiff`)
- Optional: ImageMagick + Ghostscript (for PDF/image processing),
  `git`, `gh`, Codex CLI, Lean 4 + `lake`

The Setup Wizard checks for and helps install most of the above.

## Documentation

- [Installation](https://texra.ai/guide/installation)
- [Quick Start](https://texra.ai/guide/quick-start)
- [The assistant and programs](https://texra.ai/guide/programs)
- [Polish a draft](https://texra.ai/guide/workflows/polish-a-draft) — workflow example
- [Models](https://texra.ai/guide/models)
- [Tailoring TeXRA](https://texra.ai/guide/customizing)
- [Work produced with TeXRA](https://texra.ai/work-using-texra)

Full docs at [texra.ai/guide](https://texra.ai/guide/).

## Support

Issues and feature requests: [GitHub](https://github.com/LionSR/TeXRA/issues).
Contact: [contact@texra.ai](mailto:contact@texra.ai).

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
© TeXRA Team 2024–2026.

[Terms of Service](https://texra.ai/terms) · [Provider list](https://texra.ai/providers)
