# 🧠 LLM Model Registry

> **The single source of truth for LLM pricing, capabilities, and configurations.**

Stop copy-pasting model specs from documentation. Stop guessing at pricing. Stop wondering which model supports what.

```typescript
import { lookup, cost, smartpick } from 'llm-model-registry';

// Know everything about any model
const claude = lookup('sonnet45');
console.log(claude.contextWindow);  // 200000
console.log(claude.inputPrice);     // $3/1M tokens

// Calculate exact costs
const price = cost('gpt4o', { input: 50000, output: 10000 });
console.log(`This will cost $${price.toFixed(4)}`);

// Find the perfect model for your budget
const best = smartpick(5);  // Best model under $5/1M tokens
```

## Why?

Every LLM application needs to know:
- **What models exist** and their identifiers
- **What they cost** (input, output, cached tokens)
- **What they can do** (vision, reasoning, code execution, etc.)
- **How to access them** (direct API, OpenRouter, custom endpoints)

This package gives you all of that in a single, type-safe, zero-dependency import.

## Installation

```bash
npm install llm-model-registry
```

## What's Inside

**70+ models** from **9 providers**:

| Provider | Models | Highlights |
|----------|--------|------------|
| Anthropic | Claude 4.x, 3.x | Opus, Sonnet, Haiku variants |
| OpenAI | GPT-5.x, 4.x, o-series | Reasoning models, deep research |
| Google | Gemini 3, 2.5 | 1M context, code execution |
| DeepSeek | V3.2, R1 | 90% cache savings |
| xAI | Grok 4, 3, 2 | Large context, reasoning |
| Moonshot | Kimi K2 | Thinking variants |
| DashScope | Qwen 3 | Alibaba models |
| Copilot | GPT-4o | Free tier |
| Others | Llama, etc. | Via OpenRouter |

## API at a Glance

### 🔍 Lookup

```typescript
import { lookup, resolve, exists } from 'llm-model-registry';

lookup('sonnet45');                    // By short name
resolve('claude-sonnet-4-5');          // By API identifier
exists('gpt4o');                       // Check if exists → true
```

### 🎯 Filtering

```typescript
import { from, where, supporting, withContext, ModelProvider } from 'llm-model-registry';

// By provider
from(ModelProvider.ANTHROPIC);         // All Claude models

// By capability predicate
where(c => c.supportsVision && c.supportsReasoning);

// By specific capability
supporting('supportsNativeCodeExecution');

// By context window
withContext(500000);                   // 500K+ context
```

### 💰 Cost Intelligence

```typescript
import { cost, maxCost, compareCosts } from 'llm-model-registry';

// Exact cost calculation
cost('sonnet45', { input: 10000, output: 5000 });

// With prompt caching (Claude's 90% savings!)
cost('sonnet45', { input: 10000, output: 5000, cached: 8000 });

// Worst-case estimate
maxCost('gpt4o', 50000);  // If model outputs max tokens

// Compare across models
compareCosts(['sonnet45', 'gpt4o', 'gemini25p'], { input: 10000, output: 2000 });
// → [{ model: gemini25p, cost: 0.032 }, { model: sonnet45, cost: 0.06 }, ...]
```

### 🎨 Smart Selection

```typescript
import { cheapest, smartpick, ranked } from 'llm-model-registry';

// Cheapest meeting requirements
cheapest({ supportsVision: true });
cheapest({ supportsReasoning: true }, { minContext: 100000 });

// Best model within budget (scores by capabilities)
smartpick(5);                          // Under $5/1M tokens
smartpick(10, { supportsReasoning: true });

// Ranked lists
ranked('price');                       // Cheapest first
ranked('context', 'desc');             // Largest context first
```

### 📊 Insights

```typescript
import { insights } from 'llm-model-registry';

const stats = insights();
console.log(stats.totalModels);        // 70+
console.log(stats.providers);          // { anthropic: 21, openai: 28, ... }
console.log(stats.capabilities);       // { Vision: 45, Reasoning: 32, ... }
console.log(stats.pricing.cheapest);   // The $0.05 model
console.log(stats.context.largest);    // The 1M+ context model
```

## Data Structure

Every model includes:

```typescript
interface ModelConfig {
  name: string;              // 'sonnet45'
  fullName: string;          // 'claude-sonnet-4-5'
  provider: ModelProvider;   // ANTHROPIC

  // Pricing (per 1M tokens)
  inputPrice: number;        // 3.0
  outputPrice: number;       // 15.0

  // Limits
  contextWindow: number;     // 200000
  maxOutputTokens: number;   // 64000

  // Access
  openRouterOnly: boolean;
  openrouterFullName?: string;
  baseUrl?: string;

  // Capabilities
  capabilities: {
    supportsFunctionCalling: boolean;
    supportsVision: boolean;
    supportsReasoning: boolean;
    supportsNativeCodeExecution: boolean;
    supportsNativeWebSearch: boolean;
    supportsPromptCaching: boolean;
    cacheDiscountFactor: number;  // 0.1 = 90% savings
    // ... and more
  };
}
```

## Real-World Examples

### Build an LLM Router

```typescript
import { where, cost } from 'llm-model-registry';

function routeRequest(task: {
  needsVision?: boolean;
  needsReasoning?: boolean;
  inputTokens: number;
  maxBudget: number;
}) {
  // Find capable models
  let candidates = where(c => {
    if (task.needsVision && !c.supportsVision) return false;
    if (task.needsReasoning && !c.supportsReasoning) return false;
    return true;
  });

  // Filter by budget
  candidates = candidates.filter(m =>
    cost(m, { input: task.inputTokens, output: m.maxOutputTokens }) <= task.maxBudget
  );

  // Return cheapest viable option
  return candidates.sort((a, b) =>
    a.inputPrice + a.outputPrice - b.inputPrice - b.outputPrice
  )[0];
}
```

### Usage Dashboard

```typescript
import { MODEL_CONFIGS, cost } from 'llm-model-registry';

function generateReport(usage: Record<string, { input: number; output: number }>) {
  return Object.entries(usage).map(([model, tokens]) => ({
    model,
    fullName: MODEL_CONFIGS[model]?.fullName,
    cost: cost(model, tokens),
    provider: MODEL_CONFIGS[model]?.provider,
  }));
}
```

### Model Comparison UI

```typescript
import { lookup, compareCosts } from 'llm-model-registry';

function CompareModels({ models, tokens }) {
  const comparison = compareCosts(models, tokens);

  return comparison.map(({ model, cost }) => ({
    name: model.name,
    cost: `$${cost.toFixed(4)}`,
    context: `${(model.contextWindow / 1000)}K`,
    vision: model.capabilities.supportsVision ? '✓' : '✗',
    reasoning: model.capabilities.supportsReasoning ? '✓' : '✗',
  }));
}
```

## Direct Registry Access

Skip utilities and access data directly:

```typescript
import { MODEL_CONFIGS, MODELS, ANTHROPIC_MODELS } from 'llm-model-registry';

// All models as a record
MODEL_CONFIGS['sonnet45'].inputPrice;

// Array of all model names
MODELS.forEach(name => console.log(name));

// Provider-specific exports
Object.keys(ANTHROPIC_MODELS);  // ['opus45T', 'opus45', 'sonnet45', ...]
```

## TypeScript

Full type inference out of the box:

```typescript
import type { ModelConfig, ModelCapabilities, ModelProvider } from 'llm-model-registry';

function processModel(config: ModelConfig) {
  // Full autocomplete for config.capabilities.*
}
```

## Bundle Size

- **Zero runtime dependencies**
- **Tree-shakeable** - import only what you use
- **~15KB minified** for the full registry

## Contributing

Model data getting stale? Pricing changed? New model released?

1. Update the relevant file in `src/providers/`
2. Ensure all capability flags are accurate
3. Submit a PR

## License

MIT

---

<p align="center">
  <b>Stop hardcoding model configs. Start shipping.</b>
</p>
