# llm-model-registry

> The single source of truth for LLM pricing, capabilities, and configurations.

```typescript
import { lookup, cost, cheapest } from 'llm-model-registry';

const claude = lookup('sonnet45');
const price = cost('gpt4o', { input: 50000, output: 10000 });
const budget = cheapest({ supportsVision: true });
```

**70+ models. 9 providers. Zero dependencies. Full TypeScript.**

## Install

```bash
npm install llm-model-registry
```

## What's Inside

### By Price ($/1M tokens, input+output)

| Rank | Model | Price | Provider |
|------|-------|-------|----------|
| 1 | `gpt5--` | $0.45 | OpenAI |
| 2 | `gpt41--` | $0.50 | OpenAI |
| 3 | `gemini25f-` | $0.50 | Google |
| 4 | `qwenturbo` | $0.55 | DashScope |
| 5 | `deepseek` | $0.70 | DeepSeek |
| 6 | `grok3-` | $0.80 | xAI |
| 7 | `haiku3` | $1.50 | Anthropic |
| 8 | `gpt4o-` | $0.75 | OpenAI |

### By Context Window

| Rank | Model | Context | Provider |
|------|-------|---------|----------|
| 1 | `gemini3p` | 1M | Google |
| 2 | `gemini25p` | 1M | Google |
| 3 | `qwenplus` | 1M | DashScope |
| 4 | `gpt41` | 1M | OpenAI |
| 5 | `gpt5` | 400K | OpenAI |
| 6 | `kimi2` | 262K | Moonshot |
| 7 | `grok4` | 256K | xAI |
| 8 | `sonnet45` | 200K | Anthropic |

### By Capability

| Capability | Count | Examples |
|------------|-------|----------|
| Vision | 45+ | `sonnet45`, `gpt4o`, `gemini25p` |
| Reasoning | 30+ | `opus45T`, `o3`, `deepseekT`, `grok4` |
| Code Execution | 20+ | `sonnet45`, `gpt41`, `gemini3p` |
| Web Search | 15+ | `opus45`, `gpt4o`, `o3` |
| Prompt Caching | 25+ | All Claude, Gemini, DeepSeek |

### Providers

| Provider | Models | Highlights |
|----------|--------|------------|
| **Anthropic** | 21 | 90% cache savings, PDF support |
| **OpenAI** | 28 | o-series reasoning, deep research |
| **Google** | 6 | 1M context, audio input |
| **DeepSeek** | 7 | Budget reasoning ($0.28/1M) |
| **xAI** | 5 | Grok 4 with 256K context |
| **Moonshot** | 8 | Kimi K2 thinking mode |
| **DashScope** | 3 | Qwen with 1M context |
| **Copilot** | 1 | Free GPT-4o |
| **OpenRouter** | 2 | Llama 405B, QVQ-72B |

## API

### Lookup

```typescript
lookup('sonnet45')              // → ModelConfig | undefined
resolve('claude-sonnet-4-5')    // → by full API name
exists('gpt4o')                 // → true
```

### Filter

```typescript
from(ModelProvider.ANTHROPIC)   // → all Claude models
where(c => c.supportsVision)    // → by capability predicate
supporting('supportsReasoning') // → by specific capability
withContext(500000)             // → 500K+ context models
```

### Cost

```typescript
cost('sonnet45', { input: 10000, output: 5000 })
cost('sonnet45', { input: 10000, output: 5000, cached: 8000 })  // with caching
maxCost('gpt4o', 50000)                                         // worst case
compareCosts(['sonnet45', 'gpt4o'], { input: 10000, output: 2000 })
```

### Select

```typescript
cheapest({ supportsVision: true })
cheapest({ supportsReasoning: true }, { minContext: 100000 })
smartpick(5)                    // best under $5/1M tokens
ranked('price')                 // cheapest first
ranked('context', 'desc')       // largest context first
```

### Stats

```typescript
const { totalModels, providers, pricing, context } = insights();
```

## Data Structure

```typescript
interface ModelConfig {
  name: string;              // 'sonnet45'
  fullName: string;          // 'claude-sonnet-4-5'
  provider: ModelProvider;
  inputPrice: number;        // $/1M tokens
  outputPrice: number;
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: ModelCapabilities;
  openRouterOnly: boolean;
  openrouterFullName?: string;
}
```

## Examples

### LLM Router

```typescript
import { where, cost } from 'llm-model-registry';

function route(needs: { vision?: boolean; budget: number; tokens: number }) {
  return where(c => !needs.vision || c.supportsVision)
    .filter(m => cost(m, { input: needs.tokens, output: 4000 }) <= needs.budget)
    .sort((a, b) => a.inputPrice - b.inputPrice)[0];
}
```

### Cost Dashboard

```typescript
import { cost, MODEL_CONFIGS } from 'llm-model-registry';

const report = Object.entries(usage).map(([model, tokens]) => ({
  model,
  spent: cost(model, tokens),
  provider: MODEL_CONFIGS[model]?.provider,
}));
```

## Direct Access

```typescript
import { MODEL_CONFIGS, MODELS, ANTHROPIC_MODELS } from 'llm-model-registry';

MODEL_CONFIGS['sonnet45'].inputPrice;
MODELS.forEach(name => ...);
Object.keys(ANTHROPIC_MODELS);
```

## License

MIT
