// Type imports
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessage,
  ChatCompletionMessageFunctionToolCall,
} from 'openai/resources/chat/completions';

// Local imports
import type { StreamingAggregator } from './modelHandlerOpenAI';

type ChatCompletionMessageWithReasoning = ChatCompletionMessage & {
  reasoning_content?: string;
};

interface AggregatedToolCall {
  id: string;
  function: ChatCompletionMessageFunctionToolCall['function'];
}

/**
 * Base class for streaming aggregators that support reasoning models.
 * Used by DeepSeek, Kimi, and other OpenAI-compatible reasoning models.
 */
export class BaseReasoningStreamAggregator implements StreamingAggregator {
  private readonly contentParts: string[] = [];
  private readonly reasoningParts: string[] = [];
  private readonly toolCalls = new Map<number, AggregatedToolCall>();
  private lastChunkWithChoices: ChatCompletionChunk | undefined;
  private usageChunk: ChatCompletionChunk | undefined;

  appendContent(delta: string): void {
    if (delta) {
      this.contentParts.push(delta);
    }
  }

  appendReasoning(delta: string): void {
    if (delta) {
      this.reasoningParts.push(delta);
    }
  }

  consumeChunk(chunk: ChatCompletionChunk): void {
    if (chunk.choices.length > 0) {
      this.lastChunkWithChoices = chunk;
    }
    // Check root-level usage (OpenAI format with stream_options.include_usage)
    if (chunk.usage) {
      this.usageChunk = chunk;
    }

    const choice = chunk.choices[0];
    if (!choice) {
      return;
    }

    // Check choice-level usage (Kimi format - usage is inside the choice object)
    const choiceUsage = (choice as { usage?: ChatCompletionChunk['usage'] })
      .usage;
    if (choiceUsage && !this.usageChunk) {
      // Store as if it were root-level usage for consistency
      this.usageChunk = { ...chunk, usage: choiceUsage };
    }

    const { delta } = choice;

    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const existing = this.toolCalls.get(call.index) ?? {
          id: '',
          function: { name: '', arguments: '' },
        };
        if (call.id) {
          existing.id += call.id;
        }
        if (call.function?.name) {
          existing.function.name += call.function.name;
        }
        if (call.function?.arguments) {
          existing.function.arguments += call.function.arguments;
        }
        this.toolCalls.set(call.index, existing);
      }
    }
  }

  finalize(fallback?: ChatCompletion): ChatCompletion {
    const base = fallback ?? this.buildFallbackResponse();
    const primaryChoice = base.choices[0] ?? {
      index: 0,
      message: { role: 'assistant', content: '', refusal: null },
      finish_reason: 'stop',
      logprobs: null,
    };
    const fallbackMessage = primaryChoice.message;

    const mergedMessage: ChatCompletionMessageWithReasoning = {
      ...fallbackMessage,
      role: 'assistant',
      content: this.getFullContent(),
      refusal: fallbackMessage.refusal ?? null,
    };

    const reasoning = this.getFullReasoning();
    if (reasoning) {
      mergedMessage.reasoning_content = reasoning;
    }

    const toolCalls = this.buildToolCalls();
    if (toolCalls.length > 0) {
      mergedMessage.tool_calls = toolCalls;
    }

    const mergedChoice = {
      ...primaryChoice,
      index: primaryChoice.index ?? 0,
      message: mergedMessage,
      finish_reason: primaryChoice.finish_reason ?? 'stop',
      logprobs: primaryChoice.logprobs ?? null,
    };

    // Convert null to undefined to match ChatCompletion type (usage: CompletionUsage | undefined)
    const usage =
      base.usage ?? this.usageChunk?.usage ?? this.lastChunkWithChoices?.usage;

    return {
      ...base,
      choices: [mergedChoice],
      usage: usage ?? undefined,
    };
  }

  getFullContent(): string {
    return this.contentParts.join('');
  }

  getFullReasoning(): string {
    return this.reasoningParts.join('');
  }

  private buildToolCalls(): ChatCompletionMessageFunctionToolCall[] {
    const result: ChatCompletionMessageFunctionToolCall[] = [];
    for (const [callIndex, call] of this.toolCalls.entries()) {
      // Skip empty tool calls (no id, name, or arguments)
      if (!call.id && !call.function.name && !call.function.arguments) {
        continue;
      }
      result.push({
        id: call.id || `tool_call_${callIndex}`,
        type: 'function',
        function: {
          name: call.function.name,
          arguments: call.function.arguments,
        },
      });
    }
    return result;
  }

  private buildFallbackResponse(): ChatCompletion {
    const chunk = this.lastChunkWithChoices ?? this.usageChunk;
    const choice = chunk?.choices[0];

    return {
      id: chunk?.id ?? '',
      object: 'chat.completion',
      created: chunk?.created ?? Math.floor(Date.now() / 1000),
      model: chunk?.model ?? '',
      choices: [
        {
          index: choice?.index ?? 0,
          message: {
            role: 'assistant',
            content: this.getFullContent(),
            refusal: null,
          },
          finish_reason: choice?.finish_reason ?? 'stop',
          logprobs: choice?.logprobs ?? null,
        },
      ],
    };
  }
}
