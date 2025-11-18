# Native Solution: Align with Google GenAI SDK Design

## The Core Problem

We've been fighting against Google's SDK design. The Google GenAI SDK is **stateful** (Chat maintains history), while Anthropic/OpenAI SDKs are **stateless** (pass full history each time). We designed TeXRA around the stateless pattern.

## Current Broken Flow

```typescript
// 1. Model generates response with thoughts + function call
const response = await chat.sendMessage({...});
// response.parts = [
//   { thought: true, text: "...", thoughtSignature: "abc123" },
//   { functionCall: { name: "ls", args: {...} } }
// ]

// 2. We RECONSTRUCT the function call manually (WRONG!)
const callPart = createPartFromFunctionCall(name, args);  // LOST thoughtSignature!

// 3. We create a NEW chat session with reconstructed history (WRONG!)
const newChat = client.chats.create({ history: reconstructedMessages });
```

## Three Possible Solutions

### Option 1: Use Stateful Chat Sessions (Most Native)

**Store Chat instances per execution and reuse them:**

```typescript
export class ModelHandlerGoogleGenAI {
  private googleClient: GoogleGenAI | null = null;
  private activeChatSessions = new Map<string, Chat>();  // keyed by executionId

  async createResponse(options) {
    const executionId = options.executionId;  // Need to pass this

    let chat = this.activeChatSessions.get(executionId);
    if (!chat) {
      // First call - create chat with initial history
      chat = client.chats.create({
        model: this.config.fullName,
        history: convertMessagesToGoogleContentHistory(options.messages.slice(0, -1)),
        config: generationConfig,
        systemInstruction: {...},
      });
      this.activeChatSessions.set(executionId, chat);
    }

    // Just send the new message
    const lastMessage = options.messages.at(-1);
    return await chat.sendMessage({ message: lastMessage.parts });
  }

  // No need for createToolUseFollowUpMessages!
  // The Chat instance already has the function call in its history with thoughtSignature

  cleanupExecution(executionId: string) {
    this.activeChatSessions.delete(executionId);
  }
}
```

**Pros:**

- ✅ Truly native - uses SDK as designed
- ✅ ThoughtSignature preserved automatically
- ✅ No manual reconstruction needed
- ✅ Can use `chat.getHistory()` to get real history

**Cons:**

- ❌ Architecture change required
- ❌ Need to pass executionId through createResponse
- ❌ Need cleanup mechanism
- ❌ Different pattern from other providers

---

### Option 2: Stateless but Preserve Original Parts (Minimal Change)

**Don't reconstruct - reuse the original response parts:**

```typescript
// In extractToolUse - return the FULL part, not just the call
extractToolUse(responseObject): {
  toolCallPart: Part;  // The ORIGINAL part with thoughtSignature if present
  toolCall: string;     // JSON for compatibility
} | null {
  const parts = responseObject.candidates?.[0]?.content?.parts;

  // Find the part containing the function call
  const toolCallPart = parts?.find(p => p.functionCall);
  if (!toolCallPart?.functionCall) return null;

  return {
    toolCallPart,  // Keep the ORIGINAL part (has thoughtSignature if it exists)
    toolCall: JSON.stringify(toolCallPart.functionCall),
  };
}

// In createToolUseFollowUpMessages - use the original part
async createToolUseFollowUpMessages(
  originalToolCallPart: Part,  // Pass the ORIGINAL part
  result: Record<string, unknown>,
  text?: string,
): Promise<Content[]> {
  // Don't reconstruct - use the part exactly as the model created it
  const callParts: Part[] = [];
  if (text) {
    callParts.push(createPartFromText(text));
  }
  callParts.push(originalToolCallPart);  // Use ORIGINAL - has thoughtSignature!

  const callMsg: Content = {
    role: 'model',
    parts: callParts,
  };

  // Create result message as before
  const resultPart = createPartFromFunctionResponse(...);
  const resultMsg: Content = {
    role: 'user',
    parts: [resultPart, ...attachmentParts]
  };

  return [callMsg, resultMsg];
}
```

**Pros:**

- ✅ Preserves thoughtSignature (it's on the Part, not the FunctionCall!)
- ✅ Minimal architecture change
- ✅ Compatible with stateless pattern
- ✅ Works with current flow

**Cons:**

- ❌ Still creating new Chat sessions each time (wasteful)
- ❌ Still reconstructing history
- ❌ Not truly "native"

---

### Option 3: Hybrid - Store Response Parts in State

**Store the original response in workspace state:**

```typescript
// In processThinkingBlock or extractToolUse
processToolCallResponse(responseObject, workspaceState) {
  const parts = responseObject.candidates?.[0]?.content?.parts;

  // Store ALL parts for later reuse
  workspaceState.lastModelResponseParts = parts;
}

// In createToolUseFollowUpMessages
async createToolUseFollowUpMessages(
  workspaceState: AgentWorkspaceState,
  call: FunctionCall,
  result: Record<string, unknown>,
): Promise<Content[]> {
  // Retrieve the original parts from state
  const originalParts = workspaceState.lastModelResponseParts || [];

  // Use the original parts - they have thoughtSignature!
  const callMsg: Content = {
    role: 'model',
    parts: originalParts,  // Use ALL original parts (thoughts + function call)
  };

  const resultMsg: Content = { ... };
  return [callMsg, resultMsg];
}
```

**Pros:**

- ✅ Preserves thoughtSignature
- ✅ Minimal changes to interface
- ✅ Uses workspace state (already passing it around)

**Cons:**

- ❌ Implicit state management
- ❌ Need to clear after use
- ❌ Still wasteful Chat recreation

---

## Recommended Solution: Option 2 (Preserve Original Parts)

**Why:**

1. **Minimal disruption** - doesn't change architecture significantly
2. **Solves the immediate problem** - thoughtSignature preserved
3. **Compatible with all models** - other providers don't have this field
4. **Clear intent** - "use what the model gave us, don't reconstruct"

**Implementation:**

### Step 1: Update extractToolUse return type

```typescript
interface ToolUseExtraction {
  toolCallPart: Part;        // The original Part from the response
  functionCall: FunctionCall; // The actual function call object
  toolCallJson: string;       // JSON string for compatibility
}

extractToolUse(responseObject: GenerateContentResponse): ToolUseExtraction | null
```

### Step 2: Update createToolUseFollowUpMessages signature

```typescript
async createToolUseFollowUpMessages(
  _client: GoogleGenAI | undefined,
  originalPart: Part,         // Changed: accept the original Part
  result: Record<string, unknown>,
  _workspaceState?: AgentWorkspaceState,
  text?: string,
): Promise<Content[]>
```

### Step 3: Update ToolUseCycleFlow to pass the part

```typescript
const toolInfo = options.modelHandler.extractToolUse(state.response);
if (toolInfo) {
  const followUpMsgs = await options.modelHandler.createToolUseFollowUpMessages(
    options.client,
    toolInfo.toolCallPart, // Pass the original Part
    buildToolResultPayload(result),
    store.workspace,
    state.text ?? '',
  );
}
```

---

## Future Enhancement: Full Stateful Support

Once the immediate issue is fixed with Option 2, we could consider adding stateful Chat support as an optimization:

1. Add `ChatSessionManager` utility class
2. Store Chat instances keyed by executionId
3. Add cleanup on execution complete
4. Use `chat.getHistory()` instead of manual tracking

This would be a **performance optimization** but not required for correctness.

---

## Key Insight

**The thoughtSignature lives on the Part, not on the FunctionCall!**

```typescript
interface Part {
  functionCall?: FunctionCall;
  thoughtSignature?: string; // <-- HERE!
  thought?: boolean;
  text?: string;
}
```

When we reconstruct with `createPartFromFunctionCall()`, we create a **new Part** that only has `functionCall`, losing the `thoughtSignature` that was on the original Part.

**Solution: Don't reconstruct. Use the original Part.**

---

## Testing

1. Unit test: Verify original Part is preserved through the flow
2. Integration test: Tool call after thinking works without 400 error
3. Verify other providers (Anthropic, OpenAI) still work

---

**Recommendation: Implement Option 2 immediately, consider Option 1 as future enhancement.**
