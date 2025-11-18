# Thought Signature Fix Proposal for Google GenAI Integration

## Problem Statement

Google's Gemini API is returning a 400 Bad Request error when function calls are made after the model generates thoughts:

```
HTTP 400 Bad Request – {"error":{"message":"{\n  \"error\": {\n    \"code\": 400,\n    \"message\": \"Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, and missing thought_signature may lead to degraded model performance. Additional data, function call `default_api:ls` , position 2. please refer to https://ai.google.dev/gemini-api/docs/thought-signatures for more details.\",\n    \"status\": \"INVALID_ARGUMENT\"\n  }\n}\n","code":400,"status":"Bad Request"}}
```

## Root Cause Analysis

### Current Flow

1. **Model Response Generation** (`modelHandlerGoogleGenAI.ts:469-603`):
   - Google's model generates a response containing:
     - Thought parts: `{thought: true, text: "...", thoughtSignature: "base64..."}`
     - Function call parts: `{functionCall: {name: "ls", args: {...}}}`

2. **Thought Processing** (`modelHandlerGoogleGenAI.ts:1026-1074`):
   - `processThinkingBlock()` extracts thought parts and stores `thoughtSignature` in workspace state
   - This happens in `ToolUseCycleFlow.ts:406-416`

3. **Tool Call Extraction** (`modelHandlerGoogleGenAI.ts:1076-1096`):
   - `extractToolUse()` finds the function call part
   - Returns the function call as JSON string
   - **Does NOT extract or return the thought signature**

4. **Follow-up Message Creation** (`modelHandlerGoogleGenAI.ts:1129-1196`):
   - `createToolUseFollowUpMessages()` recreates the function call message
   - Uses `createPartFromFunctionCall()` SDK helper
   - **Does NOT include thoughtSignature in the function call part**

### The Problem

According to Google's API requirements and the `@google/genai` SDK documentation:

```typescript
// From @google/genai SDK type definitions
export declare interface Part {
    // ... other fields
    functionCall?: FunctionCall;
    thought?: boolean;
    thoughtSignature?: string;  // <-- This field exists on Part, not FunctionCall
}
```

When the model generates thoughts before making a function call, the **thought signature must be included in the function call Part** when we send it back to continue the conversation. This allows the model to reuse its thinking from previous turns.

## Proposed Solution

### Solution Approach

Modify the flow to preserve and include thoughtSignature from thought parts when creating function call follow-up messages.

### Implementation Steps

#### Step 1: Modify `extractToolUse()` to return thoughtSignature

**File**: `src/agent/modelHandlers/modelHandlerGoogleGenAI.ts`

```typescript
// Change return type from `string | null` to an object
interface ToolUseInfo {
  toolCall: string;  // JSON string of the function call
  thoughtSignature?: string;  // Signature from preceding thought parts
}

extractToolUse(responseObject: GenerateContentResponse): ToolUseInfo | null {
  const candidate = responseObject?.candidates?.[0];
  const parts = candidate?.content?.parts;
  
  if (!Array.isArray(parts)) {
    return null;
  }

  // Extract thought signature from thought parts
  let thoughtSignature: string | undefined;
  for (const part of parts) {
    if (part.thought && part.thoughtSignature) {
      thoughtSignature = part.thoughtSignature;
      // Use the last thought signature if multiple exist
    }
  }

  // Find function call part
  const funcPart = parts.find((part) => part.functionCall);
  if (funcPart?.functionCall) {
    const call = funcPart.functionCall;
    const callId = ensureCallId(call);
    const callWithId = { ...call, id: callId };

    if (!call.id?.trim()) {
      this.logger.debug(
        `Generated ID for Google function call '${call.name ?? 'unknown'}': ${callId}`,
      );
    }

    return {
      toolCall: JSON.stringify(callWithId, null, 2),
      thoughtSignature,
    };
  }
  
  return null;
}
```

#### Step 2: Update signature of `createToolUseFollowUpMessages()`

Add a parameter to accept thoughtSignature:

```typescript
async createToolUseFollowUpMessages(
  _client: GoogleGenAI | undefined,
  _id: string,
  name: string,
  call: FunctionCall,
  result: Record<string, unknown>,
  _workspaceState?: AgentWorkspaceState,
  text?: string,
  thoughtSignature?: string,  // <-- New parameter
): Promise<Content[]>
```

#### Step 3: Include thoughtSignature in function call part

In `createToolUseFollowUpMessages()`, modify the part creation:

```typescript
// Create the call part with the function name and arguments
const callPart = createPartFromFunctionCall(functionName, args);

// Ensure the function call has an ID for correlation with result
const callId = ensureCallId(call);
if (callPart.functionCall) {
  callPart.functionCall.id = callId;
}

// Include thought signature if available
if (thoughtSignature) {
  callPart.thoughtSignature = thoughtSignature;
  this.logger.debug(
    `Including thoughtSignature in function call part for ${functionName}`,
  );
}
```

#### Step 4: Update interface definition

**File**: `src/agent/modelHandlers/types/IModelHandler.ts`

Update the interface method signature:

```typescript
extractToolUse(responseObject: TResponseType): ToolUseInfo | string | null;

// Where ToolUseInfo is:
interface ToolUseInfo {
  toolCall: string;
  thoughtSignature?: string;
}
```

Or, more simply, keep backward compatibility:

```typescript
// Return type can be string for backward compatibility, or object with metadata
extractToolUse(responseObject: TResponseType): string | { 
  toolCall: string; 
  thoughtSignature?: string; 
} | null;
```

#### Step 5: Update call sites in ToolUseCycleFlow

**File**: `src/agent/core/flows/ToolUseCycleFlow.ts`

Update the code that calls `extractToolUse()`:

```typescript
const toolInfo = options.modelHandler.extractToolUse(state.response);

// Handle both string (legacy) and object (new) return types
let toolCall: string | null = null;
let thoughtSignature: string | undefined;

if (typeof toolInfo === 'string') {
  toolCall = toolInfo;
} else if (toolInfo && typeof toolInfo === 'object' && 'toolCall' in toolInfo) {
  toolCall = toolInfo.toolCall;
  thoughtSignature = toolInfo.thoughtSignature;
}

// ... later when calling createToolUseFollowUpMessages ...

const followUpMsgs = await options.modelHandler.createToolUseFollowUpMessages(
  options.client,
  normalResult.toolCallId,
  normalResult.name,
  normalResult.raw,
  buildToolResultPayload(result),
  store.workspace,
  state.text ?? '',
  thoughtSignature,  // <-- Pass the thoughtSignature
);
```

#### Step 6: Update other model handlers for consistency

For Anthropic, OpenAI, DeepSeek, etc., update their `extractToolUse()` to return the same type (but they can return `thoughtSignature: undefined` since they don't support it).

### Alternative Solution: Store in Workspace State

Instead of threading through the signature via return values, we could:

1. Store thoughtSignature in workspace state when processing thinking blocks
2. Retrieve it from workspace state when creating function call messages

**Pros:**
- Less parameter threading
- Already have access to workspaceState in `createToolUseFollowUpMessages()`

**Cons:**
- More implicit state management
- Need to clear the signature after use to avoid stale data

## Testing Strategy

### Unit Tests

1. Test `extractToolUse()` with responses containing:
   - Only function calls (no thoughts)
   - Thoughts followed by function calls
   - Multiple thought parts with different signatures

2. Test `createToolUseFollowUpMessages()` with:
   - `thoughtSignature` provided
   - `thoughtSignature` undefined

### Integration Tests

1. Run a tool-use agent flow with Google Gemini models that support thinking
2. Verify that function calls succeed without 400 errors
3. Check that thoughtSignature is correctly included in outgoing messages

### Manual Testing

1. Enable debug logging to verify thoughtSignature values
2. Test with real Google Gemini API calls using tools
3. Verify no regression with other model providers (Anthropic, OpenAI, etc.)

## Backwards Compatibility

- Other model handlers (Anthropic, OpenAI, etc.) don't use thoughtSignature, so they return `undefined`
- The change is additive - existing code continues to work
- Type changes are compatible with string | object union return type

## Documentation Updates

1. Add comment explaining thoughtSignature requirement for Google models
2. Document the field in JSDoc for the interface methods
3. Update CHANGELOG with the bug fix

## References

- Google GenAI SDK types: `/workspace/node_modules/@google/genai/dist/genai.d.ts`
- Google documentation: https://ai.google.dev/gemini-api/docs/thought-signatures
- Error message indicates this is now required for proper tool operation with thinking models

## Risk Assessment

**Low Risk** because:
- The change is additive (new optional parameter)
- Only affects Google GenAI handler
- Other providers return undefined for the new field
- Backwards compatible with existing code

## Next Steps

1. Implement the changes in `modelHandlerGoogleGenAI.ts`
2. Update the interface in `IModelHandler.ts`
3. Update call sites in `ToolUseCycleFlow.ts`
4. Add unit tests
5. Test with real Google Gemini API
6. Create PR with the fix

---

**Status**: Proposal Complete - Ready for Implementation
**Estimated Effort**: 2-3 hours
**Priority**: High (blocking tool use with Google models)
