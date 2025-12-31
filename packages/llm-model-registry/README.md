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

### Cheapest Models ($/1M tokens)

| Model | Input | Output | Provider |
|-------|-------|--------|----------|
| `qwenturbo` | $0.05 | $0.50 | DashScope |
| `gpt41--` | $0.10 | $0.40 | OpenAI |
| `gemini25f-` | $0.10 | $0.40 | Google |
| `dsv3` | $0.14 | $0.28 | DeepSeek |
| `gpt4o-` | $0.15 | $0.60 | OpenAI |
| `haiku3` | $0.25 | $1.25 | Anthropic |
| `deepseek` | $0.28 | $0.42 | DeepSeek |
| `gemini3f` | $0.30 | $2.50 | Google |

### Premium Models ($/1M tokens)

| Model | Input | Output | Reasoning | Provider |
|-------|-------|--------|-----------|----------|
| `gpt45` | $75 | $150 | - | OpenAI |
| `o1pro` | $150 | $600 | ✓ | OpenAI |
| `gpt52pro` | $21 | $168 | ✓ | OpenAI |
| `opus41` | $15 | $75 | - | Anthropic |
| `opus41T` | $15 | $75 | ✓ | Anthropic |
| `o3pro` | $20 | $80 | ✓ | OpenAI |
| `gemini3p` | $2 | $12 | ✓ | Google |
| `sonnet45T` | $3 | $15 | ✓ | Anthropic |

### Largest Context Windows

| Model | Context | Provider |
|-------|---------|----------|
| `gemini3p` | 1M | Google |
| `gemini25p` | 1M | Google |
| `qwenplus` | 1M | DashScope |
| `gpt41` | 1M | OpenAI |
| `gpt5` | 400K | OpenAI |
| `kimi2` | 262K | Moonshot |
| `grok4` | 256K | xAI |
| `sonnet45` | 200K | Anthropic |

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
