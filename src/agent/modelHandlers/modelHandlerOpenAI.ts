// Third-party imports
import OpenAI from 'openai';

// Local imports - core utilities
import {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionContentPartInputAudio,
  ChatCompletionAssistantMessageParam,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionToolMessageParam,
  ChatCompletionStreamParams,
} from 'openai/resources/chat/completions';
import { isAssistantMessage } from 'openai/lib/chatCompletionUtils';
import { assertToolCallsAreChatCompletionFunctionToolCalls } from 'openai/lib/parser';

// Local imports - agent components
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentSetting, hasEndTag } from '@agent/core/AgentDataclass';
import {
  OpenAIAPIResponseUsage,
  ExtendedCompletionUsage,
} from '@agent/core/ResponseUsage';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { MediaEntry } from '@agent/utils/mediaTypes';
import { calculateTokenPrice } from '@agent/utils/priceUtils';
import { K_SLICE, MESSAGE_PREVIEW_LENGTH } from '@agent/core/constants';
import { getConfig } from '@agent/core/config';
import {
  getSdkErrorMessage,
  isContextWindowError,
  isMissingFinishReasonError,
  attachPartialText,
  takeTail,
  isUserAbort,
  PARTIAL_TEXT_TAIL_MAX,
} from '@common/errors/sdkErrorUtils';

// Local imports - tools and utils
import type { ToolDefinition } from '@model';
import type { ToolFileAttachment } from '@tools/result';
import { isNonEmptyString } from '@utils/core';
import type { FileLocation } from '@utils/files';
import { flexibleFS } from '@utils/files';
import { objectToLogString } from '@utils/text/stringUtils';
import { computeCachePercentage } from './utils/usageNormalization';
import { prepareExistingOutputContent } from './utils/fileContentUtils';
import { tagOpenAISdkError, withSdkErrorTag } from './support/sdkErrorAdapters';

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
import { parseToolArguments } from './utils/parseArguments';
import { ModelHandler } from './ModelHandler';
import {
  BaseReasoningStreamAggregator,
  type StreamingAggregator,
} from './BaseReasoningStreamAggregator';
import {
  CLIENT_COMPACTION_SUMMARY_MAX_TOKENS,
  COMPACTION_SYSTEM_PROMPT,
  DEFAULT_COMPACTION_THRESHOLD_PERCENT,
  TOOL_USE_SAFETY_BUFFER,
} from './contextManagementConstants';
import type {
  CreateResponseOptions,
  CreateResponseResult,
  ExtractResponseResult,
  DeepSeekToolCall,
  OpenAIToolCall,
} from './types/IModelHandler';
import type { ProviderStopReason } from './types/StopReasonTypes';
import type { ContentDeltaEvent } from 'openai/lib/ChatCompletionStream';

type ChatCompletionRequestBase = Omit<
  ChatCompletionCreateParamsStreaming,
  'stream' | 'stream_options'
>;
type ChatCompletionRequestWithThinking = ChatCompletionRequestBase & {
  thinking?: { type: 'enabled' | 'disabled' };
};
type ChatCompletionSummaryParams = ChatCompletionCreateParamsNonStreaming & {
  thinking?: { type: 'disabled' };
};

// Reasoning content type for DeepSeek, o1 models (not in SDK)
type ReasoningContent = string | Array<{ type: string; text?: string }>;

function extractReasoningText(content: ReasoningContent | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content.map((item) => item.text ?? '').join('');
}

const DEEPSEEK_OFFICIAL_API_MAX_TOKENS = 8192;

// COMPACTION_SYSTEM_PROMPT imported from contextManagementConstants

/** Extracts `reasoning_content` from a streaming chunk delta. */
function extractReasoningDelta(chunk: ChatCompletionChunk): string {
  const delta = chunk.choices[0]?.delta as
    | { reasoning_content?: ReasoningContent }
    | undefined;
  if (!delta || !('reasoning_content' in delta)) return '';
  return extractReasoningText(delta.reasoning_content);
}

/**
 * Extracts a capped tail of the assistant content accumulated by the SDK's
 * ChatCompletionStream in its currentChatCompletionSnapshot. Returns the
 * suffix because continuation prompts reference the tail of the response.
 */
function extractOpenAIPartialTail(
  snapshot:
    | { choices?: Array<{ message?: { content?: string | null } }> }
    | undefined,
  maxChars: number,
): string {
  const content = snapshot?.choices?.[0]?.message?.content ?? '';
  return takeTail(content, maxChars);
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
  // ── Client-side compaction state ──────────────────────────────────────
  /** Tracks prompt_tokens from the last API response for compaction threshold checks. */
  private lastKnownInputTokens = 0;

  /** Flag to force compaction on the next API call, set by requestCompaction(). */
  private compactionRequested = false;

  protected useReasoningStreamAggregator: boolean = false;

  // ── Compaction interface overrides ────────────────────────────────────

  /** Client-side compaction is available for tool-use sessions. */
  override get supportsManualCompaction(): boolean {
    return this.isToolUseMode();
  }

  override requestCompaction(): void {
    this.compactionRequested = true;
  }

  // ── Compaction internals ──────────────────────────────────────────────

  /**
   * Get the configured compaction threshold percentage.
   * Returns 0 if compaction is disabled.
   */
  private getCompactionThresholdPercent(): number {
    return getConfig<number>(
      'texra.model.compactionThresholdPercent',
      DEFAULT_COMPACTION_THRESHOLD_PERCENT,
    );
  }

  /**
   * Check if the conversation should be compacted based on token usage.
   * Compaction is only triggered when:
   * - In tool-use mode (only mode with multi-turn message accumulation)
   * - Manual request via requestCompaction(), OR
   * - Last known input tokens exceed the configured threshold
   */
  private shouldCompact(): boolean {
    if (!this.isToolUseMode()) return false;

    if (this.compactionRequested) {
      return true;
    }

    const thresholdPercent = this.getCompactionThresholdPercent();
    if (thresholdPercent <= 0) return false;

    const threshold = Math.floor(
      (thresholdPercent / 100) * this.config.contextWindow,
    );
    return this.lastKnownInputTokens > threshold;
  }

  /**
   * Compact the conversation using client-side summarization via system-prompt-swap.
   * Sends conversation messages as-is to the model with a summarization system prompt,
   * then replaces all messages with the summary.
   *
   * @returns The compacted messages array, or original messages if compaction fails
   */
  private async compactConversation(
    client: OpenAI,
    messages: ChatCompletionMessageParam[],
    signal?: AbortSignal,
  ): Promise<{
    compactedMessages: ChatCompletionMessageParam[];
    didCompact: boolean;
  }> {
    const tokensBefore = this.lastKnownInputTokens;
    const contextWindow = this.config.contextWindow;
    const utilizationBefore = (tokensBefore / contextWindow) * 100;

    this.logger.debug(
      `Compacting conversation with ${tokensBefore} input tokens (${utilizationBefore.toFixed(1)}% of ${contextWindow} context window)`,
    );

    // Separate system/developer messages from conversation messages
    const systemMessages: ChatCompletionMessageParam[] = [];
    const conversationMessages: ChatCompletionMessageParam[] = [];
    for (const msg of messages) {
      if (msg.role === 'system' || (msg.role as string) === 'developer') {
        if (conversationMessages.length === 0) {
          systemMessages.push(msg);
        } else {
          conversationMessages.push(msg);
        }
      } else {
        conversationMessages.push(msg);
      }
    }

    // Nothing to summarize if conversation is too short
    if (conversationMessages.length <= 2) {
      this.logger.debug('Conversation too short for compaction, skipping');
      return { compactedMessages: messages, didCompact: false };
    }

    // System-prompt-swap: replace the agent's system prompt with summarization
    // instructions and send conversation messages as-is. The model reads the
    // actual structured messages (roles, tool calls, tool results) natively.
    // Apply provider-specific normalization (e.g., DeepSeek's convertContentToString,
    // mergeConsecutiveRoles) so the compaction call doesn't get rejected.
    const normOptions = this.getMessageNormalizationOptions();
    const normalizedConversation = normOptions
      ? this.prepareNormalizedMessages(conversationMessages, normOptions)
      : conversationMessages;

    try {
      const summaryParams: ChatCompletionSummaryParams = {
        model: this.config.fullName,
        messages: [
          { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
          ...normalizedConversation,
        ],
        max_tokens: CLIENT_COMPACTION_SUMMARY_MAX_TOKENS,
        temperature: 0,
        stream: false,
      };
      // Disable thinking for the summary call — reasoning models
      // (DeepSeek, Kimi K2.5, GLM) don't need to think for summarization.
      if (this.getThinkingParameter() || this.capabilities.supportsReasoning) {
        summaryParams.thinking = { type: 'disabled' };
      }
      const summaryResponse = await client.chat.completions.create(
        summaryParams,
        { signal },
      );

      const summaryText = summaryResponse.choices[0]?.message?.content?.trim();
      if (!summaryText) {
        this.logger.warn('Compaction returned empty summary, skipping');
        return { compactedMessages: messages, didCompact: false };
      }

      // Replace ALL messages with system prompt + summary
      const compactedMessages: ChatCompletionMessageParam[] = [
        ...systemMessages,
        {
          role: 'user',
          content: `[Previous conversation summary]\n\n${summaryText}`,
        },
      ];

      const summaryOutputTokens = summaryResponse.usage?.completion_tokens ?? 0;
      const estimatedTokensAfter = Math.max(1, summaryOutputTokens);
      const utilizationAfter = (estimatedTokensAfter / contextWindow) * 100;
      const reduction = tokensBefore - estimatedTokensAfter;
      const reductionPercent =
        tokensBefore > 0 ? ((reduction / tokensBefore) * 100).toFixed(1) : '0';

      this.logger.logContextManagement(
        `Compacted conversation: ${tokensBefore.toLocaleString()} → ~${estimatedTokensAfter.toLocaleString()} tokens (${reductionPercent}% reduction)`,
        {
          action: 'compaction',
          tokensBefore,
          tokensAfter: estimatedTokensAfter,
          contextWindow,
          utilizationBefore: Number(utilizationBefore.toFixed(1)),
          utilizationAfter: Number(utilizationAfter.toFixed(1)),
          details: `Client-side compaction: ${conversationMessages.length} messages summarized`,
        },
      );

      return { compactedMessages, didCompact: true };
    } catch (err) {
      this.logger.warn(
        `Compaction failed, continuing with original messages: ${getSdkErrorMessage(err)}`,
      );
      return { compactedMessages: messages, didCompact: false };
    }
  }

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
    if (
      this.useReasoningStreamAggregator &&
      this.capabilities.supportsReasoning
    ) {
      return new BaseReasoningStreamAggregator();
    }
    return null;
  }

  /**
   * Extracts reasoning text from a streaming chunk delta.
   * Override in subclasses to handle provider-specific reasoning fields.
   */
  protected extractReasoningDelta(chunk: ChatCompletionChunk): string {
    return extractReasoningDelta(chunk);
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
  ): ChatCompletionRequestWithThinking {
    const effectiveMaxTokens = this.getEffectiveMaxOutputTokens();

    const baseParams: ChatCompletionRequestWithThinking = {
      model: this.config.fullName,
      messages,
      ...(this.isOReasoningModel
        ? { max_completion_tokens: effectiveMaxTokens }
        : { max_tokens: effectiveMaxTokens }),
    };

    if (!this.isOReasoningModel && !this.isGrokReasoningModel) {
      if (endTag) {
        baseParams.stop = [endTag];
      }
      baseParams.temperature = temperature;
    }

    const reasoningEffort = this.getEffectiveReasoningEffort();
    if (this.capabilities.supportsReasoning && reasoningEffort) {
      // OpenAI doesn't support 'none'; clamp to 'low' (the minimum).
      const effective = reasoningEffort === 'none' ? 'low' : reasoningEffort;
      baseParams.reasoning_effort = this.validateReasoningEffort(
        effective,
      ) as ChatCompletionRequestBase['reasoning_effort'];
    }

    // Add thinking parameter if specified by subclass (Kimi K2.5, DeepSeek)
    const thinking = this.getThinkingParameter();
    if (thinking) {
      baseParams.thinking = thinking;
    }

    if (tools?.length) {
      const parallelToolCalls = getConfig<boolean>(
        'texra.model.openaiParallelToolCalls',
        false,
      );
      if (!parallelToolCalls) {
        baseParams.parallel_tool_calls = false;
      }
      // These tools are parsed by TeXRA after the response. The SDK's
      // auto-parse validator requires strict schemas, but several TeXRA tools
      // intentionally expose nullable or optional fields.
      const convertedTools = toOpenAITools(tools);
      baseParams.tools = convertedTools;
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
      if (delta) {
        output?.append(delta);
        streamingAggregator?.appendContent(delta);
      }
    };

    const onChunk = (chunk: ChatCompletionChunk): void => {
      streamingAggregator?.consumeChunk(chunk);
      const reasoningDelta = this.extractReasoningDelta(chunk);
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

      this.finalizeStreams(thinking, output, finalResponse);
      return finalResponse;
    } catch (streamError) {
      // On mid-stream failure, lift the partial content the SDK already
      // accumulated (currentChatCompletionSnapshot) onto the error so the
      // retry UI can show it and future continuation logic can reference
      // the tail. Aborts are control flow; log at debug, skip warn.
      const partialText = extractOpenAIPartialTail(
        stream.currentChatCompletionSnapshot,
        PARTIAL_TEXT_TAIL_MAX,
      );
      if (partialText) {
        attachPartialText(streamError, partialText);
      }
      if (!isUserAbort(streamError)) {
        this.logger.warn(
          `Stream failed: ${streamError instanceof Error ? streamError.message : String(streamError)}`,
          {
            data: {
              model: this.config.fullName,
              partialTextLength: partialText.length,
            },
          },
        );
      }
      throw streamError;
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
  ): Promise<CreateResponseResult<ChatCompletion, ChatCompletionMessageParam>> {
    return withSdkErrorTag(tagOpenAISdkError, this.config.provider, () =>
      this.createResponseImpl(options),
    );
  }

  /** Creates a chat completion after SDK-boundary error tagging is installed. */
  private async createResponseImpl(
    options: CreateResponseOptions<ChatCompletionMessageParam, OpenAI>,
  ): Promise<CreateResponseResult<ChatCompletion, ChatCompletionMessageParam>> {
    const {
      client,
      messages: rawMessages,
      temperature,
      systemPrompt,
      endTag,
      signal,
      tools,
    } = options;

    // Phase 0: COMPACT - Check if conversation should be compacted
    let updatedMessages: ChatCompletionMessageParam[] | undefined;
    let messagesToUse = rawMessages;

    if (this.shouldCompact()) {
      const isManual = this.compactionRequested;
      // Clear manual flag immediately when attempted — matches Anthropic and
      // OpenAI Responses handlers. Prevents infinite retry on graceful failure.
      this.compactionRequested = false;

      const threshold = this.getCompactionThresholdPercent();
      if (isManual) {
        this.logger.debug(
          `Compacting conversation (manually requested, ${this.lastKnownInputTokens} input tokens)`,
        );
      } else {
        this.logger.debug(
          `Compacting conversation (${this.lastKnownInputTokens} tokens exceed ${threshold}% threshold of ${Math.floor((threshold / 100) * this.config.contextWindow)} tokens)`,
        );
      }

      const { compactedMessages, didCompact } = await this.compactConversation(
        client,
        rawMessages,
        signal,
      );
      if (didCompact) {
        messagesToUse = compactedMessages;
        updatedMessages = compactedMessages;
      }
    }

    // Apply message normalization if subclass specifies options
    const normOptions = this.getMessageNormalizationOptions();
    const messages = normOptions
      ? this.prepareNormalizedMessages(messagesToUse, normOptions)
      : messagesToUse;

    // Phase 1: BUILD - Construct provider-specific request parameters
    const useStreaming = this.getStreamingConfig();
    const baseParams = this.buildChatBaseParams(
      messages,
      temperature,
      systemPrompt,
      endTag,
      tools,
    );

    // Phase 2: COUNT - Estimate input tokens if handler supports it
    // Phase 3: VALIDATE - Adjust max_tokens if needed
    if (this.supportsTokenCounting) {
      try {
        const inputTokens = await this.estimateTokenCount(messages, {
          client,
          systemPrompt,
          signal,
        });

        // Validate and adjust max_tokens if needed (throws if context window exceeded)
        // Use larger safety buffer for tool-use mode
        const maxTokensKey = this.isOReasoningModel
          ? 'max_completion_tokens'
          : 'max_tokens';
        const currentMaxTokens = this.isOReasoningModel
          ? (baseParams.max_completion_tokens ??
            this.getEffectiveMaxOutputTokens())
          : (baseParams.max_tokens ?? this.getEffectiveMaxOutputTokens());
        const tokenBuffer = this.isToolUseMode()
          ? TOOL_USE_SAFETY_BUFFER
          : undefined;
        const validation = this.validateTokenLimits(
          inputTokens,
          currentMaxTokens,
          this.config.contextWindow,
          tokenBuffer,
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
          if (this.isOReasoningModel) {
            baseParams.max_completion_tokens = validation.adjustedMaxTokens;
          } else {
            baseParams.max_tokens = validation.adjustedMaxTokens;
          }
        }
      } catch (err) {
        tagOpenAISdkError(err, this.config.provider);
        if (isContextWindowError(err)) throw err;
        this.logger.debug(
          `Token counting failed: ${getSdkErrorMessage(err)}. Proceeding without token adjustment.`,
        );
      }
    }

    // Phase 4: EXECUTE
    const response = useStreaming
      ? await this.executeStreamingChat(client, baseParams, signal)
      : await this.executeNonStreamingChat(client, baseParams, signal);

    // Phase 5: TRACK - Record prompt_tokens for compaction threshold checks
    if (response.usage?.prompt_tokens) {
      this.lastKnownInputTokens = response.usage.prompt_tokens;
    }

    return { response, updatedMessages };
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
    const normalizedMessages = options
      ? normalizeOpenAIMessageContent(messages, options)
      : messages;

    if (normalizedMessages.length !== messages.length) {
      this.logger.debug(
        `Preprocessed message array from ${messages.length} to ${normalizedMessages.length} messages for ${providerLabel} model compatibility`,
      );
    }

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
    // O1 mini and O1 preview models do not support system prompt; use 'user' role instead.
    // For openai native o1 full or above reasoning models, "developer" is the new name but "system" still works.
    if (systemPrompt) {
      const role = this.capabilities.supportsSystemPrompt ? 'system' : 'user';
      messages.push({
        role,
        content: [{ type: 'text', text: systemPrompt }],
      });
    }

    // Create content list for the user message (only add non-empty prefix)
    const userMessageContent: ChatCompletionContentPart[] = [];
    if (userPrefix) {
      userMessageContent.push({ type: 'text', text: userPrefix });
    }

    // Add media if provided
    if (
      mediaFiles?.length &&
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

    if (
      mediaFiles?.length &&
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
      messages.push({ role: 'user', content: roundContent });
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
    return { role: 'assistant', content: this.formatAssistantContent(text) };
  }

  override createAssistantMessageFromResponse(
    responseObject: ChatCompletion,
    text: string,
  ): ChatCompletionMessageParam {
    const message = this.createAssistantMessage(
      text,
    ) as ChatCompletionAssistantMessageParam & { reasoning_content?: string };

    // Always include reasoning_content (even empty string) when the provider
    // requires it, so all assistant messages stay consistent in thinking mode.
    if (this.shouldIncludeReasoningInAssistantMessages()) {
      message.reasoning_content =
        this.extractReasoningFromResponse(responseObject) ?? '';
    }

    return message;
  }

  override extractAssistantText(
    message: ChatCompletionMessageParam,
  ): string | undefined {
    if (message.role !== 'assistant') return undefined;
    const { content } = message;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return undefined;
    const texts = content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .filter(Boolean);
    return texts.length > 0 ? texts.join('\n') : undefined;
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
        return [
          { type: 'text', text: `Audio: ${media.file_name}` },
          audioContent,
        ];
      } else if (media.media_category === 'audio') {
        this.logger.warn(
          `Audio input received (${media.file_name}) but native audio is not supported by this specific model/provider (${this.config.provider}). Skipping.`,
        );
        return [];
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
        // Use finish_reason from choices if available, otherwise assume stop
        const stopReason =
          responseObject.choices?.[0]?.finish_reason ?? OPENAI_CHAT_FINISH.STOP;

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
    _agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: any[],
    workspaceState: AgentWorkspaceState,
    outputLocation: FileLocation,
    prefill: string,
  ): Promise<[boolean, any[]]> {
    let endTurn = false;

    if (!(await flexibleFS.existsAndNonTrivial(outputLocation))) {
      if (prefill.length === 0) {
        this.logger.debug(
          'No prefill provided; skipping pseudo-prefill instruction',
        );
        return [endTurn, messages];
      }
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

    return [false, messages];
  }

  /** Computes cost based on token usage and model pricing. */
  computePrice(responseUsage: ExtendedCompletionUsage | null): number {
    if (!responseUsage) return 0;

    const cachedTokens =
      responseUsage.prompt_tokens_details?.cached_tokens ??
      responseUsage.prompt_cache_hit_tokens ??
      0;
    const promptTokens =
      responseUsage.prompt_tokens ??
      cachedTokens + (responseUsage.prompt_cache_miss_tokens ?? 0);
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
   * needs a different identifier (e.g., OpenRouter overrides to 'openrouter').
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

    // OpenAI: prompt_tokens_details.cached_tokens; DeepSeek: prompt_cache_hit_tokens
    const cachedTokens =
      rawUsage.prompt_tokens_details?.cached_tokens ??
      rawUsage.prompt_cache_hit_tokens ??
      0;
    const cacheMissTokens = rawUsage.prompt_cache_miss_tokens ?? 0;

    // OpenAI's prompt_tokens is the TOTAL (includes cached tokens). DeepSeek also
    // exposes cache hit/miss fields; use their sum as a fallback if prompt_tokens
    // is absent from an OpenAI-compatible response.
    const inputTokens =
      rawUsage.prompt_tokens ??
      (cachedTokens > 0 || cacheMissTokens > 0
        ? cachedTokens + cacheMissTokens
        : 0);

    return {
      inputTokens,
      outputTokens: rawUsage.completion_tokens ?? 0,
      cost: this.computePrice(rawUsage),
      responseTimeMs,
      provider: this.usageProvider,
      cachedInputTokens: cachedTokens || undefined,
      cacheMissInputTokens: cacheMissTokens || undefined,
      percentageCached: computeCachePercentage(cachedTokens, inputTokens),
      reasoningTokens:
        rawUsage.completion_tokens_details?.reasoning_tokens || undefined,
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
    return isNonEmptyString(reasoning) ? reasoning : null;
  }

  protected extractReasoningFromResponse(responseObject: any): string | null {
    return this.extractReasoningFromMessage(
      responseObject?.choices?.[0]?.message,
    );
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
    const reasoning = this.extractReasoningFromResponse(responseObject);
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
    if (typeof value === 'string') return value;
    if (value === undefined) return '{}';
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
    return parseToolArguments(raw, this.logger);
  }

  extractToolUse(responseObject: ChatCompletion): TCall[] {
    const toolCalls = responseObject?.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      return [];
    }

    try {
      assertToolCallsAreChatCompletionFunctionToolCalls(toolCalls);
    } catch {
      this.logger.warn(
        'Skipping malformed OpenAI tool_calls payload while extracting tool use.',
      );
      return [];
    }

    return toolCalls.map((call) => ({
      provider: this.toolCallProvider,
      callId: call.id,
      name: call.function.name,
      input: this.parseArguments(call.function.arguments),
      raw: call,
    })) as TCall[];
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
   * Whether final assistant messages should also replay reasoning_content.
   * DeepSeek requires this for subsequent user turns after a thinking+tool cycle.
   */
  protected shouldIncludeReasoningInAssistantMessages(): boolean {
    return false;
  }

  /**
   * Some providers require assistant tool-call messages to include a content
   * field even when the model emitted an empty string.
   */
  protected shouldIncludeEmptyAssistantToolContent(): boolean {
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

    // Include reasoning_content if this provider requires it for tool-use cycles.
    // Always include (even as empty string) to ensure consistency: once
    // reasoning_content appears in the conversation history, DeepSeek's API
    // requires it on every subsequent assistant message in thinking mode.
    if (this.shouldIncludeReasoningInToolCalls() && workspaceState) {
      callMsg.reasoning_content =
        workspaceState.reasoning.thinkingBlocks[0]?.thinking ?? '';
      // Clear after use to prevent stale reasoning in subsequent calls
      workspaceState.resetReasoning();
    }

    if (text !== undefined || this.shouldIncludeEmptyAssistantToolContent()) {
      callMsg.content = this.formatAssistantContent(text ?? '');
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

  /**
   * Creates batched tool-use follow-up messages for multiple parallel tool calls.
   *
   * For providers with thinking mode (DeepSeek, Kimi), all tool calls from a
   * single model response must be in ONE assistant message with reasoning_content,
   * followed by individual tool result messages. Without batching,
   * resetReasoning() after the first call clears reasoning_content for
   * subsequent calls, causing the API to reject the request.
   */
  async createBatchedToolUseFollowUpMessages(
    calls: TCall[],
    results: ToolResultPayload[],
    _attachmentsPerCall: ToolFileAttachment[][],
    workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<ChatCompletionMessageParam[]> {
    if (calls.length !== results.length) {
      throw new Error(
        `Batched tool calls mismatch: ${calls.length} calls vs ${results.length} results`,
      );
    }

    if (calls.length === 0) {
      return [];
    }

    const toolCalls = calls.map((call) => this.normalizeToolCall(call.raw));
    const callMsg = this.buildAssistantMessageWithToolCalls(
      toolCalls,
      workspaceState,
      text,
    );

    const toolResultMessages = toolCalls.map((call, i) => ({
      role: 'tool' as const,
      tool_call_id: call.id,
      content: formatToolResultAsText(results[i]),
    }));

    return [callMsg, ...toolResultMessages];
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
