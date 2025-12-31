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

## Providers

| Provider | Models | Notable |
|----------|--------|---------|
| **Anthropic** | Claude 4.x, 3.x | 90% cache savings |
| **OpenAI** | GPT-5.x, 4.x, o-series | Deep research |
| **Google** | Gemini 3, 2.5 | 1M context |
| **DeepSeek** | V3.2, R1 | Budget reasoning |
| **xAI** | Grok 4, 3, 2 | 256K context |
| **Moonshot** | Kimi K2 | Thinking mode |
| **DashScope** | Qwen 3 | 1M context |
| **Copilot** | GPT-4o | Free |
| **OpenRouter** | Llama, etc. | Proxy access |

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

interface ModelCapabilities {
  supportsFunctionCalling: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  supportsNativeCodeExecution: boolean;
  supportsNativeWebSearch: boolean;
  supportsPromptCaching: boolean;
  cacheDiscountFactor: number;
  // ... and more
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
