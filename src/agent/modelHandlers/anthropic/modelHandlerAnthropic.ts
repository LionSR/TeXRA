// Node imports
import { Buffer } from 'node:buffer';
import { basename } from 'node:path';

// Third-party imports
import {
  Anthropic,
  APIError as AnthropicAPIError,
  APIUserAbortError as AnthropicUserAbortError,
} from '@anthropic-ai/sdk';

// Local imports
import { startCompactionActivity } from '@agent/trace';
import type { AgentSetting } from '@agent/core/definition/AgentDataclass';
import type {
  AgentWorkspaceState,
  ThinkingBlock,
} from '@agent/core/state/AgentWorkspaceState';
import {
  ModelHandler,
  type AssistantTextAppendOptions,
} from '@agent/modelHandlers/ModelHandler';
import type { ModelCredentialSelection } from '@agent/types/ModelHandlerContracts';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import type { MediaEntry } from '@agent/types/mediaTypes';
import {
  ANTHROPIC_STOP,
  type ProviderStopReason,
} from '@agent/types/StopReasonTypes';
import {
  isAnthropicServerToolContent,
  type ServerToolExtractionResult,
} from '@agent/types/ServerTools';
import type {
  CreateResponseOptions,
  CreateResponseResult,
  ExtractResponseResult,
  AnthropicToolCall,
  TokenCountOptions,
} from '@agent/types/ModelHandlerContracts';
import { attachStreamDiagnostics } from '@common/errors/sdkError/errorMetadata';
import {
  isUserAbort,
  takeTail,
  PARTIAL_TEXT_TAIL_MAX,
} from '@common/errors/sdkError/errorPatterns';
import { handleStreamingFailure } from '@common/errors/sdkError/streamFailure';
import type {
  CompactionActivityOutcome,
  FileLocation,
  MediaAttachmentKind,
  StreamDiagnostics,
} from '@shared/schemas';
import { OUTPUT_END_TAG } from '@shared/schemas';
import { countPdfPagesInBuffer } from '@utils/media/pdfPageCount';

// Local file imports
import { normalizeAnthropicUsage } from './anthropicUsage';
import {
  getAnthropicMaxPdfPages,
  estimateTokensFromText,
} from '../contextManagementConstants';
import { AnthropicStreamHandler } from '../support/AnthropicStreamHandler';
import { AUXILIARY_MAX_RETRIES } from '../support/auxiliaryRetry';
import {
  classifyMediaEntry,
  unknownMediaCategoryWarning,
} from '../support/mediaClassification';
import { toAnthropicTools } from '../toolConversion';
import { wipeBuffer } from '../utils/toolAttachmentUtils';
import { tagAnthropicSdkError } from './anthropicSdkError';
import {
  appendTextToLastAssistantMessage as appendAnthropicTextToLastAssistantMessage,
  addMediaToUserMessage as addAnthropicMediaToUserMessage,
  prependTextToUserMessage as prependAnthropicTextToUserMessage,
  textBlock,
} from './anthropicMessages';
import {
  createBatchedToolUseFollowUpMessages as createAnthropicBatchedToolUseFollowUpMessages,
  type AnthropicToolResultContext,
  type AnthropicToolResultEntry,
} from './anthropicToolResults';
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
  resolveAnthropicCompactionOutcome,
  logContextManagementFromResponse,
  enforceCacheControlLimit,
  type AnthropicCompactionOutcome,
} from './anthropicContextManagement';
import {
  extractDocumentBlocks,
  analyzeDocumentSources,
  replaceDocumentDataWithUploads,
} from './anthropicDocumentHandling';
import { isSupportedImageMediaType } from './anthropicTools';
import {
  buildThinkingConfig,
  isCompactionEligibleModel,
} from './anthropicThinking';
import {
  buildAnthropicAssistantContent,
  extractAnthropicServerToolData,
} from './anthropicServerTools';

// Third-party imports
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
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages';
import type {
  Base64ImageSource,
  CacheControlEphemeral,
  MessageParam,
  ContentBlockParam,
  ToolUseBlock,
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

/** Anthropic's documented upper typical text-token estimate per PDF page. */
const ANTHROPIC_PDF_TOKENS_PER_PAGE_ESTIMATE = 3_000;

/** Keeps resumed-PDF inspection bounded before the model request begins. */
const MAX_PDF_PAGE_COUNT_DOWNLOAD_BYTES = 1024 * 1024;

/** Counts live Files API references after the latest compaction boundary. */
function collectFileReferenceCounts(
  messages: MessageParam[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const contentBlocks = message.content;
    if (!Array.isArray(contentBlocks)) continue;

    if (
      contentBlocks.some(
        (block) => (block as { type?: unknown }).type === 'compaction',
      )
    ) {
      counts.clear();
    }
    for (const { source } of extractDocumentBlocks(contentBlocks)) {
      if (source.type === 'file' && source.file_id) {
        counts.set(source.file_id, (counts.get(source.file_id) ?? 0) + 1);
      }
    }
  }
  return counts;
}

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
  /** Caches file-size token estimates for references that countTokens rejects. */
  private fileTokenEstimates = new Map<string, number>();

  /** Sum of all tracked PDF page counts across uploaded files. */
  private getTrackedPdfPageCount(): number {
    let total = 0;
    for (const count of this.uploadedPdfPageCounts.values()) total += count;
    return total;
  }

  /**
   * Removes page counts and token estimates for file IDs no longer referenced
   * in the current messages. This keeps both caches accurate after server-side
   * compaction drops old messages.
   */
  private pruneTrackedFileMetadata(messages: MessageParam[]): void {
    const liveFileIds = collectFileReferenceCounts(messages);

    for (const cache of [this.uploadedPdfPageCounts, this.fileTokenEstimates]) {
      for (const fileId of cache.keys()) {
        if (!liveFileIds.has(fileId)) {
          cache.delete(fileId);
        }
      }
    }
  }

  /**
   * Estimates the context consumed by Files API references from their metadata.
   * Anthropic cannot count requests containing file sources, while serializing
   * the file_id alone omits the document. Cache the best available estimate so
   * repeated tool-use rounds do not add a metadata request per file.
   */
  private async estimateFileReferenceTokens(
    client: Anthropic,
    messages: MessageParam[],
    signal?: AbortSignal,
    stopAtTokens = Number.POSITIVE_INFINITY,
  ): Promise<number> {
    const fileReferenceCounts = collectFileReferenceCounts(messages);

    let total = 0;
    for (const [fileId, referenceCount] of fileReferenceCounts) {
      signal?.throwIfAborted();
      const pageEstimate =
        (this.uploadedPdfPageCounts.get(fileId) ?? 0) *
        ANTHROPIC_PDF_TOKENS_PER_PAGE_ESTIMATE;
      if (pageEstimate > 0) {
        total += pageEstimate * referenceCount;
        if (total >= stopAtTokens) break;
        continue;
      }

      let sizeEstimate = this.fileTokenEstimates.get(fileId);
      if (sizeEstimate === undefined) {
        let metadataFallback: number | undefined;
        try {
          const metadata = await client.beta.files.retrieveMetadata(
            fileId,
            { betas: [FILES_API_BETA] },
            { signal, maxRetries: 0 },
          );
          metadataFallback = Math.ceil(metadata.size_bytes / 4);
          if (
            metadata.mime_type === 'application/pdf' &&
            metadata.size_bytes <= MAX_PDF_PAGE_COUNT_DOWNLOAD_BYTES
          ) {
            const response = await client.beta.files.download(
              fileId,
              { betas: [FILES_API_BETA] },
              { signal, maxRetries: 0 },
            );
            const buffer = Buffer.from(await response.arrayBuffer());
            try {
              signal?.throwIfAborted();
              // A parse failure falls to the catch below, which applies the
              // metadata fallback the comment there describes.
              const pageCount = await countPdfPagesInBuffer(buffer);
              if (pageCount > 0) {
                this.uploadedPdfPageCounts.set(fileId, pageCount);
                sizeEstimate =
                  pageCount * ANTHROPIC_PDF_TOKENS_PER_PAGE_ESTIMATE;
              } else {
                sizeEstimate = metadataFallback;
                this.fileTokenEstimates.set(fileId, sizeEstimate);
              }
            } finally {
              wipeBuffer(buffer);
            }
          } else {
            // Match the shared no-tokenizer heuristic without materializing a
            // large remote document. Small PDFs are inspected to avoid using
            // compressed bytes as a misleading page-count proxy.
            sizeEstimate = metadataFallback;
            this.fileTokenEstimates.set(fileId, sizeEstimate);
          }
        } catch (error) {
          signal?.throwIfAborted();
          if (metadataFallback !== undefined) {
            // A PDF that cannot be downloaded or parsed must still contribute
            // a stable fallback without repeating the failed body request.
            sizeEstimate = metadataFallback;
            this.fileTokenEstimates.set(fileId, sizeEstimate);
          }
          this.logger.debug(
            'Unable to estimate Anthropic file-reference tokens.',
            { data: { fileId, error } },
          );
        }
      }
      total += (sizeEstimate ?? 0) * referenceCount;
      if (total >= stopAtTokens) break;
    }
    return total;
  }

  /** Returns the PDF page limit based on the model's effective context window. */
  private getMaxPdfPages(): number {
    return getAnthropicMaxPdfPages(this.getEffectiveContextWindow());
  }

  /**
   * Manual compaction is available for workflow and tool-use sessions on
   * models whose llm-zoo family is compaction-eligible. Automatic compaction
   * remains tool-use-only in `setupContextManagement`.
   */
  override get supportsManualCompaction(): boolean {
    return (
      isCompactionEligibleModel(this.config.fullName) &&
      (this.isWorkflowMode() || this.isToolUseMode())
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

  /**
   * Parallel tool results must land as one assistant message carrying all
   * tool_use blocks plus one user message of tool_result blocks — the wire
   * shape the API documents for parallel tool use, and the only one that
   * replays thinking blocks correctly on adaptive-thinking models. See
   * `createBatchedToolUseFollowUpMessages`.
   */
  override get requiresBatchedParallelToolResults(): boolean {
    return true;
  }

  async getClient(
    selection: ModelCredentialSelection = 'configured',
  ): Promise<Anthropic> {
    const credential = await this.resolveClientCredential(selection);
    this.logger.debug(`Using Anthropic API. Base URL: ${credential.baseUrl}`);

    return this.rememberClientCredentialRoute(
      new Anthropic({
        apiKey: credential.apiKey,
        baseURL: credential.baseUrl,
        fetch: this.longRunningModelFetch,
        maxRetries: 0,
      }),
      credential.route,
      credential.apiKey,
    );
  }

  override getRetryEndpoint(client: Anthropic): string {
    return client.baseURL;
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

    const responseTokenCount = await client.beta.messages.countTokens(
      countTokensParams,
      { signal: options?.signal, maxRetries: AUXILIARY_MAX_RETRIES },
    );

    this.logger.debug(
      `Token count of message: ${responseTokenCount.input_tokens}`,
    );

    return responseTokenCount.input_tokens;
  }

  protected override get sdkErrorTagger() {
    return tagAnthropicSdkError;
  }

  override get supportsForcedToolChoice(): boolean {
    // Anthropic rejects named tool_choice when extended/adaptive thinking is
    // enabled. Keep reasoning models on the ordinary terminal-tool floor.
    return !this.capabilities.supportsReasoning;
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

    let compactionOutcome: CompactionActivityOutcome = 'skipped';
    try {
      streamHandler.attachToStream(stream);
      // A clean close before message_stop rejects finalMessage() natively
      // (BetaMessageStream only records a message on the message_stop event
      // and #getFinalMessage throws when none was recorded), so no separate
      // truncation check is needed here.
      const response = await stream.finalMessage();
      compactionOutcome =
        resolveAnthropicCompactionOutcome(response)?.state ?? 'skipped';

      this.processThinkingBlock(response);
      return response;
    } catch (streamError) {
      compactionOutcome = isUserAbort(streamError) ? 'cancelled' : 'failed';
      return handleStreamingFailure(streamError, {
        // Anthropic finalizes unconditionally below, including on success.
        partialTail: () =>
          extractPartialTextTail(stream.currentMessage, PARTIAL_TEXT_TAIL_MAX),
        decorateError: (error, partialText) =>
          this.decorateStreamError(
            error,
            partialText,
            streamHandler.getDiagnostics(),
            stream.request_id ?? undefined,
          ),
      });
    } finally {
      streamHandler.finalize(compactionOutcome);
      signal?.removeEventListener('abort', abortStream);
    }
  }

  /**
   * Phase 1: BUILD - Construct provider-specific request parameters.
   * Extracted from {@link createResponseImpl} verbatim; the only inputs it
   * needs are the already-resolved cache decision and the raw request fields.
   */
  private buildAnthropicRequestParams(
    params: Pick<
      CreateResponseOptions<MessageParam, Anthropic>,
      | 'messages'
      | 'temperature'
      | 'endTag'
      | 'systemPrompt'
      | 'tools'
      | 'finalTool'
    > & {
      supportsCache: boolean;
      cacheControl: CacheControlEphemeral;
      useStreaming: boolean;
    },
  ): MessageCreateParamsNonStreaming {
    const {
      messages,
      temperature,
      endTag,
      systemPrompt,
      tools,
      finalTool,
      supportsCache,
      cacheControl,
      useStreaming,
    } = params;

    // Typed as the non-streaming member: this handler never sets `stream`, and
    // pinning the member here (rather than the `MessageCreateParams` union)
    // preserves the narrowed type through `dispatchAnthropicExecution`'s
    // `client.beta.messages.create()` call — a plain union parameter type
    // would force TS to pick the ambiguous three-way overload.
    const options: MessageCreateParamsNonStreaming = {
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
        // Web fetch ships on the same Anthropic models as native web search.
        supportsNativeWebSearch: this.capabilities.supportsNativeWebSearch,
      });

      options.tool_choice =
        finalTool && this.supportsForcedToolChoice
          ? { type: 'tool', name: finalTool.name }
          : { type: 'auto' };

      // Models using adaptive thinking get interleaved thinking automatically.
      // Only add the beta header for older models that need it explicitly.
      if (
        this.capabilities.supportsInterleavedThinking &&
        !this.capabilities.supportsAdaptiveThinking
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
        capabilities: this.capabilities,
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

    return options;
  }

  /**
   * Phase 4: EXECUTE - Dispatch through the provider's two SDK paths
   * (streaming vs. non-streaming), including the non-streaming compaction
   * heuristic and post-response bookkeeping. Extracted from
   * {@link createResponseImpl} verbatim; it is the tail of that method, so it
   * returns the final {@link CreateResponseResult} directly.
   */
  private async dispatchAnthropicExecution(params: {
    client: Anthropic;
    options: MessageCreateParamsNonStreaming;
    useStreaming: boolean;
    measuredInputTokens: number | undefined;
    hasFileReference: boolean;
    messages: MessageParam[];
    signal: AbortSignal | undefined;
    effectiveContextWindow: number;
    compactionConsumed: boolean;
    pendingCompactionRequestId: number | undefined;
  }): Promise<CreateResponseResult<BetaMessage, MessageParam>> {
    const {
      client,
      options,
      useStreaming,
      measuredInputTokens,
      hasFileReference,
      messages,
      signal,
      effectiveContextWindow,
      compactionConsumed,
      pendingCompactionRequestId,
    } = params;

    // Non-streaming responses have no block-start event. Use the native count
    // when available and otherwise combine the existing text heuristic with
    // tracked PDF pages. Treating an unavailable count as either zero or
    // definitely over threshold would miss large requests or label every small
    // request as compaction.
    const compactionEdit = options.context_management?.edits?.find(
      (edit) => edit.type === 'compact_20260112',
    );
    const compactionTrigger =
      !useStreaming && compactionEdit?.trigger?.type === 'input_tokens'
        ? compactionEdit.trigger.value
        : undefined;
    let inputTokensForCompaction = measuredInputTokens;
    if (inputTokensForCompaction === undefined) {
      const textTokens = estimateTokensFromText(
        JSON.stringify({
          messages: options.messages,
          system: options.system,
          tools: options.tools,
          thinking: options.thinking,
          outputConfig: options.output_config,
        }),
      );
      const tokensUntilCompaction =
        compactionTrigger === undefined ? 0 : compactionTrigger - textTokens;
      const fileReferenceTokens =
        hasFileReference && tokensUntilCompaction > 0
          ? await this.estimateFileReferenceTokens(
              client,
              messages,
              signal,
              tokensUntilCompaction,
            )
          : 0;
      inputTokensForCompaction = textTokens + fileReferenceTokens;
    }
    const nonStreamingCompactionExpected =
      compactionTrigger !== undefined &&
      inputTokensForCompaction >= compactionTrigger;

    const compactionActivity = nonStreamingCompactionExpected
      ? startCompactionActivity(this.logger)
      : undefined;

    let response: BetaMessage;
    let compactionOutcome: AnthropicCompactionOutcome | undefined;
    try {
      response = useStreaming
        ? await this.executeStreamingResponse(client, options, signal)
        : await client.beta.messages.create(options, { signal });
      compactionOutcome = resolveAnthropicCompactionOutcome(response);
      if (!useStreaming && (compactionActivity || compactionOutcome)) {
        const activity =
          compactionActivity ?? startCompactionActivity(this.logger);
        activity.finish(compactionOutcome?.state ?? 'skipped');
      }
    } catch (error) {
      compactionActivity?.finish(isUserAbort(error) ? 'cancelled' : 'failed');
      throw error;
    }

    if (compactionConsumed && pendingCompactionRequestId !== undefined) {
      this.clearCompactionRequest(pendingCompactionRequestId);
    }

    if (compactionOutcome?.state === 'completed') {
      logContextManagementFromResponse(
        response,
        compactionOutcome,
        effectiveContextWindow,
        this.logger,
      );
    }

    return { response };
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
      finalTool,
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

    // Prune tracked file metadata for file IDs no longer in messages
    // (e.g. after server-side compaction drops old messages)
    if (
      this.uploadedPdfPageCounts.size > 0 ||
      this.fileTokenEstimates.size > 0
    ) {
      this.pruneTrackedFileMetadata(messages);
    }

    const options = this.buildAnthropicRequestParams({
      messages,
      temperature,
      endTag,
      systemPrompt,
      tools,
      finalTool,
      supportsCache,
      cacheControl,
      useStreaming,
    });

    // Set up context management before token counting so estimates use matching options.
    const compactionThresholdPercent = this.getCompactionThresholdPercent();
    const pendingCompactionRequestId = this.getPendingCompactionRequestId();
    const compactionConsumed = setupContextManagement(
      {
        options,
        contextWindow: effectiveContextWindow,
        thresholdPercent: compactionThresholdPercent,
      },
      this.isToolUseMode(),
      isCompactionEligibleModel(this.config.fullName),
      this.isCompactionRequested(),
    );
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
            signal,
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

    signal?.throwIfAborted();

    if (documentAnalysis.hasBase64Pdf) {
      const uploadResult = await replaceDocumentDataWithUploads(
        client,
        messages,
        this.capabilities.supportsNativePdf,
        (fileId, pageCount) =>
          this.uploadedPdfPageCounts.set(fileId, pageCount),
      );
      if (uploadResult.hasFileReference) {
        hasFileReference = true;
      }
    }

    if (hasFileReference) {
      ensureBeta(options, FILES_API_BETA);
    }

    return this.dispatchAnthropicExecution({
      client,
      options,
      useStreaming,
      measuredInputTokens,
      hasFileReference,
      messages,
      signal,
      effectiveContextWindow,
      compactionConsumed,
      pendingCompactionRequestId,
    });
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
      userMessageContent.push(textBlock(trimmedPrefix));
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
      userMessageContent.push(textBlock(trimmedRequest));
    }

    // Note: Anthropic handles system prompts differently via createResponse()
    return [{ role: 'user', content: userMessageContent }];
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
      roundContent.push(textBlock(trimmedMessage));
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
    messages.push({
      role: 'user',
      content: [textBlock(trimmedMessage)],
    });

    return messages;
  }

  createAssistantMessage(text: string): MessageParam {
    return {
      role: 'assistant',
      content: [textBlock(text)],
    };
  }

  override createAssistantMessageFromResponse(
    responseObject: BetaMessage,
    text: string,
  ): MessageParam {
    const outcome = resolveAnthropicCompactionOutcome(responseObject);
    if (outcome?.state !== 'completed') {
      return this.createAssistantMessage(text);
    }

    const content = this.extractAssistantContent({
      ...responseObject,
      content: outcome.content,
    });
    return content.length > 0
      ? { role: 'assistant', content: content as ContentBlockParam[] }
      : this.createAssistantMessage(text);
  }

  override updateMessageContent(
    messages: MessageParam[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
    responseObject?: BetaMessage,
  ): void {
    if (
      responseObject &&
      resolveAnthropicCompactionOutcome(responseObject)?.state === 'completed'
    ) {
      messages.length = 0;
      messages.push(
        this.createAssistantMessageFromResponse(responseObject, newResponse),
      );
      return;
    }

    super.updateMessageContent(
      messages,
      bestConnector,
      newResponse,
      workspaceState,
      responseObject,
    );
  }

  /** Converts image/document content array into Anthropic-compatible message format with type and source metadata. */
  override createMediaContent(mediaMessage: MediaEntry[]): ContentBlockParam[] {
    if (mediaMessage.length === 0) {
      return [];
    }
    this.logger.debug(
      `Creating media content for ${mediaMessage.length} items for Anthropic`,
    );
    return mediaMessage.flatMap((media): ContentBlockParam[] => {
      const classification = classifyMediaEntry(media);

      if (classification === 'audio') {
        // Anthropic doesn't explicitly support native audio input yet
        this.logger.warn(
          `Audio input received (${media.file_name}) but native audio is not currently supported by the Anthropic handler. Skipping.`,
        );
        return []; // Return empty array to skip audio
      }

      if (classification === 'unsupported') {
        this.logger.warn(unknownMediaCategoryWarning(media));
        return [];
      }

      // classification is 'image' or 'pdf' - for backward compatibility,
      // always ensure media_type exists
      let resolvedMediaType = media.media_type;
      if (!resolvedMediaType) {
        // Default to image/png since PDFs from TikZ are converted to PNG
        this.logger.warn(
          `No media_type found for image ${media.file_name}, defaulting to image/png`,
        );
        resolvedMediaType = 'image/png';
      }

      // Check for native PDF support
      const isPdf =
        classification === 'pdf' && this.capabilities.supportsNativePdf;
      const descriptionBlock = textBlock(
        `${isPdf ? 'Document' : 'Image'}: ${media.file_name}`,
      );

      if (isPdf) {
        const documentBlock = {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: media.data,
          },
          // `file_name` may be workspace-relative; the title is a filename.
          title: basename(media.file_name),
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
      .map((block) => this.normalizeResponseText(block.text))
      .join('');

    // Add end tag if needed
    newResponse = this.appendEndTagIfNeeded(
      newResponse,
      endTag,
      stopReason === ANTHROPIC_STOP.STOP_SEQUENCE,
    );

    newResponse = this.postProcessResponse(newResponse);

    return {
      text: newResponse,
      usage: responseObject.usage,
      stopReason: stopReason ?? 'stop',
    };
  }

  protected appendUserText(messages: MessageParam[], text: string): void {
    messages.push({ role: 'user', content: [textBlock(text)] });
  }

  protected appendTextToLastAssistantMessage(
    messages: MessageParam[],
    text: string,
    options: AssistantTextAppendOptions = {},
  ): boolean {
    return appendAnthropicTextToLastAssistantMessage(messages, text, options, {
      logger: this.logger,
      containCutOffMessage: (content) => this.containCutOffMessage(content),
    });
  }

  /** Normalizes Anthropic usage data into a unified format. */
  normalizeUsage(rawUsage: BetaUsage, responseTimeMs: number): NormalizedUsage {
    return normalizeAnthropicUsage(rawUsage, responseTimeMs, {
      ...this.standardPricingConfig(),
      supportsPromptCaching: this.capabilities.supportsPromptCaching,
    });
  }

  protected override createAssistantMessageForAccumulatedOutput(
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

    content.push(textBlock(workspaceState.assembly.accumulatedOutput));

    return { role: 'assistant', content };
  }

  /** Determines if generation should continue based on stop reason and end tag presence. */
  override shouldContinue(
    stopReason: ProviderStopReason,
    newResponse: string,
    _agentSetting: AgentSetting,
  ): boolean {
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

    // Context-window overflow needs the response cycle's bounded compaction
    // recovery, not an ordinary continuation prompt.
    const shouldContinue =
      (stopReason === ANTHROPIC_STOP.MAX_TOKENS ||
        stopReason === ANTHROPIC_STOP.STOP_SEQUENCE) &&
      !newResponse.includes(OUTPUT_END_TAG);

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
    // Extract all thinking blocks from the response
    const thinkingBlocks: (BetaThinkingBlock | BetaRedactedThinkingBlock)[] =
      [];
    let regularThinkingContent: string | null = null;

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

    if (thinkingBlocks.length === 0) {
      return null;
    }

    this.logger.debug(`Found ${thinkingBlocks.length} thinking blocks`);

    // If workspaceState is provided, update it with all thinking blocks
    if (
      workspaceState &&
      workspaceState.reasoning.thinkingBlocks.length === 0
    ) {
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

    return responseObject.content
      .filter(isBetaToolUseBlock)
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

  /**
   * Assistant-side content preceding tool_use blocks. Consumes the stored
   * assistant content (or reconstructs thinking/server-tool blocks) exactly
   * once per model response, so it must be called once per follow-up turn,
   * before any tool_use blocks are appended.
   */
  private buildToolCallAssistantContent(
    workspaceState?: AgentWorkspaceState,
    text?: string,
  ): ContentBlockParam[] {
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
        content.push(textBlock(text));
      }
    }

    return content;
  }

  /** Live bundle for the extracted tool-result builders (./anthropicToolResults). */
  private anthropicToolResultContext(): AnthropicToolResultContext {
    return {
      logger: this.logger,
      supportsToolResultFileUpload: this.supportsToolResultFileUpload,
      canProcessToolResultAttachments: this.canProcessToolResultAttachments,
      getTrackedPdfPageCount: () => this.getTrackedPdfPageCount(),
      recordPdfPageCount: (fileId, pageCount) =>
        this.uploadedPdfPageCounts.set(fileId, pageCount),
      getMaxPdfPages: () => this.getMaxPdfPages(),
      buildToolCallAssistantContent: (workspaceState, text) =>
        this.buildToolCallAssistantContent(workspaceState, text),
    };
  }

  /**
   * Batched variant for parallel tool calls: one assistant message carrying
   * the original response content plus ALL tool_use blocks, then ONE user
   * message with all tool_result blocks. This is the wire shape Anthropic
   * documents for parallel tool use — splitting results into alternating
   * per-call message pairs reads as sequential history and trains the model
   * away from parallel calls (and would replay thinking blocks incorrectly).
   */
  async createBatchedToolUseFollowUpMessages(
    entries: AnthropicToolResultEntry[],
    workspaceState: AgentWorkspaceState | undefined,
    text: string | undefined,
    client: Anthropic,
  ): Promise<MessageParam[]> {
    return createAnthropicBatchedToolUseFollowUpMessages(
      this.anthropicToolResultContext(),
      entries,
      workspaceState,
      text,
      client,
    );
  }

  // =========================================================================
  // Message modification methods (for post-build enrichment)
  // =========================================================================

  /**
   * Prepend text to the last user message in the conversation.
   */
  prependTextToUserMessage(messages: MessageParam[], text: string): void {
    prependAnthropicTextToUserMessage(messages, text);
  }

  /**
   * Add media files to the last user message in the conversation.
   */
  async addMediaToUserMessage(
    messages: MessageParam[],
    mediaFiles: FileLocation[],
  ): Promise<MediaAttachmentKind[]> {
    return addAnthropicMediaToUserMessage(messages, mediaFiles, {
      supportsVision: this.capabilities.supportsVision,
      createMediaForRound: (files) => this.createMediaForRound(files, 'insert'),
      consumeInsertedAttachmentKinds: () =>
        this.consumeInsertedAttachmentKinds('insert'),
    });
  }
}
