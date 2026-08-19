# TeXRA

[![VS Code Marketplace](https://vsmarketplacebadges.dev/version-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Installs](https://vsmarketplacebadges.dev/installs-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Downloads](https://vsmarketplacebadges.dev/downloads-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Rating](https://vsmarketplacebadges.dev/rating-short/texra-ai.texra.svg)](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
[![Open VSX Version](https://img.shields.io/open-vsx/v/texra-ai/texra)](https://open-vsx.org/extension/texra-ai/texra)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/texra-ai/texra)](https://open-vsx.org/extension/texra-ai/texra)
[![npm version](https://img.shields.io/npm/v/@texra-ai/cli?label=%40texra-ai%2Fcli)](https://www.npmjs.com/package/@texra-ai/cli)
[![CLI downloads](https://img.shields.io/npm/dm/@texra-ai/cli?label=CLI%20downloads)](https://www.npmjs.com/package/@texra-ai/cli)

An AI theorist for VS Code and the terminal. Multi-agent
workflows for writing, reviewing, formalizing, and rendering academic
work — with every change returned as a diff you approve.

## Install

```sh
# VS Code (or Cursor, Windsurf, Antigravity)
code --install-extension texra-ai.texra

# Terminal — requires Node.js >=22.9.0
npm install -g @texra-ai/cli

# Or via Homebrew (macOS / Linux)
brew install texra-ai/tap/texra
```

Set `<PROVIDER>_API_KEY` to use your own provider credentials, or connect a
provider subscription (ChatGPT, Grok, Kimi Code, GLM Coding Plan) — see
[Models](#models) below.

### Hosted Remote Agents

Sign in with GitHub or Google — through the Profile view in VS Code, or
`texra login` in the terminal — to unlock the hosted remote-agent catalog:
`orchestrator`, `search`, `simplifier`, and the rest of the hosted
specialists, ready to run without installing or configuring anything
locally. It covers the hosted agent catalog only — remote agents run on the
same credential as your built-in agents, your own provider API key or a
provider subscription. Sign-in does not supply model access on its own.

If TeXRA helps your research, consider supporting its development via
[GitHub Sponsors](https://github.com/sponsors/texra-ai) or
[Buy Me a Coffee](https://buymeacoffee.com/texra.ai).

## Run

In VS Code: open a `.tex` file, click the TeXRA icon, pick
**Orchestrator** or another agent, type a task. The Setup Wizard runs
on first launch and checks your environment.

In the terminal:

```sh
texra chat                                  # interactive tool-use session
texra run polish --input paper.tex          # one-shot workflow
texra multi-agent run physicist --instruction "Check this derivation"  # named team
```

Run history and agent settings are shared between both surfaces.

## Teams

Five built-in presets cover the most common research disciplines:

| Team                   | Built for                                                                        |
| ---------------------- | -------------------------------------------------------------------------------- |
| **Physicist**          | Analytical derivations, numerical experiments, literature search, slide drafting |
| **Mathematician**      | Attacking open problems, proofs, Lean 4 formalization, LaTeX correction          |
| **Computer Scientist** | Algorithm design, code-driven experiments and ablations, tests, literature       |
| **Lean Project**       | Mathlib search, tactic simplification, blueprint-driven formalization            |
| **Software Engineer**  | An engineer lead delegating implementation, review, debugging, and testing       |

Pick a team in **Settings → Multi-Agent**, or with `texra multi-agent
run <preset>`. Or define your own roster in YAML.

## Agents

**Workflow agents** write to disk and produce reviewable diffs:
`polish`, `correct`, `merge`, `ocr`, `transcribe_audio`, `paper2slide`,
`paper2poster`.

**Tool-use agents** work conversationally with file, shell, and search
access: `research`, `numerics`, `review`, `presenter`, `latexFixer`,
`latexDiff`, `creator`, `lean`, `assistant`, `setup`, plus a
software-engineering line — `engineer`, `coder`, `codeReviewer`,
`testEngineer`, `codeSimplifier`.

**Hosted specialists** (signed-in users): `orchestrator`, `search`,
`simplifier`, `criticize`, `firstread`, `logic`, `notation`, `enhance`,
`elevate`, `humanize`, `devise`, `apply`, `verifyFix`, `generic`,
`progressCheck`, and the Lean line — `leanOrchestrator`,
`leanBlueprint`, `leanSearch`, `leanSimplifier`.

Every tool call is gated by per-stream approval. Optional YOLO mode
skips approval for autonomous runs.

## Models

Bring your own keys for OpenAI, Anthropic, Google Gemini, DeepSeek,
xAI Grok, Moonshot Kimi, Alibaba Qwen, Zhipu GLM, MiniMax, OpenRouter,
or any OpenAI-compatible endpoint. Each agent in a team can run a
different model — pair a flagship reasoner for orchestration with
cheaper, faster models for routine sub-tasks.

Already paying for ChatGPT or Grok? Connect the subscription instead of
managing a key — Kimi Code and the GLM Coding Plan also run on a
subscription, authenticated with a plan-specific key.

In the extension, run **`TeXRA: Set API Key`** (stored in VS Code's
encrypted SecretStorage) or add a workspace `.env`:

```env
OPENAI_API_KEY=…
ANTHROPIC_API_KEY=…
GOOGLE_API_KEY=…
```

In the CLI, export the same variables in your shell — they're picked up
automatically — or connect a subscription:

```sh
texra auth chatgpt login    # Codex models through your ChatGPT plan
texra auth grok login       # Grok models through an xAI subscription
```

## Requirements

- **VS Code 1.125+** (also runs in Cursor, Windsurf, Antigravity), or
  **Node.js >=22.9.0** for the CLI
- **LaTeX distribution** (TeX Live, MiKTeX, or MacTeX)
- **Perl** (for `latexindent` and `latexdiff`)
- Optional: ImageMagick + Ghostscript (for PDF/image processing),
  `git`, `gh`, Codex CLI, Lean 4 + `lake`

The Setup Wizard checks for and helps install most of the above.

## Documentation

- [Installation](https://texra.ai/guide/installation)
- [Quick Start](https://texra.ai/guide/quick-start)
- [Built-in Agents](https://texra.ai/guide/built-in-agents)
- [Polish a draft](https://texra.ai/guide/workflows/polish-a-draft) — workflow example
- [Models](https://texra.ai/guide/models)
- [Custom Agents](https://texra.ai/guide/custom-agents)

Full docs at [texra.ai/guide](https://texra.ai/guide/).

## Support

Issues and feature requests: [GitHub](https://github.com/texra-ai/texra-issues/issues).
Contact: [contact@texra.ai](mailto:contact@texra.ai).

## License

© TeXRA Team 2025–2026. All rights reserved.

[Terms of Service](https://texra.ai/terms) · [Provider list](https://texra.ai/providers)
