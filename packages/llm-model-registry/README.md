# LLM Model Registry

A comprehensive, type-safe registry of Large Language Model configurations with pricing, capabilities, and provider details.

## Features

- **70+ models** from 9 providers (Anthropic, OpenAI, Google, DeepSeek, xAI, Moonshot, DashScope, Copilot, and more)
- **Full TypeScript support** with detailed type definitions
- **Capability-based filtering** for finding models that match your requirements
- **Cost calculation utilities** including prompt caching support
- **Zero dependencies** - pure TypeScript with no runtime dependencies
- **Tree-shakeable** - only import what you need

## Installation

```bash
npm install llm-model-registry
# or
yarn add llm-model-registry
# or
pnpm add llm-model-registry
```

## Quick Start

```typescript
import { MODEL_CONFIGS, getModel, calculateCost } from 'llm-model-registry';

// Access model configuration directly
const sonnet = MODEL_CONFIGS['sonnet45'];
console.log(sonnet.contextWindow); // 200000
console.log(sonnet.inputPrice);    // 3.0 ($/1M tokens)

// Use helper function
const gpt4o = getModel('gpt4o');
console.log(gpt4o?.capabilities.supportsVision); // true

// Calculate cost
const cost = calculateCost('sonnet45', 10000, 5000);
console.log(`Cost: $${cost.toFixed(4)}`); // Cost: $0.1050
```

## API Reference

### Types

#### `ModelConfig`

Complete configuration for a language model:

```typescript
interface ModelConfig {
  name: string;              // Short name (e.g., "sonnet45")
  fullName: string;          // API model ID (e.g., "claude-sonnet-4-5")
  provider: ModelProvider;   // Provider enum value
  maxOutputTokens: number;   // Max tokens in response
  inputPrice: number;        // $/1M input tokens
  outputPrice: number;       // $/1M output tokens
  contextWindow: number;     // Max context size
  capabilities: ModelCapabilities;
  openRouterOnly: boolean;   // Only available via OpenRouter
  openrouterFullName?: string;
  baseUrl?: string;          // Custom endpoint
  requiresResponsesAPI?: boolean;
}
```

#### `ModelCapabilities`

Feature flags for model capabilities:

```typescript
interface ModelCapabilities {
  supportsFunctionCalling: boolean;
  supportsNativeMCPServer: boolean;
  supportsNativeWebSearch: boolean;
  supportsNativeCodeExecution: boolean;
  supportsPromptCaching: boolean;
  supportsAutoPromptCaching: boolean;
  cacheDiscountFactor: number;  // 0.1 = 90% savings
  supportsReasoning: boolean;
  supportsInterleavedThinking: boolean;
  supportsReasoningEffort: boolean;
  reasoningEffort: ReasoningEffort;
  supportsVision: boolean;
  supportsNativePdf: boolean;
  supportsNativeAudio: boolean;
  supportsAssistantPrefill: boolean;
  supportsPredictiveOutput: boolean;
  supportsTokenCounting: boolean;
  supportsSystemPrompt: boolean;
  supportsIntermDevMsgs: boolean;
}
```

#### `ModelProvider`

Enum of supported providers:

```typescript
enum ModelProvider {
  ANTHROPIC = 'anthropic',
  OPENAI = 'openai',
  GOOGLE = 'google',
  DEEPSEEK = 'deepseek',
  XAI = 'xai',
  MOONSHOT = 'moonshot',
  DASHSCOPE = 'dashscope',
  COPILOT = 'copilot',
  OTHERS = 'others',
}
```

### Registry Access

#### `MODEL_CONFIGS`

The complete model registry indexed by short name:

```typescript
import { MODEL_CONFIGS } from 'llm-model-registry';

const claude = MODEL_CONFIGS['sonnet45'];
const gpt = MODEL_CONFIGS['gpt4o'];
```

#### `MODELS`

Array of all model short names:

```typescript
import { MODELS } from 'llm-model-registry';

console.log(MODELS); // ['opus45T', 'opus45', 'sonnet45', ...]
```

#### Individual Provider Exports

Access models by provider:

```typescript
import {
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  GOOGLE_MODELS,
  DEEPSEEK_MODELS,
  // ...
} from 'llm-model-registry';
```

### Utility Functions

#### Model Lookup

```typescript
import { getModel, getModelByFullName, hasModel } from 'llm-model-registry';

// Get by short name
const model = getModel('sonnet45');

// Get by full API name
const model2 = getModelByFullName('claude-sonnet-4-5');

// Check existence
if (hasModel('gpt4o')) { ... }
```

#### Filtering

```typescript
import {
  getModelsByProvider,
  filterByCapability,
  getModelsWithCapability,
  getModelsByAccess,
  ModelProvider,
} from 'llm-model-registry';

// Get all Anthropic models
const anthropicModels = getModelsByProvider(ModelProvider.ANTHROPIC);

// Get models with specific capabilities
const reasoningModels = filterByCapability(c => c.supportsReasoning);

// Get all vision models
const visionModels = getModelsWithCapability('supportsVision');

// Get OpenRouter-only models
const openRouterModels = getModelsByAccess(true);
```

#### Cost Calculation

```typescript
import { calculateCost, estimateMaxCost } from 'llm-model-registry';

// Basic cost calculation
const cost = calculateCost('sonnet45', 10000, 5000);

// With cached tokens (for models with prompt caching)
const cachedCost = calculateCost('sonnet45', 10000, 5000, 8000);

// Estimate maximum possible cost
const maxCost = estimateMaxCost('sonnet45', 50000);
```

#### Model Comparison

```typescript
import { sortModelsByMetric, findCheapestModel } from 'llm-model-registry';

// Sort by different metrics
const cheapest = sortModelsByMetric('price', true);
const largestContext = sortModelsByMetric('context', false);

// Find cheapest model meeting requirements
const cheapestVision = findCheapestModel({ supportsVision: true });
const cheapestReasoning = findCheapestModel(
  { supportsReasoning: true },
  100000 // min context
);
```

#### Registry Statistics

```typescript
import { getRegistryStats } from 'llm-model-registry';

const stats = getRegistryStats();
console.log(`Total models: ${stats.totalModels}`);
console.log(`Price range: $${stats.priceRange.min} - $${stats.priceRange.max}`);
console.log(`Models with vision: ${stats.capabilityCounts.supportsVision}`);
```

## Use Cases

### Building an LLM Router

```typescript
import { filterByCapability, sortModelsByMetric } from 'llm-model-registry';

function selectModel(requirements: {
  needsVision?: boolean;
  needsReasoning?: boolean;
  minContext?: number;
  preferCheap?: boolean;
}) {
  let candidates = filterByCapability(c => {
    if (requirements.needsVision && !c.supportsVision) return false;
    if (requirements.needsReasoning && !c.supportsReasoning) return false;
    return true;
  });

  if (requirements.minContext) {
    candidates = candidates.filter(m => m.contextWindow >= requirements.minContext);
  }

  if (requirements.preferCheap) {
    candidates.sort((a, b) =>
      (a.inputPrice + a.outputPrice) - (b.inputPrice + b.outputPrice)
    );
  }

  return candidates[0];
}
```

### Cost Estimation Dashboard

```typescript
import { MODEL_CONFIGS, calculateCost } from 'llm-model-registry';

function estimateMonthlyCost(
  modelName: string,
  dailyRequests: number,
  avgInputTokens: number,
  avgOutputTokens: number,
  cacheHitRate: number = 0
) {
  const model = MODEL_CONFIGS[modelName];
  if (!model) throw new Error(`Unknown model: ${modelName}`);

  const cachedTokens = avgInputTokens * cacheHitRate;
  const costPerRequest = calculateCost(
    model,
    avgInputTokens,
    avgOutputTokens,
    cachedTokens
  );

  return costPerRequest * dailyRequests * 30;
}
```

### Model Selection UI

```typescript
import { getModelsByProvider, ModelProvider } from 'llm-model-registry';

function renderModelSelector() {
  const providers = Object.values(ModelProvider);

  return providers.map(provider => ({
    label: provider,
    models: getModelsByProvider(provider).map(m => ({
      value: m.name,
      label: m.fullName,
      price: `$${m.inputPrice}/$${m.outputPrice} per 1M tokens`,
      context: `${(m.contextWindow / 1000).toFixed(0)}K context`,
    }))
  }));
}
```

## Contributing

Contributions are welcome! When adding new models:

1. Add the model configuration to the appropriate provider file in `src/providers/`
2. Ensure all capability flags are accurate
3. Include the OpenRouter model name if available
4. Update pricing information from official sources

## License

MIT
