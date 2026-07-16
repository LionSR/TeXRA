import { basename } from 'node:path';

// Third-party imports
import {
  Anthropic,
  APIError as AnthropicAPIError,
  APIUserAbortError as AnthropicUserAbortError,
} from '@anthropic-ai/sdk';

// Local imports - agent
import {
  type AgentSetting,
  hasEndTag,
} from '@agent/core/definition/AgentDataclass';
import type {
  AgentWorkspaceState,
  ThinkingBlock,
} from '@agent/core/state/AgentWorkspaceState';
import { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import type { MediaEntry } from '@agent/utils/mediaTypes';

// Local imports - common
import { ANTHROPIC_STOP } from '@agent/types/StopReasonTypes';
import {
  isAnthropicServerToolContent,
  type ServerToolExtractionResult,
} from '@agent/types/ServerToolTypes';
import type { ProviderStopReason } from '@agent/types/StopReasonTypes';
import type {
  CreateResponseOptions,
  CreateResponseResult,
  ExtractResponseResult,
  AnthropicToolCall,
  TokenCountOptions,
} from '@agent/types/ModelHandlerContracts';
import {
  attachStreamDiagnostics,
  handleStreamingFailure,
  isUserAbort,
  trackStreamConnect,
  takeTail,
  PARTIAL_TEXT_TAIL_MAX,
} from '@common/errors/sdkErrorUtils';
import replacementEngine from '@replacement/engine';

// Local imports - tools
import type {
  FileLocation,
  MediaAttachmentKind,
  StreamDiagnostics,
} from '@shared/schemas';
import type {
  ToolFileAttachment,
  ToolResult,
} from '@shared/schemas/toolResult';

// Local imports - utils
import { getConfig } from '@utils/config/configUtils';
import { getAnthropicDynamicFiltering } from '@utils/config/providerConfig';
import { joinNonEmpty } from '@utils/text/stringUtils';
import {
  computeAnthropicPrice,
  normalizeAnthropicUsage,
  type AnthropicPricingConfig,
} from './anthropicUsage';

// Local file imports
import {
  getAnthropicMaxPdfPages,
  DEFAULT_COMPACTION_THRESHOLD_PERCENT,
} from '../contextManagementConstants';
import { AnthropicStreamHandler } from '../support/AnthropicStreamHandler';
import { toAnthropicTools } from '../toolConversion';
import {
  describeAttachments,
  formatAttachmentSummaryFromNotes,
  formatToolResultAsText,
} from '../utils/toolAttachmentUtils';
import { tagAnthropicSdkError } from './anthropicSdkError';
import {
  FILES_API_BETA,
  CONTEXT_MANAGEMENT_BETA,
  COMPACTION_BETA,
  EXTENDED_CACHE_TTL_BETA,
  SHORT_CACHE_CONTROL,
  LONG_CACHE_CONTROL,
  isLongCacheControl,
  ensureBeta,
  hasLongCacheControlMarker,
  setupContextManagement,
  logContextManagementFromResponse,
  enforceCacheControlLimit,
} from './anthropicContextManagement';
import {
  extractDocumentBlocks,
  analyzeDocumentSources,
  replaceDocumentDataWithUploads,
} from './anthropicDocumentHandling';
import {
  isSupportedImageMediaType,
  uploadToolAttachments,
  type UploadedAnthropicAttachment,
} from './anthropicTools';
import {
  buildThinkingConfig,
  isCompactionEligibleModel,
  supportsAdaptiveThinking,
} from './anthropicThinking';
import {
  buildAnthropicAssistantContent,
  extractAnthropicServerToolData,
} from './anthropicServerTools';

// Type imports
import type { AnthropicBeta } from '@anthropic-ai/sdk/resources/beta/beta';
import type {
  BetaContentBlock,
  BetaContextManagementConfig,
  BetaImageBlockParam,
  BetaMessage,
  BetaOutputConfig,
  BetaRedactedThinkingBlock,
  BetaRequestDocumentBlock,
  BetaThinkingBlock,
  BetaUsage,
  MessageCountTokensParams,
  MessageCreateParams,
} from '@anthropic-ai/sdk/resources/beta/messages';
import type {
  Base64ImageSource,
  MessageParam,
  ContentBlockParam,
  ToolUseBlock,
  TextBlockParam,
  ImageBlockParam,
  DocumentBlockParam,
  ThinkingBlockParam,
  RedactedThinkingBlockParam,
} from '@anthropic-ai/sdk/resources/messages';

type ErrorWithRequestId = Error & { request_id?: string };

/**
 * Extracts the tail of text content from a (possibly partial) BetaMessage.
 */
function extractPartialTextTail(
  message: BetaMessage | undefined,
  maxChars: number,
): string {
  if (!message?.content) return '';
  const text = message.content
    .filter(isBetaTextBlock)
    .map((block) => block.text)
    .join('');
  return takeTail(text, maxChars);
}

/** Type guard for any thinking-related content block param */
const isAnyThinkingBlockParam = (
  block: ContentBlockParam,
): block is ThinkingBlockParam | RedactedThinkingBlockParam =>
  block.type === 'thinking' || block.type === 'redacted_thinking';

/** Type guard for tool use blocks in Beta API responses */
const isBetaToolUseBlock = (block: BetaContentBlock): block is ToolUseBlock =>
  block.type === 'tool_use';

/** Type guard for text blocks in Beta API responses */
const isBetaTextBlock = (
  block: BetaContentBlock,
): block is Extract<BetaContentBlock, { type: 'text' }> =>
  block.type === 'text';

const INTERLEAVED_THINKING_BETA: AnthropicBeta =
  'interleaved-thinking-2025-05-14';

export class ModelHandlerAnthropic extends ModelHandler<
  MessageParam,
  BetaUsage,
  AnthropicToolCall,
  Anthropic,
  BetaMessage,
  ContentBlockParam
> {
  /** Tracks PDF page counts for files uploaded to the Anthropic Files API. */
  private uploadedPdfPageCounts = new Map<string, number>();

  /** Sum of all tracked PDF page counts across uploaded files. */
  private getTrackedPdfPageCount(): number {
    let total = 0;
    for (const count of this.uploadedPdfPageCounts.values()) total += count;
    return total;
  }

  /**
   * Removes entries from uploadedPdfPageCounts whose file IDs are no longer
   * referenced in the current messages. This keeps the tracked total accurate
   * after server-side compaction drops old messages.
   */
  private pruneTrackedPdfPages(messages: MessageParam[]): void {
    const liveFileIds = new Set<string>();
    for (const message of messages) {
      const contentBlocks = message.content;
      if (!Array.isArray(contentBlocks)) continue;

      for (const block of extractDocumentBlocks(contentBlocks)) {
        const source = block.source as
          { type: string; file_id?: string } | undefined;
        if (source?.type === 'file' && source.file_id) {
          liveFileIds.add(source.file_id);
        }
      }
    }

    for (const fileId of this.uploadedPdfPageCounts.keys()) {
      if (!liveFileIds.has(fileId)) {
        this.uploadedPdfPageCounts.delete(fileId);
      }
    }
  }

  /** Returns the PDF page limit based on the model's effective context window. */
  private getMaxPdfPages(): number {
    return getAnthropicMaxPdfPages(this.getEffectiveContextWindow());
  }

  /**
   * Client-side compaction is available for tool-use sessions on models whose
   * llm-zoo family is compaction-eligible. `isCompactionEligibleModel` is a
   * `startsWith`-style model-family gate in `anthropicThinking.ts`; moving it
   * to an llm-zoo capability flag is #7080's scope, not this predicate's own
   * #7101 triage.
   */
  override get supportsManualCompaction(): boolean {
    return (
      isCompactionEligibleModel(this.config.fullName) && this.isToolUseMode()
    );
  }

  /**
   * Anthropic passes `system` per-call rather than storing it in `messages`
   * (see `initializeMessages` below) — the round flow must resupply it on
   * every invocation.
   */
  override get requiresPerCallSystemPrompt(): boolean {
    return true;
  }

  /**
   * Anthropic supports file uploads via their Files API. Unconditionally
   * true rather than a capability read: this is a provider-wide fact about
   * the Anthropic SDK, not a per-model llm-zoo flag or `ProviderCapabilityProfile`
   * entry (#7101 triage: see the base getter's doc comment for why this
   * stays a per-provider override rather than folding into a capability read).
   */
  protected override get supportsToolResultFileUpload(): boolean {
    return true;
  }

  async getClient(): Promise<Anthropic> {
    const credential = await this.getApiKey();
    const baseUrl = this.getBaseUrl();
    this.logger.debug(`Using Anthropic API. Base URL: ${baseUrl}`);

    // For relay auth: credential is the user's JWT, SDK sends it via x-api-key header.
    return new Anthropic({
      apiKey: credential,
      baseURL: baseUrl,
    });
  }

  override isAutoRetryManagedByProvider(_error: Error): boolean {
    return true;
  }

  /**
   * Estimates token count using Anthropic's native countTokens API.
   *
   * Note: countTokens does not support file-based document sources (file_id).
   * Check `hasFileSource` before calling this method to avoid API errors.
   *
   * @param messages - The messages to count tokens for
   * @param options - Token counting options including client, systemPrompt, tools, thinking, etc.
   * @returns Promise resolving to the total token count
   */
  override async estimateTokenCount(
    messages: MessageParam[],
    options?: TokenCountOptions<Anthropic> & {
      anthropicTools?: MessageCountTokensParams['tools'];
      thinking?: MessageCountTokensParams['thinking'];
      outputConfig?: BetaOutputConfig;
      contextManagement?: BetaContextManagementConfig;
      betas?: AnthropicBeta[];
    },
  ): Promise<number> {
    const client = options?.client ?? (await this.getClient());

    const countTokensParams: MessageCountTokensParams = {
      model: this.config.fullName,
      messages,
      ...(options?.systemPrompt && { system: options.systemPrompt }),
    };

    // Include tools in token counting for accurate measurement.
    // Tool schemas can be substantial and affect context utilization.
    if (options?.anthropicTools?.length) {
      // Filter out memory tool as countTokens API doesn't support it yet
      const countableTools = options.anthropicTools.filter(
        (tool) => !('type' in tool && tool.type === 'memory_20250818'),
      );
      if (countableTools.length > 0) {
        countTokensParams.tools = countableTools;
      }
    }

    // If thinking is enabled, we need to pass it to countTokens as well
    // to ensure consistency with the actual message creation.
    // Without this, the API returns an error when messages contain thinking blocks.
    if (options?.thinking) {
      countTokensParams.thinking = options.thinking;
    }

    // Include output_config in token counting so estimates match request options.
    // This is relevant when effort level is set (adaptive thinking).
    if (options?.outputConfig) {
      countTokensParams.output_config = options.outputConfig;
    }

    // Include context_management in token counting so estimates match request options.
    if (options?.contextManagement) {
      countTokensParams.context_management = options.contextManagement;
    }

    // Strip betas that only apply to message creation (e.g., output length)
    // while keeping context headers needed for accurate token counting.
    const countTokenBetas = new Set(
      options?.betas?.filter(
        (beta) =>
          beta === CONTEXT_MANAGEMENT_BETA ||
          beta === COMPACTION_BETA ||
          beta === EXTENDED_CACHE_TTL_BETA,
      ),
    );
    if (hasLongCacheControlMarker(messages)) {
      countTokenBetas.add(EXTENDED_CACHE_TTL_BETA);
    }
    if (countTokenBetas.size > 0) {
      countTokensParams.betas = [...countTokenBetas];
    }

    const responseTokenCount =
      await client.beta.messages.countTokens(countTokensParams);

    this.logger.debug(
      `Token count of message: ${responseTokenCount.input_tokens}`,
    );

    return responseTokenCount.input_tokens;
  }

  protected override get sdkErrorTagger() {
    return tagAnthropicSdkError;
  }

  /** Enriches an Anthropic stream failure without hiding SDK or abort identity. */
  private decorateStreamError(
    error: unknown,
    partialText: string,
    diagnostics: StreamDiagnostics,
    requestId?: string,
  ): unknown {
    tagAnthropicSdkError(error, this.config.provider);

    const isAbort = isUserAbort(error);
    const enrichedError =
      !diagnostics.messageStartReceived &&
      error instanceof Error &&
      !(error instanceof AnthropicAPIError) &&
      !isAbort
        ? new Error(
            `Stream closed before message_start after ${diagnostics.elapsedSecs}s ` +
              `(${diagnostics.eventsProcessed} events). ` +
              'Likely connection dropped before the API responded.',
            { cause: error },
          )
        : error;

    // detectRequestId() reads request_id from the thrown object.
    if (requestId && enrichedError instanceof Error) {
      (enrichedError as ErrorWithRequestId).request_id = requestId;
    }

    // The retry node owns user-facing failure reporting. Diagnostics stay on
    // the debug channel so the same failure does not produce a visible row.
    this.logger.debug(`Stream ${isAbort ? 'aborted' : 'failed'}`, {
      data: {
        isUsingRelay: this.shouldUseServerSideKeys(),
        baseUrl: this.getBaseUrl() ?? 'default',
        model: this.config.fullName,
        streamDiagnostics: diagnostics,
        partialTextLength: partialText.length,
        error: enrichedError,
      },
    });

    attachStreamDiagnostics(enrichedError, diagnostics);
    return enrichedError;
  }

  /** Executes Anthropic's event-emitter stream and preserves its SDK-specific lifecycle. */
  private async executeStreamingResponse(
    client: Anthropic,
    options: MessageCreateParams,
    signal?: AbortSignal,
  ): Promise<BetaMessage> {
    const stream = await client.beta.messages.stream(options, { signal });

    if (signal?.aborted) {
      stream.controller.abort();
      throw new AnthropicUserAbortError();
    }

    const connect = trackStreamConnect(stream);
    const abortStream = (): void => stream.controller.abort();
    signal?.addEventListener('abort', abortStream, { once: true });

    const streamHandler = new AnthropicStreamHandler(
      this.logger,
      { progressViewEnabled: this.progressViewEnabled },
      {
        // Anthropic emits explicit phase signals, so stream starts are eager.
        createThinkingStream: () =>
          this.createThinkingStream({ atPhaseSignal: true }),
        createOutputStream: () =>
          this.createOutputStream({ atPhaseSignal: true }),
      },
    );

    try {
      streamHandler.attachToStream(stream);
      const response = await stream.finalMessage();

      // A relay can close cleanly before message_stop, leaving finalMessage()
      // resolved with a truncated response rather than an SDK error.
      const diagnostics = streamHandler.getDiagnostics();
      if (!diagnostics.messageStopReceived) {
        throw new Error(
          `Stream ended without message_stop after ${diagnostics.elapsedSecs}s ` +
            `(${diagnostics.eventsProcessed} events, ` +
            `${diagnostics.thinkingChars} thinking chars, ` +
            `${diagnostics.textChars} text chars). ` +
            'Stream truncated, likely proxy idle timeout during extended thinking.',
        );
      }

      this.processThinkingBlock(response);
      return response;
    } catch (streamError) {
      return handleStreamingFailure(streamError, {
        // Anthropic finalizes unconditionally below, including on success.
        partialTail: () =>
          extractPartialTextTail(stream.currentMessage, PARTIAL_TEXT_TAIL_MAX),
        retryEligible: (tail) => connect.isConnected() || tail.length > 0,
        decorateError: (error, partialText) =>
          this.decorateStreamError(
            error,
            partialText,
            streamHandler.getDiagnostics(),
            stream.request_id ?? undefined,
          ),
      });
    } finally {
      streamHandler.finalize();
      connect.cleanup();
      signal?.removeEventListener('abort', abortStream);
    }
  }

  /** Creates an Anthropic response after SDK-boundary error tagging is installed. */
  protected override async createResponseImpl(
    requestOptions: CreateResponseOptions<MessageParam, Anthropic>,
  ): Promise<CreateResponseResult<BetaMessage, MessageParam>> {
    const {
      client,
      messages,
      temperature,
      systemPrompt,
      endTag,
      signal,
      tools,
    } = requestOptions;
    // Get streaming config
    const useStreaming = this.getStreamingConfig();
    // Track input token count for client-side context management triggering
    let measuredInputTokens: number | undefined;
    const effectiveContextWindow = this.getEffectiveContextWindow();

    // Count cache slots reserved by top-level automatic caching and system prompt
    // so enforceCacheControlLimit knows how many remain for message blocks.
    const supportsCache = this.capabilities.supportsPromptCaching;
    let reservedCacheSlots = 0;
    if (supportsCache) {
      reservedCacheSlots += 1; // top-level automatic caching
      if (systemPrompt) reservedCacheSlots += 1; // system prompt breakpoint
    }

    // Use 1-hour cache TTL for tool-use requests (which involve long-running
    // tool execution cycles where 5-minute caches would frequently expire),
    // and 5-minute TTL for simple non-tool requests.
    const cacheControl = tools?.length
      ? LONG_CACHE_CONTROL
      : SHORT_CACHE_CONTROL;

    enforceCacheControlLimit(
      messages,
      reservedCacheSlots,
      cacheControl,
      this.capabilities.supportsPromptCaching,
    );

    const documentAnalysis = analyzeDocumentSources(messages);
    let hasFileReference = documentAnalysis.hasFileSource;

    // Prune tracked PDF page counts for file IDs no longer in messages
    // (e.g. after server-side compaction drops old messages)
    if (this.uploadedPdfPageCounts.size > 0) {
      this.pruneTrackedPdfPages(messages);
    }

    // Phase 1: BUILD - Construct provider-specific request parameters
    const options: MessageCreateParams = {
      model: this.config.fullName,
      max_tokens: this.getEffectiveMaxOutputTokens(),
      messages,
      temperature,
      stop_sequences: endTag ? [endTag] : undefined,
      // Structure system prompt as a block with an explicit cache breakpoint so
      // it is independently cached even when conversations exceed the 20-block
      // lookback window.
      system:
        systemPrompt && supportsCache
          ? [
              {
                type: 'text' as const,
                text: systemPrompt,
                cache_control: cacheControl,
              },
            ]
          : systemPrompt,
      // Top-level automatic caching: the API automatically applies a cache
      // breakpoint to the last cacheable block, moving it forward as conversations
      // grow. This replaces manual per-block cache_control assignment.
      ...(supportsCache && {
        cache_control: cacheControl,
      }),
    };

    if (
      supportsCache &&
      (isLongCacheControl(cacheControl) || hasLongCacheControlMarker(messages))
    ) {
      ensureBeta(options, EXTENDED_CACHE_TTL_BETA);
    }

    if (tools?.length) {
      options.tools = toAnthropicTools(tools, {
        supportsNativeWebSearch: this.capabilities.supportsNativeWebSearch,
        // Web fetch is available on the same Anthropic models that support native web search
        supportsNativeWebFetch: this.capabilities.supportsNativeWebSearch,
        useDynamicFiltering: getAnthropicDynamicFiltering(),
      });

      options.tool_choice = { type: 'auto' };

      // Models using adaptive thinking get interleaved thinking automatically.
      // Only add the beta header for older models that need it explicitly.
      if (
        this.capabilities.supportsInterleavedThinking &&
        !supportsAdaptiveThinking(this.config.fullName)
      ) {
        ensureBeta(options, INTERLEAVED_THINKING_BETA);
      }

      // Memory tool requires the context management beta header
      if (tools.some((t) => t.name === 'memory')) {
        ensureBeta(options, CONTEXT_MANAGEMENT_BETA);
      }
    }

    // Enable thinking for any models that support reasoning
    if (this.capabilities.supportsReasoning) {
      this.logger.debug('Enabling thinking for model with reasoning support');

      const thinkingConfig = buildThinkingConfig({
        fullName: this.config.fullName,
        reasoningEffort: this.getEffectiveReasoningEffort(),
        maxTokens: options.max_tokens,
        useStreaming,
      });
      options.thinking = thinkingConfig.thinking;

      if (thinkingConfig.thinking.type === 'adaptive') {
        options.output_config = {
          ...options.output_config,
          ...thinkingConfig.outputConfig,
        };
        this.logger.debug('Set adaptive thinking', {
          data: {
            effort: thinkingConfig.outputConfig?.effort,
            maxTokens: options.max_tokens,
          },
        });
      } else if (thinkingConfig.thinking.type === 'enabled') {
        this.logger.debug('Set thinking budget', {
          data: {
            budgetTokens: thinkingConfig.thinking.budget_tokens,
            maxTokens: options.max_tokens,
            streaming: useStreaming,
          },
        });
      }

      // Remove temperature for models that reject sampling parameters when
      // thinking is enabled: Claude 4 families, Sonnet 5, and the Mythos-class
      // models (Fable 5, Mythos 5), per Anthropic docs.
      if (thinkingConfig.removeTemperature) {
        delete options.temperature;
      }
    }

    // Set up context management before token counting so estimates use matching options.
    const compactionThresholdPercent = getConfig<number>(
      'texra.model.compactionThresholdPercent',
      DEFAULT_COMPACTION_THRESHOLD_PERCENT,
    );
    const compactionConsumed = setupContextManagement(
      {
        options,
        contextWindow: effectiveContextWindow,
        thresholdPercent: compactionThresholdPercent,
      },
      this.isToolUseMode(),
      isCompactionEligibleModel(this.config.fullName),
      this.compactionRequested,
    );
    if (compactionConsumed) {
      this.compactionRequested = false;
    }

    // Phase 2: COUNT - Estimate input tokens using built params
    // Phase 3: VALIDATE - Adjust max_tokens if needed
    if (this.supportsTokenCounting && documentAnalysis.hasFileSource) {
      this.logger.debug(
        'Skipping token counting because Anthropic countTokens does not support file-based document sources.',
      );
    } else {
      await this.applyTokenCountLimit({
        // Reuse built params for token counting (build once principle).
        countTokens: async () => {
          const inputTokens = await this.estimateTokenCount(messages, {
            client,
            systemPrompt,
            anthropicTools: options.tools,
            thinking: options.thinking,
            outputConfig: options.output_config ?? undefined,
            contextManagement: options.context_management ?? undefined,
            betas: options.betas,
          });
          measuredInputTokens = inputTokens;
          return inputTokens;
        },
        currentMaxTokens: options.max_tokens,
        contextWindow: effectiveContextWindow,
        detailLabel: 'Anthropic: max_tokens reduced to fit context window',
        applyReduced: (adjusted) => {
          options.max_tokens = adjusted;

          // Only adjust thinking budget when using manual mode and it would
          // violate API constraint (budget_tokens must be < max_tokens).
          // Adaptive thinking has no budget_tokens to adjust.
          if (
            options.thinking?.type === 'enabled' &&
            options.thinking.budget_tokens >= options.max_tokens
          ) {
            const newBudget = Math.max(1024, options.max_tokens - 1024);
            this.logger.debug(
              'Adjusted thinking budget due to reduced max_tokens',
              {
                data: {
                  previousBudgetTokens: options.thinking.budget_tokens,
                  newBudgetTokens: newBudget,
                },
              },
            );
            options.thinking.budget_tokens = newBudget;
          }
        },
      });
    }

    if (documentAnalysis.hasBase64Pdf) {
      const uploadResult = await replaceDocumentDataWithUploads(
        client,
        messages,
        this.capabilities.supportsNativePdf,
        this.uploadedPdfPageCounts,
      );
      if (uploadResult.hasFileReference) {
        hasFileReference = true;
      }
    }

    if (hasFileReference) {
      ensureBeta(options, FILES_API_BETA);
    }

    // Phase 4: EXECUTE - Dispatch through the provider's two SDK paths.
    const response = useStreaming
      ? await this.executeStreamingResponse(client, options, signal)
      : await client.beta.messages.create(options, { signal });

    // Log server-side compaction events when present in response content.
    logContextManagementFromResponse(
      response,
      effectiveContextWindow,
      this.logger,
    );

    return { response };
  }

  /** Initializes the message array for Anthropic chat models with user prefix, request, and optional media. */
  async initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: FileLocation[],
    _systemPrompt?: string,
  ): Promise<MessageParam[]> {
    const trimmedPrefix = userPrefix.trim();
    const trimmedRequest = userRequest.trim();

    if (!trimmedPrefix && !trimmedRequest) {
      const errMsg =
        'Anthropic messages require a non-empty user prefix or request.';
      this.logger.error(errMsg);
      throw new Error(errMsg);
    }

    // Create content list for the user message
    const userMessageContent: ContentBlockParam[] = [];

    if (trimmedPrefix) {
      userMessageContent.push({
        type: 'text',
        text: trimmedPrefix,
        citations: null,
      });
    }

    // Add media if provided (images and native PDFs)
    if (mediaFiles?.length && this.capabilities.supportsVision) {
      const formattedMediaContent = await this.createMediaForRound(
        mediaFiles,
        'initial',
      );
      userMessageContent.push(...formattedMediaContent);
    }

    // Add user request with optional caching
    if (trimmedRequest) {
      const requestBlock: ContentBlockParam = {
        type: 'text',
        text: trimmedRequest,
        citations: null,
      };
      userMessageContent.push(requestBlock);
    }

    // Note: Anthropic handles system prompts differently via createResponse()
    const messages: MessageParam[] = [
      { role: 'user', content: userMessageContent },
    ];

    return messages;
  }

  /** Creates message array for subsequent rounds, managing cache control and image content. */
  async createRoundMessages(
    messages: MessageParam[],
    userMessage: string,
    mediaFiles?: FileLocation[],
  ): Promise<MessageParam[]> {
    // Create content list for the new round message
    const roundContent: ContentBlockParam[] = [];

    // Add media if provided (images and native PDFs)
    if (mediaFiles?.length && this.capabilities.supportsVision) {
      const formattedMediaContent = await this.createMediaForRound(
        mediaFiles,
        'followUp',
      );
      roundContent.push(...formattedMediaContent);
    }

    // Add message text with optional caching
    const trimmedMessage = userMessage.trim();
    if (trimmedMessage) {
      const messageBlock: ContentBlockParam = {
        type: 'text',
        text: trimmedMessage,
        citations: null,
      };
      roundContent.push(messageBlock);
    }

    if (roundContent.length === 0) {
      const errMsg =
        'Anthropic follow-up messages require at least one non-empty content block.';
      this.logger.error(errMsg);
      throw new Error(errMsg);
    }

    messages.push({ role: 'user', content: roundContent });

    return messages;
  }

  async createUserFollowUpMessages(
    messages: MessageParam[],
    userMessage: string,
  ): Promise<MessageParam[]> {
    const trimmedMessage = userMessage.trim();
    if (!trimmedMessage) {
      const errMsg =
        'Anthropic follow-up messages require non-empty user text.';
      this.logger.error(errMsg);
      throw new Error(errMsg);
    }
    const content: ContentBlockParam[] = [
      { type: 'text', text: trimmedMessage, citations: null },
    ];
    messages.push({ role: 'user', content });

    return messages;
  }

  createAssistantMessage(text: string): MessageParam {
    return {
      role: 'assistant',
      content: [{ type: 'text', text, citations: null }],
    };
  }

  override extractAssistantText(message: MessageParam): string | undefined {
    if (message.role !== 'assistant') return undefined;
    if (typeof message.content === 'string') return message.content;
    if (!Array.isArray(message.content)) return undefined;
    return joinNonEmpty(
      message.content
        .filter(
          (b): b is { type: 'text'; text: string } =>
            (b as { type?: string }).type === 'text',
        )
        .map((b) => b.text),
    );
  }

  /** Converts image/document content array into Anthropic-compatible message format with type and source metadata. */
  createMediaContent(mediaMessage: MediaEntry[]): ContentBlockParam[] {
    if (mediaMessage.length === 0) {
      return [];
    }
    this.logger.debug(
      `Creating media content for ${mediaMessage.length} items for Anthropic`,
    );
    return mediaMessage.flatMap((media): ContentBlockParam[] => {
      if (media.media_category === 'image') {
        // for backward compatibility
        // Always ensure media_type exists
        const originalMediaType = media.media_type;
        let resolvedMediaType = originalMediaType;
        if (!resolvedMediaType) {
          // Default to image/png since PDFs from TikZ are converted to PNG
          this.logger.warn(
            `No media_type found for image ${media.file_name}, defaulting to image/png`,
          );
          resolvedMediaType = 'image/png';
        }

        // Check for native PDF support
        const isPdf =
          this.capabilities.supportsNativePdf &&
          originalMediaType === 'application/pdf';
        const descriptionBlock = {
          type: 'text',
          text: `${isPdf ? 'Document' : 'Image'}: ${media.file_name}`,
          citations: null,
        } satisfies TextBlockParam;

        if (isPdf) {
          const documentBlock = {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: media.data,
            },
            title: media.file_name,
          } satisfies BetaRequestDocumentBlock;
          return [descriptionBlock, documentBlock];
        }

        let imageMediaType: Base64ImageSource['media_type'];
        if (isSupportedImageMediaType(resolvedMediaType)) {
          imageMediaType = resolvedMediaType;
        } else {
          if (resolvedMediaType !== 'image/png') {
            this.logger.warn(
              'Unsupported image media type, defaulting to image/png',
              {
                data: {
                  mediaType: resolvedMediaType,
                  fileName: media.file_name,
                },
              },
            );
          }
          imageMediaType = 'image/png';
        }

        const imageBlock = {
          type: 'image',
          source: {
            type: 'base64',
            media_type: imageMediaType,
            data: media.data,
          },
        } satisfies BetaImageBlockParam;

        return [descriptionBlock, imageBlock];
      } else if (media.media_category === 'audio') {
        // Anthropic doesn't explicitly support native audio input yet
        this.logger.warn(
          `Audio input received (${media.file_name}) but native audio is not currently supported by the Anthropic handler. Skipping.`,
        );
        return []; // Return empty array to skip audio
      } else {
        this.logger.warn(
          `Unknown media category for Anthropic: ${media.media_category}`,
        );
        return [];
      }
    });
  }

  /** Processes Anthropic API response, handling errors, and formatting while returning response object. */
  extractResponse(
    responseObject: BetaMessage,
    endTag: string,
  ): ExtractResponseResult {
    // Check for empty response
    if (responseObject.usage.output_tokens === 3) {
      // Anthropic specific empty response check
      const errorMsg = 'No output generated - API returned empty response';
      this.logger.error(errorMsg);
      this.logger.debug('responseObject', { data: responseObject });
      this.logger.debug('responseObject.content', {
        data: responseObject.content,
      });
      throw new Error(errorMsg);
    }

    // Extract base response
    const stopReason = responseObject.stop_reason;
    let newResponse = responseObject.content
      .filter(isBetaTextBlock)
      .map((block) => block.text.trim())
      .join('');

    // Add end tag if needed
    newResponse = this.appendEndTagIfNeeded(
      newResponse,
      endTag,
      stopReason === ANTHROPIC_STOP.STOP_SEQUENCE,
    );

    newResponse = replacementEngine.applyAll(newResponse);

    return {
      text: newResponse,
      usage: responseObject.usage,
      stopReason: stopReason ?? 'stop',
    };
  }

  protected createPseudoPrefillPrompt(prefill: string): string {
    return `Start your response with:\n${prefill}`;
  }

  protected createAssistantMessageForPrefillText(text: string): MessageParam {
    return {
      role: 'assistant',
      content: [{ type: 'text', text } as ContentBlockParam],
    };
  }

  protected appendUserText(
    messages: MessageParam[],
    text: string,
    placement: 'last-user' | 'continuation',
  ): void {
    if (placement === 'continuation') {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text } as ContentBlockParam],
      });
      return;
    }

    const lastMessage = messages.at(-1);
    if (lastMessage && Array.isArray(lastMessage.content)) {
      lastMessage.content.push({
        type: 'text',
        text,
      } as ContentBlockParam);
      return;
    }

    messages.push({
      role: 'user',
      content: [{ type: 'text', text } as ContentBlockParam],
    });
  }

  protected appendTextToLastAssistantMessage(
    messages: MessageParam[],
    text: string,
    options: { afterContinuationPrompt?: boolean; fallbackText?: string } = {},
  ): boolean {
    let targetIndex = messages.length - 1;
    const trailingMessage = messages.at(-1);

    if (options.afterContinuationPrompt) {
      if (!trailingMessage || trailingMessage.role !== 'user') return false;
      if (
        !Array.isArray(trailingMessage.content) ||
        !this.containCutOffMessage(trailingMessage.content)
      ) {
        return false;
      }
      targetIndex = messages.length - 2;
    }

    const targetMessage = messages.at(targetIndex);
    if (!targetMessage || targetMessage.role !== 'assistant') return false;

    if (Array.isArray(targetMessage.content)) {
      if (options.afterContinuationPrompt) {
        const thinkingCount = targetMessage.content.filter(
          isAnyThinkingBlockParam,
        ).length;
        if (thinkingCount > 0) {
          this.logger.debug(
            `Using ${thinkingCount} existing thinking blocks from previous message`,
          );
        }
      }

      targetMessage.content.push({
        type: 'text',
        text,
      } as ContentBlockParam);
    } else {
      targetMessage.content = [
        {
          type: 'text',
          text: options.fallbackText ?? text,
        } as ContentBlockParam,
      ];
    }

    if (options.afterContinuationPrompt) {
      messages.pop();
    }
    return true;
  }

  /** Calculates API usage cost based on input/output tokens and cache usage if supported. */
  computePrice(responseUsage: BetaUsage): number {
    return computeAnthropicPrice(responseUsage, this.pricingConfig());
  }

  /** Normalizes Anthropic usage data into a unified format. */
  normalizeUsage(rawUsage: BetaUsage, responseTimeMs: number): NormalizedUsage {
    return normalizeAnthropicUsage(
      rawUsage,
      responseTimeMs,
      this.pricingConfig(),
    );
  }

  /** Pricing/caching inputs for the extracted usage helpers. */
  private pricingConfig(): AnthropicPricingConfig {
    return {
      ...this.standardPricingConfig(),
      supportsPromptCaching: this.capabilities.supportsPromptCaching,
    };
  }

  protected createAssistantMessageForAccumulatedOutput(
    workspaceState: AgentWorkspaceState,
  ): MessageParam {
    this.logger.debug('Creating new assistant message for fresh request');
    const content: ContentBlockParam[] = [];

    const thinkingBlocks = workspaceState.reasoning.thinkingBlocks;
    if (thinkingBlocks.length > 0) {
      this.logger.debug(
        `Adding ${thinkingBlocks.length} thinking blocks to new assistant message`,
      );
      content.push(
        ...(thinkingBlocks as (
          ThinkingBlockParam | RedactedThinkingBlockParam
        )[]),
      );
      workspaceState.resetReasoning();
    }

    content.push({
      type: 'text',
      text: workspaceState.assembly.accumulatedOutput,
    } as ContentBlockParam);

    return { role: 'assistant', content };
  }

  /** Determines if generation should continue based on stop reason and end tag presence. */
  shouldContinue(
    stopReason: ProviderStopReason,
    newResponse: string,
    _agentSetting: AgentSetting,
  ): boolean {
    // DEBUG: Log the stop reason to help diagnose continuation issues
    this.logger.debug(
      `Checking if should continue - stop reason: "${stopReason}"`,
    );

    // Handle Claude 4 refusal stop reason - never continue when model refuses
    if (stopReason === ANTHROPIC_STOP.REFUSAL) {
      this.logger.warn(
        'Model refused to generate content - stopping generation',
      );
      return false;
    }

    // Continue if we hit max tokens OR stop sequence without an end tag
    const shouldContinue =
      (stopReason === ANTHROPIC_STOP.MAX_TOKENS ||
        stopReason === ANTHROPIC_STOP.STOP_SEQUENCE) &&
      !hasEndTag(newResponse);

    if (!shouldContinue && stopReason === ANTHROPIC_STOP.STOP_SEQUENCE) {
      this.logger.debug('Response complete (end tag found)');
    }

    return shouldContinue;
  }

  /**
   * Process thinking blocks for Anthropic models
   * @param responseObject The response object from Anthropic API
   * @param workspaceState Optional workspaceState to update with the thinking blocks
   * @returns The extracted thinking content (or null if none)
   * This preserves the full thinking objects including signature which is required
   * when sending back to the Anthropic API for continuing a conversation
   */
  processThinkingBlock(
    responseObject: BetaMessage,
    workspaceState?: AgentWorkspaceState,
  ): string | null {
    if (!responseObject) {
      return null;
    }

    // Extract all thinking blocks from the response
    const thinkingBlocks: (BetaThinkingBlock | BetaRedactedThinkingBlock)[] =
      [];
    let regularThinkingContent: string | null = null;

    if (Array.isArray(responseObject.content)) {
      for (const item of responseObject.content) {
        if (item.type === 'thinking' && item.thinking) {
          thinkingBlocks.push(item);
          if (regularThinkingContent === null) {
            regularThinkingContent = item.thinking;
          }
        } else if (item.type === 'redacted_thinking' && item.data) {
          thinkingBlocks.push(item);
        }
      }
    }

    if (thinkingBlocks.length === 0) {
      return null;
    }

    this.logger.debug(`Found ${thinkingBlocks.length} thinking blocks`);

    // If workspaceState is provided, update it with all thinking blocks
    if (workspaceState && !workspaceState.reasoning.thinkingAdded) {
      // Store all thinking blocks for future reference
      if (
        regularThinkingContent &&
        !this.containCutOffMessage(regularThinkingContent)
      ) {
        // Store SDK thinking blocks in workspace state for conversation continuation
        // Use spread to create defensive copy, isolating from SDK response object
        workspaceState.reasoning.thinkingBlocks = [
          ...thinkingBlocks,
        ] as ThinkingBlock[];
        // thinkingBlock is now a getter that returns thinkingBlocks[0]
        workspaceState.reasoning.thinkingAdded = true;
        this.logger.debug(
          `Added ${thinkingBlocks.length} thinking blocks to workspaceState`,
        );
      } else {
        this.logger.debug(
          `Skipping adding thinking blocks to workspaceState because of cut off message`,
        );
      }
    }

    // Return content of the first regular thinking block for logging
    return regularThinkingContent;
  }

  extractToolUse(responseObject: BetaMessage): AnthropicToolCall[] {
    if (!Array.isArray(responseObject?.content)) {
      return [];
    }

    const toolUseBlocks = responseObject.content.filter(isBetaToolUseBlock);

    if (toolUseBlocks.length === 0) {
      return [];
    }

    return toolUseBlocks
      .filter((b) => b.id && b.name)
      .map(
        (toolUseBlock) =>
          ({
            provider: 'anthropic',
            callId: toolUseBlock.id,
            name: toolUseBlock.name,
            input: toolUseBlock.input,
            raw: toolUseBlock,
          }) satisfies AnthropicToolCall,
      );
  }

  /**
   * Extract all server tool data in a single pass.
   * Returns both normalized results for display and raw content blocks for context.
   * Single source of truth for Anthropic server tool extraction.
   *
   * Strips orphaned server_tool_use blocks (missing result pair) to prevent
   * 400 errors when these blocks are echoed in follow-up messages.
   */
  override extractServerToolData(
    responseObject: BetaMessage,
  ): ServerToolExtractionResult {
    return extractAnthropicServerToolData(responseObject);
  }

  /**
   * Extract assistant content blocks from an Anthropic response, excluding tool_use blocks.
   * Preserves thinking, text, server_tool_use, web_search_tool_result, and
   * web_fetch_tool_result blocks.
   *
   * Validates that every server_tool_use (web_search/web_fetch) block has a matching
   * result block. Orphaned server_tool_use blocks are stripped to prevent 400 errors
   * on the next API call.
   */
  override extractAssistantContent(responseObject: BetaMessage): unknown[] {
    return buildAnthropicAssistantContent(
      responseObject,
      { supportsPromptCaching: this.capabilities.supportsPromptCaching },
      this.logger,
    );
  }

  async createToolUseFollowUpMessages(
    client: Anthropic | undefined,
    call: AnthropicToolCall,
    result: ToolResult,
    attachments: ToolFileAttachment[],
    workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<MessageParam[]> {
    const content: ContentBlockParam[] = [];

    // Use stored assistant content if available - preserves original order from API
    // This includes: thinking, text, server_tool_use, web_search_tool_result blocks
    if (workspaceState?.serverToolContent.lastAssistantContent.length) {
      content.push(
        ...(workspaceState.serverToolContent
          .lastAssistantContent as ContentBlockParam[]),
      );
      // Clear all stores after consuming to prevent duplicates
      workspaceState.resetServerToolContent();
      workspaceState.resetReasoning();
    } else {
      // Fall back to reconstructing from separate stores (legacy/non-streaming path)
      if (
        this.capabilities.supportsReasoning &&
        workspaceState?.reasoning.thinkingBlocks &&
        workspaceState.reasoning.thinkingBlocks.length > 0
      ) {
        content.push(
          ...(workspaceState.reasoning.thinkingBlocks as (
            ThinkingBlockParam | RedactedThinkingBlockParam
          )[]),
        );
        workspaceState.resetReasoning();
      }
      if (workspaceState?.serverToolContent.contentBlocks.length) {
        const anthropicBlocks = workspaceState.serverToolContent.contentBlocks
          .filter(isAnthropicServerToolContent)
          .map((block) => block as ContentBlockParam);
        content.push(...anthropicBlocks);
        workspaceState.resetServerToolContent();
      }
      if (text) {
        content.push({ type: 'text', text });
      }
    }

    // Add tool_use block at the end
    const toolInput = call.raw.input ?? {};
    content.push({
      type: 'tool_use',
      id: call.callId,
      name: call.name,
      input: toolInput,
    });
    const callMsg: MessageParam = {
      role: 'assistant',
      content,
    };

    // Result is already sanitized by source - use the passed attachments
    // Create mutable copy with explicit type to avoid type assertions later
    const sanitizedResult: ToolResult = { ...result };
    const canUploadFiles = this.supportsToolResultFileUpload;

    let uploadedAttachments: UploadedAnthropicAttachment[] = [];
    const unsupportedAttachments: ToolFileAttachment[] = [];
    const pageLimitExceeded: ToolFileAttachment[] = [];

    if (canUploadFiles && attachments.length > 0 && client) {
      const uploadResult = await uploadToolAttachments(
        client,
        attachments,
        this.logger,
        this.uploadedPdfPageCounts,
        this.getMaxPdfPages(),
      );
      uploadedAttachments = uploadResult.uploaded;
      unsupportedAttachments.push(...uploadResult.unsupported);
      pageLimitExceeded.push(...uploadResult.pageLimitExceeded);

      if (
        sanitizedResult.status === 'executed' &&
        uploadedAttachments.length > 0
      ) {
        // Store uploaded file info with fileId (Anthropic-specific extension)
        // Type assertion needed because FileReference doesn't include fileId
        sanitizedResult.files = uploadedAttachments.map(
          ({ attachment, fileId }) => ({
            path: attachment.path,
            mimeType: attachment.mimeType,
            description: attachment.description,
            fileId, // Anthropic-specific: retained for potential future reference
          }),
        ) as typeof sanitizedResult.files;
      }
    } else if (attachments.length > 0) {
      unsupportedAttachments.push(...attachments);
    }

    // Build tool result as plain text - JSON wastes tokens
    // Note: Anthropic handles attachments as separate content blocks, not in text
    const toolResultContent: Array<
      TextBlockParam | ImageBlockParam | DocumentBlockParam
    > = [{ type: 'text', text: formatToolResultAsText(result) }];

    const unsupportedNotes: string[] = [];

    for (const uploaded of uploadedAttachments) {
      const attachmentNote = `${uploaded.attachment.path ?? 'attachment'} (${uploaded.attachment.mimeType})`;

      switch (uploaded.blockType) {
        case 'image':
          if (this.canProcessToolResultAttachments && uploaded.base64Data) {
            toolResultContent.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type:
                  (uploaded.mediaType as Base64ImageSource['media_type']) ??
                  'image/png',
                data: uploaded.base64Data,
              },
            } as ImageBlockParam);
          } else {
            unsupportedNotes.push(attachmentNote);
          }
          break;

        case 'document':
          if (uploaded.base64Data) {
            toolResultContent.push({
              type: 'document',
              source: {
                type: 'base64',
                media_type:
                  (uploaded.mediaType as 'application/pdf') ??
                  'application/pdf',
                data: uploaded.base64Data,
              },
              title: basename(uploaded.attachment.path ?? 'attachment.pdf'),
            } as DocumentBlockParam);
          } else {
            unsupportedNotes.push(attachmentNote);
          }
          break;

        default:
          unsupportedNotes.push(attachmentNote);
      }
    }

    if (unsupportedAttachments.length > 0) {
      unsupportedNotes.push(...describeAttachments(unsupportedAttachments));
    }

    if (pageLimitExceeded.length > 0) {
      const remaining = this.getMaxPdfPages() - this.getTrackedPdfPageCount();
      const names = pageLimitExceeded
        .map((a) => a.path ?? 'attachment.pdf')
        .join(', ');
      toolResultContent.unshift({
        type: 'text',
        text: `PDF page limit reached — could not include: ${names}. ${remaining} of ${this.getMaxPdfPages()} PDF pages remaining in this conversation. Tell the user.`,
      });
    }

    if (unsupportedNotes.length > 0) {
      const notesText = unsupportedNotes.join('\n');
      toolResultContent.unshift({
        type: 'text',
        text: formatAttachmentSummaryFromNotes(notesText, 'metadata-fallback'),
      });
      if (!sanitizedResult.attachmentSummary) {
        // Store summary without the instruction (it's in the text block above)
        sanitizedResult.attachmentSummary = `Attachments available but returned as metadata only:\n${notesText}`;
      }
    }

    const resultMsg: MessageParam = {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: call.callId,
          content: toolResultContent,
          is_error: result.status === 'error' || undefined,
        },
      ],
    };

    return [callMsg, resultMsg];
  }

  // =========================================================================
  // Message modification methods (for post-build enrichment)
  // =========================================================================

  /**
   * Prepend text to the last user message in the conversation.
   */
  prependTextToUserMessage(messages: MessageParam[], text: string): void {
    if (!text.trim()) return;

    const lastUserMsg = messages.findLast((m) => m.role === 'user');
    if (!lastUserMsg) return;

    if (typeof lastUserMsg.content === 'string') {
      lastUserMsg.content = text + lastUserMsg.content;
    } else if (Array.isArray(lastUserMsg.content)) {
      const firstTextBlock = lastUserMsg.content.find(
        (block): block is TextBlockParam => block.type === 'text',
      );
      if (firstTextBlock) {
        firstTextBlock.text = text + firstTextBlock.text;
      } else {
        lastUserMsg.content.unshift({
          type: 'text',
          text,
        } as ContentBlockParam);
      }
    }
  }

  /**
   * Add media files to the last user message in the conversation.
   */
  async addMediaToUserMessage(
    messages: MessageParam[],
    mediaFiles: FileLocation[],
  ): Promise<MediaAttachmentKind[]> {
    if (!mediaFiles.length || !this.capabilities.supportsVision) return [];

    const lastUserMsg = messages.findLast((m) => m.role === 'user');
    if (!lastUserMsg) return [];

    const formattedMedia = await this.createMediaForRound(mediaFiles, 'insert');
    if (formattedMedia.length === 0) return [];

    if (typeof lastUserMsg.content === 'string') {
      lastUserMsg.content = [
        ...formattedMedia,
        { type: 'text', text: lastUserMsg.content } as ContentBlockParam,
      ];
    } else if (Array.isArray(lastUserMsg.content)) {
      lastUserMsg.content.unshift(...formattedMedia);
    }
    return this.consumeInsertedAttachmentKinds('insert');
  }
}
