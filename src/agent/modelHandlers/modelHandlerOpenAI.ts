// Third-party imports
import OpenAI from 'openai';

// Local imports - core utilities
import {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionContentPartInputAudio,
  ChatCompletionAssistantMessageParam,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionToolMessageParam,
  ChatCompletionStreamParams,
} from 'openai/resources/chat/completions';
import { isAssistantMessage } from 'openai/lib/chatCompletionUtils';

// Local imports - agent components
import type { AgentConfig } from '@agent/core/AgentConfig';
// Internal imports
import { AgentSetting, hasEndTag } from '@agent/core/AgentDataclass';
import {
  OpenAIAPIResponseUsage,
  ExtendedCompletionUsage,
} from '@agent/core/ResponseUsage';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { MediaEntry } from '@agent/utils/mediaTypes';
import { calculateTokenPrice } from '@agent/utils/priceUtils';
import {
  getSdkErrorMessage,
  isContextWindowError,
  isMissingFinishReasonError,
} from '@common/errors/sdkErrorUtils';

// Type imports
import type { ToolDefinition } from '@model';

// Internal imports
import type { ToolFileAttachment } from '@tools/result';
import { isNonEmptyString } from '@utils/core';
import type { FileLocation } from '@utils/files';
import { K_SLICE, MESSAGE_PREVIEW_LENGTH } from '@utils/config';
import { flexibleFS } from '@utils/files';
import { objectToLogString } from '@utils/text/stringUtils';
import {
  computeCachePercentage,
  nonZeroOrUndefined,
} from './utils/usageNormalization';
import { prepareExistingOutputContent } from './utils/fileContentUtils';
import { DEFAULT_SUMMARY_PROMPT } from './contextCompaction/compactionPrompt';
import { compactOpenAICompatible } from './contextCompaction/openaiCompatibleCompaction';

// Local file imports
import { OPENAI_CHAT_FINISH } from './types/StopReasonTypes';
import {
  normalizeOpenAIMessageContent,
  NormalizeOpenAIMessageContentOptions,
} from './openAIMessageUtils';
import { toOpenAITools } from './toolConversion';
import {
  formatAttachmentSummary,
  formatToolResultAsText,
  type ToolResultPayload,
} from './utils/toolAttachmentUtils';
import { ModelHandler } from './ModelHandler';
import type {
  CreateResponseOptions,
  ExtractResponseResult,
  DeepSeekToolCall,
  OpenAIToolCall,
} from './types/IModelHandler';

// Type imports
import type { ProviderStopReason } from './types/StopReasonTypes';
import type { ContentDeltaEvent } from 'openai/lib/ChatCompletionStream';

type ChatCompletionRequestBase = Omit<
  ChatCompletionCreateParamsStreaming,
  'stream' | 'stream_options'
>;

// Reasoning content type for DeepSeek, o1 models (not in SDK)
type ReasoningContent = string | Array<{ type: string; text?: string }>;

function extractReasoningText(content: ReasoningContent | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content.map((item) => item.text ?? '').join('');
}

const DEEPSEEK_OFFICIAL_API_MAX_TOKENS = 8192;

export interface StreamingAggregator {
  appendContent(delta: string): void;
  appendReasoning(delta: string): void;
  consumeChunk(chunk: ChatCompletionChunk): void;
  finalize(fallback?: ChatCompletion): ChatCompletion;
}

export function extractReasoningDelta(chunk: ChatCompletionChunk): string {
  const delta = chunk.choices[0]?.delta as
    | { reasoning_content?: ReasoningContent }
    | undefined;
  if (!delta || !('reasoning_content' in delta)) return '';
  return extractReasoningText(delta.reasoning_content);
}

/**
 * OpenAI-specific handlers.
 */
export class ModelHandlerOpenAI<
  TCall extends OpenAIToolCall | DeepSeekToolCall = OpenAIToolCall,
> extends ModelHandler<
  ChatCompletionMessageParam,
  ExtendedCompletionUsage | null,
  OpenAIAPIResponseUsage,
  TCall,
  OpenAI,
  ChatCompletion
> {
  /**
   * Creates a new OpenAI client using the stored credentials.
   * Handles API key retrieval, base URL resolution, and logging.
   * @param providerName Optional name used for logging purposes
   */
  protected async createOpenAIClient(
    providerName: string = this.config.provider,
  ): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    const baseURL = this.getBaseUrl();
    this.logger.debug(`Using ${providerName} API key. Base URL: ${baseURL}`);
    // there is a time out parameter that can be set; default is 10 minutes
    return new OpenAI({ apiKey, baseURL });
  }

  /** Returns OpenAI client with configured API key. */
  async getClient(): Promise<OpenAI> {
    return this.createOpenAIClient();
  }

  /**
   * Allows subclasses to provide a streaming aggregator implementation.
   */
  protected createStreamingAggregator(): StreamingAggregator | null {
    return null;
  }

  /**
   * Returns the thinking parameter for models that support the thinking API.
   * Used by Kimi K2.5 and DeepSeek models which use `thinking: {type: "enabled"|"disabled"}`.
   *
   * Override in subclasses to enable/disable thinking mode explicitly.
   * @returns The thinking parameter object, or undefined to not send the parameter.
   */
  protected getThinkingParameter():
    | { type: 'enabled' | 'disabled' }
    | undefined {
    return undefined;
  }

  protected buildChatBaseParams(
    messages: ChatCompletionMessageParam[],
    temperature?: number,
    systemPrompt?: string,
    endTag?: string,
    tools?: ToolDefinition[],
  ): ChatCompletionRequestBase {
    const baseParams: ChatCompletionRequestBase = {
      model: this.config.fullName,
      messages,
      ...(this.isOReasoningModel
        ? { max_completion_tokens: this.config.maxOutputTokens }
        : { max_tokens: this.config.maxOutputTokens }),
    };

    if (!this.isOReasoningModel && !this.isGrokReasoningModel) {
      if (endTag) {
        baseParams.stop = [endTag];
      }
      baseParams.temperature = temperature;
    }

    const reasoningEffort = this.getEffectiveReasoningEffort();
    if (this.capabilities.supportsReasoning && reasoningEffort) {
      baseParams.reasoning_effort = this.validateReasoningEffort(
        reasoningEffort,
      ) as ChatCompletionRequestBase['reasoning_effort'];
    }

    // Add thinking parameter if specified by subclass (Kimi K2.5, DeepSeek)
    const thinking = this.getThinkingParameter();
    if (thinking) {
      (baseParams as Record<string, unknown>).thinking = thinking;
    }

    if (tools && tools.length > 0) {
      baseParams.parallel_tool_calls = false;
      baseParams.tools = toOpenAITools(tools);
      baseParams.tool_choice = 'auto';
    }

    if (
      this.config.fullName === 'deepseek-chat' &&
      !this.capabilities.supportsReasoning
    ) {
      this.logger.debug(
        `Setting max_tokens to ${DEEPSEEK_OFFICIAL_API_MAX_TOKENS} for DeepSeek-chat models from the official api`,
      );
      baseParams.max_tokens = DEEPSEEK_OFFICIAL_API_MAX_TOKENS;
    }

    return baseParams;
  }

  protected stripTrailingToolCallsForCompaction(
    messages: ChatCompletionMessageParam[],
  ): ChatCompletionMessageParam[] {
    const cleaned = [...messages];
    const lastMessage = cleaned.at(-1);
    if (!lastMessage || lastMessage.role !== 'assistant') {
      return cleaned;
    }

    if (!('tool_calls' in lastMessage)) {
      return cleaned;
    }

    const content = lastMessage.content;
    const hasContent = Array.isArray(content)
      ? content.length > 0
      : Boolean(content?.trim());

    if (hasContent) {
      const { tool_calls: _toolCalls, ...rest } = lastMessage;
      cleaned[cleaned.length - 1] = rest as ChatCompletionMessageParam;
      return cleaned;
    }

    cleaned.pop();
    return cleaned;
  }

  protected finalizeStreams(
    thinking: ReturnType<ModelHandler['createThinkingStream']>,
    output: ReturnType<ModelHandler['createOutputStream']> | undefined,
    finalResponse: ChatCompletion,
  ): void {
    const finalReasoning = this.processThinkingBlock(finalResponse);
    thinking.finalize(finalReasoning ?? undefined);

    const finalOutput = finalResponse.choices?.[0]?.message?.content ?? '';
    output?.finalize(finalOutput);
  }

  protected async executeStreamingChat(
    client: OpenAI,
    baseParams: ChatCompletionRequestBase,
    signal?: AbortSignal,
  ): Promise<ChatCompletion> {
    const thinking = this.createThinkingStream();
    const output = this.isOutputStreamingEnabled()
      ? this.createOutputStream()
      : undefined;

    const streamParams: ChatCompletionStreamParams = {
      ...baseParams,
      stream: true,
      stream_options: { include_usage: true },
    };

    const stream = await client.chat.completions.stream(streamParams, {
      signal,
    });
    const streamingAggregator = this.createStreamingAggregator();

    const onContentDelta = ({ delta }: ContentDeltaEvent): void => {
      if (!delta) {
        return;
      }
      output?.append(delta);
      streamingAggregator?.appendContent(delta);
    };

    const onChunk = (chunk: ChatCompletionChunk): void => {
      streamingAggregator?.consumeChunk(chunk);
      const reasoningDelta = extractReasoningDelta(chunk);
      if (reasoningDelta) {
        thinking.append(reasoningDelta);
        streamingAggregator?.appendReasoning(reasoningDelta);
      }
    };

    stream.on('content.delta', onContentDelta);
    stream.on('chunk', onChunk);

    const cleanup = (): void => {
      stream.off('content.delta', onContentDelta);
      stream.off('chunk', onChunk);
    };

    try {
      let finalResponse = await this.awaitFinalResponse(
        stream,
        streamingAggregator,
      );

      // Ensure usage is captured - use SDK's totalUsage() as fallback
      if (!finalResponse.usage) {
        try {
          const totalUsage = await stream.totalUsage();
          finalResponse = { ...finalResponse, usage: totalUsage };
        } catch (_err) {
          // totalUsage() may fail if stream ended abnormally
        }
      }

      this.finalizeStreams(thinking, output ?? undefined, finalResponse);
      return finalResponse;
    } finally {
      cleanup();
    }
  }

  protected async executeNonStreamingChat(
    client: OpenAI,
    baseParams: ChatCompletionRequestBase,
    signal?: AbortSignal,
  ): Promise<ChatCompletion> {
    return client.chat.completions.create(
      {
        ...baseParams,
        stream: false,
      },
      { signal },
    );
  }

  /**
   * Awaits the final chat completion from a stream, with fallback handling
   * for providers that don't send finish_reason (e.g., DeepSeek, Kimi).
   *
   * When the SDK throws "missing finish_reason", falls back to using the
   * streaming aggregator to build a valid response from accumulated chunks.
   *
   * @param stream - The OpenAI chat completion stream
   * @param aggregator - Optional streaming aggregator for fallback
   * @returns The final ChatCompletion response
   */
  protected async awaitFinalResponse(
    stream: ReturnType<typeof OpenAI.prototype.chat.completions.stream>,
    aggregator: StreamingAggregator | null,
  ): Promise<ChatCompletion> {
    try {
      const sdkFinalResponse = await stream.finalChatCompletion();
      return aggregator
        ? aggregator.finalize(sdkFinalResponse)
        : sdkFinalResponse;
    } catch (err) {
      // Handle missing finish_reason error from OpenAI SDK
      // This can occur with DeepSeek reasoning models and other providers
      // that don't properly send finish_reason in streaming responses
      // @see https://github.com/openai/openai-node/issues/499
      if (aggregator && isMissingFinishReasonError(err)) {
        this.logger.warn(
          'Stream missing finish_reason - using aggregator fallback',
        );
        // Use aggregator without SDK response - it defaults finish_reason to 'stop'
        return aggregator.finalize();
      }
      throw err;
    }
  }

  /**
   * Returns message normalization options for this handler.
   * Subclasses can override to specify provider-specific normalization
   * (e.g., convertContentToString, mergeConsecutiveRoles) without
   * overriding the entire createResponse method.
   *
   * @returns Normalization options, or undefined to skip normalization
   */
  protected getMessageNormalizationOptions():
    | NormalizeOpenAIMessageContentOptions
    | undefined {
    return undefined; // Default: no normalization
  }

  /** Creates a chat completion with model-specific parameters. */
  async createResponse(
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
      compaction,
    } = options;

    // Apply message normalization if subclass specifies options
    const normOptions = this.getMessageNormalizationOptions();
    const messages = normOptions
      ? this.prepareNormalizedMessages(rawMessages, normOptions)
      : rawMessages;

    const { effectiveMessages } = await this.maybeApplyCompaction(
      messages,
      compaction,
      {
        contextWindow: this.config.contextWindow,
        getTokenCount: (messagesToCount) =>
          this.estimateTokenCount(messagesToCount, {
            client,
            systemPrompt,
            signal,
            tools,
          }),
        buildSummarySourceMessages: (
          messagesToCompact,
          systemCount,
          tailStart,
        ) =>
          this.stripTrailingToolCallsForCompaction(
            messagesToCompact.slice(systemCount, tailStart),
          ),
        createSummary: async (summarySourceMessages, compactionModel) => {
          const compactionResult = await compactOpenAICompatible(
            client,
            summarySourceMessages,
            compactionModel,
            DEFAULT_SUMMARY_PROMPT,
          );
          return compactionResult.summary;
        },
      },
    );

    // Phase 1: BUILD - Construct provider-specific request parameters
    const useStreaming = this.getStreamingConfig();
    const baseParams = this.buildChatBaseParams(
      effectiveMessages,
      temperature,
      systemPrompt,
      endTag,
      tools,
    );

    // Phase 2: COUNT - Estimate input tokens if handler supports it
    // Phase 3: VALIDATE - Adjust max_tokens if needed
    if (this.supportsTokenCounting) {
      try {
        const inputTokens = await this.estimateTokenCount(effectiveMessages, {
          client,
          systemPrompt,
          signal,
        });

        // Validate and adjust max_tokens if needed (throws if context window exceeded)
        const maxTokensKey = this.isOReasoningModel
          ? 'max_completion_tokens'
          : 'max_tokens';
        const currentMaxTokens = (baseParams as Record<string, unknown>)[
          maxTokensKey
        ] as number;
        const validation = this.validateTokenLimits(
          inputTokens,
          currentMaxTokens,
          this.config.contextWindow,
        );

        if (validation.adjustedMaxTokens !== currentMaxTokens) {
          this.logger.logContextManagement(
            `Token count (${inputTokens}) + ${maxTokensKey} (${currentMaxTokens}) exceeds context window (${this.config.contextWindow}). Reducing to ${validation.adjustedMaxTokens}.`,
            {
              action: 'max_tokens_reduced',
              tokensBefore: inputTokens,
              contextWindow: this.config.contextWindow,
              utilizationBefore:
                validation.utilizationPercent ??
                (inputTokens / this.config.contextWindow) * 100,
              originalMaxTokens: currentMaxTokens,
              reducedMaxTokens: validation.adjustedMaxTokens,
              details: `OpenAI: ${maxTokensKey} reduced to fit context window`,
            },
          );
          (baseParams as Record<string, unknown>)[maxTokensKey] =
            validation.adjustedMaxTokens;
        }
      } catch (err) {
        if (isContextWindowError(err)) throw err;
        this.logger.warn(
          `Token counting failed: ${getSdkErrorMessage(err)}. Proceeding without token adjustment.`,
        );
      }
    }

    // Phase 4: EXECUTE
    if (useStreaming) {
      return this.executeStreamingChat(client, baseParams, signal);
    }

    return this.executeNonStreamingChat(client, baseParams, signal);
  }

  /**
   * Normalizes OpenAI chat messages based on provided options.
   * Subclasses can opt-in by passing normalization settings.
   */
  protected normalizeMessages<T extends ChatCompletionMessageParam>(
    messages: T[],
    options?: NormalizeOpenAIMessageContentOptions,
  ): T[] {
    if (!options) {
      return messages;
    }
    return normalizeOpenAIMessageContent(messages, options);
  }

  /**
   * Normalizes messages and logs diagnostics about any changes.
   * @param messages Original message array passed to the handler.
   * @param options Normalization options passed to the OpenAI utilities.
   * @param providerLabel Label used to identify the provider in logs.
   */
  protected prepareNormalizedMessages<T extends ChatCompletionMessageParam>(
    messages: T[],
    options?: NormalizeOpenAIMessageContentOptions,
    providerLabel: string = this.config.provider,
  ): T[] {
    const normalizedMessages = this.normalizeMessages(messages, options);

    if (normalizedMessages.length !== messages.length) {
      this.logger.info(
        `Preprocessed message array from ${messages.length} to ${normalizedMessages.length} messages for ${providerLabel} model compatibility`,
      );
    }

    normalizedMessages.forEach((msg, index) => {
      const contentPreview =
        typeof msg.content === 'string'
          ? msg.content.substring(0, MESSAGE_PREVIEW_LENGTH)
          : 'non-string content';
      this.logger.debug(`Message ${index} (${msg.role}): ${contentPreview}...`);
    });

    return normalizedMessages;
  }

  /** Initializes message array with system prompt and user content. */
  async initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: FileLocation[],
    systemPrompt?: string,
  ): Promise<any[]> {
    const messages: any[] = [];

    // Handle system prompt differently for O1 models
    if (systemPrompt) {
      if (this.capabilities.supportsSystemPrompt) {
        // note that for openai native o1 full or above reasoning models, they have been renamed to "developer" but "system" still works
        messages.push({
          role: 'system',
          content: [{ type: 'text', text: systemPrompt }],
        });
      } else {
        // e.g., O1 mini and O1 preview models do not support system prompt
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: systemPrompt }],
        });
      }
    }

    // Create content list for the user message (only add non-empty prefix)
    const userMessageContent: ChatCompletionContentPart[] = [];
    if (userPrefix) {
      userMessageContent.push({ type: 'text', text: userPrefix });
    }

    // Add media if provided
    if (
      mediaFiles &&
      (this.capabilities.supportsVision ||
        this.capabilities.supportsNativeAudio)
    ) {
      // createMediaMessage returns an array of objects formatted by createMediaContent
      const formattedMediaContent = await this.createMediaMessage(mediaFiles);
      userMessageContent.push(...formattedMediaContent);
    }

    // Append content to last user message, or create new user message
    const lastMsg = messages.at(-1);
    if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
      lastMsg.content.push(...userMessageContent);
    } else {
      messages.push({ role: 'user', content: userMessageContent });
    }

    // Add final user request
    const requestRole = this.capabilities.supportsIntermDevMsgs
      ? 'system'
      : 'user';
    const lastMessage = messages.at(-1);

    if (
      requestRole === 'user' &&
      lastMessage?.role === 'user' &&
      Array.isArray(lastMessage.content)
    ) {
      lastMessage.content.push({ type: 'text', text: userRequest });
    } else {
      messages.push({
        role: requestRole,
        content: [{ type: 'text', text: userRequest }],
      });
    }

    return messages;
  }

  /** Adds user message content for subsequent rounds. */
  async createRoundMessages(
    messages: any[],
    userMessage: string,
    mediaFiles?: FileLocation[],
  ): Promise<any[]> {
    const roundContent: ChatCompletionContentPart[] = [];
    // OpenAI API: system role does not support images/audio
    // Error: 400 Invalid 'messages[N]'. Image URLs are only allowed for messages with role 'user'
    const role = 'user';

    if (
      mediaFiles &&
      mediaFiles.length > 0 &&
      (this.capabilities.supportsVision ||
        this.capabilities.supportsNativeAudio)
    ) {
      try {
        const formattedMediaContent = await this.createMediaMessage(mediaFiles);
        roundContent.push(...formattedMediaContent);
      } catch (err) {
        this.logger.error(
          `Error processing media files for follow-up round: ${getSdkErrorMessage(err)}`,
          { data: err },
        );
      }
    }
    // Only add text content if non-empty to avoid API "text content is empty" errors
    if (userMessage) {
      roundContent.push({ type: 'text', text: userMessage });
    }

    // Only push message if there's content (media or text)
    if (roundContent.length > 0) {
      messages.push({ role, content: roundContent });
    }
    return messages;
  }

  async createUserFollowUpMessages(
    messages: any[],
    userMessage: string,
  ): Promise<any[]> {
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: userMessage }],
    });
    return messages;
  }

  createAssistantMessage(text: string): ChatCompletionMessageParam {
    return { role: 'assistant', content: [{ type: 'text', text }] };
  }

  /** Builds the default content parts for inline vision requests. */
  protected buildStandardVisionParts(
    media: MediaEntry,
  ): ChatCompletionContentPart[] {
    return [
      { type: 'text', text: `Image: ${media.file_name}` },
      {
        type: 'image_url',
        image_url: {
          url: `data:${media.media_type};base64,${media.data}`,
          detail: 'high',
        },
      },
    ];
  }

  /** Formats image/audio content for OpenAI/Google's vision/audio API. */
  createMediaContent(mediaMessage: MediaEntry[]): ChatCompletionContentPart[] {
    return mediaMessage.flatMap((media): ChatCompletionContentPart[] => {
      if (media.media_category === 'image') {
        return this.buildStandardVisionParts(media);
      } else if (
        media.media_category === 'audio' &&
        this.capabilities.supportsNativeAudio
      ) {
        // Currently OpenRouter's OpenAI-compatible audio branch is the only consumer
        // Extract format from mime type (e.g., 'wav' from 'audio/wav')
        const audioFormat = (
          media.media_type.split('/').pop() ?? media.media_type
        ).toLowerCase();
        const supportedFormats = ['wav', 'mp3'] as const;

        if (
          !supportedFormats.includes(
            audioFormat as (typeof supportedFormats)[number],
          )
        ) {
          throw new Error(
            `Unsupported audio format "${audioFormat}". Valid formats: ${supportedFormats.join(', ')}`,
          );
        }

        const typedAudioFormat = audioFormat as 'wav' | 'mp3';

        const audioContent: ChatCompletionContentPartInputAudio = {
          type: 'input_audio',
          input_audio: {
            data: media.data,
            format: typedAudioFormat,
          },
        };
        // actually, currently only mp3 and wav are supported
        // openai.BadRequestError: Error code: 400 - [{'error': {'code': 400, 'message': 'Invalid audio format "m4a" for audio generation. Valid formats are: [wav, mp3]', 'status': 'INVALID_ARGUMENT'}}]

        // For the size:
        // You can use the File API to upload an audio file of any size.
        // Always use the File API when the total request size (including the files, text prompt, system instructions, etc.) is larger than 20 MB.
        // The maximum request size is 20 MB, which includes text prompts, system instructions, and files provided inline. If your file's size will make the total request size exceed 20 MB, then use the File API to upload files for use in requests.
        // If you're using an audio sample multiple times, it is more efficient to use the File API.
        // https://ai.google.dev/gemini-api/docs/audio?hl=en&lang=python

        // The structure below might need adjustment based on exact API requirements
        // Using a structure closer to the message format from documentation
        // It seems this needs to be part of the user message content directly.
        // Let's adapt this to return the structured object expected within the message content array.
        return [
          { type: 'text', text: `Audio: ${media.file_name}` }, // Text description goes separately
          audioContent,
        ];
      } else if (media.media_category === 'audio') {
        this.logger.warn(
          `Audio input received (${media.file_name}) but native audio is not supported by this specific model/provider (${this.config.provider}). Skipping.`,
        );
        return []; // Return empty array if audio not supported
      } else {
        this.logger.warn(`Unknown media category: ${media.media_category}`);
        return [];
      }
    });
  }

  /** Extracts response text and usage statistics from API response. */
  extractResponse(responseObject: any, endTag: string): ExtractResponseResult {
    if (!responseObject.choices?.length) {
      this.logger.debug(
        `Response object: ${objectToLogString(responseObject)}`,
      );

      // Add fallback for streaming which returns content directly in responseObject
      if (responseObject.role && responseObject.content) {
        this.logger.warn(
          'Using direct response format (streaming style) as fallback',
        );
        let newResponse = responseObject.content.trim();
        // Since we don't have a stop reason in this format, assume stop
        let stopReason = OPENAI_CHAT_FINISH.STOP;
        if (responseObject.choices?.[0]?.finish_reason) {
          stopReason = responseObject.choices[0].finish_reason;
        }

        // For usage, we'll use empty values since they're not provided; TODO needs to test at some points
        const usage = responseObject.usage ?? {
          prompt_tokens: 0,
          completion_tokens: 0,
        };

        // Add end tag if response was stopped and tag isn't present
        if (
          stopReason === OPENAI_CHAT_FINISH.STOP &&
          endTag &&
          !newResponse.includes(endTag)
        ) {
          this.logger.debug(`Adding end tag to response: ${endTag}`);
          newResponse = `${newResponse}\n${endTag}`;
        }

        return { text: newResponse, usage, stopReason };
      }

      if (responseObject.error) {
        const errorMsg = `API error: ${JSON.stringify(responseObject.error)}`;
        this.logger.error(errorMsg);
        throw new Error(errorMsg);
      }

      const errorMsg = 'Invalid response from API: missing choices';
      this.logger.error(errorMsg);
      this.logger.error(
        `Response object: ${objectToLogString(responseObject)}`,
      );
      throw new Error(errorMsg);
    }

    // Extract base response
    const choice = responseObject.choices[0];
    const stopReason = choice.finish_reason;
    this.logger.debug(`Stop reason: ${stopReason}`);
    let newResponse = '';
    if (choice.message.content) {
      newResponse = choice.message.content.trim();
    } else if (
      stopReason === OPENAI_CHAT_FINISH.TOOL_CALLS ||
      stopReason === OPENAI_CHAT_FINISH.FUNCTION_CALL ||
      Array.isArray(choice.message.tool_calls) ||
      choice.message.function_call
    ) {
      // Other provider SDKs (Anthropic, Google, etc.) keep a placeholder
      // message when a tool is invoked. OpenAI omits `content` entirely,
      // so lack of content is not an error in this case.

      this.logger.debug('Received tool call without message content');
    } else {
      newResponse = '';
      this.logger.error(
        `Response object: ${objectToLogString(responseObject)}`,
      );
      this.logger.error('content is empty');
    }

    // Add end tag if response was stopped and tag isn't present
    if (
      stopReason === OPENAI_CHAT_FINISH.STOP &&
      endTag &&
      !newResponse.includes(endTag)
    ) {
      this.logger.debug(`Adding end tag to response: ${endTag}`);
      newResponse = `${newResponse}\n${endTag}`;
    }

    return { text: newResponse, usage: responseObject.usage, stopReason };
  }

  /** Manages continuation with prefill support (typically no-op for models with prefill). */
  addContinueMessageWithPrefill(
    _messages: any[],
    _workspaceState: AgentWorkspaceState,
    _agentSetting: AgentSetting,
  ): void {
    this.defaultAddContinueWithPrefill();
  }

  /** Manages continuation for models without prefill support by adding a continuation prompt. */
  addContinueMessageWithoutPrefill(
    messages: any[],
    workspaceState: AgentWorkspaceState,
    agentSetting: AgentSetting,
  ): void {
    const userMessageContinuation = this.createContinuationPrompt(
      workspaceState,
      agentSetting,
    );

    this.logger.debug(
      `Adding continuation message to conversation. Continuation message:\n ${userMessageContinuation}`,
    );

    const role = this.capabilities.supportsIntermDevMsgs ? 'system' : 'user';
    messages.push({
      role,
      content: [{ type: 'text', text: userMessageContinuation }],
    });
  }

  /** Initializes output file and handles prefill content. */
  async initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: any[],
    workspaceState: AgentWorkspaceState,
    outputLocation: FileLocation,
    prefill: string,
  ): Promise<[boolean, any[]]> {
    let endTurn = false;

    if (!(await flexibleFS.existsAndNonTrivial(outputLocation))) {
      const pseudoPrefillMsg = `Organize your response with xml tags. Start your response with:\n${prefill}`;
      const lastMessage = messages.at(-1);
      if (lastMessage && Array.isArray(lastMessage.content)) {
        lastMessage.content.push({ type: 'text', text: pseudoPrefillMsg });
      } else if (lastMessage && typeof lastMessage.content === 'string') {
        lastMessage.content = [
          { type: 'text', text: lastMessage.content },
          { type: 'text', text: pseudoPrefillMsg },
        ];
      }
      this.logger.debug(`Added pseudo prefill: "${pseudoPrefillMsg}"`);
      return [endTurn, messages];
    }

    // Prepare existing file content (read, clean, extract scratchpad, update state)
    const { fileContent } = await prepareExistingOutputContent(
      outputLocation,
      workspaceState,
      this.logger,
    );

    messages.push({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: fileContent,
        },
      ],
    });

    if (hasEndTag(agentSetting, fileContent)) {
      this.logger.debug(
        'End tag detected - skipping model call (response already added above)',
      );
      endTurn = true;
      return [endTurn, messages];
    }

    this.logger.warn(
      'Output file exists but no end tag found - continuing from file',
    );
    // Only need to handle case where prefill needs to be prepended
    // (workspace state was already updated above with file content)
    if (!fileContent.includes(prefill)) {
      workspaceState.assembly.accumulatedOutput = prefill + fileContent;
      await flexibleFS.write(
        outputLocation,
        workspaceState.assembly.accumulatedOutput,
      );
    }
    this.addContinueMessageWithoutPrefill(
      messages,
      workspaceState,
      agentSetting,
    );

    endTurn = false;
    return [endTurn, messages];
  }

  /** Computes cost based on token usage and model pricing. */
  computePrice(responseUsage: ExtendedCompletionUsage | null): number {
    // Handle models that return None for usage
    if (!responseUsage) {
      return 0.0;
    }

    // Get token counts
    const promptTokens = responseUsage.prompt_tokens ?? 0;
    const completionTokens = responseUsage.completion_tokens ?? 0;
    // Note: OpenAI doesn't provide tool_use_tokens in their API response

    let basePrice = calculateTokenPrice(
      promptTokens,
      completionTokens,
      this.config.inputPrice,
      this.config.outputPrice,
    );

    // Retrieve nested token details if present
    const reasoningTokens =
      responseUsage.completion_tokens_details?.reasoning_tokens ?? 0;
    const cachedTokens =
      responseUsage.prompt_tokens_details?.cached_tokens ??
      responseUsage.prompt_cache_hit_tokens ?? // deepseek
      0;

    if (reasoningTokens) {
      basePrice += (reasoningTokens * this.config.outputPrice) / 1e6;
    }
    if (cachedTokens) {
      basePrice -=
        (cachedTokens *
          this.config.inputPrice *
          (1 - this.capabilities.cacheDiscountFactor)) /
        1e6;
    }

    return basePrice;
  }

  /**
   * Returns the provider identifier for usage tracking.
   * Defaults to config.provider. Override only when usage tracking
   * needs a different identifier (e.g., 'kimi' for Moonshot).
   */
  protected get usageProvider(): NormalizedUsage['provider'] {
    return this.config.provider as NormalizedUsage['provider'];
  }

  /** Normalizes OpenAI usage data into a unified format. */
  normalizeUsage(
    rawUsage: ExtendedCompletionUsage | null,
    responseTimeMs: number,
  ): NormalizedUsage {
    if (!rawUsage) {
      return {
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        responseTimeMs,
        provider: this.usageProvider,
      };
    }

    // OpenAI's prompt_tokens is the TOTAL (includes cached tokens).
    // Cached tokens are a subset, unlike Anthropic where input_tokens excludes cached.
    const inputTokens = rawUsage.prompt_tokens ?? 0;
    // OpenAI: prompt_tokens_details.cached_tokens; DeepSeek: prompt_cache_hit_tokens
    const cachedTokens =
      rawUsage.prompt_tokens_details?.cached_tokens ??
      rawUsage.prompt_cache_hit_tokens ??
      0;

    return {
      inputTokens,
      outputTokens: rawUsage.completion_tokens ?? 0,
      cost: this.computePrice(rawUsage),
      responseTimeMs,
      provider: this.usageProvider,
      cachedInputTokens: nonZeroOrUndefined(cachedTokens),
      percentageCached: computeCachePercentage(cachedTokens, inputTokens),
      reasoningTokens: nonZeroOrUndefined(
        rawUsage.completion_tokens_details?.reasoning_tokens,
      ),
      _native: rawUsage,
    };
  }

  /** Updates message content for models with prefill support. */
  updateMessageContentWithPrefill(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void {
    this.logger.debug(
      'Updating message content for OpenAI models with prefill support',
    );

    const lastMessage = messages.at(-1);

    if (isAssistantMessage(lastMessage)) {
      if (Array.isArray(lastMessage.content)) {
        lastMessage.content.push({
          type: 'text',
          text: bestConnector + newResponse,
        });
      } else {
        lastMessage.content = [
          {
            type: 'text',
            text: workspaceState.assembly.accumulatedOutput,
          },
        ];
      }
    } else if (lastMessage?.role === 'user' || lastMessage?.role === 'system') {
      this.logger.debug(
        ' Last message is a user or system message - unexpected format',
      );
      // Add a new assistant message
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: bestConnector + newResponse }],
      });
    }
  }

  /** Updates message content for models without prefill support. */
  updateMessageContentWithoutPrefill(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void {
    this.logger.debug(
      'Updating message content for OpenAI models without prefill support',
    );

    // For OpenAI models without prefill, the last message is always a user/system message
    const lastMessage = messages.at(-1);
    const secondLastMessage = messages.at(-2);

    if (
      !lastMessage ||
      (lastMessage.role !== 'user' && lastMessage.role !== 'system')
    ) {
      this.logger.error(
        'Last message is not a user or system message - unexpected format',
      );
      return;
    }
    this.logger.debug('Last message is a user/system message');

    if (this.containCutOffMessage(lastMessage.content)) {
      this.logger.debug(
        'Last message is a user message asking to continue after cut off',
      );
      // Then the last message is a user message
      // So the second last message must be an assistant message
      if (isAssistantMessage(secondLastMessage)) {
        if (Array.isArray(secondLastMessage.content)) {
          secondLastMessage.content.push({
            type: 'text',
            text: bestConnector + newResponse,
          });
        } else {
          this.logger.error('Second last message content is not a list');
          secondLastMessage.content = [
            {
              type: 'text',
              text: workspaceState.assembly.accumulatedOutput,
            },
          ];
        }

        // Remove the user continuation prompt to keep the conversation clean
        if (messages.at(-1)?.role === 'user') {
          messages.pop();
        } else {
          this.logger.error(
            'Last message is not a user message - unexpected format',
          );
        }
      }
    } else {
      this.logger.debug(
        'Last message is a request message rather than a ask to continue after cut off',
      );
      messages.push({
        role: 'assistant',
        content: [
          { type: 'text', text: workspaceState.assembly.accumulatedOutput },
        ],
      });
    }
  }

  /** Determines if generation should continue based on response content. */
  shouldContinue(
    stopReason: ProviderStopReason,
    newResponse: string,
    agentSetting: AgentSetting,
  ): boolean {
    return (
      stopReason === OPENAI_CHAT_FINISH.LENGTH &&
      !hasEndTag(agentSetting, newResponse)
    );
  }

  /**
   * Extracts reasoning content from an API response message.
   * Subclasses can override to look at different fields (e.g., OpenRouter uses 'reasoning').
   */
  protected extractReasoningFromMessage(
    message: Record<string, unknown> | undefined,
  ): string | null {
    const reasoning = message?.reasoning_content;
    if (isNonEmptyString(reasoning)) {
      return reasoning;
    }
    return null;
  }

  /**
   * Processes thinking blocks from API response.
   * @param responseObject The response object from the API
   * @param workspaceState Optional workspaceState to update with thinking blocks
   * @returns The extracted reasoning content or null if none found
   */
  processThinkingBlock(
    responseObject: any,
    workspaceState?: AgentWorkspaceState,
  ): string | null {
    const message = responseObject?.choices?.[0]?.message;
    const reasoning = this.extractReasoningFromMessage(message);
    if (!reasoning) {
      return null;
    }

    if (workspaceState && !workspaceState.reasoning.thinkingAdded) {
      workspaceState.reasoning.thinkingBlocks = [
        { type: 'thinking', thinking: reasoning },
      ];
      workspaceState.reasoning.thinkingAdded = true;
    }

    this.logger.debug(
      `Reasoning content preview: ${reasoning.substring(0, K_SLICE)}...`,
    );
    return reasoning;
  }

  private ensureStringifiedArguments(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }
    if (value === undefined) {
      return '{}';
    }
    try {
      return JSON.stringify(value);
    } catch (err) {
      this.logger.warn(
        `Failed to serialize tool arguments: ${getSdkErrorMessage(err)}`,
      );
      return '{}';
    }
  }

  protected normalizeToolCall(
    call: ChatCompletionMessageToolCall,
  ): ChatCompletionMessageToolCall {
    if (call.type === 'function') {
      return {
        id: call.id,
        type: 'function',
        function: {
          name: call.function.name,
          arguments: this.ensureStringifiedArguments(call.function.arguments),
        },
      };
    }
    if (call.type === 'custom') {
      return {
        id: call.id,
        type: 'custom',
        custom: {
          name: call.custom.name,
          input: this.ensureStringifiedArguments(call.custom.input),
        },
      };
    }
    // Type should be exhaustive, but return as-is for safety
    return call;
  }

  /**
   * Provider name used when extracting tool calls.
   * Defaults to config.provider. Override only when tool calls
   * need a different identifier.
   */
  protected get toolCallProvider(): string {
    return this.config.provider;
  }

  protected parseArguments(raw: unknown): unknown {
    if (typeof raw !== 'string') {
      return raw;
    }

    try {
      return JSON.parse(raw);
    } catch (error) {
      this.logger.warn(
        'Tool call arguments could not be parsed as JSON; using raw string.',
        { data: error },
      );
      return raw;
    }
  }

  extractToolUse(responseObject: ChatCompletion): TCall[] {
    const toolCalls = responseObject?.choices?.[0]?.message?.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      return toolCalls
        .filter(
          (
            call,
          ): call is ChatCompletionMessageFunctionToolCall & { id: string } =>
            Boolean(
              call &&
              typeof call === 'object' &&
              (call as ChatCompletionMessageFunctionToolCall).function?.name &&
              call.id,
            ),
        )
        .map((call) => ({
          provider: this.toolCallProvider,
          callId: call.id,
          name: call.function!.name,
          input: this.parseArguments(call.function!.arguments),
          raw: call,
        })) as TCall[];
    }

    return [];
  }

  /**
   * Formats text content for assistant messages in tool call follow-ups.
   * Subclasses can override to use string format instead of array format.
   */
  protected formatAssistantContent(
    text: string,
  ): ChatCompletionAssistantMessageParam['content'] {
    return [{ type: 'text', text }];
  }

  /**
   * Whether to include reasoning_content in assistant messages for tool-use cycles.
   * Override in subclasses (DeepSeek, Kimi) that require reasoning content preservation.
   *
   * When true, reasoning content from workspaceState.reasoning.thinkingBlocks
   * will be included in the assistant message and cleared after use.
   */
  protected shouldIncludeReasoningInToolCalls(): boolean {
    return false;
  }

  /**
   * Builds an assistant message with tool calls and optional reasoning_content.
   *
   * For providers that support thinking mode with tool calls (DeepSeek, Kimi),
   * reasoning_content must be included in the assistant message for the model
   * to continue its reasoning chain across tool-use cycles.
   *
   * @param toolCalls - Normalized tool calls
   * @param workspaceState - Workspace state containing reasoning blocks
   * @param text - Optional text content
   * @returns Assistant message with tool calls and optional reasoning_content
   */
  protected buildAssistantMessageWithToolCalls(
    toolCalls: ChatCompletionMessageToolCall[],
    workspaceState?: AgentWorkspaceState,
    text?: string,
  ): ChatCompletionAssistantMessageParam {
    const callMsg: ChatCompletionAssistantMessageParam & {
      reasoning_content?: string;
    } = {
      role: 'assistant',
      tool_calls: toolCalls,
    };

    // Include reasoning_content if this provider requires it for tool-use cycles
    if (this.shouldIncludeReasoningInToolCalls() && workspaceState) {
      const reasoningContent =
        workspaceState.reasoning.thinkingBlocks[0]?.thinking;
      if (reasoningContent) {
        callMsg.reasoning_content = reasoningContent;
        // Clear after use to prevent stale reasoning in subsequent calls
        workspaceState.resetReasoning();
      }
    }

    if (text) {
      callMsg.content = this.formatAssistantContent(text);
    }

    return callMsg;
  }

  async createToolUseFollowUpMessages(
    _client: OpenAI | undefined,
    call: TCall,
    result: ToolResultPayload,
    attachments: ToolFileAttachment[],
    workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<ChatCompletionMessageParam[]> {
    const toolCall = this.normalizeToolCall(call.raw);
    const callMsg = this.buildAssistantMessageWithToolCalls(
      [toolCall],
      workspaceState,
      text,
    );

    // Build tool result as plain text - JSON wastes tokens
    const attachmentSummary =
      this.canProcessToolResultAttachments && attachments.length > 0
        ? formatAttachmentSummary(attachments)
        : undefined;

    const resultMsg: ChatCompletionToolMessageParam = {
      role: 'tool',
      tool_call_id: toolCall.id,
      content: formatToolResultAsText(result, attachmentSummary),
    };
    return [callMsg, resultMsg];
  }

  // =========================================================================
  // Message modification methods (for post-build enrichment)
  // =========================================================================

  /**
   * Prepend text to the last user message in the conversation.
   */
  prependTextToUserMessage(
    messages: ChatCompletionMessageParam[],
    text: string,
  ): void {
    if (!text.trim()) return;

    const lastUserMsg = messages.findLast((m) => m.role === 'user');
    if (!lastUserMsg || !('content' in lastUserMsg)) return;

    if (typeof lastUserMsg.content === 'string') {
      lastUserMsg.content = text + lastUserMsg.content;
    } else if (Array.isArray(lastUserMsg.content)) {
      const firstTextPart = lastUserMsg.content.find((p) => p.type === 'text');
      if (firstTextPart && 'text' in firstTextPart) {
        firstTextPart.text = text + firstTextPart.text;
      } else {
        lastUserMsg.content.unshift({ type: 'text', text });
      }
    }
  }

  /**
   * Add media files to the last user message in the conversation.
   */
  async addMediaToUserMessage(
    messages: ChatCompletionMessageParam[],
    mediaFiles: FileLocation[],
  ): Promise<void> {
    if (!mediaFiles.length || !this.capabilities.supportsVision) return;

    const lastUserMsg = messages.findLast((m) => m.role === 'user');
    if (!lastUserMsg || !('content' in lastUserMsg)) return;

    try {
      const formattedMedia = await this.createMediaMessage(mediaFiles);
      if (typeof lastUserMsg.content === 'string') {
        lastUserMsg.content = [
          ...formattedMedia,
          {
            type: 'text',
            text: lastUserMsg.content,
          } as ChatCompletionContentPart,
        ];
      } else if (Array.isArray(lastUserMsg.content)) {
        lastUserMsg.content.unshift(...formattedMedia);
      }
    } catch (err) {
      this.logger.logError(
        `Error adding media to user message: ${getSdkErrorMessage(err)}`,
        err,
        { operation: 'add media to user message' },
      );
    }
  }
}
