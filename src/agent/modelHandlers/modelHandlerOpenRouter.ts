// Third-party imports
import { OpenRouter } from '@openrouter/sdk';
import { isAssistantMessage } from 'openai/lib/chatCompletionUtils';

// Local imports - agent components
import type { ExtendedCompletionUsage } from '@agent/core/ResponseUsage';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { isNonEmptyString } from '@utils/core';

// Local file imports
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { OPENAI_CHAT_FINISH } from './types/StopReasonTypes';
import { executeRequest } from './utils/requestExecutor';
import type { CreateResponseOptions } from './types/IModelHandler';

// Third-party type imports
import type {
  ChatGenerationParams,
  ChatGenerationTokenUsage,
  ChatResponse,
  ChatStreamingResponseChunkData,
  Effort,
  Message,
  Schema3,
} from '@openrouter/sdk/esm/models/index.js';
import type OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

type ChatCompletionRequestBase = Omit<
  ChatCompletionCreateParamsStreaming,
  'stream' | 'stream_options'
>;

/**
 * OpenRouter reasoning_details array item types.
 * @see https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
 */
interface ReasoningDetailItem {
  type: 'reasoning.text' | 'reasoning.summary' | 'reasoning.encrypted';
  id?: string | null;
  format?: string;
  index?: number;
  text?: string; // for reasoning.text
  summary?: string; // for reasoning.summary
  data?: string; // for reasoning.encrypted
  signature?: string | null; // for reasoning.text
}

const extractTextFromReasoningDetails = (
  details: ReasoningDetailItem[] | Schema3[] | unknown,
): string => {
  if (!Array.isArray(details)) {
    if (typeof details === 'string') return details;
    return '';
  }

  const textParts: string[] = [];
  for (const item of details) {
    if (!item || typeof item !== 'object') continue;

    switch ((item as ReasoningDetailItem).type) {
      case 'reasoning.text':
        if ('text' in item && item.text) textParts.push(item.text);
        break;
      case 'reasoning.summary':
        if ('summary' in item && item.summary) textParts.push(item.summary);
        break;
      case 'reasoning.encrypted':
        break;
    }
  }

  return textParts.join('');
};

const extractOpenRouterReasoningDelta = (
  chunk: ChatStreamingResponseChunkData,
): string => {
  const choice = chunk.choices[0];
  if (!choice) return '';

  const delta = choice.delta;

  if (delta.reasoningDetails && delta.reasoningDetails.length > 0) {
    return extractTextFromReasoningDetails(delta.reasoningDetails);
  }

  if (delta.reasoning) {
    return delta.reasoning;
  }

  return '';
};

const toOpenRouterContent = (
  content: ChatCompletionMessageParam['content'],
): Message['content'] => {
  if (
    typeof content === 'string' ||
    content === undefined ||
    content === null
  ) {
    return content ?? '';
  }

  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== 'object' || !('type' in part)) {
        return part as unknown;
      }

      if (part.type === 'image_url' && 'image_url' in part) {
        return {
          type: part.type,
          imageUrl: part.image_url,
        } as unknown;
      }

      if (part.type === 'input_audio' && 'input_audio' in part) {
        return {
          type: part.type,
          inputAudio: part.input_audio,
        } as unknown;
      }

      return part as unknown;
    }) as Message['content'];
  }

  return content as Message['content'];
};

const mapToolCallsForRequest = (toolCalls?: ChatCompletionMessageToolCall[]) =>
  toolCalls
    ?.filter(
      (
        toolCall,
      ): toolCall is ChatCompletionMessageToolCall & { type: 'function' } =>
        toolCall.type === 'function',
    )
    .map((toolCall) => {
      const toolFunction = (
        toolCall as { function?: { name?: string; arguments?: string } }
      ).function;

      return {
        id: toolCall.id,
        type: 'function' as const,
        function: toolFunction,
      };
    });

const toOpenRouterMessages = (
  messages: ChatCompletionMessageParam[],
): Message[] => {
  const mappedMessages = messages.map((message) => {
    if (message.role === 'assistant') {
      const assistantMessage = message as {
        tool_calls?: ChatCompletionMessageToolCall[];
        content?: ChatCompletionMessageParam['content'];
      };
      return {
        role: 'assistant',
        content: toOpenRouterContent(assistantMessage.content),
        toolCalls: mapToolCallsForRequest(assistantMessage.tool_calls),
      };
    }

    if (message.role === 'tool') {
      const toolMessage = message as {
        tool_call_id?: string;
        content?: ChatCompletionMessageParam['content'];
      };
      return {
        role: 'tool',
        content: toOpenRouterContent(toolMessage.content),
        toolCallId: toolMessage.tool_call_id,
      };
    }

    return {
      role: message.role,
      content: toOpenRouterContent(message.content),
    } as Message;
  });

  return mappedMessages as Message[];
};

const toOpenAIToolCalls = (
  toolCalls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }> | null,
): ChatCompletionMessageToolCall[] =>
  (toolCalls ?? []).map((call, index) => ({
    id: call.id ?? `call_${index}`,
    type: 'function',
    function: {
      name: call.function?.name ?? '',
      arguments: call.function?.arguments ?? '',
    },
  }));

const toOpenAIUsage = (
  usage?: ChatGenerationTokenUsage | null,
): ExtendedCompletionUsage | null => {
  if (!usage) return null;

  const promptTokens = usage.promptTokens ?? 0;
  const completionTokens = usage.completionTokens ?? 0;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.totalTokens ?? promptTokens + completionTokens,
    prompt_tokens_details: usage.promptTokensDetails?.cachedTokens
      ? { cached_tokens: usage.promptTokensDetails.cachedTokens }
      : undefined,
    completion_tokens_details: usage.completionTokensDetails?.reasoningTokens
      ? { reasoning_tokens: usage.completionTokensDetails.reasoningTokens }
      : undefined,
    prompt_cache_hit_tokens: usage.promptTokensDetails?.cachedTokens,
  };
};

const extractContentText = (
  content: string | Array<{ type?: string; text?: string }> | null | undefined,
): string => {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content
    .map((item) => ('text' in item ? (item.text ?? '') : ''))
    .join('');
};

interface CompletionBuildOptions {
  id: string;
  created: number;
  model: string;
  finishReason: string | null | undefined;
  content: string;
  systemFingerprint?: string | null;
  toolCalls?: ChatCompletionMessageToolCall[];
  usage?: ExtendedCompletionUsage | null;
  reasoning?: string;
  reasoningDetails?: ReasoningDetailItem[] | Schema3[];
}

const buildChatCompletion = (
  options: CompletionBuildOptions,
): ChatCompletion => ({
  id: options.id,
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: options.content,
        tool_calls:
          options.toolCalls && options.toolCalls.length > 0
            ? options.toolCalls
            : undefined,
        reasoning: options.reasoning || undefined,
        reasoning_details:
          options.reasoningDetails && options.reasoningDetails.length > 0
            ? (options.reasoningDetails as ReasoningDetailItem[])
            : undefined,
      } as any,
      finish_reason: (options.finishReason ??
        OPENAI_CHAT_FINISH.STOP) as ChatCompletion['choices'][number]['finish_reason'],
      logprobs: null,
    },
  ],
  created: options.created,
  model: options.model,
  object: 'chat.completion',
  system_fingerprint: options.systemFingerprint ?? undefined,
  usage: options.usage ?? undefined,
});

const convertChatResponseToCompletion = (
  response: ChatResponse,
  modelFallback: string,
): ChatCompletion => {
  const choice = response.choices[0];
  if (!choice) {
    throw new Error('Invalid OpenRouter response: missing choices');
  }

  const assistantMessage = choice.message;
  const content = extractContentText(assistantMessage.content);
  const toolCalls = toOpenAIToolCalls(assistantMessage.toolCalls);
  const usage = toOpenAIUsage(response.usage);

  const reasoningDetails =
    choice.reasoningDetails && choice.reasoningDetails.length > 0
      ? choice.reasoningDetails
      : undefined;

  return buildChatCompletion({
    id: response.id,
    created: response.created,
    model: response.model ?? modelFallback,
    finishReason: choice.finishReason ?? OPENAI_CHAT_FINISH.STOP,
    content,
    toolCalls,
    systemFingerprint: response.systemFingerprint,
    usage,
    reasoning: assistantMessage.reasoning ?? undefined,
    reasoningDetails,
  });
};

const finalizeToolCallsFromStream = (
  buffer: Map<number, { id?: string; name?: string; args: string }>,
): ChatCompletionMessageToolCall[] =>
  Array.from(buffer.entries())
    .sort(([left], [right]) => left - right)
    .map(([index, call]) => ({
      id: call.id ?? `call_${index}`,
      type: 'function',
      function: {
        name: call.name ?? '',
        arguments: call.args,
      },
    }));

/**
 * Handler for models accessed through OpenRouter.
 */
export class ModelHandlerOpenRouter extends ModelHandlerOpenAI {
  protected override get usageProvider(): NormalizedUsage['provider'] {
    return 'openrouter';
  }

  /** Uses the native OpenRouter SDK client. */
  override async getClient(): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    const baseURL = this.getBaseUrl() ?? undefined;
    this.logger.debug(`Using OpenRouter API key. Base URL: ${baseURL}`);

    const client = new OpenRouter({
      apiKey,
      serverURL: baseURL,
      xTitle: 'TeXRA.ai',
    });

    return client as unknown as OpenAI;
  }

  /** Creates a response using OpenRouter's native SDK. */
  override async createResponse(
    options: CreateResponseOptions<ChatCompletionMessageParam, OpenAI>,
  ): Promise<ChatCompletion> {
    const {
      client,
      messages: rawMessages,
      temperature,
      systemPrompt,
      endTag,
      signal,
      tools,
    } = options;
    const useStreaming = this.getStreamingConfig();
    const normalizationOptions = this.getMessageNormalizationOptions();
    const messages = normalizationOptions
      ? this.prepareNormalizedMessages(
          rawMessages,
          normalizationOptions,
          'openrouter',
        )
      : rawMessages;

    const baseParams = this.buildChatBaseParams(
      messages,
      temperature,
      systemPrompt,
      endTag,
      tools,
    );
    const chatParams = this.buildChatParams(baseParams, useStreaming);
    const openRouterClient = client as unknown as OpenRouter;

    if (useStreaming) {
      const streamParams = { ...chatParams, stream: true as const };
      const stream = (await executeRequest(
        {
          model: this.config.name,
          operation: 'openrouter.chat.send.stream',
          signal,
        },
        () => openRouterClient.chat.send(streamParams, { signal }),
      )) as AsyncIterable<ChatStreamingResponseChunkData>;

      return this.consumeStreamingResponse(
        stream,
        streamParams,
        this.config.openrouterFullName ?? this.config.fullName,
      );
    }

    const response = await executeRequest(
      {
        model: this.config.name,
        operation: 'openrouter.chat.send',
        signal,
      },
      () =>
        openRouterClient.chat.send(
          { ...chatParams, stream: false as const },
          { signal },
        ),
    );

    return convertChatResponseToCompletion(
      response as ChatResponse,
      this.config.openrouterFullName ?? this.config.fullName,
    );
  }

  private buildChatParams(
    baseParams: ChatCompletionRequestBase,
    useStreaming: boolean,
  ): ChatGenerationParams {
    const maxTokens =
      (baseParams as { max_tokens?: number }).max_tokens ??
      (baseParams as { max_completion_tokens?: number })
        .max_completion_tokens ??
      this.config.maxOutputTokens;

    const reasoningEffort =
      (baseParams as { reasoning_effort?: string }).reasoning_effort ??
      this.capabilities.reasoningEffort;

    const effortValue = reasoningEffort
      ? (this.validateReasoningEffort(reasoningEffort) as Effort)
      : undefined;

    const params: ChatGenerationParams = {
      model: this.config.openrouterFullName ?? this.config.fullName,
      messages: toOpenRouterMessages(baseParams.messages ?? []),
      temperature: baseParams.temperature ?? undefined,
      stop: baseParams.stop,
      tools: baseParams.tools as ChatGenerationParams['tools'],
      toolChoice: (baseParams as { tool_choice?: unknown }).tool_choice,
      reasoning:
        this.capabilities.supportsReasoning && effortValue !== undefined
          ? { effort: effortValue }
          : this.capabilities.supportsReasoning
            ? { effort: undefined }
            : undefined,
      stream: useStreaming ? true : undefined,
      streamOptions: useStreaming ? { includeUsage: true } : undefined,
    };

    if (typeof maxTokens === 'number') {
      params.maxTokens = maxTokens;
      params.maxCompletionTokens = maxTokens;
    }

    return params;
  }

  private async consumeStreamingResponse(
    stream: AsyncIterable<ChatStreamingResponseChunkData>,
    params: ChatGenerationParams,
    modelFallback: string,
  ): Promise<ChatCompletion> {
    const thinkingStream = this.createThinkingStream();
    const outputStream = this.isOutputStreamingEnabled()
      ? this.createOutputStream()
      : undefined;

    let aggregatedContent = '';
    let aggregatedReasoning = '';
    let aggregatedUsage: ChatGenerationTokenUsage | null = null;
    let finishReason: string | null | undefined;
    let systemFingerprint: string | null | undefined;
    let responseId: string | undefined;
    let responseCreated: number | undefined;
    let responseModel: string | undefined;
    let reasoningDetails: ReasoningDetailItem[] | Schema3[] | undefined;

    const toolCallBuffer = new Map<
      number,
      { id?: string; name?: string; args: string }
    >();

    for await (const chunk of stream) {
      responseId = chunk.id ?? responseId;
      responseCreated = chunk.created ?? responseCreated;
      responseModel = chunk.model ?? responseModel;
      systemFingerprint = chunk.systemFingerprint ?? systemFingerprint;
      if (chunk.usage) {
        aggregatedUsage = chunk.usage;
      }

      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;
      if (typeof delta.content === 'string') {
        aggregatedContent += delta.content;
        outputStream?.append(delta.content);
      }

      const reasoningDelta = extractOpenRouterReasoningDelta(chunk);
      if (reasoningDelta) {
        aggregatedReasoning += reasoningDelta;
        thinkingStream.append(reasoningDelta);
      }

      if (delta.reasoningDetails && delta.reasoningDetails.length > 0) {
        reasoningDetails = delta.reasoningDetails as ReasoningDetailItem[];
      }

      if (Array.isArray(delta.toolCalls)) {
        for (const toolCall of delta.toolCalls) {
          const existing = toolCallBuffer.get(toolCall.index) ?? {
            args: '',
          };
          if (toolCall.id) existing.id = toolCall.id;
          if (toolCall.function?.name) existing.name = toolCall.function.name;
          if (toolCall.function?.arguments) {
            existing.args += toolCall.function.arguments;
          }
          toolCallBuffer.set(toolCall.index, existing);
        }
      }

      finishReason = choice.finishReason ?? finishReason;
    }

    thinkingStream.finalize(aggregatedReasoning || undefined);
    if (outputStream) {
      outputStream.finalize(aggregatedContent);
    }

    const usage = toOpenAIUsage(aggregatedUsage);
    const toolCalls = finalizeToolCallsFromStream(toolCallBuffer);

    return buildChatCompletion({
      id: responseId ?? `openrouter-${Date.now()}`,
      created: responseCreated ?? Math.floor(Date.now() / 1000),
      model: responseModel ?? params.model ?? modelFallback,
      finishReason: finishReason ?? OPENAI_CHAT_FINISH.STOP,
      content: aggregatedContent,
      systemFingerprint,
      toolCalls,
      usage,
      reasoning: aggregatedReasoning || undefined,
      reasoningDetails,
    });
  }

  /**
   * OpenRouter returns reasoning in different formats:
   * - reasoning_details: array of objects (OpenRouter normalized format, see ReasoningDetailItem)
   * - reasoning: string (simple format)
   *
   * @see https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
   */
  protected override extractReasoningFromMessage(
    message: Record<string, unknown> | undefined,
  ): string | null {
    const reasoningDetails = message?.reasoning_details;
    if (reasoningDetails) {
      const extracted = extractTextFromReasoningDetails(reasoningDetails);
      if (extracted) return extracted;
    }

    const reasoning = message?.reasoning;
    if (!reasoning) {
      return null;
    }
    if (isNonEmptyString(reasoning)) {
      return reasoning;
    }

    return null;
  }
}

/**
 * Handler for Anthropic models using OpenAI-compatible API via OpenRouter.
 */
export class ModelHandlerAnthropicViaOpenRouter extends ModelHandlerOpenRouter {
  updateMessageContentWithPrefill(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void {
    const lastMessage = messages.at(-1);
    if (isAssistantMessage(lastMessage)) {
      if (Array.isArray(lastMessage.content)) {
        const lastPart = lastMessage.content.at(-1);
        if (lastPart && 'text' in lastPart) {
          lastPart.text = bestConnector + newResponse;
        }
      } else if (typeof lastMessage.content === 'string') {
        lastMessage.content = [
          {
            type: 'text',
            text: workspaceState.assembly.accumulatedOutput,
          },
        ];
      }
    }
  }

  /** Updates message content for models with prefill support. */
  updateMessageContentWithoutPrefill(
    messages: any[],
    _bestConnector: string,
    _newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void {
    const lastMessage = messages.at(-1);
    if (lastMessage?.role === 'user' || lastMessage?.role === 'system') {
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: workspaceState.assembly.accumulatedOutput,
          },
        ],
      });
    }
  }
}
