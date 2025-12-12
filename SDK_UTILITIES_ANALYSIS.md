# SDK Utilities Analysis for TeXRA - Deep Analysis

This document provides a thorough analysis of SDK utilities vs. custom implementations in TeXRA, based on line-by-line code review.

## Executive Summary

After deep code analysis comparing actual implementations with SDK capabilities:

| SDK | Total Custom Lines | Actually Replaceable | Reason |
|-----|-------------------|---------------------|--------|
| @anthropic-ai/sdk | ~2,500 | ~40-60 lines (2-3%) | Most is necessary application logic |
| openai | ~3,150 | ~135-170 lines (4-5%) | Stream events, type guards |
| @google/genai | ~800 | ~15 lines | Already using SDK well |
| zod | Excellent usage | N/A | Minor enhancements only |
| Error handling | ~900 | ~0 lines | Well-architected, SDK-native |

**Key Finding:** TeXRA's SDK usage is already well-optimized. Most "custom" code is legitimate application logic that SDKs don't provide.

---

## 1. Anthropic SDK - Detailed Analysis

### What TeXRA Already Uses Correctly
```typescript
// Direct SDK usage (optimal)
import { Anthropic, toFile } from '@anthropic-ai/sdk';
await client.beta.messages.stream(options);     // ✓ Native streaming
await stream.finalMessage();                     // ✓ SDK method
await client.beta.messages.countTokens(...);    // ✓ Native token counting
await client.beta.files.upload(...);            // ✓ Native file upload
```

### Why Custom Code Cannot Be Replaced

#### Cache Control Management (~100 lines)
**SDK provides:** `CacheControlEphemeral` type
**SDK does NOT provide:** Cache control lifecycle management
```typescript
// TeXRA tracks which blocks have cache_control and enforces MAX_CACHE_CONTROLLED_BLOCKS = 4
private setCacheControlTarget(block: CacheControlEligibleBlock): void {
  if (this.cacheControlledBlock && this.cacheControlledBlock !== block) {
    delete this.cacheControlledBlock.cache_control;  // Manual cleanup
  }
  block.cache_control = EPHEMERAL_CACHE_CONTROL;
  this.cacheControlledBlock = block;
}
```
**Verdict:** Cannot replace - SDK only provides types, not state management

#### Beta Feature Tracking (~60 lines)
**SDK provides:** `betas` array parameter
**SDK does NOT provide:** Beta string constants (they change over time)
```typescript
const CONTEXT_1M_BETA: AnthropicBeta = 'context-1m-2025-08-07';
const FILES_API_BETA: AnthropicBeta = 'files-api-2025-04-14';
const INTERLEAVED_THINKING_BETA: AnthropicBeta = 'interleaved-thinking-2025-05-14';
```
**Verdict:** Cannot replace - application must track beta versions

#### Streaming State Machine (AnthropicStreamHandler.ts - 354 lines)
**SDK provides:** `stream.on('streamEvent', ...)` raw events
**SDK does NOT provide:** Multi-block coordination, consecutive text merging, web search JSON accumulation

```typescript
// TeXRA handles interleaved blocks: thinking → text → server_tool → text
// SDK only emits raw events - coordination is application responsibility
interface AnthropicStreamState {
  outputStream: Stream | null;
  lastBlockIndex: number;
  pendingSearches: Map<string, { index: number; input: string }>;
  emittedSearchIds: Set<string>;
  finalized: boolean;
}
```
**Verdict:** Cannot replace - SDK emits events but doesn't manage state

#### Token Adjustment Algorithm (~50 lines)
**SDK provides:** `countTokens()` result
**SDK does NOT provide:** Max tokens adjustment based on context window
```typescript
// TeXRA adjusts max_tokens AND thinking budget proportionally
if (effectiveContextWindow - inputTokens < options.max_tokens) {
  options.max_tokens = Math.max(0, effectiveContextWindow - inputTokens - 10);
  if (options.thinking?.type === 'enabled') {
    options.thinking.budget_tokens = Math.floor(options.max_tokens * 0.5);
  }
}
```
**Verdict:** Cannot replace - business logic specific to TeXRA

#### Thinking Block Persistence (~80 lines)
**SDK provides:** `ThinkingBlock` type in response
**SDK does NOT provide:** Cross-turn thinking block preservation
```typescript
// TeXRA stores thinking blocks for conversation continuation
workspaceState.reasoning.thinkingBlocks = thinkingBlocks;
// Later reattaches them to follow-up messages
assistantMessage.content.push(...thinkingBlocks);
```
**Verdict:** Cannot replace - SDK doesn't manage conversation state

### What Could Potentially Be Optimized (~40-60 lines)

1. **Type guards** (lines 142-173) - Could be inlined but reduces readability
2. **Tool call mapping** (lines 1697-1710) - Could extract to shared utility
3. **Web search result parsing** - Could share with OpenAI handler

**Net realistic savings:** 40-60 lines (2-3% of 2,500 lines)

---

## 2. OpenAI SDK - Detailed Analysis

### What TeXRA Already Uses Correctly
```typescript
import OpenAI from 'openai';
import { isAssistantMessage } from 'openai/lib/chatCompletionUtils';  // ✓ SDK helper
stream.on('content.delta', onContentDelta);   // ✓ SDK streaming
stream.on('chunk', onChunk);                   // ✓ SDK streaming
```

### Actually Replaceable Code (~135-170 lines)

#### 1. Stream Event Type Guards (~50 lines reducible)
**Current:** Custom type guard functions
```typescript
private isReasoningDeltaEvent(event: ResponseStreamEvent):
  event is ResponseReasoningTextDeltaEvent | ... {
  return event.type === 'response.reasoning_text.delta' ||
         event.type === 'response.reasoning_summary_text.delta';
}
```
**SDK Alternative:** TypeScript discriminated unions work directly
```typescript
// No custom guards needed - TypeScript narrows based on event.type
if (event.type === 'response.reasoning_text.delta') {
  // TypeScript knows event.delta exists
}
```
**Verdict:** Can remove ~50 lines of type guards

#### 2. Tool Argument Parsing (~35 lines reducible)
**Current:** Manual JSON parsing with fallback
```typescript
protected parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); }
  catch { return raw; }
}
```
**SDK Alternative:** `zodFunction()` with auto-parsing
```typescript
import { zodFunction } from 'openai/helpers/zod';
const tool = zodFunction({ name: 'read_file', parameters: ReadInputSchema });
// SDK auto-parses arguments
```
**Caveat:** Requires converting existing schemas - medium effort

#### 3. Additional Type Guards (~10-15 lines)
```typescript
// Could add SDK guards
import { isToolMessage, isPresent } from 'openai/lib/chatCompletionUtils';
```

### What Cannot Be Replaced

#### Token Counting (~60 lines)
**SDK provides:** Nothing for Chat Completions API
**Current:** Uses `gpt-tokenizer` library - correct approach

#### Background Response Polling (~160 lines)
**SDK provides:** Low-level `responses.retrieve()`
**SDK does NOT provide:** High-level polling helper with retry logic
**Verdict:** Cannot replace - necessary for Responses API background mode

#### DeepSeek Reasoning Extraction (~40 lines)
**SDK provides:** Nothing - DeepSeek format not in SDK schema
**Current:** Custom extraction from `reasoning_content` field
**Verdict:** Cannot replace until SDK adds DeepSeek support

---

## 3. Tool Definition System - Already Optimal

### Current Implementation
```typescript
// src/tools/core/define.ts
export function defineTool<T>(def: { name, description, schema: ZodType<T> }) {
  const baseDefinition: ToolDefinition = {
    name: def.name,
    description: def.description,
    parameters: toJSONSchema(def.schema, {
      target: 'draft-2020-12',
      unrepresentable: 'any',
      io: 'input',
    }),
  };
  // Returns abstract class for inheritance
}
```

### Why This Is Better Than SDK Alternatives

| Aspect | TeXRA Approach | SDK Alternative | Winner |
|--------|---------------|-----------------|--------|
| Multi-provider | Single definition → adapts to all | Provider-specific | TeXRA |
| Validation | Built-in Zod validation | Manual | TeXRA |
| Error diagnostics | ZodError issues extraction | None | TeXRA |
| Inheritance | Abstract class pattern | None | TeXRA |

**Verdict:** Current approach is cleaner than SDK's `zodFunction()` for multi-provider support

---

## 4. Error Handling - Already Optimal

### Current Architecture
```typescript
// src/common/errors/sdkErrorUtils.ts
// Imports ALL SDK error types from Anthropic, OpenAI, Google
// Classifies by retryability and status code
// Uses WeakMap for context enrichment (non-invasive)

export function formatProviderHttpError(err: unknown): ProviderHttpErrorDetails {
  // Handles: RateLimitError, AuthenticationError, BadRequestError,
  //          APIConnectionTimeoutError, etc. from ALL providers
}
```

### Why No Replacement Needed

1. **Already uses SDK error classes** - imports all specific error types
2. **Adds value** - unified classification across providers
3. **Clean pattern** - WeakMap enrichment, log-at-boundary principle
4. **Retry logic** - separated into flow layer (PocketFlow nodes)

**Minor enhancement opportunity:** Add specific helpers like `isRateLimitError()` for convenience (~20 lines of new code, not reduction)

---

## 5. Type Definitions - Mostly Optimal

### Types That Add Genuine Value (KEEP)
- `ProviderMessage` - Union of 4 SDK message types (convenience)
- `ServerToolContentBlock` - Union of server tool blocks across providers
- `WebSearchResultEntry` / `WebSearchResult` - Normalized search results
- `SdkToolCall` discriminated union - Provider-tagged tool calls

### One Simplification Opportunity (~15 lines)
**File:** `src/agent/modelHandlers/types/StopReasonTypes.ts`
```typescript
// Current: Manual array of all FinishReason values
export const GOOGLE_FINISH_REASONS = [
  FinishReason.FINISH_REASON_UNSPECIFIED,
  FinishReason.STOP,
  // ... 11 more values
] as const;
export type GoogleFinishReason = (typeof GOOGLE_FINISH_REASONS)[number];

// Simpler: Use SDK type directly (constant only used for type extraction)
export type GoogleFinishReason = FinishReason;
```

---

## Revised Recommendations

### Actually Feasible Improvements

| Change | Lines Reduced | Effort | Risk |
|--------|--------------|--------|------|
| Remove ResponseStream type guards | ~50 | Low | Low |
| Use `zodFunction()` for tool definitions | ~35 | Medium | Medium |
| Add `isToolMessage()`, `isPresent()` | ~10 | Low | Low |
| Simplify `GoogleFinishReason` | ~15 | Low | Low |
| **TOTAL** | **~110** | | |

### Not Recommended (Original Analysis Was Incorrect)

| Original Suggestion | Why Not Feasible |
|--------------------|------------------|
| Replace AnthropicStreamHandler with MessageStream | SDK doesn't handle multi-block coordination |
| Use ToolRunner/BetaToolRunner | TeXRA needs custom tool execution, state management |
| Replace token counting | Already using native APIs where available |
| Replace file upload orchestration | SDK only provides upload, not MIME validation/buffer lifecycle |

---

## Conclusion

**TeXRA's SDK usage is already well-optimized.** The codebase correctly uses:
- Native streaming APIs
- Native token counting
- Native file upload
- SDK error types
- SDK message types

The ~2,500+ lines of "custom" code in model handlers are **legitimate application logic** that SDKs don't provide:
- Multi-block streaming coordination
- Thinking block persistence across turns
- Cache control lifecycle management
- Token adjustment algorithms
- Provider-specific beta feature tracking

**Realistic code reduction: ~110 lines** (not the 400-500 originally estimated), primarily from:
- Removing redundant TypeScript type guards (~50 lines)
- Adopting `zodFunction()` pattern (~35 lines)
- Minor type simplifications (~25 lines)

---

*Deep analysis completed: 2025-12-12*
