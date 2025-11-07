// Third-party imports
import type {
  AssistantMessage,
  ChatCompletionFinishReason,
  ChatGenerationParams,
  ChatGenerationTokenUsage,
  ChatMessageContentItem,
  ChatMessageToolCall,
  ChatResponse,
  ChatResponseChoice,
  ChatStreamingMessageChunk,
  ChatStreamingMessageToolCall,
  ChatStreamingResponseChunkData,
  Message,
} from '@openrouter/sdk/models';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

// Local imports - agent components
import type { ExtendedCompletionUsage } from '@agent/core/ResponseUsage';

/** Converts OpenAI-style content parts to OpenRouter's message parts. */
function convertContentPart(part: any): ChatMessageContentItem {
  if (!part || typeof part !== 'object') {
    return { type: 'text', text: String(part ?? '') };
  }

  if (part.type === 'image_url') {
    const image = part.image_url ?? part.imageUrl ?? {};
    return {
      type: 'image_url',
      imageUrl: {
        url: image.url ?? '',
        detail: image.detail,
      },
    } as ChatMessageContentItem;
  }

  if (part.type === 'input_audio') {
    const audio = part.input_audio ?? part.inputAudio ?? {};
    return {
      type: 'input_audio',
      inputAudio: {
        data: audio.data ?? '',
        format: audio.format ?? 'wav',
      },
    } as ChatMessageContentItem;
  }

  if (part.type === 'text') {
    return { type: 'text', text: part.text ?? '' } as ChatMessageContentItem;
  }

  return {
    type: 'text',
    text: typeof part.text === 'string' ? part.text : JSON.stringify(part),
  } as ChatMessageContentItem;
}

/**
 * Normalize OpenAI chat message content into OpenRouter's expected format.
 */
function normalizeContent(
  content: ChatCompletionMessageParam['content'],
): string | ChatMessageContentItem[] {
  if (
    typeof content === 'string' ||
    content === null ||
    content === undefined
  ) {
    return content ?? '';
  }

  if (Array.isArray(content)) {
    return content.map((part) => convertContentPart(part));
  }

  return '';
}

function convertSystemContent(
  content: string | ChatMessageContentItem[],
): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
      .filter((text) => text.length > 0)
      .join('\n');
  }

  return '';
}

function convertToolCalls(
  toolCalls: any[] | undefined,
): ChatMessageToolCall[] | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return undefined;
  }

  return toolCalls.map((call) => ({
    id: call.id ?? '',
    type: 'function',
    function: {
      name: call.function?.name ?? '',
      arguments: call.function?.arguments ?? '',
    },
  }));
}

function convertFunctionCall(
  functionCall: any | undefined,
): ChatMessageToolCall[] | undefined {
  if (!functionCall) {
    return undefined;
  }

  return [
    {
      id: 'function_call',
      type: 'function',
      function: {
        name: functionCall.name ?? '',
        arguments: functionCall.arguments ?? '',
      },
    },
  ];
}

/**
 * Convert OpenAI-style chat messages into OpenRouter message objects.
 */
export function convertToOpenRouterMessages(
  messages: ChatCompletionMessageParam[],
): Message[] {
  return messages.map((message) => {
    const baseContent = normalizeContent(message.content);

    if (message.role === 'assistant') {
      const toolCalls = convertToolCalls((message as any).tool_calls);
      const functionCall = convertFunctionCall((message as any).function_call);
      const mergedToolCalls = toolCalls ?? functionCall;

      const assistantMessage: AssistantMessage = {
        role: 'assistant',
        content: baseContent,
      };

      if (mergedToolCalls) {
        assistantMessage.toolCalls = mergedToolCalls;
      }

      if ((message as any).reasoning) {
        assistantMessage.reasoning = (message as any).reasoning;
      }

      if ((message as any).refusal) {
        assistantMessage.refusal = (message as any).refusal;
      }

      if (typeof (message as any).name === 'string') {
        assistantMessage.name = (message as any).name;
      }

      return assistantMessage as Message;
    }

    if (message.role === 'tool') {
      return {
        role: 'tool',
        content: baseContent,
        toolCallId: (message as any).tool_call_id ?? '',
      } as Message;
    }

    if (message.role === 'system') {
      return {
        role: 'system',
        content: convertSystemContent(baseContent),
        name: (message as any).name,
      } as Message;
    }

    if (message.role === 'user') {
      return {
        role: 'user',
        content: baseContent,
        name: (message as any).name,
      } as Message;
    }

    return {
      role: message.role as Message['role'],
      content: baseContent,
    } as Message;
  });
}

/**
 * Convert OpenRouter assistant messages back into OpenAI-compatible structures.
 */
function convertAssistantMessageToOpenAI(
  message: AssistantMessage,
): Record<string, any> {
  const content = message.content;
  const openAIContent = Array.isArray(content)
    ? content.map((part) => {
        if (part.type === 'image_url') {
          return {
            type: 'image_url',
            image_url: part.imageUrl,
          };
        }
        if (part.type === 'input_audio') {
          return {
            type: 'input_audio',
            input_audio: part.inputAudio,
          };
        }
        return { type: 'text', text: part.text };
      })
    : (content ?? '');

  const openAIToolCalls = message.toolCalls?.map(
    (call: ChatMessageToolCall) => ({
      id: call.id ?? '',
      type: call.type ?? 'function',
      function: {
        name: call.function?.name ?? '',
        arguments: call.function?.arguments ?? '',
      },
    }),
  );

  return {
    role: 'assistant',
    content: openAIContent,
    ...(openAIToolCalls ? { tool_calls: openAIToolCalls } : {}),
    ...(message.reasoning ? { reasoning: message.reasoning } : {}),
    ...(message.refusal ? { refusal: message.refusal } : {}),
    ...(message.name ? { name: message.name } : {}),
  };
}

/**
 * Convert OpenRouter usage metrics into ExtendedCompletionUsage structures.
 */
export function mapOpenRouterUsage(
  usage?: ChatGenerationTokenUsage | null,
): ExtendedCompletionUsage | null {
  if (!usage) {
    return null;
  }

  const extended: ExtendedCompletionUsage = {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
  } as ExtendedCompletionUsage;

  if (usage.promptTokensDetails) {
    extended.prompt_tokens_details = {
      cached_tokens: usage.promptTokensDetails.cachedTokens ?? 0,
    };
    if (usage.promptTokensDetails.cachedTokens !== undefined) {
      extended.prompt_cache_hit_tokens = usage.promptTokensDetails.cachedTokens;
    }
  }

  if (usage.completionTokensDetails) {
    const details: NonNullable<
      ExtendedCompletionUsage['completion_tokens_details']
    > = {};

    if (usage.completionTokensDetails.reasoningTokens !== undefined) {
      details.reasoning_tokens = usage.completionTokensDetails.reasoningTokens;
    }

    if (
      usage.completionTokensDetails.acceptedPredictionTokens !== undefined &&
      usage.completionTokensDetails.acceptedPredictionTokens !== null
    ) {
      details.accepted_prediction_tokens =
        usage.completionTokensDetails.acceptedPredictionTokens;
    }

    if (
      usage.completionTokensDetails.rejectedPredictionTokens !== undefined &&
      usage.completionTokensDetails.rejectedPredictionTokens !== null
    ) {
      details.rejected_prediction_tokens =
        usage.completionTokensDetails.rejectedPredictionTokens;
    }

    if (Object.keys(details).length > 0) {
      extended.completion_tokens_details = details;
    }
  }

  return extended;
}

/**
 * Convert a ChatResponse from the OpenRouter SDK into an OpenAI-style response.
 */
export function convertChatResponseToOpenAI(
  response: ChatResponse,
): Record<string, any> {
  const usage = mapOpenRouterUsage(response.usage);

  return {
    id: response.id,
    object: response.object,
    created: response.created,
    model: response.model,
    system_fingerprint: response.systemFingerprint ?? undefined,
    choices: response.choices.map((choice: ChatResponseChoice) => ({
      index: choice.index,
      finish_reason: choice.finishReason ?? null,
      message: convertAssistantMessageToOpenAI(choice.message),
      ...(choice.logprobs ? { logprobs: choice.logprobs } : {}),
    })),
    ...(usage ? { usage } : {}),
  };
}

/** Internal accumulator state for streaming responses. */
export interface StreamAccumulator {
  contentParts: string[];
  reasoningParts: string[];
  toolCalls: Map<string, ChatMessageToolCall>;
  finishReason: ChatCompletionFinishReason | null;
  role?: ChatStreamingMessageChunk['role'];
  lastChunk?: ChatStreamingResponseChunkData;
}

/** Create a new accumulator for streaming events. */
export function createStreamAccumulator(): StreamAccumulator {
  return {
    contentParts: [],
    reasoningParts: [],
    toolCalls: new Map<string, ChatMessageToolCall>(),
    finishReason: null,
  };
}

function mergeToolCall(
  accumulator: StreamAccumulator,
  call: ChatMessageToolCall,
  index?: number,
): void {
  const key =
    index !== undefined
      ? String(index)
      : call.id && call.id.length > 0
        ? call.id
        : `${accumulator.toolCalls.size}`;
  const existing = accumulator.toolCalls.get(key);

  if (!existing) {
    accumulator.toolCalls.set(key, {
      id: call.id ?? '',
      type: 'function',
      function: {
        name: call.function?.name ?? '',
        arguments: call.function?.arguments ?? '',
      },
    });
    return;
  }

  if (!existing.id && call.id) {
    existing.id = call.id;
  }

  if (call.function?.name) {
    existing.function.name = call.function.name;
  }

  if (call.function?.arguments) {
    existing.function.arguments = `${existing.function.arguments ?? ''}${call.function.arguments}`;
  }
}

/**
 * Consume a streaming chunk and update the accumulator.
 */
export function consumeStreamChunk(
  accumulator: StreamAccumulator,
  chunk: ChatStreamingResponseChunkData,
): { contentDelta: string; reasoningDelta: string } {
  accumulator.lastChunk = chunk;

  const choice = chunk.choices?.[0];
  if (!choice) {
    return { contentDelta: '', reasoningDelta: '' };
  }

  if (choice.finishReason !== undefined && choice.finishReason !== null) {
    accumulator.finishReason = choice.finishReason;
  }

  const delta = choice.delta;
  if (!delta) {
    return { contentDelta: '', reasoningDelta: '' };
  }

  if (delta.role) {
    accumulator.role = delta.role;
  }

  const contentDelta = typeof delta.content === 'string' ? delta.content : '';
  if (contentDelta) {
    accumulator.contentParts.push(contentDelta);
  }

  const reasoningDelta =
    typeof delta.reasoning === 'string' ? delta.reasoning : '';
  if (reasoningDelta) {
    accumulator.reasoningParts.push(reasoningDelta);
  }

  if (Array.isArray(delta.toolCalls)) {
    delta.toolCalls.forEach((call: ChatStreamingMessageToolCall) =>
      mergeToolCall(
        accumulator,
        {
          id: call.id ?? '',
          type: call.type ?? 'function',
          function: {
            name: call.function?.name ?? '',
            arguments: call.function?.arguments ?? '',
          },
        },
        call.index,
      ),
    );
  }

  return { contentDelta, reasoningDelta };
}

/**
 * Finalize the accumulator into a ChatResponse object.
 */
export function finalizeStreamAccumulator(
  accumulator: StreamAccumulator,
  fallbackModel: string,
): ChatResponse {
  const lastChunk = accumulator.lastChunk;

  const assistantMessage: AssistantMessage = {
    role: 'assistant',
    content: accumulator.contentParts.join(''),
  };

  if (accumulator.role) {
    assistantMessage.role = 'assistant';
  }

  if (accumulator.reasoningParts.length > 0) {
    assistantMessage.reasoning = accumulator.reasoningParts.join('');
  }

  const toolCallValues = Array.from(accumulator.toolCalls.values());
  if (toolCallValues.length > 0) {
    assistantMessage.toolCalls = toolCallValues;
  }

  return {
    id: lastChunk?.id ?? `stream_${Date.now()}`,
    object: 'chat.completion',
    created: lastChunk?.created ?? Math.floor(Date.now() / 1000),
    model: lastChunk?.model ?? fallbackModel,
    systemFingerprint: lastChunk?.systemFingerprint,
    usage: lastChunk?.usage,
    choices: [
      {
        index: lastChunk?.choices?.[0]?.index ?? 0,
        finishReason: accumulator.finishReason,
        message: assistantMessage,
      },
    ],
  } satisfies ChatResponse;
}

/**
 * Build a ChatGenerationParams payload ready for the OpenRouter SDK.
 */
export function buildChatGenerationParams(
  params: Omit<ChatGenerationParams, 'messages'> & {
    messages: ChatCompletionMessageParam[];
  },
): ChatGenerationParams {
  const { messages, ...rest } = params;
  return {
    ...rest,
    messages: convertToOpenRouterMessages(messages),
  };
}
