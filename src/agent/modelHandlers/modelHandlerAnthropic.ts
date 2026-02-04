// Standard library imports
import { Buffer } from 'node:buffer';
import { basename } from 'node:path';

// Third-party imports
import {
  Anthropic,
  APIUserAbortError as AnthropicUserAbortError,
  toFile,
} from '@anthropic-ai/sdk';

// Local imports - agent
import type { AgentConfig } from '@agent/core/AgentConfig';
import {
  type AgentSetting,
  hasEndTag,
  requireWorkflowSetting,
} from '@agent/core/AgentDataclass';
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
import {
  getSdkErrorMessage,
  isContextWindowError,
  attachStreamDiagnostics,
} from '@common/errors/sdkErrorUtils';

// Local imports - replacement
import replacementEngine from '@replacement/engine';

// Local imports - tools
import type { ToolFileAttachment } from '@tools/result';

// Local imports - utils
import { getConfig } from '@utils/config';
import { isNonEmptyString } from '@utils/core';
import { flexibleFS, type FileLocation } from '@utils/files';
import { objectToLogString } from '@utils/text/stringUtils';

// Local file imports
import { AnthropicStreamHandler } from './support/AnthropicStreamHandler';
import { toAnthropicTools } from './toolConversion';
import { ANTHROPIC_STOP } from './types/StopReasonTypes';
import {
  extractAnthropicWebSearchResults,
  isAnthropicServerToolContent,
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
import {
  computeCachePercentage,
  nonZeroOrUndefined,
} from './utils/usageNormalization';
import { DEFAULT_SUMMARY_PROMPT } from './compaction/compactionPrompt';
import { getCompactionModel } from './compaction/compactionModels';
import { extractSummaryText } from './compaction/compactionUtils';
import { COMPACTION_MAX_TOKENS } from './contextManagementConstants';

// Type imports
import type { ProviderStopReason } from './types/StopReasonTypes';
import type {
  CreateResponseOptions,
  ExtractResponseResult,
  AnthropicToolCall,
  TokenCountOptions,
} from './types/IModelHandler';
import type { AnthropicBeta } from '@anthropic-ai/sdk/resources/beta/beta';
import type {
  BetaContentBlock,
  BetaImageBlockParam,
  BetaMessage,
  BetaRedactedThinkingBlock,
  BetaRequestDocumentBlock,
  BetaThinkingBlock,
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

const CONTEXT_1M_BETA: AnthropicBeta = 'context-1m-2025-08-07';
const FILES_API_BETA: AnthropicBeta = 'files-api-2025-04-14';
const SONNET_37_OUTPUT_BETA: AnthropicBeta = 'output-128k-2025-02-19';
const INTERLEAVED_THINKING_BETA: AnthropicBeta =
  'interleaved-thinking-2025-05-14';
const CONTEXT_MANAGEMENT_BETA: AnthropicBeta = 'context-management-2025-06-27';

const ANTHROPIC_1M_CONTEXT_WINDOW = 1_000_000;

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
 * Block types that support cache_control for prompt caching.
 * Uses SDK's ContentBlockParam with Extract to get text and tool_result types.
 */
type CacheControlEligibleBlock = Extract<
  ContentBlockParam,
  { type: 'text' | 'tool_result' }
>;

const EPHEMERAL_CACHE_CONTROL: CacheControlEphemeral = {
  type: 'ephemeral',
};

const MAX_CACHE_CONTROLLED_BLOCKS = 4;

const isCacheControlEligibleBlock = (
  block: ContentBlockParam | ContentBlock | undefined,
): block is CacheControlEligibleBlock => {
  if (!block || typeof block !== 'object') {
    return false;
  }

  const blockType = (block as { type?: string }).type;
  return blockType === 'text' || blockType === 'tool_result';
};

export class ModelHandlerAnthropic extends ModelHandler<
  MessageParam,
  AnthropicUsage,
  AnthropicAPIResponseUsage,
  AnthropicToolCall,
  Anthropic,
  BetaMessage
> {
  private cacheControlledBlock?: CacheControlEligibleBlock;

  /**
   * Anthropic supports file uploads via their Files API.
   */
  protected override get supportsToolResultFileUpload(): boolean {
    return true;
  }

  /**
   * Sets or clears the cache control target block.
   * Pass a block to set it as the cache target, or undefined/null to clear.
   */
  private updateCacheControlTarget(
    block: CacheControlEligibleBlock | null | undefined,
  ): void {
    // Clear existing cache_control if switching to different block
    if (this.cacheControlledBlock && this.cacheControlledBlock !== block) {
      delete this.cacheControlledBlock.cache_control;
    }

    if (block && this.capabilities.supportsPromptCaching) {
      block.cache_control = EPHEMERAL_CACHE_CONTROL;
    }

    this.cacheControlledBlock = block ?? undefined;
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

  private assignCacheControlToLatest(
    content: (ContentBlockParam | ContentBlock)[] | undefined,
  ): void {
    if (!this.capabilities.supportsPromptCaching) {
      return;
    }

    const target = content?.findLast(isCacheControlEligibleBlock);
    if (target) {
      this.updateCacheControlTarget(target);
    } else if (content?.length) {
      this.logger.debug(
        'No eligible content block available for Anthropic cache control marker',
      );
      this.updateCacheControlTarget(undefined);
    }
  }

  private async compactConversation(
    client: Anthropic,
    messages: MessageParam[],
    systemPrompt?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const compactionModel = getCompactionModel(this.config.fullName);
    const compactionMessages: MessageParam[] = [
      ...messages,
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: DEFAULT_SUMMARY_PROMPT,
          },
        ],
      },
    ];

    const response = await client.beta.messages.create(
      {
        model: compactionModel,
        max_tokens: Math.min(
          this.config.maxOutputTokens,
          COMPACTION_MAX_TOKENS,
        ),
        messages: compactionMessages,
        ...(systemPrompt && { system: systemPrompt }),
      },
      signal ? { signal } : undefined,
    );

    const summaryText = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');

    return extractSummaryText(summaryText);
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
    if (options?.anthropicTools && options.anthropicTools.length > 0) {
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

    // Strip betas that only apply to message creation (e.g., output length)
    // while keeping context headers needed for accurate token counting.
    const countTokenBetas = options?.betas?.filter(
      (beta) => beta === CONTEXT_1M_BETA,
    );
    if (countTokenBetas && countTokenBetas.length > 0) {
      countTokensParams.betas = countTokenBetas;
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
  ): Promise<BetaMessage> {
    const {
      client,
      messages,
      temperature,
      systemPrompt,
      endTag,
      signal,
      tools,
    } = requestOptions;
    let effectiveMessages = messages;
    // Get streaming config
    const useStreaming = this.getStreamingConfig();
    // Track input token count for client-side context management triggering
    let measuredInputTokens: number | undefined;
    const forceCompaction = this.hasPendingCompactionRequest();
    const shouldAttemptCompaction =
      this.isToolUseMode() && (this.isAutoCompactEnabled() || forceCompaction);
    const useAnthropic1MBeta = getConfig<boolean>(
      'texra.model.useAnthropic1MBeta',
      false,
    );
    const isAnthropic1MBetaEligibleModel =
      this.config.fullName === 'claude-sonnet-4-20250514' ||
      this.config.fullName === 'claude-sonnet-4-5';
    const isAnthropic1MBetaActive =
      useAnthropic1MBeta && isAnthropic1MBetaEligibleModel;
    const effectiveContextWindow = isAnthropic1MBetaActive
      ? ANTHROPIC_1M_CONTEXT_WINDOW
      : this.config.contextWindow;

    this.enforceCacheControlLimit(effectiveMessages);

    let documentAnalysis = this.analyzeDocumentSources(effectiveMessages);
    let hasFileReference = documentAnalysis.hasFileSource;

    // Phase 1: BUILD - Construct provider-specific request parameters
    const options: MessageCreateParams = {
      model: this.config.fullName,
      max_tokens: this.config.maxOutputTokens,
      messages: effectiveMessages,
      temperature,
      stop_sequences: endTag ? [endTag] : undefined,
      system: systemPrompt,
    };

    if (tools && tools.length > 0) {
      options.tools = toAnthropicTools(tools, {
        supportsNativeWebSearch: this.capabilities.supportsNativeWebSearch,
      });
      (options as MessageCreateParams).tool_choice = { type: 'auto' };

      if (this.capabilities.supportsInterleavedThinking) {
        this.ensureBeta(options, INTERLEAVED_THINKING_BETA);
      }

      // Memory tool requires the context management beta header
      if (tools.some((t) => t.name === 'memory')) {
        this.ensureBeta(options, CONTEXT_MANAGEMENT_BETA);
      }
    }

    // Enable thinking for any models that support reasoning
    if (this.capabilities.supportsReasoning) {
      // This ensures thinking is explicitly enabled for all models that support it
      this.logger.debug('Enabling thinking for model with reasoning support');

      // Calculate thinking budget based on max_tokens constraint
      // budget_tokens must be less than max_tokens
      const maxBudget = Math.floor(this.config.maxOutputTokens * 0.5); // Use 50% of max_tokens as safe budget
      const defaultBudget = useStreaming ? 32768 : 4096; // streaming allows larger thinking budget
      const thinkingBudget = Math.min(defaultBudget, maxBudget);

      options.thinking = {
        type: 'enabled',
        budget_tokens: thinkingBudget,
      };

      this.logger.debug(
        `Set thinking budget: ${thinkingBudget} tokens (max_tokens: ${this.config.maxOutputTokens}, streaming: ${useStreaming})`,
      );

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

    // Opt-in beta for 1M context window on Claude Sonnet 4 family
    if (isAnthropic1MBetaActive) {
      this.ensureBeta(options, CONTEXT_1M_BETA);
    }

    // Phase 2: COUNT - Estimate input tokens using built params
    // Phase 3: VALIDATE - Adjust max_tokens if needed
    if (this.supportsTokenCounting) {
      if (documentAnalysis.hasFileSource) {
        this.logger.debug(
          'Skipping token counting because Anthropic countTokens does not support file-based document sources.',
        );
        if (forceCompaction) {
          this.logger.debug(
            'Deferring manual compaction request until token counting is available.',
          );
        }
      } else {
        // Token counting uses soft failure - if it fails, we proceed without adjustment
        // and let the API enforce limits. This avoids unnecessary retries for non-critical operations.
        try {
          // Reuse built params for token counting (build once principle)
          const inputTokens = await this.estimateTokenCount(effectiveMessages, {
            client,
            systemPrompt,
            anthropicTools: options.tools,
            thinking: options.thinking,
            betas: options.betas,
          });
          measuredInputTokens = inputTokens;

          let effectiveInputTokens = inputTokens;
          const compactionOutcome = await this.maybeCompactContext({
            messages: effectiveMessages,
            tokensBefore: inputTokens,
            contextWindow: effectiveContextWindow,
            forceCompaction,
            shouldAttempt: shouldAttemptCompaction,
            estimateTokens: (nextMessages) =>
              this.estimateTokenCount(nextMessages, {
                client,
                systemPrompt,
                anthropicTools: options.tools,
                thinking: options.thinking,
                betas: options.betas,
              }),
            compact: async () => {
              const summaryText = await this.compactConversation(
                client,
                effectiveMessages,
                systemPrompt,
                signal,
              );
              const compactedMessage: MessageParam = {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: summaryText,
                  },
                ],
              };
              return {
                summaryText,
                compactedMessages: [compactedMessage],
                compactionModel: getCompactionModel(this.config.fullName),
              };
            },
            onCompactionStart: () => {
              this.consumeCompactionRequest();
            },
          });

          if (compactionOutcome.didCompact) {
            effectiveMessages = compactionOutcome.messages;
            options.messages = effectiveMessages;
            documentAnalysis = this.analyzeDocumentSources(effectiveMessages);
            hasFileReference = documentAnalysis.hasFileSource;
          }

          effectiveInputTokens = compactionOutcome.tokensAfter;
          measuredInputTokens = compactionOutcome.tokensAfter;

          // Validate and adjust max_tokens if needed (throws if context window exceeded)
          const validation = this.validateTokenLimits(
            effectiveInputTokens,
            options.max_tokens,
            effectiveContextWindow,
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

            // Adjust thinking budget if reasoning is enabled and max_tokens was reduced
            if (
              this.capabilities.supportsReasoning &&
              options.thinking &&
              options.thinking.type === 'enabled'
            ) {
              const adjustedBudget = Math.max(
                1,
                Math.min(
                  options.thinking.budget_tokens,
                  Math.floor(options.max_tokens * 0.5),
                ),
              );
              if (adjustedBudget !== options.thinking.budget_tokens) {
                this.logger.debug(
                  `Adjusted thinking budget to ${adjustedBudget} due to reduced max_tokens`,
                );
                options.thinking.budget_tokens = adjustedBudget;
              }
            }
          }
        } catch (err) {
          // Re-throw context window violations - these are intentional validation errors
          // that should fail fast, not be swallowed by soft failure
          if (isContextWindowError(err)) {
            throw err;
          }
          // Soft failure for token counting API errors - proceed without adjustment
          this.logger.warn(
            `Token counting failed: ${getSdkErrorMessage(err)}. Proceeding without token adjustment.`,
          );
        }
      }
    }

    if (documentAnalysis.hasBase64Pdf) {
      const uploadResult = await this.replaceDocumentDataWithUploads(
        client,
        effectiveMessages,
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

        // Store thinking blocks for API conversation continuation
        this.processThinkingBlock(response);
      } catch (streamError) {
        // Log enhanced diagnostics for stream failures, especially useful for relay debugging
        const baseUrl = this.getBaseUrl();
        const isUsingRelay = this.shouldUseServerSideKeys();
        const diagnostics = streamHandler.getDiagnostics();

        this.logger.error(
          `Stream failed: ${streamError instanceof Error ? streamError.message : String(streamError)}`,
          {
            data: {
              isUsingRelay,
              baseUrl: baseUrl ?? 'default',
              model: this.config.fullName,
              streamDiagnostics: diagnostics,
            },
          },
        );

        // Attach diagnostics to error for retry UI display
        attachStreamDiagnostics(streamError, diagnostics);
        throw streamError;
      } finally {
        // Always finalize stream handler to prevent memory leaks on error
        streamHandler.finalize();
        cleanupAbortListener?.();
      }
    } else {
      response = await client.beta.messages.create(options, { signal });
    }

    return response;
  }

  private enforceCacheControlLimit(messages: MessageParam[]): void {
    if (!this.capabilities.supportsPromptCaching) {
      return;
    }

    const cacheControlledBlocks: CacheControlEligibleBlock[] = [];

    for (const message of messages) {
      const content = message.content;
      if (!Array.isArray(content) || content.length === 0) {
        continue;
      }

      for (const block of content) {
        // Clear cache_control from ineligible blocks (defensive cleanup)
        if (!isCacheControlEligibleBlock(block)) {
          if (block && typeof block === 'object' && 'cache_control' in block) {
            delete (block as { cache_control?: unknown }).cache_control;
          }
          continue;
        }

        if (block.cache_control) {
          cacheControlledBlocks.push(block);
        }
      }
    }

    // Remove excess cache control markers, keeping only the last MAX_CACHE_CONTROLLED_BLOCKS
    const excess = Math.max(
      0,
      cacheControlledBlocks.length - MAX_CACHE_CONTROLLED_BLOCKS,
    );
    for (let idx = 0; idx < excess; idx += 1) {
      delete cacheControlledBlocks[idx].cache_control;
    }

    this.cacheControlledBlock = cacheControlledBlocks.at(-1);
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

      for (const block of contentBlocks) {
        if (block.type !== 'document') {
          continue;
        }

        const source = block.source;
        if (!source) {
          continue;
        }

        if ('file_id' in (source as { file_id?: string })) {
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

      for (const block of contentBlocks) {
        // Skip non-document blocks or those without source
        if (block.type !== 'document' || !block.source) {
          continue;
        }

        const { source } = block;
        if ('file_id' in (source as { file_id?: string })) {
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

  private async uploadToolAttachments(
    client: Anthropic,
    attachments: ToolFileAttachment[],
  ): Promise<{
    uploaded: UploadedAnthropicAttachment[];
    unsupported: ToolFileAttachment[];
  }> {
    const uploaded: UploadedAnthropicAttachment[] = [];
    const unsupported: ToolFileAttachment[] = [];

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

    return { uploaded, unsupported };
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

    this.updateCacheControlTarget(undefined);

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
    if (mediaFiles && this.capabilities.supportsVision) {
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

    this.assignCacheControlToLatest(userMessageContent);

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
    if (
      mediaFiles &&
      mediaFiles.length > 0 &&
      this.capabilities.supportsVision
    ) {
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

    this.assignCacheControlToLatest(roundContent);

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
      content: [{ type: 'text', text: trimmedMessage, citations: null }],
    });

    const lastMessage = messages.at(-1);
    if (lastMessage && Array.isArray(lastMessage.content)) {
      this.assignCacheControlToLatest(lastMessage.content);
    }

    return messages;
  }

  createAssistantMessage(text: string): MessageParam {
    return {
      role: 'assistant',
      content: [{ type: 'text', text, citations: null }],
    };
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
          if (resolvedMediaType && resolvedMediaType !== 'image/png') {
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
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: userMessageContinuation }],
    });

    const lastMessage = messages.at(-1);
    if (lastMessage && Array.isArray(lastMessage.content)) {
      this.assignCacheControlToLatest(lastMessage.content);
    }
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
    const workflowSetting = requireWorkflowSetting(agentSetting);
    let endTurn = false;

    if (!(await flexibleFS.existsAndNonTrivial(outputLocation))) {
      if (this.capabilities.supportsAssistantPrefill) {
        this.logger.debug(`Adding prefill message:\n${prefill}`);
        if (
          workspaceState.assembly.accumulatedOutput.includes('<scratchpad>') &&
          prefill === '<scratchpad>' // this is not so neat
        ) {
          await flexibleFS.write(outputLocation, prefill);
        } else if (workflowSetting.outputExt === 'xml') {
          await flexibleFS.write(outputLocation, prefill + '\n');
        }
        messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: prefill }],
        });
      } else {
        // For thinking-enabled models that don't support assistant prefill,
        // add prefill as part of the user message like OpenAI handler

        const PseudoPrefillMsgContentString = `Start your response with:\n${prefill}`;
        const lastMsg = messages.at(-1);
        if (lastMsg && Array.isArray(lastMsg.content)) {
          lastMsg.content.push({
            type: 'text',
            text: PseudoPrefillMsgContentString,
          } as ContentBlockParam);
        }
        this.logger.debug(
          `Added pseudo prefill message to messages:\n${PseudoPrefillMsgContentString}`,
        );
      }
      return [endTurn, messages];
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

      this.updateCacheControlTarget(undefined);

      endTurn = true;
      return [endTurn, messages];
    }

    this.logger.warn(
      'Output file exists but no end tag found - continuing from file',
    );

    // For thinking-enabled models that don't support assistant prefill,
    // add continuation as part of the user message

    const content: ContentBlockParam[] = [
      {
        type: 'text' as const,
        text: fileContent,
      },
    ];
    this.logger.debug(
      `Using existing content as prefill: ${outputLocation.absolutePath}`,
    );
    messages.push({ role: 'assistant', content });

    this.assignCacheControlToLatest(content);

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

    endTurn = false;
    return [endTurn, messages];
  }

  /** Calculates API usage cost based on input/output tokens and cache usage if supported. */
  computePrice(responseUsage: AnthropicUsage): number {
    if (!responseUsage) {
      return 0;
    }

    // Note: Anthropic doesn't provide tool_use_tokens in their API response

    let basePrice = calculateTokenPrice(
      responseUsage.input_tokens,
      responseUsage.output_tokens,
      this.config.inputPrice,
      this.config.outputPrice,
    );

    if (this.capabilities.supportsPromptCaching) {
      if (
        'cache_creation_input_tokens' in responseUsage &&
        responseUsage.cache_creation_input_tokens !== null
      ) {
        basePrice +=
          (responseUsage.cache_creation_input_tokens *
            this.config.inputPrice *
            1.25) /
          1e6;
      }
      if (
        'cache_read_input_tokens' in responseUsage &&
        responseUsage.cache_read_input_tokens !== null
      ) {
        basePrice +=
          (responseUsage.cache_read_input_tokens *
            this.config.inputPrice *
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

    // Anthropic: total = input_tokens + cache_read + cache_creation
    const baseInput = rawUsage.input_tokens ?? 0;
    const cacheRead = rawUsage.cache_read_input_tokens ?? 0;
    const cacheCreation = rawUsage.cache_creation_input_tokens ?? 0;
    const totalInput = baseInput + cacheRead + cacheCreation;

    return {
      inputTokens: totalInput,
      outputTokens: rawUsage.output_tokens ?? 0,
      cost: this.computePrice(rawUsage),
      responseTimeMs,
      provider: 'anthropic',
      cachedInputTokens: nonZeroOrUndefined(cacheRead),
      cacheCreationTokens: nonZeroOrUndefined(cacheCreation),
      percentageCached: computeCachePercentage(
        cacheRead + cacheCreation,
        totalInput,
      ),
      serverToolRequests: nonZeroOrUndefined(
        rawUsage.server_tool_use?.web_search_requests,
      ),
      _native: rawUsage,
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
        const newMessage: ContentBlockParam = {
          type: 'text',
          text: bestConnector + newResponse,
        };
        lastMessage.content.push(newMessage);
      } else {
        lastMessage.content = [
          {
            type: 'text',
            text: workspaceState.assembly.accumulatedOutput,
          } as ContentBlockParam,
        ];
      }

      if (Array.isArray(lastMessage.content)) {
        this.assignCacheControlToLatest(lastMessage.content);
      }
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
        this.assignCacheControlToLatest(secondLastMessage.content);
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

    this.assignCacheControlToLatest(content);
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

    if (responseObject.content && Array.isArray(responseObject.content)) {
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
      .map((toolUseBlock) => {
        if (!toolUseBlock.id || !toolUseBlock.name) {
          return null;
        }
        return {
          provider: 'anthropic',
          callId: toolUseBlock.id,
          name: toolUseBlock.name,
          input: toolUseBlock.input,
          raw: toolUseBlock,
        } satisfies AnthropicToolCall;
      })
      .filter((call): call is AnthropicToolCall => call !== null);
  }

  /**
   * Extract all server tool data in a single pass.
   * Returns both normalized results for display and raw content blocks for context.
   * Single source of truth for Anthropic server tool extraction.
   */
  override extractServerToolData(
    responseObject: BetaMessage,
  ): ServerToolExtractionResult {
    if (!Array.isArray(responseObject?.content)) {
      return { webSearchResults: [], contentBlocks: [] };
    }

    // Extract content blocks that need to be preserved
    // Filter for server tool content (server_tool_use, web_search_tool_result)
    // Cast needed because BetaContentBlock has slightly different types than the regular API
    const contentBlocks = responseObject.content.filter(
      isAnthropicServerToolContent,
    ) as (ServerToolUseBlock | WebSearchToolResultBlock)[];

    // Extract normalized web search results for display
    const webSearchResults = extractAnthropicWebSearchResults(
      responseObject.content,
    );

    return { webSearchResults, contentBlocks };
  }

  /**
   * Extract assistant content blocks from an Anthropic response, excluding tool_use blocks.
   * Preserves thinking, text, server_tool_use, and web_search_tool_result blocks.
   */
  override extractAssistantContent(responseObject: BetaMessage): unknown[] {
    if (!Array.isArray(responseObject?.content)) {
      return [];
    }

    return responseObject.content.filter((block) => block.type !== 'tool_use');
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

    if (canUploadFiles && attachments.length > 0 && client) {
      const uploadResult = await this.uploadToolAttachments(
        client,
        attachments,
      );
      uploadedAttachments = uploadResult.uploaded;
      unsupportedAttachments.push(...uploadResult.unsupported);

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

    const isError = Boolean(result.isError);
    const resultMsg: MessageParam = {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: call.callId,
          content: toolResultContent,
          is_error: isError || undefined,
        },
      ],
    };

    const toolResultBlock = Array.isArray(resultMsg.content)
      ? resultMsg.content.at(-1)
      : undefined;
    if (isCacheControlEligibleBlock(toolResultBlock)) {
      this.updateCacheControlTarget(toolResultBlock);
    }

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
