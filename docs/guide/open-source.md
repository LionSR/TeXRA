# Open source projects

Research tools benefit from community collaboration. TeXRA's client software is open source, and so are several satellite projects it builds on, so developers, researchers, and tool builders can use and contribute to them independently.

## TeXRA

**The VS Code extension, desktop app, `texra` CLI, and published libraries.**

[![GitHub](https://img.shields.io/github/stars/LionSR/TeXRA)](https://github.com/LionSR/TeXRA)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/LionSR/TeXRA/blob/main/LICENSE)

TeXRA's client software is licensed under the Apache License 2.0: the agent runtime, the specialist agents that derive, check, and formalize results, and all three hosts over it. The hosted service (accounts, the relay, and the account-served agent catalog) remains governed by its Terms of Service.

[TeXRA on GitHub](https://github.com/LionSR/TeXRA)

---

## llm-zoo

**One package to look up any LLM's pricing, capabilities, and context window.**

[![npm](https://img.shields.io/npm/v/llm-zoo)](https://www.npmjs.com/package/llm-zoo)
[![GitHub](https://img.shields.io/github/stars/texra-ai/llm-zoo)](https://github.com/texra-ai/llm-zoo)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/texra-ai/llm-zoo/blob/main/LICENSE)

Keeping track of LLM pricing, context windows, and capabilities across providers is hard. **llm-zoo** is a single, typed, zero-dependency package covering 140+ models from Claude, GPT, Gemini, DeepSeek, Grok, and more.

### Highlights

- **140+ models** across Anthropic, OpenAI, Google, GLM, DeepSeek, MiniMax, xAI, Moonshot, Meta, DashScope, Copilot, and others, with OpenRouter tracked as an access route rather than a provider
- **Zero dependencies**, with full TypeScript support
- **Tree-shakeable** for efficient bundling
- **Zod schemas** for runtime validation (Zod v4)
- **Always current**: pricing and capabilities are updated regularly

### Quick start

```bash
npm install llm-zoo
```

```typescript
import { lookup, cost, from, cheapest, ModelProvider } from 'llm-zoo';

// Look up a model
const claude = lookup('sonnet5');
console.log(claude.contextWindow); // 1000000

// Calculate cost
const price = cost('sonnet5', { input: 1000, output: 500 }); // 0.007

// Find the cheapest model with vision support
const model = cheapest({ supportsVision: true });

// Filter by provider
const anthropicModels = from(ModelProvider.ANTHROPIC);
```

### Key APIs

| Function                      | Description                                     |
| ----------------------------- | ----------------------------------------------- |
| `lookup(model)`               | Get full model configuration                    |
| `resolve(apiName)`            | Search by full API identifier                   |
| `from(provider)`              | Filter models by provider                       |
| `where(predicate)`            | Custom filtering by capabilities                |
| `supporting(capability)`      | Find models with a specific feature             |
| `withContext(tokens)`         | Models meeting context requirements             |
| `cheapest(filters)`           | Most cost-effective model for given constraints |
| `cost(model, usage)`          | Calculate exact usage costs                     |
| `compareCosts(models, usage)` | Side-by-side cost comparison                    |

::: tip Use Case
TeXRA uses llm-zoo for model selection and cost estimation. If you build LLM-powered tools, routing logic, or cost dashboards, it saves you from maintaining your own model registry.
:::

[llm-zoo on GitHub](https://github.com/texra-ai/llm-zoo) · [llm-zoo on npm](https://www.npmjs.com/package/llm-zoo)

---

## MCP server for Mathematica

**A Model Context Protocol server that bridges MCP clients to a local Mathematica installation.**

[![GitHub](https://img.shields.io/github/stars/texra-ai/mcp-server-mathematica)](https://github.com/texra-ai/mcp-server-mathematica)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/texra-ai/mcp-server-mathematica/blob/main/LICENSE)

Research in physics, mathematics, and engineering often requires symbolic computation. **mcp-server-mathematica** lets any MCP-compatible client (Cursor, Claude Desktop, and others) execute Mathematica code and verify mathematical derivations through a local `wolframscript` installation.

### Highlights

- **Execute Mathematica code** from any MCP client
- **Verify derivation steps**: checks that algebraic transformations are correct
- **Multiple output formats**: text, LaTeX, or Mathematica expressions
- **Lightweight**: a Node.js server communicating over stdio

### Tools provided

#### `execute_mathematica`

Run any Mathematica expression and get the result in the format you choose.

```json
{
  "code": "Integrate[x^2, {x, 0, 1}]",
  "format": "latex"
}
```

#### `verify_derivation`

Validate a sequence of mathematical steps. The server checks each transition using `Simplify[prev == current]`.

```json
{
  "steps": ["x^2 - y^2", "(x-y)*(x+y)"],
  "format": "text"
}
```

### Requirements

- **Mathematica** installed locally with `wolframscript` available in your PATH
- **Node.js** v16 or later

### Quick start

```bash
git clone https://github.com/texra-ai/mcp-server-mathematica.git
cd mcp-server-mathematica
npm install
npm run build
node build/index.js
```

Then configure your MCP client to connect to the running server.

::: tip Use Case
TeXRA's own agents run Mathematica through the built-in `wolfram` tool, which calls `wolframscript` directly. mcp-server-mathematica brings the same capability to other MCP clients such as Cursor and Claude Desktop. It is useful for physicists and mathematicians who want AI assistants to check symbolic derivations against a computer algebra system rather than rely on LLM arithmetic alone.
:::

[mcp-server-mathematica on GitHub](https://github.com/texra-ai/mcp-server-mathematica)

---

## TeXRA scientific skills

**A collection of agent skills for scientific writing, peer review, and figure creation.**

[![GitHub](https://img.shields.io/github/stars/texra-ai/texra-scientific-skills)](https://github.com/texra-ai/texra-scientific-skills)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/texra-ai/texra-scientific-skills/blob/main/LICENSE)

TeXRA's capabilities, packaged as portable agent skills. **texra-scientific-skills** distributes specialized skills for working with LaTeX manuscripts, mathematical content, and scientific communication, usable as Claude Code plugins or Codex skill bundles.

### Skills

- **Inline Paper Critic**: adds compile-safe review comments to LaTeX manuscripts
- **Literature Search**: discovers and synthesizes academic sources with proper grounding
- **Manuscript Review**: audits technical documents for mathematical accuracy and consistency
- **Math OCR**: converts handwritten math into LaTeX
- **Mathematical Enhancer**: improves proofs, derivations, and mathematical clarity
- **Scientific Presenter**: creates presentations and Beamer decks
- **Scientific Simplifier**: streamlines code, LaTeX, and writing while preserving meaning
- **TikZ Figure Builder**: creates and refines scientific diagrams with iterative compilation
- **Writing Commenter**: provides inline editorial feedback

### Quick start

```text
# Claude Code
/plugin marketplace add texra-ai/texra-scientific-skills
```

Skills use the standard `SKILL.md` format. You can also install them through Codex or by symlinking individual skill directories into your agent's skills location.

::: tip Use Case
These skills bring TeXRA's research workflows to any agent system that supports the `SKILL.md` format, so your own AI assistant can draft, review, and illustrate scientific work.
:::

[texra-scientific-skills on GitHub](https://github.com/texra-ai/texra-scientific-skills)

---

## TeXRA Lean skills

**Agent skills for Lean 4 and Mathlib formalization work.**

[![GitHub](https://img.shields.io/github/stars/texra-ai/texra-lean-skills)](https://github.com/texra-ai/texra-lean-skills)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/texra-ai/texra-lean-skills/blob/main/LICENSE)

**texra-lean-skills** helps AI agents assist with mathematical formalization in Lean 4, connecting informal mathematics and formal code. It is distributed as a Claude Code plugin or a Codex skills bundle in the standard skill format.

### Skills

- **lean-blueprint**: authors and maintains documents connecting informal mathematics to Lean declarations
- **lean-proof-assistant**: develops and debugs Lean proofs with goal inspection and lemma search
- **lean-search**: locates existing Lean 4 and Mathlib lemmas, APIs, and formalization patterns
- **lean-simplifier**: refactors code toward Mathlib-quality style while preserving meaning
- **lean-tactic-improver**: turns repeated proof patterns into reusable project automation

### Quick start

```text
# Claude Code
/plugin marketplace add texra-ai/texra-lean-skills
```

You can also install the skills through Codex or by symlinking individual skill directories into your agent's skills location.

::: tip Use Case
If you formalize mathematics in Lean 4, these skills let AI assistants search Mathlib, draft and debug proofs, reuse project-specific proof patterns across sessions, and keep blueprints in sync with formal declarations.
:::

[texra-lean-skills on GitHub](https://github.com/texra-ai/texra-lean-skills)

---

## Zotero cleanup (zotcleanup)

**Point an AI agent at your Zotero library and let it fix the metadata, previewing every change before it writes.**

[![GitHub](https://img.shields.io/github/stars/texra-ai/zotero-cleanup-skills)](https://github.com/texra-ai/zotero-cleanup-skills)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/texra-ai/zotero-cleanup-skills/blob/main/LICENSE)

A working Zotero library accumulates errors. **zotcleanup** is a Claude Code / Codex skill plus independent, **dry-run-safe** scripts, built on [pyzotero](https://github.com/urschrei/pyzotero), arXiv, and Crossref, that fix it one reviewable pass at a time. Every value is looked up from a named authority (arXiv, Crossref, DBLP) above a match threshold; nothing is guessed, and nothing is written until you pass `--apply`.

### What it fixes

- **Stale item types**: arXiv preprints that were published long ago but are still typed `preprint`
- **Inconsistent venues**: one journal under several names (`Phys Rev Lett`, `Physical Review Letters`, …)
- **Import gunk**: `{{braces}}`, `&amp;`, all-caps names, and broken escapes in titles and authors
- **Placeholder DOIs**: ResearchGate / DataCite stand-ins replaced with the real DOI
- **Unfiled references**: hundreds of loose items organized

### Quick start

```text
# Claude Code
/plugin marketplace add texra-ai/zotero-cleanup-skills
```

The scripts also run standalone with [uv](https://docs.astral.sh/uv/) (Python ≥ 3.10) and your Zotero credentials. Every command defaults to a dry run that previews changes before `--apply` writes them.

::: tip Use Case
A messy library is where AI agents hallucinate citations. A verified, deduplicated Zotero library gives TeXRA's research agents real DOIs and venues to cite, keeping [Research tools](./research-tools.md) grounded.
:::

[zotero-cleanup-skills on GitHub](https://github.com/texra-ai/zotero-cleanup-skills)

---

## Contributing

The satellite projects below are MIT-licensed and welcome contributions. To report a bug, add a model to llm-zoo, extend the Mathematica tools, or contribute a new agent skill, open an issue or a pull request on the project's GitHub repository.

- [texra-ai on GitHub](https://github.com/texra-ai)
