# 🚨 CRITICAL ISSUE: Parallel Function Calls Not Supported

## The Problem

Our current architecture processes **ONE tool call per iteration**, but Google's Gemini API (and potentially Anthropic/OpenAI) can return **MULTIPLE parallel function calls in a SINGLE response**.

## Current Architecture (Sequential)

```typescript
// In all model handlers:
extractToolUse() {
  const toolCall = parts.find(p => p.functionCall);  // ❌ Only gets FIRST call
  return toolCall;
}

// ToolUseCycleFlow.ts processes ONE tool call per iteration:
const toolExtraction = modelHandler.extractToolUse(response);  // ❌ Gets one
// Execute the tool
// Call model again for next tool call
```

### Current Flow
```
Response: [FC1, FC2] 
→ Extract FC1 only
→ Execute FC1
→ Send FC1 + FR1 back to model
→ Model returns [FC2] (or error?)
→ Extract FC2
→ Execute FC2
→ Send FC2 + FR2 back to model
```

## Google's Expected Flow (Parallel)

### From Documentation: "Parallel function calling example"

```json
// Turn 1, Step 1 - Model Response
{
  "parts": [
    {
      "functionCall": { "name": "get_temp", "args": {"location": "Paris"} },
      "thoughtSignature": "<Signature_A>"  // ✅ Only on FIRST
    },
    {
      "functionCall": { "name": "get_temp", "args": {"location": "London"} }
      // ❌ No signature on parallel FCs
    }
  ]
}

// Turn 1, Step 2 - User Response (Expected by Google)
{
  "messages": [
    {
      "role": "model",
      "parts": [
        {
          "functionCall": { "name": "get_temp", "args": {"location": "Paris"} },
          "thoughtSignature": "<Signature_A>"  // ✅ MUST include
        },
        {
          "functionCall": { "name": "get_temp", "args": {"location": "London"} }
        }
      ]
    },
    {
      "role": "user",
      "parts": [
        { "functionResponse": { "name": "get_temp", "response": {"temp": "15C"} } },
        { "functionResponse": { "name": "get_temp", "response": {"temp": "12C"} } }
      ]
    }
  ]
}
```

### Key Quote from Documentation:
> "When the API returns parallel function calls 'FC1 + signature, FC2', the user response expected is 'FC1+ signature, FC2, FR1, FR2'."

### WARNING from Documentation:
> "If you have them interleaved as 'FC1 + signature, FR1, FC2, FR2' the API will return a 400 error."

## What This Means

### ❌ Our Current Approach is WRONG for Parallel Calls

1. **We only extract the FIRST function call**
   ```typescript
   const originalPart = parts.find((part) => part.functionCall);  // ❌ 
   ```

2. **We execute it individually**

3. **We send back only ONE FC + ONE FR at a time**
   - This might trigger the "interleaved" error mentioned in the docs!

### ✅ What We SHOULD Do (According to Google)

1. **Extract ALL function calls** from the response
2. **Execute ALL of them** (can be in parallel)
3. **Send back ALL FCs + ALL FRs together** in a single message:
   ```json
   {
     "role": "model",
     "parts": [FC1_with_signature, FC2, FC3, ...]
   },
   {
     "role": "user", 
     "parts": [FR1, FR2, FR3, ...]
   }
   ```

## Impact on Other Model Handlers

### Anthropic
Line 1574 in `modelHandlerAnthropic.ts`:
```typescript
const tu = content.find((c: any) => c.type === 'tool_use');  // ❌ Only FIRST
```

**Anthropic Documentation**: [Parallel tool use](https://docs.anthropic.com/en/docs/build-with-claude/tool-use#parallel-tool-use)
> "Claude can also make multiple tool use requests at the same time"

### OpenAI  
Line 1170-1171 in `modelHandlerOpenAI.ts`:
```typescript
const toolCalls = responseObject?.choices?.[0]?.message?.tool_calls;
if (Array.isArray(toolCalls) && toolCalls.length > 0) {
  return JSON.stringify(toolCalls[0], null, 2);  // ❌ Only FIRST
}
```

**OpenAI Documentation**: [Parallel function calling](https://platform.openai.com/docs/guides/function-calling#parallel-function-calling)
> "Parallel function calling is the model's ability to perform multiple function calls together"

## Required Architectural Change

### Option 1: Change `extractToolUse` to return ALL tool calls

```typescript
// Change signature
extractToolUse(response): Array<{toolCall: string; originalBlock: any}> | null {
  // Return ALL function calls, not just the first one
  const allToolCalls = parts
    .filter(p => p.functionCall)
    .map(part => ({
      toolCall: JSON.stringify(part.functionCall),
      originalPart: part
    }));
  return allToolCalls.length > 0 ? allToolCalls : null;
}
```

### Option 2: Add a new method for batch extraction

```typescript
interface IModelHandler {
  // Keep existing for backward compatibility
  extractToolUse(response): string | {...} | null;
  
  // New method for parallel calls
  extractAllToolUses?(response): Array<{toolCall: string; originalBlock: any}> | null;
}
```

### Option 3: Keep Sequential (Current) BUT fix message history

The current sequential approach might actually work IF:
1. We properly preserve the ENTIRE model response in history
2. When sending the next tool call, we include the FULL previous model response (with all FCs)

```typescript
// Instead of:
messages.push({ role: "model", parts: [FC1_with_signature] });
messages.push({ role: "user", parts: [FR1] });
// Call model again - returns FC2

// Do:
messages.push({ role: "model", parts: [FC1_with_sig, FC2, FC3, ...] }); // FULL response
messages.push({ role: "user", parts: [FR1] });
// Call model again - should know FC2 and FC3 are still pending
```

## Immediate Questions

1. **Does the Google SDK's Chat class handle this automatically?**
   - The docs say: "If you use the official Google Gen AI SDKs and use the chat feature ... thought signatures are handled automatically"
   - Maybe the `Chat` class already handles parallel calls?

2. **Are we using the SDK correctly?**
   - Line 473 in our code: `const chat = client.chats.create(chatParams);`
   - We create a NEW chat every time
   - Should we reuse the Chat instance instead?

3. **Do parallel calls even work with our current architecture?**
   - Need to test: what happens when Gemini returns 2 function calls?
   - Do we get an error? Or does it somehow work?

## Action Plan

### 🔍 INVESTIGATE (Priority 1)
1. **Test parallel function calls** with current code
   - Create a test that requests multiple parallel tools
   - See what happens

2. **Check if Chat class handles it**
   - Read `@google/genai` SDK source
   - See if `chat.sendMessage()` handles parallel calls automatically

3. **Check Anthropic & OpenAI behavior**
   - Do they have the same requirement?
   - What's the expected message format?

### 🛠️ IMPLEMENT (Priority 2)
Based on findings:
- **If SDK handles it**: Verify we're using SDK correctly (might need to reuse Chat instance)
- **If we need to handle it**: Implement one of the options above

### 📝 DOCUMENT (Priority 3)
- Update CHANGELOG if architecture changes
- Document parallel function call support
- Add tests for parallel calls

## Risk Assessment

### 🔴 HIGH RISK
- **Current code might fail with parallel function calls**
- **Affects Google, Anthropic, OpenAI, DeepSeek handlers**
- **Could cause 400 errors from Google API**

### ⚠️ MEDIUM RISK  
- Might work "accidentally" if:
  - Models don't return parallel calls often
  - Our sequential approach happens to work
  - SDK handles it transparently

### 🟢 LOW RISK (Best Case)
- Google SDK's Chat class handles everything
- We just need to use it correctly
- No architecture change needed

## Next Steps

1. ✅ Document the issue (this file)
2. ⚠️ Test with real parallel function calls
3. ⚠️ Investigate SDK behavior
4. ⚠️ Implement fix if needed
5. ⚠️ Update tests
6. ⚠️ Update CHANGELOG

---

**Created**: 2025-11-18 (During investigation of thought_signature issue)
**Status**: 🚨 NEEDS INVESTIGATION
**Priority**: HIGH (affects core functionality)
