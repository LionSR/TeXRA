import type { ChatGenerationParams } from '@openrouter/sdk/models/chatgenerationparams';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

// Local imports - agent components
import type { ExtendedCompletionUsage } from '@agent/core/ResponseUsage';

export interface OpenRouterToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenRouterBaseContentPart {
  type: string;
}

export interface OpenRouterTextContentPart extends OpenRouterBaseContentPart {
  type: 'text';
  text: string;
}

export interface OpenRouterImageContentPart extends OpenRouterBaseContentPart {
  type: 'image_url';
  imageUrl?: unknown;
}

export interface OpenRouterAudioContentPart extends OpenRouterBaseContentPart {
  type: 'input_audio';
  inputAudio?: unknown;
}

export type OpenRouterContentPart =
  | OpenRouterTextContentPart
  | OpenRouterImageContentPart
  | OpenRouterAudioContentPart
  | string;

type OpenRouterMessagesPayload = NonNullable<ChatGenerationParams['messages']>;

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | OpenRouterContentPart[];
  name?: string;
  toolCalls?: OpenRouterToolCall[];
  toolCallId?: string;
  reasoning?: unknown;
  refusal?: unknown;
}

export interface OpenRouterChoiceMessage {
  content?: unknown;
  toolCalls?: OpenRouterToolCall[];
  reasoning?: unknown;
  refusal?: unknown;
  name?: string;
}

export interface OpenRouterChoice {
  index?: number;
  finishReason?: string | null;
  logprobs?: unknown;
  message?: OpenRouterChoiceMessage;
}

export interface OpenRouterChatResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  systemFingerprint?: string | null;
  choices?: OpenRouterChoice[];
  usage?: Record<string, any>;
}

function toOpenRouterText(text: unknown): OpenRouterTextContentPart {
  return { type: 'text', text: typeof text === 'string' ? text : '' };
}

function convertStructuredPart(
  part: Record<string, unknown>,
): OpenRouterContentPart {
  if (part.type === 'text') {
    return toOpenRouterText(part.text);
  }

  if (part.type === 'image_url') {
    const payload =
      (part as { imageUrl?: unknown }).imageUrl ??
      (part as { image_url?: unknown }).image_url;
    return {
      type: 'image_url',
      imageUrl: payload,
    } satisfies OpenRouterImageContentPart;
  }

  if (part.type === 'input_audio') {
    const payload =
      (part as { inputAudio?: unknown }).inputAudio ??
      (part as { input_audio?: unknown }).input_audio;
    return {
      type: 'input_audio',
      inputAudio: payload,
    } satisfies OpenRouterAudioContentPart;
  }

  return toOpenRouterText((part as { text?: string }).text);
}

/**
 * Converts OpenAI-style message content into the OpenRouter representation.
 */
function convertContent(
  content: ChatCompletionMessageParam['content'],
): string | OpenRouterContentPart[] {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content.map((part) =>
    convertStructuredPart(part as Record<string, unknown>),
  );
}

export function convertMessagesToOpenRouter(
  messages: ChatCompletionMessageParam[],
): OpenRouterMessagesPayload {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      const payload: OpenRouterMessage = {
        role: 'assistant',
        content: convertContent(message.content),
      };

      const toolCalls = (message as any).tool_calls;
      if (Array.isArray(toolCalls)) {
        payload.toolCalls = toolCalls.map(
          (call: any): OpenRouterToolCall => ({
            id: call.id ?? '',
            type: 'function',
            function: {
              name: call.function?.name ?? '',
              arguments: call.function?.arguments ?? '',
            },
          }),
        );
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

    const base: OpenRouterMessage = {
      role: message.role,
      content: convertContent(message.content),
    };

    if (typeof (message as any).name === 'string') {
      base.name = (message as any).name;
    }

    return base;
  }) as OpenRouterMessagesPayload;
}

/**
 * Converts OpenRouter message content back into OpenAI-compatible parts.
 */
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

  return content.map((part: OpenRouterContentPart) => {
    if (typeof part === 'string') {
      return { type: 'text', text: part };
    }

    if (part.type === 'text') {
      return { type: 'text', text: part.text ?? '' };
    }

    if (part.type === 'image_url') {
      return {
        type: 'image_url',
        image_url: (part as OpenRouterImageContentPart).imageUrl,
      };
    }

    if (part.type === 'input_audio') {
      return {
        type: 'input_audio',
        input_audio: (part as OpenRouterAudioContentPart).inputAudio,
      };
    }

    return { type: 'text', text: '' };
  });
}

/**
 * Maps OpenRouter usage statistics into the OpenAI extended usage structure.
 */
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
    choices: (response.choices ?? []).map((choice) => {
      const message = choice.message ?? {};
      const toolCalls = Array.isArray(message.toolCalls)
        ? message.toolCalls.map((call) => ({
            id: call.id ?? '',
            type: call.type ?? 'function',
            function: {
              name: call.function?.name ?? '',
              arguments: call.function?.arguments ?? '',
            },
          }))
        : undefined;

      return {
        index: choice.index,
        finish_reason: choice.finishReason ?? null,
        message: {
          role: 'assistant',
          content: toOpenAIContent(message.content),
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
          ...(message.reasoning ? { reasoning: message.reasoning } : {}),
          ...(message.refusal ? { refusal: message.refusal } : {}),
          ...(message.name ? { name: message.name } : {}),
        },
        ...(choice.logprobs ? { logprobs: choice.logprobs } : {}),
      };
    }),
    ...(usage ? { usage } : {}),
  };
}

export interface StreamState {
  content: string[];
  reasoning: string[];
  toolCalls: Map<string, OpenRouterToolCall>;
  toolCallCounter: number;
  lastChunk?: any;
  finishReason?: string | null;
}

export function createStreamState(): StreamState {
  return {
    content: [],
    reasoning: [],
    toolCalls: new Map(),
    toolCallCounter: 0,
  };
}

function keyForCall(state: StreamState, call: any): string {
  if (call.index !== undefined) {
    return String(call.index);
  }
  if (call.id) {
    return call.id;
  }
  state.toolCallCounter += 1;
  return `generated-${state.toolCallCounter}`;
}

/**
 * Accumulates a streaming chunk from the OpenRouter SDK into an intermediate state.
 */
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
      const key = keyForCall(state, call);
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

/**
 * Creates a synthetic ChatResponse from the aggregated streaming state.
 */
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
