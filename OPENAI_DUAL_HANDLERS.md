# OpenAI Dual Handler Support

## Confirmed: Both OpenAI Handlers Updated ✅

### 1. Chat Completions API Handler
**File**: `src/agent/modelHandlers/modelHandlerOpenAI.ts`

**Uses**: Standard OpenAI Chat Completions API
- `openai.chat.completions.create()`
- Tool calls: `ChatCompletionMessageToolCall`

**Updated**: ✅
- `createToolUseFollowUpMessages()` accepts `callArg: any`
- Preserves original `ChatCompletionMessageToolCall` when available
- Falls back to normalization for backward compatibility

### 2. Responses API Handler  
**File**: `src/agent/modelHandlers/modelHandlerOpenAIResponse.ts`

**Uses**: OpenAI Responses API (different from Chat Completions)
- `openai.responses.create()`
- Tool calls: `ResponseFunctionToolCallItem`
- Different message format and structure

**Updated**: ✅
- `createToolUseFollowUpMessages()` accepts `callArg: any`
- Handles native `ResponseFunctionToolCallItem` format
- Backward compatible with parsed payloads

## Key Differences

| Feature | Chat Completions API | Responses API |
|---------|---------------------|---------------|
| **Tool Call Type** | `ChatCompletionMessageToolCall` | `ResponseFunctionToolCallItem` |
| **Message Type** | `ChatCompletionMessageParam` | `ResponseInputItem` |
| **ID Field** | `id` | `call_id` |
| **Use Case** | Standard chat | Long-running responses |

## Implementation Notes

Both handlers now:
1. Accept the native SDK object OR legacy parsed payload
2. Check if the object is complete (has all required fields)
3. Use the original if complete (preserves metadata)
4. Fall back to reconstruction if incomplete (backward compatibility)

This ensures both OpenAI integration paths work correctly with the new native object preservation pattern.

## Status

- ✅ Both handlers updated
- ✅ Both compile successfully
- ✅ Both lint clean
- ⚠️ Test files need updates (expected - they use old signatures)
