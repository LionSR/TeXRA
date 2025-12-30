// Standard library imports
import { Buffer } from 'node:buffer';

// Third-party imports
import { backOff, IBackOffOptions } from 'exponential-backoff';
import OpenAI, { APIConnectionTimeoutError, toFile } from 'openai';

// Local imports - agent
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentSetting } from '@agent/core/AgentDataclass';
// Internal imports
import { AgentType, hasEndTag } from '@agent/core/AgentDataclass';
import { ConversationRoundState } from '@agent/core/AgentState';
import { type OpenAIAPIResponseUsage } from '@agent/core/ResponseUsage';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { MediaEntry } from '@agent/utils/mediaTypes';
import { calculateTokenPrice } from '@agent/utils/priceUtils';
import { getSdkErrorMessage } from '@common/errors/sdkErrorUtils';

// Type imports
import type { ModelConfig } from '@model';

// Internal imports
import { cleanFileContent } from '@replacement/engine';

// Type imports
import type { ToolFileAttachment } from '@tools/result';
import type { FileLocation } from '@utils/files';

// Internal imports
import { K_SLICE, getConfig } from '@utils/config';
import { sleepWithAbort } from '@utils/core';
import { flexibleFS } from '@utils/files';
import { isNonEmptyString } from '@utils/core';
import xmlUtils from '@utils/text/xmlUtils';

// Local file imports
import {
  formatAttachmentSummary,
  loadAttachmentBuffer,
  type ToolResultPayload,
} from './utils/toolAttachmentUtils';
import { executeRequest } from './utils/requestExecutor';
import { OPENAI_CHAT_FINISH } from './types/StopReasonTypes';
import { toOpenAIResponseTools } from './toolConversion';
import { ModelHandler } from './ModelHandler';
import {
  buildOpenAIWebSearchResult,
  extractOpenAIWebSearchResults,
  hasOpenAIWebSearchData,
  isOpenAIReasoningItem,
  isOpenAIServerToolContent,
  isOpenAIWebSearchCall,
  type ServerToolExtractionResult,
} from './types/ServerToolTypes';

// Type imports
import type { ProviderStopReason } from './types/StopReasonTypes';
import type {
  CreateResponseOptions,
  ExtractResponseResult,
  OpenAIResponseToolCall,
} from './types/IModelHandler';
import type { ResponseStreamParams } from 'openai/lib/responses/ResponseStream';
import type { Reasoning } from 'openai/resources/shared';
import type {
  EasyInputMessage,
  Response,
  ResponseUsage,
  ResponseCreateParamsBase,
  ResponseCreateParamsNonStreaming,
  ResponseReasoningItem,
  ResponseFunctionToolCallItem,
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseInputContent,
  ResponseInputMessageContentList,
  ResponseInputFile,
  ResponseStreamEvent,
  ResponseStatus,
  ResponseFunctionCallOutputItemList,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseFunctionWebSearch,
  // Streaming event types
  ResponseTextDeltaEvent,
  ResponseReasoningTextDeltaEvent,
  ResponseReasoningSummaryTextDeltaEvent,
  ResponseOutputItemDoneEvent,
  ResponseWebSearchCallInProgressEvent,
} from 'openai/resources/responses/responses';

interface UploadedOpenAIResponseAttachment {
  attachment: ToolFileAttachment;
  fileId: string;
  isImage: boolean;
}

/**
 * Handler for OpenAI's Responses API. This implementation works directly with
 * the native response message types instead of reusing the chat completion
 * abstractions. Conversation state is maintained through `previous_response_id`
 * so we only submit the new messages for each turn.
 */
export class ModelHandlerOpenAIResponse extends ModelHandler<
  ResponseInputItem,
  ResponseUsage,
  OpenAIAPIResponseUsage,
  OpenAIResponseToolCall,
  OpenAI,
  Response
> {
  private isOpenRouterRoutingEnabled(): boolean {
    return (
      this.config.openRouterOnly ||
      getConfig<boolean>('texra.model.useOpenRouter', false)
    );
  }

  /**
   * OpenAI Response API supports file uploads.
   */
  protected override get supportsToolResultFileUpload(): boolean {
    return true;
  }

  constructor(config: ModelConfig) {
    super(config);
  }

  /**
   * Override streaming config to disable streaming when background mode is enabled.
   * Background responses use polling for completed results, incompatible with streaming.
   * @returns false if background mode is enabled, otherwise delegates to base
   */
  public override getStreamingConfig(): boolean {
    if (this.isBackgroundModeActive()) {
      return false;
    }
    return super.getStreamingConfig();
  }

  /**
   * Check if background mode is active for this handler.
   * Background mode is enabled when the config toggle is on AND
   * this model/agent is eligible for background execution.
   */
  public override isBackgroundModeActive(): boolean {
    const useBackgroundResponses = getConfig<boolean>(
      'texra.model.useBackgroundResponses',
      false,
    );
    return useBackgroundResponses && this.isBackgroundModeEligible();
  }

  protected override backgroundModeSupported = true;

  /**
   * Determines if background mode should be enabled for this request.
   * Background mode is only supported for GPT 5 series models when running
   * workflow agents (CoT or Direct), not tool-use agents.
   * @returns true if background mode is eligible for this model and agent type
   */
  private isBackgroundModeEligible(): boolean {
    const isGpt5 = this.config.name.toLowerCase().startsWith('gpt5');
    if (!isGpt5) {
      return false;
    }

    // Workflow agents are CoT or Direct - must explicitly match known types
    const agentType = this.getAgentType();
    const isWorkflowAgent =
      agentType === AgentType.CoT || agentType === AgentType.Direct;
    return isWorkflowAgent;
  }

  /** Base polling delay for exponential backoff (5 seconds) */
  private static readonly BACKGROUND_POLL_BASE_DELAY_MS = 5000;
  /** Maximum polling delay cap (60 seconds) */
  private static readonly BACKGROUND_POLL_MAX_DELAY_MS = 60000;
  private static readonly BACKGROUND_MAX_DURATION_MS = 3 * 60 * 60 * 1000; // 3 hours
  /** Statuses indicating the background response is still processing. */
  private static readonly BACKGROUND_PENDING_STATUSES: readonly ResponseStatus[] =
    ['queued', 'in_progress'];
  /** Statuses indicating the background response has finished (success or failure). */
  private static readonly BACKGROUND_TERMINAL_STATUSES: readonly ResponseStatus[] =
    ['completed', 'failed', 'cancelled', 'incomplete'];
  private previousResponseId: string | null = null;
  private sentMessages = 0;

  /**
   * Manually set the previous response ID to resume a conversation.
   * Call with `null` to reset the stored ID.
   */
  setPreviousResponseId(id: string | null): void {
    this.previousResponseId = id;
    this.sentMessages = 0;
  }

  /** Retrieve the stored previous response ID. */
  getPreviousResponseId(): string | null {
    return this.previousResponseId;
  }

  /** Creates a configured OpenAI client instance. */
  protected async createOpenAIClient(
    providerName: string = this.config.provider,
  ): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    const baseURL = this.getBaseUrl();
    this.logger.debug(`Using ${providerName} API key. Base URL: ${baseURL}`);
    return new OpenAI({ apiKey, baseURL });
  }

  /** Returns OpenAI client with configured API key. */
  async getClient(): Promise<OpenAI> {
    return this.createOpenAIClient();
  }

  /** Reset conversation bookkeeping when starting a new session. */
  async initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: FileLocation[],
    systemPrompt?: string,
  ): Promise<ResponseInputItem[]> {
    this.previousResponseId = null;
    this.sentMessages = 0;

    const messages: ResponseInputItem[] = [];

    if (systemPrompt) {
      const role = this.capabilities.supportsSystemPrompt ? 'system' : 'user';
      messages.push({
        type: 'message',
        role,
        content: [
          this.createInputText(systemPrompt),
        ] as ResponseInputMessageContentList,
      } as ResponseInputItem);
    }

    const supportsMedia =
      this.capabilities.supportsVision || this.capabilities.supportsNativeAudio;
    const userContent: ResponseInputMessageContentList = [
      this.createInputText(userPrefix),
    ];

    if (mediaFiles && mediaFiles.length > 0 && supportsMedia) {
      try {
        const mediaContent = (await this.createMediaMessage(
          mediaFiles,
        )) as ResponseInputMessageContentList;
        userContent.push(...mediaContent);
      } catch (err) {
        this.logger.logError(
          `Error processing media files: ${getSdkErrorMessage(err)}`,
          err,
          { operation: 'process media files' },
        );
      }
    }

    if (userContent.length > 0) {
      messages.push({
        type: 'message',
        role: 'user',
        content: userContent,
      } as ResponseInputItem);
    }

    const requestRole = this.capabilities.supportsIntermDevMsgs
      ? 'system'
      : 'user';

    if (requestRole === 'user' && messages.length > 0) {
      this.appendInputText(messages.at(-1)!, userRequest);
    } else {
      messages.push({
        type: 'message',
        role: requestRole,
        content: [
          this.createInputText(userRequest),
        ] as ResponseInputMessageContentList,
      } as ResponseInputItem);
    }

    return messages;
  }

  /** Adds user message content for subsequent rounds. */
  async createRoundMessages(
    messages: ResponseInputItem[],
    userMessage: string,
    mediaFiles?: FileLocation[],
  ): Promise<ResponseInputItem[]> {
    const roundContent: ResponseInputMessageContentList = [];

    if (
      mediaFiles &&
      mediaFiles.length > 0 &&
      (this.capabilities.supportsVision ||
        this.capabilities.supportsNativeAudio)
    ) {
      try {
        const formattedMediaContent = (await this.createMediaMessage(
          mediaFiles,
        )) as ResponseInputMessageContentList;
        roundContent.push(...formattedMediaContent);
      } catch (err) {
        this.logger.logError(
          `Error processing media files for follow-up round: ${getSdkErrorMessage(err)}`,
          err,
          { operation: 'process media files' },
        );
      }
    }

    roundContent.push(this.createInputText(userMessage));

    messages.push({
      type: 'message',
      role: 'user',
      content: roundContent,
    } as ResponseInputItem);

    return messages;
  }

  /** Formats image/audio content for the Responses API. */
  createMediaContent(mediaMessage: MediaEntry[]): ResponseInputContent[] {
    return mediaMessage.flatMap((media): ResponseInputContent[] => {
      const mediaType = media.media_type ?? '';

      if (
        media.media_category === 'image' &&
        typeof mediaType === 'string' &&
        mediaType.startsWith('image/')
      ) {
        return [
          this.createInputText(`Image: ${media.file_name}`),
          {
            type: 'input_image',
            image_url: `data:${mediaType};base64,${media.data}`,
            detail: 'high',
          },
        ];
      }

      // Audio input is documented but not functional in the Responses API
      // See: https://community.openai.com/t/audio-input-not-working-when-migrating-from-completions-to-responses/1364108/3
      // See: https://github.com/openai/openai-node/commit/9909fef596280fc16174679d97c3e81543c68646
      // TODO: Re-enable when OpenAI makes audio input functional
      if (media.media_category === 'audio') {
        this.logger.warn(
          `Audio input received (${media.file_name}) but the Responses API does not currently support audio input. Skipping.`,
        );
        return [];
      }

      if (mediaType === 'application/pdf') {
        return [
          this.createInputText(`Document: ${media.file_name}`),
          {
            type: 'input_file',
            file_data: media.data,
            filename: media.file_name,
          },
        ];
      }

      if (media.media_category === 'image') {
        this.logger.warn(
          `Skipping media ${media.file_name} with unsupported image MIME type: ${mediaType}`,
        );
        return [];
      }

      this.logger.warn(`Unknown media category: ${media.media_category}`);
      return [];
    });
  }

  private isInputFileContent(
    content: ResponseInputContent,
  ): content is ResponseInputFile {
    return content.type === 'input_file';
  }

  private async uploadInlineInputFiles(
    client: OpenAI,
    messageItems: ResponseInputItem[],
  ): Promise<void> {
    for (const item of messageItems) {
      if (!this.isMessageItem(item)) {
        continue;
      }

      const contentList = (
        item as ResponseInputItem & {
          content?: ResponseInputMessageContentList;
        }
      ).content;

      if (!Array.isArray(contentList)) {
        continue;
      }

      for (const content of contentList) {
        if (
          this.isInputFileContent(content) &&
          content.file_data &&
          !content.file_id
        ) {
          await this.replaceFileDataWithUpload(client, content);
        }
      }
    }
  }

  private async replaceFileDataWithUpload(
    client: OpenAI,
    content: ResponseInputFile,
  ): Promise<void> {
    if (this.isOpenRouterRoutingEnabled()) {
      this.logger.debug(
        'OpenRouter routing active; skipping inline file upload.',
      );
      return;
    }

    const fileData = content.file_data;
    if (!fileData) {
      return;
    }

    const filename = content.filename ?? 'document.pdf';
    let buffer: Buffer | undefined;

    try {
      const base64Separator = ';base64,';
      const separatorIndex = fileData.indexOf(base64Separator);
      const payload =
        separatorIndex >= 0
          ? fileData.slice(separatorIndex + base64Separator.length)
          : fileData;

      buffer = Buffer.from(payload, 'base64');
      const uploadedFile = await executeRequest(
        {
          model: this.config.name,
          operation: `openai.files.create:${filename}`,
        },
        async () =>
          client.files.create({
            file: await toFile(buffer!, filename),
            purpose: 'assistants',
          }),
      );

      content.file_id = uploadedFile.id;
      delete content.file_data;
      if ('filename' in content) {
        delete content.filename;
      }
    } catch (err) {
      const errorMessage = getSdkErrorMessage(err);

      if (
        err instanceof APIConnectionTimeoutError ||
        errorMessage.includes('Request timed out')
      ) {
        this.logger.warn(
          `Timed out uploading file ${filename}. Falling back to inline payload.`,
        );
        return;
      }

      this.logger.logError(
        `Failed to upload file ${filename}: ${errorMessage}`,
        err,
        { operation: 'upload file' },
      );
      throw err;
    } finally {
      if (buffer) {
        buffer.fill(0);
        buffer = undefined;
      }
    }
  }

  /**
   * Create a response using the Responses API.
   * The handler submits only the messages that were not part of the previous
   * request and relies on `previous_response_id` for conversation context.
   */
  async createResponse(
    options: CreateResponseOptions<ResponseInputItem, OpenAI>,
  ): Promise<Response> {
    const { client, messages, temperature, systemPrompt, signal, tools } =
      options;
    const streamingToggleEnabled = this.getStreamingConfig();
    const backgroundToggleEnabled = getConfig<boolean>(
      'texra.model.useBackgroundResponses',
      false,
    );
    const isEligible = this.isBackgroundModeEligible();
    if (backgroundToggleEnabled && !this.backgroundModeSupported) {
      this.logger.debug(
        'Background mode toggle is enabled but this handler does not support background execution. Falling back to synchronous requests.',
      );
    }
    if (
      backgroundToggleEnabled &&
      this.backgroundModeSupported &&
      !isEligible
    ) {
      this.logger.debug(
        'Background mode toggle is enabled but not eligible for this model/agent type (requires GPT 5 series with workflow agents). Falling back to synchronous requests.',
      );
    }
    const useBackgroundResponses =
      this.backgroundModeSupported && backgroundToggleEnabled && isEligible;
    const useStreaming = streamingToggleEnabled && !useBackgroundResponses;

    if (streamingToggleEnabled && useBackgroundResponses) {
      this.logger.debug(
        'Background mode enabled; skipping streaming to avoid unstable behavior.',
      );
    }
    const newMessages = messages.slice(this.sentMessages);

    await this.uploadInlineInputFiles(client, newMessages);

    const params: ResponseCreateParamsBase = {
      model: this.config.fullName,
      input: newMessages,
      max_output_tokens: this.config.maxOutputTokens,
      store: true,
    };

    if (useBackgroundResponses) {
      this.logger.debug(
        'Submitting OpenAI Responses request in background mode.',
        {
          data: {
            model: this.config.fullName,
            previousResponseId: this.previousResponseId ?? undefined,
          },
        },
      );
      params.background = true;
    }

    if (!this.isOReasoningModel) {
      params.temperature = temperature;
    }

    if (this.previousResponseId) {
      params.previous_response_id = this.previousResponseId;
    }

    if (systemPrompt) {
      params.instructions = systemPrompt;
    }

    if (tools && tools.length > 0) {
      const convertedTools = toOpenAIResponseTools(tools, {
        supportsNativeWebSearch: this.capabilities.supportsNativeWebSearch,
        supportsFunctionCalling: this.capabilities.supportsFunctionCalling,
      });
      // Only set tools if there are any after filtering (deep research models
      // strip unsupported function tools, potentially leaving an empty array)
      if (convertedTools.length > 0) {
        params.tools = convertedTools;
        params.tool_choice = 'auto';
      }
    }

    // Include web search sources in response when native web search is enabled.
    // This is set outside the tools block because deep research models use
    // native web search even when no explicit tools are passed.
    if (this.capabilities.supportsNativeWebSearch) {
      params.include = ['web_search_call.action.sources'];
    }

    if (this.capabilities.supportsReasoning) {
      const isGpt5 = this.config.name.startsWith('gpt5');
      const includeSummary =
        !isGpt5 ||
        getConfig<boolean>('texra.model.gpt5ReasoningSummary', false);
      const reasoning: Reasoning = {};
      if (includeSummary) {
        reasoning.summary = 'auto';
      }
      if (
        this.capabilities.supportsReasoningEffort &&
        this.capabilities.reasoningEffort &&
        this.capabilities.reasoningEffort !== 'none'
      ) {
        reasoning.effort = this.capabilities.reasoningEffort;
      }
      params.reasoning = reasoning;
    }

    if (useStreaming) {
      const { stream: _stream, ...rest } = params;
      const streamParams: ResponseStreamParams = { ...rest, stream: true };
      const stream = await executeRequest(
        {
          model: this.config.name,
          operation: 'openai.responses.stream',
          signal,
        },
        () => client.responses.stream(streamParams, { signal }),
      );

      // State for handling interleaved thinking and web search
      // GPT can: think → web_search → think more → web_search → text
      const state = {
        thinkingStream: this.createThinkingStream(),
        outputStream: this.isOutputStreamingEnabled()
          ? this.createOutputStream()
          : null,
        emittedWebSearchIds: new Set<string>(),
        hasThinkingContent: false,
      };

      for await (const event of stream) {
        if (this.isReasoningDeltaEvent(event)) {
          state.thinkingStream.append(event.delta);
          state.hasThinkingContent = true;
        } else if (this.isTextDeltaEvent(event)) {
          state.outputStream?.append(event.delta);
        } else if (this.isWebSearchInProgressEvent(event)) {
          // Web search starting - finalize current thinking stream
          // Don't emit placeholder here - wait for output_item.done with full data
          if (state.hasThinkingContent) {
            state.thinkingStream.finalize();
            state.hasThinkingContent = false;
            // Create new thinking stream for potential continuation after search
            state.thinkingStream = this.createThinkingStream();
          }
        } else if (this.isOutputItemDoneEvent(event)) {
          // When output item is done, we can get the full web search data
          const item = event.item;
          if (
            this.isWebSearchItem(item) &&
            !state.emittedWebSearchIds.has(item.id) &&
            hasOpenAIWebSearchData(item)
          ) {
            // Finalize thinking if we have content (in case in_progress didn't fire)
            if (state.hasThinkingContent) {
              state.thinkingStream.finalize();
              state.hasThinkingContent = false;
              state.thinkingStream = this.createThinkingStream();
            }
            this.emitOpenAIWebSearch(item);
            state.emittedWebSearchIds.add(item.id);
          }
        }
      }

      const response = await stream.finalResponse();
      // Finalize any remaining thinking content (only if there's actual content)
      if (state.hasThinkingContent) {
        state.thinkingStream.finalize();
      }
      const { response: finalText } = this.extractResponse(response, '');
      if (state.outputStream) state.outputStream.finalize(finalText);

      // Emit any web searches not yet emitted (fallback for edge cases)
      this.emitWebSearchesFromResponse(response, state.emittedWebSearchIds);

      this.previousResponseId = response.id;
      this.sentMessages = messages.length;
      return response;
    }

    // Non-streaming path
    // Errors propagate to PocketFlow's execFallback which logs once (log at boundary principle)
    const { stream: _nonStream, ...nonStreamRest } = params;
    const nonStreamingParams: ResponseCreateParamsNonStreaming = {
      ...nonStreamRest,
      stream: false,
    };
    let response = await executeRequest(
      {
        model: this.config.name,
        operation: 'openai.responses.create',
        signal,
      },
      () => client.responses.create(nonStreamingParams, { signal }),
    );
    if (useBackgroundResponses) {
      this.logger.debug(
        `Background response ${response.id} created with status ${
          response.status ?? 'unknown'
        }`,
        {
          data: {
            responseId: response.id,
            status: response.status,
            usage: response.usage ?? undefined,
          },
        },
      );
      this.logger.logProgress(
        `Running OpenAI Responses in background mode for response ${response.id}; polling every 15s. Completion may take longer than usual.`,
      );
    }
    if (useBackgroundResponses) {
      response = await this.waitForBackgroundCompletion(
        client,
        response,
        signal,
      );
    }
    this.previousResponseId = response.id;
    this.sentMessages = messages.length;
    return response;
  }

  /**
   * Extract plain text and usage information from the Responses API result.
   *
   * Note: OpenAI's Responses API streaming can sometimes return missing or null
   * usage data, especially with thinking models through relay proxies. We handle
   * this gracefully by using zero defaults rather than failing.
   * See: https://github.com/openai/openai-agents-python/issues/1179
   */
  extractResponse(
    responseObject: Response,
    endTag: string,
  ): ExtractResponseResult {
    // Handle missing usage gracefully - OpenAI streaming may not always include it
    const usage: ResponseUsage = responseObject.usage ?? {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    };
    if (!responseObject.usage) {
      this.logger.warn(
        'Response missing usage information - token counts will show as 0',
      );
    }
    let newResponse = responseObject.output_text?.trim() ?? '';

    if (!newResponse && responseObject.output) {
      const fallbackSegments: string[] = [];

      for (const item of responseObject.output) {
        if (!this.isOutputMessage(item)) {
          continue;
        }

        for (const part of item.content) {
          if (part.type === 'output_text') {
            fallbackSegments.push(part.text);
          }
        }
      }

      const fallbackText = fallbackSegments.join('').trim();
      if (fallbackText) {
        newResponse = fallbackText;
      }
    }

    const stopReason =
      responseObject.status === 'completed'
        ? OPENAI_CHAT_FINISH.STOP
        : OPENAI_CHAT_FINISH.LENGTH;

    if (
      stopReason === OPENAI_CHAT_FINISH.STOP &&
      endTag &&
      !newResponse.includes(endTag)
    ) {
      return { response: `${newResponse}\n${endTag}`, usage, stopReason };
    }

    return { response: newResponse, usage, stopReason };
  }

  /** Price computation adapted for Responses API token fields. */
  computePrice(responseUsage: ResponseUsage): number {
    const promptTokens = responseUsage.input_tokens ?? 0;
    const completionTokens = responseUsage.output_tokens ?? 0;

    let basePrice = calculateTokenPrice(
      promptTokens,
      completionTokens,
      this.config.inputPrice,
      this.config.outputPrice,
    );

    const reasoningTokens =
      responseUsage.output_tokens_details?.reasoning_tokens ?? 0;
    const cachedTokens = responseUsage.input_tokens_details?.cached_tokens ?? 0;

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

  /** Normalizes OpenAI Responses API usage data into a unified format. */
  normalizeUsage(
    rawUsage: ResponseUsage,
    responseTimeMs: number,
  ): NormalizedUsage {
    if (!rawUsage) {
      return {
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        responseTimeMs,
        provider: 'openai-response',
      };
    }

    const inputTokens = rawUsage.input_tokens ?? 0;
    const outputTokens = rawUsage.output_tokens ?? 0;
    const cachedTokens = rawUsage.input_tokens_details?.cached_tokens ?? 0;
    const reasoningTokens =
      rawUsage.output_tokens_details?.reasoning_tokens ?? 0;

    // Calculate percentage cached
    const percentageCached =
      inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0;

    return {
      inputTokens,
      outputTokens,
      cost: this.computePrice(rawUsage),
      responseTimeMs,
      provider: 'openai-response',
      cachedInputTokens: cachedTokens || undefined,
      percentageCached: percentageCached > 0 ? percentageCached : undefined,
      reasoningTokens: reasoningTokens || undefined,
      _native: rawUsage,
    };
  }

  /** Models with prefill support do not require additional continuation messages. */
  addContinueMessageWithPrefill(
    _messages: ResponseInputItem[],
    _stateRound: ConversationRoundState,
    _workspaceState: AgentWorkspaceState,
    _agentSetting: AgentSetting,
    _agentConfig: AgentConfig,
  ): void {
    this.defaultAddContinueWithPrefill();
  }

  private isBackgroundPending(response: Response): boolean {
    const status = response.status;
    if (!status) {
      return false;
    }

    return ModelHandlerOpenAIResponse.BACKGROUND_PENDING_STATUSES.includes(
      status,
    );
  }

  private async waitForBackgroundCompletion(
    client: OpenAI,
    initialResponse: Response,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (!initialResponse.id) {
      return initialResponse;
    }

    const responseId = initialResponse.id;
    const startTime = Date.now();
    let pollCount = 0;
    const initialStatus = initialResponse.status ?? 'unknown';

    this.logger.debug(
      `Background polling started for response ${responseId} (status: ${initialStatus})`,
      {
        data: {
          responseId,
          status: initialResponse.status,
        },
      },
    );

    // If already complete, return immediately
    if (!this.isBackgroundPending(initialResponse)) {
      return this.validateBackgroundResponse(initialResponse, responseId, pollCount, startTime);
    }

    // Custom error class to signal that polling should continue
    class PendingError extends Error {
      constructor(public response: Response) {
        super('Response still pending');
        this.name = 'PendingError';
      }
    }

    const backOffOptions: Partial<IBackOffOptions> = {
      // Start with 5 second delay, exponentially increasing
      startingDelay: ModelHandlerOpenAIResponse.BACKGROUND_POLL_BASE_DELAY_MS,
      // Cap at 60 seconds between polls
      maxDelay: ModelHandlerOpenAIResponse.BACKGROUND_POLL_MAX_DELAY_MS,
      // Use full jitter for graceful polling (prevents thundering herd)
      jitter: 'full',
      // Calculate max attempts based on timeout (generous upper bound)
      // With exponential backoff, we'll hit timeout before this limit
      numOfAttempts: 1000,
      // Custom retry logic
      retry: (error: Error, attemptNumber: number) => {
        // Check for abort signal
        if (signal?.aborted) {
          this.logger.warn(
            `Background polling aborted for response ${responseId}`,
            {
              data: {
                responseId,
                pollCount: attemptNumber,
                elapsedMs: Date.now() - startTime,
              },
            },
          );
          return false;
        }

        // Check for timeout
        const elapsedMs = Date.now() - startTime;
        if (elapsedMs > ModelHandlerOpenAIResponse.BACKGROUND_MAX_DURATION_MS) {
          this.logger.error(
            `Background response ${responseId} exceeded maximum polling duration`,
            {
              data: {
                responseId,
                pollCount: attemptNumber,
                elapsedMs,
              },
            },
          );
          return false;
        }

        // Only retry on PendingError (response still processing)
        return error instanceof PendingError;
      },
    };

    try {
      const finalResponse = await backOff(async () => {
        pollCount++;
        const requestOptions = signal ? { signal } : undefined;

        const current = await executeRequest(
          {
            model: this.config.name,
            operation: `openai.responses.retrieve:${responseId}`,
            signal,
          },
          () => client.responses.retrieve(responseId, undefined, requestOptions),
        );

        this.logger.debug(
          `Background poll ${pollCount} for response ${responseId}: status=${
            current.status ?? 'unknown'
          }`,
          {
            data: {
              responseId,
              status: current.status,
              pollCount,
            },
          },
        );

        // If still pending, throw to trigger retry with backoff
        if (this.isBackgroundPending(current)) {
          throw new PendingError(current);
        }

        return current;
      }, backOffOptions);

      return this.validateBackgroundResponse(finalResponse, responseId, pollCount, startTime);
    } catch (error) {
      // Handle timeout exceeded
      const elapsedMs = Date.now() - startTime;
      if (elapsedMs > ModelHandlerOpenAIResponse.BACKGROUND_MAX_DURATION_MS) {
        throw new Error(
          `Background response ${responseId} exceeded maximum polling duration of ${ModelHandlerOpenAIResponse.BACKGROUND_MAX_DURATION_MS} ms. Retry later or cancel the job with client.responses.cancel("${responseId}").`,
        );
      }

      // Handle abort
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }

      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Validate the final background response and log completion details.
   */
  private validateBackgroundResponse(
    response: Response,
    responseId: string,
    pollCount: number,
    startTime: number,
  ): Response {
    const elapsedMs = Date.now() - startTime;
    this.logger.debug(
      `Background polling finished for response ${responseId} with status=${
        response.status ?? 'unknown'
      } after ${pollCount} polls (${elapsedMs} ms)`,
      {
        data: {
          responseId,
          status: response.status,
          pollCount,
          elapsedMs,
          usage: response.usage ?? undefined,
        },
      },
    );

    const finalStatus = response.status;
    const isTerminal =
      finalStatus !== undefined &&
      ModelHandlerOpenAIResponse.BACKGROUND_TERMINAL_STATUSES.includes(
        finalStatus,
      );

    if (!isTerminal) {
      this.logger.warn(
        `Background response ${responseId} returned non-terminal status ${finalStatus ?? 'unknown'} after polling loop`,
        {
          data: {
            responseId,
            status: finalStatus,
            pollCount,
            elapsedMs,
          },
        },
      );
    }

    if (response.status !== 'completed') {
      const fallbackStatus = response.status ?? 'unknown';
      const errorDetail =
        response.error?.message ??
        response.incomplete_details?.reason ??
        'Background response did not complete successfully.';
      this.logger.error(
        `Background response ${responseId} ended with status ${fallbackStatus}`,
        {
          data: {
            responseId,
            status: response.status,
            error: response.error ?? undefined,
            incomplete: response.incomplete_details ?? undefined,
          },
        },
      );
      throw new Error(
        `Background response ${responseId} ended with status ${fallbackStatus}: ${errorDetail}. Retrieve the latest status with client.responses.retrieve("${responseId}").`,
      );
    }

    return response;
  }

  /** Adds continuation instructions for models without prefill support. */
  addContinueMessageWithoutPrefill(
    messages: ResponseInputItem[],
    _stateRound: ConversationRoundState,
    workspaceState: AgentWorkspaceState,
    agentSetting: AgentSetting,
    _agentConfig: AgentConfig,
  ): void {
    const userMessageContinuation = this.createContinuationPrompt(
      workspaceState,
      agentSetting,
    );

    const role = this.capabilities.supportsIntermDevMsgs ? 'system' : 'user';
    messages.push({
      type: 'message',
      role,
      content: [
        this.createInputText(userMessageContinuation),
      ] as ResponseInputMessageContentList,
    } as ResponseInputItem);
  }

  /** Initializes output file and handles prefill content. */
  async initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: ResponseInputItem[],
    workspaceState: AgentWorkspaceState,
    outputLocation: FileLocation,
    prefill: string,
  ): Promise<[boolean, ResponseInputItem[]]> {
    let endTurn = false;

    if (!(await flexibleFS.existsAndNonTrivial(outputLocation))) {
      const pseudoPrefill = `Organize your response with xml tags. Start your response with:\n${prefill}`;
      const lastMessage = messages.at(-1);
      if (lastMessage) {
        this.appendInputText(lastMessage, pseudoPrefill);
      } else {
        messages.push({
          type: 'message',
          role: 'user',
          content: [
            this.createInputText(pseudoPrefill),
          ] as ResponseInputMessageContentList,
        } as ResponseInputItem);
      }
      this.logger.debug(
        `Added pseudo prefill message to messages:\n${pseudoPrefill}`,
      );
      return [endTurn, messages];
    }

    let fileContent = await flexibleFS.read(outputLocation);
    fileContent = cleanFileContent(fileContent);

    const scratchpad = await xmlUtils.extractScratchpad(
      fileContent,
      'scratchpad',
    );
    if (scratchpad) {
      this.logger.logScratchpad(scratchpad);
    }

    await flexibleFS.write(outputLocation, fileContent);

    // Update workspace state - critical for multi-round agents on resume
    // so that subsequent rounds have correct context
    workspaceState.assembly.updateAccumulatedOutput(fileContent);
    workspaceState.assembly.updateLastResponse(fileContent);

    messages.push(this.createAssistantMessage(fileContent));

    if (hasEndTag(agentSetting, fileContent)) {
      this.logger.debug('End tag detected - skipping continuation');
      endTurn = true;
      return [endTurn, messages];
    }

    this.logger.warn(
      'Output file exists but no end tag found - continuing from file',
    );
    // Note: workspace state already updated above (lines 1108-1109)
    // Only need to handle case where prefill needs to be prepended
    if (!fileContent.includes(prefill)) {
      workspaceState.assembly.updateAccumulatedOutput(prefill + fileContent);
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

  /** Updates message content for models with prefill support. */
  updateMessageContentWithPrefill(
    messages: ResponseInputItem[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void {
    this.logger.debug(
      'Updating message content for OpenAI Responses models with prefill support',
    );

    const lastMessage = messages.at(-1);
    if (
      lastMessage &&
      this.appendAssistantText(lastMessage, `${bestConnector}${newResponse}`)
    ) {
      return;
    }

    messages.push(
      this.createAssistantMessage(workspaceState.assembly.accumulatedOutput),
    );
  }

  /** Updates message content for models without prefill support. */
  updateMessageContentWithoutPrefill(
    messages: ResponseInputItem[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void {
    this.logger.debug(
      'Updating message content for OpenAI Responses models without prefill support',
    );

    const lastMessage = messages.at(-1);
    const secondLastMessage = messages.at(-2);

    if (!this.isMessageItem(lastMessage)) {
      this.logger.error(
        'Last message is not a message item - unexpected format',
      );
      return;
    }

    const lastContent = this.getMessageContent(lastMessage);

    if (lastContent && this.containCutOffMessage(lastContent)) {
      this.logger.debug(
        'Last message is a user message asking to continue after cut off',
      );
      if (secondLastMessage) {
        const appended = this.appendAssistantText(
          secondLastMessage,
          `${bestConnector}${newResponse}`,
        );
        const trailingMessage = messages.at(-1);
        if (
          this.isMessageItem(trailingMessage) &&
          trailingMessage.role === 'user'
        ) {
          messages.pop();
        } else if (!appended) {
          messages.push(
            this.createAssistantMessage(
              workspaceState.assembly.accumulatedOutput,
            ),
          );
        }
      }
    } else {
      this.logger.debug(
        'Last message is a request message rather than a continuation request',
      );
      messages.push(
        this.createAssistantMessage(workspaceState.assembly.accumulatedOutput),
      );
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
   * Process reasoning summaries from the Responses API.
   *
   * Collects ALL reasoning items from the response output, not just the first.
   * This is important when native search is enabled because the model may produce
   * multiple reasoning items (e.g., one before web_search_call, one before function_call).
   */
  processThinkingBlock(
    responseObject: Response,
    workspaceState?: AgentWorkspaceState,
  ): string | null {
    const outputArr = responseObject?.output;
    if (!Array.isArray(outputArr)) {
      return null;
    }

    // Collect ALL reasoning items, not just the first
    // This handles cases where native search produces multiple reasoning blocks
    const reasoningItems = outputArr.filter(
      (item): item is ResponseReasoningItem => item?.type === 'reasoning',
    );

    if (reasoningItems.length === 0) {
      return null;
    }

    // Flatten all summary parts from all reasoning items
    const allSummaryParts = reasoningItems.flatMap(
      (item) => item.summary ?? [],
    );

    if (allSummaryParts.length === 0) {
      return null;
    }

    const thoughtContent = allSummaryParts
      .map((part) => part.text)
      .join('\n\n'); // to make the thinking markdown rendering more readable

    if (workspaceState) {
      workspaceState.reasoning.thinkingBlocks = allSummaryParts.map((part) => ({
        type: 'thinking',
        thinking: part.text,
      }));
      workspaceState.reasoning.thinkingAdded = true;
    }

    if (thoughtContent) {
      this.logger.debug(
        `OpenAI Responses reasoning preview (${reasoningItems.length} item(s)): ${thoughtContent.substring(0, K_SLICE)}...`,
      );
    }

    return thoughtContent || null;
  }

  private parseArguments(raw: unknown): unknown {
    if (typeof raw !== 'string') {
      return raw;
    }

    try {
      return JSON.parse(raw);
    } catch (error) {
      this.logger.warn(
        'OpenAI Responses tool call arguments could not be parsed as JSON; using raw string.',
        { data: error },
      );
      return raw;
    }
  }

  extractToolUse(response: Response): OpenAIResponseToolCall[] {
    const items = response?.output;
    if (!Array.isArray(items)) return [];

    const calls = items.filter(
      (it): it is ResponseFunctionToolCallItem => it?.type === 'function_call',
    );
    if (calls.length === 0) {
      return [];
    }

    return calls
      .filter((call) => Boolean(call.call_id && call.name))
      .map((call) => ({
        provider: 'openai-response',
        callId: call.call_id!,
        name: call.name!,
        input: this.parseArguments(call.arguments),
        raw: call,
      }));
  }

  /**
   * Extract all server tool data in a single pass.
   * Returns both normalized results for display and raw content blocks for context.
   * Single source of truth for OpenAI Responses API server tool extraction.
   *
   * Note: We include reasoning items ONLY when they immediately precede a
   * web_search_call item. This satisfies two API requirements:
   * - "web_search_call was provided without its required 'reasoning' item"
   * - "reasoning was provided without its required following item"
   *
   * Reasoning items followed by function_call are NOT included here because
   * function_call items are handled separately by the tool use flow.
   */
  override extractServerToolData(
    response: Response,
  ): ServerToolExtractionResult {
    const output = response?.output;
    if (!Array.isArray(output)) {
      return { webSearchResults: [], contentBlocks: [] };
    }

    // Extract content blocks that need to be preserved
    // Only include reasoning items that are immediately followed by web_search_call
    // to satisfy both API requirements (reasoning needs following item, web_search needs preceding reasoning)
    const contentBlocks: (ResponseFunctionWebSearch | ResponseReasoningItem)[] =
      [];
    for (let i = 0; i < output.length; i++) {
      const item = output[i];
      if (isOpenAIWebSearchCall(item)) {
        // Check if there's a reasoning item immediately before this web_search_call
        if (i > 0 && isOpenAIReasoningItem(output[i - 1])) {
          contentBlocks.push(output[i - 1] as ResponseReasoningItem);
        }
        contentBlocks.push(item);
      }
    }

    // Extract normalized web search results for display
    const webSearchResults = extractOpenAIWebSearchResults(output);

    return { webSearchResults, contentBlocks };
  }

  async createToolUseFollowUpMessages(
    client: OpenAI | undefined,
    call: OpenAIResponseToolCall,
    result: ToolResultPayload,
    attachments: ToolFileAttachment[],
    workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<ResponseInputItem[]> {
    const messages: ResponseInputItem[] = [];
    if (text) {
      messages.push(this.createAssistantMessage(text));
    }

    // Include server tool content blocks (reasoning, web_search_call) from workspace state
    // These need to be preserved when both server and local tools are in the same response.
    // Reasoning items must be included when web_search_call references them.
    if (workspaceState?.serverToolContent.contentBlocks.length) {
      // Filter to only OpenAI server tool content (reasoning + web_search_call)
      const openaiBlocks = workspaceState.serverToolContent.contentBlocks
        .filter(isOpenAIServerToolContent)
        .map((block) => block as ResponseInputItem);
      messages.push(...openaiBlocks);
      // Clear after consuming to prevent duplicates - use reset method for consistency
      workspaceState.resetServerToolContent();
    }

    const callMsg: ResponseFunctionToolCall = {
      type: 'function_call',
      call_id: call.callId,
      name: call.name,
      arguments: call.raw.arguments,
    };

    // Create mutable copy for adding attachmentSummary/files
    const finalResult: ToolResultPayload = { ...result };
    const canUploadFiles = this.supportsToolResultFileUpload;

    let uploadedAttachments: UploadedOpenAIResponseAttachment[] = [];
    if (canUploadFiles && attachments.length > 0 && client) {
      uploadedAttachments = await this.uploadToolAttachments(
        client,
        attachments,
      );
      if (uploadedAttachments.length > 0) {
        finalResult.files = uploadedAttachments.map(
          ({ attachment, fileId }) => ({
            path: attachment.path,
            mimeType: attachment.mimeType,
            description: attachment.description,
            fileId,
          }),
        );
      }
    }

    if (
      attachments.length > 0 &&
      (!canUploadFiles || !client || uploadedAttachments.length === 0)
    ) {
      finalResult.attachmentSummary = formatAttachmentSummary(attachments);
    }

    const primaryText = isNonEmptyString(result.output)
      ? result.output
      : isNonEmptyString(result.summary)
        ? result.summary
        : undefined;
    const summaryPayload = JSON.stringify(finalResult, null, 2);
    const combinedText = primaryText
      ? `${primaryText}\n\n${summaryPayload}`
      : summaryPayload;

    let outputPayload: string | ResponseFunctionCallOutputItemList;

    if (uploadedAttachments.length > 0) {
      const parts: ResponseFunctionCallOutputItemList = [
        { type: 'input_text', text: combinedText },
      ];

      for (const uploaded of uploadedAttachments) {
        if (this.canProcessToolResultAttachments && uploaded.isImage) {
          parts.push({
            type: 'input_image',
            detail: 'auto',
            file_id: uploaded.fileId,
          });
          continue;
        }

        parts.push({ type: 'input_file', file_id: uploaded.fileId });
      }

      outputPayload = parts;
    } else {
      outputPayload = combinedText;
    }

    const resultMsg: ResponseInputItem.FunctionCallOutput = {
      type: 'function_call_output',
      call_id: call.callId,
      output: outputPayload,
    };

    messages.push(callMsg, resultMsg);
    return messages;
  }

  private async uploadToolAttachments(
    client: OpenAI,
    attachments: ToolFileAttachment[],
  ): Promise<UploadedOpenAIResponseAttachment[]> {
    if (this.isOpenRouterRoutingEnabled()) {
      this.logger.debug(
        'OpenRouter routing active; skipping tool attachment uploads.',
      );
      return [];
    }

    const uploaded: UploadedOpenAIResponseAttachment[] = [];

    for (const attachment of attachments) {
      let buffer: Buffer | undefined;
      try {
        buffer = await loadAttachmentBuffer(attachment);
      } catch (err) {
        this.logger.warn(
          `Unable to read attachment ${attachment.path ?? 'attachment'}: ${getSdkErrorMessage(err)}`,
        );
        continue;
      }

      try {
        const filename =
          typeof attachment.path === 'string' && attachment.path.length > 0
            ? (attachment.path.split('/').pop() ?? 'attachment')
            : 'attachment';
        const mimeType = attachment.mimeType ?? 'application/octet-stream';

        const uploadedFile = await executeRequest(
          {
            model: this.config.name,
            operation: `openai.files.create:${filename}`,
          },
          async () =>
            client.files.create({
              file: await toFile(buffer!, filename, { type: mimeType }),
              purpose: 'assistants',
            }),
        );

        uploaded.push({
          attachment,
          fileId: uploadedFile.id,
          isImage: mimeType.startsWith('image/'),
        });
      } catch (err) {
        // Logged via retry helper
      } finally {
        if (buffer) {
          buffer.fill(0);
          buffer = undefined;
        }
      }
    }

    return uploaded;
  }

  async createUserFollowUpMessages(
    messages: ResponseInputItem[],
    userMessage: string,
  ): Promise<ResponseInputItem[]> {
    messages.push({
      type: 'message',
      role: 'user',
      content: [
        this.createInputText(userMessage),
      ] as ResponseInputMessageContentList,
    } as ResponseInputItem);
    return messages;
  }

  createAssistantMessage(text: string): EasyInputMessage {
    return {
      type: 'message',
      role: 'assistant',
      content: text,
    } satisfies EasyInputMessage;
  }

  private createInputText(text: string): ResponseInputContent {
    return { type: 'input_text', text };
  }

  private isMessageItem(
    item?: ResponseInputItem,
  ): item is EasyInputMessage | ResponseInputItem.Message {
    if (!item || typeof item !== 'object') {
      return false;
    }

    const role = (item as { role?: unknown }).role;
    if (typeof role !== 'string') {
      return false;
    }

    const type = (item as { type?: unknown }).type;
    if (typeof type === 'string' && type !== 'message') {
      return false;
    }

    const content = (item as { content?: unknown }).content;
    return typeof content === 'string' || Array.isArray(content);
  }

  /** Type guard for ResponseOutputMessage items from the SDK. */
  private isOutputMessage(
    item: ResponseOutputItem,
  ): item is ResponseOutputMessage {
    return item.type === 'message';
  }

  /** Type alias for reasoning delta events (both raw and summary). */
  private isReasoningDeltaEvent(
    event: ResponseStreamEvent,
  ): event is
    | ResponseReasoningTextDeltaEvent
    | ResponseReasoningSummaryTextDeltaEvent {
    return (
      event.type === 'response.reasoning_text.delta' ||
      event.type === 'response.reasoning_summary_text.delta'
    );
  }

  /** Type guard for web search in_progress events. */
  private isWebSearchInProgressEvent(
    event: ResponseStreamEvent,
  ): event is ResponseWebSearchCallInProgressEvent {
    return event.type === 'response.web_search_call.in_progress';
  }

  /** Type guard for text output delta events. */
  private isTextDeltaEvent(
    event: ResponseStreamEvent,
  ): event is ResponseTextDeltaEvent {
    return event.type === 'response.output_text.delta';
  }

  /** Type guard for output item done events. */
  private isOutputItemDoneEvent(
    event: ResponseStreamEvent,
  ): event is ResponseOutputItemDoneEvent {
    return event.type === 'response.output_item.done';
  }

  /** Type guard for web search output items. */
  private isWebSearchItem(
    item: ResponseOutputItem,
  ): item is ResponseFunctionWebSearch {
    return item.type === 'web_search_call';
  }

  /**
   * Emit web search result to progress view during streaming.
   * Uses shared helper for consistent WebSearchResult construction.
   */
  private emitOpenAIWebSearch(item: ResponseFunctionWebSearch): void {
    this.emitWebSearchResult(buildOpenAIWebSearchResult(item));
  }

  /**
   * Emit web searches from the final response that weren't already emitted during streaming.
   *
   * This fallback ensures web searches are displayed even if streaming events are missed:
   * - Network interruptions may cause output_item.done events to be lost
   * - Some edge cases in the SDK may not emit all streaming events
   * - Non-streaming responses need this path entirely
   *
   * The `alreadyEmitted` set prevents duplicates when streaming worked correctly.
   * During normal streaming, this method typically does nothing (all IDs already emitted).
   */
  private emitWebSearchesFromResponse(
    response: Response,
    alreadyEmitted: Set<string>,
  ): void {
    const output = response?.output;
    if (!Array.isArray(output)) {
      return;
    }

    for (const item of output) {
      if (
        this.isWebSearchItem(item) &&
        !alreadyEmitted.has(item.id) &&
        hasOpenAIWebSearchData(item)
      ) {
        this.emitOpenAIWebSearch(item);
        alreadyEmitted.add(item.id);
      }
    }
  }

  private getMessageContent(
    item?: ResponseInputItem,
  ): ResponseInputMessageContentList | string | undefined {
    if (!this.isMessageItem(item)) {
      return undefined;
    }
    return item.content;
  }

  private appendInputText(message: ResponseInputItem, text: string): void {
    if (!this.isMessageItem(message)) {
      return;
    }

    const content = message.content;

    if (Array.isArray(content)) {
      content.push(this.createInputText(text));
      return;
    }

    if (typeof content === 'string') {
      message.content = [
        this.createInputText(content),
        this.createInputText(text),
      ];
      return;
    }

    message.content = [this.createInputText(text)];
  }

  private appendAssistantText(
    message: ResponseInputItem,
    text: string,
  ): boolean {
    if (!this.isMessageItem(message) || message.role !== 'assistant') {
      return false;
    }

    const { content } = message;

    if (typeof content === 'string') {
      message.content = `${content}${text}`;
      return true;
    }

    let existingText = '';
    if (Array.isArray(content)) {
      existingText = content
        .map((part) => {
          const type = (part as { type?: unknown }).type;
          const partText = (part as { text?: unknown }).text;
          if (type === 'input_text' && typeof partText === 'string') {
            return partText;
          }
          if (type === 'output_text' && typeof partText === 'string') {
            return partText;
          }
          return '';
        })
        .join('');
    }

    // It could be that: If an assistant message's content is not a string or a recognized input content list (e.g., ResponseOutputMessage with output_text parts), its existing content is not extracted. This results in existingText being empty, and the original message content is completely overwritten by the new appended text. But we will see if that is the case.

    Object.assign(
      message,
      this.createAssistantMessage(`${existingText}${text}`),
    );
    return true;
  }

  // =========================================================================
  // Message modification methods (for post-build enrichment)
  // =========================================================================

  /**
   * Prepend text to the last user message in the conversation.
   * Finds the last user message and prepends text to its content.
   */
  prependTextToUserMessage(messages: ResponseInputItem[], text: string): void {
    if (!text.trim()) return;

    const lastUserMsg = messages.findLast(
      (m) => (m as { role?: string }).role === 'user',
    ) as { role: 'user'; content?: unknown } | undefined;
    if (!lastUserMsg || !Array.isArray(lastUserMsg.content)) return;

    const content = lastUserMsg.content as { type?: string; text?: string }[];
    const firstTextPart = content.find((part) => part.type === 'input_text');
    if (firstTextPart && 'text' in firstTextPart) {
      firstTextPart.text = text + firstTextPart.text;
    } else {
      content.unshift({ type: 'input_text', text });
    }
  }

  /**
   * Add media files to the last user message in the conversation.
   * Inserts media content parts at the beginning of the user message.
   */
  async addMediaToUserMessage(
    messages: ResponseInputItem[],
    mediaFiles: FileLocation[],
  ): Promise<void> {
    if (!mediaFiles.length || !this.config.capabilities.supportsVision) return;

    const lastUserMsg = messages.findLast(
      (m) => (m as { role?: string }).role === 'user',
    ) as { role: 'user'; content?: unknown[] } | undefined;
    if (!lastUserMsg || !Array.isArray(lastUserMsg.content)) return;

    try {
      const formattedMedia = (await this.createMediaMessage(
        mediaFiles,
      )) as ResponseInputMessageContentList;
      lastUserMsg.content.unshift(...formattedMedia);
    } catch (err) {
      this.logger.logError(
        `Error adding media to user message: ${getSdkErrorMessage(err)}`,
        err,
        { operation: 'add media to user message' },
      );
    }
  }
}
