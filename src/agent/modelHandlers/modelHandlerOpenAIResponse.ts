// Standard library imports
import { Buffer } from 'node:buffer';
import * as path from 'path';

// Third-party imports
import OpenAI, {
  APIConnectionTimeoutError,
  APIError as OpenAIAPIError,
  toFile,
} from 'openai';
import { ResponsesWS } from 'openai/resources/responses/ws';
import { WebSocketError } from 'openai/resources/responses/internal-base';

// Local imports - agent
import type { AgentConfig } from '@agent/core/AgentConfig';
import { hasEndTag, type AgentSetting } from '@agent/core/AgentDataclass';
import { type OpenAIAPIResponseUsage } from '@agent/core/ResponseUsage';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { MediaEntry } from '@agent/utils/mediaTypes';
import { calculateTokenPrice } from '@agent/utils/priceUtils';
import { K_SLICE } from '@agent/core/constants';
import { getConfig } from '@agent/core/config';
import {
  getSdkErrorMessage,
  isContextWindowError,
  isPreviousResponseIdError,
  attachPartialText,
  takeTail,
  PARTIAL_TEXT_TAIL_MAX,
} from '@common/errors/sdkErrorUtils';

// Type imports
import type { ToolFileAttachment } from '@tools/result';

// Local imports - utils
import { delay } from '@utils/core';
import { isNonEmptyString } from '@utils/core';
import {
  getWebSocketEnabled,
  getUseOpenRouter,
} from '@utils/config/providerConfig';
import { flexibleFS } from '@utils/files/flexibleFS';
import type { FileLocation } from '@utils/files/taskRunStorage';
import { OFFICE_MIME_TYPES } from '@utils/files/mimeUtils';
import { computeCachePercentage } from './utils/usageNormalization';
import { prepareExistingOutputContent } from './utils/fileContentUtils';
import { tagOpenAISdkError, withSdkErrorTag } from './support/sdkErrorAdapters';
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
  loadAttachmentBuffer,
  type ToolResultPayload,
} from './utils/toolAttachmentUtils';
import { parseToolArguments } from './utils/parseArguments';
import { OPENAI_CHAT_FINISH } from './types/StopReasonTypes';
import { toOpenAIResponseTools } from './toolConversion';
import { ModelHandler } from './ModelHandler';
import {
  CHAINED_RESPONSE_MAX_OUTPUT_FACTOR,
  CHAINED_RESPONSE_SAFETY_MARGIN_PERCENT,
  DEFAULT_COMPACTION_THRESHOLD_PERCENT,
  TOKEN_SAFETY_BUFFER,
  TOOL_USE_SAFETY_BUFFER,
} from './contextManagementConstants';
import {
  buildOpenAIWebSearchResult,
  extractOpenAIWebSearchResults,
  hasOpenAIWebSearchData,
  isOpenAIReasoningItem,
  isOpenAIServerToolContent,
  isOpenAIWebSearchCall,
  type ServerToolExtractionResult,
} from './types/ServerToolTypes';
import type { InputTokenCountParams } from 'openai/resources/responses/input-tokens';
import type { ProviderStopReason } from './types/StopReasonTypes';
import type {
  CreateResponseOptions,
  CreateResponseResult,
  ExtractResponseResult,
  OpenAIResponseToolCall,
  TokenCountOptions,
} from './types/IModelHandler';
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
  ResponseFunctionToolCallItem,
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseInputContent,
  ResponseInputMessageContentList,
  ResponseInputFile,
  ResponseStreamEvent,
  ResponsesClientEvent,
  ResponsesServerEvent,
  ResponseCompletedEvent,
  ResponseFailedEvent,
  ResponseIncompleteEvent,
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
  ResponseFunctionCallArgumentsDoneEvent,
} from 'openai/resources/responses/responses';

interface UploadedOpenAIResponseAttachment {
  attachment: ToolFileAttachment;
  fileId: string;
  isImage: boolean;
}

/** Shared state for streaming event processing (WebSocket and HTTP paths). */
interface StreamingEventState {
  thinkingStream: {
    append(delta: string): void;
    finalize(finalText?: string): void;
  };
  outputStream: {
    append(delta: string): void;
    finalize(finalText?: string): void;
  } | null;
  emittedWebSearchIds: Set<string>;
  hasThinkingContent: boolean;
}

/** Result of executeViaWebSocket: the API response plus streaming state for deferred finalization. */
interface WebSocketExecutionResult {
  response: Response;
  state: StreamingEventState;
}

function isResponseFunctionToolCallItem(
  item: ResponseOutputItem | undefined,
): item is ResponseFunctionToolCallItem {
  return item?.type === 'function_call';
}

/**
 * MIME types that the OpenAI Responses API accepts as `input_file` content.
 * Composed from the shared OFFICE_MIME_TYPES plus PDF.
 * Images are handled separately via `input_image`.
 */
const INLINEABLE_FILE_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  ...OFFICE_MIME_TYPES,
]);

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
  /** Flag to force compaction on the next API call, set by requestCompaction(). */
  private compactionRequested = false;

  private isOpenRouterRoutingEnabled(): boolean {
    return this.config.openRouterOnly || getUseOpenRouter();
  }

  private getEventResponseId(event: ResponseStreamEvent): string | undefined {
    return 'response_id' in event && typeof event.response_id === 'string'
      ? event.response_id
      : undefined;
  }

  /**
   * OpenAI Response API supports file uploads.
   */
  protected override get supportsToolResultFileUpload(): boolean {
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

  override requestCompaction(): void {
    this.compactionRequested = true;
  }

  /**
   * Determines if background mode should be enabled for this request.
   * Enabled for GPT-family models (gpt4*, gpt5*, etc.) when running a
   * workflow agent (CoT or Direct) — not for tool-use agents, which rely
   * on per-step streaming.
   */
  private isBackgroundModeEligible(): boolean {
    const isGpt = this.config.name.toLowerCase().startsWith('gpt');
    return isGpt && this.isWorkflowMode();
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

  /** WebSocket connection for persistent transport mode. */
  private wsConnection: ResponsesWS | null = null;
  /** Timestamp when the WebSocket connection was created (for 60-min limit). */
  private wsConnectionCreatedAt = 0;
  /** Keepalive interval for the WebSocket connection. */
  private wsKeepaliveInterval: ReturnType<typeof setInterval> | null = null;
  /** Maximum WebSocket connection age before reconnecting (55 min, 5-min buffer before 60-min server limit). */
  private static readonly WS_MAX_AGE_MS = 55 * 60 * 1000;
  /** Keepalive ping interval to prevent idle timeouts (30 seconds). */
  private static readonly WS_KEEPALIVE_INTERVAL_MS = 30_000;
  /** WebSocket readyState value for an open connection. */
  private static readonly WS_OPEN = 1;

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

  /**
   * Get or create a WebSocket connection, reusing an existing one if still valid.
   * Reconnects if the connection is approaching the 60-minute server limit.
   */
  private async getOrCreateWebSocket(
    client: OpenAI,
    signal?: AbortSignal,
  ): Promise<ResponsesWS> {
    // Check if existing connection is still valid
    if (this.wsConnection) {
      const age = Date.now() - this.wsConnectionCreatedAt;
      const socketReady =
        this.wsConnection.socket.readyState ===
        ModelHandlerOpenAIResponse.WS_OPEN;
      if (age < ModelHandlerOpenAIResponse.WS_MAX_AGE_MS && socketReady) {
        return this.wsConnection;
      }
      // Connection expired or closed — reconnect
      this.logger.debug(
        `WebSocket connection stale (age: ${Math.round(age / 1000)}s, ready: ${socketReady}) — reconnecting`,
      );
      this.closeWebSocket();
    }

    if (signal?.aborted) {
      throw new DOMException('The operation was aborted', 'AbortError');
    }

    this.logger.debug('Opening WebSocket connection to Responses API');
    const ws = new ResponsesWS(client);

    // Wait for the socket to open, fail on error, or abort on signal.
    // If the handshake fails or is aborted, close the orphaned socket
    // to prevent resource leaks (it hasn't been assigned to wsConnection yet).
    await new Promise<void>((resolve, reject) => {
      if (ws.socket.readyState === ModelHandlerOpenAIResponse.WS_OPEN) {
        resolve();
        return;
      }

      const cleanup = (): void => {
        ws.socket.off('open', onOpen);
        ws.socket.off('error', onError);
        signal?.removeEventListener('abort', onAbort);
      };
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (err: Error): void => {
        cleanup();
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(err);
      };
      const onAbort = (): void => {
        cleanup();
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new DOMException('The operation was aborted', 'AbortError'));
      };

      ws.socket.once('open', onOpen);
      ws.socket.once('error', onError);
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    this.wsConnection = ws;
    this.wsConnectionCreatedAt = Date.now();
    this.startWsKeepalive(ws);

    this.logger.debug('WebSocket connection established');
    return ws;
  }

  /**
   * Finalize and reset the thinking stream if it has content.
   * Extracted as a method to avoid recreating a closure on every streaming event.
   */
  private rotateThinkingStream(state: StreamingEventState): void {
    if (!state.hasThinkingContent) return;
    state.thinkingStream.finalize();
    state.hasThinkingContent = false;
    state.thinkingStream = this.createThinkingStream();
  }

  /**
   * Process a single streaming event, updating the shared streaming state.
   * Used by both WebSocket and HTTP streaming paths for consistent behavior.
   */
  private processStreamingEvent(
    event: ResponseStreamEvent,
    state: StreamingEventState,
  ): void {
    if (this.isReasoningDeltaEvent(event)) {
      state.thinkingStream.append(event.delta);
      state.hasThinkingContent = true;
    } else if (this.isTextDeltaEvent(event)) {
      state.outputStream?.append(event.delta);
    } else if (this.isWebSearchInProgressEvent(event)) {
      this.rotateThinkingStream(state);
    } else if (this.isFunctionCallArgumentsDoneEvent(event)) {
      // Function call arguments complete - finalize streams since no more
      // text/thinking deltas will arrive after tool calls begin.
      this.rotateThinkingStream(state);
      this.logger.debug(`Tool call ready during streaming: ${event.name}`);
    } else if (this.isOutputItemDoneEvent(event)) {
      const item = event.item;
      if (
        this.isWebSearchItem(item) &&
        !state.emittedWebSearchIds.has(item.id) &&
        hasOpenAIWebSearchData(item)
      ) {
        this.rotateThinkingStream(state);
        this.emitOpenAIWebSearch(item);
        state.emittedWebSearchIds.add(item.id);
      }
    }
  }

  /** Create a fresh streaming event state for a new request. */
  private createStreamingEventState(): StreamingEventState {
    return {
      thinkingStream: this.createThinkingStream(),
      outputStream: this.isOutputStreamingEnabled()
        ? this.createOutputStream()
        : null,
      emittedWebSearchIds: new Set<string>(),
      hasThinkingContent: false,
    };
  }

  /**
   * Finalize thinking/output streams and emit remaining web searches.
   * Shared by both WebSocket and HTTP streaming paths after background
   * polling completes.
   */
  private finalizeStreams(
    response: Response,
    state: StreamingEventState,
  ): void {
    if (state.hasThinkingContent) {
      state.thinkingStream.finalize();
    }
    const { text: finalText } = this.extractResponse(response, '');
    if (state.outputStream) state.outputStream.finalize(finalText);
    this.emitWebSearchesFromResponse(response, state.emittedWebSearchIds);
  }

  /**
   * Execute a response request via WebSocket transport.
   * Sends a response.create event and collects streaming events until
   * a terminal event (completed, failed, incomplete) is received.
   *
   * Completed and incomplete responses are resolved so the caller's
   * `finalizeResponse()` can handle non-completed statuses consistently
   * with the HTTP streaming path. Failed responses are rejected so the
   * caller's catch block can apply recovery logic.
   */
  private async executeViaWebSocket(
    ws: ResponsesWS,
    params: ResponseCreateParamsBase,
    signal?: AbortSignal,
  ): Promise<WebSocketExecutionResult> {
    // Short-circuit if already aborted before sending the request
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted', 'AbortError');
    }

    const state = this.createStreamingEventState();
    // Accumulate text deltas so we can attach a tail to the error on reject,
    // mirroring the HTTP streaming path. Without this, a WebSocket failure
    // mid-response would lose any text that had already been generated.
    let streamedText = '';

    return new Promise<WebSocketExecutionResult>((resolve, reject) => {
      let settled = false;
      // Track the response ID for this request so we only process events
      // belonging to it (important when abort-and-retry reuses the connection).
      // Starts as null — terminal events are ignored until response.created sets it,
      // preventing stale events from a previous request from being accepted.
      let currentResponseId: string | null = null;

      /** Check whether a terminal event belongs to the current request. */
      const isCurrentResponse = (response: Response): boolean =>
        currentResponseId !== null && response.id === currentResponseId;

      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        // Close the WebSocket on abort to prevent cross-talk on retry.
        // The server runs responses sequentially, so after client-side abort
        // it continues finishing the current response. If we reuse the socket,
        // the new executeViaWebSocket call's listeners would receive stale
        // events (including response.created) from the prior response, causing
        // the new request to resolve with the wrong response.
        this.closeWebSocket();
        rejectWithPartial(
          new DOMException('The operation was aborted', 'AbortError'),
        );
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      // Process streaming events, filtering by response ID.
      const onEvent = (event: ResponsesServerEvent): void => {
        const e = event as ResponseStreamEvent;

        // Capture the response ID from the first response.created event
        if (e.type === 'response.created') {
          currentResponseId = e.response.id;
          return;
        }

        // Discard any events that arrive before response.created identifies
        // the current request. This guards against out-of-order delivery and
        // prevents processing stale events on a reused connection.
        if (!currentResponseId) return;

        // Filter events by response ID: skip events from stale responses
        const eventResponseId = this.getEventResponseId(e);
        if (eventResponseId && eventResponseId !== currentResponseId) {
          return;
        }

        this.processStreamingEvent(e, state);
        if (this.isTextDeltaEvent(e)) {
          streamedText += e.delta;
        }
      };

      /** Attach partial-text tail to an error before rejecting with it. */
      const rejectWithPartial = (err: unknown): void => {
        if (streamedText) {
          attachPartialText(err, takeTail(streamedText, PARTIAL_TEXT_TAIL_MAX));
        }
        reject(err);
      };

      const finalizeSuccess = (response: Response): void => {
        if (settled || !isCurrentResponse(response)) return;
        settled = true;
        cleanup();
        // Stream finalization is deferred to the caller so that background
        // polling (if needed) can replace the response before streams close.
        resolve({ response, state });
      };

      const onCompleted = (event: ResponseCompletedEvent): void =>
        finalizeSuccess(event.response);

      // Failed responses must be rejected so the caller's catch block can
      // run error recovery (e.g., context-window compaction).
      const onFailed = (event: ResponseFailedEvent): void => {
        if (settled || !isCurrentResponse(event.response)) return;
        settled = true;
        cleanup();
        const errorMsg =
          event.response.error?.message ?? 'Response failed without details';
        rejectWithPartial(
          new Error(`OpenAI WebSocket response failed: ${errorMsg}`),
        );
      };

      // Incomplete responses are resolved (not rejected) to match the HTTP
      // streaming path behavior. The caller's finalizeResponse() handles
      // non-completed statuses (e.g., max_output_tokens truncation) by
      // clearing previousResponseId and logging a warning.
      const onIncomplete = (event: ResponseIncompleteEvent): void =>
        finalizeSuccess(event.response);

      const onWsError = (error: WebSocketError): void => {
        if (settled) return;
        settled = true;
        cleanup();
        // Invalidate the connection on error events (e.g., websocket_connection_limit_reached).
        // The server may close the socket after sending the error, but the close event
        // fires after this handler and would be a no-op (settled=true).
        this.closeWebSocket();
        rejectWithPartial(error);
      };

      // Handle unexpected socket close during a request
      const onSocketClose = (code: number, reason: Buffer): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.closeWebSocket();
        rejectWithPartial(
          new Error(
            `WebSocket closed unexpectedly (code: ${code}, reason: ${reason.toString()})`,
          ),
        );
      };

      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort);
        ws.off('event', onEvent);
        ws.off('response.completed', onCompleted);
        // Type assertion needed: the EventEmitter generic maps event names to
        // handler signatures via Extract<ResponsesServerEvent, {type?: EventType}>.
        // Our handler types are compatible but TS can't prove it through the indirection.
        ws.off('response.failed', onFailed as Parameters<typeof ws.off>[1]);
        ws.off(
          'response.incomplete',
          onIncomplete as Parameters<typeof ws.off>[1],
        );
        ws.off('error', onWsError);
        ws.socket.off('close', onSocketClose);
      };

      ws.on('event', onEvent);
      ws.on('response.completed', onCompleted);
      ws.on('response.failed', onFailed as Parameters<typeof ws.on>[1]);
      ws.on('response.incomplete', onIncomplete as Parameters<typeof ws.on>[1]);
      ws.on('error', onWsError);
      ws.socket.on('close', onSocketClose);

      // Build and send the WebSocket client event.
      // ResponsesClientEvent mirrors ResponseCreateParamsBase fields with type: 'response.create'.
      // Transport-specific fields (stream, background) are included but ignored by the server.
      try {
        ws.send({
          type: 'response.create',
          ...params,
        } as ResponsesClientEvent);
      } catch (sendError) {
        // If send() throws synchronously, clean up listeners to prevent leaks
        // on the reused WebSocket connection.
        settled = true;
        cleanup();
        reject(sendError);
      }
    });
  }

  /** Release all resources held by this handler (WebSocket, keepalive). */
  override dispose(): void {
    this.closeWebSocket();
  }

  /** Close the WebSocket connection and clean up resources. */
  private closeWebSocket(): void {
    this.stopWsKeepalive();
    const wsConnection = this.wsConnection;
    if (wsConnection) {
      try {
        wsConnection.close();
      } catch {
        // Cleanup must not mask the original failure path.
      }
      this.wsConnection = null;
      this.wsConnectionCreatedAt = 0;
      this.logger.debug('WebSocket connection closed');
    }
  }

  /** Start keepalive pings on the WebSocket connection. */
  private startWsKeepalive(ws: ResponsesWS): void {
    this.stopWsKeepalive();
    this.wsKeepaliveInterval = setInterval(() => {
      try {
        if (ws.socket.readyState === ModelHandlerOpenAIResponse.WS_OPEN) {
          ws.socket.platformSocket.ping();
        }
      } catch {
        // Ignore ping errors
      }
    }, ModelHandlerOpenAIResponse.WS_KEEPALIVE_INTERVAL_MS);
  }

  /** Stop keepalive pings. */
  private stopWsKeepalive(): void {
    if (this.wsKeepaliveInterval) {
      clearInterval(this.wsKeepaliveInterval);
      this.wsKeepaliveInterval = null;
    }
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
      if (err instanceof DOMException && err.name === 'AbortError') {
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
    const safeToChain = response.status === 'completed' && hasInputTokens;
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
    if (this.previousResponseId !== null) {
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
    if (!this.previousResponseId) {
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
      } catch {
        // Fall back to output_tokens if token counting fails.
        // NOTE: It's unclear what output_tokens represents exactly for the compact
        // endpoint — it may be the generation cost rather than the reusable content
        // size. This fallback is a best-effort estimate until OpenAI clarifies.
        tokensAfter = compactedResponse.usage.output_tokens;
      }

      const utilizationAfter = (tokensAfter / contextWindow) * 100;
      const reduction = tokensBefore - tokensAfter;
      const reductionPercent = ((reduction / tokensBefore) * 100).toFixed(1);

      // Log context management event with structured data
      this.logger.logContextManagement(
        `Compacted conversation: ${tokensBefore.toLocaleString()} → ${tokensAfter.toLocaleString()} tokens (${reductionPercent}% reduction)`,
        {
          action: 'compaction',
          tokensBefore,
          tokensAfter,
          contextWindow,
          utilizationBefore: Number(utilizationBefore.toFixed(1)),
          utilizationAfter: Number(utilizationAfter.toFixed(1)),
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
    this.closeWebSocket();

    const messages: ResponseInputItem[] = [];

    if (systemPrompt) {
      const role = this.capabilities.supportsSystemPrompt ? 'system' : 'user';
      const systemMessage: ResponseInputItem.Message = {
        type: 'message',
        role,
        content: [this.createInputText(systemPrompt)],
      };
      messages.push(systemMessage);
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
        content: [this.createInputText(userRequest)],
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
        this.logger.logError(
          `Error processing media files for follow-up round: ${getSdkErrorMessage(err)}`,
          err,
          { operation: 'process media files' },
        );
      }
    }

    roundContent.push(this.createInputText(userMessage));

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

      const contentList = item.content;

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
      const uploadedFile = await client.files.create({
        file: await toFile(buffer!, filename),
        purpose: 'assistants',
      });

      content.file_id = uploadedFile.id;
      delete content.file_data;
      if ('filename' in content) {
        delete content.filename;
      }
    } catch (err) {
      // Two native SDK timeout signals: APIConnectionTimeoutError (client-side
      // SDK timeout) and APIError with status 408 (server-side Request Timeout).
      // Status 408 is NOT mapped to APIConnectionTimeoutError by the SDK —
      // it falls through to a bare APIError — so both must be checked.
      const isTimeout =
        err instanceof APIConnectionTimeoutError ||
        (err instanceof OpenAIAPIError && err.status === 408);
      if (isTimeout) {
        this.logger.warn(
          `Timed out uploading file ${filename}. Falling back to inline payload.`,
        );
        return;
      }

      this.logger.logError(
        `Failed to upload file ${filename}: ${getSdkErrorMessage(err)}`,
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
      ...(this.previousResponseId && {
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
  async createResponse(
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
        tagOpenAISdkError,
        this.config.provider,
        () => this.createResponseImpl(options),
      );
    } finally {
      this.inFlight = false;
    }
  }

  private async createResponseImpl(
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
        this.logger.logProgress(
          `Compacting conversation (manually requested, ${this.conversationState.cumulativeInputTokens} input tokens)`,
        );
      } else {
        const threshold = this.getCompactionTokenThreshold();
        this.logger.logProgress(
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
      compactedThisCall || this.conversationState.isCompacted;
    const newMessages = shouldSendAll
      ? effectiveMessages
      : effectiveMessages.slice(this.conversationState.sentMessages);

    await this.uploadInlineInputFiles(client, newMessages);

    // Build shared params used by both token counting and API call

    // OpenAI Responses API doesn't support 'none'; clamp to 'low'.
    const rawEffort = this.capabilities.supportsReasoning
      ? this.getEffectiveReasoningEffort()
      : undefined;
    const reasoningEffort = rawEffort === 'none' ? ('low' as const) : rawEffort;

    // Phase 1: BUILD - Construct provider-specific request parameters
    const baseParams = {
      model: this.config.fullName,
      input: newMessages,
      ...(systemPrompt && { instructions: systemPrompt }),
      ...(this.previousResponseId && {
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
    if (this.supportsTokenCounting) {
      try {
        // Reuse built params for token counting (build once principle)
        // IMPORTANT: Pass tools and systemPrompt for accurate count
        const inputTokens = await this.estimateTokenCount(baseParams.input, {
          client,
          signal,
          systemPrompt,
          tools: convertedTools,
        });

        // DIAGNOSTIC: Log token count details for investigation
        // Compare pre-flight estimate with cumulative tokens from previous response
        const prevCumulative = this.conversationState.cumulativeInputTokens;
        const utilizationEstimate =
          (inputTokens / this.config.contextWindow) * 100;
        this._diagPreFlightTokens = inputTokens; // Store for comparison in finalizeResponse
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

        // Validate and adjust max_output_tokens if needed (throws if context window exceeded)
        const tokenBuffer = this.getTokenSafetyBuffer();
        const validation = this.validateTokenLimits(
          inputTokens,
          maxOutputTokens,
          this.config.contextWindow,
          tokenBuffer,
        );

        if (validation.adjustedMaxTokens !== maxOutputTokens) {
          this.logger.logContextManagement(
            `Token count (${inputTokens}) + max_output_tokens (${maxOutputTokens}) exceeds context window (${this.config.contextWindow}). Reducing to ${validation.adjustedMaxTokens}.`,
            {
              action: 'max_tokens_reduced',
              tokensBefore: inputTokens,
              contextWindow: this.config.contextWindow,
              utilizationBefore:
                validation.utilizationPercent ??
                (inputTokens / this.config.contextWindow) * 100,
              originalMaxTokens: maxOutputTokens,
              reducedMaxTokens: validation.adjustedMaxTokens,
              details:
                'OpenAI Response: max_output_tokens reduced to fit context window',
            },
          );
          maxOutputTokens = validation.adjustedMaxTokens;
        }
      } catch (err) {
        tagOpenAISdkError(err, this.config.provider);
        if (isContextWindowError(err)) throw err;
        this.logger.debug(
          `Token counting failed: ${getSdkErrorMessage(err)}. Applying fallback cap.`,
        );
        // Fallback: cap output based on best available estimate.
        // Skip on first turn (no history to overflow).
        const inputEstimate = this.getBestInputTokenEstimate();
        if (inputEstimate > 0) {
          const buffer = this.getTokenSafetyBuffer();
          const available = this.config.contextWindow - inputEstimate - buffer;
          const capped = Math.min(maxOutputTokens, Math.max(0, available));
          if (capped !== maxOutputTokens) {
            this.logger.debug(
              `Fallback: max_output_tokens ${maxOutputTokens} → ${capped} (estimate: ${inputEstimate})`,
            );
            maxOutputTokens = capped;
          }
        }
      }
    }

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
      const isGpt5 = this.config.name.startsWith('gpt5');
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

    // Wrap execution in try-catch to handle previousResponseId errors
    // When an error indicates the response ID is invalid, we clear it so
    // the retry logic can recover by starting a fresh conversation.
    //
    // Text accumulated from `response.output_text.delta` events during
    // streaming. Hoisted here so the catch block can surface it as
    // partial text on mid-stream failures. ResponseStream has no native
    // currentMessage accessor (unlike ChatCompletionStream), so we
    // accumulate manually from the events we already iterate.
    let streamedText = '';
    try {
      // Try to resume a pending background response (for retry after connection error)
      if (useBackgroundResponses && this.pendingBackgroundResponseId) {
        const resumedResponse = await this.tryResumeBackgroundResponse(
          client,
          signal,
        );
        if (resumedResponse) {
          this.finalizeResponse(
            resumedResponse,
            effectiveMessages.length,
            compactedThisCall,
          );
          return {
            response: resumedResponse,
            updatedMessages: compactedMessages,
          };
        }
        // Resume failed or response failed remotely - fall through to create new request
      }

      // WebSocket transport: persistent connection for lower-latency tool-use loops
      if (useWebSocket) {
        const ws = await this.getOrCreateWebSocket(client, signal);
        const wsResult = await this.executeViaWebSocket(ws, params, signal);
        let response = wsResult.response;
        const state = wsResult.state;

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
        this.finalizeStreams(response, state);

        this.finalizeResponse(
          response,
          effectiveMessages.length,
          compactedThisCall,
        );
        return {
          response,
          updatedMessages: compactedMessages,
        };
      }

      if (useStreaming) {
        const { stream: _stream, ...rest } = params;
        const streamParams: ResponseStreamParams = { ...rest, stream: true };
        const stream = await client.responses.stream(streamParams, { signal });

        // State for handling interleaved thinking and web search
        // GPT can: think → web_search → think more → web_search → text
        const state = this.createStreamingEventState();

        for await (const event of stream) {
          this.processStreamingEvent(event, state);
          if (event.type === 'response.output_text.delta') {
            streamedText += event.delta;
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

        this.finalizeStreams(response, state);

        this.finalizeResponse(
          response,
          effectiveMessages.length,
          compactedThisCall,
        );
        return {
          response,
          updatedMessages: compactedMessages,
        };
      }

      // Non-streaming path
      // Errors propagate to PocketFlow's execFallback which logs once (log at boundary principle)
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
          this.logger.logProgress(
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
        effectiveMessages.length,
        compactedThisCall,
      );
      return {
        response,
        updatedMessages: compactedMessages,
      };
    } catch (error) {
      // Attach a capped tail of any streamed text before normalization so the
      // retry UI receives the same structured error shape downstream.
      if (streamedText) {
        attachPartialText(error, takeTail(streamedText, PARTIAL_TEXT_TAIL_MAX));
      }

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
        this.logger.logProgress(
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
        return this.createResponseImpl({
          client,
          messages,
          temperature,
          systemPrompt,
          signal,
          tools,
        });
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
    const cachedTokens = rawUsage.input_tokens_details?.cached_tokens ?? 0;

    return {
      inputTokens,
      outputTokens: rawUsage.output_tokens ?? 0,
      cost: this.computePrice(rawUsage),
      responseTimeMs,
      provider: 'openai-response',
      cachedInputTokens: cachedTokens || undefined,
      percentageCached: computeCachePercentage(cachedTokens, inputTokens),
      reasoningTokens:
        rawUsage.output_tokens_details?.reasoning_tokens || undefined,
      _native: rawUsage,
    };
  }

  /** Models with prefill support do not require additional continuation messages. */
  addContinueMessageWithPrefill(
    _messages: ResponseInputItem[],
    _workspaceState: AgentWorkspaceState,
    _agentSetting: AgentSetting,
  ): void {
    this.defaultAddContinueWithPrefill();
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
        if (err instanceof DOMException && err.name === 'AbortError') {
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
        if (err instanceof DOMException && err.name === 'AbortError') {
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
        const statusCode = (err as { status?: number }).status;
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
      content: [this.createInputText(userMessageContinuation)],
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
          content: [this.createInputText(pseudoPrefill)],
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
    const isResponseChaining = Boolean(this.previousResponseId);

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
      } = await this.buildInlineAttachmentParts(attachments);
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
        const filename = isNonEmptyString(attachment.path)
          ? path.basename(attachment.path)
          : 'attachment';
        const mimeType = attachment.mimeType ?? 'application/octet-stream';

        const uploadedFile = await client.files.create({
          file: await toFile(buffer!, filename, { type: mimeType }),
          purpose: 'assistants',
        });

        uploaded.push({
          attachment,
          fileId: uploadedFile.id,
          isImage: mimeType.startsWith('image/'),
        });
      } catch (err) {
        this.logger.warn(
          `Failed to upload attachment to OpenAI: ${getSdkErrorMessage(err)}`,
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

  /**
   * Build inline base64 content parts for tool attachments when file uploads
   * are unavailable (e.g., OpenRouter routing). Images use data URI in
   * `image_url`; PDFs and office documents use `file_data` in `input_file`.
   * Unsupported MIME types are skipped.
   */
  private async buildInlineAttachmentParts(
    attachments: ToolFileAttachment[],
  ): Promise<{
    parts: ResponseFunctionCallOutputItemList;
    inlined: ToolFileAttachment[];
    skipped: ToolFileAttachment[];
  }> {
    const MAX_INLINE_BYTES = 20 * 1024 * 1024; // 20 MiB cap per attachment
    const parts: ResponseFunctionCallOutputItemList = [];
    const inlined: ToolFileAttachment[] = [];
    const skipped: ToolFileAttachment[] = [];

    for (const attachment of attachments) {
      const mimeType = attachment.mimeType ?? 'application/octet-stream';
      const isImage = mimeType.startsWith('image/');
      const isFileInput = INLINEABLE_FILE_MIME_TYPES.has(mimeType);

      if (!isImage && !isFileInput) {
        skipped.push(attachment);
        continue;
      }

      let buffer: Buffer | undefined;
      try {
        buffer = await loadAttachmentBuffer(attachment);
        if (buffer.length > MAX_INLINE_BYTES) {
          this.logger.debug(
            `Skipping inline attachment ${attachment.path ?? 'attachment'}: ${buffer.length} bytes exceeds limit`,
          );
          skipped.push(attachment);
          continue;
        }

        const base64 = buffer.toString('base64');

        if (isImage) {
          parts.push({
            type: 'input_image',
            detail: 'auto',
            image_url: `data:${mimeType};base64,${base64}`,
          });
        } else {
          // PDF, office documents, and other file types accepted by input_file
          const filename =
            typeof attachment.path === 'string' && attachment.path.length > 0
              ? path.basename(attachment.path)
              : 'attachment';
          parts.push({
            type: 'input_file',
            file_data: `data:${mimeType};base64,${base64}`,
            filename,
          });
        }
        inlined.push(attachment);
      } catch (err) {
        this.logger.debug(
          `Unable to inline attachment ${attachment.path ?? 'attachment'}: ${getSdkErrorMessage(err)}`,
        );
        skipped.push(attachment);
      } finally {
        if (buffer) {
          buffer.fill(0);
          buffer = undefined;
        }
      }
    }

    return { parts, inlined, skipped };
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

  override extractAssistantText(
    message: ResponseInputItem,
  ): string | undefined {
    if (!this.isAssistantTextMessage(message)) {
      return undefined;
    }

    // String content (from createAssistantMessage)
    if (typeof message.content === 'string') {
      return message.content;
    }

    // Array content (input_text history or output_text response parts)
    if (Array.isArray(message.content)) {
      const texts = message.content
        .map((part) => this.extractTextContentPart(part))
        .filter((text): text is string => text !== undefined);
      return texts.length > 0 ? texts.join('') : undefined;
    }

    return undefined;
  }

  private createInputText(text: string): ResponseInputContent {
    return { type: 'input_text', text };
  }

  private isMessageItem(
    item?: ResponseInputItem,
  ): item is EasyInputMessage | ResponseInputItem.Message {
    if (!item || typeof item !== 'object') return false;
    if (!('role' in item) || typeof item.role !== 'string') return false;
    if (
      'type' in item &&
      typeof item.type === 'string' &&
      item.type !== 'message'
    ) {
      return false;
    }
    if (!('content' in item)) return false;
    const { content } = item;
    return typeof content === 'string' || Array.isArray(content);
  }

  private isAssistantTextMessage(
    item?: ResponseInputItem,
  ): item is EasyInputMessage | ResponseOutputMessage {
    return (
      item?.type === 'message' &&
      item.role === 'assistant' &&
      (typeof item.content === 'string' || Array.isArray(item.content))
    );
  }

  private extractTextContentPart(part: unknown): string | undefined {
    if (!part || typeof part !== 'object') return undefined;
    const candidate = part as { type?: unknown; text?: unknown };
    return (candidate.type === 'input_text' ||
      candidate.type === 'output_text') &&
      typeof candidate.text === 'string'
      ? candidate.text
      : undefined;
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

  /** Type guard for function call arguments done events. */
  private isFunctionCallArgumentsDoneEvent(
    event: ResponseStreamEvent,
  ): event is ResponseFunctionCallArgumentsDoneEvent {
    return event.type === 'response.function_call_arguments.done';
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
        .map((part) => this.extractTextContentPart(part) ?? '')
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
    if (!mediaFiles.length || !this.capabilities.supportsVision) return;

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
