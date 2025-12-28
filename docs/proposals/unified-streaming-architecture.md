# Unified Streaming Architecture for Model Handlers

This document describes the design for refactoring model handler streaming to use a unified `AsyncIterable<StreamEvent>` pattern, replacing the current inconsistent mix of event listeners, for-await loops, and state machines.

## Problem Statement

The current streaming implementations across model handlers are inconsistent and hard to maintain:

| Provider        | Pattern                       | Stream Type                              | Challenges                          |
| --------------- | ----------------------------- | ---------------------------------------- | ----------------------------------- |
| Anthropic       | Event emitter + Handler class | `MessageStream`                          | Interleaved blocks, partial JSON    |
| OpenAI          | Event listeners (`on`/`off`)  | `ChatCompletionStream`                   | Tool calls as indexed fragments     |
| Google          | for-await (cumulative chunks) | `AsyncIterable<GenerateContentResponse>` | Must diff to get deltas             |
| OpenAI Response | for-await + state machine     | `AsyncIterable<ResponseStreamEvent>`     | Interleaved events, background mode |
| OpenRouter      | for-await                     | `ChatCompletionStream`                   | Different reasoning field names     |
| DeepSeek/Kimi   | Inherits OpenAI + overrides   | Event emitter                            | Custom reasoning extraction         |

### Current Pain Points

1. **6 different streaming patterns** - No clear "happy path" for new handlers
2. **Scattered aggregation logic** - `BaseReasoningStreamAggregator` only for OpenAI-compatible
3. **Inconsistent error handling** - Some use try/finally, others rely on implicit cleanup
4. **Hard to test** - Streaming logic spans base + derived + support classes
5. **Subclasses override too much** - Kimi reimplements entire `createResponse()`

## Proposed Solution

### Unified Event Schema

All providers normalize to a single `AsyncIterable<StreamEvent>`:

```typescript
type StreamEvent =
  // Content streaming
  | { type: 'thinking'; delta: string; blockIndex?: number }
  | { type: 'content'; delta: string; blockIndex?: number }

  // Tool calls
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; arguments: string }
  | { type: 'tool_call_done'; id: string }

  // Web search (native tools)
  | {
      type: 'web_search';
      callId: string;
      query: string;
      results: WebSearchResultEntry[];
      status: WebSearchStatus;
    }

  // Completion
  | { type: 'usage'; usage: NormalizedUsage }
  | { type: 'done'; response: NormalizedResponse };
```

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Consumer (Agent/UI)                     │
│     for await (const event of stream) { ... }           │
└─────────────────────────────────────────────────────────┘
                           ▲
                           │ AsyncIterable<StreamEvent>
┌─────────────────────────────────────────────────────────┐
│              Provider Stream Normalizers                 │
├──────────┬──────────┬──────────┬──────────┬─────────────┤
│ Anthropic│  OpenAI  │  Google  │ Response │  OpenRouter │
│ Normalizer│Normalizer│Normalizer│Normalizer│ Normalizer  │
└──────────┴──────────┴──────────┴──────────┴─────────────┘
      ▲          ▲          ▲          ▲           ▲
      │          │          │          │           │
   SDK Stream  SDK Stream  SDK Stream SDK Stream SDK Stream
```

## SDK Native Features to Leverage

All three primary SDKs support native `AsyncIterable`:

### Anthropic SDK (@anthropic-ai/sdk)

```typescript
// BetaMessageStream implements AsyncIterable<BetaMessageStreamEvent>
// Currently unused - we use event emitters instead
for await (const event of stream) {
  // event is BetaRawMessageStreamEvent
}

// Built-in snapshot tracking (underutilized)
stream.on('text', (textDelta: string, textSnapshot: string) => {
  // Provides both delta AND accumulated text
});

// Native event types we can reuse:
// - BetaRawMessageStreamEvent (content_block_start, content_block_delta, content_block_stop)
// - BetaContentBlock (text, thinking, tool_use, server_tool_use)
```

### OpenAI SDK (openai)

```typescript
// ChatCompletionStream implements AsyncIterable<ChatCompletionChunk>
for await (const chunk of stream) {
  // chunk is ChatCompletionChunk
}

// Built-in helpers (underutilized):
await stream.finalChatCompletion(); // Wait for complete response
await stream.totalUsage(); // Aggregate usage across chunks
stream.toReadableStream(); // Serialization helper

// ContentDeltaEvent provides normalized (delta, snapshot) tuple
```

### Google GenAI SDK (@google/genai)

```typescript
// sendMessageStream returns AsyncGenerator<GenerateContentResponse>
// Already used correctly with for-await
for await (const chunk of stream) {
  chunk.candidates?.[0]?.content?.parts;
}
```

### Stream Utilities in SDKs

Both Anthropic and OpenAI export:

```typescript
// Stream manipulation
stream.tee(): [Stream<Item>, Stream<Item>]  // Split for parallel consumption
Stream.fromReadableStream(rs, controller)   // Convert ReadableStream
```

## Detailed Design

### 1. StreamEvent Types (Zod Schema)

```typescript
// src/agent/modelHandlers/streaming/streamEventSchema.ts

import { z } from 'zod';

export const ThinkingEventSchema = z.object({
  type: z.literal('thinking'),
  delta: z.string(),
  blockIndex: z.number().optional(),
});

export const ContentEventSchema = z.object({
  type: z.literal('content'),
  delta: z.string(),
  blockIndex: z.number().optional(),
});

export const ToolCallStartEventSchema = z.object({
  type: z.literal('tool_call_start'),
  id: z.string(),
  name: z.string(),
});

export const ToolCallDeltaEventSchema = z.object({
  type: z.literal('tool_call_delta'),
  id: z.string(),
  arguments: z.string(),
});

export const ToolCallDoneEventSchema = z.object({
  type: z.literal('tool_call_done'),
  id: z.string(),
});

export const WebSearchEventSchema = z.object({
  type: z.literal('web_search'),
  callId: z.string(),
  query: z.string(),
  results: z.array(WebSearchResultEntrySchema),
  status: z.enum(['in_progress', 'completed', 'failed']),
});

export const UsageEventSchema = z.object({
  type: z.literal('usage'),
  usage: NormalizedUsageSchema,
});

export const DoneEventSchema = z.object({
  type: z.literal('done'),
  response: NormalizedResponseSchema,
});

export const StreamEventSchema = z.discriminatedUnion('type', [
  ThinkingEventSchema,
  ContentEventSchema,
  ToolCallStartEventSchema,
  ToolCallDeltaEventSchema,
  ToolCallDoneEventSchema,
  WebSearchEventSchema,
  UsageEventSchema,
  DoneEventSchema,
]);

export type StreamEvent = z.infer<typeof StreamEventSchema>;
```

### 2. Provider Normalizers

Each provider implements a generator function:

```typescript
// src/agent/modelHandlers/streaming/normalizers/anthropicNormalizer.ts

export async function* normalizeAnthropicStream(
  stream: MessageStream,
  options: NormalizerOptions,
): AsyncGenerator<StreamEvent> {
  const state = {
    lastBlockIndex: -1,
    currentThinkingId: null as number | null,
    currentTextBlockId: null as number | null,
    pendingSearches: new Map<string, { index: number; input: string }>(),
  };

  // Use SDK's native AsyncIterable instead of event emitters
  for await (const event of stream) {
    yield* handleAnthropicEvent(event, state, options);
  }

  // Emit final events
  const finalMessage = await stream.finalMessage();
  yield* emitFinalEvents(finalMessage, state, options);
}

function* handleAnthropicEvent(
  event: BetaRawMessageStreamEvent,
  state: AnthropicStreamState,
  options: NormalizerOptions,
): Generator<StreamEvent> {
  if (event.type === 'content_block_delta') {
    if (event.delta.type === 'thinking_delta') {
      yield {
        type: 'thinking',
        delta: event.delta.thinking,
        blockIndex: event.index,
      };
    } else if (event.delta.type === 'text_delta') {
      yield {
        type: 'content',
        delta: event.delta.text,
        blockIndex: event.index,
      };
    }
    // ... handle other delta types
  }
  // ... handle other event types
}
```

### 3. Unified Consumer

A single consumer handles all providers:

```typescript
// src/agent/modelHandlers/streaming/StreamConsumer.ts

export class StreamConsumer {
  constructor(
    private logger: AgentLogger,
    private options: StreamConsumerOptions,
  ) {}

  async consume(
    stream: AsyncIterable<StreamEvent>,
  ): Promise<NormalizedResponse> {
    const thinkingStream = this.logger.createStream(MESSAGE_TYPES.THINKING, {
      progressViewEnabled: this.options.progressViewEnabled,
    });
    const outputStream = this.options.outputEnabled
      ? this.logger.createStream(MESSAGE_TYPES.MODEL_RESPONSE, {
          progressViewEnabled: this.options.progressViewEnabled,
        })
      : null;

    const emittedSearchIds = new Set<string>();
    let response: NormalizedResponse | null = null;

    try {
      for await (const event of stream) {
        switch (event.type) {
          case 'thinking':
            thinkingStream.append(event.delta);
            break;

          case 'content':
            outputStream?.append(event.delta);
            break;

          case 'web_search':
            if (!emittedSearchIds.has(event.callId)) {
              this.logger.info('', {
                messageType: MESSAGE_TYPES.WEB_SEARCH,
                data: event,
              });
              emittedSearchIds.add(event.callId);
            }
            break;

          case 'usage':
            // Store for final response
            break;

          case 'done':
            response = event.response;
            break;
        }
      }
    } finally {
      thinkingStream.finalize();
      outputStream?.finalize();
    }

    if (!response) {
      throw new Error('Stream ended without done event');
    }

    return response;
  }
}
```

### 4. Handler Integration

Model handlers expose a `createStream()` method:

```typescript
// In ModelHandlerAnthropic
protected async *createNormalizedStream(
  params: CreateResponseParams,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const stream = await this.client.beta.messages.stream(params, { signal });
  yield* normalizeAnthropicStream(stream, this.getNormalizerOptions());
}

// In executeStreamingChat (base class or shared)
protected async executeStreamingChat(params, signal): Promise<NormalizedResponse> {
  const stream = this.createNormalizedStream(params, signal);
  const consumer = new StreamConsumer(this.logger, this.getConsumerOptions());
  return consumer.consume(stream);
}
```

## UI Integration

The UI layer remains **unchanged**. The consumer uses the same logger APIs:

| Stream Event  | Logger Call                                | UI MESSAGE_TYPE  |
| ------------- | ------------------------------------------ | ---------------- |
| `thinking`    | `thinkingStream.append()`                  | `THINKING`       |
| `content`     | `outputStream.append()`                    | `MODEL_RESPONSE` |
| `web_search`  | `logger.info({ messageType: WEB_SEARCH })` | `WEB_SEARCH`     |
| `tool_call_*` | (accumulated, logged on done)              | `TOOL_USE`       |

### Progress View Compatibility

Current flow (unchanged):

```
Stream.append() → bus.emit('addLogMessage'/'updateLogMessage') → ProgressView
```

The `StreamConsumer` calls the same `createStream()` / `append()` / `finalize()` APIs.

## Special Considerations

### 1. Interleaved Thinking Blocks (Anthropic)

Anthropic can interleave thinking with content. The `blockIndex` field enables:

```typescript
// Consumer tracks current thinking block
let currentThinkingIndex = -1;
let thinkingStream: AgentLogStream | null = null;

case 'thinking':
  if (event.blockIndex !== currentThinkingIndex) {
    thinkingStream?.finalize();
    thinkingStream = this.logger.createStream(MESSAGE_TYPES.THINKING);
    currentThinkingIndex = event.blockIndex ?? -1;
  }
  thinkingStream?.append(event.delta);
```

### 2. Consecutive Text Block Merging

Consecutive text blocks share a stream:

```typescript
let currentTextBlockIndex = -1;
let outputStream: AgentLogStream | null = null;

case 'content':
  const isConsecutive = event.blockIndex === currentTextBlockIndex + 1;
  if (!isConsecutive && outputStream) {
    outputStream.finalize();
    outputStream = null;
  }
  if (!outputStream) {
    outputStream = this.logger.createStream(MESSAGE_TYPES.MODEL_RESPONSE);
  }
  outputStream.append(event.delta);
  currentTextBlockIndex = event.blockIndex ?? currentTextBlockIndex;
```

### 3. OpenAI-Compatible Subclasses

DeepSeek, Kimi, xAI, DashScope can use hooks instead of overriding streaming:

```typescript
// Base class provides hooks
protected getReasoningExtractor(): (chunk: ChatCompletionChunk) => string {
  return extractReasoningDelta; // Default
}

protected customizeStreamParams(params: ChatCompletionStreamParams): void {
  // Override in subclass (e.g., Kimi adds `thinking: true`)
}

// Kimi only needs:
protected customizeStreamParams(params) {
  if (this.isThinkingModel()) {
    params.thinking = true;
  }
}
```

### 4. Background Mode (OpenAI Response API)

Background mode bypasses streaming entirely:

```typescript
if (this.isBackgroundModeActive()) {
  // Poll until complete, no streaming events
  const response = await this.pollForCompletion(responseId, signal);
  yield { type: 'done', response: this.normalizeResponse(response) };
  return;
}

// Normal streaming path
for await (const event of stream) {
  yield* normalizeOpenAIResponseEvent(event, state);
}
```

## Implementation Plan

### Phase 1: Foundation (Week 1)

1. **Create schema and types**
   - [ ] `src/agent/modelHandlers/streaming/streamEventSchema.ts`
   - [ ] `src/agent/modelHandlers/streaming/types.ts`
   - [ ] Export from `src/agent/modelHandlers/streaming/index.ts`

2. **Create StreamConsumer**
   - [ ] `src/agent/modelHandlers/streaming/StreamConsumer.ts`
   - [ ] Handle all event types
   - [ ] Support interleaved blocks
   - [ ] Add comprehensive tests

### Phase 2: Provider Normalizers (Week 2)

3. **Anthropic normalizer**
   - [ ] `src/agent/modelHandlers/streaming/normalizers/anthropicNormalizer.ts`
   - [ ] Use SDK's native AsyncIterable
   - [ ] Handle web search accumulation
   - [ ] Tests with mock streams

4. **OpenAI normalizer**
   - [ ] `src/agent/modelHandlers/streaming/normalizers/openaiNormalizer.ts`
   - [ ] Use SDK's native AsyncIterable
   - [ ] Handle tool call fragments
   - [ ] Tests with mock streams

5. **Google normalizer**
   - [ ] `src/agent/modelHandlers/streaming/normalizers/googleNormalizer.ts`
   - [ ] Calculate deltas from cumulative chunks
   - [ ] Tests with mock streams

### Phase 3: Integration (Week 3)

6. **Integrate with Anthropic handler**
   - [ ] Add `createNormalizedStream()` method
   - [ ] Refactor `executeStreamingChat()` to use consumer
   - [ ] Remove `AnthropicStreamHandler` class
   - [ ] Integration tests

7. **Integrate with OpenAI handler**
   - [ ] Add `createNormalizedStream()` method
   - [ ] Add hooks for subclasses (`getReasoningExtractor`, `customizeStreamParams`)
   - [ ] Integration tests

8. **Integrate with Google handler**
   - [ ] Add `createNormalizedStream()` method
   - [ ] Integration tests

### Phase 4: Subclasses & Cleanup (Week 4)

9. **Simplify OpenAI subclasses**
   - [ ] Kimi: Remove `createResponse()` override, use hooks
   - [ ] DeepSeek: Verify works with base class
   - [ ] xAI, DashScope: Verify minimal changes needed

10. **OpenAI Response API & OpenRouter**
    - [ ] `src/agent/modelHandlers/streaming/normalizers/openaiResponseNormalizer.ts`
    - [ ] `src/agent/modelHandlers/streaming/normalizers/openrouterNormalizer.ts`
    - [ ] Integration tests

11. **Cleanup**
    - [ ] Remove `BaseReasoningStreamAggregator` (if unused)
    - [ ] Remove old streaming code paths
    - [ ] Update documentation

## Testing Strategy

### Unit Tests

```typescript
// Test normalizer in isolation
describe('anthropicNormalizer', () => {
  it('yields thinking events for thinking_delta', async () => {
    const mockStream = createMockAnthropicStream([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Let me think...' },
      },
    ]);

    const events = await collectEvents(
      normalizeAnthropicStream(mockStream, {}),
    );
    expect(events).toContainEqual({
      type: 'thinking',
      delta: 'Let me think...',
      blockIndex: 0,
    });
  });
});
```

### Integration Tests

```typescript
// Test full flow with real SDK types
describe('StreamConsumer integration', () => {
  it('creates thinking and output streams from normalized events', async () => {
    const mockLogger = createMockLogger();
    const consumer = new StreamConsumer(mockLogger, {
      progressViewEnabled: true,
    });

    const events = async function* () {
      yield { type: 'thinking', delta: 'Thinking...' };
      yield { type: 'content', delta: 'Hello' };
      yield { type: 'done', response: mockResponse };
    };

    await consumer.consume(events());

    expect(mockLogger.createStream).toHaveBeenCalledWith(
      MESSAGE_TYPES.THINKING,
      expect.any(Object),
    );
    expect(mockLogger.createStream).toHaveBeenCalledWith(
      MESSAGE_TYPES.MODEL_RESPONSE,
      expect.any(Object),
    );
  });
});
```

## Migration Path

1. **Parallel implementation** - New streaming code coexists with old
2. **Feature flag** - `texra.experimental.unifiedStreaming` enables new path
3. **Gradual rollout** - Enable per-provider as verified
4. **Cleanup** - Remove old code after all providers migrated

## Benefits

| Aspect             | Before                | After                      |
| ------------------ | --------------------- | -------------------------- |
| Streaming patterns | 6 different           | 1 unified                  |
| New handler effort | High (copy/adapt)     | Low (implement normalizer) |
| Testing            | Hard (event emitters) | Easy (generators)          |
| Error handling     | Inconsistent          | Consistent try/finally     |
| Code duplication   | High                  | Low (shared consumer)      |
| SDK utilization    | Event-based           | Native AsyncIterable       |

## Files to Create/Modify

### New Files

- `src/agent/modelHandlers/streaming/streamEventSchema.ts`
- `src/agent/modelHandlers/streaming/types.ts`
- `src/agent/modelHandlers/streaming/StreamConsumer.ts`
- `src/agent/modelHandlers/streaming/normalizers/anthropicNormalizer.ts`
- `src/agent/modelHandlers/streaming/normalizers/openaiNormalizer.ts`
- `src/agent/modelHandlers/streaming/normalizers/googleNormalizer.ts`
- `src/agent/modelHandlers/streaming/normalizers/openaiResponseNormalizer.ts`
- `src/agent/modelHandlers/streaming/normalizers/openrouterNormalizer.ts`
- `src/agent/modelHandlers/streaming/index.ts`

### Modified Files

- `src/agent/modelHandlers/modelHandlerAnthropic.ts`
- `src/agent/modelHandlers/modelHandlerOpenAI.ts`
- `src/agent/modelHandlers/modelHandlerGoogleGenAI.ts`
- `src/agent/modelHandlers/modelHandlerOpenAIResponse.ts`
- `src/agent/modelHandlers/modelHandlerOpenRouter.ts`
- `src/agent/modelHandlers/modelHandlerKimi.ts`
- `src/agent/modelHandlers/modelHandlerDeepSeek.ts`

### Files to Remove (after migration)

- `src/agent/modelHandlers/support/AnthropicStreamHandler.ts` (logic moves to normalizer)
- `src/agent/modelHandlers/BaseReasoningStreamAggregator.ts` (if unused)

## Open Questions

1. Should `blockIndex` be required or optional on thinking/content events?
2. Should we support streaming tool call arguments to the UI?
3. How to handle providers that don't support thinking (emit empty or skip)?
4. Should the consumer be a class or a function?

## References

- [Anthropic SDK Streaming](https://docs.anthropic.com/en/api/streaming)
- [OpenAI SDK Streaming](https://platform.openai.com/docs/api-reference/streaming)
- [Google GenAI Streaming](https://ai.google.dev/gemini-api/docs/text-generation#streaming)
