// Standard library imports
import { Buffer } from 'node:buffer';
import { basename, dirname } from 'node:path';

// Third-party imports
import {
  Anthropic,
  APIError as AnthropicAPIError,
  APIUserAbortError as AnthropicUserAbortError,
  toFile,
} from '@anthropic-ai/sdk';
import { PDFDocument } from '@cantoo/pdf-lib';

// Local imports - agent
import type { AgentConfig } from '@agent/core/AgentConfig';
import { type AgentSetting, hasEndTag } from '@agent/core/AgentDataclass';
import {
  AnthropicAPIResponseUsage,
  AnthropicUsage,
} from '@agent/core/ResponseUsage';
import {
  AgentWorkspaceState,
  ThinkingBlock,
} from '@agent/core/AgentWorkspaceState';
import { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { MediaEntry } from '@agent/utils/mediaTypes';
import { calculateTokenPrice } from '@agent/utils/priceUtils';

// Local imports - common
import { getConfig } from '@agent/core/config';
import {
  getSdkErrorMessage,
  isContextWindowError,
  attachStreamDiagnostics,
  attachPartialText,
  takeTail,
  isUserAbort,
  PARTIAL_TEXT_TAIL_MAX,
} from '@common/errors/sdkErrorUtils';

// Local imports - replacement
import replacementEngine from '@replacement/engine';

// Local imports - tools
import type { ToolFileAttachment } from '@tools/result';

// Local imports - utils
import { AbsoluteFS, flexibleFS, type FileLocation } from '@utils/files';
import { getAnthropicDynamicFiltering } from '@utils/config/providerConfig';
import { objectToLogString } from '@utils/text/stringUtils';

// Local file imports
import {
  getAnthropicMaxPdfPages,
  DEFAULT_COMPACTION_THRESHOLD_PERCENT,
  TOOL_USE_SAFETY_BUFFER,
} from './contextManagementConstants';
import { AnthropicStreamHandler } from './support/AnthropicStreamHandler';
import { toAnthropicTools } from './toolConversion';
import { ANTHROPIC_STOP } from './types/StopReasonTypes';
import {
  extractAnthropicWebFetchResults,
  extractAnthropicWebSearchResults,
  isAnthropicServerToolContent,
  isAnthropicServerToolUse,
  isAnthropicWebFetchResult,
  isAnthropicWebSearchResult,
  type ServerToolExtractionResult,
} from './types/ServerToolTypes';
import { prepareExistingOutputContent } from './utils/fileContentUtils';
import {
  describeAttachments,
  formatAttachmentSummaryFromNotes,
  formatToolResultAsText,
  loadAttachmentBuffer,
  type ToolResultPayload,
} from './utils/toolAttachmentUtils';
import { computeCachePercentage } from './utils/usageNormalization';
import {
  tagAnthropicSdkError,
  withSdkErrorTag,
} from './support/sdkErrorAdapters';

// Type imports
import type { ProviderStopReason } from './types/StopReasonTypes';
import type {
  CreateResponseOptions,
  CreateResponseResult,
  ExtractResponseResult,
  AnthropicToolCall,
  TokenCountOptions,
} from './types/IModelHandler';
import type { AnthropicBeta } from '@anthropic-ai/sdk/resources/beta/beta';
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaCompactionBlock,
  BetaCompactionIterationUsage,
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
  CacheControlEphemeral,
  MessageParam,
  ContentBlock,
  ContentBlockParam,
  ToolUseBlock,
  TextBlockParam,
  ImageBlockParam,
  DocumentBlockParam,
  ThinkingBlockParam,
  RedactedThinkingBlockParam,
  ServerToolUseBlock,
  WebSearchToolResultBlock,
  WebFetchToolResultBlock,
} from '@anthropic-ai/sdk/resources/messages';

/** Supported image media types from SDK's Base64ImageSource definition */
const SUPPORTED_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const isSupportedImageMediaType = (
  mediaType: string,
): mediaType is Base64ImageSource['media_type'] =>
  SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType);

interface UploadedAnthropicAttachment {
  attachment: ToolFileAttachment;
  fileId: string;
  blockType: 'image' | 'document';
  base64Data?: string;
  mediaType?: string;
}

type ErrorWithRequestId = Error & { request_id?: string };

/**
 * Extracts the tail of text content from a (possibly partial) BetaMessage.
 * The SDK's stream.currentMessage accumulates all content blocks as they
 * arrive, so on a stream failure this already holds whatever text was
 * generated — no custom buffering required. Returns the suffix because
 * continuation prompts only reference the last few hundred chars.
 */
function extractPartialTextTail(
  message: BetaMessage | undefined,
  maxChars: number,
): string {
  if (!message?.content) return '';
  const text = message.content
    .filter(
      (block): block is Extract<BetaContentBlock, { type: 'text' }> =>
        block.type === 'text',
    )
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

/**
 * Anthropic-specific model handler implementation for managing API interactions and message processing.
 */

const FILES_API_BETA: AnthropicBeta = 'files-api-2025-04-14';
const SONNET_37_OUTPUT_BETA: AnthropicBeta = 'output-128k-2025-02-19';
const INTERLEAVED_THINKING_BETA: AnthropicBeta =
  'interleaved-thinking-2025-05-14';
const CONTEXT_MANAGEMENT_BETA: AnthropicBeta = 'context-management-2025-06-27';
const COMPACTION_BETA: AnthropicBeta = 'compact-2026-01-12';
const EXTENDED_CACHE_TTL_BETA: AnthropicBeta = 'extended-cache-ttl-2025-04-11';

const OPUS_46_FULLNAME = 'claude-opus-4-6';
const OPUS_47_FULLNAME = 'claude-opus-4-7';
const SONNET_46_FULLNAME = 'claude-sonnet-4-6';

/** Compaction must be triggered at or above this minimum input token threshold. */
const MIN_COMPACTION_TRIGGER_TOKENS = 50_000;

/**
 * 1M context window is available natively for Opus 4.6, Opus 4.7, and Sonnet 4.6
 * at standard pricing (no beta header needed). Context window sizes
 * are provided directly by llm-zoo. Other Claude models use 200K.
 */

/**
 * Model patterns that require temperature removal when thinking is enabled.
 * Per Anthropic docs, Claude 4 and Claude 3.7 Sonnet models don't support temperature with thinking.
 */
const THINKING_TEMPERATURE_EXCLUDED_PATTERNS = [
  'claude-opus-4',
  'claude-sonnet-4',
  'claude-haiku-4',
  'claude-3-7-sonnet',
];

/**
 * Options for setting up context management configuration.
 */
interface ContextManagementSetupOptions {
  options: MessageCreateParams;
  contextWindow: number;
  thresholdPercent: number;
}

type CacheControlCompactionBlock = Extract<
  BetaContentBlockParam,
  { type: 'compaction' }
>;

const SHORT_CACHE_CONTROL: CacheControlEphemeral = {
  type: 'ephemeral',
};

const LONG_CACHE_CONTROL: CacheControlEphemeral = {
  type: 'ephemeral',
  ttl: '1h',
};

function isLongCacheControl(cacheControl: unknown): boolean {
  if (!cacheControl || typeof cacheControl !== 'object') {
    return false;
  }
  const marker = cacheControl as Partial<CacheControlEphemeral>;
  return marker.type === 'ephemeral' && marker.ttl === '1h';
}

// Cache creation cost multipliers relative to base input price, by TTL.
const CACHE_CREATION_COST_MULTIPLIER_5M = 1.25;
const CACHE_CREATION_COST_MULTIPLIER_1H = 2.0;

// Anthropic allows up to 4 cache breakpoint slots total. Top-level automatic
// caching uses one slot, and the system prompt uses another when present.
// enforceCacheControlLimit dynamically computes the remaining slots available
// for message-level blocks (e.g. compaction blocks).
const MAX_CACHE_BREAKPOINT_SLOTS = 4;

const isCompactionCacheControlBlock = (
  block: ContentBlockParam | ContentBlock | BetaContentBlockParam | undefined,
): block is CacheControlCompactionBlock => {
  if (block == null || typeof block !== 'object') return false;
  return (block as { type?: string }).type === 'compaction';
};

export class ModelHandlerAnthropic extends ModelHandler<
  MessageParam,
  AnthropicUsage,
  AnthropicAPIResponseUsage,
  AnthropicToolCall,
  Anthropic,
  BetaMessage
> {
  /** Flag to force compaction on the next API call, set by requestCompaction(). */
  private compactionRequested = false;

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

      for (const block of this.extractDocumentBlocks(contentBlocks)) {
        const source = (block as DocumentBlockParam).source as
          | { type: string; file_id?: string }
          | undefined;
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

  private isClaudeOpus46(): boolean {
    return this.config.fullName.startsWith(OPUS_46_FULLNAME);
  }

  private isClaudeOpus47(): boolean {
    return this.config.fullName.startsWith(OPUS_47_FULLNAME);
  }

  private isClaudeSonnet46(): boolean {
    return this.config.fullName.startsWith(SONNET_46_FULLNAME);
  }

  /** Returns the PDF page limit based on the model's effective context window. */
  private getMaxPdfPages(): number {
    return getAnthropicMaxPdfPages(this.getEffectiveContextWindow());
  }

  /**
   * Whether this model supports adaptive thinking with the effort parameter.
   * Per Anthropic docs, Opus 4.6, Opus 4.7, and Sonnet 4.6 support adaptive thinking.
   * Opus 4.7 only accepts adaptive thinking — manual budget_tokens returns 400.
   */
  private supportsAdaptiveThinking(): boolean {
    return (
      this.isClaudeOpus46() || this.isClaudeOpus47() || this.isClaudeSonnet46()
    );
  }

  /**
   * Returns the Anthropic effort level for the current model.
   * Maps the llm-zoo ReasoningEffort enum to Anthropic's effort levels.
   * Falls back to 'high' (the API default) when no specific effort is configured.
   * 'max' is only valid for Opus-tier models (Opus 4.6 and Opus 4.7).
   */
  private getAnthropicEffort(): BetaOutputConfig['effort'] {
    const reasoningEffort = this.getEffectiveReasoningEffort();
    if (!reasoningEffort) {
      return 'high';
    }

    switch (reasoningEffort) {
      case 'xhigh':
        // 'max' is supported on Opus 4.6 and Opus 4.7
        return this.isClaudeOpus46() || this.isClaudeOpus47() ? 'max' : 'high';
      case 'high':
        return 'high';
      case 'medium':
        return 'medium';
      case 'low':
      case 'none':
        // Anthropic doesn't support fully disabling thinking; 'low' is the minimum.
        return 'low';
      default:
        return 'high';
    }
  }

  /** Whether this model supports Anthropic's native server-side context compaction. */
  private isCompactionEligibleModel(): boolean {
    return (
      this.isClaudeOpus46() || this.isClaudeOpus47() || this.isClaudeSonnet46()
    );
  }

  override get supportsManualCompaction(): boolean {
    return this.isCompactionEligibleModel() && this.isToolUseMode();
  }

  override requestCompaction(): void {
    this.compactionRequested = true;
  }

  /**
   * Anthropic supports file uploads via their Files API.
   */
  protected override get supportsToolResultFileUpload(): boolean {
    return true;
  }

  /** Ensures a beta flag is included in options, initializing the array if needed. */
  private ensureBeta(options: MessageCreateParams, beta: AnthropicBeta): void {
    if (!options.betas) {
      options.betas = [];
    }
    if (!options.betas.includes(beta)) {
      options.betas.push(beta);
    }
  }

  private hasLongCacheControlMarker(messages: MessageParam[]): boolean {
    return messages.some((message) => {
      if (!Array.isArray(message.content)) {
        return false;
      }
      return message.content.some((block) =>
        isLongCacheControl(
          (block as { cache_control?: unknown }).cache_control,
        ),
      );
    });
  }

  /**
   * Sets up context management configuration for Anthropic's server-side editing.
   * Must be called before token counting so estimate options match create options.
   */
  private setupContextManagement({
    options,
    contextWindow,
    thresholdPercent,
  }: ContextManagementSetupOptions): void {
    if (!this.isToolUseMode()) {
      return;
    }

    if (!this.isCompactionEligibleModel()) {
      return;
    }

    // Consume the manual compaction flag only after preconditions pass
    const forceCompaction = this.compactionRequested;
    if (forceCompaction) {
      this.compactionRequested = false;
    }

    // Only enable context management if threshold is configured (> 0) or manually requested
    if (thresholdPercent <= 0 && !forceCompaction) {
      return;
    }

    this.ensureBeta(options, CONTEXT_MANAGEMENT_BETA);

    const contextManagementEdits = [
      ...(options.context_management?.edits ?? []),
    ];

    if (
      !contextManagementEdits.some((edit) => edit.type === 'compact_20260112')
    ) {
      this.ensureBeta(options, COMPACTION_BETA);
      // Anthropic currently enforces a 50K minimum trigger value for compact_20260112.
      // Keep manual compaction at that floor so the server accepts the request and
      // compacts on the next call for any normal conversation.
      const compactionTriggerTokens = forceCompaction
        ? MIN_COMPACTION_TRIGGER_TOKENS
        : Math.max(
            MIN_COMPACTION_TRIGGER_TOKENS,
            Math.floor((thresholdPercent / 100) * contextWindow),
          );

      contextManagementEdits.push({
        type: 'compact_20260112',
        trigger: {
          type: 'input_tokens',
          value: compactionTriggerTokens,
        },
        pause_after_compaction: false,
      });
    }

    options.context_management = {
      ...(options.context_management ?? {}),
      edits: contextManagementEdits,
    } satisfies BetaContextManagementConfig;
  }

  async getClient(): Promise<Anthropic> {
    const credential = await this.getApiKey();
    const baseUrl = this.getBaseUrl();
    this.logger.debug(`Using Anthropic API. Base URL: ${baseUrl}`);

    // For relay auth: credential is the user's JWT, SDK sends it via x-api-key header
    return new Anthropic({ apiKey: credential, baseURL: baseUrl });
  }

  /**
   * Whether this handler supports native token counting via API.
   * Uses Anthropic's countTokens endpoint for exact pre-flight counts.
   */
  override get supportsTokenCounting(): boolean {
    return this.capabilities.supportsTokenCounting;
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
    if (this.hasLongCacheControlMarker(messages)) {
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

  /** Creates a chat completion response using Anthropic's API with specified parameters and optional system prompt. */
  async createResponse(
    requestOptions: CreateResponseOptions<MessageParam, Anthropic>,
  ): Promise<CreateResponseResult<BetaMessage, MessageParam>> {
    return withSdkErrorTag(tagAnthropicSdkError, this.config.provider, () =>
      this.createResponseImpl(requestOptions),
    );
  }

  /** Creates an Anthropic response after SDK-boundary error tagging is installed. */
  private async createResponseImpl(
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

    this.enforceCacheControlLimit(messages, reservedCacheSlots, cacheControl);

    const documentAnalysis = this.analyzeDocumentSources(messages);
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
      (isLongCacheControl(cacheControl) ||
        this.hasLongCacheControlMarker(messages))
    ) {
      this.ensureBeta(options, EXTENDED_CACHE_TTL_BETA);
    }

    if (tools?.length) {
      options.tools = toAnthropicTools(tools, {
        supportsNativeWebSearch: this.capabilities.supportsNativeWebSearch,
        // Web fetch is available on the same Anthropic models that support native web search
        supportsNativeWebFetch: this.capabilities.supportsNativeWebSearch,
        useDynamicFiltering: getAnthropicDynamicFiltering(),
      });

      (options as MessageCreateParams).tool_choice = { type: 'auto' };

      // Models using adaptive thinking get interleaved thinking automatically.
      // Only add the beta header for older models that need it explicitly.
      if (
        this.capabilities.supportsInterleavedThinking &&
        !this.supportsAdaptiveThinking()
      ) {
        this.ensureBeta(options, INTERLEAVED_THINKING_BETA);
      }

      // Memory tool requires the context management beta header
      if (tools.some((t) => t.name === 'memory')) {
        this.ensureBeta(options, CONTEXT_MANAGEMENT_BETA);
      }
    }

    // Enable thinking for any models that support reasoning
    if (this.capabilities.supportsReasoning) {
      this.logger.debug('Enabling thinking for model with reasoning support');

      if (this.supportsAdaptiveThinking()) {
        // Opus 4.6, Opus 4.7, and Sonnet 4.6: use adaptive thinking with effort parameter.
        // Adaptive thinking lets the model decide when and how much to think,
        // and automatically enables interleaved thinking between tool calls.
        // budget_tokens is deprecated on these models.
        const effort = this.getAnthropicEffort();
        // Opus 4.7 defaults display to 'omitted', which suppresses reasoning
        // output. Request 'summarized' so thinking tokens still stream to the
        // user — older adaptive-thinking models already emit reasoning by
        // default and are unaffected.
        options.thinking = this.isClaudeOpus47()
          ? { type: 'adaptive', display: 'summarized' }
          : { type: 'adaptive' };
        options.output_config = {
          ...options.output_config,
          effort,
        };

        this.logger.debug(
          `Set adaptive thinking with effort: ${effort} (max_tokens: ${options.max_tokens})`,
        );
      } else {
        // Older models: use manual thinking with budget_tokens
        // budget_tokens must be < max_tokens; use 50% to leave room for actual output
        const maxBudget = Math.floor(options.max_tokens * 0.5);

        const defaultBudget = useStreaming ? 32768 : 4096;
        const thinkingBudget = Math.min(defaultBudget, maxBudget);

        options.thinking = {
          type: 'enabled',
          budget_tokens: thinkingBudget,
        };

        this.logger.debug(
          `Set thinking budget: ${thinkingBudget} tokens (max_tokens: ${options.max_tokens}, streaming: ${useStreaming})`,
        );
      }

      // Remove temperature for Claude 4 models when thinking is enabled as per Anthropic docs
      const requiresNoTemperature = THINKING_TEMPERATURE_EXCLUDED_PATTERNS.some(
        (pattern) => this.config.fullName.includes(pattern),
      );
      if (requiresNoTemperature) {
        delete options.temperature;
      }
    }

    // Add beta features for Claude 3.7 Sonnet to increase max output to 128k tokens and enable thinking
    if (this.config.fullName === 'claude-3-7-sonnet-20250219') {
      // Add the output beta while preserving existing betas (e.g., interleaved thinking, context management)
      this.ensureBeta(options, SONNET_37_OUTPUT_BETA);
      // Update max tokens to use the higher limit when streaming
      options.max_tokens = useStreaming ? 64000 : this.config.maxOutputTokens;
      // The thinking configuration is now handled above for all reasoning models
    }

    // Set up context management before token counting so estimates use matching options.
    const compactionThresholdPercent = getConfig<number>(
      'texra.model.compactionThresholdPercent',
      DEFAULT_COMPACTION_THRESHOLD_PERCENT,
    );
    this.setupContextManagement({
      options,
      contextWindow: effectiveContextWindow,
      thresholdPercent: compactionThresholdPercent,
    });

    // Phase 2: COUNT - Estimate input tokens using built params
    // Phase 3: VALIDATE - Adjust max_tokens if needed
    if (this.supportsTokenCounting) {
      if (documentAnalysis.hasFileSource) {
        this.logger.debug(
          'Skipping token counting because Anthropic countTokens does not support file-based document sources.',
        );
      } else {
        // Token counting uses soft failure - if it fails, we proceed without adjustment
        // and let the API enforce limits. This avoids unnecessary retries for non-critical operations.
        try {
          // Reuse built params for token counting (build once principle)
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

          // Validate and adjust max_tokens if needed (throws if context window exceeded)
          // Use larger safety buffer for tool-use mode
          const tokenBuffer = this.isToolUseMode()
            ? TOOL_USE_SAFETY_BUFFER
            : undefined;
          const validation = this.validateTokenLimits(
            inputTokens,
            options.max_tokens,
            effectiveContextWindow,
            tokenBuffer,
          );

          if (validation.adjustedMaxTokens !== options.max_tokens) {
            const originalMaxTokens = options.max_tokens;
            this.logger.logContextManagement(
              `Token count of message plus max tokens exceeds context window: ${inputTokens} + ${originalMaxTokens} > ${effectiveContextWindow}. Reducing max tokens to ${validation.adjustedMaxTokens}.`,
              {
                action: 'max_tokens_reduced',
                tokensBefore: inputTokens,
                contextWindow: effectiveContextWindow,
                utilizationBefore:
                  validation.utilizationPercent ??
                  (inputTokens / effectiveContextWindow) * 100,
                originalMaxTokens,
                reducedMaxTokens: validation.adjustedMaxTokens,
                details: 'Anthropic: max_tokens reduced to fit context window',
              },
            );
            options.max_tokens = validation.adjustedMaxTokens;

            // Only adjust thinking budget when using manual mode and it would
            // violate API constraint (budget_tokens must be < max_tokens).
            // Adaptive thinking has no budget_tokens to adjust.
            if (
              options.thinking?.type === 'enabled' &&
              options.thinking.budget_tokens >= options.max_tokens
            ) {
              const newBudget = Math.max(1024, options.max_tokens - 1024);
              this.logger.debug(
                `Adjusted thinking budget from ${options.thinking.budget_tokens} to ${newBudget} due to reduced max_tokens`,
              );
              options.thinking.budget_tokens = newBudget;
            }
          }
        } catch (err) {
          tagAnthropicSdkError(err, this.config.provider);
          // Re-throw context window violations - these are intentional validation errors
          // that should fail fast, not be swallowed by soft failure
          if (isContextWindowError(err)) {
            throw err;
          }
          // Soft failure for token counting API errors - proceed without adjustment
          this.logger.debug(
            `Token counting failed: ${getSdkErrorMessage(err)}. Proceeding without token adjustment.`,
          );
        }
      }
    }

    if (documentAnalysis.hasBase64Pdf) {
      const uploadResult = await this.replaceDocumentDataWithUploads(
        client,
        messages,
      );
      if (uploadResult.hasFileReference) {
        hasFileReference = true;
      }
    }

    if (hasFileReference) {
      this.ensureBeta(options, FILES_API_BETA);
    }

    // Phase 4: EXECUTE - Make the API call
    let response: BetaMessage;

    if (useStreaming) {
      // in the future if we pass stream to outside, calling stream.controller.abort() will abort the stream; which will be very useful for our stop button
      // we should also make sure partial results can be returned in the presence of errors!
      const stream = await client.beta.messages.stream(options, { signal });

      if (signal?.aborted) {
        stream.controller.abort();
        throw new AnthropicUserAbortError();
      }

      let cleanupAbortListener: (() => void) | undefined;
      if (signal) {
        const abortListener = () => {
          stream.controller.abort();
          signal.removeEventListener('abort', abortListener);
        };
        signal.addEventListener('abort', abortListener);
        cleanupAbortListener = () => {
          signal.removeEventListener('abort', abortListener);
        };
      }

      const streamHandler = new AnthropicStreamHandler(
        this.logger,
        {
          outputEnabled: this.isOutputStreamingEnabled(),
          progressViewEnabled: this.progressViewEnabled,
        },
        {
          createThinkingStream: () => this.createThinkingStream(),
          createOutputStream: () => this.createOutputStream(),
        },
      );

      try {
        streamHandler.attachToStream(stream);

        // Note that there is no second consumption problem as per anthropic sdk examples
        response = await stream.finalMessage();

        // Validate stream completeness: when a relay proxy gracefully closes the
        // connection mid-thinking, the SDK's for-await loop ends normally and
        // finalMessage() resolves with a partial response (stop_reason: null,
        // no message_stop event). Detect this and throw instead of silently
        // returning truncated output.
        const diagnostics = streamHandler.getDiagnostics();
        if (!diagnostics.messageStopReceived) {
          // The catch block below will read current diagnostics, attach them
          // to the enriched error, and keep one diagnostics snapshot. The
          // retry node owns the visible failure row.
          throw new Error(
            `Stream ended without message_stop after ${diagnostics.elapsedSecs}s ` +
              `(${diagnostics.eventsProcessed} events, ` +
              `${diagnostics.thinkingChars} thinking chars, ` +
              `${diagnostics.textChars} text chars). ` +
              `Stream truncated, likely proxy idle timeout during extended thinking.`,
          );
        }

        // Store thinking blocks for API conversation continuation
        this.processThinkingBlock(response);
      } catch (streamError) {
        tagAnthropicSdkError(streamError, this.config.provider);

        const diagnostics = streamHandler.getDiagnostics();
        const partialText = extractPartialTextTail(
          stream.currentMessage,
          PARTIAL_TEXT_TAIL_MAX,
        );
        const requestId = stream.request_id;

        // Wrap only non-APIError, non-abort stream failures. APIError
        // subclasses carry status/headers/requestID/type needed for retry
        // classification; AnthropicUserAbortError is a sibling of
        // AnthropicAPIError, so wrapping it would break downstream
        // `instanceof AnthropicUserAbortError` checks.
        const isAbort = isUserAbort(streamError);
        let enrichedError: unknown = streamError;
        if (
          !stream.currentMessage &&
          streamError instanceof Error &&
          !(streamError instanceof AnthropicAPIError) &&
          !isAbort
        ) {
          enrichedError = new Error(
            `Stream closed before message_start after ${diagnostics.elapsedSecs}s ` +
              `(${diagnostics.eventsProcessed} events). ` +
              `Likely connection dropped before the API responded.`,
            { cause: streamError },
          );
        }

        // detectRequestId() reads .request_id off the thrown error, so set it
        // on whichever object we're throwing (the wrapper or the original).
        if (requestId && enrichedError instanceof Error) {
          (enrichedError as ErrorWithRequestId).request_id = requestId;
        }

        const logMessage = `Stream ${isAbort ? 'aborted' : 'failed'}: ${enrichedError instanceof Error ? enrichedError.message : String(enrichedError)}`;
        const logData = {
          data: {
            isUsingRelay: this.shouldUseServerSideKeys(),
            baseUrl: this.getBaseUrl() ?? 'default',
            model: this.config.fullName,
            streamDiagnostics: diagnostics,
            partialTextLength: partialText.length,
          },
        };
        // The retry node owns user-facing failure reporting. Keep stream
        // diagnostics available without showing a second visible failure row.
        this.logger.debug(logMessage, logData);

        attachStreamDiagnostics(enrichedError, diagnostics);
        attachPartialText(enrichedError, partialText);
        throw enrichedError;
      } finally {
        // Always finalize stream handler to prevent memory leaks on error
        streamHandler.finalize();
        cleanupAbortListener?.();
      }
    } else {
      response = await client.beta.messages.create(options, { signal });
    }

    // Log server-side compaction events when present in response content.
    this.logContextManagementFromResponse(response, effectiveContextWindow);

    return { response };
  }

  /**
   * Log context management events from the Anthropic response.
   * Compaction events are surfaced via `content` blocks and usage iterations.
   */
  private logContextManagementFromResponse(
    response: BetaMessage,
    contextWindow: number,
  ): void {
    // Anthropic's input_tokens excludes cached tokens (unlike OpenAI where it's the total).
    // Per SDK docs: "Total input tokens is the summation of input_tokens,
    // cache_creation_input_tokens, and cache_read_input_tokens."
    const totalInputTokens =
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0);

    const compactionBlock = response.content.find(
      (block): block is BetaCompactionBlock => block.type === 'compaction',
    );
    if (!compactionBlock) {
      return;
    }

    const compactionIteration = (response.usage as BetaUsage).iterations?.find(
      (iteration): iteration is BetaCompactionIterationUsage =>
        iteration.type === 'compaction',
    );
    const tokensBefore = compactionIteration
      ? compactionIteration.input_tokens +
        compactionIteration.cache_read_input_tokens +
        compactionIteration.cache_creation_input_tokens
      : totalInputTokens;
    const details = compactionBlock.content
      ? `Anthropic native compaction (${compactionBlock.content.length.toLocaleString()} chars)`
      : 'Anthropic native compaction (empty summary)';
    const summary = compactionBlock.content?.trim() || undefined;

    this.logger.logContextManagement(
      `Server-side compaction: summarized context`,
      {
        action: 'compaction',
        tokensBefore,
        tokensAfter: totalInputTokens,
        contextWindow,
        utilizationBefore: (tokensBefore / contextWindow) * 100,
        utilizationAfter: (totalInputTokens / contextWindow) * 100,
        details,
        summary,
      },
    );
  }

  /**
   * Enforces the Anthropic cache breakpoint slot limit for message-level blocks.
   *
   * With top-level automatic caching, only compaction blocks need explicit
   * cache_control markers in messages. All other block-level markers (including
   * legacy markers from saved conversations) are stripped. Compaction markers
   * are then trimmed to fit within the remaining slot budget.
   *
   * @param messages - The conversation messages to enforce limits on
   * @param reservedSlots - Number of slots already used by system prompt
   *   and top-level automatic caching
   */
  private enforceCacheControlLimit(
    messages: MessageParam[],
    reservedSlots: number,
    cacheControl: CacheControlEphemeral,
  ): void {
    if (!this.capabilities.supportsPromptCaching) {
      return;
    }

    const compactionBlocks: CacheControlCompactionBlock[] = [];

    for (const message of messages) {
      const content = message.content;
      if (!Array.isArray(content) || !content.length) {
        continue;
      }

      for (const block of content) {
        if (!block || typeof block !== 'object') {
          continue;
        }

        // Cast to a broader type that includes compaction blocks (which appear
        // at runtime via server-side context management but aren't in
        // ContentBlockParam).
        const anyBlock = block as ContentBlockParam | BetaContentBlockParam;

        // Compaction blocks keep an explicit marker, but it must match the
        // current request's top-level TTL so Anthropic sees monotone breakpoints.
        if (isCompactionCacheControlBlock(anyBlock)) {
          anyBlock.cache_control = cacheControl;
          compactionBlocks.push(anyBlock);
          continue;
        }

        // Strip cache_control from all other blocks (legacy markers from saved
        // conversations or ineligible block types). Top-level automatic caching
        // handles the "last block" breakpoint now.
        if ('cache_control' in block) {
          delete (block as { cache_control?: unknown }).cache_control;
        }
      }
    }

    // Trim compaction markers if they exceed the remaining slot budget
    const availableSlots = Math.max(
      0,
      MAX_CACHE_BREAKPOINT_SLOTS - reservedSlots,
    );
    const excess = Math.max(0, compactionBlocks.length - availableSlots);
    for (let idx = 0; idx < excess; idx += 1) {
      delete compactionBlocks[idx].cache_control;
    }
  }

  private async replaceDocumentDataWithUploads(
    client: Anthropic,
    messages: MessageParam[],
  ): Promise<{ uploaded: boolean; hasFileReference: boolean }> {
    if (!this.capabilities.supportsNativePdf) {
      return { uploaded: false, hasFileReference: false };
    }

    let uploaded = false;
    let hasFileReference = false;

    for (const message of messages) {
      const contentBlocks = message.content;
      if (!Array.isArray(contentBlocks)) {
        continue;
      }

      for (const block of this.extractDocumentBlocks(contentBlocks)) {
        // Cast to beta source type: upload code stores BetaFileDocumentSource
        // entries (via Files API) into non-beta message arrays.
        const source = block.source as BetaRequestDocumentBlock['source'];

        if (source.type === 'file') {
          hasFileReference = true;
          continue;
        }

        if (source.type !== 'base64') {
          continue;
        }

        const mediaType = source.media_type;
        if (mediaType !== 'application/pdf') {
          continue;
        }

        const base64Data = source.data;
        if (!base64Data) {
          continue;
        }

        const filename =
          (block.title ?? 'document.pdf').trim() || 'document.pdf';
        const sanitizedFilename = this.sanitizeFilename(filename);
        let buffer: Buffer | undefined;
        let uploadedSource: BetaRequestDocumentBlock['source'] | undefined;

        try {
          buffer = Buffer.from(base64Data, 'base64');

          // Count pages before upload so we can track them for future validation
          const pageCount = await this.countPdfPagesFromBuffer(buffer);

          const uploadedFile = await client.beta.files.upload({
            file: await toFile(buffer!, sanitizedFilename, {
              type: mediaType,
            }),
            betas: [FILES_API_BETA],
          });

          uploadedSource = {
            type: 'file',
            file_id: uploadedFile.id,
          } as BetaRequestDocumentBlock['source'];

          // Track page count so uploadToolAttachments can enforce
          // the PDF page limit in subsequent rounds
          if (pageCount > 0) {
            this.uploadedPdfPageCounts.set(uploadedFile.id, pageCount);
          }
        } finally {
          if (buffer) {
            buffer.fill(0);
            buffer = undefined;
          }
        }

        if (uploadedSource) {
          delete (source as { data?: string }).data;
          (block as BetaRequestDocumentBlock).source = uploadedSource;
          uploaded = true;
          hasFileReference = true;
        }
      }
    }

    return { uploaded, hasFileReference };
  }

  /**
   * Extracts all document blocks from a content block array, including those
   * nested inside tool_result blocks. PDFs attached as tool result attachments
   * (e.g., from ArXiv downloads) are nested inside tool_result content and
   * would be missed by a top-level-only scan.
   */
  private extractDocumentBlocks(
    contentBlocks: ContentBlockParam[],
  ): DocumentBlockParam[] {
    const documents: DocumentBlockParam[] = [];
    for (const block of contentBlocks) {
      if (block.type === 'document' && block.source) {
        documents.push(block);
      } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (const nested of block.content) {
          if (
            nested.type === 'document' &&
            (nested as DocumentBlockParam).source
          ) {
            documents.push(nested as DocumentBlockParam);
          }
        }
      }
    }
    return documents;
  }

  private analyzeDocumentSources(messages: MessageParam[]): {
    hasFileSource: boolean;
    hasBase64Pdf: boolean;
  } {
    let hasFileSource = false;
    let hasBase64Pdf = false;

    for (const message of messages) {
      const contentBlocks = message.content;
      if (!Array.isArray(contentBlocks)) {
        continue;
      }

      for (const block of this.extractDocumentBlocks(contentBlocks)) {
        const source = block.source as BetaRequestDocumentBlock['source'];
        if (source.type === 'file') {
          hasFileSource = true;
        } else if (
          source.type === 'base64' &&
          source.media_type === 'application/pdf' &&
          source.data
        ) {
          hasBase64Pdf = true;
        }

        // Early exit if both found
        if (hasFileSource && hasBase64Pdf) {
          return { hasFileSource: true, hasBase64Pdf: true };
        }
      }
    }

    return { hasFileSource, hasBase64Pdf };
  }

  /**
   * Count pages in a PDF buffer without writing to disk.
   * Returns 0 on parse failure so the API can enforce the limit as fallback.
   */
  private async countPdfPagesFromBuffer(buffer: Buffer): Promise<number> {
    try {
      const pdfDoc = await PDFDocument.load(buffer, {
        updateMetadata: false,
        ignoreEncryption: true,
      });
      return pdfDoc.getPageCount();
    } catch {
      return 0;
    }
  }

  /**
   * Uploads tool file attachments (images and PDFs) to the Anthropic Files API.
   */
  private async uploadToolAttachments(
    client: Anthropic,
    attachments: ToolFileAttachment[],
  ): Promise<{
    uploaded: UploadedAnthropicAttachment[];
    unsupported: ToolFileAttachment[];
    pageLimitExceeded: ToolFileAttachment[];
  }> {
    const uploaded: UploadedAnthropicAttachment[] = [];
    const unsupported: ToolFileAttachment[] = [];
    const pageLimitExceeded: ToolFileAttachment[] = [];

    for (const attachment of attachments) {
      const mimeType = attachment.mimeType ?? 'application/octet-stream';
      const normalized = mimeType.toLowerCase();
      const isImage = isSupportedImageMediaType(normalized);
      const isPdf = normalized === 'application/pdf';

      if (!isImage && !isPdf) {
        unsupported.push(attachment);
        continue;
      }

      let buffer: Buffer | undefined;
      try {
        buffer = await loadAttachmentBuffer(attachment);
      } catch (err) {
        this.logger.warn(
          `Unable to read attachment ${attachment.path ?? 'attachment'}: ${getSdkErrorMessage(err)}`,
        );
        unsupported.push(attachment);
        continue;
      }

      // Check PDF page limit before uploading
      let pdfPageCount = 0;
      if (isPdf) {
        pdfPageCount = await this.countPdfPagesFromBuffer(buffer);
        if (
          this.getTrackedPdfPageCount() + pdfPageCount >
          this.getMaxPdfPages()
        ) {
          pageLimitExceeded.push(attachment);
          buffer.fill(0);
          buffer = undefined;
          continue;
        }
      }

      try {
        const filename = this.sanitizeFilename(
          attachment.path ??
            (isPdf
              ? 'document.pdf'
              : `image.${normalized.split('/').pop() ?? 'png'}`),
        );

        const base64Data = buffer.toString('base64');
        const uploadedFile = await client.beta.files.upload({
          file: await toFile(buffer!, filename, { type: mimeType }),
          betas: [FILES_API_BETA],
        });

        if (isPdf && pdfPageCount > 0) {
          this.uploadedPdfPageCounts.set(uploadedFile.id, pdfPageCount);
        }

        uploaded.push({
          attachment,
          fileId: uploadedFile.id,
          blockType: isPdf ? 'document' : 'image',
          base64Data,
          mediaType: normalized,
        });
      } catch (err) {
        unsupported.push(attachment);
      } finally {
        if (buffer) {
          buffer.fill(0);
          buffer = undefined;
        }
      }
    }

    return { uploaded, unsupported, pageLimitExceeded };
  }

  private sanitizeFilename(filename: string): string {
    const baseName = basename(filename) || filename;
    const trimmed = baseName.trim();
    const withoutControlChars = Array.from(trimmed, (char) =>
      char.charCodeAt(0) < 32 ? '_' : char,
    ).join('');
    const withoutForbidden = withoutControlChars.replaceAll(
      /[:<>"|?*\\/]/g,
      '_',
    );
    // Use || here (not ??) because we need to catch empty strings, not just null/undefined
    const sanitized = withoutForbidden || 'document.pdf';
    // Removing directory information avoids Anthropic rejecting names that contain
    // slashes, but it also means the model loses subdirectory context when
    // generating citations for assets or pictures that originally lived in nested
    // folders.
    return sanitized.slice(0, 255);
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
      const formattedMediaContent = (await this.createMediaMessage(
        mediaFiles,
      )) as ContentBlockParam[];
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
      try {
        const formattedMediaContent = (await this.createMediaMessage(
          mediaFiles,
        )) as ContentBlockParam[];
        roundContent.push(...formattedMediaContent);
      } catch (err) {
        this.logger.logError(
          `Error processing media files for follow-up round: ${getSdkErrorMessage(err)}`,
          err,
          { operation: 'process media files' },
        );
      }
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
    const texts = message.content
      .filter(
        (b): b is { type: 'text'; text: string } =>
          (b as { type?: string }).type === 'text',
      )
      .map((b) => b.text)
      .filter(Boolean);
    return texts.length > 0 ? texts.join('\n') : undefined;
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
              `Unsupported image media type ${resolvedMediaType} for ${media.file_name}, defaulting to image/png`,
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
      this.logger.debug(`responseObject: ${objectToLogString(responseObject)}`);
      this.logger.debug(
        `responseObject.content: ${objectToLogString(responseObject.content)}`,
      );
      throw new Error(errorMsg);
    }

    // Extract base response
    const stopReason = responseObject.stop_reason;
    let newResponse = responseObject.content
      .filter(
        (block): block is Extract<BetaContentBlock, { type: 'text' }> =>
          block.type === 'text',
      )
      .map((block) => block.text.trim())
      .join('');

    // Add end tag if needed
    if (
      stopReason === ANTHROPIC_STOP.STOP_SEQUENCE &&
      !newResponse.includes(endTag)
    ) {
      newResponse += `\n${endTag}`;
    }

    newResponse = replacementEngine.applyAll(newResponse);

    return {
      text: newResponse,
      usage: responseObject.usage,
      stopReason: stopReason ?? 'stop',
    };
  }

  /** Manages continuation with prefill support (typically no-op for models with prefill). */
  addContinueMessageWithPrefill(
    _messages: MessageParam[],
    _workspaceState: AgentWorkspaceState,
    _agentSetting: AgentSetting,
  ): void {
    this.defaultAddContinueWithPrefill();
  }

  /** Manages continuation for models without prefill support by adding a continuation prompt. */
  addContinueMessageWithoutPrefill(
    messages: MessageParam[],
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
    const content: ContentBlockParam[] = [
      { type: 'text', text: userMessageContinuation },
    ];
    messages.push({ role: 'user', content });
  }

  /** Initializes output file and handles prefill content, returning [isComplete, updatedMessages]. */
  async initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: MessageParam[],
    workspaceState: AgentWorkspaceState,
    outputLocation: FileLocation,
    prefill: string,
  ): Promise<[boolean, MessageParam[]]> {
    if (!(await flexibleFS.existsAndNonTrivial(outputLocation))) {
      if (this.capabilities.supportsAssistantPrefill) {
        if (prefill.length === 0) {
          // Anthropic rejects assistant messages with empty text content blocks.
          // When an agent declares no prefill, skip pushing the assistant turn
          // entirely so the model produces its response from a clean slate.
          this.logger.debug(
            'No prefill provided; skipping assistant prefill message',
          );
          return [false, messages];
        }
        this.logger.debug(`Adding prefill message:\n${prefill}`);
        workspaceState.assembly.accumulatedOutput = `${prefill}\n`;
        await AbsoluteFS.ensureDir(dirname(outputLocation.absolutePath));
        await flexibleFS.write(
          outputLocation,
          workspaceState.assembly.accumulatedOutput,
        );
        messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: prefill }],
        });
      } else {
        if (prefill.length === 0) {
          // No prefill declared --- skip the pseudo-prefill instruction so the
          // model isn't told `Start your response with:\n` (an empty directive).
          this.logger.debug(
            'No prefill provided; skipping pseudo-prefill instruction',
          );
        } else {
          // For thinking-enabled models that don't support assistant prefill,
          // add prefill as part of the user message like OpenAI handler
          const pseudoPrefillText = `Start your response with:\n${prefill}`;
          const lastMsg = messages.at(-1);
          if (lastMsg && Array.isArray(lastMsg.content)) {
            lastMsg.content.push({
              type: 'text',
              text: pseudoPrefillText,
            } as ContentBlockParam);
          }
          this.logger.debug(
            `Added pseudo prefill message to messages:\n${pseudoPrefillText}`,
          );
        }
      }
      return [false, messages];
    }

    // Prepare existing file content (read, clean, extract scratchpad, update state)
    const { fileContent } = await prepareExistingOutputContent(
      outputLocation,
      workspaceState,
      this.logger,
    );

    if (hasEndTag(agentSetting, fileContent)) {
      this.logger.debug(
        'End tag detected - adding completed response and skipping model call',
      );
      // Add the completed assistant response to conversation
      // This is critical for multi-round agents on resume - the conversation
      // must include this round's response for subsequent rounds to have context
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: fileContent }],
      });

      return [true, messages];
    }

    this.logger.debug(
      'Output file exists but no end tag found - continuing from file',
    );

    // For thinking-enabled models that don't support assistant prefill,
    // add continuation as part of the user message

    const content: ContentBlockParam[] = [{ type: 'text', text: fileContent }];
    this.logger.debug(
      `Using existing content as prefill: ${outputLocation.absolutePath}`,
    );
    messages.push({ role: 'assistant', content });

    if (!this.capabilities.supportsAssistantPrefill) {
      // For models that don't support assistant prefill, we need to:
      // add a continuation message in addition
      this.addContinueMessageWithoutPrefill(
        messages,
        workspaceState,
        agentSetting,
      );

      this.logger.debug(
        `Added existing content as assistant message and continuation prompt`,
      );
    }

    return [false, messages];
  }

  /** Calculates API usage cost based on input/output tokens and cache usage if supported. */
  computePrice(responseUsage: AnthropicUsage): number {
    if (!responseUsage) {
      return 0;
    }

    // Note: Anthropic doesn't provide tool_use_tokens in their API response
    const usageTotals = this.getUsageTokenTotals(responseUsage);

    // Standard pricing applies across the full context window (no long-context premium).
    const inputPrice = this.config.inputPrice;
    const outputPrice = this.config.outputPrice;

    let basePrice = calculateTokenPrice(
      usageTotals.baseInputTokens,
      usageTotals.outputTokens,
      inputPrice,
      outputPrice,
    );

    if (this.capabilities.supportsPromptCaching) {
      if (usageTotals.cacheCreationTokens > 0) {
        const pricedBreakdownTokens =
          usageTotals.cacheCreation5mTokens + usageTotals.cacheCreation1hTokens;

        if (pricedBreakdownTokens > 0) {
          basePrice +=
            (usageTotals.cacheCreation5mTokens *
              inputPrice *
              CACHE_CREATION_COST_MULTIPLIER_5M) /
            1e6;
          basePrice +=
            (usageTotals.cacheCreation1hTokens *
              inputPrice *
              CACHE_CREATION_COST_MULTIPLIER_1H) /
            1e6;

          const unclassifiedCacheCreationTokens = Math.max(
            usageTotals.cacheCreationTokens - pricedBreakdownTokens,
            0,
          );
          basePrice +=
            (unclassifiedCacheCreationTokens *
              inputPrice *
              CACHE_CREATION_COST_MULTIPLIER_5M) /
            1e6;
        } else {
          basePrice +=
            (usageTotals.cacheCreationTokens *
              inputPrice *
              CACHE_CREATION_COST_MULTIPLIER_5M) /
            1e6;
        }
      }
      if (usageTotals.cacheReadTokens > 0) {
        basePrice +=
          (usageTotals.cacheReadTokens *
            inputPrice *
            this.capabilities.cacheDiscountFactor) /
          1e6;
      }
    }

    return basePrice;
  }

  /** Normalizes Anthropic usage data into a unified format. */
  normalizeUsage(
    rawUsage: AnthropicUsage,
    responseTimeMs: number,
  ): NormalizedUsage {
    if (!rawUsage) {
      return {
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        responseTimeMs,
        provider: 'anthropic',
      };
    }

    const usageTotals = this.getUsageTokenTotals(rawUsage);
    const totalInput =
      usageTotals.baseInputTokens +
      usageTotals.cacheReadTokens +
      usageTotals.cacheCreationTokens;

    return {
      inputTokens: totalInput,
      outputTokens: usageTotals.outputTokens,
      cost: this.computePrice(rawUsage),
      responseTimeMs,
      provider: 'anthropic',
      cachedInputTokens: usageTotals.cacheReadTokens || undefined,
      cacheCreationTokens: usageTotals.cacheCreationTokens || undefined,
      percentageCached: computeCachePercentage(
        usageTotals.cacheReadTokens + usageTotals.cacheCreationTokens,
        totalInput,
      ),
      serverToolRequests:
        (rawUsage.server_tool_use?.web_search_requests ?? 0) +
          (rawUsage.server_tool_use?.web_fetch_requests ?? 0) || undefined,
      _native: rawUsage,
    };
  }

  /**
   * Gets Anthropic input/output/cache token totals.
   * Uses per-iteration usage when available so compaction requests are fully billed.
   */
  private getUsageTokenTotals(responseUsage: AnthropicUsage): {
    baseInputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    cacheCreation5mTokens: number;
    cacheCreation1hTokens: number;
  } {
    const usageWithIterations = responseUsage as AnthropicUsage & {
      iterations?: BetaUsage['iterations'];
    };
    const iterations = usageWithIterations.iterations;
    if (Array.isArray(iterations) && iterations.length > 0) {
      let baseInputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheCreationTokens = 0;
      let cacheCreation5mTokens = 0;
      let cacheCreation1hTokens = 0;

      for (const iteration of iterations) {
        baseInputTokens += iteration.input_tokens;
        outputTokens += iteration.output_tokens;
        cacheReadTokens += iteration.cache_read_input_tokens;
        cacheCreationTokens += iteration.cache_creation_input_tokens;
        cacheCreation5mTokens +=
          iteration.cache_creation?.ephemeral_5m_input_tokens ?? 0;
        cacheCreation1hTokens +=
          iteration.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      }

      return {
        baseInputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        cacheCreation5mTokens,
        cacheCreation1hTokens,
      };
    }

    return {
      baseInputTokens: responseUsage.input_tokens ?? 0,
      outputTokens: responseUsage.output_tokens ?? 0,
      cacheReadTokens: responseUsage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: responseUsage.cache_creation_input_tokens ?? 0,
      cacheCreation5mTokens:
        responseUsage.cache_creation?.ephemeral_5m_input_tokens ?? 0,
      cacheCreation1hTokens:
        responseUsage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    };
  }

  updateMessageContentWithPrefill(
    messages: MessageParam[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void {
    const lastMessage = messages.at(-1);

    if (lastMessage && lastMessage.role === 'assistant') {
      if (Array.isArray(lastMessage.content)) {
        lastMessage.content.push({
          type: 'text',
          text: bestConnector + newResponse,
        } as ContentBlockParam);
      } else {
        lastMessage.content = [
          {
            type: 'text',
            text: workspaceState.assembly.accumulatedOutput,
          } as ContentBlockParam,
        ];
      }
    } else if (lastMessage?.role === 'user') {
      // No prefill was pushed (agent declared empty prefill). Add the model's
      // response as a new assistant message so multi-round conversation history
      // is preserved.
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: bestConnector + newResponse,
          } as ContentBlockParam,
        ],
      });
    }
  }

  updateMessageContentWithoutPrefill(
    messages: MessageParam[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void {
    // For thinking-enabled anthropic models that don't support assistant prefill,
    // handle like OpenAI models where the last message is always a user message
    const lastMessage = messages.at(-1);
    const secondLastMessage = messages.at(-2);

    if (!lastMessage || lastMessage.role !== 'user') {
      this.logger.error(
        'Last message is not a user message - unexpected format',
      );
      return;
    }

    // Handle continuation after cutoff - append to the previous assistant message
    if (this.containCutOffMessage(lastMessage.content)) {
      this.logger.debug(
        'Last message is a user message asking to continue after cutoff',
      );

      if (!secondLastMessage || secondLastMessage.role !== 'assistant') {
        return;
      }

      if (Array.isArray(secondLastMessage.content)) {
        const thinkingCount = secondLastMessage.content.filter(
          isAnyThinkingBlockParam,
        ).length;
        if (thinkingCount > 0) {
          this.logger.debug(
            `Using ${thinkingCount} existing thinking blocks from previous message`,
          );
        }

        secondLastMessage.content.push({
          type: 'text',
          text: bestConnector + newResponse,
        } as ContentBlockParam);
      }

      messages.pop();
      return;
    }

    // Handle new request - create a new assistant message
    this.logger.debug('Creating new assistant message for fresh request');
    const content: ContentBlockParam[] = [];

    const thinkingBlocks = workspaceState.reasoning.thinkingBlocks;
    if (thinkingBlocks.length > 0) {
      this.logger.debug(
        `Adding ${thinkingBlocks.length} thinking blocks to new assistant message`,
      );
      content.push(
        ...(thinkingBlocks as (
          | ThinkingBlockParam
          | RedactedThinkingBlockParam
        )[]),
      );
      workspaceState.resetReasoning();
    }

    content.push({
      type: 'text',
      text: workspaceState.assembly.accumulatedOutput,
    } as ContentBlockParam);

    messages.push({ role: 'assistant', content });
  }

  /** Determines if generation should continue based on stop reason and end tag presence. */
  shouldContinue(
    stopReason: ProviderStopReason,
    newResponse: string,
    agentSetting: AgentSetting,
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
      !hasEndTag(agentSetting, newResponse);

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
    if (!Array.isArray(responseObject?.content)) {
      return { webSearchResults: [], webFetchResults: [], contentBlocks: [] };
    }

    // Extract content blocks that need to be preserved
    // Filter for server tool content (server_tool_use, web_search_tool_result, web_fetch_tool_result)
    // Cast needed because BetaContentBlock has slightly different types than the regular API
    let contentBlocks = responseObject.content.filter(
      isAnthropicServerToolContent,
    ) as (
      | ServerToolUseBlock
      | WebSearchToolResultBlock
      | WebFetchToolResultBlock
    )[];

    // Collect IDs of result blocks that have matching server_tool_use calls.
    const searchResultIds = new Set(
      contentBlocks
        .filter(isAnthropicWebSearchResult)
        .map((b) => b.tool_use_id),
    );
    const fetchResultIds = new Set(
      contentBlocks.filter(isAnthropicWebFetchResult).map((b) => b.tool_use_id),
    );

    // Strip orphaned server_tool_use blocks that lack a matching result.
    contentBlocks = contentBlocks.filter((block) => {
      if (!isAnthropicServerToolUse(block)) return true;
      if (block.name === 'web_search') return searchResultIds.has(block.id);
      if (block.name === 'web_fetch') return fetchResultIds.has(block.id);
      return true;
    });

    // Extract normalized results for display
    const webSearchResults = extractAnthropicWebSearchResults(
      responseObject.content,
    );
    const webFetchResults = extractAnthropicWebFetchResults(
      responseObject.content,
    );

    return { webSearchResults, webFetchResults, contentBlocks };
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
    if (!Array.isArray(responseObject?.content)) {
      return [];
    }

    let assistantContent = responseObject.content.filter(
      (block) => block.type !== 'tool_use',
    );

    // Validate server_tool_use / result block pairing.
    // The API rejects messages where a server_tool_use block exists
    // without its corresponding result block.
    const searchResultIds = new Set(
      assistantContent
        .filter(isAnthropicWebSearchResult)
        .map((b) => b.tool_use_id),
    );
    const fetchResultIds = new Set(
      assistantContent
        .filter(isAnthropicWebFetchResult)
        .map((b) => b.tool_use_id),
    );
    const orphanedIds: string[] = [];
    for (const block of assistantContent) {
      if (!isAnthropicServerToolUse(block)) continue;
      if (block.name === 'web_search' && !searchResultIds.has(block.id)) {
        orphanedIds.push(block.id);
      } else if (block.name === 'web_fetch' && !fetchResultIds.has(block.id)) {
        orphanedIds.push(block.id);
      }
    }
    if (orphanedIds.length > 0) {
      const orphanSet = new Set(orphanedIds);
      this.logger.debug(
        `Stripping ${orphanedIds.length} orphaned server_tool_use block(s) without matching result: ${orphanedIds.join(', ')}. ` +
          `Response content types: [${responseObject.content.map((b) => b.type).join(', ')}]`,
      );
      assistantContent = assistantContent.filter(
        (block) => !isAnthropicServerToolUse(block) || !orphanSet.has(block.id),
      );
    }

    if (!this.capabilities.supportsPromptCaching) {
      return assistantContent;
    }

    return assistantContent.map((block) =>
      block.type === 'compaction'
        ? { ...block, cache_control: LONG_CACHE_CONTROL }
        : block,
    );
  }

  async createToolUseFollowUpMessages(
    client: Anthropic | undefined,
    call: AnthropicToolCall,
    result: ToolResultPayload,
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
            | ThinkingBlockParam
            | RedactedThinkingBlockParam
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
    const sanitizedResult: ToolResultPayload = { ...result };
    const canUploadFiles = this.supportsToolResultFileUpload;

    let uploadedAttachments: UploadedAnthropicAttachment[] = [];
    const unsupportedAttachments: ToolFileAttachment[] = [];
    const pageLimitExceeded: ToolFileAttachment[] = [];

    if (canUploadFiles && attachments.length > 0 && client) {
      const uploadResult = await this.uploadToolAttachments(
        client,
        attachments,
      );
      uploadedAttachments = uploadResult.uploaded;
      unsupportedAttachments.push(...uploadResult.unsupported);
      pageLimitExceeded.push(...uploadResult.pageLimitExceeded);

      if (uploadedAttachments.length > 0) {
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
          is_error: result.isError || undefined,
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
  ): Promise<void> {
    if (!mediaFiles.length || !this.capabilities.supportsVision) return;

    const lastUserMsg = messages.findLast((m) => m.role === 'user');
    if (!lastUserMsg) return;

    try {
      const formattedMedia = (await this.createMediaMessage(
        mediaFiles,
      )) as ContentBlockParam[];
      if (typeof lastUserMsg.content === 'string') {
        lastUserMsg.content = [
          ...formattedMedia,
          { type: 'text', text: lastUserMsg.content } as ContentBlockParam,
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
