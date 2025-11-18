# Google GenAI SDK Usage Analysis

## Current Usage Pattern ❌

```typescript
// src/agent/modelHandlers/modelHandlerGoogleGenAI.ts:473
async createResponse(options: CreateResponseOptions<Content>): Promise<GenerateContentResponse> {
  // Extract history and last message
  const historyMessages = messages.slice(0, -1);
  const lastMessage = messages.at(-1);
  
  // Convert to Google format
  const chatHistory = convertMessagesToGoogleContentHistory(historyMessages, this.logger);
  const lastMessageParts = lastMessage.parts;
  
  // CREATE NEW Chat instance EVERY TIME
  const chatParams: CreateChatParameters = {
    model: this.config.fullName,
    history: chatHistory,  // Pass history explicitly
    config: generationConfig,
    systemInstruction: {...}
  };
  
  const chat = client.chats.create(chatParams);  // ❌ NEW instance each call
  
  // Send message
  const result = await chat.sendMessage({ message: lastMessageParts, ... });
  
  return result;
}
```

### Problems with This Approach

1. **Chat instance is NOT reused** - We create a new one for each turn
2. **History is manually managed** - We explicitly pass the history each time
3. **SDK's automatic history management is BYPASSED**
4. **SDK's automatic thought signature handling might not work**

## Recommended Usage Pattern ✅

According to Google's documentation and SDK design:

```typescript
// CORRECT: Create Chat ONCE, reuse for entire conversation
const chat = ai.chats.create({
  model: 'gemini-3-pro-preview',
  config: { temperature: 0.7, tools: [...] },
  history: []  // Optional: only for initialization
});

// Turn 1: User asks question
const response1 = await chat.sendMessage({ message: 'Check weather in Paris and London' });

// SDK automatically:
// - Adds user message to internal history
// - Adds model response to internal history
// - Preserves thoughtSignature on all Parts
// - Handles parallel function calls

// Turn 2: Send function results
const response2 = await chat.sendMessage({ 
  message: [functionResponse1, functionResponse2] 
});

// SDK automatically:
// - Includes the FULL previous model response (with all FCs and signatures)
// - Sends function responses
// - Continues the conversation correctly
```

## Key SDK Features We're NOT Using

### 1. Automatic History Management

From SDK docs:
> "The session maintains all the turns between user and model."

```typescript
export declare class Chat {
  private history;  // SDK maintains this internally
  
  sendMessage(params): Promise<GenerateContentResponse>;
  getHistory(curated?: boolean): Content[];  // Can retrieve history
}
```

**What this means:**
- Chat instance keeps track of ALL messages
- Including model responses with function calls
- Including thought signatures
- We DON'T need to manually reconstruct history

### 2. Automatic Function Calling

From SDK types (line 398-418):

```typescript
export interface AutomaticFunctionCallingConfig {
  disable?: boolean;
  maximumRemoteCalls?: number;  // Default: 10
  ignoreCallHistory?: boolean;  // Default: false
}

export interface GenerateContentConfig {
  automaticFunctionCalling?: AutomaticFunctionCallingConfig;
}

export class GenerateContentResponse {
  automatic_function_calling_history?: Content[];
}
```

**What this means:**
- SDK can automatically detect function calls
- SDK can automatically execute them (with provided handlers)
- SDK maintains function call history
- **Thought signatures are handled automatically**

### 3. Curated vs Comprehensive History

From SDK docs (lines 1000-1010):
> "There are two types of history:
> - The `curated history` contains only the valid turns between user and model
> - The `comprehensive history` contains all turns, including invalid or empty model outputs"

```typescript
chat.getHistory(curated: false);  // Get comprehensive history (default)
chat.getHistory(curated: true);   // Get curated history
```

## Why Our Current Approach Might Break

### Issue 1: Parallel Function Calls

**Google's Expectation:**
```json
{
  "role": "model",
  "parts": [
    { "functionCall": {...}, "thoughtSignature": "<Sig>" },
    { "functionCall": {...} }  // No signature on parallel calls
  ]
},
{
  "role": "user",
  "parts": [
    { "functionResponse": {...} },
    { "functionResponse": {...} }
  ]
}
```

**Our Current Approach:**
1. Extract only FIRST function call
2. Execute it
3. Create NEW Chat instance with history INCLUDING the first FC
4. Send first FR
5. Model returns second FC
6. Repeat

**Problem:** We're sending function responses one-by-one instead of in a batch!

### Issue 2: Thought Signature Preservation

**SDK's Automatic Handling:**
- When you call `chat.sendMessage()`, the Chat instance automatically:
  1. Adds the user message to history
  2. Calls the model
  3. **Stores the COMPLETE model response** in history (including all Parts with signatures)
  4. Returns the response

**Our Manual Handling:**
- We extract `messages` array from somewhere else
- We manually convert it to Google format
- We create a NEW Chat with this history
- We might be LOSING Parts or signatures during conversion!

Let me check the conversion function:
```typescript
const chatHistory = convertMessagesToGoogleContentHistory(historyMessages, this.logger);
```

**Question:** Does this function preserve ALL Part fields including `thoughtSignature`?

## Solution Options

### Option A: Use SDK's Automatic Function Calling ✅ BEST

```typescript
// Enable automatic function calling
const chat = ai.chats.create({
  model: 'gemini-3-pro-preview',
  config: {
    temperature: 0.7,
    tools: [...],
    automaticFunctionCalling: {
      disable: false,
      maximumRemoteCalls: 10
    }
  }
});

// Just send messages, SDK handles everything!
const response = await chat.sendMessage({ 
  message: 'Check weather in Paris and London' 
});

// SDK automatically:
// ✅ Detects function calls
// ✅ Executes them (with handlers)
// ✅ Manages thought signatures
// ✅ Handles parallel calls
// ✅ Maintains complete history
```

**Pros:**
- Zero manual handling
- Guaranteed correct thought signature handling
- Handles parallel calls correctly
- Future-proof

**Cons:**
- Major architectural change
- Need to refactor tool execution system
- Need to provide function handlers to SDK

### Option B: Reuse Chat Instance, Manual Tool Execution ⚠️ MEDIUM

```typescript
class GoogleGenAIHandler {
  private chatSessions: Map<string, Chat> = new Map();
  
  async createResponse(options) {
    // Get or create Chat instance for this conversation
    const sessionId = getConversationId(options);
    let chat = this.chatSessions.get(sessionId);
    
    if (!chat) {
      // Create NEW chat only for NEW conversations
      chat = client.chats.create({
        model: this.config.fullName,
        config: generationConfig,
        history: initialHistory  // Only on first create
      });
      this.chatSessions.set(sessionId, chat);
    }
    
    // Just send the NEW message (not the full history!)
    const result = await chat.sendMessage({ 
      message: lastMessageParts,
      config: overrideConfig  // Per-request config if needed
    });
    
    return result;
  }
  
  clearSession(sessionId: string) {
    this.chatSessions.delete(sessionId);
  }
}
```

**Pros:**
- SDK handles history and signatures automatically
- Keep existing tool execution architecture
- Smaller change

**Cons:**
- Need to manage Chat instance lifecycle
- Need session IDs
- Still manually extract/execute function calls
- Still need to handle parallel calls manually

### Option C: Keep Current Approach, Fix Parallel Calls ❌ WORST

Continue creating new Chat each time BUT:
1. Extract ALL function calls (not just first)
2. Execute them in parallel
3. Send ALL results back together
4. Make sure conversion preserves thought signatures

**Pros:**
- Minimal change to current architecture

**Cons:**
- Fighting against SDK design
- Error-prone
- Need to ensure conversion preserves ALL Part fields
- Need to handle parallel calls manually
- Might still have subtle bugs

## Recommendation

### Immediate (This PR): Option C
Since we're already deep in this PR, let's:
1. ✅ Fix thought signature preservation (DONE)
2. ⚠️ Verify conversion preserves all Part fields
3. ⚠️ Document the parallel call limitation
4. ⚠️ Add warning if multiple FCs detected

### Future (Next PR): Option B
Refactor to reuse Chat instances:
1. Add Chat instance management
2. Keep manual tool execution
3. Let SDK handle history and signatures
4. Eventually handle parallel calls

### Long-term: Option A
Full SDK integration:
1. Use automatic function calling
2. Provide tool handlers to SDK
3. Let SDK handle everything
4. Simplify our code significantly

## Critical Check: Does Our Conversion Preserve Signatures?

Let me check `convertMessagesToGoogleContentHistory`:
