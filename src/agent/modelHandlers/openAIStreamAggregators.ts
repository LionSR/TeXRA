// Standard library imports
// (none needed)

// Third-party imports
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessage,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

const MAX_TOOL_CALLS = 100;

type ExtendedChoiceDelta = ChatCompletionChunk.Choice.Delta & {
  reasoning_content?: unknown;
  content?: unknown;
};

type ToolCallDelta = ChatCompletionChunk.Choice.Delta.ToolCall;

type FunctionCallDelta = ChatCompletionChunk.Choice.Delta.FunctionCall;

type ChatCompletionMessageWithReasoning = ChatCompletionMessage & {
  reasoning_content?: string;
};

/**
 * Delta information returned when processing a streaming chunk.
 */
export interface StreamAggregatorDelta {
  /** Reasoning text extracted from the chunk. */
  reasoningDelta?: string;
  /** Assistant message text extracted from the chunk. */
  contentDelta?: string;
}

/**
 * Aggregator interface for OpenAI-style streaming responses.
 */
export interface OpenAIStreamAggregator {
  /**
   * Ingests a streaming chunk and returns extracted reasoning/output text.
   */
  ingest(chunk: ChatCompletionChunk): StreamAggregatorDelta;

  /** Returns the concatenated assistant message content. */
  getAggregatedContent(): string;

  /** Returns the concatenated reasoning content. */
  getAggregatedReasoning(): string;

  /**
   * Synthesizes a final ChatCompletion payload from aggregated state.
   */
  finalize(): ChatCompletion;
}

/**
 * Shared aggregator for providers that do not emit a final completion payload.
 */
export class OpenAIStreamDeltaAggregator implements OpenAIStreamAggregator {
  private readonly contentParts: string[] = [];
  private readonly reasoningParts: string[] = [];
  private readonly aggregatedToolCalls = new Map<number, ToolCallDelta>();
  private aggregatedFunctionCall: FunctionCallDelta | null = null;
  private role: ChatCompletionMessage['role'] | undefined;
  private lastChunk: ChatCompletionChunk | null = null;

  ingest(chunk: ChatCompletionChunk): StreamAggregatorDelta {
    this.lastChunk = chunk;

    const delta = (chunk.choices?.[0]?.delta ?? {}) as ExtendedChoiceDelta;
    const updates: StreamAggregatorDelta = {};

    if (delta.role === 'assistant') {
      this.role = delta.role;
    }

    const reasoningDelta = this.collectText(delta.reasoning_content);
    if (reasoningDelta) {
      this.reasoningParts.push(reasoningDelta);
      updates.reasoningDelta = reasoningDelta;
    }

    const contentDelta = this.collectText(delta.content);
    if (contentDelta) {
      this.contentParts.push(contentDelta);
      updates.contentDelta = contentDelta;
    }

    if (Array.isArray(delta.tool_calls)) {
      this.aggregateToolCalls(delta.tool_calls as ToolCallDelta[]);
    }

    if (delta.function_call) {
      this.aggregateFunctionCall(delta.function_call as FunctionCallDelta);
    }

    return updates;
  }

  getAggregatedContent(): string {
    return this.contentParts.join('');
  }

  getAggregatedReasoning(): string {
    return this.reasoningParts.join('');
  }

  finalize(): ChatCompletion {
    const lastChunk = this.lastChunk;
    const message: ChatCompletionMessageWithReasoning = {
      role: this.role ?? 'assistant',
      content: this.getAggregatedContent(),
      refusal: null,
    };

    const reasoning = this.getAggregatedReasoning();
    if (reasoning) {
      message.reasoning_content = reasoning;
    }

    const toolCalls = this.normalizeToolCalls();
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    if (this.aggregatedFunctionCall) {
      const name = this.aggregatedFunctionCall.name ?? '';
      const args = this.aggregatedFunctionCall.arguments ?? '';
      if (name || args) {
        message.function_call = {
          name,
          arguments: args,
        };
      }
    }

    const finishReason =
      lastChunk?.choices?.[0]?.finish_reason ?? 'stop';

    const response: ChatCompletion = {
      id: lastChunk?.id ?? `stream-aggregated-${Date.now()}`,
      object: 'chat.completion',
      created: lastChunk?.created ?? Math.floor(Date.now() / 1000),
      model: lastChunk?.model ?? 'stream-aggregated-model',
      system_fingerprint: lastChunk?.system_fingerprint,
      usage: lastChunk?.usage ?? undefined,
      choices: [
        {
          index: 0,
          message,
          finish_reason: finishReason,
          logprobs: null,
        },
      ],
    };

    return response;
  }

  private collectText(value: unknown): string {
    if (!value) {
      return '';
    }

    if (typeof value === 'string') {
      return value;
    }

    if (Array.isArray(value)) {
      return value
        .map((entry) => {
          if (!entry) {
            return '';
          }
          if (typeof entry === 'string') {
            return entry;
          }
          if (typeof entry === 'object' && 'text' in entry) {
            return (entry as { text?: string }).text ?? '';
          }
          return '';
        })
        .join('');
    }

    if (
      typeof value === 'object' &&
      'text' in (value as Record<string, unknown>)
    ) {
      return (value as { text?: string }).text ?? '';
    }

    return '';
  }

  private aggregateToolCalls(toolCalls: ToolCallDelta[]): void {
    for (const toolCall of toolCalls) {
      if (!toolCall) {
        continue;
      }

      const index =
        typeof toolCall.index === 'number' && toolCall.index >= 0
          ? toolCall.index
          : 0;

      if (
        !this.aggregatedToolCalls.has(index) &&
        this.aggregatedToolCalls.size >= MAX_TOOL_CALLS
      ) {
        continue;
      }

      const target = this.ensureToolCallSlot(index);

      if (toolCall.id) {
        target.id = this.appendString(target.id, toolCall.id);
      }
      if (toolCall.type) {
        target.type = toolCall.type;
      }
      if (toolCall.function) {
        const fn = target.function ?? { name: '', arguments: '' };
        fn.name = this.appendString(fn.name, toolCall.function.name);
        fn.arguments = this.appendString(
          fn.arguments,
          toolCall.function.arguments,
        );
        target.function = fn;
      }
    }
  }

  private aggregateFunctionCall(functionCall: FunctionCallDelta): void {
    if (!this.aggregatedFunctionCall) {
      this.aggregatedFunctionCall = {};
    }

    this.aggregatedFunctionCall.name = this.appendString(
      this.aggregatedFunctionCall.name,
      functionCall.name,
    );
    this.aggregatedFunctionCall.arguments = this.appendString(
      this.aggregatedFunctionCall.arguments,
      functionCall.arguments,
    );
  }

  private normalizeToolCalls(): ChatCompletionMessageToolCall[] {
    const sortedEntries = Array.from(this.aggregatedToolCalls.entries()).sort(
      (a, b) => a[0] - b[0],
    );

    const normalized: ChatCompletionMessageToolCall[] = [];

    for (const [, call] of sortedEntries) {
      const maybeCall = this.toMessageToolCall(call);
      if (maybeCall) {
        normalized.push(maybeCall);
      }
    }

    return normalized;
  }

  private ensureToolCallSlot(index: number): ToolCallDelta {
    let existing = this.aggregatedToolCalls.get(index);
    if (!existing) {
      existing = {
        index,
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
      };
      this.aggregatedToolCalls.set(index, existing);
      return existing;
    }

    if (!existing.function) {
      existing.function = { name: '', arguments: '' };
    } else {
      existing.function = {
        name: existing.function.name ?? '',
        arguments: existing.function.arguments ?? '',
      };
    }

    if (typeof existing.id !== 'string') {
      existing.id = '';
    }

    if (!existing.type) {
      existing.type = 'function';
    }

    return existing;
  }

  private toMessageToolCall(
    call: ToolCallDelta,
  ): ChatCompletionMessageToolCall | null {
    const id = typeof call.id === 'string' ? call.id : '';
    const fnName = call.function?.name ?? '';
    const fnArgs = call.function?.arguments ?? '';

    if (!id && !fnName && !fnArgs) {
      return null;
    }

    return {
      id,
      type: call.type ?? 'function',
      function: {
        name: fnName,
        arguments: fnArgs,
      },
    };
  }

  private appendString(
    existing: string | undefined,
    addition?: string,
  ): string {
    if (!addition) {
      return existing ?? '';
    }
    return `${existing ?? ''}${addition}`;
  }
}
