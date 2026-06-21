---
created: 2026-02-02
updated: 2026-02-10
---

# PRD: Split createResponse into Phased Architecture

## Overview

Refactor `createResponse` across all model handlers into distinct phases:

1. **Build** - Construct provider-specific request parameters (ONCE)
2. **Count** - Estimate input tokens via native APIs (using built params)
3. **Validate** - Check context limits and adjust max_tokens
4. **Execute** - Make the API call (streaming or non-streaming)

**Key Principle**: Parameters are built ONCE and reused for both token counting and the actual API call. This avoids duplication and ensures consistency.

## Handlers to Modify (10 total)

| Handler                    | Base Class   | Has Token Counting      | Complexity |
| -------------------------- | ------------ | ----------------------- | ---------- |
| ModelHandler               | -            | Base method             | Low        |
| ModelHandlerOpenAI         | ModelHandler | No                      | Medium     |
| ModelHandlerAnthropic      | ModelHandler | Yes (countTokens)       | High       |
| ModelHandlerGoogleGenAI    | ModelHandler | Yes (countTokens)       | Medium     |
| ModelHandlerOpenAIResponse | ModelHandler | Yes (inputTokens.count) | High       |
| ModelHandlerKimi           | OpenAI       | Yes (custom API)        | Low        |
| ModelHandlerDeepSeek       | OpenAI       | No (inherited)          | Low        |
| ModelHandlerXAI            | OpenAI       | No (inherited)          | Low        |
| ModelHandlerOpenRouter     | OpenAI       | No (inherited)          | Medium     |
| ModelHandlerDashScope      | OpenAI       | No (inherited)          | Low        |

## Architecture

### New Types (in `types/IModelHandler.ts`)

```typescript
/** Options for token counting - all fields optional, handlers use what they need */
interface TokenCountOptions<C> {
  client?: C; // Pre-authenticated client (avoids re-auth)
  systemPrompt?: string; // System prompt to include in count
  tools?: unknown[]; // Tool definitions to include in count
  signal?: AbortSignal; // For cancellation
}

interface TokenValidationResult {
  adjustedMaxTokens: number;
  inputTokens?: number;
  utilizationPercent?: number;
}
```

### Base ModelHandler Methods

```typescript
// Phase 2: Token counting (overridable)
async estimateTokenCount(
  messages: M[],
  options?: TokenCountOptions<C>
): Promise<number>

// Phase 3: Validation (shared implementation)
protected validateTokenLimits(
  inputTokens: number,
  maxTokens: number,
  contextWindow: number
): TokenValidationResult

// Property to indicate support
get supportsTokenCounting(): boolean
```

## Phased Architecture Pattern

### Before (Current - Parameters Built Twice)

```typescript
async createResponse(options) {
  // Build params for token counting
  const countParams = { model, messages, system, tools, thinking, ... };
  const tokenCount = await client.countTokens(countParams);

  // Build params AGAIN for API call (duplication!)
  const apiParams = { model, messages, system, tools, thinking, max_tokens, ... };
  return client.messages.create(apiParams);
}
```

### After (Refactored - Parameters Built Once)

```typescript
async createResponse(options) {
  // Phase 1: BUILD - Parameters built ONCE
  const params = this.buildRequestParams(options);

  // Phase 2: COUNT - Reuse built params
  if (this.supportsTokenCounting && !skipTokenCounting) {
    try {
      const inputTokens = await this.estimateTokenCount(messages, {
        client,
        systemPrompt: params.system,
        tools: params.tools,
        thinking: params.thinking,
        contextManagement: params.context_management,
        betas: params.betas,
      });

      // Phase 3: VALIDATE - Adjust max_tokens if needed
      const validation = this.validateTokenLimits(
        inputTokens,
        params.max_tokens,
        contextWindow
      );
      if (validation.adjustedMaxTokens !== params.max_tokens) {
        params.max_tokens = validation.adjustedMaxTokens;
        // Adjust thinking budget if needed (Anthropic-specific)
      }
    } catch (err) {
      if (isContextWindowError(err)) throw err;
      this.logger.warn(`Token counting failed: ${err}. Proceeding without adjustment.`);
    }
  }

  // Phase 4: EXECUTE - Use the same params object
  return useStreaming
    ? client.messages.stream(params)
    : client.messages.create(params);
}
```

## Per-Handler Implementation

### ModelHandlerAnthropic

**Build Phase**: Extract parameter construction into `buildRequestParams()`:

- model, max_tokens, messages, temperature, stop_sequences, system
- tools (converted via toAnthropicTools)
- thinking (if supportsReasoning)
- betas (SONNET_37_OUTPUT_BETA, CONTEXT_1M_BETA, etc.)
- context_management (for tool-use mode)

**Count Phase**: Override `estimateTokenCount()`:

- Call `client.beta.messages.countTokens()` with built params
- Include tools, thinking, context_management, betas
- Handle file-based sources (skip counting - API limitation)

**Validate Phase**: Use shared `validateTokenLimits()`:

- Check against effectiveContextWindow (may be 1M with beta)
- Adjust thinking budget if max_tokens reduced

### ModelHandlerGoogleGenAI

**Build Phase**: Extract into `buildRequestParams()`:

- temperature, maxOutputTokens, stopSequences
- thinkingConfig (if supportsReasoning)
- tools (converted via toGoogleTools)

**Count Phase**: Override `estimateTokenCount()`:

- Build countContents: system (as Content) + history + upcoming message
- Call `client.models.countTokens()`

**Validate Phase**: Use shared `validateTokenLimits()`:

- Adjust `generationConfig.maxOutputTokens`

### ModelHandlerOpenAIResponse

**Build Phase**: Extract into `buildRequestParams()`:

- model, input, instructions, previous_response_id
- tools (converted), reasoning (effort + summary)
- max_output_tokens, store, tool_choice

**Count Phase**: Already has `estimateTokenCount()`:

- Call `client.responses.inputTokens.count()` with built params
- Include previous_response_id for accurate server-side history count
- Skip when routing through OpenRouter

**Validate Phase**: Use shared `validateTokenLimits()`:

- Adjust `params.max_output_tokens`

### ModelHandlerKimi

**Build Phase**: Inherits from OpenAI handler

**Count Phase**: Already has `estimateTokenCount()`:

- POST to `/v1/tokenizers/estimate-token-count`

**Validate Phase**: Add `supportsTokenCounting` getter returning true

### ModelHandlerOpenAI (Base)

**Build Phase**: Uses existing `buildChatBaseParams()` method

**Count Phase**: Calls `estimateTokenCount()` if `supportsTokenCounting` returns true

- Enables Kimi's token counting to be used via inheritance

**Validate Phase**: Uses shared `validateTokenLimits()`

- Handles both `max_tokens` and `max_completion_tokens` (O-reasoning models)

### OpenAI-derivative handlers (DeepSeek, XAI, DashScope, OpenRouter)

No changes needed - they inherit from OpenAI. Token counting will be used if any derivative implements `supportsTokenCounting: true`.

## Implementation Steps

### Step 1: Add shared infrastructure to base ModelHandler

- [x] Add `TokenValidationResult` type to `types/IModelHandler.ts`
- [x] Add `TokenCountOptions` type to `types/IModelHandler.ts`
- [x] Add `validateTokenLimits()` method using `computeReducedMaxTokens()`
- [x] Update `estimateTokenCount` signature to accept options

### Step 2: Refactor ModelHandlerAnthropic

- [x] Extract `buildRequestParams()` method for parameter construction (kept inline, params built once)
- [x] Add `estimateTokenCount()` override that accepts built params
- [x] Add `supportsTokenCounting` getter
- [x] Refactor `createResponse` to: build params → count → validate → execute

### Step 3: Refactor ModelHandlerGoogleGenAI

- [x] Extract `buildRequestParams()` method (kept inline, params built once)
- [x] Add `estimateTokenCount()` override
- [x] Add `supportsTokenCounting` getter
- [x] Refactor `createResponse` to use phased pattern

### Step 4: Refactor ModelHandlerOpenAIResponse

- [x] Extract `buildRequestParams()` method (kept inline, params built once)
- [x] Already has `estimateTokenCount()` - updated to accept options
- [x] Refactor inline token counting to call `estimateTokenCount` + `validateTokenLimits`

### Step 5: Wire up ModelHandlerKimi

- [x] Add `supportsTokenCounting` getter returning true
- [x] Already has `estimateTokenCount` override

### Step 6: Verify derivative handlers

- [x] ModelHandlerDeepSeek, XAI, DashScope, OpenRouter - no changes needed

### Step 7: Clean up and test

- [x] Run `npm run typecheck`
- [x] Run `npm run lint`
- [x] Run `npm run compile:fast`
- [ ] Manual testing with each provider

## Provider-Specific Quirks to Preserve

| Handler         | Quirk                              | How Preserved                                           |
| --------------- | ---------------------------------- | ------------------------------------------------------- |
| Anthropic       | context_management in countTokens  | Include in built params, pass to estimateTokenCount     |
| Anthropic       | Skip for file-based sources        | Check `hasFileSource` before calling estimateTokenCount |
| Anthropic       | Thinking budget adjustment         | Post-validation adjustment in createResponse            |
| OpenAI Response | previous_response_id affects count | Include in built params                                 |
| OpenAI Response | Skip for OpenRouter routing        | Check supportsNativeTokenCounting                       |
| Google          | System prompt in count             | Build as Content in countContents                       |

## Error Handling Pattern (preserve existing)

```typescript
try {
  const inputTokens = await this.estimateTokenCount(messages, tokenCountOptions);
  const validation = this.validateTokenLimits(inputTokens, maxTokens, contextWindow);
  if (validation.adjustedMaxTokens !== maxTokens) {
    params.max_tokens = validation.adjustedMaxTokens;
    this.logger.logContextManagement(`Reducing max tokens...`, {...});
  }
} catch (err) {
  if (isContextWindowError(err)) throw err;  // Hard fail
  this.logger.warn(`Token counting failed: ${err}. Proceeding without adjustment.`);  // Soft fail
}
```

## Verification Checklist

1. **Type check**: `npm run typecheck`
2. **Lint**: `npm run lint`
3. **Build**: `npm run compile:fast`
4. **Manual testing**:
   - [ ] Test each provider with a long context that triggers max_tokens adjustment
   - [ ] Verify token count is logged: "Token count: X"
   - [ ] Verify adjustment is logged when needed: "Reducing max tokens..."
   - [ ] Test streaming and non-streaming modes
   - [ ] Test with tools enabled
   - [ ] Test Anthropic with thinking mode enabled

## Risks and Mitigations

| Risk                            | Mitigation                                           |
| ------------------------------- | ---------------------------------------------------- |
| Breaking existing behavior      | Preserve soft-failure pattern, comprehensive testing |
| Provider-specific params missed | Detailed analysis done, quirks documented above      |
| Streaming affected              | Execute phase unchanged, only pre-flight affected    |
| Performance regression          | Token counting already happens, just reorganized     |

## Critical Files

```
src/agent/modelHandlers/
├── ModelHandler.ts                    # Base class - validateTokenLimits, estimateTokenCount
├── modelHandlerAnthropic.ts           # Add estimateTokenCount, refactor createResponse
├── modelHandlerGoogleGenAI.ts         # Add estimateTokenCount, refactor createResponse
├── modelHandlerOpenAI.ts              # No changes (no native token counting)
├── modelHandlerOpenAIResponse.ts      # Refactor to use estimateTokenCount + validateTokenLimits
├── modelHandlerKimi.ts                # Add supportsTokenCounting
├── modelHandlerDeepSeek.ts            # No changes
├── modelHandlerXAI.ts                 # No changes
├── modelHandlerOpenRouter.ts          # No changes
├── modelHandlerDashScope.ts           # No changes
├── contextManagementConstants.ts      # Already has computeReducedMaxTokens (use as-is)
└── types/IModelHandler.ts             # TokenCountOptions, TokenValidationResult types
```

## Implementation Review Status

### Modular ✅

- `validateTokenLimits()` is a shared method in the base class
- `estimateTokenCount()` is an overridable method with consistent signature
- Each handler implements provider-specific counting logic

### DRY ✅

- Token validation logic centralized in `validateTokenLimits()`
- `computeReducedMaxTokens()` reused from `contextManagementConstants.ts`
- Error handling pattern consistent across all handlers
- Removed duplicate imports from refactored handlers

### Works ✅

| Handler            | estimateTokenCount | validateTokenLimits       | Called in createResponse                     |
| ------------------ | ------------------ | ------------------------- | -------------------------------------------- |
| Anthropic          | ✅ Implemented     | ✅ Used                   | ✅ Yes                                       |
| Google             | ✅ Implemented     | ✅ Used                   | ✅ Yes                                       |
| OpenAI Response    | ✅ Implemented     | ✅ Used                   | ✅ Yes                                       |
| OpenAI (base)      | ✅ Calls override  | ✅ Used                   | ✅ Yes                                       |
| Kimi               | ✅ Implemented     | ✅ Used (via OpenAI base) | ✅ Yes                                       |
| OpenAI derivatives | ❌ N/A             | ❌ N/A                    | ✅ Ready (if they add supportsTokenCounting) |

### Build Status ✅

- `npm run typecheck` - Passes
- `npm run lint` - Passes (no new warnings)
- `npm run compile` - Passes
- `npm run compile:fast` - Passes
