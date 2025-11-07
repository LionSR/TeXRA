// Third-party imports
import { countTokens } from 'gpt-tokenizer';
import OpenAI from 'openai';
import {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionContentPartInputAudio,
  ChatCompletionAssistantMessageParam,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessage,
  ChatCompletionMessageCustomToolCall,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionToolMessageParam,
  ChatCompletionStreamParams,
} from 'openai/resources/chat/completions';
import type { ContentDeltaEvent } from 'openai/lib/ChatCompletionStream';

// Local imports - agent components
import type { AgentConfig } from '../core/AgentConfig';
import { AgentSetting, hasEndTag } from '../core/AgentDataclass';
import { ConversationRoundState } from '../core/AgentState';
import {
  OpenAIAPIResponseUsage,
  ResponseUsageFactory,
  ExtendedCompletionUsage,
} from '../core/ResponseUsage';
import { AgentWorkspaceState } from '../core/AgentWorkspaceState';
import { ModelHandler } from './ModelHandler';
import {
  describeAttachments,
  extractToolAttachments,
} from './utils/toolAttachmentUtils';
import { toOpenAITools } from './toolConversion';
import {
  normalizeOpenAIMessageContent,
  NormalizeOpenAIMessageContentOptions,
} from './openAIMessageUtils';
import type { ProviderStopReason } from './types/StopReasonTypes';
import { OPENAI_CHAT_FINISH } from './types/StopReasonTypes';
import { createContinuationMessage } from '@agent/utils/continuationMessage';
import { MediaEntry } from '@agent/utils/mediaTypes';
import { calculateTokenPrice } from '@agent/utils/priceUtils';
import { getSdkErrorMessage } from '@common/errors/sdkErrorUtils';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import type { ModelConfig, ToolDefinition } from '@model';
import { cleanFileContent } from '@replacement/engine';
import { K_SLICE, MESSAGE_PREVIEW_LENGTH } from '@utils/config';

// Local imports - filesystem utilities
import { WorkspaceFS } from '@utils/files';
import { objectToLogString } from '@utils/text/stringUtils';
import xmlUtils from '@utils/text/xmlUtils';

type ChatCompletionRequestBase = Omit<
  ChatCompletionCreateParamsStreaming,
  'stream' | 'stream_options'
>;

type ChatCompletionMessageWithReasoning = ChatCompletionMessage & {
  reasoning_content?: string;
};

interface AggregatedToolCall {
  id: string;
  function: ChatCompletionMessageFunctionToolCall['function'];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const collectTextFromUnknown = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(collectTextFromUnknown).join('');
  }
  if (isRecord(value) && typeof value.text === 'string') {
    return value.text;
  }
  return '';
};

const DEEPSEEK_OFFICIAL_API_MAX_TOKENS = 8192;

class DeepSeekStreamAggregator {
  private readonly contentParts: string[] = [];
  private readonly reasoningParts: string[] = [];
  private readonly toolCalls = new Map<number, AggregatedToolCall>();
  private functionCall: ChatCompletionMessage['function_call'] = null;
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
    if (chunk.usage) {
      this.usageChunk = chunk;
    }

    const choice = chunk.choices[0];
    if (!choice) {
      return;
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

    if (delta.function_call) {
      const { name = '', arguments: args = '' } = delta.function_call;
      const current = this.functionCall ?? { name: '', arguments: '' };
      this.functionCall = {
        name: `${current.name}${name}`,
        arguments: `${current.arguments}${args}`,
      };
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

    if (
      this.functionCall &&
      (this.functionCall.name.length > 0 ||
        this.functionCall.arguments.length > 0)
    ) {
      mergedMessage.function_call = this.functionCall;
    }

    const mergedChoice = {
      ...primaryChoice,
      index: primaryChoice.index ?? 0,
      message: mergedMessage,
      finish_reason: primaryChoice.finish_reason ?? 'stop',
      logprobs: primaryChoice.logprobs ?? null,
    };

    const usageCandidate =
      base.usage ?? this.usageChunk?.usage ?? this.lastChunkWithChoices?.usage;
    const usage = usageCandidate === null ? undefined : usageCandidate;

    return {
      ...base,
      choices: [mergedChoice],
      usage,
    };
  }

  getFullContent(): string {
    return this.contentParts.join('');
  }

  getFullReasoning(): string {
    return this.reasoningParts.join('');
  }

  private buildToolCalls(): ChatCompletionMessageFunctionToolCall[] {
    const toolCalls: ChatCompletionMessageFunctionToolCall[] = [];
    for (const [index, call] of this.toolCalls.entries()) {
      if (!call.id && !call.function.name && !call.function.arguments) {
        continue;
      }
      toolCalls.push({
        id: call.id || `tool_call_${index}`,
        type: 'function',
        function: {
          name: call.function.name,
          arguments: call.function.arguments,
        },
      });
    }
    return toolCalls;
  }

  private buildFallbackResponse(): ChatCompletion {
    const chunk = this.lastChunkWithChoices ?? this.usageChunk;
    if (!chunk) {
      return {
        id: '',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: '',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: this.getFullContent(),
              refusal: null,
            },
            finish_reason: 'stop',
            logprobs: null,
          },
        ],
      };
    }

    const choice = chunk.choices[0];
    const usage = chunk.usage === null ? undefined : chunk.usage;

    return {
      id: chunk.id,
      object: 'chat.completion',
      created: chunk.created,
      model: chunk.model,
      system_fingerprint: chunk.system_fingerprint,
      usage,
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

const extractReasoningDelta = (chunk: ChatCompletionChunk): string => {
  const choice = chunk.choices[0];
  if (!choice) {
    return '';
  }

  const delta = choice.delta as unknown;
  if (!isRecord(delta) || !('reasoning_content' in delta)) {
    return '';
  }

  return collectTextFromUnknown(
    (delta as { reasoning_content?: unknown }).reasoning_content,
  );
};

/**
 * OpenAI-specific handlers.
 */
export class ModelHandlerOpenAI extends ModelHandler<
  ChatCompletionMessageParam,
  ExtendedCompletionUsage | null,
  OpenAIAPIResponseUsage,
  ChatCompletionMessageToolCall | ChatCompletionMessage.FunctionCall,
  OpenAI
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

  /** Creates a chat completion with model-specific parameters. */
  async createResponse(
    client: OpenAI,
    messages: ChatCompletionMessageParam[],
    temperature: number,
    systemPrompt?: string,
    endTag?: string,
    signal?: AbortSignal,
    tools?: ToolDefinition[],
  ): Promise<any> {
    // Get streaming config
    const useStreaming = this.getStreamingConfig();

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

    // Calculate input tokens using the helper method
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
      this.logger.error(
        `Token counting failed: ${getSdkErrorMessage(err)}. Proceeding without token adjustment.`,
        undefined,
        undefined,
        err,
      );
      // Decide if you want to throw here or let the API call potentially fail
    }

    if (useStreaming) {
      const streamParams: ChatCompletionStreamParams = {
        ...baseParams,
        stream: true,
        stream_options: { include_usage: true },
      };

      try {
        const stream = await client.chat.completions.stream(streamParams, {
          signal,
        });
        const thinking = this.createThinkingStream();
        const output = this.isOutputStreamingEnabled()
          ? this.createOutputStream()
          : undefined;
        // DeepSeek streaming chunks surface reasoning/tool deltas that we need to
        // stitch back into the final message. Non-DeepSeek models already return
        // complete data through the SDK response, so the aggregator isn't needed.
        const deepSeekAggregator = this.config.fullName.includes('deepseek')
          ? new DeepSeekStreamAggregator()
          : null;

        const onContentDelta = ({ delta }: ContentDeltaEvent): void => {
          if (!delta) {
            return;
          }
          output?.append(delta);
          deepSeekAggregator?.appendContent(delta);
        };

        const onChunk = (chunk: ChatCompletionChunk): void => {
          deepSeekAggregator?.consumeChunk(chunk);
          const reasoningDelta = extractReasoningDelta(chunk);
          if (reasoningDelta) {
            thinking.append(reasoningDelta);
            deepSeekAggregator?.appendReasoning(reasoningDelta);
          }
        };

        stream.on('content.delta', onContentDelta);
        stream.on('chunk', onChunk);

        try {
          const sdkFinalResponse = await stream.finalChatCompletion();
          const finalResponse = deepSeekAggregator
            ? deepSeekAggregator.finalize(sdkFinalResponse)
            : sdkFinalResponse;
          const finalReasoning = this.processThinkingBlock(finalResponse);
          if (finalReasoning === null) {
            thinking.finalize();
          } else {
            thinking.finalize(finalReasoning);
          }
          const finalOutput =
            finalResponse.choices?.[0]?.message?.content ?? '';
          output?.finalize(finalOutput);
          return finalResponse;
        } finally {
          stream.off('content.delta', onContentDelta);
          stream.off('chunk', onChunk);
        }
      } catch (err) {
        this.logger.error(
          `Error in createResponse(streaming): ${getSdkErrorMessage(err)}`,
          undefined,
          undefined,
          err,
        );
        throw err;
      }
    } else {
      try {
        const nonStreamingParams: ChatCompletionCreateParamsNonStreaming = {
          ...baseParams,
          stream: false,
        };
        const response = await client.chat.completions.create(
          nonStreamingParams,
          {
            signal,
          },
        );
        return response;
      } catch (err) {
        this.logger.error(
          `Error in createResponse: ${getSdkErrorMessage(err)}`,
          undefined,
          undefined,
          err,
        );
        throw err;
      }
    }
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
    mediaFiles?: string[],
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
    mediaFiles?: string[],
  ): Promise<any[]> {
    const roundContent: ChatCompletionContentPart[] = [];

    // const role = this.config.capabilities.supportsIntermDevMsgs
    // ? 'system'
    // : 'user';
    // technically we can use system for the follow-up round messages, but it does not support images...
    // Error in createResponse: Error: 400 Invalid 'messages[4]'. Image URLs are only allowed for messages with role 'user', but this message with role 'system' contains an image URL.
    // system role does not support images/audio
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
          undefined,
          undefined,
          err,
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
        this.isGoogle &&
        this.config.capabilities.supportsNativeAudio
      ) {
        // Currently only Google via OpenAI compatibility layer supports this
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
  extractResponse(
    responseObject: any,
    endTag: string,
  ): [string, any, ProviderStopReason] {
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
        // let stopReason = OPENAI_CHAT_FINISH.LENGTH;
        if (responseObject.choices?.[0]?.finish_reason) {
          stopReason = responseObject.choices[0].finish_reason;
        }

        // For usage, we'll use empty values since they're not provided; TODO needs to test at some points
        const usage = responseObject.usage || {
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

        return [newResponse, usage, stopReason];
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
      stopReason === OPENAI_CHAT_FINISH.TOOL_USE ||
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

    return [newResponse, responseObject.usage, stopReason];
  }

  /** Manages continuation with prefill support (typically no-op for models with prefill). */
  addContinueMessageWithPrefill(
    _messages: any[],
    _stateRound: ConversationRoundState,
    _toolState: AgentWorkspaceState,
    _agentSetting: AgentSetting,
    _agentConfig: AgentConfig,
  ): void {
    this.logger.debug('Skipping continuation - assistant prefill is supported');
    // No-op for models that support prefill
  }

  /** Manages continuation for models without prefill support by adding a continuation prompt. */
  addContinueMessageWithoutPrefill(
    messages: any[],
    _stateRound: ConversationRoundState,
    toolState: AgentWorkspaceState,
    agentSetting: AgentSetting,
    _agentConfig: AgentConfig,
  ): void {
    // Create continuation message with last K tokens
    const prefillTokens = toolState.assembly.lastResponse.slice(-K_SLICE);
    const userMessageContinuation = createContinuationMessage(
      agentSetting.endTag,
      prefillTokens,
    );

    // Add continuation message
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
    toolState: AgentWorkspaceState,
    outputFile: string,
    prefill: string,
  ): Promise<[boolean, any[]]> {
    let endTurn = false;

    if (!(await WorkspaceFS.existsAndNonTrivial(outputFile))) {
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
    let fileContent = await WorkspaceFS.read(outputFile);
    fileContent = cleanFileContent(fileContent);

    // Extract any existing scratchpad content
    const scratchpad = await xmlUtils.extractScratchpad(
      fileContent,
      'scratchpad',
    );
    if (scratchpad) {
      this.logger.info(scratchpad, undefined, MESSAGE_TYPES.SCRATCHPAD);
    }

    // Write file content to output file
    await WorkspaceFS.write(outputFile, fileContent);

    messages.push({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: fileContent,
        },
      ],
    });

    const lastMessage = messages.at(-1);
    if (hasEndTag(agentSetting, fileContent)) {
      this.logger.debug('End tag detected - skipping continuation');
      if (lastMessage && Array.isArray(lastMessage.content)) {
        // this is suspicious, because the two conflicts!!!
        const lastPart = lastMessage.content[lastMessage.content.length - 1];
        if (lastPart && 'text' in lastPart) {
          lastPart.text = fileContent;
        }
      } else if (lastMessage) {
        lastMessage.content = [
          {
            type: 'text',
            text: fileContent,
          },
        ];
      }
      endTurn = true;
      return [endTurn, messages];
    }

    this.logger.warn(
      'Output file exists but no end tag found - continuing from file',
    );
    if (fileContent.includes(prefill)) {
      toolState.assembly.updateAccumulatedOutput(fileContent);
    } else {
      toolState.assembly.updateAccumulatedOutput(prefill + fileContent);
      await WorkspaceFS.write(outputFile, toolState.assembly.accumulatedOutput);
    }
    const state = new ConversationRoundState(0);
    toolState.assembly.lastResponse = toolState.assembly.accumulatedOutput;
    this.addContinueMessageWithoutPrefill(
      messages,
      state,
      toolState,
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

  /** Creates usage statistics from OpenAI's response format. */
  computeResponseUsage(
    responseUsage: ExtendedCompletionUsage | null,
    responseTime: number,
  ): OpenAIAPIResponseUsage {
    // For Google models, create a minimal usage object with zeros
    if (!responseUsage) {
      const emptyUsage: ExtendedCompletionUsage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        // Note: OpenAI doesn't provide tool_use_tokens, so we don't include it
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: {
          reasoning_tokens: 0,
          accepted_prediction_tokens: undefined,
          rejected_prediction_tokens: undefined,
        },
      };
      return ResponseUsageFactory.fromOpenAIResponse(
        emptyUsage,
        this.computePrice(responseUsage),
        responseTime,
      );
    }

    return ResponseUsageFactory.fromOpenAIResponse(
      responseUsage,
      this.computePrice(responseUsage),
      responseTime,
    );
  }

  /** Updates message content for models with prefill support. */
  updateMessageContentWithPrefill(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    toolState: AgentWorkspaceState,
  ): void {
    this.logger.debug(
      'Updating message content for OpenAI models with prefill support',
    );

    const lastMessage = messages.at(-1);

    if (lastMessage.role === 'assistant') {
      if (Array.isArray(lastMessage.content)) {
        const newMessage = {
          type: 'text',
          text: bestConnector + newResponse,
        };
        lastMessage.content.push(newMessage);
      } else {
        lastMessage.content = [
          {
            type: 'text',
            text: toolState.assembly.accumulatedOutput,
          },
        ];
      }
    } else if (lastMessage.role === 'user' || lastMessage.role === 'system') {
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
    toolState: AgentWorkspaceState,
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
      if (secondLastMessage && secondLastMessage.role === 'assistant') {
        // we get gradually get rid if this kind of isArray conditioning since now we are consistently using the content array
        // but why do the following two differ?
        if (Array.isArray(secondLastMessage.content)) {
          secondLastMessage.content.push({
            type: 'text',
            text: bestConnector + newResponse,
          } as any);
        } else {
          this.logger.error('Second last message content is not a list');
          secondLastMessage.content = [
            {
              type: 'text',
              text: toolState.assembly.accumulatedOutput,
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
        content: [{ type: 'text', text: toolState.assembly.accumulatedOutput }],
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
   * Processes thinking blocks from API response. OpenAI models do not support thinking blocks.
   * @param responseObject The response object from the OpenAI API
   * @param toolState Optional toolState to update with thinking blocks
   * @returns Always returns null as OpenAI doesn't support thinking blocks
   */
  processThinkingBlock(
    responseObject: any,
    toolState?: AgentWorkspaceState,
  ): string | null {
    const reasoning = responseObject?.choices?.[0]?.message?.reasoning_content;
    if (typeof reasoning !== 'string' || !reasoning.trim()) {
      return null;
    }

    if (toolState && !toolState.reasoning.thinkingAdded) {
      toolState.reasoning.thinkingBlocks = [
        { type: 'thinking', thinking: reasoning },
      ];
      toolState.reasoning.thinkingAdded = true;
    }

    this.logger.debug(
      `OpenAI reasoning preview: ${reasoning.substring(0, K_SLICE)}...`,
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

  private isFunctionToolCall(
    call: ChatCompletionMessageToolCall | ChatCompletionMessage.FunctionCall,
  ): call is ChatCompletionMessageFunctionToolCall {
    return (
      typeof (call as ChatCompletionMessageToolCall)?.type === 'string' &&
      (call as ChatCompletionMessageToolCall).type === 'function'
    );
  }

  private isCustomToolCall(
    call: ChatCompletionMessageToolCall | ChatCompletionMessage.FunctionCall,
  ): call is ChatCompletionMessageCustomToolCall {
    return (
      typeof (call as ChatCompletionMessageToolCall)?.type === 'string' &&
      (call as ChatCompletionMessageToolCall).type === 'custom'
    );
  }

  protected normalizeToolCall(
    id: string,
    fallbackName: string,
    call: ChatCompletionMessageToolCall | ChatCompletionMessage.FunctionCall,
  ): ChatCompletionMessageToolCall {
    if (this.isFunctionToolCall(call)) {
      return {
        id: call.id ?? id,
        type: 'function',
        function: {
          name: call.function?.name ?? fallbackName,
          arguments: this.ensureStringifiedArguments(call.function?.arguments),
        },
      };
    }

    if (this.isCustomToolCall(call)) {
      return {
        id: call.id ?? id,
        type: 'custom',
        custom: {
          name: call.custom?.name ?? fallbackName,
          input: this.ensureStringifiedArguments(call.custom?.input),
        },
      };
    }

    return {
      id,
      type: 'function',
      function: {
        name: call.name ?? fallbackName,
        arguments: this.ensureStringifiedArguments(call.arguments),
      },
    };
  }

  extractToolUse(responseObject: any): string | null {
    const toolCalls = responseObject?.choices?.[0]?.message?.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      return JSON.stringify(toolCalls[0], null, 2);
    }
    const func = responseObject?.choices?.[0]?.message?.function_call;
    if (func) {
      return JSON.stringify(func, null, 2);
    }
    return null;
  }

  async createToolUseFollowUpMessages(
    _client: OpenAI | undefined,
    id: string,
    name: string,
    call: ChatCompletionMessageToolCall | ChatCompletionMessage.FunctionCall,
    result: Record<string, unknown>,
    _toolState?: AgentWorkspaceState,
    text?: string,
  ): Promise<ChatCompletionMessageParam[]> {
    const toolCall = this.normalizeToolCall(id, name, call);
    const callMsg: ChatCompletionAssistantMessageParam = {
      role: 'assistant',
      tool_calls: [toolCall],
    };
    if (text) {
      callMsg.content = [{ type: 'text', text }];
    }
    const { attachments, sanitizedResult } = extractToolAttachments(result);
    if (attachments.length > 0) {
      (sanitizedResult as Record<string, unknown>).attachmentSummary =
        `Attachments available:\n${describeAttachments(attachments).join(
          '\n',
        )}\nUse the read_file tool to download them.`;
    }

    const resultMsg: ChatCompletionToolMessageParam = {
      role: 'tool',
      tool_call_id: toolCall.id ?? id,
      content: JSON.stringify(sanitizedResult),
    };
    const messages: ChatCompletionMessageParam[] = [callMsg, resultMsg];
    return messages;
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
    try {
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
    } catch (err) {
      // Log the error and re-throw to indicate failure
      this.logger.error(
        `Error counting tokens: ${getSdkErrorMessage(err)}`,
        undefined,
        undefined,
        err,
      );
      throw err;
    }
  }
}
