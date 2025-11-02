// Standard library imports
import { Buffer } from 'node:buffer';

// Third-party imports
import OpenAI, { toFile } from 'openai';
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
  ResponseInputImage,
  ResponseInputText,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import type { Reasoning } from 'openai/resources/shared';
import type { ResponseStreamParams } from 'openai/lib/responses/ResponseStream';

// Local imports - agent
import type { AgentConfig } from '../core/AgentConfig';
import type { AgentSetting } from '../core/AgentDataclass';
import { hasEndTag } from '../core/AgentDataclass';
import { AgentStateRound } from '../core/AgentState';
import {
  ResponseUsageFactory,
  type OpenAIAPIResponseUsage,
  type ExtendedCompletionUsage,
} from '../core/ResponseUsage';
import { ToolState } from '../core/ToolState';
import { z } from 'zod';

// Local imports - base handler
import { ModelHandler } from './ModelHandler';
import { toOpenAIResponseTools } from './toolConversion';
import type { ProviderStopReason } from './types/StopReasonTypes';
import { OPENAI_CHAT_FINISH } from './types/StopReasonTypes';
import {
  describeAttachments,
  extractToolAttachments,
  loadAttachmentBuffer,
} from './utils/toolAttachmentUtils';

// Local imports - utilities
import { createContinuationMessage } from '@agent/utils/continuationMessage';
import { MediaEntry } from '@agent/utils/mediaTypes';
import { calculateTokenPrice } from '@agent/utils/priceUtils';
import { getSdkErrorMessage } from '@common/errors/sdkErrorUtils';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import type { ModelConfig, ToolDefinition } from '@model';
import type { ToolFileAttachment } from '@tools/result';
import { cleanFileContent } from '@replacement/engine';
import { K_SLICE, getConfig } from '@utils/config';
import { sleep } from '@utils/helpers';
import { WorkspaceFS } from '@utils/files';
import xmlUtils from '@utils/text/xmlUtils';

const ResponseOutputPartSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
  })
  .passthrough();

const ResponseOutputItemSchema = z
  .object({
    type: z.string(),
    content: z.array(ResponseOutputPartSchema).optional().default([]),
  })
  .passthrough();

const ResponseUsageDetailsSchema = z
  .object({
    cached_tokens: z.number().int().nonnegative().default(0),
  })
  .passthrough()
  .default({ cached_tokens: 0 });

const ResponseOutputDetailsSchema = z
  .object({
    reasoning_tokens: z.number().int().nonnegative().default(0),
  })
  .passthrough()
  .default({ reasoning_tokens: 0 });

const ResponseUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
    input_tokens_details: ResponseUsageDetailsSchema,
    output_tokens_details: ResponseOutputDetailsSchema,
  })
  .passthrough();

const ResponseEnvelopeSchema = z
  .object({
    status: z.string(),
    usage: ResponseUsageSchema,
    output_text: z
      .string()
      .optional()
      .transform((value) => (value ?? '').trim()),
    output: z
      .array(ResponseOutputItemSchema)
      .optional()
      .transform((value) => value ?? []),
  })
  .passthrough();

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
  ResponseFunctionToolCallItem
> {
  protected override get supportsToolFileOutputs(): boolean {
    return true;
  }

  protected override get supportsInlineToolImages(): boolean {
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
    const useBackgroundResponses = getConfig<boolean>(
      'texra.model.useBackgroundResponses',
      false,
    );
    if (useBackgroundResponses) {
      return false;
    }
    return super.getStreamingConfig();
  }

  protected override backgroundModeSupported = true;
  private static readonly BACKGROUND_POLL_INTERVAL_MS = 15000;
  private static readonly BACKGROUND_RETRIEVE_MAX_RETRIES = 3;
  private static readonly BACKGROUND_MAX_DURATION_MS = 3 * 60 * 60 * 1000; // 3 hours
  private static readonly BACKGROUND_PENDING_STATUSES = [
    'queued',
    'in_progress',
  ] as const;
  private static readonly BACKGROUND_TERMINAL_STATUSES = [
    'completed',
    'failed',
    'cancelled',
    'expired',
  ] as const;
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
    mediaFiles?: string[],
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
        this.logger.error(
          `Error processing media files: ${getSdkErrorMessage(err)}`,
          undefined,
          undefined,
          err,
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
    mediaFiles?: string[],
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
        this.logger.error(
          `Error processing media files for follow-up round: ${getSdkErrorMessage(err)}`,
          undefined,
          undefined,
          err,
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

      if (media.media_category === 'audio') {
        if (!this.capabilities.supportsNativeAudio) {
          this.logger.warn(
            `Audio input received (${media.file_name}) but native audio is not supported by this model/provider (${this.config.provider}). Skipping.`,
          );
          return [];
        }

        let audioFormat = media.media_type;
        if (media.media_type.includes('/')) {
          audioFormat = media.media_type.split('/')[1];
        }

        const normalizedFormat =
          audioFormat === 'mp3' || audioFormat === 'wav'
            ? audioFormat
            : undefined;
        if (!normalizedFormat) {
          this.logger.warn(
            `Audio input received (${media.file_name}) with unsupported format (${audioFormat}). Skipping.`,
          );
          return [];
        }

        return [
          this.createInputText(`Audio: ${media.file_name}`),
          {
            type: 'input_audio',
            input_audio: {
              data: media.data,
              format: normalizedFormat,
            },
          },
        ];
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
      const uploadedFile = await client.files.create({
        file: await toFile(buffer, filename),
        purpose: 'assistants',
      });

      content.file_id = uploadedFile.id;
      delete content.file_data;
      if ('filename' in content) {
        delete content.filename;
      }
    } catch (err) {
      this.logger.error(
        `Failed to upload file ${filename}: ${getSdkErrorMessage(err)}`,
        undefined,
        undefined,
        err,
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
    client: OpenAI,
    messages: ResponseInputItem[],
    temperature: number,
    systemPrompt?: string,
    _endTag?: string,
    signal?: AbortSignal,
    tools?: ToolDefinition[],
  ): Promise<Response> {
    const streamingToggleEnabled = this.getStreamingConfig();
    const backgroundToggleEnabled = getConfig<boolean>(
      'texra.model.useBackgroundResponses',
      false,
    );
    if (backgroundToggleEnabled && !this.backgroundModeSupported) {
      this.logger.debug(
        'Background mode toggle is enabled but this handler does not support background execution. Falling back to synchronous requests.',
      );
    }
    const useBackgroundResponses =
      this.backgroundModeSupported && backgroundToggleEnabled;
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
        undefined,
        undefined,
        {
          model: this.config.fullName,
          previousResponseId: this.previousResponseId ?? undefined,
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
      params.tools = toOpenAIResponseTools(tools);
      params.tool_choice = 'auto';
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
      if (this.capabilities.supportsReasoningEffort) {
        reasoning.effort = 'high';
      }
      params.reasoning = reasoning;
    }

    if (useStreaming) {
      const { stream: _stream, ...rest } = params;
      const streamParams: ResponseStreamParams = { ...rest, stream: true };
      const stream = client.responses.stream(streamParams, { signal });
      const thinking = this.createThinkingStream();
      const output = this.isOutputStreamingEnabled()
        ? this.createOutputStream()
        : undefined;
      const responseStream: AsyncIterable<ResponseStreamEvent> = stream;
      for await (const event of responseStream) {
        switch (event.type) {
          case 'response.reasoning_text.delta':
          case 'response.reasoning_summary_text.delta': {
            thinking.append(event.delta);
            break;
          }
          case 'response.output_text.delta': {
            output?.append(event.delta);
            break;
          }
          default:
            break;
        }
      }

      const response = await stream.finalResponse();
      const finalReasoning = this.processThinkingBlock(response);
      thinking.finalize(finalReasoning ?? undefined);
      const [finalText] = this.extractResponse(response, '');
      if (output) output.finalize(finalText);

      this.previousResponseId = response.id;
      this.sentMessages = messages.length;
      return response;
    }

    try {
      const { stream: _nonStream, ...nonStreamRest } = params;
      const nonStreamingParams: ResponseCreateParamsNonStreaming = {
        ...nonStreamRest,
        stream: false,
      };
      let response = await client.responses.create(nonStreamingParams, {
        signal,
      });
      if (useBackgroundResponses) {
        this.logger.debug(
          `Background response ${response.id} created with status ${
            response.status ?? 'unknown'
          }`,
          undefined,
          undefined,
          {
            responseId: response.id,
            status: response.status,
            usage: response.usage ?? undefined,
          },
        );
        this.logger.info(
          `Running OpenAI Responses in background mode for response ${response.id}; polling every 15s. Completion may take longer than usual.`,
          undefined,
          MESSAGE_TYPES.PROGRESS_STATUS,
          {
            responseId: response.id,
            pollIntervalMs:
              ModelHandlerOpenAIResponse.BACKGROUND_POLL_INTERVAL_MS,
          },
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

  /**
   * Extract plain text and usage information from the Responses API result.
   */
  extractResponse(
    responseObject: Response,
    endTag: string,
  ): [string, ResponseUsage, ProviderStopReason] {
    const parsed = ResponseEnvelopeSchema.parse(responseObject);
    const usage = parsed.usage;

    let newResponse = parsed.output_text;

    if (!newResponse) {
      const fallbackSegments: string[] = [];

      for (const item of parsed.output) {
        if (item.type !== 'message') {
          continue;
        }

        for (const part of item.content) {
          if (part.type === 'output_text' && typeof part.text === 'string') {
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
      parsed.status === 'completed'
        ? OPENAI_CHAT_FINISH.STOP
        : OPENAI_CHAT_FINISH.LENGTH;

    if (
      stopReason === OPENAI_CHAT_FINISH.STOP &&
      endTag &&
      !newResponse.includes(endTag)
    ) {
      return [`${newResponse}\n${endTag}`, usage, stopReason];
    }

    return [newResponse, usage, stopReason];
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

  /** Map usage fields and create usage statistics object. */
  computeResponseUsage(
    responseUsage: ResponseUsage,
    responseTime: number,
  ): OpenAIAPIResponseUsage {
    const mapped: ExtendedCompletionUsage = {
      prompt_tokens: responseUsage.input_tokens ?? 0,
      completion_tokens: responseUsage.output_tokens ?? 0,
      total_tokens: responseUsage.total_tokens ?? 0,
      prompt_tokens_details: {
        cached_tokens: responseUsage.input_tokens_details?.cached_tokens ?? 0,
      },
      completion_tokens_details: {
        reasoning_tokens:
          responseUsage.output_tokens_details?.reasoning_tokens ?? 0,
        accepted_prediction_tokens: undefined,
        rejected_prediction_tokens: undefined,
      },
    };

    return ResponseUsageFactory.fromOpenAIResponse(
      mapped,
      this.computePrice(responseUsage),
      responseTime,
    );
  }

  /** Models with prefill support do not require additional continuation messages. */
  addContinueMessageWithPrefill(
    _messages: ResponseInputItem[],
    _stateRound: AgentStateRound,
    _toolState: ToolState,
    _agentSetting: AgentSetting,
    _agentConfig: AgentConfig,
  ): void {
    this.logger.debug('Skipping continuation - assistant prefill is supported');
  }

  private isBackgroundPending(response: Response): boolean {
    const status = response.status;
    if (!status) {
      return false;
    }

    return ModelHandlerOpenAIResponse.BACKGROUND_PENDING_STATUSES.includes(
      status as (typeof ModelHandlerOpenAIResponse.BACKGROUND_PENDING_STATUSES)[number],
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

    let current = initialResponse;
    const responseId = initialResponse.id;
    const pollInterval = ModelHandlerOpenAIResponse.BACKGROUND_POLL_INTERVAL_MS;
    const maxRetries =
      ModelHandlerOpenAIResponse.BACKGROUND_RETRIEVE_MAX_RETRIES;
    const startTime = Date.now();
    let pollCount = 0;
    let consecutiveErrors = 0;
    const initialStatus = current.status ?? 'unknown';

    this.logger.debug(
      `Background polling started for response ${responseId} (status: ${initialStatus})`,
      undefined,
      undefined,
      {
        responseId,
        status: current.status,
      },
    );

    while (this.isBackgroundPending(current)) {
      pollCount += 1;
      this.logger.debug(
        `Waiting ${pollInterval}ms before poll ${pollCount} for response ${responseId}`,
        undefined,
        undefined,
        {
          responseId,
          pollCount,
          waitMs: pollInterval,
        },
      );
      try {
        await this.waitWithAbort(pollInterval, signal);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          this.logger.warn(
            `Background polling aborted for response ${responseId} while waiting to poll.`,
            undefined,
            undefined,
            {
              responseId,
              pollCount,
              elapsedMs: Date.now() - startTime,
            },
          );
          // Background jobs keep running on the OpenAI side when polling stops.
          // Callers can later resume polling or explicitly cancel via client.responses.cancel(responseId).
        }
        throw err;
      }

      const elapsedMs = Date.now() - startTime;
      if (elapsedMs > ModelHandlerOpenAIResponse.BACKGROUND_MAX_DURATION_MS) {
        this.logger.error(
          `Background response ${responseId} exceeded maximum polling duration while pending`,
          undefined,
          undefined,
          {
            responseId,
            status: current.status,
            pollCount,
            elapsedMs,
          },
        );
        throw new Error(
          `Background response ${responseId} exceeded maximum polling duration of ${ModelHandlerOpenAIResponse.BACKGROUND_MAX_DURATION_MS} ms. Retry later or cancel the job with client.responses.cancel("${responseId}").`,
        );
      }

      try {
        const requestOptions = signal ? { signal } : undefined;
        current = await client.responses.retrieve(
          responseId,
          undefined,
          requestOptions,
        );
        consecutiveErrors = 0;
        this.logger.debug(
          `Background poll ${pollCount} for response ${responseId}: status=${
            current.status ?? 'unknown'
          }`,
          undefined,
          undefined,
          {
            responseId,
            status: current.status,
            pollCount,
          },
        );
      } catch (err) {
        consecutiveErrors += 1;
        const message = getSdkErrorMessage(err);
        this.logger.warn(
          `Background poll ${pollCount} for response ${responseId} failed (${consecutiveErrors}/${maxRetries}): ${message}. Will retry...`,
          undefined,
          undefined,
          {
            responseId,
            pollCount,
            error: message,
          },
        );

        if (consecutiveErrors >= maxRetries) {
          this.logger.error(
            `Giving up after ${consecutiveErrors} errors retrieving background response ${responseId}`,
            undefined,
            undefined,
            {
              responseId,
              pollCount,
              error: message,
            },
          );
          throw err;
        }

        continue;
      }
    }

    const elapsedMs = Date.now() - startTime;
    this.logger.debug(
      `Background polling finished for response ${responseId} with status=${
        current.status ?? 'unknown'
      } after ${pollCount} polls (${elapsedMs} ms)`,
      undefined,
      undefined,
      {
        responseId,
        status: current.status,
        pollCount,
        elapsedMs,
        usage: current.usage ?? undefined,
      },
    );

    const finalStatus = current.status;

    const isTerminal =
      !!finalStatus &&
      ModelHandlerOpenAIResponse.BACKGROUND_TERMINAL_STATUSES.includes(
        finalStatus as (typeof ModelHandlerOpenAIResponse.BACKGROUND_TERMINAL_STATUSES)[number],
      );

    if (!isTerminal) {
      this.logger.warn(
        `Background response ${responseId} returned non-terminal status ${finalStatus ?? 'unknown'} after polling loop`,
        undefined,
        undefined,
        {
          responseId,
          status: finalStatus,
          pollCount,
          elapsedMs,
        },
      );
    }

    if (current.status !== 'completed') {
      const fallbackStatus = current.status ?? 'unknown';
      const errorDetail =
        current.error?.message ??
        current.incomplete_details?.reason ??
        'Background response did not complete successfully.';
      this.logger.error(
        `Background response ${responseId} ended with status ${fallbackStatus}`,
        undefined,
        undefined,
        {
          responseId,
          status: current.status,
          error: current.error ?? undefined,
          incomplete: current.incomplete_details ?? undefined,
        },
      );
      throw new Error(
        `Background response ${responseId} ended with status ${fallbackStatus}: ${errorDetail}. Retrieve the latest status with client.responses.retrieve("${responseId}").`,
      );
    }

    return current;
  }

  private async waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      await sleep(ms);
      return;
    }

    if (signal.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const supportsAbortTimeout = typeof AbortSignal.timeout === 'function';

    await new Promise<void>((resolve, reject) => {
      let timeoutId: NodeJS.Timeout | undefined;
      let timeoutSignal: AbortSignal | undefined;

      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        timeoutSignal?.removeEventListener('abort', onTimeout);
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
      };

      const onAbort = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
        cleanup();
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };

      const onTimeout = () => {
        cleanup();
        resolve();
      };

      signal.addEventListener('abort', onAbort, { once: true });

      if (supportsAbortTimeout) {
        timeoutSignal = AbortSignal.timeout(ms);
        timeoutSignal.addEventListener('abort', onTimeout, { once: true });
      } else {
        timeoutId = setTimeout(onTimeout, ms);
      }
    });
  }

  /** Adds continuation instructions for models without prefill support. */
  addContinueMessageWithoutPrefill(
    messages: ResponseInputItem[],
    _stateRound: AgentStateRound,
    toolState: ToolState,
    agentSetting: AgentSetting,
    _agentConfig: AgentConfig,
  ): void {
    const prefillTokens = toolState.lastResponse.slice(-K_SLICE);
    const userMessageContinuation = createContinuationMessage(
      agentSetting.endTag,
      prefillTokens,
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
    toolState: ToolState,
    outputFile: string,
    prefill: string,
  ): Promise<[boolean, ResponseInputItem[]]> {
    let endTurn = false;

    if (!(await WorkspaceFS.existsAndNonTrivial(outputFile))) {
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

    let fileContent = await WorkspaceFS.read(outputFile);
    fileContent = cleanFileContent(fileContent);

    const scratchpad = await xmlUtils.extractScratchpad(
      fileContent,
      'scratchpad',
    );
    if (scratchpad) {
      this.logger.info(scratchpad, undefined, MESSAGE_TYPES.SCRATCHPAD);
    }

    await WorkspaceFS.write(outputFile, fileContent);

    messages.push(this.createAssistantMessage(fileContent));

    if (hasEndTag(agentSetting, fileContent)) {
      this.logger.debug('End tag detected - skipping continuation');
      endTurn = true;
      return [endTurn, messages];
    }

    this.logger.warn(
      'Output file exists but no end tag found - continuing from file',
    );
    if (fileContent.includes(prefill)) {
      toolState.updateAccumulatedOutput(fileContent);
    } else {
      toolState.updateAccumulatedOutput(prefill + fileContent);
      await WorkspaceFS.write(outputFile, toolState.accumulatedOutput);
    }

    const state = new AgentStateRound(0);
    toolState.lastResponse = toolState.accumulatedOutput;
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

  /** Updates message content for models with prefill support. */
  updateMessageContentWithPrefill(
    messages: ResponseInputItem[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
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

    messages.push(this.createAssistantMessage(toolState.accumulatedOutput));
  }

  /** Updates message content for models without prefill support. */
  updateMessageContentWithoutPrefill(
    messages: ResponseInputItem[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
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
            this.createAssistantMessage(toolState.accumulatedOutput),
          );
        }
      }
    } else {
      this.logger.debug(
        'Last message is a request message rather than a continuation request',
      );
      messages.push(this.createAssistantMessage(toolState.accumulatedOutput));
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

  /** Process reasoning summaries from the Responses API. */
  processThinkingBlock(
    responseObject: Response,
    groupId?: string,
    toolState?: ToolState,
  ): string | null {
    const outputArr = responseObject?.output;
    if (!Array.isArray(outputArr)) {
      return null;
    }
    const reasoningObj = outputArr.find(
      (item) => item?.type === 'reasoning',
    ) as ResponseReasoningItem | undefined;
    const summaryParts = reasoningObj?.summary ?? [];
    if (summaryParts.length === 0) {
      return null;
    }

    const thoughtContent = summaryParts.map((part) => part.text).join('\n\n'); // to make the thinking markdown rendering more readable

    if (toolState && !toolState.thinkingAdded) {
      toolState.thinkingBlocks = summaryParts.map((part) => ({
        type: 'thinking',
        thinking: part.text,
      }));
      toolState.thinkingAdded = true;
    }

    if (thoughtContent) {
      this.logger.debug(
        `OpenAI Responses reasoning preview: ${thoughtContent.substring(0, K_SLICE)}...`,
        groupId,
      );
    }

    return thoughtContent || null;
  }

  extractToolUse(response: Response): string | null {
    const items = response?.output;
    if (!Array.isArray(items)) return null;

    const call = items.find(
      (it): it is ResponseFunctionToolCallItem => it?.type === 'function_call',
    );
    return call ? JSON.stringify(call, null, 2) : null;
  }

  async createToolUseFollowUpMessages(
    client: OpenAI | undefined,
    id: string,
    name: string,
    call: ResponseFunctionToolCallItem,
    result: Record<string, unknown>,
    _toolState?: ToolState,
    text?: string,
  ): Promise<ResponseInputItem[]> {
    const messages: ResponseInputItem[] = [];
    if (text) {
      messages.push(this.createAssistantMessage(text));
    }

    const callMsg: ResponseFunctionToolCall = {
      type: 'function_call',
      call_id: id,
      name,
      arguments:
        typeof call?.arguments === 'string'
          ? call.arguments
          : JSON.stringify(
              (call as unknown as { input?: unknown; arguments?: unknown })
                ?.input ??
                (call as unknown as { input?: unknown; arguments?: unknown })
                  ?.arguments ??
                {},
            ),
    };

    const { attachments, sanitizedResult } = extractToolAttachments(result);
    const supportsAttachments = this.supportsToolFileOutputs;
    const supportsInlineImages = this.supportsInlineToolImages;

    let uploadedAttachments: UploadedOpenAIResponseAttachment[] = [];
    if (supportsAttachments && attachments.length > 0 && client) {
      uploadedAttachments = await this.uploadToolAttachments(
        client,
        attachments,
      );
      if (uploadedAttachments.length > 0) {
        (sanitizedResult as { files?: unknown }).files =
          uploadedAttachments.map(({ attachment, fileId }) => ({
            path: attachment.path,
            mimeType: attachment.mimeType,
            description: attachment.description,
            fileId,
          }));
      }
    }

    if (
      attachments.length > 0 &&
      (!supportsAttachments || !client || uploadedAttachments.length === 0)
    ) {
      (sanitizedResult as Record<string, unknown>).attachmentSummary =
        `Attachments available:\n${describeAttachments(attachments).join(
          '\n',
        )}\nUse the read_file tool to inspect them.`;
    }

    const primaryText =
      typeof result.output === 'string' && result.output.trim().length > 0
        ? result.output
        : typeof result.summary === 'string'
          ? result.summary
          : undefined;
    const summaryPayload = JSON.stringify(sanitizedResult, null, 2);
    const combinedText = primaryText
      ? `${primaryText}\n\n${summaryPayload}`
      : summaryPayload;

    let outputPayload:
      | string
      | Array<ResponseInputText | ResponseInputImage | ResponseInputFile>;

    if (uploadedAttachments.length > 0) {
      const parts: Array<
        ResponseInputText | ResponseInputImage | ResponseInputFile
      > = [{ type: 'input_text', text: combinedText }];

      for (const uploaded of uploadedAttachments) {
        if (supportsInlineImages && uploaded.isImage) {
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
      call_id: id,
      output: outputPayload,
    };

    messages.push(callMsg, resultMsg);
    return messages;
  }

  private async uploadToolAttachments(
    client: OpenAI,
    attachments: ToolFileAttachment[],
  ): Promise<UploadedOpenAIResponseAttachment[]> {
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

        const uploadedFile = await client.files.create({
          file: await toFile(buffer, filename, { type: mimeType }),
          purpose: 'assistants',
        });

        uploaded.push({
          attachment,
          fileId: uploadedFile.id,
          isImage: mimeType.startsWith('image/'),
        });
      } catch (err) {
        this.logger.error(
          `Failed to upload attachment ${attachment.path ?? 'attachment'}: ${getSdkErrorMessage(err)}`,
          undefined,
          undefined,
          err,
        );
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
    return typeof content === 'string' || this.isInputContentList(content);
  }

  private getMessageContent(
    item?: ResponseInputItem,
  ): ResponseInputMessageContentList | string | undefined {
    if (!this.isMessageItem(item)) {
      return undefined;
    }
    return item.content;
  }

  private isInputContentList(
    content: unknown,
  ): content is ResponseInputMessageContentList {
    return (
      Array.isArray(content) &&
      content.every((item) => this.isInputContent(item))
    );
  }

  private isInputContent(content: unknown): content is ResponseInputContent {
    if (!content || typeof content !== 'object') {
      return false;
    }

    const type = (content as { type?: unknown }).type;
    return (
      type === 'input_text' ||
      type === 'input_image' ||
      type === 'input_file' ||
      type === 'input_audio'
    );
  }

  private appendInputText(message: ResponseInputItem, text: string): void {
    if (!this.isMessageItem(message)) {
      return;
    }

    const content = message.content;

    if (this.isInputContentList(content)) {
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
    if (this.isInputContentList(content)) {
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
}
