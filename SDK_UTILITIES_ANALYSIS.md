# SDK Utilities Analysis for TeXRA

This document identifies native SDK helpers, methods, types, and schemas that could replace custom implementations for better maintainability and reduced code.

## Executive Summary

After deep analysis of the SDKs used in TeXRA, several opportunities for code reduction were identified:

| SDK | Current Usage | Opportunities Found |
|-----|--------------|---------------------|
| @anthropic-ai/sdk | Good | 8 major opportunities |
| openai | Good | 7 major opportunities |
| @google/genai | Moderate | 5 opportunities |
| zod | Excellent | 4 enhancement opportunities |
| @modelcontextprotocol/sdk | Limited | 3 opportunities |

---

## 1. Anthropic SDK (`@anthropic-ai/sdk` v0.71.2)

### Currently Used
- Basic types: `MessageParam`, `StopReason`, `ToolUseBlock`
- Stream events: `BetaRawMessageStreamEvent`
- Server tools: `ServerToolUseBlock`, `WebSearchToolResultBlock`

### Underutilized Features

#### 1.1 Token Counting API
**SDK provides:** `client.messages.countTokens()`
```typescript
// SDK native
const count = await client.messages.countTokens({
  model: 'claude-sonnet-4-20250514',
  messages: [{ role: 'user', content: 'Hello' }],
});
console.log(count.input_tokens);
```
**Current:** Uses `gpt-tokenizer` for estimates
**Impact:** More accurate token counting for Claude models

#### 1.2 MessageStream Event Helpers
**SDK provides:** `MessageStream` class with built-in event handling
```typescript
// SDK native
const stream = client.messages.stream({ ... });
stream.on('text', (text) => console.log(text));
stream.on('thinking', (thinking) => console.log(thinking));
stream.on('inputJson', (json) => console.log(json));
const finalMessage = await stream.finalMessage();
const finalText = await stream.finalText();
```
**Current:** Manual event parsing in `AnthropicStreamHandler.ts` (354 lines)
**Impact:** Could reduce stream handling code by ~50%

#### 1.3 ToolRunner / BetaToolRunner
**SDK provides:** Automatic tool execution loop with context compaction
```typescript
// SDK native - handles full tool loop
const runner = client.beta.messages.runTools({
  model: 'claude-sonnet-4-20250514',
  tools: [{ name: 'read_file', ... }],
  messages: [...],
}).on('tool_use', (toolUse) => executeLocalTool(toolUse));

const finalMessage = await runner.finalMessage();
```
**Current:** Custom tool-use loop in agent implementations
**Impact:** Could simplify agentic flows significantly

#### 1.4 File Upload Utilities
**SDK provides:** `toFile()` function for various input types
```typescript
import { toFile } from '@anthropic-ai/sdk';
// Converts Blob, Response, ReadStream, AsyncIterable to File
const file = await toFile(blob, 'image.png');
```
**Current:** Manual file handling
**Impact:** Cleaner file handling code

#### 1.5 APIPromise Utilities
**SDK provides:** `withResponse()` for request ID tracking
```typescript
const { data, response, request_id } = await client.messages.create({ ... }).withResponse();
```
**Current:** Manual response handling
**Impact:** Better debugging and request tracking

#### 1.6 Batch Processing API
**SDK provides:** Native batch API for bulk operations
```typescript
const batch = await client.messages.batches.create({
  requests: [{ custom_id: '1', params: { ... } }, ...]
});
```
**Current:** Sequential requests
**Impact:** More efficient bulk processing

#### 1.7 Base64 Encoding Utilities
**SDK provides:** `toBase64()`, `fromBase64()`, `encodeUTF8()`, `decodeUTF8()`
```typescript
import { toBase64, fromBase64 } from '@anthropic-ai/sdk/internal/utils/bytes';
```
**Current:** Uses Node.js Buffer directly
**Impact:** Cross-environment compatibility

#### 1.8 Error Type Granularity
**SDK provides:** Specific error classes
```typescript
import {
  RateLimitError,
  AuthenticationError,
  BadRequestError,
  APIConnectionTimeoutError
} from '@anthropic-ai/sdk';
```
**Current:** `src/common/errors/sdkErrorUtils.ts` handles some
**Impact:** More granular error handling

---

## 2. OpenAI SDK (`openai` v6.10.0)

### Currently Used
- `ChatCompletionTool`, `FunctionDefinition`
- `isAssistantMessage()` helper
- `ContentDeltaEvent` for streaming
- `ResponseStreamParams`, `Reasoning`, `ReasoningEffort`

### Underutilized Features

#### 2.1 Zod Integration for Structured Outputs
**SDK provides:** Native Zod support
```typescript
import { zodResponseFormat, zodFunction } from 'openai/helpers/zod';
import { z } from 'zod';

// Structured output with automatic parsing
const completion = await client.beta.chat.completions.parse({
  model: 'gpt-4o',
  messages: [...],
  response_format: zodResponseFormat(MySchema, 'my_schema'),
});
console.log(completion.choices[0].message.parsed); // Typed!

// Tool with Zod schema
const tool = zodFunction({
  name: 'get_weather',
  parameters: z.object({ location: z.string() }),
});
```
**Current:** Manual JSON Schema conversion in `tools/core/define.ts`
**Impact:** Type-safe structured outputs, less conversion code

#### 2.2 ChatCompletionStream Events
**SDK provides:** Rich event system
```typescript
const stream = client.beta.chat.completions.stream({ ... });
stream.on('content.delta', (delta) => { ... });
stream.on('tool_calls.function.arguments.delta', (delta) => { ... });
stream.on('refusal.delta', (delta) => { ... });

// Convert for frontend
const readableStream = stream.toReadableStream();
```
**Current:** Manual stream parsing
**Impact:** Cleaner streaming code

#### 2.3 ChatCompletionRunner for Tool Loops
**SDK provides:** Automatic tool execution
```typescript
import { ChatCompletionStreamingRunner } from 'openai/lib/ChatCompletionStreamingRunner';

const runner = ChatCompletionStreamingRunner.runTools(client, {
  model: 'gpt-4o',
  tools: [...],
  messages: [...],
});
runner.on('functionToolCall', (call) => { ... });
const result = await runner.finalChatCompletion();
```
**Current:** Custom tool loops
**Impact:** Reduced boilerplate for tool-use agents

#### 2.4 Input Token Counting
**SDK provides:** Pre-request token estimation
```typescript
const count = await client.responses.inputTokens.count({
  model: 'gpt-4o',
  input: [...],
  tools: [...],
});
```
**Current:** External tokenizer estimates
**Impact:** Accurate cost estimation

#### 2.5 Type Guards
**SDK provides:** Built-in type guards
```typescript
import { isAssistantMessage, isToolMessage, isPresent } from 'openai/lib/chatCompletionUtils';
```
**Current:** Custom type guards in `ServerToolTypes.ts`
**Impact:** Could supplement existing guards

#### 2.6 Webhook Verification
**SDK provides:** Signature verification
```typescript
import { Webhooks } from 'openai/resources';
const event = Webhooks.unwrap(payload, headers, secret);
```
**Current:** Not needed currently but available for future use

#### 2.7 allSettledWithThrow Utility
**SDK provides:** Promise utility
```typescript
import { allSettledWithThrow } from 'openai/lib/Util';
// Like Promise.allSettled but throws on any rejection
```
**Current:** Manual Promise handling
**Impact:** Cleaner async code

---

## 3. Google GenAI SDK (`@google/genai` v1.33.0)

### Currently Used
- `FinishReason` enum
- Basic generation types

### Underutilized Features

#### 3.1 Content Creation Helpers
**SDK provides:** Factory functions
```typescript
import {
  createPartFromText,
  createPartFromBase64,
  createPartFromUri,
  createUserContent,
  createModelContent,
  createPartFromFunctionCall,
  createPartFromFunctionResponse,
} from '@google/genai';

const content = createUserContent([
  createPartFromText('Describe this image'),
  createPartFromBase64(base64Data, 'image/png'),
]);
```
**Current:** Manual content construction
**Impact:** Cleaner message building

#### 3.2 Response Getters
**SDK provides:** Built-in accessors
```typescript
const response = await model.generateContent(...);
console.log(response.text);           // Concatenated text
console.log(response.functionCalls);  // All function calls
console.log(response.data);           // Inline data
```
**Current:** Manual content extraction
**Impact:** Simpler response handling

#### 3.3 Chat History Management
**SDK provides:** `Chat` class with history
```typescript
const chat = model.startChat({ history: [...] });
const response = await chat.sendMessage('Hello');
const history = chat.getHistory();
```
**Current:** Manual history tracking
**Impact:** Built-in conversation management

#### 3.4 File Upload/Download
**SDK provides:** File management
```typescript
const file = await genai.files.upload({
  file: '/path/to/file.pdf',
  config: { mimeType: 'application/pdf' },
});
await genai.files.download({ file: file.name, downloadPath: './out.pdf' });
```
**Current:** Manual file handling
**Impact:** Simpler media handling

#### 3.5 Native Schema Type
**SDK provides:** Full JSON Schema interface
```typescript
import type { Schema } from '@google/genai/dist/genai';
// Already used in ToolDefinition.ts - good!
```
**Status:** Already properly used

---

## 4. Zod (`zod` v4.1.13)

### Currently Used (Excellent)
- Schema-first types with `z.infer<>`
- `z.discriminatedUnion()` for type unions
- `toJSONSchema()` for tool definitions
- `.transform()`, `.superRefine()` for validation

### Enhancement Opportunities

#### 4.1 `z.nativeEnum()` for SDK Enums
**Location:** `src/agent/modelHandlers/types/StopReasonTypes.ts`
```typescript
// Current (lines 9-20)
export const OPENAI_CHAT_FINISH = {
  STOP: 'stop',
  LENGTH: 'length',
  // ...
} as const;
export type OpenAIChatFinishReason = (typeof OPENAI_CHAT_FINISH_REASONS)[number] | null;

// Could use z.nativeEnum()
const OpenAIChatFinishSchema = z.nativeEnum(OPENAI_CHAT_FINISH);
type OpenAIChatFinishReason = z.infer<typeof OpenAIChatFinishSchema> | null;
```
**Impact:** Consistent schema-based validation

#### 4.2 Replace Manual Type Guards with Zod
**Location:** `src/agent/modelHandlers/types/ServerToolTypes.ts`
```typescript
// Current (lines 98-106)
export function isAnthropicServerToolUse(block: unknown): block is ServerToolUseBlock {
  return typeof block === 'object' && block !== null &&
    (block as { type?: string }).type === 'server_tool_use';
}

// Could use Zod schema with safeParse
const ServerToolUseBlockSchema = z.object({
  type: z.literal('server_tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
const isAnthropicServerToolUse = (block: unknown) =>
  ServerToolUseBlockSchema.safeParse(block).success;
```
**Impact:** Consistent validation, better error messages

#### 4.3 `.catch()` for Graceful Fallbacks
**Current:** Manual safeParse with if-checks
```typescript
// Could simplify with .catch()
const result = schema.catch(defaultValue).parse(data);
```

#### 4.4 `.brand()` for Branded Types
**Location:** `src/utils/files/taskRunStorage.ts`
```typescript
// Current
export type StorageKey = string & { readonly __brand: 'StorageKey' };

// Could use Zod's brand
const StorageKeySchema = z.string().regex(...).brand<'StorageKey'>();
```

---

## 5. MCP SDK (`@modelcontextprotocol/sdk` v1.24.3)

### Currently Used
- Basic MCP types

### Underutilized Features

#### 5.1 Tool Name Validation
**SDK provides:** Built-in validation
```typescript
import { validateToolName, validateAndWarnToolName } from '@modelcontextprotocol/sdk/shared/toolNameValidation';

const { isValid, warnings } = validateToolName('my_tool');
```
**Current:** No explicit tool name validation
**Impact:** Better tool naming consistency

#### 5.2 Zod-to-JSON-Schema Compatibility
**SDK provides:** Cross-version Zod support
```typescript
import { toJsonSchemaCompat, safeParse, safeParseAsync } from '@modelcontextprotocol/sdk/server/zod-compat';
```
**Current:** Direct Zod usage
**Impact:** Better Zod v3/v4 compatibility

#### 5.3 Native Tool Registration
**SDK provides:** `McpServer.registerTool()`
```typescript
const tool = server.registerTool('my_tool', {
  description: '...',
  inputSchema: MyZodSchema,
  outputSchema: OutputSchema,
}, async (args) => { ... });

tool.disable();  // Runtime control
tool.update({ description: 'new desc' });
```
**Current:** Custom tool registration
**Impact:** Standard MCP tool lifecycle

---

## Recommendations by Priority

### High Priority (Significant Code Reduction)

1. **Anthropic MessageStream** - Replace `AnthropicStreamHandler.ts` (354 lines) with SDK's event-based streaming
2. **OpenAI zodResponseFormat/zodFunction** - Eliminate manual JSON Schema conversion in tool definitions
3. **Token Counting APIs** - Use native `countTokens()` from Anthropic/OpenAI instead of estimates

### Medium Priority (Code Quality)

4. **Type Guards with Zod** - Replace manual type guards in `ServerToolTypes.ts` with Zod schemas
5. **Content Creation Helpers (Google)** - Use `createPartFromText()`, etc. for cleaner code
6. **Error Type Handling** - Use SDK-specific error classes for granular handling

### Lower Priority (Future Considerations)

7. **ToolRunner/ChatCompletionRunner** - Consider for future agentic loop simplification
8. **Batch Processing** - For bulk operations if needed
9. **MCP Tool Registration** - If MCP server functionality expands

---

## Files Most Affected

| File | Lines | Potential Reduction |
|------|-------|---------------------|
| `src/agent/modelHandlers/support/AnthropicStreamHandler.ts` | 354 | ~150 lines |
| `src/agent/modelHandlers/types/ServerToolTypes.ts` | 387 | ~100 lines |
| `src/agent/modelHandlers/types/StopReasonTypes.ts` | 111 | ~30 lines |
| `src/tools/core/define.ts` | 33 | ~10 lines (with zodFunction) |
| Various model handlers | ~2000 | ~200 lines total |

**Estimated Total Code Reduction:** 400-500 lines with improved type safety

---

## Next Steps

1. Create feature branch for SDK utility adoption
2. Start with high-priority items (MessageStream, zodFunction)
3. Add tests to verify behavior parity
4. Gradually migrate lower-priority items
5. Update documentation

---

*Generated: 2025-12-12*
