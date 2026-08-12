// Third-party imports
import OpenAI from 'openai';
import { ModelProvider } from 'llm-zoo';
import { isAssistantMessage } from 'openai/lib/chatCompletionUtils';
import {
  ChatCompletionStream,
  type ContentDeltaEvent,
} from 'openai/lib/ChatCompletionStream';

// Local imports
import { parseToolInput } from '@agent/core/flows/toolUseRound/toolCallParsing';
import type { ExtendedCompletionUsage } from '@agent/core/usage/ResponseUsage';
import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import type { MediaEntry } from '@agent/utils/mediaTypes';
import { K_SLICE } from '@agent/core/constants';
import { OPENAI_CHAT_FINISH } from '@agent/types/StopReasonTypes';
import type {
  CreateResponseOptions,
  CreateResponseResult,
  ExtractResponseResult,
  DeepSeekToolCall,
  OpenAIToolCall,
} from '@agent/types/ModelHandlerContracts';
import { detectRequestId } from '@common/errors/sdkError/errorInspection';
import {
  isMissingFinishReasonError,
  isUserAbort,
  PARTIAL_TEXT_TAIL_MAX,
} from '@common/errors/sdkError/errorPatterns';
import { buildErrorLogData } from '@common/errors/sdkError/providerErrorFormat';
import { handleStreamingFailure } from '@common/errors/sdkError/streamFailure';
import type { ToolDefinition } from '@model/ToolDefinition';
import type { FileLocation, MediaAttachmentKind } from '@shared/schemas';
import type {
  ToolFileAttachment,
  ToolResult,
} from '@shared/schemas/toolResult';
import { DEFAULT_CORE_SETTINGS } from '@shared/schemas/coreSettings';
import { isNonEmptyString } from '@utils/core';
import { extractMimeSubtype } from '@utils/text/stringUtils';
import { getConfig } from '@utils/config/configUtils';
import { assertToolCallsAreChatCompletionFunctionToolCalls } from './functionToolCalls';

// Local file imports
import { AUXILIARY_MAX_RETRIES } from '../support/auxiliaryRetry';
import { toDataUrl } from '../support/dataUrl';
import {
  classifyMediaEntry,
  unknownMediaCategoryWarning,
} from '../support/mediaClassification';
import {
  getDeclaredMaxReasoningEffort,
  toOpenAIReasoningEffort,
} from '../support/reasoningEffort';
import { tagOpenAISdkError } from './openAISdkError';
import { computeOpenAIPrice, normalizeOpenAIUsage } from './openAIUsage';
import {
  appendUserTextToChatMessages,
  createChatRoundMessages,
  createChatUserFollowUpMessages,
  extractChatAssistantText,
  initializeChatMessages,
  insertMediaIntoChatUserMessage,
  normalizeOpenAIMessageContent,
  prependTextToChatUserMessage,
} from './openAIMessageUtils';
import {
  extractOpenAIPartialTail,
  extractReasoningDelta as extractReasoningDeltaFromChunk,
} from './openAIChatHelpers';
import { toOpenAITools } from '../toolConversion';
import { formatToolResultTextWithAttachments } from '../utils/toolAttachmentUtils';
import { ModelHandler } from '../ModelHandler';
import { OpenAICompatibleModelHandler } from './OpenAICompatibleModelHandler';
import { ReasoningStreamAggregator } from './ReasoningStreamAggregator';
import { CLIENT_COMPACTION_SUMMARY_MAX_TOKENS } from '../contextManagementConstants';
import type { NormalizeOpenAIMessageContentOptions } from './openAIMessageUtils';

// Third-party imports
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionAssistantMessageParam,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
type ChatCompletionRequestBase = Omit<
  ChatCompletionCreateParamsStreaming,
  'stream' | 'stream_options'
>;
type ChatCompletionRequestWithThinking = ChatCompletionRequestBase & {
  thinking?: { type: 'enabled' | 'disabled' };
};
type ChatCompletionSummaryParams = ChatCompletionCreateParamsNonStreaming & {
  thinking?: { type: 'enabled' | 'disabled' };
};
type ErrorWithRequestId = Error & { request_id?: string };

/**
 * DeepSeek's official (non-OpenRouter) chat API caps `max_tokens` well below
 * what its newer, larger-output model families allow. Used only as the
 * threshold below which a registry entry is still bound by that legacy
 * ceiling (see the `buildChatBaseParams` override below) — the value that
 * gets sent is always the model's own `config.maxOutputTokens`, never this
 * constant, so the registry entry stays the single source of truth for how
 * many tokens a given model actually supports.
 */
const DEEPSEEK_OFFICIAL_API_MAX_TOKENS = 8192;

/**
 * The raw shapes `extractResponse` can receive across every OpenAI-compatible
 * provider this handler serves (DeepSeek, Kimi, GLM, MiniMax, xAI, DashScope,
 * …). Most return a strict `ChatCompletion`, but the reasoning stream
 * aggregator finalizes to a streaming-style `{ role, content }` object with
 * no `choices`, and some relays return a bare `{ error }` payload.
 */
type OpenAIClassifiedResponse =
  | { kind: 'chat'; choice: ChatCompletion.Choice }
  | {
      kind: 'streamingFallback';
      content: string;
      stopReason: string;
      usage: ChatCompletion['usage'];
    }
  | { kind: 'errorPayload'; error: unknown }
  | { kind: 'malformed' };

/**
 * Classifies a raw OpenAI-family response `any` exactly once, so the rest of
 * `extractResponse` reads typed fields off a tagged union instead of
 * re-checking `any` properties per branch.
 */
function classifyOpenAIResponse(responseObject: any): OpenAIClassifiedResponse {
  if (responseObject?.choices?.length) {
    return { kind: 'chat', choice: responseObject.choices[0] };
  }
  if (responseObject?.role && responseObject?.content) {
    return {
      kind: 'streamingFallback',
      content: responseObject.content,
      // Use finish_reason from choices if available, otherwise assume stop.
      // `choices` is already known empty/absent here, so this is always STOP
      // in practice; kept for parity with a `finish_reason` a caller might
      // still attach alongside a choices-less fallback payload.
      stopReason:
        responseObject.choices?.[0]?.finish_reason ?? OPENAI_CHAT_FINISH.STOP,
      usage: responseObject.usage ?? {
        prompt_tokens: 0,
        completion_tokens: 0,
      },
    };
  }
  if (responseObject?.error) {
    return { kind: 'errorPayload', error: responseObject.error };
  }
  return { kind: 'malformed' };
}

/**
 * OpenAI-specific handlers.
 */
export class ModelHandlerOpenAI<
  TCall extends OpenAIToolCall | DeepSeekToolCall = OpenAIToolCall,
> extends OpenAICompatibleModelHandler<
  ChatCompletionMessageParam,
  ExtendedCompletionUsage | null,
  TCall,
  ChatCompletion,
  ChatCompletionContentPart
> {
  // ── Client-side compaction state ──────────────────────────────────────
  /** Tracks prompt_tokens from the last API response for compaction threshold checks. */
  private lastKnownInputTokens = 0;

  protected useReasoningStreamAggregator: boolean = false;

  // ── Compaction interface overrides ────────────────────────────────────

  /** Client-side compaction is available for tool-use sessions. */
  override get supportsManualCompaction(): boolean {
    return this.isToolUseMode();
  }

  // ── Compaction internals ──────────────────────────────────────────────

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
    return this.runClientCompaction(
      messages,
      this.lastKnownInputTokens,
      async (conversationMessages, compactionSystemPrompt) => {
        // System-prompt-swap: send conversation messages as-is with a
        // summarization system prompt. Apply provider-specific normalization
        // (e.g. DeepSeek's convertContentToString, mergeConsecutiveRoles) so
        // the compaction call doesn't get rejected.
        const normalizedConversation =
          this.prepareNormalizedMessages(conversationMessages);

        const summaryParams = this.buildCompactionSummaryParams(
          normalizedConversation,
          compactionSystemPrompt,
        );
        const summaryResponse = await client.chat.completions.create(
          summaryParams,
          { signal, maxRetries: AUXILIARY_MAX_RETRIES },
        );
        return {
          summaryText:
            summaryResponse.choices[0]?.message?.content?.trim() ?? '',
          outputTokens: summaryResponse.usage?.completion_tokens ?? 0,
        };
      },
      (summary) => ({
        role: 'user',
        content: summary,
      }),
    );
  }

  /**
   * Extracts reasoning text from a streaming chunk delta.
   * Override in subclasses to handle provider-specific reasoning fields.
   */
  protected extractReasoningDelta(chunk: ChatCompletionChunk): string {
    return extractReasoningDeltaFromChunk(chunk);
  }

  /**
   * Returns the thinking parameter for models that support the thinking API.
   * Used by Kimi K2.5 and DeepSeek models which use `thinking: {type: "enabled"|"disabled"}`.
   *
   * Override in subclasses to enable/disable thinking mode explicitly.
   * @returns The thinking parameter object, or undefined to not send the parameter.
   */
  protected getThinkingParameter():
    { type: 'enabled' | 'disabled' } | undefined {
    return undefined;
  }

  protected buildCompactionSummaryParams(
    conversationMessages: ChatCompletionMessageParam[],
    systemPrompt: string,
  ): ChatCompletionSummaryParams {
    const summaryParams: ChatCompletionSummaryParams = {
      model: this.config.fullName,
      messages: [
        { role: 'system', content: systemPrompt },
        ...conversationMessages,
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
    return summaryParams;
  }

  /**
   * Whether this request configures the agent's end tag as an API-level `stop`
   * sequence (see `buildChatBaseParams`). o-series and Grok reasoning models
   * never do, so a natural `STOP` finish from them does not imply the provider
   * stripped the end tag. Single source of truth gating both the `stop` config
   * and `extractResponse`'s `appendEndTagIfNeeded` restoration, so the two
   * can't drift apart.
   */
  protected get configuresEndTagStopSequence(): boolean {
    const isGrokReasoningModel =
      this.config.provider === ModelProvider.XAI &&
      this.capabilities.supportsReasoning;
    return !this.isOReasoningModel && !isGrokReasoningModel;
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

    if (this.configuresEndTagStopSequence) {
      if (endTag) {
        baseParams.stop = [endTag];
      }
      baseParams.temperature = temperature;
    }

    const reasoningEffort = this.getEffectiveReasoningEffort();
    if (this.capabilities.supportsReasoning && reasoningEffort) {
      baseParams.reasoning_effort = this.validateReasoningEffort(
        toOpenAIReasoningEffort(
          reasoningEffort,
          getDeclaredMaxReasoningEffort(this.config.capabilities),
        ),
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
        DEFAULT_CORE_SETTINGS.model.openaiParallelToolCalls,
      );
      baseParams.parallel_tool_calls = parallelToolCalls;
      // These tools are parsed by TeXRA after the response. The SDK's
      // auto-parse validator requires strict schemas, but several TeXRA tools
      // intentionally expose nullable or optional fields.
      const convertedTools = toOpenAITools(tools);
      baseParams.tools = convertedTools;
      baseParams.tool_choice = 'auto';
    }

    if (
      this.config.provider === ModelProvider.DEEPSEEK &&
      !this.capabilities.supportsReasoning &&
      this.config.maxOutputTokens <= DEEPSEEK_OFFICIAL_API_MAX_TOKENS
    ) {
      // Tool-use mode otherwise reduces max_tokens (getEffectiveMaxOutputTokens)
      // to leave headroom for context growth; a model already capped at or
      // below the official API's legacy ceiling has no headroom to spare, so
      // use its own declared max_tokens unreduced.
      this.logger.debug(
        `Setting max_tokens to ${this.config.maxOutputTokens} for DeepSeek chat models capped at the official API's max_tokens ceiling`,
      );
      baseParams.max_tokens = this.config.maxOutputTokens;
    }

    return baseParams;
  }

  protected finalizeStreams(
    thinking: ReturnType<ModelHandler['createThinkingStream']>,
    output: ReturnType<ModelHandler['createOutputStream']>,
    finalResponse: ChatCompletion,
  ): void {
    const finalReasoning = this.processThinkingBlock(finalResponse);
    thinking.finalize(finalReasoning ?? undefined);

    const finalOutput = finalResponse.choices?.[0]?.message?.content ?? '';
    output.finalize(finalOutput);
  }

  protected async executeStreamingChat(
    client: OpenAI,
    baseParams: ChatCompletionRequestBase,
    signal?: AbortSignal,
  ): Promise<ChatCompletion> {
    // Opened before the request; the deferred starts fire (if ever) at the
    // first reasoning/content delta — the phase signal for this API.
    const thinking = this.createThinkingStream();
    const output = this.createOutputStream();

    const streamParams: ChatCompletionCreateParamsStreaming = {
      ...baseParams,
      stream: true,
      stream_options: { include_usage: true },
    };

    const streamingAggregator =
      this.useReasoningStreamAggregator && this.capabilities.supportsReasoning
        ? new ReasoningStreamAggregator()
        : null;
    let requestId: string | undefined;
    let stream: ChatCompletionStream | undefined;
    const abortReconstructedStream = () => stream?.abort();
    signal?.addEventListener('abort', abortReconstructedStream, { once: true });

    const onContentDelta = ({ delta }: ContentDeltaEvent): void => {
      if (delta) {
        output.append(delta);
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

    try {
      const request = client.chat.completions.create(streamParams, { signal });
      const { data, response } = await request.withResponse();
      requestId = detectRequestId({ headers: response.headers });
      stream = ChatCompletionStream.fromReadableStream(data.toReadableStream());
      if (signal?.aborted) stream.abort();
      stream.on('content.delta', onContentDelta);
      stream.on('chunk', onChunk);

      let finalResponse = await this.awaitFinalResponse(
        stream,
        streamingAggregator,
      );

      // Ensure usage is captured - use SDK's totalUsage() as fallback
      if (!finalResponse.usage) {
        try {
          const totalUsage = await stream.totalUsage();
          finalResponse = { ...finalResponse, usage: totalUsage };
        } catch (err) {
          // totalUsage() may fail if stream ended abnormally — leave usage
          // unset, but log so missing token accounting is traceable.
          this.logger.debug('totalUsage() fallback failed; usage unavailable', {
            data: buildErrorLogData(err, { operation: 'totalUsage fallback' }),
          });
        }
      }

      this.finalizeStreams(thinking, output, finalResponse);
      return finalResponse;
    } catch (streamError) {
      return handleStreamingFailure(streamError, {
        // Finalize the progress streams on error so the progress view does
        // not hang in a loading state (parity with the OpenRouter streaming
        // path). No explicit final text so any chunks already streamed are
        // preserved (passing `''` would overwrite the visible partial
        // output). `finalize` is idempotent, so this is safe even if a
        // partial finalize already ran.
        finalizeOnError: () => {
          thinking.finalize(undefined);
          output.finalize();
        },
        // On mid-stream failure, lift the partial content the SDK already
        // accumulated (currentChatCompletionSnapshot) onto the error so the
        // retry UI can show it and future continuation logic can reference
        // the tail.
        partialTail: () =>
          extractOpenAIPartialTail(
            stream?.currentChatCompletionSnapshot,
            PARTIAL_TEXT_TAIL_MAX,
          ),
        decorateError: (err, tail) => {
          // Tag at the boundary so abort identity survives wrapping and
          // minification (mirrors the Anthropic stream catch).
          tagOpenAISdkError(err, this.config.provider);
          if (requestId && err instanceof Error) {
            (err as ErrorWithRequestId).request_id = requestId;
          }
          // Aborts are control flow; log at debug, skip warn.
          if (!isUserAbort(err)) {
            this.logger.warn('Stream failed', {
              data: {
                ...buildErrorLogData(err, { model: this.config.fullName }),
                partialTextLength: tail.length,
              },
            });
          }
          return err;
        },
      });
    } finally {
      signal?.removeEventListener('abort', abortReconstructedStream);
      stream?.off('content.delta', onContentDelta);
      stream?.off('chunk', onChunk);
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
    stream: ChatCompletionStream,
    aggregator: ReasoningStreamAggregator | null,
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
   * Declarative message-normalization knobs for OpenAI-compatible providers.
   * Subclasses set these instead of re-implementing
   * {@link getMessageNormalizationOptions}; the base derives the options from
   * them. Real OpenAI keeps all three off (array content sent as-is).
   */
  /** Collapse array message content into a newline-joined string. */
  protected readonly convertContentToString: boolean = false;
  /**
   * Collapse content to a string only for non-vision models; vision models
   * keep array content so image parts survive.
   */
  protected readonly convertContentToStringUnlessVision: boolean = false;
  /** Merge consecutive messages that share the same role. */
  protected readonly mergeConsecutiveRoles: boolean = false;

  /**
   * Returns message normalization options derived from the declarative knobs
   * above. Subclasses can still override this directly for bespoke logic.
   *
   * @returns Normalization options, or undefined to skip normalization
   */
  protected getMessageNormalizationOptions():
    NormalizeOpenAIMessageContentOptions | undefined {
    const convertContentToString =
      this.convertContentToString ||
      (this.convertContentToStringUnlessVision &&
        !this.capabilities.supportsVision);
    if (!convertContentToString && !this.mergeConsecutiveRoles) {
      return undefined;
    }
    return {
      ...(convertContentToString ? { convertContentToString: true } : {}),
      ...(this.mergeConsecutiveRoles ? { mergeConsecutiveRoles: true } : {}),
    };
  }

  protected override get sdkErrorTagger() {
    return tagOpenAISdkError;
  }

  override get supportsForcedToolChoice(): boolean {
    return true;
  }

  /** Creates a chat completion after SDK-boundary error tagging is installed. */
  protected override async createResponseImpl(
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
      finalTool,
    } = options;

    // Phase 0: COMPACT - Apply the shared trigger before building the request.
    const { compactedMessages, didCompact } =
      await this.maybeCompactByInputTokens(
        rawMessages,
        this.lastKnownInputTokens,
        () => this.compactConversation(client, rawMessages, signal),
      );
    const updatedMessages = didCompact ? compactedMessages : undefined;
    const messagesToUse = updatedMessages ?? rawMessages;

    // Apply message normalization if subclass specifies options
    const messages = this.prepareNormalizedMessages(messagesToUse);

    // Phase 1: BUILD - Construct provider-specific request parameters
    const useStreaming = this.getStreamingConfig();
    const baseParams = this.buildChatBaseParams(
      messages,
      temperature,
      systemPrompt,
      endTag,
      tools,
    );
    if (finalTool && tools?.length) {
      baseParams.tool_choice = {
        type: 'function',
        function: { name: finalTool.name },
      };
    }

    // Phase 2: COUNT - Estimate input tokens if handler supports it
    // Phase 3: VALIDATE - Adjust max_tokens if needed
    const maxTokensKey = this.isOReasoningModel
      ? 'max_completion_tokens'
      : 'max_tokens';
    await this.applyTokenCountLimit({
      countTokens: () =>
        this.estimateTokenCount(messages, { client, systemPrompt, signal }),
      currentMaxTokens:
        baseParams[maxTokensKey] ?? this.getEffectiveMaxOutputTokens(),
      contextWindow: this.config.contextWindow,
      detailLabel: `OpenAI: ${maxTokensKey} reduced to fit context window`,
      applyReduced: (adjusted) => {
        baseParams[maxTokensKey] = adjusted;
      },
    });

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
   * Normalizes messages under {@link getMessageNormalizationOptions} and logs
   * diagnostics about any changes.
   * @param messages Original message array passed to the handler.
   */
  private prepareNormalizedMessages<T extends ChatCompletionMessageParam>(
    messages: T[],
  ): T[] {
    const options = this.getMessageNormalizationOptions();
    const normalizedMessages = options
      ? normalizeOpenAIMessageContent(messages, options)
      : messages;

    if (normalizedMessages.length !== messages.length) {
      this.logger.debug('Preprocessed message array for model compatibility', {
        data: {
          beforeCount: messages.length,
          afterCount: normalizedMessages.length,
          providerLabel: this.config.provider,
        },
      });
    }

    return normalizedMessages;
  }

  /** Initializes message array with system prompt and user content. */
  async initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: FileLocation[],
    systemPrompt?: string,
  ): Promise<ChatCompletionMessageParam[]> {
    return initializeChatMessages(
      userPrefix,
      userRequest,
      mediaFiles,
      systemPrompt,
      this.capabilities,
      (files, context) => this.createMediaForRound(files, context),
    );
  }

  /** Adds user message content for subsequent rounds. */
  async createRoundMessages(
    messages: ChatCompletionMessageParam[],
    userMessage: string,
    mediaFiles?: FileLocation[],
  ): Promise<ChatCompletionMessageParam[]> {
    return createChatRoundMessages(
      messages,
      userMessage,
      mediaFiles,
      this.capabilities,
      (files, context) => this.createMediaForRound(files, context),
    );
  }

  async createUserFollowUpMessages(
    messages: ChatCompletionMessageParam[],
    userMessage: string,
  ): Promise<ChatCompletionMessageParam[]> {
    return createChatUserFollowUpMessages(messages, userMessage);
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
    return extractChatAssistantText(message);
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
          url: toDataUrl(media.media_type, media.data),
          detail: 'high',
        },
      },
    ];
  }

  /** Formats image/audio content for OpenAI/Google's vision/audio API. */
  createMediaContent(mediaMessage: MediaEntry[]): ChatCompletionContentPart[] {
    return mediaMessage.flatMap((media): ChatCompletionContentPart[] => {
      const classification = classifyMediaEntry(media);

      // This handler has no PDF-specific rendering; treat a classified PDF
      // the same as any other image, matching the prior media_category-only
      // check.
      if (classification === 'image' || classification === 'pdf') {
        return this.buildStandardVisionParts(media);
      } else if (
        classification === 'audio' &&
        this.capabilities.supportsNativeAudio
      ) {
        // Currently OpenRouter's OpenAI-compatible audio branch is the only consumer
        // Extract format from mime type (e.g., 'wav' from 'audio/wav')
        const audioFormat = extractMimeSubtype(media.media_type).toLowerCase();
        if (audioFormat !== 'wav' && audioFormat !== 'mp3') {
          throw new Error(
            `Unsupported audio format "${audioFormat}". Valid formats: wav, mp3`,
          );
        }

        return [
          { type: 'text', text: `Audio: ${media.file_name}` },
          {
            type: 'input_audio',
            input_audio: { data: media.data, format: audioFormat },
          },
        ];
      } else if (classification === 'audio') {
        this.logger.warn(
          `Audio input received (${media.file_name}) but native audio is not supported by this specific model/provider (${this.config.provider}). Skipping.`,
        );
        return [];
      } else {
        this.logger.warn(unknownMediaCategoryWarning(media));
        return [];
      }
    });
  }

  /**
   * Extracts response text and usage statistics from an API response.
   *
   * `responseObject` is intentionally `any` for the reasons documented on
   * {@link OpenAIClassifiedResponse}; `classifyOpenAIResponse` sniffs the raw
   * shape exactly once so the body below reads typed fields instead of
   * re-checking `any` properties per branch.
   */
  extractResponse(responseObject: any, endTag: string): ExtractResponseResult {
    const classified = classifyOpenAIResponse(responseObject);

    if (classified.kind === 'errorPayload') {
      this.logger.debug('Response object', { data: responseObject });
      const errorMsg = `API error: ${JSON.stringify(classified.error)}`;
      this.logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    if (classified.kind === 'malformed') {
      const errorMsg = 'Invalid response from API: missing choices';
      this.logger.error(errorMsg);
      this.logger.error('Response object', { data: responseObject });
      throw new Error(errorMsg);
    }

    let content: string;
    let stopReason: ExtractResponseResult['stopReason'];
    let usage: ExtractResponseResult['usage'];

    if (classified.kind === 'streamingFallback') {
      this.logger.debug('Response object', { data: responseObject });
      this.logger.warn(
        'Using direct response format (streaming style) as fallback',
      );
      ({ content, stopReason, usage } = classified);
    } else {
      const { choice } = classified;
      stopReason = choice.finish_reason;
      usage = responseObject.usage;
      content = choice.message.content ?? '';
      this.logger.debug(`Stop reason: ${stopReason}`);
      if (!content) {
        if (
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
          this.logger.error('Response object', { data: responseObject });
          this.logger.error('content is empty');
        }
      }
    }

    // Only restore the end tag when it was configured as an API-level stop
    // sequence (see `configuresEndTagStopSequence`). o-series/Grok reasoning
    // models never set `stop`, so a natural STOP there doesn't imply the
    // provider stripped the tag — forging it could mask incomplete output as
    // complete.
    const withEndTag = this.appendEndTagIfNeeded(
      content ? this.normalizeResponseText(content) : '',
      endTag,
      stopReason === OPENAI_CHAT_FINISH.STOP &&
        this.configuresEndTagStopSequence,
    );

    return { text: this.postProcessResponse(withEndTag), usage, stopReason };
  }

  protected appendUserText(
    messages: ChatCompletionMessageParam[],
    text: string,
  ): void {
    appendUserTextToChatMessages(
      messages,
      text,
      this.capabilities.supportsIntermDevMsgs,
    );
  }

  protected appendTextToLastAssistantMessage(
    messages: ChatCompletionMessageParam[],
    text: string,
    options: { afterContinuationPrompt?: boolean; fallbackText?: string } = {},
  ): boolean {
    let targetIndex = messages.length - 1;
    const trailingMessage = messages.at(-1);

    if (options.afterContinuationPrompt) {
      if (
        !trailingMessage ||
        (trailingMessage.role !== 'user' && trailingMessage.role !== 'system')
      ) {
        return false;
      }
      if (!this.containCutOffMessage(trailingMessage.content)) {
        return false;
      }
      targetIndex = messages.length - 2;
    }

    const targetMessage = messages.at(targetIndex);
    if (!isAssistantMessage(targetMessage)) {
      return false;
    }

    if (Array.isArray(targetMessage.content)) {
      targetMessage.content.push({ type: 'text', text });
    } else {
      targetMessage.content = [
        { type: 'text', text: options.fallbackText ?? text },
      ];
    }

    if (options.afterContinuationPrompt && trailingMessage?.role === 'user') {
      messages.pop();
    }
    return true;
  }

  /** Computes cost based on token usage and model pricing. */
  computePrice(responseUsage: ExtendedCompletionUsage | null): number {
    return computeOpenAIPrice(responseUsage, this.standardPricingConfig());
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
    return normalizeOpenAIUsage(
      rawUsage,
      responseTimeMs,
      this.usageProvider,
      this.standardPricingConfig(),
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

  protected extractReasoningFromResponse(
    responseObject: ChatCompletion,
  ): string | null {
    // extractReasoningFromMessage takes a loose bag, not ChatCompletionMessage,
    // because provider-specific overrides (e.g. MiniMax's reasoning_details)
    // read fields the official SDK type doesn't declare.
    return this.extractReasoningFromMessage(
      responseObject?.choices?.[0]?.message as unknown as
        Record<string, unknown> | undefined,
    );
  }

  /**
   * Processes thinking blocks from API response.
   * @param responseObject The response object from the API
   * @param workspaceState Optional workspaceState to update with thinking blocks
   * @returns The extracted reasoning content or null if none found
   */
  processThinkingBlock(
    responseObject: ChatCompletion,
    workspaceState?: AgentWorkspaceState,
  ): string | null {
    const reasoning = this.extractReasoningFromResponse(responseObject);
    if (!reasoning) {
      return null;
    }

    this.applyStringReasoningToWorkspaceState(reasoning, workspaceState);

    this.logger.debug('Reasoning content preview', {
      data: { preview: reasoning.slice(0, K_SLICE) },
    });
    return reasoning;
  }

  private ensureStringifiedArguments(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === undefined) return '{}';
    try {
      return JSON.stringify(value);
    } catch (err) {
      this.logger.warn('Failed to serialize tool arguments', {
        data: buildErrorLogData(err, { operation: 'serialize tool arguments' }),
      });
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

  extractToolUse(responseObject: ChatCompletion): TCall[] {
    const toolCalls = responseObject?.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      return [];
    }

    // Let a malformed payload throw: swallowing it here would return an
    // empty tool-call list, which the caller reads as "the model made no
    // tool calls" and finalizes the run as a successful completion instead
    // of surfacing the corrupted provider response. The thrown error
    // propagates to the existing classifyAgentError boundary
    // (AgentRunLifecycle.ts), which fails the run loudly and retryably.
    assertToolCallsAreChatCompletionFunctionToolCalls(toolCalls);

    return toolCalls.map((call) => ({
      provider: this.toolCallProvider,
      callId: call.id,
      name: call.function.name,
      input: parseToolInput(call.function.arguments, call.id, this.logger),
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
    result: ToolResult,
    attachments: ToolFileAttachment[],
    workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<ChatCompletionMessageParam[]> {
    // The single-call path is batched-of-one: identical assistant-turn
    // construction, tool result formatting, and reasoning reset.
    return this.createBatchedToolUseFollowUpMessages(
      [{ call, result, attachments }],
      workspaceState,
      text,
    );
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
    entries: Array<{
      call: TCall;
      result: ToolResult;
      attachments: ToolFileAttachment[];
    }>,
    workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<ChatCompletionMessageParam[]> {
    if (entries.length === 0) {
      return [];
    }

    const toolCalls = entries.map(({ call }) =>
      this.normalizeToolCall(call.raw),
    );
    const callMsg = this.buildAssistantMessageWithToolCalls(
      toolCalls,
      workspaceState,
      text,
    );

    const toolResultMessages = toolCalls.map((call, i) => ({
      role: 'tool' as const,
      tool_call_id: call.id,
      content: formatToolResultTextWithAttachments(
        entries[i].result,
        entries[i].attachments,
        this.canProcessToolResultAttachments,
      ),
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
    prependTextToChatUserMessage(messages, text);
  }

  /**
   * Add media files to the last user message in the conversation.
   */
  async addMediaToUserMessage(
    messages: ChatCompletionMessageParam[],
    mediaFiles: FileLocation[],
  ): Promise<MediaAttachmentKind[]> {
    if (!mediaFiles.length || !this.capabilities.supportsVision) return [];

    const lastUserMsg = messages.findLast((m) => m.role === 'user');
    if (!lastUserMsg || !('content' in lastUserMsg)) return [];

    const formattedMedia = await this.createMediaForRound(mediaFiles, 'insert');
    if (formattedMedia.length === 0) return [];
    insertMediaIntoChatUserMessage(lastUserMsg, formattedMedia);
    return this.consumeInsertedAttachmentKinds('insert');
  }
}
