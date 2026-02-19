# Open Source Projects

TeXRA is built on the belief that great research tools benefit from community collaboration. We've open-sourced key components of our infrastructure so that developers, researchers, and tool builders can use and contribute to them independently.

## llm-zoo

**One package to lookup any LLM's pricing, capabilities, and context window.**

[![npm](https://img.shields.io/npm/v/llm-zoo)](https://www.npmjs.com/package/llm-zoo)
[![GitHub](https://img.shields.io/github/stars/texra-ai/llm-zoo)](https://github.com/texra-ai/llm-zoo)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/texra-ai/llm-zoo/blob/main/LICENSE)

Keeping track of LLM pricing, context windows, and capabilities across providers is a moving target. **llm-zoo** solves this by providing a single, typed, zero-dependency package covering 70+ models from Claude, GPT, Gemini, DeepSeek, Grok, and more.

### Highlights

- **70+ models** across Anthropic, OpenAI, Google, DeepSeek, xAI, Moonshot, DashScope, Copilot, and OpenRouter
- **Zero dependencies** — lightweight with full TypeScript support
- **Tree-shakeable** for efficient bundling
- **Zod schemas** for runtime validation (Zod v4)
- **Always current** — pricing and capabilities regularly updated

### Quick Start

```bash
npm install llm-zoo
```

```typescript
import { lookup, cost, from, cheapest, ModelProvider } from 'llm-zoo';

// Look up a model
const claude = lookup('sonnet');
console.log(claude.contextWindow); // 200000

// Calculate cost
const usage = { inputTokens: 1000, outputTokens: 500 };
console.log(cost('sonnet', usage)); // { input: 0.003, output: 0.0075, total: 0.0105 }

// Find the cheapest model with vision support
const model = cheapest({ capabilities: ['vision'] });

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
llm-zoo powers TeXRA's model selection and cost estimation internally. If you're building LLM-powered tools, routing logic, or cost dashboards, it saves you from maintaining your own model registry.
:::

[GitHub Repository](https://github.com/texra-ai/llm-zoo) · [npm Package](https://www.npmjs.com/package/llm-zoo)

---

## MCP Server for Mathematica

**A Model Context Protocol server that bridges MCP clients to a local Mathematica installation.**

[![GitHub](https://img.shields.io/github/stars/texra-ai/mcp-server-mathematica)](https://github.com/texra-ai/mcp-server-mathematica)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/texra-ai/mcp-server-mathematica/blob/main/LICENSE)

Research in physics, mathematics, and engineering often requires symbolic computation. **mcp-server-mathematica** lets any MCP-compatible client (Cursor, Claude Desktop, and others) execute Mathematica code and verify mathematical derivations through a local `wolframscript` installation.

### Highlights

- **Execute Mathematica code** from any MCP client
- **Verify derivation steps** — validate that algebraic transformations are correct
- **Multiple output formats** — text, LaTeX, or Mathematica expressions
- **Lightweight** — Node.js server communicating over stdio

### Tools Provided

#### `execute_mathematica`

Run arbitrary Mathematica expressions and get results in your preferred format.

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

### Quick Start

```bash
git clone https://github.com/texra-ai/mcp-server-mathematica.git
cd mcp-server-mathematica
npm install
npm run build
node build/index.js
```

Then configure your MCP client to connect to the running server.

::: tip Use Case
mcp-server-mathematica powers TeXRA's mathematical verification capabilities. It's especially useful for physicists and mathematicians who want AI assistants to check symbolic derivations against a proper computer algebra system rather than relying on LLM arithmetic alone.
:::

[GitHub Repository](https://github.com/texra-ai/mcp-server-mathematica)

---

## Contributing

Both projects are MIT-licensed and welcome contributions. If you find a bug, want to add a model to llm-zoo, or want to extend the Mathematica tools — open an issue or submit a pull request on the respective GitHub repository.

- [texra-ai on GitHub](https://github.com/texra-ai)
