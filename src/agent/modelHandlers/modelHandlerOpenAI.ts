// Third-party imports
import { countTokens } from 'gpt-tokenizer';
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
import { ConversationRoundState } from '@agent/core/AgentState';
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
import { cleanFileContent } from '@replacement/engine';
import type { ToolFileAttachment } from '@tools/result';
import { isNonEmptyString } from '@utils/core';
import type { FileLocation } from '@utils/files';
import { K_SLICE, MESSAGE_PREVIEW_LENGTH } from '@utils/config';
import { flexibleFS } from '@utils/files';
import { objectToLogString } from '@utils/text/stringUtils';
import { extractScratchpad } from '@utils/text/xmlUtils';

// Local file imports
import { OPENAI_CHAT_FINISH } from './types/StopReasonTypes';
import {
  normalizeOpenAIMessageContent,
  NormalizeOpenAIMessageContentOptions,
} from './openAIMessageUtils';
import { toOpenAITools } from './toolConversion';
import {
  formatAttachmentSummary,
  type ToolResultPayload,
} from './utils/toolAttachmentUtils';
import { executeRequest } from './utils/requestExecutor';
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

const extractReasoningText = (
  content: ReasoningContent | undefined,
): string => {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content.map((item) => item.text ?? '').join('');
};

const DEEPSEEK_OFFICIAL_API_MAX_TOKENS = 8192;

export interface StreamingAggregator {
  appendContent(delta: string): void;
  appendReasoning(delta: string): void;
  consumeChunk(chunk: ChatCompletionChunk): void;
  finalize(fallback?: ChatCompletion): ChatCompletion;
}

export const extractReasoningDelta = (chunk: ChatCompletionChunk): string => {
  const choice = chunk.choices[0];
  if (!choice) return '';

  const delta = choice.delta as { reasoning_content?: ReasoningContent };
  if (!('reasoning_content' in delta)) return '';

  return extractReasoningText(delta.reasoning_content);
};

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

    if (
      this.config.capabilities.supportsReasoning &&
      this.config.capabilities.supportsReasoningEffort &&
      this.config.capabilities.reasoningEffort
    ) {
      baseParams.reasoning_effort = this.validateReasoningEffort(
        this.config.capabilities.reasoningEffort,
      ) as ChatCompletionRequestBase['reasoning_effort'];
    }

    if (tools && tools.length > 0) {
      baseParams.parallel_tool_calls = false;
      baseParams.tools = toOpenAITools(tools);
      baseParams.tool_choice = 'auto';
    }

    if (
      this.config.fullName === 'deepseek-chat' &&
      !this.config.capabilities.supportsReasoning
    ) {
      this.logger.debug(
        `Setting max_tokens to ${DEEPSEEK_OFFICIAL_API_MAX_TOKENS} for DeepSeek-chat models from the official api`,
      );
      baseParams.max_tokens = DEEPSEEK_OFFICIAL_API_MAX_TOKENS;
    }

    this.applyTokenHeuristics(baseParams, messages, systemPrompt);

    return baseParams;
  }

  protected applyTokenHeuristics(
    baseParams: ChatCompletionRequestBase,
    messages: ChatCompletionMessageParam[],
    systemPrompt?: string,
  ): void {
    try {
      const approximateInputTokens = this._calculateApproximateTokens(
        messages,
        systemPrompt,
      );

      this.logger.debug(
        `Approximate token count of message: ${approximateInputTokens}`,
      );

      if (approximateInputTokens > this.config.contextWindow) {
        const errorMsg = `Approximate token count of message exceeds context window: ${approximateInputTokens} > ${this.config.contextWindow}`;
        this.logger.error(errorMsg);
        throw new Error(errorMsg);
      }

      const maxOutputKey: 'max_completion_tokens' | 'max_tokens' = this
        .isOReasoningModel
        ? 'max_completion_tokens'
        : 'max_tokens';
      const availableTokens =
        this.config.contextWindow - approximateInputTokens;
      const currentMax = baseParams[maxOutputKey];
      if (typeof currentMax === 'number' && availableTokens < currentMax) {
        const TOKEN_BUFFER = 5000;
        const MIN_COMPLETION_TOKENS = 100;

        if (availableTokens <= 0) {
          baseParams[maxOutputKey] = 1;
          this.logger.warn(
            `Approximate token count (${approximateInputTokens}) already exceeds context window (${this.config.contextWindow}). Forcing ${maxOutputKey} to 1 token.`,
          );
        } else {
          const adjustedWithBuffer = Math.max(
            MIN_COMPLETION_TOKENS,
            availableTokens - TOKEN_BUFFER,
          );
          const adjusted = Math.min(availableTokens, adjustedWithBuffer);
          baseParams[maxOutputKey] = adjusted;
          this.logger.warn(
            `Approximate token count (${approximateInputTokens}) + max tokens (${currentMax}) exceeds context window (${this.config.contextWindow}). Reducing ${maxOutputKey} to ${adjusted}.`,
          );
        }
      }
    } catch (err) {
      // Re-throw context window violations - these are intentional validation errors
      // that should fail fast, not be swallowed by soft failure
      if (isContextWindowError(err)) {
        throw err;
      }
      // Soft failure for token counting errors - proceed without adjustment
      this.logger.warn(
        `Token counting failed: ${getSdkErrorMessage(err)}. Proceeding without token adjustment.`,
      );
    }
  }

  protected finalizeStreams(
    thinking: ReturnType<ModelHandler['createThinkingStream']>,
    output: ReturnType<ModelHandler['createOutputStream']> | undefined,
    finalResponse: ChatCompletion,
  ): void {
    const finalReasoning = this.processThinkingBlock(finalResponse);
    if (finalReasoning === null) {
      thinking.finalize();
    } else {
      thinking.finalize(finalReasoning);
    }

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

    const markRetryAttempt = (attempt: number): void => {
      if (attempt === 1) {
        return;
      }

      const retryNotice = `\n[Retrying request: attempt ${attempt}]`;
      thinking.append(retryNotice);
      output?.append(retryNotice);
    };
    const streamParams: ChatCompletionStreamParams = {
      ...baseParams,
      stream: true,
      stream_options: { include_usage: true },
    };

    return executeRequest(
      {
        model: this.config.name,
        operation: 'openai.chat.completions.stream',
        signal,
        onAttemptStart: (nextAttempt) => {
          markRetryAttempt(nextAttempt);
        },
      },
      async () => {
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
      },
    );
  }

  protected async executeNonStreamingChat(
    client: OpenAI,
    baseParams: ChatCompletionRequestBase,
    signal?: AbortSignal,
  ): Promise<ChatCompletion> {
    return executeRequest(
      {
        model: this.config.name,
        operation: 'openai.chat.completions.create',
        signal,
      },
      () =>
        client.chat.completions.create(
          {
            ...baseParams,
            stream: false,
          },
          { signal },
        ),
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
    } = options;

    // Apply message normalization if subclass specifies options
    const normOptions = this.getMessageNormalizationOptions();
    const messages = normOptions
      ? this.prepareNormalizedMessages(rawMessages, normOptions)
      : rawMessages;

    const useStreaming = this.getStreamingConfig();
    const baseParams = this.buildChatBaseParams(
      messages,
      temperature,
      systemPrompt,
      endTag,
      tools,
    );

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
      if (this.config.capabilities.supportsSystemPrompt) {
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

    // Create content list for the user message
    const userMessageContent: ChatCompletionContentPart[] = [
      { type: 'text', text: userPrefix },
    ];

    // Add media if provided
    if (
      mediaFiles &&
      (this.config.capabilities.supportsVision ||
        this.config.capabilities.supportsNativeAudio)
    ) {
      // createMediaMessage returns an array of objects formatted by createMediaContent
      const formattedMediaContent = await this.createMediaMessage(mediaFiles);
      userMessageContent.push(...formattedMediaContent);
    }

    // Append the formatted content to the correct message
    let lastRole = messages.length > 0 ? messages.at(-1).role : null;
    if (lastRole === 'system' || messages.length === 0) {
      messages.push({ role: 'user', content: userMessageContent });
    } else if (lastRole === 'user') {
      messages.at(-1).content.push(...userMessageContent);
    } else {
      // Fallback: Should not happen with current logic but good to handle
      messages.push({ role: 'user', content: userMessageContent });
      this.logger.warn(
        'Unexpected message structure, adding new user message.',
      );
    }

    // Add final user request
    const requestRole = this.config.capabilities.supportsIntermDevMsgs
      ? 'system'
      : 'user';
    lastRole = messages.length > 0 ? messages.at(-1)?.role : null;

    if (requestRole === 'system') {
      messages.push({
        role: requestRole,
        content: [{ type: 'text', text: userRequest }],
      });
    } else if (requestRole === 'user' && lastRole === 'user') {
      const lastMessage = messages.at(-1);
      if (lastMessage && Array.isArray(lastMessage.content)) {
        lastMessage.content.push({
          type: 'text',
          text: userRequest,
        });
      } else if (lastMessage && typeof lastMessage.content === 'string') {
        // Convert string content to array format
        lastMessage.content = [
          { type: 'text', text: lastMessage.content },
          { type: 'text', text: userRequest },
        ];
      }
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
      (this.config.capabilities.supportsVision ||
        this.config.capabilities.supportsNativeAudio)
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
    roundContent.push({ type: 'text', text: userMessage });

    messages.push({ role, content: roundContent });
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
        this.config.capabilities.supportsNativeAudio
      ) {
        // Currently OpenRouter's OpenAI-compatible audio branch is the only consumer
        let audioFormat = media.media_type;
        if (media.media_type.includes('/')) {
          audioFormat = media.media_type.split('/')[1]; // e.g., 'wav' from 'audio/wav'
        }

        type SupportedAudioFormat = 'wav' | 'mp3';
        const normalizedAudioFormat = audioFormat.toLowerCase();
        const supportedFormats = new Set<SupportedAudioFormat>(['wav', 'mp3']);
        if (
          !supportedFormats.has(normalizedAudioFormat as SupportedAudioFormat)
        ) {
          const errorMessage = `Unsupported audio format "${audioFormat}" for audio generation. Valid formats are: wav, mp3.`;
          this.logger.error(errorMessage);
          throw new Error(errorMessage);
        }

        const typedAudioFormat = normalizedAudioFormat as SupportedAudioFormat;

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

        return { response: newResponse, usage, stopReason };
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

    return { response: newResponse, usage: responseObject.usage, stopReason };
  }

  /** Manages continuation with prefill support (typically no-op for models with prefill). */
  addContinueMessageWithPrefill(
    _messages: any[],
    _stateRound: ConversationRoundState,
    _workspaceState: AgentWorkspaceState,
    _agentSetting: AgentSetting,
    _agentConfig: AgentConfig,
  ): void {
    this.defaultAddContinueWithPrefill();
  }

  /** Manages continuation for models without prefill support by adding a continuation prompt. */
  addContinueMessageWithoutPrefill(
    messages: any[],
    _stateRound: ConversationRoundState,
    workspaceState: AgentWorkspaceState,
    agentSetting: AgentSetting,
    _agentConfig: AgentConfig,
  ): void {
    const userMessageContinuation = this.createContinuationPrompt(
      workspaceState,
      agentSetting,
    );

    this.logger.debug(
      `Adding continuation message to conversation. Continuation message:\n ${userMessageContinuation}`,
    );

    const role = this.config.capabilities.supportsIntermDevMsgs
      ? 'system'
      : 'user';
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
      const PseudoPrefillMsgContentString = `Organize your response with xml tags. Start your response with:\n${prefill}`;
      const lastMessage = messages.at(-1);
      if (lastMessage && Array.isArray(lastMessage.content)) {
        lastMessage.content.push({
          type: 'text',
          text: PseudoPrefillMsgContentString,
        });
      } else if (lastMessage && typeof lastMessage.content === 'string') {
        lastMessage.content = [
          { type: 'text', text: lastMessage.content },
          { type: 'text', text: PseudoPrefillMsgContentString },
        ];
      }
      this.logger.debug(
        `Added pseudo prefill message to messages:\n${PseudoPrefillMsgContentString}`,
      );
      return [endTurn, messages];
    }

    // Get prefill from existing and non-trivial file
    let fileContent = await flexibleFS.read(outputLocation);
    fileContent = cleanFileContent(fileContent);

    // Extract any existing scratchpad content
    const scratchpad = await extractScratchpad(fileContent, 'scratchpad');
    if (scratchpad) {
      this.logger.logScratchpad(scratchpad);
    }

    // Write file content to output file
    await flexibleFS.write(outputLocation, fileContent);

    // Update workspace state - critical for multi-round agents on resume
    // so that subsequent rounds have correct context
    workspaceState.assembly.accumulatedOutput = fileContent;
    workspaceState.assembly.lastResponse = fileContent;

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
    // Note: workspace state already updated above (lines 885-886)
    // Only need to handle case where prefill needs to be prepended
    if (!fileContent.includes(prefill)) {
      workspaceState.assembly.accumulatedOutput = prefill + fileContent;
      await flexibleFS.write(
        outputLocation,
        workspaceState.assembly.accumulatedOutput,
      );
    }
    const state = new ConversationRoundState(0);
    this.addContinueMessageWithoutPrefill(
      messages,
      state,
      workspaceState,
      agentSetting,
      agentConfig,
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

    const inputTokens = rawUsage.prompt_tokens ?? 0;
    const outputTokens = rawUsage.completion_tokens ?? 0;

    // Extract cached tokens (OpenAI style or DeepSeek style)
    const cachedTokens =
      rawUsage.prompt_tokens_details?.cached_tokens ??
      rawUsage.prompt_cache_hit_tokens ?? // DeepSeek
      0;

    // Extract reasoning tokens
    const reasoningTokens =
      rawUsage.completion_tokens_details?.reasoning_tokens ?? 0;

    // Calculate percentage cached
    const percentageCached =
      inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0;

    return {
      inputTokens,
      outputTokens,
      cost: this.computePrice(rawUsage),
      responseTimeMs,
      provider: this.usageProvider,
      cachedInputTokens: cachedTokens || undefined,
      percentageCached: percentageCached > 0 ? percentageCached : undefined,
      reasoningTokens: reasoningTokens || undefined,
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

  async createToolUseFollowUpMessages(
    _client: OpenAI | undefined,
    call: TCall,
    result: ToolResultPayload,
    attachments: ToolFileAttachment[],
    _workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<ChatCompletionMessageParam[]> {
    const toolCall = this.normalizeToolCall(call.raw);
    const callMsg: ChatCompletionAssistantMessageParam = {
      role: 'assistant',
      tool_calls: [toolCall],
    };
    if (text) {
      callMsg.content = this.formatAssistantContent(text);
    }

    // Build tool result as plain text (Claude Code pattern) - JSON wastes tokens
    const textPieces: string[] = [];
    if (isNonEmptyString(result.output)) {
      textPieces.push(result.output);
    }
    if (result.userInstruction) {
      textPieces.push(`User feedback: ${result.userInstruction}`);
    }
    if (result.isError && !result.output && result.error) {
      textPieces.push(result.error);
    }
    if (textPieces.length === 0 && result.summary) {
      textPieces.push(result.summary);
    }
    // Add attachment summary if handler supports them
    if (this.canProcessToolResultAttachments && attachments.length > 0) {
      textPieces.push(formatAttachmentSummary(attachments));
    }

    const resultMsg: ChatCompletionToolMessageParam = {
      role: 'tool',
      tool_call_id: toolCall.id,
      content: textPieces.join('\n\n') || 'OK',
    };
    return [callMsg, resultMsg];
  }

  /**
   * Calculates the approximate number of tokens for a given set of messages and system prompt
   * using gpt-tokenizer. This is an estimation and might not perfectly match OpenAI's
   * internal counting, especially for multi-modal content.
   *
   * @param messages The array of message objects.
   * @param systemPrompt Optional system prompt string.
   * @returns The approximate number of tokens.
   * @throws Error if token calculation fails.
   */
  private _calculateApproximateTokens(
    messages: any[],
    systemPrompt?: string,
  ): number {
    // Note: This is a simplified token count. A more accurate count would
    // need to replicate OpenAI's specific chat message formatting rules.
    // https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb
    // Errors propagate to caller which handles them appropriately.

    // Combine system prompt and messages for counting
    // TODO: This might not be perfectly accurate for multi-modal or structured messages.
    // gpt-tokenizer's countTokens might need a ChatMessage structure similar to Anthropic's.
    // For now, concatenate text content.
    let textToCount = systemPrompt ? `${systemPrompt}\n` : '';
    messages.forEach((msg) => {
      if (Array.isArray(msg.content)) {
        msg.content.forEach((part: any) => {
          if (part.type === 'text') {
            textToCount += `${msg.role}: ${part.text}\n`;
          }
          // Basic handling for other types, might need refinement
          else if (part.type === 'image_url') {
            // Approximation: Count tokens for a placeholder text representation
            textToCount += `${msg.role}: [Image]\n`;
          } else if (part.type === 'input_audio') {
            textToCount += `${msg.role}: [Audio]\n`;
          }
        });
      } else if (typeof msg.content === 'string') {
        textToCount += `${msg.role}: ${msg.content}\n`;
      }
    });
    // Use the appropriate encoding based on the model, defaulting to cl100k_base
    // Needs a mapping from model name to encoding or importing specific model tokenizers.
    // Assuming cl100k_base for gpt-3.5/4 for now. Need to enhance this.
    return countTokens(textToCount); // Assuming cl100k_base default
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
    if (!mediaFiles.length || !this.config.capabilities.supportsVision) return;

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
