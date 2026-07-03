# OpenAI SDK Type Improvements Proposal

> **Status:** Partially landed proposal (2026-07-04 status sweep). Individual
> helper replacements have landed opportunistically, but SDK-version-specific
> claims must be re-verified before implementation; several custom adapters remain
> intentional.

## Executive Summary

This proposal identifies opportunities to leverage native OpenAI SDK types, type guards, and utilities to reduce code duplication, improve type safety, and establish a single source of truth for OpenAI-related types in the TeXRA codebase.

**SDK Version Analyzed:** OpenAI SDK v6.9.1

---

## Table of Contents

1. [Native SDK Types Available](#1-native-sdk-types-available)
2. [Current Issues Identified](#2-current-issues-identified)
3. [Proposed Improvements](#3-proposed-improvements)
4. [Implementation Plan](#4-implementation-plan)
5. [Migration Strategy](#5-migration-strategy)

---

## 1. Native SDK Types Available

### 1.1 Type Guards (from `openai/lib/chatCompletionUtils`)

The SDK provides built-in type guards that are not being utilized:

```typescript
// Available in: openai/lib/chatCompletionUtils
import {
  isAssistantMessage,
  isToolMessage,
  isPresent,
} from 'openai/lib/chatCompletionUtils';

// Type guards:
isAssistantMessage(message); // → message is ChatCompletionAssistantMessageParam
isToolMessage(message); // → message is ChatCompletionToolMessageParam
isPresent<T>(obj); // → obj is T (null/undefined check)
```

### 1.2 Parser Utilities (from `openai/lib/parser`)

```typescript
// Available in: openai/lib/parser
import {
  isChatCompletionFunctionTool,
  shouldParseToolCall,
  hasAutoParseableInput,
  assertToolCallsAreChatCompletionFunctionToolCalls,
  validateInputTools,
} from 'openai/lib/parser';

// Type guard for tools:
isChatCompletionFunctionTool(tool); // → tool is ChatCompletionFunctionTool

// Assertion helper:
assertToolCallsAreChatCompletionFunctionToolCalls(toolCalls); // → asserts type
```

### 1.3 CompletionUsage Type Details

The SDK's `CompletionUsage` type already includes detailed token breakdowns:

```typescript
// From: openai/resources/completions.d.ts
interface CompletionUsage {
  completion_tokens: number;
  prompt_tokens: number;
  total_tokens: number;

  // Already includes these detailed breakdowns:
  completion_tokens_details?: {
    accepted_prediction_tokens?: number;
    audio_tokens?: number;
    reasoning_tokens?: number;
    rejected_prediction_tokens?: number;
  };

  prompt_tokens_details?: {
    audio_tokens?: number;
    cached_tokens?: number; // ← This is what ExtendedCompletionUsage adds
  };
}
```

### 1.4 ChatCompletionCreateParamsBase

The SDK now natively supports `parallel_tool_calls`:

```typescript
// From: openai/resources/chat/completions/completions.d.ts (line 1316)
interface ChatCompletionCreateParamsBase {
  // ...
  parallel_tool_calls?: boolean; // ← Native support!
  // ...
}
```

### 1.5 ChatCompletionMessageToolCall Types

```typescript
// Native union type for tool calls
type ChatCompletionMessageToolCall =
  ChatCompletionMessageFunctionToolCall | ChatCompletionMessageCustomToolCall;

// Each has a discriminant 'type' field:
interface ChatCompletionMessageFunctionToolCall {
  id: string;
  type: 'function'; // ← discriminant
  function: { name: string; arguments: string };
}

interface ChatCompletionMessageCustomToolCall {
  id: string;
  type: 'custom'; // ← discriminant
  custom: { name: string; input: string };
}
```

---

## 2. Current Issues Identified

### 2.1 Custom Type Duplicating SDK Type

**File:** `src/agent/core/ResponseUsage.ts` (lines 22-24)

```typescript
// Current implementation
export interface ExtendedCompletionUsage extends CompletionUsage {
  prompt_cache_hit_tokens?: number; // DeepSeek-specific
}
```

**Issue:** The SDK's `CompletionUsage` already has `prompt_tokens_details.cached_tokens`. The only truly custom field is `prompt_cache_hit_tokens` for DeepSeek.

**Recommendation:** Create a provider-specific extension only for DeepSeek:

```typescript
// Proposed: Use SDK type directly where possible
import type { CompletionUsage } from 'openai/resources/completions';

// Only extend for provider-specific fields
export interface DeepSeekCompletionUsage extends CompletionUsage {
  prompt_cache_hit_tokens?: number;
}

// Type alias for common usage
export type OpenAICompletionUsage = CompletionUsage;
```

### 2.2 Unsafe Type Assertions

**File:** `src/agent/modelHandlers/modelHandlerOpenAI.ts` (line 194)

```typescript
// Current: Uses 'as any' to bypass type checking
if (tools && tools.length > 0) {
  (baseParams as any).parallel_tool_calls = false; // ❌ Type unsafety
  baseParams.tools = toOpenAITools(tools);
}
```

**Issue:** The SDK now natively supports `parallel_tool_calls` in `ChatCompletionCreateParamsBase`.

**Fix:** Remove the `as any` cast:

```typescript
// Proposed: Use native SDK support
if (tools && tools.length > 0) {
  baseParams.parallel_tool_calls = false; // ✅ Type safe
  baseParams.tools = toOpenAITools(tools);
}
```

### 2.3 Manual Type Guards Duplicating SDK Functionality

**File:** `src/agent/modelHandlers/modelHandlerOpenAI.ts` (lines 1171-1187)

```typescript
// Current: Manual type guards
private isFunctionToolCall(
  call: ChatCompletionMessageToolCall | ChatCompletionMessage.FunctionCall,
): call is ChatCompletionMessageFunctionToolCall {
  return (
    typeof (call as ChatCompletionMessageToolCall)?.type === 'string' &&
    (call as ChatCompletionMessageToolCall).type === 'function'
  );
}
```

**Issue:**

1. Multiple redundant type assertions
2. Doesn't leverage discriminated union pattern
3. Duplicated in multiple handlers

**Proposed Refactoring:**

```typescript
// Create a shared utility module: src/agent/modelHandlers/utils/sdkTypeGuards.ts
import type {
  ChatCompletionMessageToolCall,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageCustomToolCall,
  ChatCompletionMessage,
} from 'openai/resources/chat/completions';

/**
 * Type guard for function tool calls using discriminated union.
 * Works with both ChatCompletionMessageToolCall and legacy FunctionCall.
 */
export function isFunctionToolCall(
  call:
    | ChatCompletionMessageToolCall
    | ChatCompletionMessage.FunctionCall
    | unknown,
): call is ChatCompletionMessageFunctionToolCall {
  if (typeof call !== 'object' || call === null) return false;

  const typed = call as Record<string, unknown>;

  // Modern function tool call
  if (typed.type === 'function' && typeof typed.function === 'object') {
    return true;
  }

  // Legacy FunctionCall (no 'type' field, has 'name' and 'arguments')
  if (!('type' in typed) && 'name' in typed && 'arguments' in typed) {
    return false; // Return false - this is legacy format, not FunctionToolCall
  }

  return false;
}

/**
 * Type guard for custom tool calls.
 */
export function isCustomToolCall(
  call: ChatCompletionMessageToolCall | unknown,
): call is ChatCompletionMessageCustomToolCall {
  if (typeof call !== 'object' || call === null) return false;
  const typed = call as Record<string, unknown>;
  return typed.type === 'custom' && typeof typed.custom === 'object';
}

/**
 * Check if a tool call has valid function data for extraction.
 */
export function hasValidFunctionCall(
  call: ChatCompletionMessageToolCall,
): call is ChatCompletionMessageFunctionToolCall & { id: string } {
  return (
    call.type === 'function' &&
    typeof call.id === 'string' &&
    typeof call.function?.name === 'string'
  );
}
```

### 2.4 Manual `isRecord` Helper

**File:** `src/agent/modelHandlers/modelHandlerOpenAI.ts` (lines 80-81)

```typescript
// Current: Manual helper
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
```

**Issue:** This is a common pattern that could be centralized.

**Recommendation:** Move to shared utilities and make more robust:

```typescript
// src/utils/typeGuards.ts
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function hasProperty<K extends string>(
  obj: unknown,
  key: K,
): obj is Record<K, unknown> {
  return isRecord(obj) && key in obj;
}
```

### 2.5 Reasoning Content Extraction

**File:** `src/agent/modelHandlers/modelHandlerOpenAI.ts` (lines 105-119)

```typescript
// Current: Manual extraction with multiple casts
const extractReasoningDelta = (chunk: ChatCompletionChunk): string => {
  const choice = chunk.choices[0];
  if (!choice) return '';

  const delta = choice.delta as unknown; // ← Loses type info
  if (!isRecord(delta) || !('reasoning_content' in delta)) {
    return '';
  }

  return collectTextFromUnknown(
    (delta as { reasoning_content?: unknown }).reasoning_content,
  );
};
```

**Issue:** The SDK's `ChatCompletionChunk.Choice.Delta` doesn't include `reasoning_content` (provider-specific), but the approach loses type safety.

**Proposed Improvement:**

```typescript
// Define extended delta type for reasoning models
interface ReasoningDelta extends ChatCompletionChunk.Choice.Delta {
  reasoning_content?: string | Array<{ type: string; text?: string }>;
}

function hasReasoningContent(
  delta: ChatCompletionChunk.Choice.Delta,
): delta is ReasoningDelta {
  return 'reasoning_content' in delta;
}

const extractReasoningDelta = (chunk: ChatCompletionChunk): string => {
  const choice = chunk.choices[0];
  if (!choice) return '';

  const delta = choice.delta;
  if (!hasReasoningContent(delta)) return '';

  return collectTextFromUnknown(delta.reasoning_content);
};
```

### 2.6 Tool Call Union Types Without Discrimination

**File:** `src/agent/modelHandlers/types/IModelHandler.ts` (lines 112-117)

```typescript
// Current: Union without type guards
export type SdkToolCall =
  | OpenAIToolCall
  | DeepSeekToolCall
  | OpenAIResponseToolCall
  | GoogleToolCall
  | AnthropicToolCall;
```

**Issue:** No type guards provided to discriminate between union members.

**Proposed Addition:**

```typescript
// Add type guards for provider discrimination
export function isOpenAIToolCall(call: SdkToolCall): call is OpenAIToolCall {
  return call.provider === 'openai';
}

export function isDeepSeekToolCall(
  call: SdkToolCall,
): call is DeepSeekToolCall {
  return call.provider === 'deepseek';
}

export function isOpenAIResponseToolCall(
  call: SdkToolCall,
): call is OpenAIResponseToolCall {
  return call.provider === 'openai-response';
}

export function isGoogleToolCall(call: SdkToolCall): call is GoogleToolCall {
  return call.provider === 'google';
}

export function isAnthropicToolCall(
  call: SdkToolCall,
): call is AnthropicToolCall {
  return call.provider === 'anthropic';
}
```

### 2.7 `any` Types in Interface Definitions

**File:** `src/agent/modelHandlers/types/IModelHandler.ts`

```typescript
// Current: Uses 'any' in multiple places
export interface ExtractResponseResult {
  response: string;
  usage: any; // ← Should be typed
  stopReason: ProviderStopReason;
}

export interface IModelHandler<
  M extends ProviderMessage = ProviderMessage,
  U = any, // ← Should be constrained
  R = any, // ← Should be constrained
  // ...
> {
  // ...
}
```

**Proposed Improvement:**

```typescript
import type { CompletionUsage } from 'openai/resources/completions';
import type { Usage as AnthropicUsage } from '@anthropic-ai/sdk/resources/messages';
import type { GenerateContentResponseUsageMetadata } from '@google/genai';

// Create a union of all provider usage types
export type ProviderUsage =
  | CompletionUsage
  | AnthropicUsage
  | GenerateContentResponseUsageMetadata
  | null;

export interface ExtractResponseResult {
  response: string;
  usage: ProviderUsage;
  stopReason: ProviderStopReason;
}
```

---

## 3. Proposed Improvements

### 3.1 Create Shared Type Guard Module

Create a new file: `src/agent/modelHandlers/utils/sdkTypeGuards.ts`

```typescript
/**
 * Centralized SDK type guards for OpenAI-compatible APIs.
 * Single source of truth for type discrimination.
 */

// Re-export SDK type guards
export {
  isAssistantMessage,
  isToolMessage,
  isPresent,
} from 'openai/lib/chatCompletionUtils';
export { isChatCompletionFunctionTool } from 'openai/lib/parser';

// Custom type guards for extended functionality
export * from './toolCallTypeGuards';
export * from './messageTypeGuards';
export * from './providerTypeGuards';
```

### 3.2 Leverage SDK's Streaming Utilities

The SDK provides `ChatCompletionStream` with built-in methods:

```typescript
// Current approach: Manual event handling
stream.on('content.delta', onContentDelta);
stream.on('chunk', onChunk);
// ... manual cleanup

// Alternative: Use async iteration (cleaner)
for await (const chunk of stream) {
  // Process chunk
}
const completion = await stream.finalChatCompletion();
```

**Recommendation:** Consider using async iteration for simpler streaming code in handlers that don't need fine-grained event control.

### 3.3 Use SDK's Assertion Helpers

```typescript
// Instead of manual filtering with assertions
const validToolCalls = toolCalls.filter((call): call is ... => ...);

// Use SDK's assertion helper
import { assertToolCallsAreChatCompletionFunctionToolCalls } from 'openai/lib/parser';

try {
  assertToolCallsAreChatCompletionFunctionToolCalls(toolCalls);
  // toolCalls is now typed as ChatCompletionMessageFunctionToolCall[]
} catch {
  // Handle invalid tool calls
}
```

---

## 4. Implementation Plan

### Phase 1: Quick Wins (Low Risk)

1. **Remove `as any` for `parallel_tool_calls`**
   - File: `modelHandlerOpenAI.ts` line 194
   - Change: Remove cast, SDK now supports it natively
   - Risk: None

2. **Import and use SDK type guards**
   - Add imports for `isAssistantMessage`, `isToolMessage`, `isPresent`
   - Replace manual implementations where applicable
   - Risk: Low

3. **Add type guards for `SdkToolCall` union**
   - File: `types/IModelHandler.ts`
   - Add provider discrimination functions
   - Risk: None (additive)

### Phase 2: Type Consolidation (Medium Risk)

4. **Refactor `ExtendedCompletionUsage`**
   - Use SDK's `CompletionUsage` directly
   - Create `DeepSeekCompletionUsage` only for DeepSeek-specific fields
   - Note: `ResponseUsageFactory` has been removed (was only used by deprecated `computeResponseUsage`)
   - Risk: Medium (requires testing all handlers)

5. **Create shared type guard utilities**
   - New file: `src/agent/modelHandlers/utils/sdkTypeGuards.ts`
   - Consolidate all tool call type guards
   - Update handlers to import from new location
   - Risk: Medium (refactoring)

6. **Replace `any` with proper types in interfaces**
   - File: `types/IModelHandler.ts`
   - Create `ProviderUsage` union type
   - Update all implementations
   - Risk: Medium (may surface hidden type errors)

### Phase 3: Advanced Improvements (Higher Risk)

7. **Improve reasoning content extraction**
   - Define `ReasoningDelta` interface
   - Add proper type guard
   - Risk: Low-Medium

8. **Consider using SDK's streaming helpers**
   - Evaluate `ChatCompletionStream.finalChatCompletion()`
   - May simplify `StreamingAggregator` implementations
   - Risk: Higher (behavioral changes possible)

---

## 5. Migration Strategy

### Testing Requirements

For each change:

1. Run existing unit tests
2. Test with all supported providers (OpenAI, DeepSeek, OpenRouter, etc.)
3. Test both streaming and non-streaming modes
4. Test tool use functionality

### Backward Compatibility

- Keep `ExtendedCompletionUsage` as a type alias initially
- Add deprecation comments for custom type guards being replaced
- Export SDK type guards from existing module locations

### Rollback Plan

- Each phase can be rolled back independently
- Keep old implementations as fallbacks during transition
- Use feature flags if needed for gradual rollout

---

## 6. Further Simplification Opportunities

### Reduce Abstraction Layers

The current architecture has several normalization/wrapper layers that could be simplified:

#### `SdkToolCall` Wrapper Type

**Current:** Each tool call is wrapped with a provider discriminant and extracted fields:

```typescript
export type OpenAIToolCall = {
  provider: 'openai';
  callId: string; // extracted from raw.id
  name: string; // extracted from raw.function.name
  input: unknown; // parsed from raw.function.arguments
  raw: ChatCompletionMessageToolCall; // original SDK type
};
```

**Issue:** This duplicates data already in `raw` and adds an abstraction layer.

**Potential Simplification:** Use the SDK type directly with a provider tag:

```typescript
export type OpenAIToolCall = ChatCompletionMessageToolCall & {
  provider: 'openai';
};
```

#### `normalizeToolCall` Method

**Current:** Reconstructs SDK types with fallbacks:

```typescript
protected normalizeToolCall(id, fallbackName, call) {
  return {
    id: call.id ?? id,  // fallback rarely needed
    type: 'function',
    function: { name: call.function?.name ?? fallbackName, ... }
  };
}
```

**Issue:** The SDK already returns valid data; fallbacks may be unnecessary defensive coding.

**Potential Simplification:** Use `call.raw` directly if it's already a valid `ChatCompletionMessageToolCall`:

```typescript
async createToolUseFollowUpMessages(client, call, result) {
  // Use raw SDK type directly instead of normalizing
  const callMsg: ChatCompletionAssistantMessageParam = {
    role: 'assistant',
    tool_calls: [call.raw],  // Direct use
  };
  // ...
}
```

#### Inline Type Guards vs Utility Functions

**Current:** Separate type guard functions:

```typescript
if (isFunctionToolCall(call)) { ... }
```

**Alternative:** TypeScript discriminated unions work directly:

```typescript
if ('type' in call && call.type === 'function') { ... }
```

The SDK's `ChatCompletionMessageToolCall` is already a discriminated union on `type`. TypeScript narrows automatically.

### Recommendation

Consider these simplifications in Phase 3 after stabilizing the Phase 1-2 type improvements:

1. **Audit `normalizeToolCall` usage** - determine if fallbacks are ever triggered
2. **Flatten `SdkToolCall`** - extend SDK types instead of wrapping
3. **Remove unnecessary type guards** - use inline discriminant checks where TypeScript inference works

---

## Summary of Benefits

| Improvement                | Benefit                                    |
| -------------------------- | ------------------------------------------ |
| Use SDK type guards        | Reduced code duplication, SDK-maintained   |
| Remove `as any` casts      | Type safety, IDE support                   |
| Centralized type guards    | Single source of truth, easier maintenance |
| Provider usage union       | Type-safe usage handling                   |
| Discriminated union guards | Runtime safety, better error messages      |

---

## Files to Modify

| File                                             | Changes                            |
| ------------------------------------------------ | ---------------------------------- |
| `src/agent/core/ResponseUsage.ts`                | Refactor `ExtendedCompletionUsage` |
| `src/agent/modelHandlers/modelHandlerOpenAI.ts`  | Remove `as any`, use SDK guards    |
| `src/agent/modelHandlers/types/IModelHandler.ts` | Add type guards, fix `any` types   |
| `src/agent/modelHandlers/utils/sdkTypeGuards.ts` | New file - centralized guards      |
| `src/utils/typeGuards.ts`                        | New file - generic type guards     |

---

## Appendix: SDK Type Reference

### Key Import Paths

```typescript
// Chat Completions
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionCreateParamsBase,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions';

// Usage Types
import type { CompletionUsage } from 'openai/resources/completions';

// Type Guards
import {
  isAssistantMessage,
  isToolMessage,
  isPresent,
} from 'openai/lib/chatCompletionUtils';
import {
  isChatCompletionFunctionTool,
  shouldParseToolCall,
} from 'openai/lib/parser';

// Streaming
import type {
  ChatCompletionStream,
  ContentDeltaEvent,
} from 'openai/lib/ChatCompletionStream';
```
