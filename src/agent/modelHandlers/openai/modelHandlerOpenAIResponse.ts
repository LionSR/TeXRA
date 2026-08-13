// Third-party imports
import { ModelProvider } from 'llm-zoo';
import OpenAI, { OpenAIError } from 'openai';
// Exported by openai@6.x via the package's ./lib/* subpath; keep typecheck
// coverage around SDK upgrades because this is not a top-level public helper.
import { addOutputText } from 'openai/lib/ResponsesParser';

// Local imports
import { logProgressStatus, startCompactionActivity } from '@agent/trace';
import { parseToolInput } from '@agent/core/flows/toolUseRound/toolCallParsing';
import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import type { MediaEntry } from '@agent/utils/mediaTypes';
import { K_SLICE } from '@agent/core/constants';
import { OPENAI_CHAT_FINISH } from '@agent/types/StopReasonTypes';
import {
  extractOpenAIWebSearchResults,
  isOpenAIReasoningItem,
  isOpenAIServerToolContent,
  isOpenAIWebSearchCall,
  type ServerToolExtractionResult,
} from '@agent/types/ServerTools';
import type {
  CreateResponseOptions,
  CreateResponseResult,
  ExtractResponseResult,
  OpenAIResponseToolCall,
  TokenCountOptions,
} from '@agent/types/ModelHandlerContracts';
import { attachContextWindowError } from '@common/errors/sdkError/errorMetadata';
import {
  isContextWindowError,
  isPreviousResponseIdError,
  isUserAbort,
  takeTail,
  PARTIAL_TEXT_TAIL_MAX,
} from '@common/errors/sdkError/errorPatterns';
import {
  buildErrorLogData,
  getSdkErrorMessage,
} from '@common/errors/sdkError/providerErrorFormat';
import { handleStreamingFailure } from '@common/errors/sdkError/streamFailure';
import { isGpt5ModelName, isGptFamilyModelName } from '@model/modelNames';
import type {
  OpenAIResponseProviderCapabilities,
  ProviderCapabilityProfile,
} from '@model/providerCapabilities';
import type {
  FileLocation,
  MediaAttachmentKind,
  ToolFileAttachment,
  ToolResult,
} from '@shared/schemas';
import { DEFAULT_CORE_SETTINGS } from '@shared/schemas/coreSettings';
import { clamp, filterNotNullish } from '@utils/core';
import { getWebSocketEnabled } from '@utils/config/providerConfig';
import { getConfig } from '@utils/config/configUtils';

// Local file imports
import { roundedUtilizationPercent } from '../support/contextUtilization';
import { logCompactionEvent } from '../support/compactionLogging';
import { AUXILIARY_MAX_RETRIES } from '../support/auxiliaryRetry';
import { toDataUrl } from '../support/dataUrl';
import {
  classifyMediaEntry,
  unknownMediaCategoryWarning,
} from '../support/mediaClassification';
import { shouldUseOpenRouter } from '../support/ProxyConfigResolver';
import { emitServerToolResult } from '../support/serverToolResultEmission';
import {
  getDeclaredMaxReasoningEffort,
  toOpenAIReasoningEffort,
} from '../support/reasoningEffort';
import {
  computeOpenAIResponsePrice,
  normalizeOpenAIResponseUsage,
} from './openAIUsage';
import { tagOpenAISdkError } from './openAISdkError';
import { normalizeOpenAIResponseError } from './openAIResponseErrors';
import {
  formatAttachmentSummary,
  formatToolResultAsText,
  uploadAndRecordToolAttachments,
} from '../utils/toolAttachmentUtils';
import { toOpenAIResponseTools } from '../toolConversion';
import { OpenAICompatibleModelHandler } from './OpenAICompatibleModelHandler';
import {
  CHAINED_RESPONSE_MAX_OUTPUT_FACTOR,
  CHAINED_RESPONSE_SAFETY_MARGIN_PERCENT,
  CLIENT_COMPACTION_SUMMARY_MAX_TOKENS,
  COMPACTION_USER_PROMPT,
  estimateTokensFromText,
  TOKEN_SAFETY_BUFFER,
  TOOL_USE_SAFETY_BUFFER,
} from '../contextManagementConstants';
import { ResponseStreamProcessor } from './ResponseStreamProcessor';
import { OpenAIResponseWebSocketTransport } from './OpenAIResponseWebSocketTransport';
import { createOpenAIBackgroundRunLifecycle } from './openAIBackgroundRunLifecycle';
import { ServerChainState } from '../support/ServerChainState';
import { isResponseFunctionToolCallItem } from './responsesShapeGuards';
import {
  contentToText,
  createInputText,
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
import type { BackgroundRunLifecycle } from '../support/BackgroundRunLifecycle';

// Third-party imports
import type { InputTokenCountParams } from 'openai/resources/responses/input-tokens';
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
  ResponseRetrieveParamsNonStreaming,
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseInputContent,
  ResponseInputMessageContentList,
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

/**
 * Shape returned by {@link ModelHandlerOpenAIResponse.buildResponseBaseParams}
 * (the BUILD phase): the fields shared by token counting and the final API
 * call, before the EXECUTE phase layers on `max_output_tokens`, `store`, and
 * the transport-specific flags. `input` is narrowed to `ResponseInputItem[]`
 * (rather than `ResponseCreateParamsBase`'s `string | ResponseInput`) because
 * this handler always builds it from `newMessages`, and token counting reads
 * it back as an array.
 */
type OpenAIResponseBaseParams = Omit<
  Pick<
    ResponseCreateParamsBase,
    | 'model'
    | 'input'
    | 'instructions'
    | 'previous_response_id'
    | 'tools'
    | 'reasoning'
  >,
  'input'
> & { input: ResponseInputItem[] };

type ServerToolContentBlock = ResponseFunctionWebSearch | ResponseReasoningItem;

/**
 * store:false (stateless) content blocks: every reasoning item that carries a
 * non-empty `encrypted_content` blob (replayed next turn for reasoning
 * continuity) plus each web_search_call, in output order — so a reasoning item
 * still immediately precedes its following item. A summary-only reasoning item
 * is skipped; replayed empty the stateless endpoint rejects it rather than
 * chaining.
 */
function collectStatelessContentBlocks(
  output: readonly ResponseOutputItem[],
): ServerToolContentBlock[] {
  const blocks: ServerToolContentBlock[] = [];
  for (const item of output) {
    if (isOpenAIReasoningItem(item)) {
      const encrypted = item.encrypted_content;
      if (typeof encrypted === 'string' && encrypted.length > 0) {
        blocks.push(item);
      }
    } else if (isOpenAIWebSearchCall(item)) {
      blocks.push(item);
    }
  }
  return blocks;
}

/**
 * store:true content blocks: only the reasoning item immediately preceding each
 * web_search_call (the API pairing requirement) plus the web_search_call.
 * `previous_response_id` retains everything else server-side.
 */
function collectWebSearchPairedBlocks(
  output: readonly ResponseOutputItem[],
): ServerToolContentBlock[] {
  const blocks: ServerToolContentBlock[] = [];
  for (const [i, item] of output.entries()) {
    if (!isOpenAIWebSearchCall(item)) continue;
    const previous = i > 0 ? output[i - 1] : undefined;
    if (previous && isOpenAIReasoningItem(previous)) {
      blocks.push(previous);
    }
    blocks.push(item);
  }
  return blocks;
}

/**
 * The SDK's response-stream accumulator (`client.responses.stream()`) throws
 * on any event `type` outside its typed union — including heartbeat/keepalive
 * frames a long-running or background response can emit that predate this SDK
 * release adding support for them. That's a transport-level signal, not a
 * failed response, so callers holding a response id should poll by id instead
 * of failing the turn.
 */
function isUnhandledStreamEventError(error: unknown): boolean {
  // The SDK currently exposes this accumulator failure only through its
  // message; keep the prefix check narrow until it publishes a stable code.
  return (
    error instanceof OpenAIError &&
    error.message.startsWith('Unhandled response stream event')
  );
}

function responseRetrieveParamsFor(
  params: ResponseCreateParamsBase,
): ResponseRetrieveParamsNonStreaming | undefined {
  return params.include ? { include: params.include } : undefined;
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
 * THREAD SAFETY: This handler delegates its mutable conversation state to two
 * collaborators — {@link ServerChainState} (the `previous_response_id` chain
 * anchor + sent-messages/token bookkeeping) and {@link BackgroundRunLifecycle}
 * (the pending background-response id + poll/resume choreography) — and
 * neither is thread-safe. Each handler instance (and the collaborators it
 * owns) must be used by a single agent execution at a time. Do not share
 * instances across concurrent invocations.
 */
export class ModelHandlerOpenAIResponse extends OpenAICompatibleModelHandler<
  ResponseInputItem,
  ResponseUsage,
  OpenAIResponseToolCall,
  Response,
  ResponseInputContent
> {
  protected getActiveProviderCapabilities(): ProviderCapabilityProfile | null {
    return null;
  }

  /** Capabilities captured for post-response pricing and usage attribution. */
  protected getUsageProviderCapabilities(): ProviderCapabilityProfile | null {
    return this.getActiveProviderCapabilities();
  }

  private getOpenAIResponseCapabilities():
    OpenAIResponseProviderCapabilities | undefined {
    return this.getActiveProviderCapabilities()?.openAIResponses;
  }

  protected isOpenRouterRoutingEnabled(): boolean {
    return this.activeCredentialRoute === undefined
      ? shouldUseOpenRouter(this.config)
      : this.activeCredentialRoute === 'openrouter';
  }

  public override getEffectiveContextWindow(): number {
    return (
      this.getActiveProviderCapabilities()?.contextWindow ??
      super.getEffectiveContextWindow()
    );
  }

  private getEffectiveInputTokenLimit(): number {
    return (
      this.getActiveProviderCapabilities()?.inputTokenLimit ??
      this.getEffectiveContextWindow()
    );
  }

  /**
   * OpenAI Response API supports file uploads. Reads the ChatGPT-subscription
   * profile when active (that backend disables tool-result file upload);
   * otherwise defaults to true for the base Responses API (#7101 triage:
   * runtime combinator over profile data, not a per-provider override).
   */
  protected override get supportsToolResultFileUpload(): boolean {
    return (
      this.getOpenAIResponseCapabilities()?.supportsToolResultFileUpload ?? true
    );
  }

  /** Whether inline input files can be uploaded before the response request. */
  protected get supportsInlineInputFileUpload(): boolean {
    return (
      this.getOpenAIResponseCapabilities()?.supportsInlineInputFileUpload ??
      true
    );
  }

  /** Whether this backend can retain responses for `previous_response_id`. */
  protected get supportsResponseChaining(): boolean {
    return (
      this.getOpenAIResponseCapabilities()?.supportsResponseChaining ?? true
    );
  }

  /**
   * Whether the backend stores responses server-side (`store: true`). The base
   * OpenAI Responses API does. A stateless backend (the Codex ChatGPT-subscription
   * endpoint forces `store: false`) keeps no server-side reasoning, so it must
   * (a) request `reasoning.encrypted_content` and (b) replay those blobs in the
   * next turn's input for cross-turn reasoning continuity — the store:true path
   * relies on `previous_response_id` instead and must NOT replay them (the items
   * already live server-side, so resending throws "Duplicate item found").
   *
   * Single source for the `store` request field and the encrypted-reasoning gate.
   */
  protected get storesResponsesServerSide(): boolean {
    return (
      this.getOpenAIResponseCapabilities()?.storesResponsesServerSide ?? true
    );
  }

  /**
   * Override streaming config to disable streaming when background mode is enabled.
   * Background responses use polling for completed results, incompatible with streaming.
   */
  public override getStreamingConfig(): boolean {
    if (this.getOpenAIResponseCapabilities()?.streaming === 'forced') {
      return true;
    }
    return !this.isBackgroundModeActive() && super.getStreamingConfig();
  }

  /**
   * Check if background mode is active for this handler.
   * Background mode is enabled when this handler supports it, the config
   * toggle is on, and this model/agent is eligible for background execution.
   *
   * Single source of truth for the background-mode decision: the request path
   * (`createResponseImpl`), `getStreamingConfig`, and `storesResponsesServerSide`
   * all route through this method, so provider-profile policy (e.g. the Codex
   * subscription profile forcing it off) takes effect on the actual request, not
   * just on this predicate.
   */
  public override isBackgroundModeActive(): boolean {
    if (this.getOpenAIResponseCapabilities()?.backgroundMode === 'disabled') {
      return false;
    }
    return (
      this.backgroundModeSupported &&
      this.isBackgroundModeToggleEnabled() &&
      this.isBackgroundModeEligible()
    );
  }

  private isBackgroundModeToggleEnabled(): boolean {
    return getConfig<boolean>('texra.model.useBackgroundResponses', true);
  }

  protected override backgroundModeSupported = true;

  /**
   * Reads the ChatGPT-subscription profile when active (that backend does
   * support compaction, just not via the stateful endpoint — see
   * {@link storesResponsesServerSide} and `compactConversationClientSide`);
   * otherwise falls back to whether this request is routed through
   * OpenRouter, which implements its own compaction path via
   * `ModelHandlerOpenRouterNative` instead.
   */
  override get supportsManualCompaction(): boolean {
    return (
      this.getOpenAIResponseCapabilities()?.supportsManualCompaction ??
      !this.isOpenRouterRoutingEnabled()
    );
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

  /** The `previous_response_id` chain anchor + conversation bookkeeping. See
   *  {@link ServerChainState} for the narrow interface this handler uses
   *  instead of mutating chain fields directly. */
  private readonly chainState = new ServerChainState();

  /** Pending background-response id + poll/resume choreography. See
   *  {@link BackgroundRunLifecycle} for the narrow interface this handler
   *  uses instead of mutating background-response fields directly. */
  private readonly backgroundLifecycle: BackgroundRunLifecycle<
    OpenAI,
    Response,
    ResponseRetrieveParamsNonStreaming
  > = createOpenAIBackgroundRunLifecycle({
    logger: () => this.logger,
    provider: this.config.provider,
  });

  /** Internal compaction recovery already attempted during this public call. */
  private compactionRetrySource: 'threshold' | 'overflow' | null = null;

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
      emitWebSearchResult: (result) =>
        emitServerToolResult(this.logger, this.progressViewEnabled, result),
      logger: this.logger,
    });
  }

  /**
   * Whether WebSocket transport is enabled for this handler.
   *
   * WebSocket transport connects directly to the OpenAI Responses API via the
   * official SDK and is incompatible with any non-default base URL, including:
   * - Server-side keys relay (Supabase Edge Function)
   * - OpenRouter routing
   * - Custom per-provider or per-model endpoints
   *
   * Also incompatible with background mode (polling-based, doesn't benefit
   * from persistent connection).
   *
   * `protected` so a subclass on a non-default endpoint (e.g. the Codex
   * backend) can opt into trying WebSocket against its own base URL.
   */
  protected isWebSocketModeEnabled(): boolean {
    if (this.getOpenAIResponseCapabilities()?.webSocket === 'global-toggle') {
      return getWebSocketEnabled();
    }
    return getWebSocketEnabled() && this.getBaseUrl() === null;
  }

  /** Release all resources held by this handler (WebSocket, keepalive). */
  override dispose(): void {
    this.wsTransport?.dispose();
  }

  /**
   * Finalize response state after a successful API call, and build the result
   * every transport path returns. Updates the chain anchor, conversation state,
   * and token counts, then surfaces {@link ResponseFinalizeContext.compactedMessages}
   * so a finalized-but-not-returned (or returned-but-not-finalized) response is
   * unrepresentable.
   */
  private finalizeResponse(
    response: Response,
    ctx: ResponseFinalizeContext,
  ): CreateResponseResult<Response, ResponseInputItem> {
    // Apply compaction state if compaction happened this call
    if (ctx.compactedThisCall) {
      this.applyCompactionState();
    }

    // Only chain from completed responses with usage data. Missing usage
    // signals streaming instability; chaining from such responses has produced
    // stale-id and token-count drift in practice, so treat it the same as a
    // non-completed status.
    // Use a typeof check rather than truthiness so a legitimate 0 wouldn't
    // be misclassified.
    const hasInputTokens = typeof response.usage?.input_tokens === 'number';
    const safeToChain =
      this.supportsResponseChaining &&
      response.status === 'completed' &&
      hasInputTokens;
    if (safeToChain) {
      this.chainState.recordChained(response.id, ctx.effectiveMessagesLength);
    } else {
      const errorDetail =
        response.error?.message ?? response.incomplete_details?.reason;
      this.logger.debug('Response not safe for chaining', {
        data: {
          responseId: response.id,
          status: response.status,
          hasUsage: !!response.usage,
          hasInputTokens,
          errorDetail,
        },
      });
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
      // requires a chain anchor to be set).
      this.chainState.invalidateChain();
    }

    // Clear any pending background response ID - a successful finalization means
    // any previous pending ID is stale and should not be resumed
    this.backgroundLifecycle.clearPending();

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
      this.chainState.setCumulativeInputTokens(response.usage.input_tokens);
    } else {
      // Not silent degradation: the chain anchor was already refused above
      // (hasInputTokens gates safeToChain), this records that the context
      // baseline could not be advanced for this turn.
      this.logger.debug(
        'Response usage missing input_tokens; context usage not tracked',
        {
          data: {
            responseId: response.id,
            responseStatus: response.status,
            hasUsage: !!response.usage,
          },
        },
      );
    }

    // Reset compacted flag after successful request (ready for next compaction if needed)
    this.chainState.clearSendAllNextTurn();

    return { response, updatedMessages: ctx.compactedMessages };
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
    return Math.floor((percent / 100) * this.getEffectiveInputTokenLimit());
  }

  /**
   * Whether this route can compact at all: compaction is supported, not
   * routed through OpenRouter (which may not support compaction), and there
   * is prior conversation to compact. Shared by the manual/requested flag
   * path and the live-count decision in {@link createResponseImpl}.
   */
  private canCompactRoute(): boolean {
    return (
      this.supportsManualCompaction &&
      !this.isOpenRouterRoutingEnabled() &&
      this.chainState.getCumulativeInputTokens() > 0
    );
  }

  /**
   * Check if the conversation should be compacted.
   *
   * Automatic compaction is decided by the live pre-flight token count in
   * {@link createResponseImpl} — one measurement of the CURRENT request owns
   * the decision (it mints its own compaction request and retries
   * internally). The cumulative-usage threshold below is only the fallback
   * decision for models that cannot count tokens pre-flight; the cumulative
   * figure comes from the PREVIOUS successful response and goes stale the
   * moment a single turn adds a large input.
   */
  private shouldCompact(): boolean {
    if (!this.supportsManualCompaction) {
      this.consumeCompactionRequest();
      return false;
    }

    // Manual/requested compaction bypasses threshold checks.
    // The flag is NOT cleared here - the caller clears it after compaction
    // is attempted to preserve the request across retries.
    if (this.isCompactionRequested()) {
      return this.canCompactRoute();
    }

    if (this.supportsTokenCounting) {
      // The live pre-flight count decides for counting-capable models.
      // Deliberate tradeoff: if the count API soft-fails for a turn, that
      // turn has no automatic compaction trigger at all (the stale cumulative
      // figure is not consulted) — the API enforces the window, and an
      // API-side overflow still recovers via handleCreateResponseError's
      // compact-and-retry. Costs one extra round-trip in that rare failure
      // mode; keeps the live count the single decision owner.
      return false;
    }

    const thresholdPercent = this.getCompactionThresholdPercent();
    if (thresholdPercent <= 0) {
      return false;
    }
    if (this.isOpenRouterRoutingEnabled()) {
      // Same exclusion as canCompactRoute(): OpenRouter conversations compact
      // through ModelHandlerOpenRouterNative. Nothing is logged here because
      // the capability gate above already returns for every OpenRouter-routed
      // request — no provider profile grants supportsManualCompaction on that
      // route — so this only pins the invariant.
      return false;
    }
    const threshold = this.getCompactionTokenThreshold();
    return this.chainState.getCumulativeInputTokens() > threshold;
  }

  /**
   * Result from compactConversation including messages and state updates.
   * State updates are returned but not applied - caller is responsible for
   * applying them only after successful API call to prevent stale state on retry.
   *
   * `sourceMessages` is the exact `messages` array reference compaction ran
   * against — it's how {@link createResponseImpl} recognizes a same-turn retry
   * (PocketFlow's `Node._exec` reuses the same `prepRes`, hence the same
   * `messages` reference, across retry attempts) and reuses this result
   * instead of re-running compaction. That reuse is what keeps this payload's
   * retry lifetime matched to {@link ServerChainState.clearChainForCompaction}'s
   * anchor clear, which already survives retries permanently — without it, the
   * anchor clear alone would survive while this payload got wiped every
   * attempt, forcing a redundant re-compaction on each retry.
   *
   * Reference equality alone cannot distinguish a same-turn retry from the
   * next turn, since `ModelInvocationNode.post()` mutates the shared messages
   * array in place (same reference survives across turns too). The field is
   * therefore also cleared unconditionally by {@link applyCompactionState} on
   * every successful call, so it can never outlive the turn it was computed
   * for; the `sourceMessages` check only ever matters while an attempt from
   * this same turn is still retrying after a failure.
   */
  private compactionResult?: {
    compactedMessages: ResponseInputItem[];
    tokensAfter: number;
    sourceMessages: ResponseInputItem[];
    sourceFingerprint: string;
  };

  /**
   * Get the appropriate safety buffer for token validation.
   * - Chained responses (previous_response_id): proportional margin (5% of context window)
   *   because the pre-flight token count can significantly undercount server-side context
   *   (reasoning tokens, framing overhead). A flat buffer is insufficient at high utilization.
   * - Tool-use mode: larger flat buffer (2000) for counting discrepancies
   * - Otherwise: small buffer (10) for exact counting
   */
  private getTokenSafetyBuffer(): number {
    if (this.supportsResponseChaining && this.chainState.hasAnchor()) {
      // Proportional margin scales with context window size - critical at high utilization
      // where even a small percentage error can cause overflow.
      const proportionalMargin = Math.floor(
        this.getEffectiveContextWindow() *
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
    if (!this.supportsResponseChaining || !this.chainState.hasAnchor()) {
      return maxOutputTokens;
    }

    const budgeted = Math.max(
      1,
      Math.floor(maxOutputTokens * CHAINED_RESPONSE_MAX_OUTPUT_FACTOR),
    );
    if (budgeted !== maxOutputTokens) {
      this.logger.debug('Applied chained max_output_tokens budget', {
        data: { before: maxOutputTokens, after: budgeted },
      });
    }
    return budgeted;
  }

  /**
   * Compact the conversation to reduce context size via OpenAI's stateful
   * `/responses/compact` endpoint, which replaces prior assistant messages,
   * tool calls, and results with a single encrypted compaction item.
   *
   * Only usable when {@link storesResponsesServerSide} is true — the compact
   * endpoint acts on a stored server-side response, which a `store: false`
   * backend (the ChatGPT-subscription/Codex profile) never has. That backend
   * is compacted via {@link compactConversationClientSide} instead, a
   * distinct code path that never calls this endpoint.
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
    const tokensBefore = this.chainState.getCumulativeInputTokens();
    const contextWindow = this.getEffectiveContextWindow();
    const utilizationBefore = roundedUtilizationPercent(
      tokensBefore,
      contextWindow,
    );

    this.logger.debug('Compacting conversation', {
      data: {
        inputTokens: tokensBefore,
        utilizationPercent: utilizationBefore,
        contextWindow,
      },
    });

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

    const activity = startCompactionActivity(this.logger);
    try {
      const compactedResponse: CompactedResponse = await client
        .withOptions({ maxRetries: AUXILIARY_MAX_RETRIES })
        .responses.compact(compactParams, { signal });

      // Note: SDK types CompactedResponse.output as ResponseOutputItem[], but the
      // compact endpoint returns ResponseInputItem[] suitable for re-submission.
      const compactedMessages =
        compactedResponse.output as unknown as ResponseInputItem[];
      if (compactedMessages.length === 0) {
        this.logger.warn('Compaction returned no reusable context, skipping');
        this.compactionResult = undefined;
        activity.finish('skipped');
        return messages;
      }

      // CRITICAL: Clear the chain anchor now that compaction has replaced the
      // server-side history. Must happen BEFORE estimateTokenCount — otherwise the
      // count would include the full previous conversation on top of the compacted
      // messages, massively inflating the result.
      this.chainState.clearChainForCompaction();

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
          'Post-compaction token counting failed; falling back to output_tokens',
          {
            data: buildErrorLogData(err, {
              operation: 'post-compaction token counting',
            }),
          },
        );
        // NOTE: It's unclear what output_tokens represents exactly for the compact
        // endpoint — it may be the generation cost rather than the reusable content
        // size. This fallback is a best-effort estimate until OpenAI clarifies.
        tokensAfter = compactedResponse.usage.output_tokens;
      }

      logCompactionEvent({
        logger: this.logger,
        tokensBefore,
        tokensAfter,
        contextWindow,
        details: `OpenAI Responses API compaction: ${compactedResponse.output.length} items`,
      });

      // Store compacted messages for use in this request.
      // Mark as pending compaction - state will be finalized after successful API call.
      // This prevents stale state if API call fails and needs retry.
      this.compactionResult = {
        compactedMessages,
        tokensAfter,
        sourceMessages: messages,
        sourceFingerprint: this.messagesTailFingerprint(messages),
      };

      activity.finish('completed');
      return compactedMessages;
    } catch (err) {
      const userAborted = isUserAbort(err);
      activity.finish(userAborted ? 'cancelled' : 'failed');
      signal?.throwIfAborted();
      if (userAborted) throw err;
      this.logger.warn(
        `Compaction failed, continuing with original messages: ${getSdkErrorMessage(err)}`,
        {
          data: buildErrorLogData(err, { operation: 'compact conversation' }),
        },
      );
      this.compactionResult = undefined;
      return messages;
    }
  }

  /**
   * Client-side compaction fallback for backends that cannot use the
   * stateful `/responses/compact` endpoint (see {@link compactConversation})
   * because they don't store responses server-side — the ChatGPT-subscription
   * (Codex) backend forces `store: false` on every request, so there is no
   * stored response for the compact endpoint to act on (#7213). Summarizes
   * the conversation locally via a throwaway system-prompt-swap call to the
   * same Responses API, then resends a single summary message instead of the
   * full history. Reuses the `ModelHandler.runClientCompaction` scaffold
   * already shared by the Chat Completions, OpenRouter-native, and Google
   * Interactions handlers.
   *
   * The summarization call always streams: this path only ever runs under a
   * profile that also forces `streaming: 'forced'` (see
   * `getStreamingConfig`), and a non-streaming request would receive an SSE
   * body it can't parse.
   *
   * State updates are stored in compactionResult but NOT applied immediately,
   * mirroring {@link compactConversation} — the caller applies them only
   * after a successful API call so a failed retry doesn't see stale state.
   *
   * @param client - OpenAI client instance
   * @param messages - Current conversation messages
   * @param signal - Optional abort signal
   * @returns The compacted messages array, or original messages if compaction fails
   */
  private async compactConversationClientSide(
    client: OpenAI,
    messages: ResponseInputItem[],
    signal?: AbortSignal,
  ): Promise<ResponseInputItem[]> {
    const tokensBefore = this.chainState.getCumulativeInputTokens();
    const contextWindow = this.getEffectiveContextWindow();

    this.logger.debug('Compacting conversation (client-side)', {
      data: {
        inputTokens: tokensBefore,
        utilizationPercent: roundedUtilizationPercent(
          tokensBefore,
          contextWindow,
        ),
        contextWindow,
      },
    });

    const { compactedMessages, didCompact } = await this.runClientCompaction(
      messages,
      tokensBefore,
      async (conversationMessages, compactionSystemPrompt) => {
        const stream = await client
          .withOptions({ maxRetries: AUXILIARY_MAX_RETRIES })
          .responses.stream(
            {
              model: this.config.fullName,
              instructions: compactionSystemPrompt,
              input: [
                ...conversationMessages,
                {
                  type: 'message',
                  role: 'user',
                  content: [createInputText(COMPACTION_USER_PROMPT)],
                },
              ],
              max_output_tokens: CLIENT_COMPACTION_SUMMARY_MAX_TOKENS,
              store: this.storesResponsesServerSide,
              ...(this.capabilities.supportsReasoning && {
                reasoning: { effort: 'low' },
              }),
            },
            { signal },
          );

        // The ChatGPT-subscription (Codex) backend strips `max_output_tokens`
        // at the wire (it answers `400 Unsupported parameter: max_output_tokens`
        // — see rewriteCodexRequestBody), so the summary cap cannot be enforced
        // server-side on this path, and this client-side path only ever runs for
        // that stateless profile. Enforce the cap locally instead: stop
        // consuming and abort the request once the streamed summary reaches the
        // cap, bounding both the resent summary size and the summarization
        // turn's latency. Under a backend that does honor `max_output_tokens`
        // the stream ends first, so this ceiling is never hit.
        let streamedText = '';
        for await (const event of stream) {
          if (event.type !== 'response.output_text.delta') continue;
          streamedText += event.delta;
          if (
            estimateTokensFromText(streamedText) >=
            CLIENT_COMPACTION_SUMMARY_MAX_TOKENS
          ) {
            stream.abort();
            return {
              summaryText: streamedText.trim(),
              outputTokens: estimateTokensFromText(streamedText),
            };
          }
        }

        // Prefer the text accumulated from the deltas above: the Codex backend
        // leaves the completed response's `output`/`output_text` empty (the same
        // reason executeStreamingPath rebuilds from `output_text.delta`), so
        // extracting only from finalResponse() would yield an empty summary and
        // silently skip compaction. Fall back to finalResponse() extraction only
        // when no text was streamed.
        const summaryResponse = await stream.finalResponse();
        const summaryText =
          streamedText.trim() ||
          this.extractResponse(summaryResponse, '').text.trim();
        return {
          summaryText,
          outputTokens:
            summaryResponse.usage?.output_tokens ??
            estimateTokensFromText(summaryText),
        };
      },
      (summary): ResponseInputItem => ({
        type: 'message',
        role: 'user',
        content: [createInputText(summary)],
      }),
    );

    if (!didCompact) {
      this.compactionResult = undefined;
      return compactedMessages;
    }

    // CRITICAL: clear now, before this handler builds the next request —
    // the compacted messages replace the discarded history, so a stale
    // previousResponseId must never be resent alongside them (same reason as
    // compactConversation()'s stateful path).
    this.chainState.clearChainForCompaction();
    this.compactionResult = {
      compactedMessages,
      // Bookkeeping must reflect the INPUT cost of resending the compacted
      // payload next turn (system items + the summary message with its
      // "[Previous conversation summary]" prefix), not the OUTPUT cost of
      // generating the summary — mirroring the stateful path, which counts the
      // compacted items' input tokens. `applyTokenCountFailureFallback()`
      // prefers this value over the chain's cumulative count, and on the Codex
      // profile it is load-bearing: token counting
      // is unavailable and `failWhenFallbackOutputBudgetIsReduced` fails the
      // request locally when the estimate + budget overflow the context window,
      // so an output-token underestimate could let through a request the backend
      // then rejects.
      tokensAfter: this.estimateResentInputTokens(compactedMessages),
      sourceMessages: messages,
      sourceFingerprint: this.messagesTailFingerprint(messages),
    };
    return compactedMessages;
  }

  /**
   * Estimate the input-token cost of resending the compacted payload. The
   * ChatGPT-subscription (Codex) profile — the only backend that reaches
   * {@link compactConversationClientSide} — exposes no token-counting endpoint
   * (`supportsTokenCounting: false`), so {@link estimateTokenCount} throws and
   * the stateful path's exact API count is unavailable; fall back to a
   * text-length heuristic over exactly what gets resent.
   */
  private estimateResentInputTokens(messages: ResponseInputItem[]): number {
    // Flatten message content (string or typed parts) to plain text;
    // non-text items contribute nothing to the estimate.
    const text = messages
      .map((message) =>
        contentToText((message as { content?: unknown }).content, ''),
      )
      .join('\n');
    return Math.max(1, estimateTokensFromText(text));
  }

  /**
   * Apply compaction state updates after successful API call.
   * Updates conversation state flags.
   *
   * Note: cumulativeInputTokens is NOT updated here - it will be set from
   * response.usage.input_tokens after the API call to reflect actual usage.
   */
  private applyCompactionState(): void {
    if (!this.compactionResult) return;

    // Reset sent messages counter and mark as compacted so subsequent
    // requests know to send all messages.
    this.chainState.markCompactionApplied();

    // Note: the chain anchor is already cleared immediately after compaction
    // (before API call) to avoid "No tool output found" errors.

    // Clear compactionResult now that this successful call has consumed it.
    // This runs only on success (finalizeResponse's success paths), never on
    // a failed attempt that will be retried, so it can't be confused with the
    // same-turn-retry cache check in createResponseImpl(). Clearing here
    // (rather than relying on `sourceMessages !== messages` reference
    // (in)equality) matters because PocketFlow's ModelInvocationNode.post()
    // mutates `shared.messages` in place via replaceMessagesInPlace
    // (length=0 + push), so the array reference is often IDENTICAL across
    // turns, not just across retries of the same turn. Leaving compactionResult
    // set here would make the next turn's genuinely different input look like
    // a same-turn retry, resend this turn's stale compactedMessages, and
    // silently drop everything appended since (tool outputs, new user turns).
    this.compactionResult = undefined;
  }

  /** Reset conversation bookkeeping when starting a new session. */
  async initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: FileLocation[],
    systemPrompt?: string,
  ): Promise<ResponseInputItem[]> {
    this.chainState.resetChainForNewSession();
    this.backgroundLifecycle.clearPending();
    this.wsTransport?.dispose();

    const messages: ResponseInputItem[] = [];

    if (systemPrompt) {
      // Every runnable model accepts a system-role prompt; only the retired
      // o1-mini / o1-preview ever needed the 'user'-role fallback.
      const systemMessage: ResponseInputItem.Message = {
        type: 'message',
        role: 'system',
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
      const mediaContent = await this.createMediaForRound(
        mediaFiles,
        'initial',
      );
      userContent.push(...mediaContent);
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
      const formattedMediaContent = await this.createMediaForRound(
        mediaFiles,
        'followUp',
      );
      roundContent.push(...formattedMediaContent);
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
      const classification = classifyMediaEntry(media);

      if (classification === 'image' && mediaType.startsWith('image/')) {
        return [
          createInputText(`Image: ${media.file_name}`),
          {
            type: 'input_image',
            image_url: toDataUrl(mediaType, media.data),
            detail: 'high',
          },
        ];
      }

      // Audio input is documented but not functional in the Responses API
      // See: https://community.openai.com/t/audio-input-not-working-when-migrating-from-completions-to-responses/1364108/3
      // See: https://github.com/openai/openai-node/commit/9909fef596280fc16174679d97c3e81543c68646
      // TODO: Re-enable when OpenAI makes audio input functional
      if (classification === 'audio') {
        this.logger.warn(
          `Audio input received (${media.file_name}) but the Responses API does not currently support audio input. Skipping.`,
        );
        return [];
      }

      if (classification === 'pdf') {
        return [
          createInputText(`Document: ${media.file_name}`),
          {
            type: 'input_file',
            file_data: toDataUrl(mediaType, media.data),
            filename: media.file_name,
          },
        ];
      }

      if (classification === 'image') {
        this.logger.warn(
          `Skipping media ${media.file_name} with unsupported image MIME type: ${mediaType}`,
        );
        return [];
      }

      this.logger.warn(unknownMediaCategoryWarning(media));
      return [];
    });
  }

  /**
   * Whether this handler supports native token counting via API.
   * When true, the handler will use OpenAI's /responses/input_tokens endpoint
   * for exact token counts instead of heuristics.
   */
  override get supportsTokenCounting(): boolean {
    return (
      this.getOpenAIResponseCapabilities()?.supportsTokenCounting ??
      !this.isOpenRouterRoutingEnabled()
    );
  }

  /**
   * Some Responses-compatible routes deliberately omit `max_output_tokens` from
   * the wire request. When token counting is unavailable, a fallback estimate
   * can detect that the requested output budget would exceed the context window,
   * but such routes cannot enforce a reduced budget. They should fail locally
   * instead of sending a request that the backend will reject opaquely.
   */
  protected shouldFailWhenFallbackOutputBudgetIsReduced(
    inputEstimate: number,
    _maxOutputTokens: number,
    contextWindow: number,
    buffer: number,
  ): boolean {
    if (
      !this.getOpenAIResponseCapabilities()
        ?.failWhenFallbackOutputBudgetIsReduced
    ) {
      return false;
    }
    return inputEstimate + buffer >= contextWindow;
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
        this.chainState.getAnchorId() && {
          previous_response_id: this.chainState.getAnchorId(),
        }),
      ...(options?.systemPrompt && { instructions: options.systemPrompt }),
      ...(options?.tools?.length && {
        tools: options.tools as InputTokenCountParams['tools'],
      }),
    };

    const tokenCount = await client
      .withOptions({ maxRetries: AUXILIARY_MAX_RETRIES })
      .responses.inputTokens.count(
        countParams,
        options?.signal ? { signal: options.signal } : undefined,
      );

    this.logger.debug(`Token count of message: ${tokenCount.input_tokens}`);
    return tokenCount.input_tokens;
  }

  private applyTokenCountFailureFallback(maxOutputTokens: number): number {
    // Best available estimate of current input tokens: the post-compaction
    // figure when compaction just happened, else the previous response's
    // cumulative count, else 0 on the first turn.
    const inputEstimate =
      this.compactionResult?.tokensAfter ??
      this.chainState.getCumulativeInputTokens();
    if (inputEstimate <= 0) return maxOutputTokens;

    const buffer = this.getTokenSafetyBuffer();
    const inputTokenLimit = this.getEffectiveInputTokenLimit();
    if (inputEstimate + buffer >= inputTokenLimit) {
      const error = new Error(
        `Token estimate (${inputEstimate}) + safety buffer (${buffer}) exceeds route input limit (${inputTokenLimit}).`,
      );
      attachContextWindowError(error);
      throw error;
    }
    const contextWindow = this.getEffectiveContextWindow();
    const bufferedMaxTokens = contextWindow - inputEstimate - buffer;
    const validation = this.validateTokenLimits(
      inputEstimate,
      maxOutputTokens,
      contextWindow,
      buffer,
    );
    const capped = clamp(
      Math.min(validation.adjustedMaxTokens, bufferedMaxTokens),
      0,
      maxOutputTokens,
    );
    if (capped === maxOutputTokens) return maxOutputTokens;

    if (
      this.shouldFailWhenFallbackOutputBudgetIsReduced(
        inputEstimate,
        maxOutputTokens,
        contextWindow,
        buffer,
      )
    ) {
      const error = new Error(
        `Token estimate (${inputEstimate}) + output budget (${maxOutputTokens}) + safety buffer (${buffer}) exceeds context window (${contextWindow}), and this route cannot enforce a reduced output budget locally.`,
      );
      // Tag with a typed marker so isContextWindowError() recognizes this
      // internal case without depending on the message wording above, which
      // this method (not a third-party provider) owns and may reword freely.
      attachContextWindowError(error);
      throw error;
    }

    this.logger.debug('Fallback: adjusting max_output_tokens', {
      data: { before: maxOutputTokens, after: capped, inputEstimate },
    });
    this.logMaxTokensReduced({
      tokensBefore: inputEstimate,
      tokensBeforeIsEstimate: true,
      contextWindow,
      utilizationPercent: validation.utilizationPercent,
      originalMaxTokens: maxOutputTokens,
      reducedMaxTokens: capped,
      details:
        'OpenAI Response: max_output_tokens reduced from fallback estimate',
    });
    return capped;
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

  /**
   * Single-turn guard: concurrent callers would race on the chain-state
   * collaborator's anchor and conversation bookkeeping.
   */
  protected override withCreateResponseGuard<T>(
    run: () => Promise<T>,
  ): Promise<T> {
    return this.withSingleTurnGuard('modelHandlerOpenAIResponse', () => {
      this.compactionRetrySource = null;
      return run();
    });
  }

  override get supportsForcedToolChoice(): boolean {
    return true;
  }

  /**
   * Phase 1: BUILD - Construct the shared base request parameters (including
   * the reasoning config) used by both token counting and the API call.
   * Extracted from {@link createResponseImpl} verbatim.
   */
  private buildResponseBaseParams(args: {
    newMessages: ResponseInputItem[];
    systemPrompt: string | undefined;
    convertedTools: ReturnType<typeof toOpenAIResponseTools> | undefined;
  }): OpenAIResponseBaseParams {
    const { newMessages, systemPrompt, convertedTools } = args;

    const rawEffort = this.capabilities.supportsReasoning
      ? this.getEffectiveReasoningEffort()
      : undefined;
    const reasoningEffort = rawEffort
      ? toOpenAIReasoningEffort(
          rawEffort,
          getDeclaredMaxReasoningEffort(this.config.capabilities),
        )
      : undefined;
    // Pro-mode registry entries (GPT-5.6 Pro) share the base model's wire id
    // and select pro execution via `reasoning.mode` on the request.
    const reasoningMode = this.capabilities.reasoningMode;
    const reasoning: Reasoning | undefined =
      reasoningEffort || reasoningMode
        ? {
            ...(reasoningEffort && { effort: reasoningEffort }),
            ...(reasoningMode && { mode: reasoningMode }),
          }
        : undefined;

    return {
      model: this.config.fullName,
      input: newMessages,
      ...(systemPrompt && { instructions: systemPrompt }),
      ...(this.supportsResponseChaining &&
        this.chainState.getAnchorId() && {
          previous_response_id: this.chainState.getAnchorId(),
        }),
      ...(convertedTools?.length && { tools: convertedTools }),
      ...(reasoning && { reasoning }),
    };
  }

  /**
   * Phase 4: EXECUTE - Build the final request params and dispatch through
   * the WebSocket / streaming / non-streaming transport paths, including the
   * shared error recovery for all three. Extracted from
   * {@link createResponseImpl} verbatim; it is the tail of that method, so it
   * returns the final {@link CreateResponseResult} directly.
   */
  private async dispatchOpenAIResponseExecution(args: {
    baseParams: OpenAIResponseBaseParams;
    maxOutputTokens: number;
    convertedTools: ReturnType<typeof toOpenAIResponseTools> | undefined;
    finalTool: CreateResponseOptions<ResponseInputItem, OpenAI>['finalTool'];
    useBackgroundResponses: boolean;
    useWebSocket: boolean;
    useStreaming: boolean;
    temperature: number;
    client: OpenAI;
    signal: AbortSignal | undefined;
    effectiveMessages: ResponseInputItem[];
    compactedThisCall: boolean;
    compactedMessages: ResponseInputItem[] | undefined;
    requestOptions: CreateResponseOptions<ResponseInputItem, OpenAI>;
  }): Promise<CreateResponseResult<Response, ResponseInputItem>> {
    const {
      baseParams,
      maxOutputTokens,
      convertedTools,
      finalTool,
      useBackgroundResponses,
      useWebSocket,
      useStreaming,
      temperature,
      client,
      signal,
      effectiveMessages,
      compactedThisCall,
      compactedMessages,
      requestOptions,
    } = args;

    // Phase 4: EXECUTE - Build final params and make the API call
    const parallelToolCalls = getConfig<boolean>(
      'texra.model.openaiParallelToolCalls',
      DEFAULT_CORE_SETTINGS.model.openaiParallelToolCalls,
    );
    const params: ResponseCreateParamsBase = {
      ...baseParams,
      max_output_tokens: maxOutputTokens,
      store: this.storesResponsesServerSide,
      ...(this.config.serviceTier === 'fast' && {
        service_tier: 'fast',
      }),
      ...(convertedTools?.length && {
        tool_choice: finalTool
          ? ({ type: 'function', name: finalTool.name } as const)
          : ('auto' as const),
        parallel_tool_calls: parallelToolCalls,
      }),
    };

    if (useBackgroundResponses) {
      this.logger.debug(
        'Submitting OpenAI Responses request in background mode.',
        {
          data: {
            model: this.config.fullName,
            previousResponseId: this.chainState.getAnchorId() ?? undefined,
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

    // Stateless (store:false) backends keep no server-side reasoning, so request
    // encrypted reasoning blobs to replay in the next turn's input for cross-turn
    // reasoning continuity (matching the Codex CLI / OpenCode). The store:true
    // path retains reasoning via previous_response_id and must not replay it.
    if (
      !this.storesResponsesServerSide &&
      this.capabilities.supportsReasoning
    ) {
      params.include = [
        ...(params.include ?? []),
        'reasoning.encrypted_content',
      ];
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
        requestOptions,
        compactedThisCall,
      );
    }
  }

  protected override async createResponseImpl(
    options: CreateResponseOptions<ResponseInputItem, OpenAI>,
  ): Promise<CreateResponseResult<Response, ResponseInputItem>> {
    const {
      client,
      messages,
      temperature,
      systemPrompt,
      signal,
      tools,
      finalTool,
    } = options;

    if (this.backgroundLifecycle.hasPendingResume()) {
      const resumeContext: ResponseFinalizeContext = {
        effectiveMessagesLength:
          this.compactionResult?.compactedMessages.length ?? messages.length,
        compactedThisCall: this.compactionResult !== undefined,
        compactedMessages: this.compactionResult?.compactedMessages,
      };
      try {
        const resumed = await this.tryResumeBackgroundIfPending(
          client,
          signal,
          resumeContext,
        );
        if (resumed) return resumed;
      } catch (error) {
        return await this.handleCreateResponseError(
          error,
          options,
          resumeContext.compactedThisCall,
        );
      }
    }

    // Clear any stale compaction result from a genuinely different input. A
    // same-turn retry (PocketFlow's Node._exec reuses the same prepRes, hence
    // the same `messages` reference, across retry attempts) keeps its cached
    // result below instead — otherwise the chain anchor that compaction
    // already cleared on chainState (which survives retries permanently)
    // would outlive this payload, forcing a redundant re-compaction on every
    // retry. A retained pending response is handled above before this state
    // can be discarded.
    //
    // This reference check alone is NOT sufficient to distinguish a same-turn
    // retry from the next turn, because PocketFlow's ModelInvocationNode.post()
    // mutates `shared.messages` in place, so the reference is often identical
    // across turns too. The primary guard against cross-turn reuse is
    // applyCompactionState() clearing compactionResult on every successful
    // call; this line only ever matters while a compaction from a still-in-
    // flight (unsuccessful) attempt is pending.
    if (
      this.compactionResult !== undefined &&
      (this.compactionResult.sourceMessages !== messages ||
        this.compactionResult.sourceFingerprint !==
          this.messagesTailFingerprint(messages))
    ) {
      // Reference or content changed — a follow-up appended after a failed
      // turn mutates the SAME array in place, so identity alone would replay
      // a stale pre-follow-up payload and silently drop the user's message.
      this.compactionResult = undefined;
    }

    // Route through isBackgroundModeActive() so provider-profile policy actually
    // gates the request, not just the predicate.
    const useBackgroundResponses = this.isBackgroundModeActive();
    const streamingToggleEnabled = useBackgroundResponses
      ? super.getStreamingConfig()
      : this.getStreamingConfig();
    const useStreaming = streamingToggleEnabled && !useBackgroundResponses;
    const useWebSocket =
      this.isWebSocketModeEnabled() && !useBackgroundResponses;

    if (
      !useBackgroundResponses &&
      this.isBackgroundModeToggleEnabled() &&
      this.isBackgroundModeEligible()
    ) {
      if (this.getOpenAIResponseCapabilities()?.backgroundMode === 'disabled') {
        this.logger.debug(
          'Background mode toggle is enabled but the active provider profile disables background execution. Proceeding without background mode.',
        );
      } else {
        this.logger.debug(
          'Background mode toggle is enabled but this handler does not support background execution. Proceeding without background mode.',
        );
      }
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
    const reusableCompaction = this.compactionResult;
    if (reusableCompaction) {
      // Anything surviving the staleness check above compacted this exact input.
      // Same-turn retry of an input that already compacted successfully on a
      // prior attempt (see the cache check above): reuse it instead of
      // hitting the compact endpoint again. Re-running compaction here would
      // be a silent no-op from the caller's perspective but a real, wasted
      // API round trip, since chainState's anchor clear already committed
      // permanently and doesn't need redoing.
      effectiveMessages = reusableCompaction.compactedMessages;
      compactedThisCall = true;
      compactedMessages = reusableCompaction.compactedMessages;
    } else if (this.shouldCompact()) {
      // Consume the manual compaction request now that compaction is being
      // attempted. For automatic compaction (threshold-based) no request is
      // pending, so this reports false and changes nothing.
      const wasManualRequest = this.consumeCompactionRequest();
      if (wasManualRequest) {
        // Requested compactions come from the manual command, the live-count
        // threshold, or the overflow recovery — each already logged its
        // trigger; this line records the execution.
        logProgressStatus(
          this.logger,
          `Compacting conversation (requested, ${this.chainState.getCumulativeInputTokens()} input tokens)`,
        );
      } else {
        const threshold = this.getCompactionTokenThreshold();
        logProgressStatus(
          this.logger,
          `Compacting conversation (${this.chainState.getCumulativeInputTokens()} tokens exceed ${this.getCompactionThresholdPercent()}% threshold of ${threshold} tokens)`,
        );
      }
      // A backend that keeps no server-side response state (the ChatGPT-
      // subscription/Codex profile) has nothing for the stateful compact
      // endpoint to act on, so it always goes through the client-side
      // summarize-and-resend fallback instead (#7213).
      effectiveMessages = this.storesResponsesServerSide
        ? await this.compactConversation(
            client,
            messages,
            systemPrompt,
            signal,
            convertedTools,
          )
        : await this.compactConversationClientSide(client, messages, signal);
      // compactionResult is set if compaction succeeded
      const { compactionResult } = this;
      compactedThisCall = compactionResult !== undefined;
      if (compactionResult) {
        // Note: the chain anchor is already cleared inside compactConversation()
        // immediately after the compact endpoint succeeds (before token counting).
        compactedMessages = compactionResult.compactedMessages;
      }
    }

    // After compaction in THIS call, send all compacted messages.
    // If already compacted (from previous call), also send all messages.
    // Otherwise, only send new messages since last request.
    const shouldSendAll =
      !this.supportsResponseChaining ||
      compactedThisCall ||
      this.chainState.getSendAllNextTurn();
    const newMessages = shouldSendAll
      ? effectiveMessages
      : effectiveMessages.slice(this.chainState.getSentCount());

    if (this.supportsInlineInputFileUpload) {
      await uploadInlineInputFiles(client, newMessages, {
        openRouterRouting: this.isOpenRouterRoutingEnabled(),
        logger: this.logger,
      });
    }

    // Build shared params used by both token counting and API call
    const baseParams = this.buildResponseBaseParams({
      newMessages,
      systemPrompt,
      convertedTools,
    });

    let maxOutputTokens = this.getEffectiveMaxOutputTokens();
    maxOutputTokens = this.applyChainedOutputTokenBudget(maxOutputTokens);

    // Phase 2: COUNT - Estimate input tokens using built params
    // Phase 3: VALIDATE - Adjust max_output_tokens if needed
    //
    // The live count of the CURRENT request is the one accurate measurement
    // (with previous_response_id set it includes server-side history, per
    // OpenAI docs) and owns every context decision for counting-capable
    // models: it reduces max_output_tokens, it triggers compaction at the
    // threshold (below, after this block), and past 100% it throws — routed
    // through handleCreateResponseError so a pre-flight overflow gets the
    // same recovery as an API-side rejection (drop previous_response_id,
    // compact, retry internally). Throwing it raw would dead-end: every
    // external retry of the unchanged request overflows identically.
    let preFlightTokens: number | undefined;
    try {
      if (!this.supportsTokenCounting) {
        maxOutputTokens = this.applyTokenCountFailureFallback(maxOutputTokens);
      }

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
        contextWindow: this.getEffectiveContextWindow(),
        tokenBuffer: this.getTokenSafetyBuffer(),
        detailLabel:
          'OpenAI Response: max_output_tokens reduced to fit context window',
        applyReduced: (adjusted) => {
          maxOutputTokens = adjusted;
        },
        onCounted: (inputTokens) => {
          preFlightTokens = inputTokens;
        },
        onCountFailure: (err) => {
          this.logger.debug('Token counting failed; applying fallback cap', {
            data: buildErrorLogData(err, { operation: 'token counting' }),
          });
          maxOutputTokens =
            this.applyTokenCountFailureFallback(maxOutputTokens);
        },
      });
    } catch (error) {
      return await this.handleCreateResponseError(
        error,
        options,
        compactedThisCall,
      );
    }

    // Threshold decision on the live count: compact and retry internally
    // before sending, using the same requested-compaction mechanism as the
    // overflow recovery. The one-shot guard keeps a compaction attempt that
    // failed to shrink the transcript from recursing again on its recount.
    if (
      preFlightTokens !== undefined &&
      !compactedThisCall &&
      this.compactionRetrySource === null &&
      this.getCompactionThresholdPercent() > 0 &&
      preFlightTokens > this.getCompactionTokenThreshold() &&
      this.canCompactRoute()
    ) {
      logProgressStatus(
        this.logger,
        `Compacting conversation (pre-flight count ${preFlightTokens} tokens exceeds ${this.getCompactionThresholdPercent()}% threshold of ${this.getCompactionTokenThreshold()} tokens)`,
      );
      this.compactionRetrySource = 'threshold';
      this.requestCompaction();
      return this.createResponseImpl(options);
    }

    return this.dispatchOpenAIResponseExecution({
      baseParams,
      maxOutputTokens,
      convertedTools,
      finalTool,
      useBackgroundResponses,
      useWebSocket,
      useStreaming,
      temperature,
      client,
      signal,
      effectiveMessages,
      compactedThisCall,
      compactedMessages,
      requestOptions: options,
    });
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
    const resumedResponse = await this.backgroundLifecycle.tryResume(
      client,
      signal,
    );
    if (!resumedResponse) return null;
    return this.finalizeResponse(resumedResponse, ctx);
  }

  /**
   * Last-chance adaptation of the request before it goes on the wire. The
   * HTTP paths rewrite the serialized body in their custom `fetch`, but the
   * WebSocket transport sends `params` directly via the SDK and never touches
   * `fetch` — so backends needing request shaping (e.g. Codex) must apply it
   * here too. Identity by default; overridden where a backend rewrites params.
   */
  protected prepareWireParams(
    params: ResponseCreateParamsBase,
  ): ResponseCreateParamsBase {
    return params;
  }

  /**
   * Some backends (the ChatGPT-subscription Codex endpoint) stream output items
   * (text, tool calls, reasoning) but leave the completed response's `output` /
   * `output_text` empty or partial. Fill the missing items from the streamed
   * `output_item.done` events and text deltas so function calls and final text
   * are not dropped. Shared by the HTTP streaming and WebSocket transports —
   * both observe the same sparse completed response. `output` / `output_text`
   * are mutable on the base `Response`, so this assigns through that view (the
   * streaming path's value is a `ParsedResponse`) and mutates in place.
   */
  private rebuildSparseResponseOutput(
    response: Response,
    streamedItems: Response['output'],
    streamedText: string,
  ): void {
    const mergedOutput = mergeMissingStreamedOutputItems(
      response.output,
      streamedItems,
    );
    if (mergedOutput !== response.output) {
      response.output = mergedOutput;
    }
    if (streamedText && !hasResponseOutputText(response)) {
      response.output_text = streamedText;
    }
  }

  /**
   * Poll a still-pending response through to completion.
   *
   * All three transport paths can land on a pending response — background mode
   * by design, the streaming and WebSocket paths when the stream ends before
   * the response finishes (e.g. a relay timeout on a slow request). The
   * retrieve-and-wait handling is identical; only the diagnostic differs, so
   * the caller supplies that via `onPending`.
   */
  private async awaitPendingResponse(
    response: Response,
    client: OpenAI,
    signal: AbortSignal | undefined,
    retrieveParams: ResponseRetrieveParamsNonStreaming | undefined,
    onPending: () => void,
  ): Promise<Response> {
    if (!this.backgroundLifecycle.isPending(response)) return response;
    onPending();
    return this.backgroundLifecycle.waitForCompletion(
      client,
      response,
      signal,
      retrieveParams,
    );
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
      this.prepareWireParams(params),
      signal,
    );
    let response = wsResult.response;
    const { processor } = wsResult;

    // Safety net: handle unexpected pending status (shouldn't happen without background mode)
    response = await this.awaitPendingResponse(
      response,
      client,
      signal,
      responseRetrieveParamsFor(params),
      () => {
        this.logger.debug(
          'WebSocket response ended with pending status: polling for completion',
          {
            data: { responseId: response.id, status: response.status },
          },
        );
      },
    );

    // The Codex backend leaves the completed response's output empty; rebuild
    // it from the streamed items/text, mirroring the HTTP streaming path, so
    // tool calls and final text survive. (No-op after a background poll, which
    // returns a fully-populated response.)
    this.rebuildSparseResponseOutput(
      response,
      processor.streamedItems,
      processor.streamedText,
    );

    // Finalize streams after background polling so the final text
    // reflects the completed response, not the pre-poll snapshot.
    processor.finalize(response);

    return this.finalizeResponse(response, ctx);
  }

  /**
   * Streaming path. The processor accumulates the streamed output items and
   * text, so a mid-stream failure can surface the partial tail as structured
   * error metadata (the Responses stream has no native currentMessage
   * accessor). Polls to completion if the stream ends before the response
   * finishes.
   */
  private async executeStreamingPath(
    params: ResponseCreateParamsBase,
    client: OpenAI,
    signal: AbortSignal | undefined,
    ctx: ResponseFinalizeContext,
  ): Promise<CreateResponseResult<Response, ResponseInputItem>> {
    // Hoisted so the catch can finalize the progress streams on a mid-stream
    // failure (otherwise the progress view hangs in a loading state) and read
    // back the partial text.
    let processor: ResponseStreamProcessor | undefined;
    // Captured from `response.created` so a stream event outside the SDK's
    // typed union (see isUnhandledStreamEventError) can fall back to polling
    // by id instead of failing an otherwise-healthy turn.
    let responseId: string | undefined;
    try {
      const { stream: _stream, ...rest } = params;
      const streamParams: ResponseStreamParams = { ...rest, stream: true };
      const retrieveParams = responseRetrieveParamsFor(params);
      const stream = await client.responses.stream(streamParams, { signal });

      // Processor handles interleaved thinking and web search
      // GPT can: think → web_search → think more → web_search → text
      processor = this.createStreamProcessor();
      const streamProcessor = processor;

      const retrieveAfterUnhandledStreamEvent = async (
        streamError: unknown,
      ): Promise<Response> => {
        if (!responseId || !isUnhandledStreamEventError(streamError)) {
          throw streamError;
        }
        if (!this.storesResponsesServerSide) {
          this.logger.debug(
            "OpenAI stream emitted an event outside the SDK's typed union for a stateless response; polling fallback is unavailable",
            {
              data: {
                responseId,
                ...buildErrorLogData(streamError, {
                  operation: 'unhandled stream event',
                }),
              },
            },
          );
          throw streamError;
        }
        this.logger.debug(
          "OpenAI stream emitted an event outside the SDK's typed union: falling back to polling",
          {
            data: {
              responseId,
              ...buildErrorLogData(streamError, {
                operation: 'unhandled stream event',
              }),
            },
          },
        );
        return this.backgroundLifecycle.retrieveAndRemember(
          client,
          responseId,
          retrieveParams,
          signal,
        );
      };

      let response: Response | undefined;
      try {
        for await (const event of stream) {
          if (event.type === 'response.created') {
            responseId = event.response.id;
          }
          streamProcessor.process(event);
        }
      } catch (streamError) {
        response = await retrieveAfterUnhandledStreamEvent(streamError);
      }

      if (!response) {
        try {
          response = await stream.finalResponse();
        } catch (streamError) {
          response = await retrieveAfterUnhandledStreamEvent(streamError);
        }
      }

      // If the stream ended before the response completed (e.g., relay timeout
      // during slow GPT-5 requests), poll until it finishes instead of silently
      // returning an incomplete response.
      const streamed = response;
      response = await this.awaitPendingResponse(
        streamed,
        client,
        signal,
        retrieveParams,
        () => {
          this.logger.debug(
            'Streaming response ended with pending status - polling for completion',
            {
              data: { responseId: streamed.id, status: streamed.status },
            },
          );
        },
      );

      this.rebuildSparseResponseOutput(
        response,
        processor.streamedItems,
        processor.streamedText,
      );

      processor.finalize(response);

      return this.finalizeResponse(response, ctx);
    } catch (error) {
      return handleStreamingFailure(error, {
        // Finalize the progress streams on error so the view does not hang
        // in a loading state (no-op if the stream never opened or already
        // finalized). Note: this only runs when `recover` above (the
        // `retrieveAfterUnhandledStreamEvent` polling fallback attempted at
        // both the event-loop catch and the `finalResponse()` catch) was
        // either unavailable or itself failed — a successful recovery
        // returns a valid `response` and never reaches this catch.
        finalizeOnError: () => processor?.abort(),
        // Attach a capped tail of any streamed text before it propagates so
        // the retry UI receives the same structured error shape downstream.
        partialTail: () => {
          const streamedText = processor?.streamedText ?? '';
          return streamedText
            ? takeTail(streamedText, PARTIAL_TEXT_TAIL_MAX)
            : '';
        },
      });
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
    response = await this.awaitPendingResponse(
      response,
      client,
      signal,
      responseRetrieveParamsFor(params),
      () => {
        if (useBackgroundResponses) {
          logProgressStatus(
            this.logger,
            'Running OpenAI in background mode; polling for completion (this may take longer than usual).',
          );
          return;
        }
        this.logger.debug(
          'Response returned with pending status despite non-background mode; polling for completion',
          {
            data: {
              responseId: response.id,
              status: response.status,
              hasPreviousResponseId: !!this.chainState.getAnchorId(),
            },
          },
        );
      },
    );

    return this.finalizeResponse(response, ctx);
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
        `Clearing previousResponseId=${this.chainState.getAnchorId()} due to invalid/expired response - ` +
          'next retry will rebuild conversation from local history',
      );
      this.chainState.invalidateChain();
      // Also clear pending background response if present
      this.backgroundLifecycle.clearPending();
    } else if (
      isContextWindowError(error) &&
      !compactedThisCall &&
      this.compactionRetrySource !== 'overflow' &&
      (this.chainState.hasAnchor() || this.canCompactRoute())
    ) {
      // Recovery for a context-window overflow (API-side or pre-flight):
      // - When chaining, accumulated reasoning tokens from prior turns are
      //   stored server-side and count against the window even where
      //   inputTokens.count() may not fully reflect them — drop the chain
      //   (clearing previous_response_id discards the hidden reasoning
      //   tokens) and compact client-side messages, then retry.
      // - Without a chain (e.g. after invalidateChain(), or a non-chaining
      //   route), a compactable transcript still recovers via compaction
      //   alone.
      // Termination: compactedThisCall blocks re-entry after a successful
      // compaction, and the overflow source blocks a second overflow recovery.
      logProgressStatus(
        this.logger,
        'Context window exceeded: compacting conversation and retrying.',
      );
      this.chainState.invalidateChain();
      // invalidateChain(), not resetChainForNewSession() — the latter zeroes
      // cumulativeInputTokens, which would prevent shouldCompact() from
      // triggering on the retry.
      this.backgroundLifecycle.clearPending();
      this.compactionRetrySource = 'overflow';
      this.requestCompaction();
      // Retry internally: the recursive call will compact (shouldCompact()=true)
      // and send all messages without server-side state.
      // Call the impl directly — we're still inside the outer createResponse's
      // inFlight guard, and the public entry would trip the assertion.
      return this.createResponseImpl(options);
    } else if (this.chainState.hasAnchor()) {
      // Log diagnostic info for other errors when chaining was active
      this.logger.debug('Request failed while response chaining was active', {
        data: {
          previousResponseId: this.chainState.getAnchorId(),
          error: providerError.message,
        },
      });
    }

    // Retention of the pending background response id is decided at the point
    // of failure (BackgroundRunLifecycle.tryResume and waitForCompletion). If
    // it survived to here, the next retry will try to resume the same ID.
    if (this.backgroundLifecycle.hasPendingResume()) {
      this.logger.debug(
        `Retaining pendingBackgroundResponseId=${this.backgroundLifecycle.getPendingId()} for retry - ` +
          'next attempt will try to resume polling instead of creating new request',
      );
    }

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
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
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
    const providerOutputText = responseObject.output_text ?? '';
    let newResponse = this.normalizeResponseText(providerOutputText);
    if (!providerOutputText.trim() && Array.isArray(responseObject.output)) {
      // Mutates responseObject.output_text from output message parts.
      addOutputText(responseObject);
      newResponse = this.normalizeResponseText(
        responseObject.output_text ?? '',
      );
    }

    const stopReason =
      responseObject.status === 'completed'
        ? OPENAI_CHAT_FINISH.STOP
        : OPENAI_CHAT_FINISH.LENGTH;

    // Unlike Chat Completions/Anthropic, the Responses API has no `stop`
    // parameter — this handler never configures the end tag as an API-level
    // stop sequence, so a "completed" status never implies the provider
    // stripped it. Forging the tag here would be pure speculation that could
    // mask genuinely incomplete output as done; the extraction layer already
    // tolerates a missing end tag.
    newResponse = this.postProcessResponse(newResponse);

    return { text: newResponse, usage, stopReason };
  }

  /** Price computation adapted for Responses API token fields. */
  computePrice(responseUsage: ResponseUsage): number {
    const providerCapabilities = this.getUsageProviderCapabilities();
    return computeOpenAIResponsePrice(
      responseUsage,
      providerCapabilities
        ? {
            inputPrice: providerCapabilities.inputPrice,
            outputPrice: providerCapabilities.outputPrice,
            cacheDiscountFactor: this.capabilities.cacheDiscountFactor,
          }
        : this.standardPricingConfig(),
    );
  }

  /**
   * Provider identifier for usage tracking. `openai-response` distinguishes
   * OpenAI's Responses surface from its Chat Completions surface; compatible
   * non-OpenAI backends retain their configured provider.
   */
  protected get usageProvider(): NormalizedUsage['provider'] {
    return this.config.provider === ModelProvider.OPENAI
      ? 'openai-response'
      : (this.config.provider as NormalizedUsage['provider']);
  }

  /** Normalizes OpenAI Responses API usage data into a unified format. */
  normalizeUsage(
    rawUsage: ResponseUsage,
    responseTimeMs: number,
  ): NormalizedUsage {
    const usage = normalizeOpenAIResponseUsage(
      rawUsage,
      responseTimeMs,
      this.usageProvider,
      (usage) => this.computePrice(usage),
    );
    const usageRoute = this.getUsageProviderCapabilities()?.usageRoute;
    return usageRoute == null ? usage : { ...usage, usageRoute };
  }

  protected appendUserText(messages: ResponseInputItem[], text: string): void {
    const role = this.capabilities.supportsIntermDevMsgs ? 'system' : 'user';
    messages.push({
      type: 'message',
      role,
      content: [createInputText(text)],
    });
  }

  protected appendTextToLastAssistantMessage(
    messages: ResponseInputItem[],
    text: string,
    options: { afterContinuationPrompt?: boolean; fallbackText?: string } = {},
  ): boolean {
    let targetIndex = messages.length - 1;
    const trailingMessage = messages.at(-1);

    if (options.afterContinuationPrompt) {
      if (!isMessageItem(trailingMessage)) return false;
      const lastContent = trailingMessage.content;
      if (!lastContent || !this.containCutOffMessage(lastContent)) {
        return false;
      }
      targetIndex = messages.length - 2;
    }

    const targetMessage = messages.at(targetIndex);
    if (!targetMessage) return false;

    const appended = this.appendAssistantText(targetMessage, text);
    if (
      options.afterContinuationPrompt &&
      isMessageItem(trailingMessage) &&
      trailingMessage.role === 'user'
    ) {
      messages.pop();
      return appended;
    }

    if (!appended && options.fallbackText != null) {
      messages.push(this.createAssistantMessage(options.fallbackText));
      return true;
    }

    return appended;
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
    }

    if (thoughtContent) {
      this.logger.debug('OpenAI Responses reasoning preview', {
        data: {
          itemCount: reasoningItems.length,
          preview: thoughtContent.slice(0, K_SLICE),
        },
      });
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
      input: parseToolInput(call.arguments, call.call_id, this.logger),
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

    // The two store modes preserve reasoning differently (see each helper);
    // both keep output order so a reasoning item stays immediately before its
    // following item when the blocks are replayed.
    const contentBlocks = this.storesResponsesServerSide
      ? collectWebSearchPairedBlocks(output)
      : collectStatelessContentBlocks(output);

    // Extract normalized web search results for display
    const webSearchResults = extractOpenAIWebSearchResults(output);

    return { webSearchResults, webFetchResults: [], contentBlocks };
  }

  async createToolUseFollowUpMessages(
    client: OpenAI | undefined,
    call: OpenAIResponseToolCall,
    result: ToolResult,
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
      this.supportsResponseChaining && this.chainState.hasAnchor();

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

    const canUploadFiles = this.supportsToolResultFileUpload;
    const canUpload =
      canUploadFiles && attachments.length > 0 && client !== undefined;

    // This upload occurs while assembling the next turn, outside the model
    // invocation gate. Restore the SDK's ordinary two retries for this
    // auxiliary request; generation requests keep maxRetries: 0.
    const { finalResult, uploadResult } = await uploadAndRecordToolAttachments(
      result,
      canUpload,
      async () => ({
        uploaded: await uploadToolAttachments(
          client!.withOptions({ maxRetries: AUXILIARY_MAX_RETRIES }),
          attachments,
          {
            openRouterRouting: this.isOpenRouterRoutingEnabled(),
            logger: this.logger,
          },
        ),
      }),
    );
    const uploadedAttachments: UploadedOpenAIResponseAttachment[] =
      uploadResult?.uploaded ?? [];

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
    const followUpMessage: ResponseInputItem.Message = {
      type: 'message',
      role: 'user',
      content: [createInputText(userMessage)],
    };
    messages.push(followUpMessage);
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

    // String content (from createAssistantMessage) or array content
    // (input_text history or output_text response parts); empty flattens to
    // undefined.
    const text = contentToText(message.content, '');
    return text.length > 0 ? text : undefined;
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

    const existingText = contentToText(content, '');

    Object.assign(
      message,
      this.createAssistantMessage(`${existingText}${text}`),
    );
    return true;
  }

  // =========================================================================
  // Message modification methods (for post-build enrichment)
  // =========================================================================

  /** Find the last user message in the conversation, if any. */
  private findLastUserMessage(
    messages: ResponseInputItem[],
  ): EasyInputMessage | ResponseInputItem.Message | undefined {
    return messages.findLast(
      (m): m is EasyInputMessage | ResponseInputItem.Message =>
        isMessageItem(m) && m.role === 'user',
    );
  }

  /**
   * Prepend text to the last user message in the conversation.
   * Finds the last user message and prepends text to its content.
   */
  prependTextToUserMessage(messages: ResponseInputItem[], text: string): void {
    if (!text.trim()) return;

    const lastUserMsg = this.findLastUserMessage(messages);
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
  ): Promise<MediaAttachmentKind[]> {
    if (!mediaFiles.length || !this.capabilities.supportsVision) return [];

    const lastUserMsg = this.findLastUserMessage(messages);
    if (!lastUserMsg || !Array.isArray(lastUserMsg.content)) return [];

    const formattedMedia = await this.createMediaForRound(mediaFiles, 'insert');
    if (formattedMedia.length === 0) return [];
    lastUserMsg.content.unshift(...formattedMedia);
    return this.consumeInsertedAttachmentKinds('insert');
  }
}
