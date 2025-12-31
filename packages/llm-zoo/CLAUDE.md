# CLAUDE.md

Guidance for Claude Code when working with this repository.

## Project Overview

**llm-zoo** is a standalone npm package providing a comprehensive registry of 70+ LLM model configurations with pricing, capabilities, and context windows. Zero runtime dependencies, full TypeScript support, tree-shakeable.

## Development Commands

```bash
# Build the package
npm run build

# Build with watch mode
npm run dev

# Type check
npm run typecheck

# Clean dist folder
npm run clean
```

## Architecture

### Source Organization

```
src/
├── index.ts           # Main entry point (no zod dependency)
├── ModelConfig.ts     # Core types, enums, defaults
├── ModelRegistry.ts   # Aggregates all provider models
├── utils.ts           # Utility functions (lookup, cost, filter, etc.)
├── schemas.ts         # Zod schemas (separate entry point)
└── providers/         # Model definitions by provider
    ├── anthropicModels.ts
    ├── openaiModels.ts
    ├── openaiReasoningModels.ts
    ├── googleModels.ts
    ├── deepseekModels.ts
    ├── xaiModels.ts
    ├── moonshotModels.ts
    ├── dashscopeModels.ts
    ├── copilotModels.ts
    └── otherModels.ts
```

### Entry Points

- `llm-zoo` - Main entry, zero dependencies
- `llm-zoo/providers` - Direct provider exports
- `llm-zoo/schemas` - Zod schemas (requires zod peer dependency)

### Key Design Decisions

1. **Zod is optional** - Main entry doesn't import schemas to avoid requiring zod
2. **Types first in exports** - Package.json exports have `types` before `import`/`require`
3. **Use `export type`** - For isolatedModules compatibility
4. **Tree-shakeable** - `sideEffects: false` in package.json

## Adding/Updating Models

### Update Existing Model

Edit the relevant file in `src/providers/`. Each model has:

```typescript
modelName: {
  name: 'modelName',           // Short name for lookup
  fullName: 'full-api-name',   // Full API model name
  provider: ModelProvider.X,
  inputPrice: 3.0,             // $/1M input tokens
  outputPrice: 15.0,           // $/1M output tokens
  contextWindow: 200000,
  maxOutputTokens: 64000,
  capabilities: { ... },
  openRouterOnly: false,
}
```

### Add New Model

1. Add to appropriate provider file in `src/providers/`
2. Follow existing patterns for capabilities
3. Update README rankings if notable

### Add New Provider

1. Create `src/providers/newProviderModels.ts`
2. Export from `src/providers/index.ts`
3. Import and spread in `src/ModelRegistry.ts`

## Type Guidelines

- `ModelConfig` - Complete model configuration
- `ModelCapabilities` - 19 capability flags
- `ModelProvider` - Enum of supported providers
- Use `Partial<ModelCapabilities>` for filtering

## Testing Changes

```bash
npm run build  # Must complete without errors
```

Verify:
- No TypeScript errors
- No warnings about export order
- ESM and CJS builds both succeed

## Publishing

```bash
npm run build
npm publish
```
