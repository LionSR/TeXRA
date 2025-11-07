import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

// Local imports - agent components
import type { ExtendedCompletionUsage } from '@agent/core/ResponseUsage';

export type OpenRouterMessage = Record<string, unknown>;
export type OpenRouterChatResponse = Record<string, any>;

export function convertMessagesToOpenRouter(
  messages: ChatCompletionMessageParam[],
): OpenRouterMessage[] {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      const payload: Record<string, unknown> = {
        role: 'assistant',
        content: message.content ?? '',
      };

      const toolCalls = (message as any).tool_calls;
      if (Array.isArray(toolCalls)) {
        payload.toolCalls = toolCalls.map((call: any) => ({
          id: call.id ?? '',
          type: 'function',
          function: {
            name: call.function?.name ?? '',
            arguments: call.function?.arguments ?? '',
          },
        }));
      }

      if ((message as any).reasoning) {
        payload.reasoning = (message as any).reasoning;
      }

      if ((message as any).refusal) {
        payload.refusal = (message as any).refusal;
      }

      if (typeof (message as any).name === 'string') {
        payload.name = (message as any).name;
      }

      return payload;
    }

    if (message.role === 'tool') {
      return {
        role: 'tool',
        content:
          typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content ?? ''),
        toolCallId: (message as any).tool_call_id ?? '',
      } satisfies OpenRouterMessage;
    }

    const base: Record<string, unknown> = {
      role: message.role,
      content: message.content ?? '',
    };

    if (typeof (message as any).name === 'string') {
      base.name = (message as any).name;
    }

    return base;
  });
}

function toOpenAIContent(content: any): ChatCompletionMessageParam['content'] {
  if (
    typeof content === 'string' ||
    content === null ||
    content === undefined
  ) {
    return content ?? '';
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content.map((part: any) => {
    if (part?.type === 'text') {
      return { type: 'text', text: part.text ?? '' };
    }

    if (part?.type === 'image_url') {
      return { type: 'image_url', image_url: part.imageUrl ?? part.image_url };
    }

    if (part?.type === 'input_audio') {
      return {
        type: 'input_audio',
        input_audio: part.inputAudio ?? part.input_audio,
      };
    }

    return { type: 'text', text: '' };
  });
}

function mapUsage(usage: any): ExtendedCompletionUsage | null {
  if (!usage) {
    return null;
  }

  const extended: ExtendedCompletionUsage = {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
  } as ExtendedCompletionUsage;

  if (usage.promptTokensDetails?.cachedTokens !== undefined) {
    extended.prompt_tokens_details = {
      cached_tokens: usage.promptTokensDetails.cachedTokens ?? 0,
    };
    extended.prompt_cache_hit_tokens =
      usage.promptTokensDetails.cachedTokens ?? undefined;
  }

  if (usage.completionTokensDetails) {
    const details: NonNullable<
      ExtendedCompletionUsage['completion_tokens_details']
    > = {};

    if (usage.completionTokensDetails.reasoningTokens !== undefined) {
      details.reasoning_tokens = usage.completionTokensDetails.reasoningTokens;
    }

    if (usage.completionTokensDetails.acceptedPredictionTokens !== undefined) {
      details.accepted_prediction_tokens =
        usage.completionTokensDetails.acceptedPredictionTokens ?? undefined;
    }

    if (usage.completionTokensDetails.rejectedPredictionTokens !== undefined) {
      details.rejected_prediction_tokens =
        usage.completionTokensDetails.rejectedPredictionTokens ?? undefined;
    }

    if (Object.keys(details).length > 0) {
      extended.completion_tokens_details = details;
    }
  }

  return extended;
}

export function convertChatResponseToOpenAI(
  response: OpenRouterChatResponse,
): Record<string, any> {
  const usage = mapUsage(response.usage);

  return {
    id: response.id,
    object: response.object,
    created: response.created,
    model: response.model,
    system_fingerprint: response.systemFingerprint ?? undefined,
    choices: (response.choices ?? []).map((choice: any) => ({
      index: choice.index,
      finish_reason: choice.finishReason ?? null,
      message: {
        role: 'assistant',
        content: toOpenAIContent(choice.message?.content),
        ...(Array.isArray(choice.message?.toolCalls)
          ? {
              tool_calls: choice.message.toolCalls.map((call: any) => ({
                id: call.id ?? '',
                type: call.type ?? 'function',
                function: {
                  name: call.function?.name ?? '',
                  arguments: call.function?.arguments ?? '',
                },
              })),
            }
          : {}),
        ...(choice.message?.reasoning
          ? { reasoning: choice.message.reasoning }
          : {}),
        ...(choice.message?.refusal ? { refusal: choice.message.refusal } : {}),
        ...(choice.message?.name ? { name: choice.message.name } : {}),
      },
      ...(choice.logprobs ? { logprobs: choice.logprobs } : {}),
    })),
    ...(usage ? { usage } : {}),
  };
}

export interface StreamState {
  content: string[];
  reasoning: string[];
  toolCalls: Map<
    string,
    { id: string; type: string; function: { name: string; arguments: string } }
  >;
  lastChunk?: any;
  finishReason?: string | null;
}

export function createStreamState(): StreamState {
  return {
    content: [],
    reasoning: [],
    toolCalls: new Map(),
  };
}

function keyForCall(call: any): string {
  if (call.index !== undefined) {
    return String(call.index);
  }
  if (call.id) {
    return call.id;
  }
  return `${Date.now()}-${Math.random()}`;
}

export function accumulateStreamChunk(
  state: StreamState,
  chunk: any,
): { content: string; reasoning: string } {
  state.lastChunk = chunk;

  const choice = chunk?.choices?.[0];
  if (!choice) {
    return { content: '', reasoning: '' };
  }

  if (choice.finishReason !== undefined) {
    state.finishReason = choice.finishReason;
  }

  const delta = choice.delta ?? {};
  const content = typeof delta.content === 'string' ? delta.content : '';
  if (content) {
    state.content.push(content);
  }

  const reasoning = typeof delta.reasoning === 'string' ? delta.reasoning : '';
  if (reasoning) {
    state.reasoning.push(reasoning);
  }

  if (Array.isArray(delta.toolCalls)) {
    for (const call of delta.toolCalls) {
      const key = keyForCall(call);
      const existing = state.toolCalls.get(key);
      if (!existing) {
        state.toolCalls.set(key, {
          id: call.id ?? '',
          type: call.type ?? 'function',
          function: {
            name: call.function?.name ?? '',
            arguments: call.function?.arguments ?? '',
          },
        });
        continue;
      }

      if (call.function?.name) {
        existing.function.name = call.function.name;
      }

      if (call.function?.arguments) {
        existing.function.arguments = `${existing.function.arguments ?? ''}${call.function.arguments}`;
      }
    }
  }

  return { content, reasoning };
}

export function finalizeStream(
  state: StreamState,
  fallbackModel: string,
): OpenRouterChatResponse {
  const last = state.lastChunk ?? {};
  const toolCalls = Array.from(state.toolCalls.values());

  return {
    id: last.id ?? `stream_${Date.now()}`,
    object: 'chat.completion',
    created: last.created ?? Math.floor(Date.now() / 1000),
    model: last.model ?? fallbackModel,
    systemFingerprint: last.systemFingerprint,
    usage: last.usage,
    choices: [
      {
        index: last.choices?.[0]?.index ?? 0,
        finishReason: state.finishReason ?? null,
        message: {
          role: 'assistant',
          content: state.content.join(''),
          ...(state.reasoning.length > 0
            ? { reasoning: state.reasoning.join('') }
            : {}),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        },
      },
    ],
  };
}
