import { ChannelStreamAggregator } from '../utils/channelStreamAggregator';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessage,
  ChatCompletionMessageFunctionToolCall,
} from 'openai/resources/chat/completions';

type ChatCompletionMessageWithReasoning = ChatCompletionMessage & {
  reasoning_content?: string;
};

/**
 * Streaming aggregator for OpenAI-compatible reasoning models (DeepSeek,
 * Kimi, GLM, MiniMax). Despite the historical "Base" name it has no
 * subclasses; `ModelHandlerOpenAI.executeStreamingChat` instantiates it
 * directly when the reasoning aggregator is enabled.
 */
export class BaseReasoningStreamAggregator extends ChannelStreamAggregator {
  private lastChunkWithChoices: ChatCompletionChunk | undefined;
  private usageChunk: ChatCompletionChunk | undefined;

  appendContent(delta: string): void {
    this.pushContent(delta);
  }

  appendReasoning(delta: string): void {
    this.pushReasoning(delta);
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
        this.toolCalls.add({
          index: call.index,
          id: call.id,
          name: call.function?.name,
          arguments: call.function?.arguments,
        });
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

  private buildToolCalls(): ChatCompletionMessageFunctionToolCall[] {
    return this.toolCalls.build(({ id, name, arguments: args }) => ({
      id,
      type: 'function',
      function: { name, arguments: args },
    }));
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
