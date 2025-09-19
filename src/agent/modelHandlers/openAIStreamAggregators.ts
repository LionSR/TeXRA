// Standard library imports
// (none needed)

// Third-party imports
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessage,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

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

interface AggregatedToolCall
  extends Partial<Omit<ChatCompletionMessageToolCall, 'function'>> {
  index?: number;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface AggregatedFunctionCall {
  name: string;
  arguments: string;
}

/**
 * Shared aggregator for providers that do not emit a final completion payload.
 */
export class OpenAIStreamDeltaAggregator implements OpenAIStreamAggregator {
  private readonly contentParts: string[] = [];
  private readonly reasoningParts: string[] = [];
  private readonly aggregatedToolCalls: AggregatedToolCall[] = [];
  private aggregatedFunctionCall: AggregatedFunctionCall | null = null;
  private role: string | undefined;
  private lastChunk: ChatCompletionChunk | null = null;

  ingest(chunk: ChatCompletionChunk): StreamAggregatorDelta {
    this.lastChunk = chunk;

    const delta = chunk.choices?.[0]?.delta ?? {};
    const updates: StreamAggregatorDelta = {};

    if (delta && typeof delta === 'object' && 'role' in delta) {
      const maybeRole = (delta as { role?: unknown }).role;
      if (typeof maybeRole === 'string') {
        this.role = maybeRole;
      }
    }

    const reasoningDelta = this.collectText(
      (delta as { reasoning_content?: unknown }).reasoning_content,
    );
    if (reasoningDelta) {
      this.reasoningParts.push(reasoningDelta);
      updates.reasoningDelta = reasoningDelta;
    }

    const contentDelta = this.collectText(
      (delta as { content?: unknown }).content,
    );
    if (contentDelta) {
      this.contentParts.push(contentDelta);
      updates.contentDelta = contentDelta;
    }

    const toolCalls = (delta as { tool_calls?: unknown }).tool_calls;
    if (Array.isArray(toolCalls)) {
      this.aggregateToolCalls(toolCalls as AggregatedToolCall[]);
    }

    const functionCall = (delta as { function_call?: AggregatedFunctionCall })
      .function_call;
    if (functionCall) {
      this.aggregateFunctionCall(functionCall);
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
    const message: ChatCompletionMessage = {
      role: this.role ?? 'assistant',
      content: this.getAggregatedContent(),
    } as ChatCompletionMessage;

    const reasoning = this.getAggregatedReasoning();
    if (reasoning) {
      (
        message as unknown as ChatCompletionMessage & {
          reasoning_content?: string;
        }
      ).reasoning_content = reasoning;
    }

    const toolCalls = this.normalizeToolCalls();
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls as ChatCompletionMessageToolCall[];
    }

    if (this.aggregatedFunctionCall) {
      const { name, arguments: args } = this.aggregatedFunctionCall;
      if (name || args) {
        message.function_call = {
          name,
          arguments: args,
        };
      }
    }

    const response: ChatCompletion = {
      id: lastChunk?.id ?? 'stream-aggregated',
      object: 'chat.completion',
      created: lastChunk?.created ?? Math.floor(Date.now() / 1000),
      model: lastChunk?.model ?? '',
      system_fingerprint: lastChunk?.system_fingerprint,
      usage: lastChunk?.usage,
      choices: [
        {
          index: 0,
          message,
          finish_reason: lastChunk?.choices?.[0]?.finish_reason ?? undefined,
        },
      ],
    } as ChatCompletion;

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

    if (typeof value === 'object' && 'text' in (value as Record<string, unknown>)) {
      return (value as { text?: string }).text ?? '';
    }

    return '';
  }

  private aggregateToolCalls(toolCalls: AggregatedToolCall[]): void {
    for (const toolCall of toolCalls) {
      if (!toolCall) {
        continue;
      }

      const index =
        typeof toolCall.index === 'number' && toolCall.index >= 0
          ? toolCall.index
          : 0;

      while (this.aggregatedToolCalls.length <= index) {
        this.aggregatedToolCalls.push({
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        });
      }

      const target = this.aggregatedToolCalls[index];
      if (toolCall.id) {
        target.id = this.appendString(target.id, toolCall.id as string);
      }
      if (toolCall.type) {
        target.type = toolCall.type;
      }
      if (toolCall.function) {
        const fn = target.function ?? { name: '', arguments: '' };
        fn.name = this.appendString(fn.name, toolCall.function.name ?? '');
        fn.arguments = this.appendString(
          fn.arguments,
          toolCall.function.arguments ?? '',
        );
        target.function = fn;
      }
    }
  }

  private aggregateFunctionCall(functionCall: AggregatedFunctionCall): void {
    if (!this.aggregatedFunctionCall) {
      this.aggregatedFunctionCall = { name: '', arguments: '' };
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

  private normalizeToolCalls(): AggregatedToolCall[] {
    return this.aggregatedToolCalls.filter((call) => {
      const hasId = typeof call.id === 'string' && call.id.length > 0;
      const hasName =
        typeof call.function?.name === 'string' && call.function.name.length > 0;
      const hasArgs =
        typeof call.function?.arguments === 'string' &&
        call.function.arguments.length > 0;
      return hasId || hasName || hasArgs;
    });
  }

  private appendString(existing: string | undefined, addition: string): string {
    if (!addition) {
      return existing ?? '';
    }
    return `${existing ?? ''}${addition}`;
  }
}
