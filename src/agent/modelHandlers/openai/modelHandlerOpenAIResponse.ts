// Third-party imports
import OpenAI from 'openai';
// Exported by openai@6.x via the package's ./lib/* subpath; keep typecheck
// coverage around SDK upgrades because this is not a top-level public helper.
import { addOutputText } from 'openai/lib/ResponsesParser';

// Local imports - agent
import {
  logContextManagementEvent,
  logProgressStatus,
  logSdkError,
} from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  hasEndTag,
  type AgentSetting,
} from '@agent/core/definition/AgentDataclass';
import { type OpenAIAPIResponseUsage } from '@agent/core/usage/ResponseUsage';
import type { AgentWorkspaceState } from '@agent/core/execution/AgentWorkspaceState';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import type { MediaEntry } from '@agent/utils/mediaTypes';
import { calculateTokenPrice } from '@agent/utils/priceUtils';
import { K_SLICE } from '@agent/core/constants';
import {
  detectStatusCode,
  getSdkErrorMessage,
  isContextWindowError,
  isPreviousResponseIdError,
  isUserAbort,
  attachPartialText,
  takeTail,
  PARTIAL_TEXT_TAIL_MAX,
} from '@common/errors/sdkErrorUtils';
import { isGpt5ModelName, isGptFamilyModelName } from '@model/modelNames';

// Type imports
import type { FileLocation } from '@shared/schemas';
import type { ToolFileAttachment } from '@shared/schemas/toolResult';

// Local imports - utils
import { clamp, delay, filterNotNullish, roundTo } from '@utils/core';
import { getConfig } from '@utils/config/configUtils';
import {
  getWebSocketEnabled,
  getUseOpenRouter,
} from '@utils/config/providerConfig';
import { flexibleFS } from '@utils/files/flexibleFS';
import { toOpenAIReasoningEffort } from '../support/reasoningEffort';
import { normalizeUsage } from '../support/UsageNormalizer';
import { prepareExistingOutputContent } from '../utils/fileContentUtils';
import { tagOpenAISdkError } from './openAISdkError';
import { withSdkErrorTag } from '../support/sdkErrorTagging';
import {
  classifyOpenAIBackgroundResumeError,
  createOpenAIBackgroundPollingError,
  createOpenAIBackgroundTerminalError,
  normalizeOpenAIResponseError,
} from './openAIResponseErrors';

// Local file imports
import {
  formatAttachmentSummary,
  formatToolResultAsText,
  type ToolResultPayload,
} from '../utils/toolAttachmentUtils';
import { parseToolArguments } from '../utils/parseArguments';
import { OPENAI_CHAT_FINISH } from '../types/StopReasonTypes';
import { toOpenAIResponseTools } from '../toolConversion';
import { ModelHandler } from '../ModelHandler';
import {
  CHAINED_RESPONSE_MAX_OUTPUT_FACTOR,
  CHAINED_RESPONSE_SAFETY_MARGIN_PERCENT,
  TOKEN_SAFETY_BUFFER,
  TOOL_USE_SAFETY_BUFFER,
} from '../contextManagementConstants';
import {
  extractOpenAIWebSearchResults,
  isOpenAIReasoningItem,
  isOpenAIServerToolContent,
  isOpenAIWebSearchCall,
  type ServerToolExtractionResult,
} from '../types/ServerToolTypes';
import { ResponseStreamProcessor } from './ResponseStreamProcessor';
import { OpenAIResponseWebSocketTransport } from './OpenAIResponseWebSocketTransport';
import { isResponseFunctionToolCallItem } from './responseStreamEvents';
import {
  createInputText,
  extractTextContentPart,
  hasResponseOutputText,
  isAssistantTextMessage,
  isMessageItem,
} from './openAIResponseContent';
import {
  buildInlineAttachmentParts,
  uploadInlineInputFiles,
  uploadToolAttachments,
  type UploadedOpenAIResponseAttachment,
} from './openAIResponseFileUploads';
import type { InputTokenCountParams } from 'openai/resources/responses/input-tokens';
import type { ProviderStopReason } from '../types/StopReasonTypes';
import type {
  CreateResponseOptions,
  CreateResponseResult,
  ExtractResponseResult,
  OpenAIResponseToolCall,
  TokenCountOptions,
} from '../types/IModelHandler';
import type { ResponseStreamParams } from 'openai/lib/responses/ResponseStream';
import type { Reasoning } from 'openai/resources/shared';
import type {
  CompactedResponse,
  EasyInputMessage,
  Response,
  ResponseCompactParams,
  ResponseUsage,
  ResponseCreateParamsBase,
  ResponseCreateParamsNonStreaming,
  ResponseReasoningItem,
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseInputContent,
  ResponseInputMessageContentList,
  ResponseStatus,
  ResponseFunctionCallOutputItemList,
  ResponseOutputItem,
  ResponseFunctionWebSearch,
} from 'openai/resources/responses/responses';

/**
 * The per-call values every transport path needs to finalize a response: how
 * many messages are in the (possibly compacted) conversation, whether
 * compaction happened this call, and the compacted messages to surface as
 * {@link CreateResponseResult.updatedMessages}. Grouped into one argument so the
 * extracted path methods don't carry a long, transposable positional tail.
 */
interface ResponseFinalizeContext {
  readonly effectiveMessagesLength: number;
  readonly compactedThisCall: boolean;
  readonly compactedMessages: ResponseInputItem[] | undefined;
}

function responseOutputItemKey(item: ResponseOutputItem): string | undefined {
  if (typeof item.id === 'string') return `id:${item.id}`;
  if (item.type === 'function_call' && typeof item.call_id === 'string') {
    return `function_call:${item.call_id}`;
  }
  return undefined;
}

function mergeMissingStreamedOutputItems(
  finalOutput: Response['output'],
  streamedItems: Response['output'],
): Response['output'] {
  if (streamedItems.length === 0) return finalOutput;
  if (!Array.isArray(finalOutput) || finalOutput.length === 0) {
    return streamedItems;
  }

  const finalKeys = new Set(
    finalOutput.map(responseOutputItemKey).filter(filterNotNullish),
  );
  const hasMissingStreamedItem = streamedItems.some((item) => {
    const key = responseOutputItemKey(item);
    return key != null && !finalKeys.has(key);
  });
  if (!hasMissingStreamedItem) return finalOutput;

  const streamedKeys = new Set(
    streamedItems.map(responseOutputItemKey).filter(filterNotNullish),
  );
  const finalOnlyItems = finalOutput.filter((item) => {
    const key = responseOutputItemKey(item);
    return key == null || !streamedKeys.has(key);
  });
  return [...streamedItems, ...finalOnlyItems];
}

/**
 * Handler for OpenAI's Responses API. This implementation works directly with
 * the native response message types instead of reusing the chat completion
 * abstractions. Conversation state is maintained through `previous_response_id`
 * so we only submit the new messages for each turn.
 *
 * THREAD SAFETY: This handler maintains internal state (previousResponseId,
 * pendingBackgroundResponseId, conversationState) that is NOT thread-safe.
 * Each handler instance must be used by a single agent execution at a time.
 * Do not share instances across concurrent invocations.
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
    return this.config.openRouterOnly || getUseOpenRouter();
  }

  /**
   * OpenAI Response API supports file uploads.
   */
  protected override get supportsToolResultFileUpload(): boolean {
    return true;
  }

  /** Whether inline input files can be uploaded before the response request. */
  protected get supportsInlineInputFileUpload(): boolean {
    return true;
  }

  /** Whether this backend can retain responses for `previous_response_id`. */
  protected get supportsResponseChaining(): boolean {
    return true;
  }

  /**
   * Override streaming config to disable streaming when background mode is enabled.
   * Background responses use polling for completed results, incompatible with streaming.
   */
  public override getStreamingConfig(): boolean {
    return !this.isBackgroundModeActive() && super.getStreamingConfig();
  }

  /**
   * Check if background mode is active for this handler.
   * Background mode is enabled when this handler supports it, the config
   * toggle is on, and this model/agent is eligible for background execution.
   */
  public override isBackgroundModeActive(): boolean {
    return this.shouldUseBackgroundResponses();
  }

  private isBackgroundModeToggleEnabled(): boolean {
    return getConfig<boolean>('texra.model.useBackgroundResponses', true);
  }

  private shouldUseBackgroundResponses(
    backgroundToggleEnabled = this.isBackgroundModeToggleEnabled(),
    backgroundModeEligible = this.isBackgroundModeEligible(),
  ): boolean {
    return (
      this.backgroundModeSupported &&
      backgroundToggleEnabled &&
      backgroundModeEligible
    );
  }

  protected override backgroundModeSupported = true;

  override get supportsManualCompaction(): boolean {
    return !this.isOpenRouterRoutingEnabled();
  }

  /**
   * Determines if background mode should be enabled for this request.
   * Enabled for GPT-family models (gpt4*, gpt5*, etc.) when running a
   * workflow agent (CoT or Direct) — not for tool-use agents, which rely
   * on per-step streaming.
   */
  private isBackgroundModeEligible(): boolean {
    return isGptFamilyModelName(this.config.name) && this.isWorkflowMode();
  }

  private static readonly BACKGROUND_POLL_INTERVAL_MS = 15000;
  private static readonly BACKGROUND_MAX_DURATION_MS = 3 * 60 * 60 * 1000; // 3 hours
  /** Statuses indicating the background response is still processing. */
  private static readonly BACKGROUND_PENDING_STATUSES: readonly ResponseStatus[] =
    ['queued', 'in_progress'];
  private previousResponseId: string | null = null;

  /**
   * Stores the ID of a background response that is currently being polled.
   * This allows retry logic to resume polling the same response instead of
   * creating a new request when connection errors occur during polling.
   *
   * IMPORTANT: This handler assumes single-threaded execution per instance.
   * Do not share a handler instance across concurrent agent invocations.
   */
  private pendingBackgroundResponseId: string | null = null;

  /**
   * Guards against concurrent createResponse() calls on the same handler.
   * The handler's mutable conversation state (previousResponseId, sentMessages,
   * etc.) assumes a single in-flight turn; concurrent calls would race on
   * previousResponseId and corrupt the chain. See the class doc ("THREAD SAFETY")
   * for the contract.
   */
  private inFlight = false;

  /** DIAGNOSTIC: Pre-flight token estimate for comparison with actual usage */
  private _diagPreFlightTokens: number | null = null;

  /** Clears the pending background response ID. Single point of mutation. */
  private clearPendingBackgroundResponse(): void {
    this.pendingBackgroundResponseId = null;
  }

  // =========================================================================
  // WebSocket transport
  // =========================================================================

  /**
   * Persistent WebSocket transport, created lazily on first use. The connection
   * lifecycle (open, keepalive, reconnect, close) lives in the collaborator;
   * the handler only decides when WebSocket mode applies.
   */
  private wsTransport: OpenAIResponseWebSocketTransport | null = null;

  private getWebSocketTransport(): OpenAIResponseWebSocketTransport {
    if (!this.wsTransport) {
      this.wsTransport = new OpenAIResponseWebSocketTransport({
        logger: this.logger,
        createStreamProcessor: () => this.createStreamProcessor(),
      });
    }
    return this.wsTransport;
  }

  /**
   * Create a stream processor bound to this handler's streaming collaborators.
   * Shared by the WebSocket transport and the HTTP streaming loop.
   */
  private createStreamProcessor(): ResponseStreamProcessor {
    return new ResponseStreamProcessor({
      // The processor opens this at the reasoning output item — the
      // provider's explicit phase signal — so the start emits eagerly.
      createThinkingStream: () =>
        this.createThinkingStream({ atPhaseSignal: true }),
      createOutputStream: () => this.createOutputStream(),
      extractText: (response) => this.extractResponse(response, '').text,
      emitWebSearchResult: (result) => this.emitWebSearchResult(result),
      logger: this.logger,
    });
  }

  /**
   * Whether WebSocket transport is enabled for this handler.
   *
   * WebSocket transport connects directly to the OpenAI Responses API via the
   * official SDK and is incompatible with any non-default base URL, including:
   * - Server-side keys relay (Supabase Edge Function)
   * - Improved connection proxy (proxy.texra.ai)
   * - OpenRouter routing
   * - Custom per-provider or per-model endpoints
   *
   * Also incompatible with background mode (polling-based, doesn't benefit
   * from persistent connection).
   */
  private isWebSocketModeEnabled(): boolean {
    return getWebSocketEnabled() && this.getBaseUrl() === null;
  }

  /** Release all resources held by this handler (WebSocket, keepalive). */
  override dispose(): void {
    this.wsTransport?.dispose();
  }

  /**
   * Attempts to resume polling a pending background response.
   *
   * @returns The completed response if resume succeeded, or null if a new request is needed.
   *          Throws on abort (user cancellation).
   */
  private async tryResumeBackgroundResponse(
    client: OpenAI,
    signal?: AbortSignal,
  ): Promise<Response | null> {
    const pendingId = this.pendingBackgroundResponseId;
    if (!pendingId) {
      return null;
    }

    this.logger.debug(
      `Resuming polling for pending background response ${pendingId}`,
    );

    let pendingResponse: Response;
    try {
      pendingResponse = await client.responses.retrieve(
        pendingId,
        undefined,
        signal ? { signal } : undefined,
      );
    } catch (err) {
      // Tag before checking: the SDK throws APIUserAbortError (not a
      // DOMException) when the signal fires inside retrieve(), and the tag
      // makes isUserAbort() robust even in minified bundles.
      tagOpenAISdkError(err, this.config.provider);
      if (isUserAbort(err)) {
        this.clearPendingBackgroundResponse();
        throw err;
      }
      // Transient failures (no status / 5xx / 429 / 408) — the background
      // response is likely still alive server-side, so retain the ID and
      // rethrow so the outer retry resumes the same ID. Definitive failures
      // (4xx, notably 404 expired) — clear the ID and create a new request.
      //
      // Check statusCode directly rather than providerError.userRetryable: the latter
      // is force-true for relay errors, which would incorrectly retain the ID
      // on a relay-wrapped 404 and loop until retries are exhausted.
      const { providerError, shouldRetainPendingResponse } =
        classifyOpenAIBackgroundResumeError(err, this.config.provider);
      if (shouldRetainPendingResponse) {
        throw err;
      }
      this.logger.warn(
        `Couldn't resume the pending OpenAI response; will start a new request. (${providerError.message})`,
        {
          data: {
            responseId: pendingId,
            error: providerError.message,
            statusCode: providerError.statusCode,
          },
        },
      );
      this.clearPendingBackgroundResponse();
      return null;
    }

    // Check the status of the retrieved response
    if (this.isBackgroundPending(pendingResponse)) {
      // Still processing - resume polling
      this.logger.debug(
        `Pending background response ${pendingId} still processing (status: ${pendingResponse.status}), resuming poll`,
      );
      const response = await this.waitForBackgroundCompletion(
        client,
        pendingResponse,
        signal,
      );
      // Note: clearPendingBackgroundResponse() called by finalizeResponse() in caller
      return response;
    }

    if (pendingResponse.status === 'completed') {
      // Already completed while we were disconnected
      this.logger.debug(
        `Pending background response ${pendingId} already completed`,
      );
      // Note: clearPendingBackgroundResponse() called by finalizeResponse() in caller
      return pendingResponse;
    }

    // Response failed remotely (failed/cancelled/incomplete)
    const errorDetail =
      pendingResponse.error?.message ??
      pendingResponse.incomplete_details?.reason ??
      'no additional details';
    this.logger.warn(
      `OpenAI background response ended remotely (${pendingResponse.status}: ${errorDetail}); starting a new request.`,
      {
        data: {
          responseId: pendingId,
          status: pendingResponse.status,
          error: pendingResponse.error ?? undefined,
          incompleteDetails: pendingResponse.incomplete_details ?? undefined,
        },
      },
    );
    this.clearPendingBackgroundResponse();
    return null;
  }

  /**
   * Conversation state for tracking messages, tokens, and compaction.
   * Grouped together to ensure synchronized resets.
   */
  private conversationState = {
    /** Number of messages already sent to the API */
    sentMessages: 0,
    /** Cumulative input tokens across the conversation (for compaction trigger) */
    cumulativeInputTokens: 0,
    /** Whether the conversation has been compacted */
    isCompacted: false,
    /** Whether we've logged the OpenRouter compaction skip message */
    openRouterSkipLogged: false,
  };

  /** Reset conversation state to initial values. */
  private resetConversationState(): void {
    this.conversationState = {
      sentMessages: 0,
      cumulativeInputTokens: 0,
      isCompacted: false,
      openRouterSkipLogged: false,
    };
  }

  /** Drop server-side chain state while preserving local token history. */
  private invalidateResponseChain(): void {
    this.previousResponseId = null;
    this.conversationState.sentMessages = 0;
    this.conversationState.isCompacted = false;
  }

  /**
   * Finalize response state after a successful API call.
   * Updates previousResponseId, conversation state, and token counts.
   */
  private finalizeResponse(
    response: Response,
    effectiveMessagesCount: number,
    compactedThisCall: boolean,
  ): void {
    // Apply compaction state if compaction happened this call
    if (compactedThisCall) {
      this.applyCompactionState();
    }

    // Only chain from completed responses with usage data. Missing usage
    // signals streaming instability (see the [TOKEN_DIAG] branch below);
    // chaining from such responses has produced stale-id and token-count
    // drift in practice, so treat it the same as a non-completed status.
    // Use a typeof check rather than truthiness so a legitimate 0 wouldn't
    // be misclassified.
    const hasInputTokens = typeof response.usage?.input_tokens === 'number';
    const safeToChain =
      this.supportsResponseChaining &&
      response.status === 'completed' &&
      hasInputTokens;
    if (safeToChain) {
      this.previousResponseId = response.id;
      this.conversationState.sentMessages = effectiveMessagesCount;
    } else {
      const errorDetail =
        response.error?.message ?? response.incomplete_details?.reason;
      this.logger.debug(
        `Response ${response.id} not safe for chaining (status="${response.status}", hasInputTokens=${hasInputTokens})`,
        {
          data: {
            responseId: response.id,
            status: response.status,
            hasUsage: !!response.usage,
            hasInputTokens,
            errorDetail,
          },
        },
      );
      // Rejecting the chain anchor invalidates the client-side bookkeeping:
      // sentMessages counts against server-side history that we're now
      // refusing to reference, so slicing from it on the next turn would
      // drop context. Reset sentMessages so the next turn sends full
      // history via `input`, and clear isCompacted so the send-all branch
      // isn't wrongly re-entered. Preserve cumulativeInputTokens so
      // shouldCompact() can still trigger proactively — otherwise a
      // large conversation that hits a transient missing-usage response
      // would lose its compaction baseline and fail hard on the next
      // turn, bypassing the context-window recovery below (which also
      // requires previousResponseId to be set).
      this.invalidateResponseChain();
    }

    // Clear any pending background response ID - a successful finalization means
    // any previous pending ID is stale and should not be resumed
    this.clearPendingBackgroundResponse();

    // Set cumulative input tokens from actual usage (not additive - this IS the total).
    // The response's input_tokens reflects the full context including server-side history.
    //
    // Note: OpenAI's input_tokens is the TOTAL (includes cached tokens).
    // Cached tokens are a subset reported in input_tokens_details.cached_tokens.
    // This differs from Anthropic where input_tokens excludes cached tokens.
    //
    // NOTE: With previous_response_id, input_tokens includes the full conversation
    // history. However, there may be edge cases where token counting doesn't match
    // actual context usage (e.g., timing between count and API call, tool definitions,
    // or reasoning token accounting). See PRD Known Issues for investigation details.
    if (response.usage?.input_tokens) {
      const actualTokens = response.usage.input_tokens;
      this.conversationState.cumulativeInputTokens = actualTokens;

      // DIAGNOSTIC: Compare pre-flight estimate with actual usage
      if (this._diagPreFlightTokens !== null) {
        const diff = actualTokens - this._diagPreFlightTokens;
        const diffPercent =
          this._diagPreFlightTokens > 0
            ? ((diff / this._diagPreFlightTokens) * 100).toFixed(1)
            : 'N/A';
        const reasoningTokens =
          response.usage.output_tokens_details?.reasoning_tokens ?? 0;
        const outputTokens = response.usage.output_tokens ?? 0;

        this.logger.debug(
          `[TOKEN_DIAG] Actual vs pre-flight: ${actualTokens} vs ${this._diagPreFlightTokens} (diff: ${diff > 0 ? '+' : ''}${diff}, ${diffPercent}%)`,
          {
            data: {
              actualInputTokens: actualTokens,
              preFlightTokens: this._diagPreFlightTokens,
              difference: diff,
              differencePercent: diffPercent,
              outputTokens,
              reasoningTokens,
              totalTokens: response.usage.total_tokens,
              contextWindow: this.config.contextWindow,
              utilizationActual:
                (actualTokens / this.config.contextWindow) * 100,
            },
          },
        );
        this._diagPreFlightTokens = null; // Clear for next request
      }
    } else {
      // DIAGNOSTIC: Log when usage data is missing (streaming instability?)
      this.logger.debug(
        `[TOKEN_DIAG] response.usage.input_tokens MISSING - cannot track context usage`,
        {
          data: {
            responseId: response.id,
            responseStatus: response.status,
            hasUsage: !!response.usage,
            inputTokens: response.usage?.input_tokens,
            outputTokens: response.usage?.output_tokens,
            totalTokens: response.usage?.total_tokens,
            preFlightTokens: this._diagPreFlightTokens,
          },
        },
      );
      this._diagPreFlightTokens = null; // Clear anyway
    }

    // Reset compacted flag after successful request (ready for next compaction if needed)
    this.conversationState.isCompacted = false;
  }

  /**
   * Manually set the previous response ID to resume a conversation.
   * Call with `null` to reset the stored ID.
   */
  setPreviousResponseId(id: string | null): void {
    this.previousResponseId = id;
    this.resetConversationState();
    this.clearPendingBackgroundResponse();
  }

  /** Retrieve the stored previous response ID. */
  getPreviousResponseId(): string | null {
    return this.previousResponseId;
  }

  /**
   * Calculate the absolute token threshold based on the model's context window
   * and the configured percentage threshold.
   */
  private getCompactionTokenThreshold(): number {
    const percent = this.getCompactionThresholdPercent();
    if (percent <= 0) {
      return 0;
    }
    // Calculate threshold as percentage of context window
    return Math.floor((percent / 100) * this.config.contextWindow);
  }

  /**
   * Check if the conversation should be compacted based on cumulative input tokens.
   * Compaction is only triggered when:
   * - Threshold percentage is greater than 0 (not disabled)
   * - Cumulative input tokens exceed the calculated threshold (percentage of context window)
   * - Not running through OpenRouter (which may not support compaction)
   */
  private shouldCompact(): boolean {
    if (!this.supportsManualCompaction) {
      this.compactionRequested = false;
      return false;
    }

    // Manual compaction request bypasses threshold checks.
    // The flag is NOT cleared here - the caller clears it after compaction
    // is attempted to preserve the request across retries.
    if (this.compactionRequested) {
      if (this.isOpenRouterRoutingEnabled()) {
        return false;
      }
      // Only compact if there are tokens to compact
      return this.conversationState.cumulativeInputTokens > 0;
    }

    const thresholdPercent = this.getCompactionThresholdPercent();
    if (thresholdPercent <= 0) {
      return false;
    }
    if (this.isOpenRouterRoutingEnabled()) {
      if (!this.conversationState.openRouterSkipLogged) {
        this.logger.debug('Skipping compaction: OpenRouter routing is enabled');
        this.conversationState.openRouterSkipLogged = true;
      }
      return false;
    }
    const threshold = this.getCompactionTokenThreshold();
    return this.conversationState.cumulativeInputTokens > threshold;
  }

  /**
   * Result from compactConversation including messages and state updates.
   * State updates are returned but not applied - caller is responsible for
   * applying them only after successful API call to prevent stale state on retry.
   */
  private compactionResult?: {
    compactedMessages: ResponseInputItem[];
    tokensAfter: number;
  };

  /**
   * Best available estimate of current input tokens.
   * Returns compactionResult.tokensAfter if compaction just happened,
   * otherwise falls back to cumulativeInputTokens from previous response.
   * Returns 0 if no token data available (first turn).
   */
  private getBestInputTokenEstimate(): number {
    return (
      this.compactionResult?.tokensAfter ??
      this.conversationState.cumulativeInputTokens
    );
  }

  /**
   * Get the appropriate safety buffer for token validation.
   * - Chained responses (previous_response_id): proportional margin (5% of context window)
   *   because the pre-flight token count can significantly undercount server-side context
   *   (reasoning tokens, framing overhead). A flat buffer is insufficient at high utilization.
   * - Tool-use mode: larger flat buffer (2000) for counting discrepancies
   * - Otherwise: small buffer (10) for exact counting
   */
  private getTokenSafetyBuffer(): number {
    if (this.supportsResponseChaining && this.previousResponseId !== null) {
      // Proportional margin scales with context window size - critical at high utilization
      // where even a small percentage error can cause overflow.
      const proportionalMargin = Math.floor(
        this.config.contextWindow *
          (CHAINED_RESPONSE_SAFETY_MARGIN_PERCENT / 100),
      );
      // Use at least the tool-use buffer as a floor
      return Math.max(proportionalMargin, TOOL_USE_SAFETY_BUFFER);
    }
    return this.isToolUseMode() ? TOOL_USE_SAFETY_BUFFER : TOKEN_SAFETY_BUFFER;
  }

  /**
   * Reduces max_output_tokens when response chaining is active.
   * This mirrors the existing tool-use output-budgeting pattern and reserves
   * headroom for server-side context framing with previous_response_id.
   */
  private applyChainedOutputTokenBudget(maxOutputTokens: number): number {
    if (!this.supportsResponseChaining || !this.previousResponseId) {
      return maxOutputTokens;
    }

    const budgeted = Math.max(
      1,
      Math.floor(maxOutputTokens * CHAINED_RESPONSE_MAX_OUTPUT_FACTOR),
    );
    if (budgeted !== maxOutputTokens) {
      this.logger.debug(
        `Applied chained max_output_tokens budget: ${maxOutputTokens} -> ${budgeted}`,
      );
    }
    return budgeted;
  }

  /**
   * Compact the conversation to reduce context size.
   * Uses OpenAI's `/responses/compact` endpoint to replace prior assistant messages,
   * tool calls, and results with a single encrypted compaction item.
   *
   * State updates are stored in compactionResult but NOT applied immediately.
   * The caller must apply them only after successful API call to prevent
   * stale state if the API call fails and needs to retry.
   *
   * @param client - OpenAI client instance
   * @param messages - Current conversation messages
   * @param systemPrompt - Optional system instructions
   * @param signal - Optional abort signal
   * @returns The compacted messages array, or original messages if compaction fails
   */
  private async compactConversation(
    client: OpenAI,
    messages: ResponseInputItem[],
    systemPrompt?: string,
    signal?: AbortSignal,
    convertedTools?: unknown[],
  ): Promise<ResponseInputItem[]> {
    const tokensBefore = this.conversationState.cumulativeInputTokens;
    const contextWindow = this.config.contextWindow;
    const utilizationBefore = (tokensBefore / contextWindow) * 100;

    this.logger.debug(
      `Compacting conversation with ${tokensBefore} input tokens (${utilizationBefore.toFixed(1)}% of ${contextWindow} context window)`,
    );

    const compactParams: ResponseCompactParams = {
      model: this.config.fullName,
      input: messages,
    };

    if (systemPrompt) {
      compactParams.instructions = systemPrompt;
    }

    // NOTE: Do NOT pass previous_response_id here.
    // We're sending the full message history in `input`, so passing
    // previous_response_id would cause double-counting and exceed context window.

    try {
      const compactedResponse: CompactedResponse =
        await client.responses.compact(compactParams);

      // Note: SDK types CompactedResponse.output as ResponseOutputItem[], but the
      // compact endpoint returns ResponseInputItem[] suitable for re-submission.
      const compactedMessages =
        compactedResponse.output as unknown as ResponseInputItem[];

      // CRITICAL: Clear previousResponseId now that compaction has replaced the
      // server-side history. Must happen BEFORE estimateTokenCount — otherwise the
      // count would include the full previous conversation on top of the compacted
      // messages, massively inflating the result.
      this.previousResponseId = null;

      // Count the actual tokens of the compacted messages rather than relying on
      // usage fields from the compact response (usage.input_tokens is the cost of
      // the compact operation's input, and usage.output_tokens may not match the
      // input token cost when these items are re-submitted).
      let tokensAfter: number;
      try {
        tokensAfter = await this.estimateTokenCount(compactedMessages, {
          client,
          signal,
          systemPrompt,
          tools: convertedTools,
        });
      } catch (err) {
        // Fall back to output_tokens if token counting fails. Log so a degraded
        // post-compaction token estimate is visible rather than silent.
        this.logger.debug(
          `Post-compaction token counting failed; falling back to output_tokens: ${getSdkErrorMessage(err)}`,
        );
        // NOTE: It's unclear what output_tokens represents exactly for the compact
        // endpoint — it may be the generation cost rather than the reusable content
        // size. This fallback is a best-effort estimate until OpenAI clarifies.
        tokensAfter = compactedResponse.usage.output_tokens;
      }

      const utilizationAfter = (tokensAfter / contextWindow) * 100;
      const reduction = tokensBefore - tokensAfter;
      const reductionPercent = ((reduction / tokensBefore) * 100).toFixed(1);

      // Log context management event with structured data
      logContextManagementEvent(
        this.logger,
        `Compacted conversation: ${tokensBefore.toLocaleString()} → ${tokensAfter.toLocaleString()} tokens (${reductionPercent}% reduction)`,
        {
          action: 'compaction',
          tokensBefore,
          tokensAfter,
          contextWindow,
          utilizationBefore: roundTo(utilizationBefore, 1),
          utilizationAfter: roundTo(utilizationAfter, 1),
          details: `OpenAI Responses API compaction: ${compactedResponse.output.length} items`,
        },
      );

      // Store compacted messages for use in this request.
      // Mark as pending compaction - state will be finalized after successful API call.
      // This prevents stale state if API call fails and needs retry.
      this.compactionResult = { compactedMessages, tokensAfter };

      return compactedMessages;
    } catch (err) {
      this.logger.warn(
        `Compaction failed, continuing with original messages: ${getSdkErrorMessage(err)}`,
      );
      this.compactionResult = undefined;
      return messages;
    }
  }

  /**
   * Apply compaction state updates after successful API call.
   * Updates conversation state flags. Does NOT clear compactionResult -
   * it's needed for the return value and gets cleared on next createResponse() call.
   *
   * Note: cumulativeInputTokens is NOT updated here - it will be set from
   * response.usage.input_tokens after the API call to reflect actual usage.
   */
  private applyCompactionState(): void {
    if (!this.compactionResult) return;

    // Reset sent messages counter since we're using compacted output
    this.conversationState.sentMessages = 0;
    // Mark as compacted so subsequent requests know to send all messages
    this.conversationState.isCompacted = true;

    // Note: previousResponseId is already cleared immediately after compaction
    // (before API call) to avoid "No tool output found" errors.

    // Note: compactionResult is NOT cleared here - it's read for the return value.
    // It gets cleared at the start of the next createResponse() call.
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
    this.resetConversationState();
    this.clearPendingBackgroundResponse();
    this.wsTransport?.dispose();

    const messages: ResponseInputItem[] = [];

    if (systemPrompt) {
      const role = this.capabilities.supportsSystemPrompt ? 'system' : 'user';
      const systemMessage: ResponseInputItem.Message = {
        type: 'message',
        role,
        content: [createInputText(systemPrompt)],
      };
      messages.push(systemMessage);
    }

    const supportsMedia =
      this.capabilities.supportsVision || this.capabilities.supportsNativeAudio;
    const userContent: ResponseInputMessageContentList = [
      createInputText(userPrefix),
    ];

    if (mediaFiles && mediaFiles.length > 0 && supportsMedia) {
      try {
        const mediaContent = (await this.createMediaMessage(
          mediaFiles,
        )) as ResponseInputMessageContentList;
        userContent.push(...mediaContent);
      } catch (err) {
        logSdkError(
          this.logger,
          `Error processing media files: ${getSdkErrorMessage(err)}`,
          err,
          { operation: 'process media files' },
        );
      }
    }

    const initialUserMessage: ResponseInputItem.Message = {
      type: 'message',
      role: 'user',
      content: userContent,
    };
    messages.push(initialUserMessage);

    const requestRole = this.capabilities.supportsIntermDevMsgs
      ? 'system'
      : 'user';

    if (requestRole === 'user' && messages.length > 0) {
      this.appendInputText(messages.at(-1)!, userRequest);
    } else {
      const requestMessage: ResponseInputItem.Message = {
        type: 'message',
        role: requestRole,
        content: [createInputText(userRequest)],
      };
      messages.push(requestMessage);
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
      mediaFiles?.length &&
      (this.capabilities.supportsVision ||
        this.capabilities.supportsNativeAudio)
    ) {
      try {
        const formattedMediaContent = (await this.createMediaMessage(
          mediaFiles,
        )) as ResponseInputMessageContentList;
        roundContent.push(...formattedMediaContent);
      } catch (err) {
        logSdkError(
          this.logger,
          `Error processing media files for follow-up round: ${getSdkErrorMessage(err)}`,
          err,
          { operation: 'process media files' },
        );
      }
    }

    roundContent.push(createInputText(userMessage));

    const roundUserMessage: ResponseInputItem.Message = {
      type: 'message',
      role: 'user',
      content: roundContent,
    };
    messages.push(roundUserMessage);

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
          createInputText(`Image: ${media.file_name}`),
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
          createInputText(`Document: ${media.file_name}`),
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

  /**
   * Whether this handler supports native token counting via API.
   * When true, the handler will use OpenAI's /responses/input_tokens endpoint
   * for exact token counts instead of heuristics.
   */
  override get supportsTokenCounting(): boolean {
    return !this.isOpenRouterRoutingEnabled();
  }

  /**
   * Estimates token count using OpenAI's native /responses/input_tokens endpoint.
   * This provides exact pre-flight token counts for the Responses API.
   *
   * @param messages The messages to count tokens for.
   * @param options Token counting options including client and signal.
   * @returns Promise resolving to the total token count.
   * @see https://platform.openai.com/docs/api-reference/responses/input-tokens
   */
  override async estimateTokenCount(
    messages: ResponseInputItem[],
    options?: TokenCountOptions<OpenAI>,
  ): Promise<number> {
    if (!this.supportsTokenCounting) {
      throw new Error(
        'Token counting not available when routing through OpenRouter',
      );
    }

    const client = options?.client ?? (await this.getClient());

    // Build params matching what we send to the actual API call
    const countParams: InputTokenCountParams = {
      model: this.config.fullName,
      input: messages,
      ...(this.supportsResponseChaining &&
        this.previousResponseId && {
          previous_response_id: this.previousResponseId,
        }),
      ...(options?.systemPrompt && { instructions: options.systemPrompt }),
      ...(options?.tools?.length && {
        tools: options.tools as InputTokenCountParams['tools'],
      }),
    };

    const tokenCount = await client.responses.inputTokens.count(
      countParams,
      options?.signal ? { signal: options.signal } : undefined,
    );

    this.logger.debug(`Token count of message: ${tokenCount.input_tokens}`);
    return tokenCount.input_tokens;
  }

  /**
   * Create a response using the Responses API.
   * The handler submits only the messages that were not part of the previous
   * request and relies on `previous_response_id` for conversation context.
   *
   * Supports automatic conversation compaction when cumulative input tokens
   * exceed the configured threshold (texra.model.compactionThresholdPercent).
   *
   * @returns Result containing the response and optionally updated messages if compaction occurred
   */
  protected override get sdkErrorTagger() {
    return tagOpenAISdkError;
  }

  override async createResponse(
    options: CreateResponseOptions<ResponseInputItem, OpenAI>,
  ): Promise<CreateResponseResult<Response, ResponseInputItem>> {
    // Single-turn contract: concurrent callers would race on previousResponseId
    // and conversationState. Fail loudly so the caller bug surfaces instead of
    // corrupting the conversation silently.
    if (this.inFlight) {
      throw new Error(
        'modelHandlerOpenAIResponse.createResponse invoked while a prior ' +
          'call is still in flight; this handler is single-turn per instance.',
      );
    }
    this.inFlight = true;
    try {
      return await withSdkErrorTag(
        this.sdkErrorTagger,
        this.config.provider,
        () => this.createResponseImpl(options),
      );
    } finally {
      this.inFlight = false;
    }
  }

  protected override async createResponseImpl(
    options: CreateResponseOptions<ResponseInputItem, OpenAI>,
  ): Promise<CreateResponseResult<Response, ResponseInputItem>> {
    // Clear any stale compaction result from previous attempts (ensures clean state on retries)
    this.compactionResult = undefined;

    const { client, messages, temperature, systemPrompt, signal, tools } =
      options;
    const backgroundToggleEnabled = this.isBackgroundModeToggleEnabled();
    const backgroundModeEligible = this.isBackgroundModeEligible();
    const useBackgroundResponses = this.shouldUseBackgroundResponses(
      backgroundToggleEnabled,
      backgroundModeEligible,
    );
    const streamingToggleEnabled = useBackgroundResponses
      ? super.getStreamingConfig()
      : this.getStreamingConfig();
    const useStreaming = streamingToggleEnabled && !useBackgroundResponses;
    const useWebSocket =
      this.isWebSocketModeEnabled() && !useBackgroundResponses;

    if (
      backgroundToggleEnabled &&
      backgroundModeEligible &&
      !useBackgroundResponses
    ) {
      this.logger.debug(
        'Background mode toggle is enabled but this handler does not support background execution. Proceeding without background mode.',
      );
    } else if (streamingToggleEnabled && useBackgroundResponses) {
      this.logger.debug(
        'Background mode enabled; skipping streaming to avoid unstable behavior.',
      );
    }

    // Convert tools early so they're available for both compaction token counting and the API call
    const convertedTools = tools?.length
      ? toOpenAIResponseTools(tools, {
          supportsNativeWebSearch: this.capabilities.supportsNativeWebSearch,
          supportsFunctionCalling: this.capabilities.supportsFunctionCalling,
        })
      : undefined;

    // Check if compaction is needed before processing the request
    let effectiveMessages = messages;
    // Track if compaction happened in THIS call (not previous calls)
    let compactedThisCall = false;
    // Store compacted messages for return value (captured when compaction succeeds)
    let compactedMessages: ResponseInputItem[] | undefined;
    if (this.shouldCompact()) {
      // Capture whether this was a manual request before clearing the flag.
      const wasManualRequest = this.compactionRequested;
      // Clear manual compaction flag now that compaction is being attempted.
      // For automatic compaction (threshold-based), this is a no-op since the flag is false.
      this.compactionRequested = false;
      if (wasManualRequest) {
        logProgressStatus(
          this.logger,
          `Compacting conversation (manually requested, ${this.conversationState.cumulativeInputTokens} input tokens)`,
        );
      } else {
        const threshold = this.getCompactionTokenThreshold();
        logProgressStatus(
          this.logger,
          `Compacting conversation (${this.conversationState.cumulativeInputTokens} tokens exceed ${this.getCompactionThresholdPercent()}% threshold of ${threshold} tokens)`,
        );
      }
      effectiveMessages = await this.compactConversation(
        client,
        messages,
        systemPrompt,
        signal,
        convertedTools,
      );
      // compactionResult is set if compaction succeeded
      compactedThisCall = this.compactionResult !== undefined;
      if (compactedThisCall) {
        // Note: previousResponseId is already cleared inside compactConversation()
        // immediately after the compact endpoint succeeds (before token counting).
        compactedMessages = this.compactionResult!.compactedMessages;
      }
    }

    // After compaction in THIS call, send all compacted messages.
    // If already compacted (from previous call), also send all messages.
    // Otherwise, only send new messages since last request.
    const shouldSendAll =
      !this.supportsResponseChaining ||
      compactedThisCall ||
      this.conversationState.isCompacted;
    const newMessages = shouldSendAll
      ? effectiveMessages
      : effectiveMessages.slice(this.conversationState.sentMessages);

    if (this.supportsInlineInputFileUpload) {
      await uploadInlineInputFiles(client, newMessages, {
        openRouterRouting: this.isOpenRouterRoutingEnabled(),
        logger: this.logger,
      });
    }

    // Build shared params used by both token counting and API call

    const rawEffort = this.capabilities.supportsReasoning
      ? this.getEffectiveReasoningEffort()
      : undefined;
    const reasoningEffort = rawEffort
      ? toOpenAIReasoningEffort(rawEffort)
      : undefined;

    // Phase 1: BUILD - Construct provider-specific request parameters
    const baseParams = {
      model: this.config.fullName,
      input: newMessages,
      ...(systemPrompt && { instructions: systemPrompt }),
      ...(this.supportsResponseChaining &&
        this.previousResponseId && {
          previous_response_id: this.previousResponseId,
        }),
      ...(convertedTools?.length && { tools: convertedTools }),
      ...(reasoningEffort && { reasoning: { effort: reasoningEffort } }),
    };

    let maxOutputTokens = this.getEffectiveMaxOutputTokens();
    maxOutputTokens = this.applyChainedOutputTokenBudget(maxOutputTokens);

    // Phase 2: COUNT - Estimate input tokens using built params
    // Phase 3: VALIDATE - Adjust max_output_tokens if needed
    //
    // Two-layer protection against context overflow:
    // 1. shouldCompact() uses cumulativeInputTokens (from PREVIOUS response) at 75% threshold
    //    to proactively compact before trouble
    // 2. This native count (CURRENT request) is the safety net at 100% threshold
    //
    // NOTE: When previous_response_id is set, the API includes server-side history
    // (per OpenAI docs). However, there may be edge cases where token counting
    // doesn't match actual context usage. See PRD Known Issues for investigation.
    await this.applyTokenCountLimit({
      // Reuse built params for token counting (build once principle).
      // IMPORTANT: Pass tools and systemPrompt for accurate count.
      countTokens: () =>
        this.estimateTokenCount(baseParams.input, {
          client,
          signal,
          systemPrompt,
          tools: convertedTools,
        }),
      currentMaxTokens: maxOutputTokens,
      contextWindow: this.config.contextWindow,
      tokenBuffer: this.getTokenSafetyBuffer(),
      detailLabel:
        'OpenAI Response: max_output_tokens reduced to fit context window',
      applyReduced: (adjusted) => {
        maxOutputTokens = adjusted;
      },
      onCounted: (inputTokens) => {
        // DIAGNOSTIC: Log token count details for investigation.
        // Compare pre-flight estimate with cumulative tokens from prev response.
        const prevCumulative = this.conversationState.cumulativeInputTokens;
        const utilizationEstimate =
          (inputTokens / this.config.contextWindow) * 100;
        this._diagPreFlightTokens = inputTokens; // Compared in finalizeResponse
        this.logger.debug(
          `[TOKEN_DIAG] Pre-flight count: ${inputTokens} (${utilizationEstimate.toFixed(1)}% of ${this.config.contextWindow})`,
          {
            data: {
              preFlightTokens: inputTokens,
              prevCumulativeTokens: prevCumulative,
              delta: inputTokens - prevCumulative,
              newMessagesCount: newMessages.length,
              totalMessagesCount: effectiveMessages.length,
              hasPreviousResponseId: !!this.previousResponseId,
              hasTools: !!convertedTools?.length,
              toolCount: convertedTools?.length ?? 0,
              contextWindow: this.config.contextWindow,
              maxOutputTokens,
            },
          },
        );
      },
      onCountFailure: (err) => {
        this.logger.debug(
          `Token counting failed: ${getSdkErrorMessage(err)}. Applying fallback cap.`,
        );
        // Fallback: cap output based on best available estimate.
        // Skip on first turn (no history to overflow).
        const inputEstimate = this.getBestInputTokenEstimate();
        if (inputEstimate > 0) {
          const buffer = this.getTokenSafetyBuffer();
          const available = this.config.contextWindow - inputEstimate - buffer;
          const capped = clamp(available, 0, maxOutputTokens);
          if (capped !== maxOutputTokens) {
            this.logger.debug(
              `Fallback: max_output_tokens ${maxOutputTokens} → ${capped} (estimate: ${inputEstimate})`,
            );
            maxOutputTokens = capped;
          }
        }
      },
    });

    // Phase 4: EXECUTE - Build final params and make the API call
    const parallelToolCalls = getConfig<boolean>(
      'texra.model.openaiParallelToolCalls',
      false,
    );
    const params: ResponseCreateParamsBase = {
      ...baseParams,
      max_output_tokens: maxOutputTokens,
      store: true,
      ...(convertedTools?.length && {
        tool_choice: 'auto' as const,
        ...(!parallelToolCalls && { parallel_tool_calls: false }),
      }),
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

    // Include web search sources in response when native web search is enabled.
    // This is set outside the tools block because deep research models use
    // native web search even when no explicit tools are passed.
    if (this.capabilities.supportsNativeWebSearch) {
      params.include = ['web_search_call.action.sources'];
    }

    // Extend reasoning with summary option for API call (not needed for token counting)
    if (this.capabilities.supportsReasoning) {
      const isGpt5 = isGpt5ModelName(this.config.name);
      const includeSummary =
        !isGpt5 ||
        getConfig<boolean>('texra.model.gpt5ReasoningSummary', false);
      if (includeSummary) {
        params.reasoning = {
          ...(params.reasoning as Reasoning),
          summary: 'auto',
        };
      }
    }

    const finalizeContext: ResponseFinalizeContext = {
      effectiveMessagesLength: effectiveMessages.length,
      compactedThisCall,
      compactedMessages,
    };

    // Wrap execution in a try/catch so the error handler can recover from an
    // invalid/expired previous_response_id or a context-window overflow.
    try {
      // Try to resume a pending background response (retry after connection error)
      if (useBackgroundResponses && this.pendingBackgroundResponseId) {
        const resumed = await this.tryResumeBackgroundIfPending(
          client,
          signal,
          finalizeContext,
        );
        // Null means nothing to resume (or it failed remotely) — fall through
        // to create a fresh request.
        if (resumed) return resumed;
      }

      // WebSocket transport: persistent connection for lower-latency tool-use loops
      if (useWebSocket) {
        return await this.executeWebSocketPath(
          params,
          client,
          signal,
          finalizeContext,
        );
      }

      if (useStreaming) {
        return await this.executeStreamingPath(
          params,
          client,
          signal,
          finalizeContext,
        );
      }

      // Non-streaming path
      return await this.executeNonStreamingPath(
        params,
        client,
        signal,
        useBackgroundResponses,
        finalizeContext,
      );
    } catch (error) {
      return await this.handleCreateResponseError(
        error,
        options,
        compactedThisCall,
      );
    }
  }

  /**
   * Resumes a pending background response left over from a prior connection
   * failure. Returns the finalized result, or null when there is nothing to
   * resume (or the remote response itself failed) so the caller falls through
   * to creating a fresh request.
   */
  private async tryResumeBackgroundIfPending(
    client: OpenAI,
    signal: AbortSignal | undefined,
    ctx: ResponseFinalizeContext,
  ): Promise<CreateResponseResult<Response, ResponseInputItem> | null> {
    const resumedResponse = await this.tryResumeBackgroundResponse(
      client,
      signal,
    );
    if (!resumedResponse) return null;
    this.finalizeResponse(
      resumedResponse,
      ctx.effectiveMessagesLength,
      ctx.compactedThisCall,
    );
    return {
      response: resumedResponse,
      updatedMessages: ctx.compactedMessages,
    };
  }

  /**
   * WebSocket transport path: a persistent connection for lower-latency
   * tool-use loops. Polls to completion if the response comes back pending.
   */
  private async executeWebSocketPath(
    params: ResponseCreateParamsBase,
    client: OpenAI,
    signal: AbortSignal | undefined,
    ctx: ResponseFinalizeContext,
  ): Promise<CreateResponseResult<Response, ResponseInputItem>> {
    const wsResult = await this.getWebSocketTransport().execute(
      client,
      params,
      signal,
    );
    let response = wsResult.response;
    const processor = wsResult.processor;

    // Safety net: handle unexpected pending status (shouldn't happen without background mode)
    if (this.isBackgroundPending(response)) {
      this.logger.debug(
        `WebSocket response ${response.id} ended with pending status "${response.status}" — polling for completion`,
      );
      response = await this.waitForBackgroundCompletion(
        client,
        response,
        signal,
      );
    }

    // Finalize streams after background polling so the final text
    // reflects the completed response, not the pre-poll snapshot.
    processor.finalize(response);

    this.finalizeResponse(
      response,
      ctx.effectiveMessagesLength,
      ctx.compactedThisCall,
    );
    return { response, updatedMessages: ctx.compactedMessages };
  }

  /**
   * Streaming path. Accumulates `output_text.delta` events so a mid-stream
   * failure can surface the partial tail as structured error metadata (the
   * Responses stream has no native currentMessage accessor). Polls to
   * completion if the stream ends before the response finishes.
   */
  private async executeStreamingPath(
    params: ResponseCreateParamsBase,
    client: OpenAI,
    signal: AbortSignal | undefined,
    ctx: ResponseFinalizeContext,
  ): Promise<CreateResponseResult<Response, ResponseInputItem>> {
    // Text accumulated from `response.output_text.delta` events; surfaced as
    // partial text if the stream fails mid-flight.
    let streamedText = '';
    // Each `output_item.done` carries one complete output item (message, tool
    // call, or reasoning). Some backends (the Codex subscription endpoint) leave
    // the completed response's `output` empty, so we keep the items to rebuild
    // it below — otherwise the whole turn, tool calls included, is dropped.
    const streamedItems: Response['output'] = [];
    try {
      const { stream: _stream, ...rest } = params;
      const streamParams: ResponseStreamParams = { ...rest, stream: true };
      const stream = await client.responses.stream(streamParams, { signal });

      // Processor handles interleaved thinking and web search
      // GPT can: think → web_search → think more → web_search → text
      const processor = this.createStreamProcessor();

      for await (const event of stream) {
        processor.process(event);
        if (event.type === 'response.output_text.delta') {
          streamedText += event.delta;
        } else if (event.type === 'response.output_item.done') {
          streamedItems.push(event.item);
        }
      }

      let response = await stream.finalResponse();

      // If the stream ended before the response completed (e.g., relay timeout
      // during slow GPT-5 requests), poll until it finishes instead of silently
      // returning an incomplete response.
      if (this.isBackgroundPending(response)) {
        this.logger.debug(
          `Streaming response ${response.id} ended with pending status "${response.status}" - polling for completion`,
        );
        response = await this.waitForBackgroundCompletion(
          client,
          response,
          signal,
        );
      }

      // Some backends (the ChatGPT-subscription Codex endpoint) stream output
      // items (text, tool calls, reasoning) but leave the completed response's
      // `output` empty or partial. Fill missing items from streamed
      // `output_item.done` events so function calls are not dropped.
      // `finalResponse()` returns a `ParsedResponse`, but `output` /
      // `output_text` are mutable fields on the base `Response`; assign
      // through that view so no hand-rolled response shape is needed.
      const mergedOutput = mergeMissingStreamedOutputItems(
        response.output,
        streamedItems,
      );
      if (mergedOutput !== response.output) {
        (response as Response).output = mergedOutput;
      }
      if (streamedText && !hasResponseOutputText(response)) {
        (response as Response).output_text = streamedText;
      }

      processor.finalize(response);

      this.finalizeResponse(
        response,
        ctx.effectiveMessagesLength,
        ctx.compactedThisCall,
      );
      return { response, updatedMessages: ctx.compactedMessages };
    } catch (error) {
      // Attach a capped tail of any streamed text before it propagates so the
      // retry UI receives the same structured error shape downstream.
      if (streamedText) {
        attachPartialText(error, takeTail(streamedText, PARTIAL_TEXT_TAIL_MAX));
      }
      throw error;
    }
  }

  /**
   * Non-streaming path. Errors propagate to PocketFlow's execFallback which
   * logs once (log-at-boundary principle). Polls for completion when the
   * response is pending — expected under background mode, and a handled edge
   * case under server-side `previous_response_id` latency.
   */
  private async executeNonStreamingPath(
    params: ResponseCreateParamsBase,
    client: OpenAI,
    signal: AbortSignal | undefined,
    useBackgroundResponses: boolean,
    ctx: ResponseFinalizeContext,
  ): Promise<CreateResponseResult<Response, ResponseInputItem>> {
    const { stream: _nonStream, ...nonStreamRest } = params;
    const nonStreamingParams: ResponseCreateParamsNonStreaming = {
      ...nonStreamRest,
      stream: false,
    };
    let response = await client.responses.create(nonStreamingParams, {
      signal,
    });

    // Poll for completion if response is pending (queued/in_progress).
    // This can happen in two cases:
    // 1. Background mode explicitly enabled (expected)
    // 2. Server-side latency when using previous_response_id (unexpected but handled)
    if (this.isBackgroundPending(response)) {
      if (useBackgroundResponses) {
        logProgressStatus(
          this.logger,
          'Running OpenAI in background mode; polling for completion (this may take longer than usual).',
        );
      } else {
        this.logger.debug(
          `Response ${response.id} returned with pending status "${response.status}" despite non-background mode; polling for completion`,
          {
            data: {
              responseId: response.id,
              status: response.status,
              hasPreviousResponseId: !!this.previousResponseId,
            },
          },
        );
      }
      response = await this.waitForBackgroundCompletion(
        client,
        response,
        signal,
      );
    }

    this.finalizeResponse(
      response,
      ctx.effectiveMessagesLength,
      ctx.compactedThisCall,
    );
    return { response, updatedMessages: ctx.compactedMessages };
  }

  /**
   * Error recovery for {@link createResponseImpl}. Normalizes the provider
   * error; on an invalid/expired `previous_response_id` it clears the chain so
   * the next retry rebuilds from local history; on a context-window overflow
   * while chaining (and not already compacted this call) it drops server-side
   * state and retries internally with compaction. All other errors rethrow.
   */
  private async handleCreateResponseError(
    error: unknown,
    options: CreateResponseOptions<ResponseInputItem, OpenAI>,
    compactedThisCall: boolean,
  ): Promise<CreateResponseResult<Response, ResponseInputItem>> {
    // Extract error details for diagnostics (useful for relay errors)
    const providerError = normalizeOpenAIResponseError(
      error,
      this.config.provider,
    );
    const { rawErrorBody } = providerError;
    if (rawErrorBody) {
      this.logger.debug('Raw error body from provider', {
        data: { rawErrorBody },
      });
    }

    // OpenAI: If the error indicates the response ID is invalid, clear it
    // This allows retry logic to recover by starting a fresh conversation
    if (isPreviousResponseIdError(error)) {
      this.logger.debug(
        `Clearing previousResponseId=${this.previousResponseId} due to invalid/expired response - ` +
          'next retry will rebuild conversation from local history',
      );
      this.invalidateResponseChain();
      // Also clear pending background response if present
      this.clearPendingBackgroundResponse();
    } else if (
      isContextWindowError(error) &&
      this.previousResponseId &&
      !compactedThisCall
    ) {
      // Recovery: When using previous_response_id, accumulated reasoning tokens
      // from prior turns are stored server-side and count against the context
      // window, but inputTokens.count() may not fully reflect them. This causes
      // pre-flight validation to pass while the API rejects the request.
      //
      // Fix: Drop server-side state (clearing previous_response_id discards the
      // hidden reasoning tokens) and compact client-side messages, then retry.
      // The guard !compactedThisCall prevents infinite recursion.
      logProgressStatus(
        this.logger,
        'Context window exceeded — compacting conversation and retrying.',
      );
      this.previousResponseId = null;
      // Don't call resetConversationState() — it zeroes cumulativeInputTokens
      // which would prevent shouldCompact() from triggering on the retry.
      this.clearPendingBackgroundResponse();
      this.compactionRequested = true;
      this._diagPreFlightTokens = null;
      // Retry internally: the recursive call will compact (shouldCompact()=true)
      // and send all messages without server-side state.
      // Call the impl directly — we're still inside the outer createResponse's
      // inFlight guard, and the public entry would trip the assertion.
      return this.createResponseImpl(options);
    } else if (this.previousResponseId) {
      // Log diagnostic info for other errors when chaining was active
      this.logger.debug(
        `Request failed with previousResponseId=${this.previousResponseId}. ` +
          `Error: ${providerError.message}`,
      );
    }

    // Retention of pendingBackgroundResponseId is decided at the point of
    // failure (tryResumeBackgroundResponse and waitForBackgroundCompletion).
    // If it survived to here, the next retry will try to resume the same ID.
    if (this.pendingBackgroundResponseId) {
      this.logger.debug(
        `Retaining pendingBackgroundResponseId=${this.pendingBackgroundResponseId} for retry - ` +
          'next attempt will try to resume polling instead of creating new request',
      );
    }

    // Clear diagnostic state to avoid stale comparison on retry
    this._diagPreFlightTokens = null;

    throw error;
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
      this.logger.debug(
        'Response missing usage information - token counts will show as 0',
        {
          data: {
            responseId: responseObject.id,
            status: responseObject.status,
          },
        },
      );
    }
    let newResponse = responseObject.output_text?.trim() ?? '';
    if (!newResponse && Array.isArray(responseObject.output)) {
      // Mutates responseObject.output_text from output message parts.
      addOutputText(responseObject);
      newResponse = responseObject.output_text?.trim() ?? '';
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
      return { text: `${newResponse}\n${endTag}`, usage, stopReason };
    }

    return { text: newResponse, usage, stopReason };
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
    return normalizeUsage(
      {
        provider: 'openai-response',
        computePrice: (usage) => this.computePrice(usage),
        extract: (usage) => ({
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cachedTokens: usage.input_tokens_details?.cached_tokens ?? 0,
          reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
        }),
      },
      rawUsage,
      responseTimeMs,
    );
  }

  private isBackgroundPending(response: Response): boolean {
    return ModelHandlerOpenAIResponse.BACKGROUND_PENDING_STATUSES.includes(
      response.status as ResponseStatus,
    );
  }

  private async waitForBackgroundCompletion<T extends Response>(
    client: OpenAI,
    initialResponse: T,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!initialResponse.id) {
      return initialResponse;
    }

    let current = initialResponse;
    const responseId = initialResponse.id;

    // Track which response is being polled so retry logic can resume via
    // tryResumeBackgroundResponse instead of creating a new request.
    this.pendingBackgroundResponseId = responseId;
    const pollInterval = ModelHandlerOpenAIResponse.BACKGROUND_POLL_INTERVAL_MS;
    const startTime = Date.now();
    let pollCount = 0;
    const initialStatus = current.status ?? 'unknown';

    this.logger.debug(
      `Background polling started for response ${responseId} (status: ${initialStatus})`,
      {
        data: {
          responseId,
          status: current.status,
        },
      },
    );

    while (this.isBackgroundPending(current)) {
      pollCount += 1;
      this.logger.debug(
        `Waiting ${pollInterval}ms before poll ${pollCount} for response ${responseId}`,
        {
          data: {
            responseId,
            pollCount,
            waitMs: pollInterval,
          },
        },
      );
      try {
        await delay(pollInterval, { signal });
      } catch (err) {
        if (isUserAbort(err)) {
          this.logger.debug(
            `Background polling aborted for response ${responseId} while waiting to poll.`,
            {
              data: {
                responseId,
                pollCount,
                elapsedMs: Date.now() - startTime,
              },
            },
          );
          // User cancelled - clear pending ID to prevent ghost-resume on next call.
          // The background job keeps running on OpenAI's side but we won't try to
          // resume it since the user explicitly cancelled.
          this.clearPendingBackgroundResponse();
        }
        throw err;
      }

      const elapsedMs = Date.now() - startTime;
      if (elapsedMs > ModelHandlerOpenAIResponse.BACKGROUND_MAX_DURATION_MS) {
        this.logger.error(
          `Background response ${responseId} exceeded maximum polling duration while pending`,
          {
            data: {
              responseId,
              status: current.status,
              pollCount,
              elapsedMs,
            },
          },
        );
        throw new Error(
          `Background response ${responseId} exceeded maximum polling duration of ${ModelHandlerOpenAIResponse.BACKGROUND_MAX_DURATION_MS} ms. Retry later or cancel the job with client.responses.cancel("${responseId}").`,
        );
      }

      const requestOptions = signal ? { signal } : undefined;
      try {
        // Cast is safe: retrieve returns the same response structure, just without parsed output typing
        current = (await client.responses.retrieve(
          responseId,
          undefined,
          requestOptions,
        )) as T;
      } catch (err) {
        // Tag before checking: retrieve() throws the SDK's APIUserAbortError,
        // not a DOMException, when the signal fires.
        tagOpenAISdkError(err, this.config.provider);
        if (isUserAbort(err)) {
          // User cancelled during retrieve - clear pending ID
          this.clearPendingBackgroundResponse();
          throw err;
        }
        // 404 "response not found" during polling means the response is truly
        // gone server-side. Clear the pending ID so the next retry creates a
        // fresh background request instead of routing through
        // tryResumeBackgroundResponse to rediscover the 404. The wrapping
        // below strips the 404 status so the provider-error normalizer
        // classifies the error as retryable (network-like), keeping the retry
        // loop engaged rather than bailing out on a non-retryable 4xx.
        //
        // All other errors (401, 403, 5xx, network, etc.) propagate unchanged
        // so downstream handlers (relay 401 token refresh, retryability checks,
        // non-retryable classification) work correctly with full HTTP metadata.
        const statusCode = detectStatusCode(err);
        if (statusCode === 404) {
          this.clearPendingBackgroundResponse();
          throw createOpenAIBackgroundPollingError(
            responseId,
            err,
            this.config.provider,
          );
        }
        throw err;
      }

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
    }

    const elapsedMs = Date.now() - startTime;
    this.logger.debug(
      `Background polling finished for response ${responseId} with status=${
        current.status ?? 'unknown'
      } after ${pollCount} polls (${elapsedMs} ms)`,
      {
        data: {
          responseId,
          status: current.status,
          pollCount,
          elapsedMs,
          usage: current.usage ?? undefined,
        },
      },
    );

    if (current.status === 'completed') {
      return current;
    }

    const fallbackStatus = current.status ?? 'unknown';
    this.logger.error(
      `Background response ${responseId} ended with status ${fallbackStatus}`,
      {
        data: {
          responseId,
          status: current.status,
          pollCount,
          elapsedMs,
          error: current.error ?? undefined,
          incomplete: current.incomplete_details ?? undefined,
        },
      },
    );
    throw createOpenAIBackgroundTerminalError(current, this.config.provider);
  }

  /** Adds continuation instructions for models without prefill support. */
  addContinueMessageWithoutPrefill(
    messages: ResponseInputItem[],
    workspaceState: AgentWorkspaceState,
    agentSetting: AgentSetting,
  ): void {
    const userMessageContinuation = this.createContinuationPrompt(
      workspaceState,
      agentSetting,
    );

    const role = this.capabilities.supportsIntermDevMsgs ? 'system' : 'user';
    const continuationMessage: ResponseInputItem.Message = {
      type: 'message',
      role,
      content: [createInputText(userMessageContinuation)],
    };
    messages.push(continuationMessage);
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
      if (prefill.length === 0) {
        this.logger.debug(
          'No prefill provided; skipping pseudo-prefill instruction',
        );
        return [endTurn, messages];
      }
      const pseudoPrefill = `Organize your response with xml tags. Start your response with:\n${prefill}`;
      const lastMessage = messages.at(-1);
      if (lastMessage) {
        this.appendInputText(lastMessage, pseudoPrefill);
      } else {
        const pseudoPrefillMessage: ResponseInputItem.Message = {
          type: 'message',
          role: 'user',
          content: [createInputText(pseudoPrefill)],
        };
        messages.push(pseudoPrefillMessage);
      }
      this.logger.debug(
        `Added pseudo prefill message to messages:\n${pseudoPrefill}`,
      );
      return [endTurn, messages];
    }

    // Prepare existing file content (read, clean, extract scratchpad, update state)
    const { fileContent } = await prepareExistingOutputContent(
      outputLocation,
      workspaceState,
      this.logger,
    );

    messages.push(this.createAssistantMessage(fileContent));

    if (hasEndTag(agentSetting, fileContent)) {
      this.logger.debug('End tag detected - skipping continuation');
      endTurn = true;
      return [endTurn, messages];
    }

    this.logger.debug(
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

    if (!isMessageItem(lastMessage)) {
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
        if (isMessageItem(trailingMessage) && trailingMessage.role === 'user') {
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
        `OpenAI Responses reasoning preview (${reasoningItems.length} item(s)): ${thoughtContent.slice(0, K_SLICE)}...`,
      );
    }

    return thoughtContent || null;
  }

  extractToolUse(response: Response): OpenAIResponseToolCall[] {
    const items = response?.output;
    if (!Array.isArray(items)) return [];

    const calls = items.filter(isResponseFunctionToolCallItem);
    if (calls.length === 0) {
      return [];
    }

    return calls.map((call) => ({
      provider: 'openai-response',
      callId: call.call_id,
      name: call.name,
      input: parseToolArguments(call.arguments, this.logger),
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
      return { webSearchResults: [], webFetchResults: [], contentBlocks: [] };
    }

    // Extract content blocks that need to be preserved
    // Only include reasoning items that are immediately followed by web_search_call
    // to satisfy both API requirements (reasoning needs following item, web_search needs preceding reasoning)
    const contentBlocks: (ResponseFunctionWebSearch | ResponseReasoningItem)[] =
      [];
    for (const [i, item] of output.entries()) {
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

    return { webSearchResults, webFetchResults: [], contentBlocks };
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

    // When using previous_response_id (response chaining), the previous response's
    // output items (reasoning, web_search_call, function_call) are already in
    // OpenAI's server-side history. We should only send NEW items (function_call_output).
    // Including them again causes "Duplicate item found" errors.
    const isResponseChaining =
      this.supportsResponseChaining && Boolean(this.previousResponseId);

    if (text && !isResponseChaining) {
      // Only include assistant text when not chaining (it's in previous response)
      messages.push(this.createAssistantMessage(text));
    }

    // Include server tool content blocks (reasoning, web_search_call) from workspace state.
    // These need to be preserved when both server and local tools are in the same response.
    // Reasoning items must be included when web_search_call references them.
    // SKIP when response chaining - these items are already in previous_response_id context.
    // Always clear after processing to prevent accumulation across cycles.
    if (workspaceState?.serverToolContent.contentBlocks.length) {
      if (!isResponseChaining) {
        const openaiBlocks: ResponseInputItem[] =
          workspaceState.serverToolContent.contentBlocks.filter(
            isOpenAIServerToolContent,
          );
        messages.push(...openaiBlocks);
      }
      workspaceState.resetServerToolContent();
    }

    // Always include function_call in messages for persistence and resume.
    // When response chaining is active, the model already has this via previous_response_id,
    // but we still need it in our local array so resumed sessions have complete history.
    // The slicing logic (sentMessages) handles avoiding re-sends during chaining.
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
      uploadedAttachments = await uploadToolAttachments(client, attachments, {
        openRouterRouting: this.isOpenRouterRoutingEnabled(),
        logger: this.logger,
      });
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

    // Build tool result as plain text - JSON wastes tokens
    let combinedText = formatToolResultAsText(
      result,
      finalResult.attachmentSummary,
    );

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
    } else if (attachments.length > 0 && this.canProcessToolResultAttachments) {
      // Inline base64 fallback: when file uploads are unavailable (e.g. OpenRouter)
      // but the model supports visual content, embed images/PDFs directly.
      const {
        parts: inlineParts,
        inlined,
        skipped,
      } = await buildInlineAttachmentParts(attachments, this.logger);
      if (inlineParts.length > 0) {
        // Build summary that accurately reflects which attachments were inlined
        // vs. skipped, so the model only gets a read_file hint for skipped ones.
        const summaryParts: string[] = [];
        if (inlined.length > 0) {
          summaryParts.push(
            formatAttachmentSummary(inlined, 'included-inline'),
          );
        }
        if (skipped.length > 0) {
          summaryParts.push(formatAttachmentSummary(skipped, 'metadata-only'));
        }
        const inlineSummary = summaryParts.join('\n');
        finalResult.attachmentSummary = inlineSummary;
        combinedText = formatToolResultAsText(result, inlineSummary);
        outputPayload = [
          { type: 'input_text', text: combinedText },
          ...inlineParts,
        ];
      } else {
        outputPayload = combinedText;
      }
    } else {
      outputPayload = combinedText;
    }

    const resultMsg: ResponseInputItem.FunctionCallOutput = {
      type: 'function_call_output',
      call_id: call.callId,
      output: outputPayload,
    };

    // Always push both function_call and function_call_output for complete history.
    // The slicing logic (sentMessages) handles avoiding re-sends during response chaining.
    messages.push(callMsg, resultMsg);
    return messages;
  }

  async createUserFollowUpMessages(
    messages: ResponseInputItem[],
    userMessage: string,
  ): Promise<ResponseInputItem[]> {
    messages.push({
      type: 'message',
      role: 'user',
      content: [
        createInputText(userMessage),
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

  override extractAssistantText(
    message: ResponseInputItem,
  ): string | undefined {
    if (!isAssistantTextMessage(message)) {
      return undefined;
    }

    // String content (from createAssistantMessage)
    if (typeof message.content === 'string') {
      return message.content;
    }

    // Array content (input_text history or output_text response parts)
    if (Array.isArray(message.content)) {
      const texts = message.content
        .map((part) => extractTextContentPart(part))
        .filter(filterNotNullish);
      return texts.length > 0 ? texts.join('') : undefined;
    }

    return undefined;
  }

  private getMessageContent(
    item?: ResponseInputItem,
  ): ResponseInputMessageContentList | string | undefined {
    if (!isMessageItem(item)) {
      return undefined;
    }
    return item.content;
  }

  private appendInputText(message: ResponseInputItem, text: string): void {
    if (!isMessageItem(message)) {
      return;
    }

    const content = message.content;

    if (Array.isArray(content)) {
      content.push(createInputText(text));
      return;
    }

    if (typeof content === 'string') {
      message.content = [createInputText(content), createInputText(text)];
      return;
    }

    message.content = [createInputText(text)];
  }

  private appendAssistantText(
    message: ResponseInputItem,
    text: string,
  ): boolean {
    if (!isMessageItem(message) || message.role !== 'assistant') {
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
        .map((part) => extractTextContentPart(part) ?? '')
        .join('');
    }

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
      (m): m is EasyInputMessage | ResponseInputItem.Message =>
        isMessageItem(m) && m.role === 'user',
    );
    if (!lastUserMsg || !Array.isArray(lastUserMsg.content)) return;

    const content = lastUserMsg.content;
    const firstTextPart = content.find((part) => part.type === 'input_text');
    if (firstTextPart?.type === 'input_text') {
      firstTextPart.text = text + firstTextPart.text;
    } else {
      content.unshift(createInputText(text));
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
    if (!mediaFiles.length || !this.capabilities.supportsVision) return;

    const lastUserMsg = messages.findLast(
      (m): m is EasyInputMessage | ResponseInputItem.Message =>
        isMessageItem(m) && m.role === 'user',
    );
    if (!lastUserMsg || !Array.isArray(lastUserMsg.content)) return;

    try {
      const formattedMedia = (await this.createMediaMessage(
        mediaFiles,
      )) as ResponseInputMessageContentList;
      lastUserMsg.content.unshift(...formattedMedia);
    } catch (err) {
      logSdkError(
        this.logger,
        `Error adding media to user message: ${getSdkErrorMessage(err)}`,
        err,
        { operation: 'add media to user message' },
      );
    }
  }
}
