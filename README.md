# TeXRA

[![VS Code Marketplace](https://vsmarketplacebadges.dev/version-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Installs](https://vsmarketplacebadges.dev/installs-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Downloads](https://vsmarketplacebadges.dev/downloads-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Rating](https://vsmarketplacebadges.dev/rating-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Open VSX Version](https://img.shields.io/open-vsx/v/texra-ai/texra)](https://open-vsx.org/extension/texra-ai/texra)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/texra-ai/texra)](https://open-vsx.org/extension/texra-ai/texra)
[![npm version](https://img.shields.io/npm/v/@texra-ai/cli?label=%40texra-ai%2Fcli)](https://www.npmjs.com/package/@texra-ai/cli)
[![CLI downloads](https://img.shields.io/npm/dm/@texra-ai/cli?label=CLI%20downloads)](https://www.npmjs.com/package/@texra-ai/cli)

An open-source AI theorist for VS Code, desktop, and the terminal. It handles
real theory work: deriving results, checking derivations, and formalizing proofs
in Lean 4. It takes on open problems in long autonomous runs, splitting large
jobs across helper agents and programs. Apache 2.0, and you bring your own model
keys or subscriptions.

## Install

```sh
# VS Code (or Cursor, Windsurf, Antigravity)
code --install-extension texra-ai.texra

# Terminal: requires Node.js 22.22.2+ (22.x) or Node.js 24.15+
npm install -g @texra-ai/cli

# Or via Homebrew (macOS / Linux)
brew install texra-ai/tap/texra
```

The standalone **Desktop App** (macOS, Windows, Linux) is coming soon — see the
[Desktop App guide](https://texra.ai/guide/desktop).

Set `<PROVIDER>_API_KEY` to use your own credentials, sign in with a
ChatGPT or Grok subscription, or add an API key for Kimi Code or the
GLM Coding Plan.

Everything ships bundled with no TeXRA account; model calls go directly from
your machine to your chosen provider.

TeXRA is sustained by the community. If TeXRA helps your
research, consider supporting it via
[GitHub Sponsors](https://github.com/sponsors/texra-ai) or
[Buy Me a Coffee](https://buymeacoffee.com/texra.ai) to keep it open
for everyone.

## Run

In VS Code: open a project folder, click the TeXRA icon, and say what you want.
Run the **Setup Assistant** on first launch to check your environment.

In the terminal:

```sh
texra chat                                  # interactive chat
texra run edit --input paper.tex            # one-shot document program
texra run review --input paper.tex --print  # audit the manuscript's mathematics
```

Task history, settings, and credentials are shared across the VS Code extension,
desktop app, and CLI.

## The assistant and programs

**One assistant** takes every task: it reads and edits your project, runs
commands, searches arXiv, the web, and Zotero, computes in Wolfram, works on
Lean 4 proofs, and splits large jobs across helper agents.

**Programs** are packaged jobs started by name: ask the assistant, or run
`texra run <program> --input <file>`.

- Document programs revise or create LaTeX and return reviewable diffs:
  `edit`, `annotate`, `enhance`, `apply`, `merge`, `transcribe`, `slides`,
  `poster`.
- Task programs delegate a focused job with its own checklist:
  `review`, `search`, `derive`, `solve`, `experiment`, `code`,
  `review-code`, `simplify`, `test`, `fix-latex`, `latexdiff`.
- Lean programs work with Lean 4 projects: `prove`, `lean-simplify`, `blueprint`, `lean-search`.

Tailor it with a project `AGENTS.md`, skills, and plugins that add skills,
MCP servers, and custom programs.

New projects default to **Auto-approve** for autonomous tasks; switch to **Ask**
or **Block** anytime in **Settings → General → Approval**.

## Models

Bring your own keys for OpenAI, Anthropic, Google Gemini, DeepSeek,
xAI Grok, Moonshot Kimi, Alibaba Qwen, Zhipu GLM, MiniMax, Meta Muse Spark, or
any OpenAI-compatible endpoint. Each helper agent or program can run a
different model — pair a flagship reasoner for planning with faster models for
routine subtasks.

In VS Code or the desktop app, run **`TeXRA: Set API Key`** (saved in
`~/.texra/secrets/`, shared by all TeXRA apps) or add a project `.env`:

```env
OPENAI_API_KEY=…
ANTHROPIC_API_KEY=…
GOOGLE_API_KEY=…
```

In the CLI, export the same variables in your shell.

## Requirements

- **VS Code 1.125+** (also runs in Cursor, Windsurf, Antigravity), **Desktop App**
  (coming soon), or **Node.js 22.22.2+ (22.x) / 24.15+** for the CLI
- **LaTeX distribution** (TeX Live, MiKTeX, or MacTeX)
- **Perl** (for `latexindent` and `latexdiff`)
- Optional: ImageMagick + Ghostscript (for PDF/image processing),
  `git`, `gh`, Codex CLI, Lean 4 + `lake`

The Setup Assistant checks for and helps install most of the above.

## Documentation

- [Installation](https://texra.ai/guide/installation)
- [Quick Start](https://texra.ai/guide/quick-start)
- [Desktop App](https://texra.ai/guide/desktop)
- [The assistant and programs](https://texra.ai/guide/programs)
- [Polish a draft](https://texra.ai/guide/workflows/polish-a-draft) — workflow example
- [Models](https://texra.ai/guide/models)
- [Tailoring TeXRA](https://texra.ai/guide/customizing)
- [Work produced with TeXRA](https://texra.ai/work-using-texra)

Full docs at [texra.ai/guide](https://texra.ai/guide/).

## Development

`main` targets TeXRA 1.0 (fresh SQLite state; legacy JSON stores are not
migrated, and project files are untouched). See
[AGENTS.md](https://github.com/LionSR/TeXRA/blob/main/AGENTS.md) for contributor
architecture notes.

## Support

Issues and feature requests: [GitHub](https://github.com/LionSR/TeXRA/issues).
Contact: [contact@texra.ai](mailto:contact@texra.ai).

## License

Licensed under the [Apache License, Version 2.0](https://github.com/LionSR/TeXRA/blob/main/LICENSE).
© TeXRA Team 2024–2026.

[Terms of Service](https://texra.ai/terms) · [Provider list](https://texra.ai/providers)
