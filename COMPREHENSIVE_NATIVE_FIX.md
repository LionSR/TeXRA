# Comprehensive Native SDK Fix: Stop Reconstructing, Start Preserving

## The Systematic Problem

**ALL model handlers are reconstructing SDK-native objects instead of preserving them.**

This loses SDK-managed metadata and fights against the design of every SDK.

## Evidence Across All Handlers

### 1. Google GenAI Handler ❌

```typescript
// Line 1148 - Reconstruct (WRONG)
const callPart = createPartFromFunctionCall(functionName, args);
// LOSES: thoughtSignature from the original Part!
```

**Original Part has**:

```typescript
{
  functionCall: {...},
  thoughtSignature: "abc123"  // ← LOST!
}
```

### 2. Anthropic Handler ❌

```typescript
// Line 1608-1614 - Reconstruct (WRONG)
content.push({
  type: 'tool_use',
  id,
  name,
  input: toolInput, // Manually reconstructed
});
```

**We receive** `call: ToolUseBlock` on line 1586 but don't use it!

### 3. OpenAI Handler ❌

```typescript
// Line 1189 - Normalize/Reconstruct (WRONG)
const toolCall = this.normalizeToolCall(id, name, call);
```

**We receive** the original `ChatCompletionMessageToolCall` but reconstruct it!

## The Universal Solution

### Option 2 Pattern (for all handlers):

**Stop extracting pieces and reconstructing. Use the original objects.**

```typescript
// ❌ WRONG - Extract and reconstruct
extractToolUse(response) {
  const call = response.tool_call;
  return {
    id: call.id,
    name: call.name,
    input: call.input
  };
}

// ✅ RIGHT - Return the whole original object
extractToolUse(response) {
  const originalBlock = response.tool_call;  // Keep ENTIRE object
  return {
    originalBlock,  // For use in follow-up messages
    toolCall: JSON.stringify(originalBlock)  // For compatibility/logging
  };
}

// ❌ WRONG - Reconstruct in follow-up
createToolUseFollowUpMessages(id, name, call, result) {
  const reconstructed = { type: 'tool_use', id, name, input: call.input };
  content.push(reconstructed);  // Lost metadata!
}

// ✅ RIGHT - Use original
createToolUseFollowUpMessages(originalBlock, result) {
  content.push(originalBlock);  // Preserve ALL SDK metadata!
}
```

## Implementation Plan

### Phase 1: Update Return Types

#### A. Update `extractToolUse()` interface

**File**: `src/agent/modelHandlers/types/IModelHandler.ts`

```typescript
interface ToolUseExtraction<TNativeType = unknown> {
  originalBlock: TNativeType;  // The complete native SDK object
  toolCallJson: string;        // JSON string for logging/compatibility
}

// Method signature
extractToolUse(responseObject: TResponseType): ToolUseExtraction<TNativeToolType> | null;
```

#### B. Update Each Handler

##### Google GenAI

```typescript
interface GoogleToolUseExtraction {
  originalPart: Part;           // The COMPLETE Part with thoughtSignature
  toolCallJson: string;
}

extractToolUse(responseObject: GenerateContentResponse): GoogleToolUseExtraction | null {
  const parts = responseObject.candidates?.[0]?.content?.parts;
  const originalPart = parts?.find(p => p.functionCall);

  if (!originalPart?.functionCall) return null;

  return {
    originalPart,  // Keep the ENTIRE Part
    toolCallJson: JSON.stringify(originalPart.functionCall, null, 2),
  };
}
```

##### Anthropic

```typescript
interface AnthropicToolUseExtraction {
  originalBlock: ToolUseBlock;  // The COMPLETE ToolUseBlock
  toolCallJson: string;
}

extractToolUse(responseObject: BetaMessage): AnthropicToolUseExtraction | null {
  const content = responseObject?.content;
  const originalBlock = content?.find((c: any) => c.type === 'tool_use') as ToolUseBlock;

  if (!originalBlock) return null;

  return {
    originalBlock,  // Keep the ENTIRE block
    toolCallJson: JSON.stringify(originalBlock, null, 2),
  };
}
```

##### OpenAI

```typescript
interface OpenAIToolUseExtraction {
  originalToolCall: ChatCompletionMessageToolCall;  // The COMPLETE tool call
  toolCallJson: string;
}

extractToolUse(responseObject: any): OpenAIToolUseExtraction | null {
  const toolCalls = responseObject?.choices?.[0]?.message?.tool_calls;
  const originalToolCall = toolCalls?.[0];

  if (!originalToolCall) return null;

  return {
    originalToolCall,  // Keep the ENTIRE object
    toolCallJson: JSON.stringify(originalToolCall, null, 2),
  };
}
```

### Phase 2: Update `createToolUseFollowUpMessages()`

#### A. Change Method Signatures

**Before**:

```typescript
createToolUseFollowUpMessages(
  client: C,
  id: string,       // ← Extracted pieces
  name: string,     // ← Extracted pieces
  call: T,          // ← Partial object
  result: Record<string, unknown>,
  workspaceState?: AgentWorkspaceState,
  text?: string,
): Promise<M[]>
```

**After**:

```typescript
createToolUseFollowUpMessages(
  client: C,
  originalBlock: TNativeToolType,  // ← The COMPLETE native object
  result: Record<string, unknown>,
  workspaceState?: AgentWorkspaceState,
  text?: string,
): Promise<M[]>
```

#### B. Use Original Objects

##### Google GenAI

```typescript
async createToolUseFollowUpMessages(
  _client: GoogleGenAI | undefined,
  originalPart: Part,  // ← The COMPLETE Part with thoughtSignature!
  result: Record<string, unknown>,
  _workspaceState?: AgentWorkspaceState,
  text?: string,
): Promise<Content[]> {
  const callParts: Part[] = [];
  if (text) {
    callParts.push(createPartFromText(text));
  }
  callParts.push(originalPart);  // ✅ Use ORIGINAL Part - has thoughtSignature!

  const callMsg: Content = {
    role: 'model',
    parts: callParts,
  };

  // ... rest of logic for result message
  return [callMsg, resultMsg];
}
```

##### Anthropic

```typescript
async createToolUseFollowUpMessages(
  client: Anthropic | undefined,
  originalBlock: ToolUseBlock,  // ← The COMPLETE ToolUseBlock
  result: Record<string, unknown>,
  workspaceState?: AgentWorkspaceState,
  text?: string,
): Promise<MessageParam[]> {
  const content: ContentBlockParam[] = [];

  // Add thinking blocks if present
  if (workspaceState?.reasoning.thinkingBlocks) {
    content.push(...workspaceState.reasoning.thinkingBlocks);
  }

  if (text) {
    content.push({ type: 'text', text });
  }

  content.push(originalBlock);  // ✅ Use ORIGINAL block - preserves ALL fields!

  const callMsg: MessageParam = {
    role: 'assistant',
    content,
  };

  // ... rest of logic
  return [callMsg, resultMsg];
}
```

##### OpenAI

```typescript
async createToolUseFollowUpMessages(
  _client: OpenAI | undefined,
  originalToolCall: ChatCompletionMessageToolCall,  // ← COMPLETE tool call
  result: Record<string, unknown>,
  _workspaceState?: AgentWorkspaceState,
  text?: string,
): Promise<ChatCompletionMessageParam[]> {
  const callMsg: ChatCompletionAssistantMessageParam = {
    role: 'assistant',
    tool_calls: [originalToolCall],  // ✅ Use ORIGINAL - no normalization!
  };

  if (text) {
    callMsg.content = [{ type: 'text', text }];
  }

  const resultMsg: ChatCompletionToolMessageParam = {
    role: 'tool',
    tool_call_id: originalToolCall.id,
    content: JSON.stringify(sanitizedResult),
  };

  return [callMsg, resultMsg];
}
```

### Phase 3: Update Call Sites

**File**: `src/agent/core/flows/ToolUseCycleFlow.ts`

```typescript
// Extract tool use info
const toolInfo = options.modelHandler.extractToolUse(state.response);

if (toolInfo) {
  // ... tool execution logic ...

  // Create follow-up messages using the ORIGINAL block
  const followUpMsgs = await options.modelHandler.createToolUseFollowUpMessages(
    options.client,
    toolInfo.originalBlock, // ← Pass the complete native object
    buildToolResultPayload(result),
    store.workspace,
    state.text ?? '',
  );

  state.messages.push(...followUpMsgs);
}
```

## Benefits of This Approach

### 1. Preserves SDK Metadata

- ✅ Google: `thoughtSignature` on `Part`
- ✅ Anthropic: Any future fields on `ToolUseBlock`
- ✅ OpenAI: Complete `ChatCompletionMessageToolCall` structure
- ✅ Future-proof for new SDK fields

### 2. Aligns with SDK Design

- Uses objects as the SDK designed them
- No manual reconstruction
- No field-by-field copying
- Respects SDK contracts

### 3. Simplifies Code

- Fewer parameters to thread through
- Less extraction logic
- Clearer intent: "use what the model gave us"
- Easier to maintain

### 4. Prevents Future Issues

- New SDK fields automatically preserved
- No risk of missing important metadata
- Works with SDK updates without code changes

## Migration Strategy

### Step 1: Update Interfaces (Breaking Change Prep)

- Create new interface types
- Mark old signatures as deprecated
- Add backward compatibility

### Step 2: Implement Google (High Priority)

- Fixes immediate `thoughtSignature` issue
- Tests the pattern on the most affected handler

### Step 3: Implement Anthropic

- Validates pattern works for different SDK

### Step 4: Implement OpenAI

- Completes the pattern across major providers

### Step 5: Update Remaining Handlers

- DeepSeek (uses OpenAI pattern)
- XAI (uses OpenAI pattern)
- Other OpenAI-compatible handlers

### Step 6: Remove Deprecated Code

- Clean up old signatures
- Remove reconstruction logic
- Update tests

## Testing Checklist

- [ ] Google: Tool call with thinking works without 400 error
- [ ] Google: `thoughtSignature` present in follow-up messages
- [ ] Anthropic: Tool calls work with all block types
- [ ] OpenAI: Tool calls work with function_call and tool_calls
- [ ] DeepSeek: Tool calls work (OpenAI-compatible)
- [ ] No regression in handlers without tool support
- [ ] Streaming still works
- [ ] Multi-turn tool conversations work

## Files to Modify

1. `src/agent/modelHandlers/types/IModelHandler.ts` - Interface updates
2. `src/agent/modelHandlers/modelHandlerGoogleGenAI.ts` - Implementation
3. `src/agent/modelHandlers/modelHandlerAnthropic.ts` - Implementation
4. `src/agent/modelHandlers/modelHandlerOpenAI.ts` - Implementation
5. `src/agent/modelHandlers/modelHandlerDeepSeek.ts` - Implementation (if different)
6. `src/agent/core/flows/ToolUseCycleFlow.ts` - Call site updates
7. Tests - Add/update tests for all handlers

---

**Priority**: HIGH - Blocking tool use with Google models
**Effort**: 4-6 hours for complete implementation
**Risk**: LOW - Additive change, improves correctness
