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
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-6F387A?style=flat)](LICENSE)

[Desktop App](https://github.com/texra-ai/texra-desktop-releases/releases) · [Docs](https://texra.ai/guide/) · [Install](#install) · [Programs](#programs) · [Models](#models) · [Work with TeXRA](#work-produced-with-texra) · [Worldline SDK](#build-on-texras-runtime) · [Sponsor](https://github.com/sponsors/texra-ai)

</div>

---

TeXRA connects frontier models to the tools theoretical research depends on:
Wolfram and Python, a live Lean 4 server with Loogle, arXiv and Zotero, LaTeX
compilation with `latexdiff` PDFs, and parallel multi-agent scripts.

**TeXRA 1.0** ships as a standalone Desktop App, a VS Code extension (also
Cursor, Windsurf, and Antigravity), and a terminal CLI over one SQLite-backed
Effect runtime. Apache 2.0, no TeXRA account: bring your own API keys or
subscriptions, and requests go straight from your machine to the provider.

## Why researchers use TeXRA

- **Tools in the loop.** Check derivations in Wolfram and Python, type-check
  proofs against a live Lean 4 server, cite real papers from arXiv and Zotero,
  and inspect every LaTeX edit as a line-by-line diff or compiled `latexdiff`
  PDF.
- **One assistant, parallel scripts, autonomous goals.** Describe the problem
  and files; there is no agent menu. For large jobs, the assistant writes sandboxed
  JavaScript to fan out helper agents in parallel, delegates coding to Codex or
  Claude Code, or runs multi-round goals checked by an independent judge.
- **Built for multi-hour problems.** Tasks persist to SQLite, resume after a
  crash without repeating finished work, fork at any turn, and stay alive in a
  shared background service across Desktop, VS Code, and CLI.
- **Tailored to your project.** Add rules in `AGENTS.md`, Markdown memory,
  `SKILL.md` skills, and Claude Code / Codex plugins (including MCP servers and
  custom programs).

## Install

- **Desktop App** (macOS, Windows, Linux; no VS Code required): download from
  [texra-ai/texra-desktop-releases](https://github.com/texra-ai/texra-desktop-releases/releases).
- **VS Code extension & Terminal CLI:**

```sh
# VS Code 1.125+ (also Cursor, Windsurf, Antigravity)
code --install-extension texra-ai.texra

# Terminal CLI (Node.js 22.22.2+ or 24.15+)
npm install -g @texra-ai/cli        # or: brew install texra-ai/tap/texra
```

Add an API key in **Settings → Models** (or `texra auth chatgpt login` /
`texra auth grok login`), then open a project folder or start from the terminal:

```sh
texra setup                                 # guided setup and first task
texra chat                                  # interactive chat
texra run edit --input paper.tex            # revise LaTeX with compiled diffs
texra run review --input paper.tex --print  # audit derivations and math
texra run prove --input Proofs/Basic.lean   # complete proofs with Lean diagnostics
```

All three apps share credentials, settings, and task history. See the
[Installation](https://texra.ai/guide/installation) and
[Quick Start](https://texra.ai/guide/quick-start) guides.

## Programs

Ask the assistant in plain words or run `texra run <program> --input <file>`
([full catalog](https://texra.ai/guide/programs)):

| Family       | Programs                                                                                                                 | What it returns                                               |
| :----------- | :----------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------ |
| **Document** | `edit`, `annotate`, `enhance`, `apply`, `transcribe`, `slides`, `poster`                                                 | Compiled LaTeX and `latexdiff` PDFs                           |
| **Task**     | `review`, `search`, `derive`, `solve`, `experiment`, `code`, `review-code`, `simplify`, `test`, `fix-latex`, `latexdiff` | Research report or verified project edits                     |
| **Lean 4**   | `prove`, `lean-simplify`, `blueprint`, `lean-search`                                                                     | Proofs verified with zero errors, zero `sorry`, no new axioms |

## Models

Direct routes to Anthropic, OpenAI, Google Gemini, DeepSeek, xAI Grok, Moonshot
Kimi, Alibaba Qwen, Zhipu GLM, MiniMax, and Meta Muse, plus ChatGPT, Grok, Kimi
Code, and GLM subscriptions and custom OpenAI Responses, Anthropic Messages, or
Gemini Interactions endpoints. Mix models freely across helper agents and
programs ([Models guide](https://texra.ai/guide/models)).

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

More at [texra.ai/work-using-texra](https://texra.ai/work-using-texra).

## Build on TeXRA's runtime

TeXRA's core ships as two standalone Effect 4 libraries you can embed in your
own apps, CLIs, and editors:

- **[Worldline (`@texra-ai/worldline`)](packages/harness/README.md):** Durable,
  forkable agent runtime in Effect backed by SQLite, with crash-tested recovery,
  plain-JS multi-agent scripts in QuickJS, approvals, plugins, browser-safe UI
  views, and 14 runnable examples.
- **[`@texra-ai/llm`](packages/llm/README.md):** Pure Effect `Model` over OpenAI
  Responses, Anthropic Messages, and Google Interactions (10 providers, 140+
  `llm-zoo` models, typed `ModelError`, lazy SDK loading, and wire cassettes).

Companion MIT-licensed repositories under [texra-ai](https://github.com/texra-ai):

[![llm-zoo](https://img.shields.io/github/stars/texra-ai/llm-zoo?style=flat&label=llm-zoo&color=6F387A)](https://github.com/texra-ai/llm-zoo)
[![texra-scientific-skills](https://img.shields.io/github/stars/texra-ai/texra-scientific-skills?style=flat&label=texra-scientific-skills&color=6F387A)](https://github.com/texra-ai/texra-scientific-skills)
[![texra-lean-skills](https://img.shields.io/github/stars/texra-ai/texra-lean-skills?style=flat&label=texra-lean-skills&color=6F387A)](https://github.com/texra-ai/texra-lean-skills)
[![zotero-cleanup-skills](https://img.shields.io/github/stars/texra-ai/zotero-cleanup-skills?style=flat&label=zotero-cleanup-skills&color=6F387A)](https://github.com/texra-ai/zotero-cleanup-skills)

<details>
<summary>Workspace packages, upgrading from 0.40, and development</summary>

- **Packages:** [`@texra-ai/worldline`](packages/harness/README.md) ·
  [`@texra-ai/llm`](packages/llm/README.md) ·
  [`@texra-ai/texra`](packages/texra/AGENTS.md) ·
  [`packages/extension`](packages/extension/README.md) · `packages/desktop` ·
  [`@texra-ai/cli`](packages/cli/README.npm.md) · `packages/trace-viewer`
- **Upgrading from 0.40:** 1.0 starts with fresh SQLite history (0.40 JSON
  state and your research files are untouched), shares keys in
  `~/.texra/secrets/`, retires TeXRA accounts / OpenRouter / Copilot / custom
  agent YAML files, and uses `provider/id[@effort]` model names. See
  [CHANGELOG.md](CHANGELOG.md).
- **Development:** `corepack pnpm install`, `npm run typecheck`, `npm run gate`,
  `npm run test:pure`. Architecture guide: [AGENTS.md](AGENTS.md).

</details>

## Support & License

[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub_Sponsors-EA4AAA?style=flat&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/texra-ai)
[![Buy Me a Coffee](https://img.shields.io/badge/Support-Buy_Me_a_Coffee-FFDD00?style=flat&logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/texra.ai)

[Full Docs](https://texra.ai/guide/) · [GitHub Issues](https://github.com/LionSR/TeXRA/issues) · [SECURITY.md](SECURITY.md) · [contact@texra.ai](mailto:contact@texra.ai)

Licensed under [Apache-2.0](LICENSE). © TeXRA Team 2024–2026. [Terms](https://texra.ai/terms) · [Providers](https://texra.ai/providers)
