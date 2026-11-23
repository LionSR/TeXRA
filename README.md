<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/public/logo-mark-reversed.svg" />
  <source media="(prefers-color-scheme: light)" srcset="docs/public/logo-mark.svg" />
  <img src="docs/public/logo-mark.svg" alt="TeXRA" width="128" />
</picture>

# TeXRA

**Derive it, check it, prove it.**<br />
An open-source AI theorist for the desktop, VS Code, and the terminal.

[![GitHub Stars](https://img.shields.io/github/stars/LionSR/TeXRA?style=flat&color=6F387A&logo=github)](https://github.com/LionSR/TeXRA/stargazers)
[![VS Code Marketplace](https://vsmarketplacebadges.dev/version-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Installs](https://vsmarketplacebadges.dev/installs-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Downloads](https://vsmarketplacebadges.dev/downloads-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Rating](https://vsmarketplacebadges.dev/rating-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Open VSX Version](https://img.shields.io/open-vsx/v/texra-ai/texra)](https://open-vsx.org/extension/texra-ai/texra)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/texra-ai/texra)](https://open-vsx.org/extension/texra-ai/texra)
[![npm version](https://img.shields.io/npm/v/@texra-ai/cli?label=%40texra-ai%2Fcli)](https://www.npmjs.com/package/@texra-ai/cli)
[![CLI downloads](https://img.shields.io/npm/dm/@texra-ai/cli?label=CLI%20downloads)](https://www.npmjs.com/package/@texra-ai/cli)

[![Desktop App](https://img.shields.io/badge/Desktop_App-macOS_%7C_Windows_%7C_Linux-6F387A?style=for-the-badge)](https://github.com/texra-ai/texra-desktop-releases/releases)
[![Docs](https://img.shields.io/badge/Docs-texra.ai%2Fguide-270939?style=for-the-badge)](https://texra.ai/guide/)
[![Worldline SDK](https://img.shields.io/badge/Runtime-%40texra--ai%2Fworldline-6F387A?style=for-the-badge)](packages/harness/README.md)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-270939?style=for-the-badge)](LICENSE)

[Quick Start](https://texra.ai/guide/quick-start) · [Desktop App](https://texra.ai/guide/desktop) · [Programs](https://texra.ai/guide/programs) · [Lean 4](https://texra.ai/guide/lean) · [Models](https://texra.ai/guide/models) · [Work with TeXRA](https://texra.ai/work-using-texra) · [Sponsor](https://github.com/sponsors/texra-ai)

</div>

---

TeXRA runs models with the tools theoretical research needs: arXiv and Zotero,
Wolfram and Python, a live Lean 4 server, LaTeX compilation, and parallel helper
agents. Document edits come back as diffs you inspect line by line.

TeXRA 1.0 ships as a standalone Desktop App, a VS Code extension (also Cursor,
Windsurf, and Antigravity), and a terminal CLI, all on one Effect runtime backed
by SQLite. Apache 2.0, with no TeXRA account: bring your own API keys or
provider subscriptions, and requests go straight from your machine to the
provider.

## What you can do with it

- **Open problems and derivations:** check known results on arXiv, test small
  cases in Python or Julia, verify symbolic steps in `wolframscript`, and write
  up the proof or counterexample.
- **Lean 4 formalization:** search Mathlib with Loogle, inspect tactic goal
  states through TeXRA's headless Lean server (`lake env lean --server`), and
  iterate until files compile with zero errors, zero `sorry`, and no new axioms.
- **Manuscript audits:** reproduce derivations, check limiting cases and
  dimensions, catch notation drift across sections, and confirm that code
  matches the paper.
- **LaTeX editing and presentations:** proofread, polish, annotate with
  `\criticize{}` comments, apply inline fixes, transcribe handwriting or audio,
  and generate Beamer slides or posters, with compiled `latexdiff` PDFs.
- **Autonomous goals:** turn a plan into multi-round runs where a separate judge
  with no prior conversation verifies every requirement with tools before the
  goal completes.

## Install

### Desktop App (macOS, Windows, Linux)

Download the installer from
[texra-ai/texra-desktop-releases](https://github.com/texra-ai/texra-desktop-releases/releases)
(macOS universal `.dmg`/zip, Windows x64 installer, Linux x64 AppImage/`.deb`).
Arrange movable panes for Agent, Files, Editor, PDF, Review, Terminal, Browser,
and Logs, with no VS Code required.

### VS Code Extension & Terminal CLI

```sh
# VS Code 1.125+ (also Cursor, Windsurf, Antigravity)
code --install-extension texra-ai.texra

# Terminal CLI (Node.js 22.22.2+ in 22.x, or Node.js 24.15+)
npm install -g @texra-ai/cli

# Or via Homebrew (macOS / Linux)
brew install texra-ai/tap/texra
```

All three apps share saved credentials (`~/.texra/secrets/`), settings
(`.texra/config.json` and `~/.texra`), and SQLite task history. On macOS and
Linux, a shared background service keeps tasks running when a window or terminal
closes so any other app can follow or steer them live (`texra tasks`, `/tasks`).

## Quick start

Connect a model by adding an API key under **Settings → Models → API keys** (or
`TeXRA: Set API Key`, `<PROVIDER>_API_KEY` in your shell, or a project `.env`),
or sign in with a subscription:

```sh
texra auth chatgpt login
texra auth grok login
```

Kimi Code and GLM Coding Plan subscriptions use their plan API keys. Paid Claude
Max/Team and ChatGPT Pro/Business plans also include monthly API credits usable
with standard Anthropic or OpenAI keys.

In the Desktop App or VS Code, open a project folder, run the **Setup
Assistant** on first launch, and describe what you want. In the terminal:

```sh
texra setup                                 # guided setup and first task
texra chat                                  # interactive chat
texra run edit --input paper.tex            # revise a LaTeX file with diffs
texra run review --input paper.tex --print  # audit derivations and math
texra run prove --input Proofs/Basic.lean   # complete proofs with Lean diagnostics
texra resume <run-id>                       # resume an interrupted task
```

## One assistant, scripts, programs, and goals

There is one assistant and no agent menu. Tell it what you need and which files
to work on; it reads and edits your project, runs shell commands, searches
arXiv, the web, and Zotero, drives Lean 4, compiles LaTeX, and can hand coding
work to local OpenAI Codex or Claude Code installs.

For work that fans out across sections, lemmas, or independent checks, the
assistant writes a sandboxed JavaScript `script` calling `agent()`, `self()`,
`program()`, and tools with `Promise.all` or `Promise.allSettled`. Finished
calls are cached in SQLite and reused automatically on retry or resume.

Programs are packaged jobs started by asking the assistant or running
`texra run <program> --input <file>`:

| Family       | Programs                                                                                                                 | Output / check                                                                                 |
| :----------- | :----------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------- |
| **Document** | `edit`, `annotate`, `enhance`, `apply`, `transcribe`, `slides`, `poster`                                                 | Compiled LaTeX and diffs (`reflect: true` adds a critic pass)                                  |
| **Task**     | `review`, `search`, `derive`, `solve`, `experiment`, `code`, `review-code`, `simplify`, `test`, `fix-latex`, `latexdiff` | Helper agent report or verified project edits                                                  |
| **Lean 4**   | `prove`, `lean-simplify`, `blueprint`, `lean-search`                                                                     | Checked against Lean diagnostics (zero errors, zero `sorry`, no new axioms) or `leanblueprint` |

Approve a plan with **Run as goal** (`r` in the terminal) to run autonomous
rounds until a separate judge checks every requirement with tools. Goals stop at
`texra.goal.maxCostUsd` (default `$5`), and any child run accepts a `maxCostUsd`
cap.

## Persistence, approvals, and plugins

Every turn, tool result, approval, and child run is saved in SQLite
(`texra.project-v1.db`). Interrupted or crashed runs resume without repeating
finished tool calls (`texra resume`, `/resume`), and you can fork any task or
earlier message (**Fork from here**, `/fork`) while leaving the original
untouched.

One approval policy (**Auto-approve**, **Ask**, or **Block**, under **Settings →
General → Approval**) controls edits, shell commands, delegations, and MCP
calls. New projects default to Auto-approve, and policy is never read from a
cloned `.texra/config.json`. File tools reject symlinks outside the workspace,
`web_fetch` blocks private networks, and child processes do not inherit API
keys.

Put personal rules in `~/.texra/AGENTS.md` and project conventions in
`AGENTS.md` (both apply), keep Markdown notes in **Memory** (`MEMORY.md`), load
`SKILL.md` skills (including `.agents`, `.claude`, `.codex`, and `.gemini`
folders), and install Claude Code or Codex plugins
(`texra plugin install github.com/<owner>/<repo>`) with skills, commands,
agents, stdio MCP `2025-11-25` servers, JS programs (`<plugin>:<name>`), or
native `harness.mjs` extensions (all review-and-trust gated). Agents can also
save reusable project programs under `own:<name>`.

## Models

[![Anthropic](https://img.shields.io/badge/Anthropic-Claude-191919?style=flat)](https://texra.ai/guide/models#anthropic-models)
[![OpenAI](https://img.shields.io/badge/OpenAI-GPT--6-191919?style=flat)](https://texra.ai/guide/models#openai-models)
[![Google](https://img.shields.io/badge/Google-Gemini_4-191919?style=flat)](https://texra.ai/guide/models#google-models)
[![DeepSeek](https://img.shields.io/badge/DeepSeek-V4-191919?style=flat)](https://texra.ai/guide/models#deepseek-models)
[![xAI](https://img.shields.io/badge/xAI-Grok-191919?style=flat)](https://texra.ai/guide/models#grok-xai-models)
[![Moonshot](https://img.shields.io/badge/Moonshot-Kimi-191919?style=flat)](https://texra.ai/guide/models#moonshot-kimi-models)
[![Qwen](https://img.shields.io/badge/DashScope-Qwen-191919?style=flat)](https://texra.ai/guide/models#dashscope-qwen-models)
[![GLM](https://img.shields.io/badge/Z.AI-GLM-191919?style=flat)](https://texra.ai/guide/models#glm-zhipu-ai-z-ai-models)
[![MiniMax](https://img.shields.io/badge/MiniMax-M3-191919?style=flat)](https://texra.ai/guide/models#minimax-models)
[![Meta](https://img.shields.io/badge/Meta-Muse-191919?style=flat)](https://texra.ai/guide/models#meta-muse-models)

Direct routes to all ten providers plus custom endpoints speaking OpenAI
Responses, Anthropic Messages, or Gemini Interactions. Models use
`provider/id[@effort]` references (such as `anthropic/claude-opus-5-5@high`,
`openai/gpt-6.1-sol+pro`, or `@none` where supported), and each helper agent or
program can run a different model.

## Work produced with TeXRA

- **Lean 4 formalizations:** [TNLean](https://github.com/LionSR/TNLean)
  (tensor-network theory and matrix-product states),
  [QICLean](https://github.com/LionSR/QICLean) (quantum information and
  channels), [MIPStarRE](https://github.com/LionSR/MIPStarRE) (mathematics
  around MIP\* = RE).
- **Papers:**
  [Can Theoretical Physics Research Benefit from Language Agents?](https://arxiv.org/abs/2506.06214)
  (ICML 2026) ·
  [Multi-agent Autoformalization of Tensor Network Theory](https://arxiv.org/abs/2607.07857)
  (2026) ·
  [Co-Designing Quantum Codes with Transversal Diagonal Gates via Multi-Agent Systems](https://arxiv.org/abs/2510.20728)
  (2025) ·
  [Agentic Publication Protocol](https://arxiv.org/abs/2606.27386) (2026).

See the full list at
[texra.ai/work-using-texra](https://texra.ai/work-using-texra).

## Packages and open-source ecosystem

This repository is a pnpm workspace: an embeddable Effect agent runtime, the
TeXRA application layer, and three hosts over them.

| Package                                                                  | Role                                                                                                                              |
| :----------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------- |
| [`@texra-ai/worldline`](packages/harness/README.md) (`packages/harness`) | Embeddable agent runtime in Effect: SQLite sessions, resume, fork, approvals, sandboxed scripts, plugins, crash-conformance suite |
| [`@texra-ai/llm`](packages/llm/README.md) (`packages/llm`)               | Effect model contract over OpenAI Responses, Anthropic Messages, and Google Interactions, backed by `llm-zoo`                     |
| [`@texra-ai/texra`](packages/texra/AGENTS.md) (`packages/texra`)         | TeXRA app layer: research plugins, programs, LaTeX tools, UI kit, and host controllers                                            |
| [`packages/extension`](packages/extension/README.md)                     | VS Code / Open VSX extension (`texra-ai.texra`)                                                                                   |
| `packages/desktop`                                                       | Standalone Electron desktop app ([Desktop guide](https://texra.ai/guide/desktop))                                                 |
| [`@texra-ai/cli`](packages/cli/README.npm.md) (`packages/cli`)           | Interactive Ink TUI and headless CLI (`texra`)                                                                                    |
| `packages/trace-viewer`                                                  | Single-file HTML trace viewer for exported runs                                                                                   |

Related MIT-licensed projects under [texra-ai](https://github.com/texra-ai):

[![llm-zoo](https://img.shields.io/github/stars/texra-ai/llm-zoo?style=flat&label=llm-zoo&color=6F387A)](https://github.com/texra-ai/llm-zoo)
[![mcp-server-mathematica](https://img.shields.io/github/stars/texra-ai/mcp-server-mathematica?style=flat&label=mcp-server-mathematica&color=6F387A)](https://github.com/texra-ai/mcp-server-mathematica)
[![texra-scientific-skills](https://img.shields.io/github/stars/texra-ai/texra-scientific-skills?style=flat&label=texra-scientific-skills&color=6F387A)](https://github.com/texra-ai/texra-scientific-skills)
[![texra-lean-skills](https://img.shields.io/github/stars/texra-ai/texra-lean-skills?style=flat&label=texra-lean-skills&color=6F387A)](https://github.com/texra-ai/texra-lean-skills)
[![zotero-cleanup-skills](https://img.shields.io/github/stars/texra-ai/zotero-cleanup-skills?style=flat&label=zotero-cleanup-skills&color=6F387A)](https://github.com/texra-ai/zotero-cleanup-skills)

## Requirements

- Desktop App, VS Code 1.125+ (or Cursor, Windsurf, Antigravity), or Node.js
  22.22.2+ (22.x) / 24.15+ for the CLI and SDK packages
- LaTeX distribution (TeX Live, MiKTeX, or MacTeX) and Perl (for `latexindent`
  and `latexdiff`) when compiling or diffing `.tex` files
- Optional: GraphicsMagick or ImageMagick + Ghostscript, `git`, `gh`, Lean 4 +
  `lake` (on `PATH`), WolframScript (`wolframscript`), OpenAI Codex CLI, Claude
  Code CLI

## Upgrading from 0.40

- **Fresh SQLite state:** 0.40 JSON histories, checkpoints, and app state are
  not migrated; they stay untouched on disk alongside your research files. From
  1.0 on, updates keep your SQLite history.
- **Re-enter credentials:** All apps now read `~/.texra/secrets/`. Add your API
  keys and sign in to ChatGPT or Grok again. TeXRA accounts, OpenRouter, and
  Copilot routes are removed.
- **One assistant and programs:** Custom agent YAML files and `.texrarules` are
  no longer read. Move project rules to `AGENTS.md`, checklists to skills, and
  repeatable procedures to plugin programs.
- **Model names:** Settings and `--model` now use `provider/id[@effort]` instead
  of short names.

See [CHANGELOG.md](CHANGELOG.md) for the full 1.0 changelog.

## Development

```sh
corepack pnpm install
npm run compile:fast   # build extension and webviews (strips types only)
npm run typecheck      # TypeScript check across all packages
npm run gate           # lint, invariants, docs, format check, typecheck, Effect diagnostics
npm run test:pure      # host-free test tier
```

See [AGENTS.md](AGENTS.md) for architecture rules, package boundaries, Effect
conventions, and testing rules.

## Support & License

[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub_Sponsors-EA4AAA?style=flat&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/texra-ai)
[![Buy Me a Coffee](https://img.shields.io/badge/Support-Buy_Me_a_Coffee-FFDD00?style=flat&logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/texra.ai)

Issues and feature requests: [GitHub Issues](https://github.com/LionSR/TeXRA/issues) · Security: [SECURITY.md](SECURITY.md) · Contact: [contact@texra.ai](mailto:contact@texra.ai)

Licensed under the [Apache License, Version 2.0](LICENSE). © TeXRA Team 2024–2026.

[Terms of Service](https://texra.ai/terms) · [Provider list](https://texra.ai/providers)
