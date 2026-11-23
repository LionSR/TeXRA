<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/public/logo-mark-reversed.svg" />
  <source media="(prefers-color-scheme: light)" srcset="docs/public/logo-mark.svg" />
  <img src="docs/public/logo-mark.svg" alt="TeXRA" width="120" />
</picture>

# TeXRA

**Derive it, check it, prove it.**<br />
Open-source AI theorist for the desktop, VS Code, and the terminal.

[![GitHub Stars](https://img.shields.io/github/stars/LionSR/TeXRA?style=flat&color=6F387A&logo=github)](https://github.com/LionSR/TeXRA/stargazers)
[![VS Code Marketplace](https://vsmarketplacebadges.dev/version-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Installs](https://vsmarketplacebadges.dev/installs-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Rating](https://vsmarketplacebadges.dev/rating-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Open VSX Version](https://img.shields.io/open-vsx/v/texra-ai/texra)](https://open-vsx.org/extension/texra-ai/texra)
[![npm version](https://img.shields.io/npm/v/@texra-ai/cli?label=%40texra-ai%2Fcli)](https://www.npmjs.com/package/@texra-ai/cli)
[![CLI downloads](https://img.shields.io/npm/dm/@texra-ai/cli?label=CLI%20downloads)](https://www.npmjs.com/package/@texra-ai/cli)

[![Desktop App](https://img.shields.io/badge/Desktop_App-macOS_%7C_Windows_%7C_Linux-6F387A?style=for-the-badge)](https://github.com/texra-ai/texra-desktop-releases/releases)
[![Docs](https://img.shields.io/badge/Docs-texra.ai%2Fguide-270939?style=for-the-badge)](https://texra.ai/guide/)
[![Worldline Runtime](https://img.shields.io/badge/Agent_Runtime-%40texra--ai%2Fworldline-6F387A?style=for-the-badge)](packages/harness/README.md)
[![LLM SDK](https://img.shields.io/badge/LLM_Layer-%40texra--ai%2Fllm-270939?style=for-the-badge)](packages/llm/README.md)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-191919?style=for-the-badge)](LICENSE)

[Quick Start](#install-and-quick-start) · [Programs](#programs) · [Models](#models) · [Work with TeXRA](#work-produced-with-texra) · [Worldline SDK](#build-on-texras-runtime) · [Sponsor](https://github.com/sponsors/texra-ai)

</div>

---

TeXRA connects frontier models to the tools theoretical research depends on:
arXiv and Zotero, Wolfram and Python, a live Lean 4 server, LaTeX compilation
with `latexdiff` PDFs, and parallel multi-agent scripts.

**TeXRA 1.0** runs as a standalone Desktop App, a VS Code extension (also
Cursor, Windsurf, and Antigravity), and a terminal CLI over one SQLite-backed
Effect runtime. Apache 2.0, no TeXRA account: bring your own API keys or
provider subscriptions, and requests go straight from your machine to the
provider.

## Why researchers use TeXRA

- **Tools in the loop.** Derivations are checked in `wolframscript` and Python,
  proofs compile against a headless Lean 4 server (`lake env lean --server`)
  with Loogle, citations resolve to arXiv and Zotero, and document edits arrive
  as diffs you review line by line.
- **One assistant, parallel scripts, autonomous goals.** No agent menu: describe
  the problem and files. For large jobs, the assistant writes sandboxed
  JavaScript (`script`) fanning out `agent()`, `self()`, and packaged programs
  in parallel, or runs multi-round **Goal mode** where a separate judge checks
  every requirement with tools before completion (capped at
  `texra.goal.maxCostUsd`, default `$5`).
- **Built for multi-hour tasks.** Every turn, tool call, approval, and child run
  commits to SQLite (`texra.project-v1.db`). Interrupted runs resume without
  repeating finished work (`texra resume`, `/resume`), any turn can be forked
  (`/fork`), and a shared macOS/Linux background service keeps tasks running
  when you close a window or terminal.
- **Proven on real mathematics and physics.** Used to build Lean 4
  formalizations ([TNLean](https://github.com/LionSR/TNLean),
  [QICLean](https://github.com/LionSR/QICLean),
  [MIPStarRE](https://github.com/LionSR/MIPStarRE)) and published papers
  (ICML 2026 and arXiv).

## Install and quick start

- **Desktop App** (macOS universal `.dmg`/zip, Windows x64, Linux AppImage /
  `.deb`): download from
  [texra-ai/texra-desktop-releases](https://github.com/texra-ai/texra-desktop-releases/releases)
  (movable Agent, Files, Editor, PDF, Review, Terminal, Browser, and Logs panes;
  no VS Code required).
- **VS Code extension & CLI:**

```sh
# VS Code 1.125+ (also Cursor, Windsurf, Antigravity)
code --install-extension texra-ai.texra

# Terminal CLI (Node.js 22.22.2+ in 22.x, or 24.15+)
npm install -g @texra-ai/cli        # or: brew install texra-ai/tap/texra
```

All three apps share `~/.texra/secrets/`, settings (`.texra/config.json` and
`~/.texra`), and SQLite task history. Connect a model under **Settings →
Models** (or `TeXRA: Set API Key`, `<PROVIDER>_API_KEY`, `.env`, or
`texra auth chatgpt login` / `texra auth grok login`; Kimi Code and GLM Coding
Plan use plan keys; Claude Max/Team and ChatGPT Pro/Business include monthly API
credits).

In Desktop or VS Code, open a project folder, run **Setup Assistant**, and
describe your task. In the terminal:

```sh
texra setup                                 # guided setup and first task
texra chat                                  # interactive chat
texra run edit --input paper.tex            # revise LaTeX with compiled diffs
texra run review --input paper.tex --print  # audit derivations and math
texra run prove --input Proofs/Basic.lean   # close sorrys with Lean diagnostics
texra resume <run-id>                       # resume an interrupted task
```

## Programs

Ask the assistant in plain language or run `texra run <program> --input <file>`:

| Family       | Programs                                                                                                                 | Output / verification                                                          |
| :----------- | :----------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------- |
| **Document** | `edit`, `annotate`, `enhance`, `apply`, `transcribe`, `slides`, `poster`                                                 | Compiled LaTeX and `latexdiff` PDFs (`reflect: true` adds a critic pass)       |
| **Task**     | `review`, `search`, `derive`, `solve`, `experiment`, `code`, `review-code`, `simplify`, `test`, `fix-latex`, `latexdiff` | Helper agent report or verified project edits                                  |
| **Lean 4**   | `prove`, `lean-simplify`, `blueprint`, `lean-search`                                                                     | Lean diagnostics (zero errors, zero `sorry`, no new axioms) or `leanblueprint` |

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

Direct routes to all ten providers plus custom OpenAI Responses, Anthropic
Messages, or Gemini Interactions endpoints. Models use `provider/id[@effort]`
references (`anthropic/claude-opus-5-5@high`, `openai/gpt-6.1-sol+pro`, `@none`
where allowed), and each helper agent or program can run a different model.

## Tailoring, plugins, and approvals

- **Rules and memory:** Personal `~/.texra/AGENTS.md` and project `AGENTS.md`
  both apply; cross-task notes live as ordinary Markdown files (`MEMORY.md`).
- **Skills, plugins, and coding agents:** Load `SKILL.md` skills (including
  `.agents`, `.claude`, `.codex`, and `.gemini`), delegate coding to local
  OpenAI Codex or Claude Code, or install Claude Code / Codex plugins
  (`texra plugin install github.com/<owner>/<repo>`) carrying skills, agents,
  stdio MCP `2025-11-25` servers, JS programs (`<plugin>:<name>`), or native
  `harness.mjs` extensions (review-and-trust gated). Agents can also save
  reusable project programs under `own:<name>`.
- **Approvals and isolation:** One policy (**Auto-approve**, **Ask**, or
  **Block**, default Auto-approve, never read from cloned `.texra/config.json`)
  controls edits, shell commands, delegations, and MCP calls. Symlink escapes,
  private-network `web_fetch` SSRF, and API-key inheritance in child processes
  are blocked.

## Work produced with TeXRA

- **Lean 4 formalizations:** [TNLean](https://github.com/LionSR/TNLean)
  (tensor-network theory and MPS), [QICLean](https://github.com/LionSR/QICLean)
  (quantum information and channels),
  [MIPStarRE](https://github.com/LionSR/MIPStarRE) (MIP\* = RE).
- **Papers:**
  [Can Theoretical Physics Research Benefit from Language Agents?](https://arxiv.org/abs/2506.06214)
  (ICML 2026) ·
  [Multi-agent Autoformalization of Tensor Network Theory](https://arxiv.org/abs/2607.07857)
  (2026) ·
  [Co-Designing Quantum Codes with Transversal Diagonal Gates via Multi-Agent Systems](https://arxiv.org/abs/2510.20728)
  (2025) ·
  [Agentic Publication Protocol](https://arxiv.org/abs/2606.27386) (2026).

Full list: [texra.ai/work-using-texra](https://texra.ai/work-using-texra).

## Build on TeXRA's runtime

TeXRA's core ships as two standalone Effect 4 libraries you can embed in your
own Node apps, CLIs, and editors:

- **[Worldline (`@texra-ai/worldline`)](packages/harness/README.md):**
  Durable, forkable agent runtime in Effect: SQLite sessions verified against 9
  crash-recovery invariants, `run.fork`, sandboxed QuickJS multi-agent scripts
  with cached replay, approvals, plugins, MCP `2025-11-25`, browser-safe UI
  views, and 14 runnable examples.
- **[`@texra-ai/llm`](packages/llm/README.md):** Pure Effect `Model` contract
  over OpenAI Responses (HTTP + WebSocket), Anthropic Messages, and Google
  Interactions for 10 providers and 140+ `llm-zoo` models, with lazy SDK
  loading, typed `ModelError`, and wire-recorded CI cassettes.

<details>
<summary>All workspace packages and related MIT repositories</summary>

| Package                                                                  | Role                                                                               |
| :----------------------------------------------------------------------- | :--------------------------------------------------------------------------------- |
| [`@texra-ai/worldline`](packages/harness/README.md) (`packages/harness`) | Embeddable Effect agent runtime                                                    |
| [`@texra-ai/llm`](packages/llm/README.md) (`packages/llm`)               | Multi-protocol Effect LLM contract over `llm-zoo`                                  |
| [`@texra-ai/texra`](packages/texra/AGENTS.md) (`packages/texra`)         | TeXRA app layer: research plugins, programs, LaTeX tools, UI kit, host controllers |
| [`packages/extension`](packages/extension/README.md)                     | VS Code / Open VSX extension (`texra-ai.texra`)                                    |
| `packages/desktop`                                                       | Standalone Electron desktop app ([Desktop guide](https://texra.ai/guide/desktop))  |
| [`@texra-ai/cli`](packages/cli/README.npm.md) (`packages/cli`)           | Interactive Ink TUI and headless CLI (`texra`)                                     |
| `packages/trace-viewer`                                                  | Single-file HTML trace viewer                                                      |

Related MIT repositories under [texra-ai](https://github.com/texra-ai):

[![llm-zoo](https://img.shields.io/github/stars/texra-ai/llm-zoo?style=flat&label=llm-zoo&color=6F387A)](https://github.com/texra-ai/llm-zoo)
[![texra-scientific-skills](https://img.shields.io/github/stars/texra-ai/texra-scientific-skills?style=flat&label=texra-scientific-skills&color=6F387A)](https://github.com/texra-ai/texra-scientific-skills)
[![texra-lean-skills](https://img.shields.io/github/stars/texra-ai/texra-lean-skills?style=flat&label=texra-lean-skills&color=6F387A)](https://github.com/texra-ai/texra-lean-skills)
[![zotero-cleanup-skills](https://img.shields.io/github/stars/texra-ai/zotero-cleanup-skills?style=flat&label=zotero-cleanup-skills&color=6F387A)](https://github.com/texra-ai/zotero-cleanup-skills)

</details>

<details>
<summary>Upgrading from 0.40, requirements, and local development</summary>

**Upgrading from 0.40** (full list in [CHANGELOG.md](CHANGELOG.md)):

- **Fresh SQLite state:** 0.40 JSON histories stay untouched on disk alongside
  your research files; from 1.0 on, updates keep your SQLite history.
- **Re-enter credentials:** All apps now read `~/.texra/secrets/`. TeXRA
  accounts, OpenRouter, and Copilot routes are removed.
- **One assistant and programs:** Custom agent YAML files and `.texrarules` are
  no longer read; move rules to `AGENTS.md`, checklists to skills, and
  procedures to plugin programs. Models use `provider/id[@effort]`.

**Requirements:** Desktop App, VS Code 1.125+, or Node.js 22.22.2+ / 24.15+;
LaTeX distribution + Perl for compiling/diffing `.tex`; optional
GraphicsMagick/ImageMagick + Ghostscript, `git`, `gh`, Lean 4 (`lake`),
WolframScript, Codex CLI, Claude Code CLI.

**Development** (see [AGENTS.md](AGENTS.md)):

```sh
corepack pnpm install
npm run compile:fast   # build extension and webviews (strips types only)
npm run typecheck      # TypeScript check across all packages
npm run gate           # lint, invariants, docs, format check, typecheck, Effect diagnostics
npm run test:pure      # host-free test tier
```

</details>

## Support & License

[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub_Sponsors-EA4AAA?style=flat&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/texra-ai)
[![Buy Me a Coffee](https://img.shields.io/badge/Support-Buy_Me_a_Coffee-FFDD00?style=flat&logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/texra.ai)

[Full Docs](https://texra.ai/guide/) · [GitHub Issues](https://github.com/LionSR/TeXRA/issues) · [SECURITY.md](SECURITY.md) · [contact@texra.ai](mailto:contact@texra.ai)

Licensed under [Apache-2.0](LICENSE). © TeXRA Team 2024–2026. [Terms](https://texra.ai/terms) · [Providers](https://texra.ai/providers)
