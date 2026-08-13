// WebSocket transport for the OpenAI Responses API.
//
// Owns the persistent WebSocket connection lifecycle (open, keepalive,
// reconnect, close) and executes a single `response.create` over it, feeding
// streaming events into a per-request `ResponseStreamProcessor`. The connection
// is reused across tool-use turns for lower latency and reconnected before the
// server's 60-minute limit.

import { Buffer } from 'node:buffer';

import { ResponsesWS } from 'openai/resources/responses/ws';
import { WebSocketError } from 'openai/resources/responses/internal-base';

import type { AgentTrace } from '@agent/trace';
import {
  attachPartialText,
  attachSdkErrorMetadata,
} from '@common/errors/sdkError/errorMetadata';
import {
  takeTail,
  PARTIAL_TEXT_TAIL_MAX,
} from '@common/errors/sdkError/errorPatterns';

import { wrapResponseError } from './openAIResponseErrors';
import { ResponseStreamProcessor } from './ResponseStreamProcessor';
import { getStreamEventResponseId } from './responseStreamEvents';
import type {
  Response,
  ResponseCompletedEvent,
  ResponseCreateParamsBase,
  ResponseFailedEvent,
  ResponseIncompleteEvent,
  ResponseStreamEvent,
  ResponsesClientEvent,
  ResponsesServerEvent,
} from 'openai/resources/responses/responses';
import type OpenAI from 'openai';

/** Maximum WebSocket connection age before reconnecting (55 min, 5-min buffer before 60-min server limit). */
const WS_MAX_AGE_MS = 55 * 60 * 1000;
/** Keepalive ping interval to prevent idle timeouts (30 seconds). */
const WS_KEEPALIVE_INTERVAL_MS = 30_000;
/** WebSocket readyState value for an open connection. */
const WS_OPEN = 1;

/** Close a socket during cleanup; an already-closed socket must not mask the original failure path. */
function closeQuietly(connection: ResponsesWS): void {
  try {
    connection.close();
  } catch {
    /* ignore */
  }
}

/** Collaborators the transport borrows from the owning handler. */
interface OpenAIResponseWebSocketTransportDeps {
  logger: AgentTrace;
  /** Create a fresh stream processor for a request's streaming events. */
  createStreamProcessor(): ResponseStreamProcessor;
}

/**
 * Result of {@link OpenAIResponseWebSocketTransport.execute}: the API response
 * plus its stream processor, which holds the deferred finalization state and
 * the accumulated output items/text the caller needs to rebuild a sparse
 * completed response.
 */
interface WebSocketExecutionResult {
  response: Response;
  processor: ResponseStreamProcessor;
}

export class OpenAIResponseWebSocketTransport {
  /** WebSocket connection for persistent transport mode. */
  private wsConnection: ResponsesWS | null = null;
  /** Timestamp when the WebSocket connection was created (for 60-min limit). */
  private wsConnectionCreatedAt = 0;
  /** Keepalive interval for the WebSocket connection. */
  private wsKeepaliveInterval: ReturnType<typeof setInterval> | null = null;
  /** Socket whose request-specific listeners currently own error settlement. */
  private activeRequestSocket: ResponsesWS | null = null;

  constructor(private readonly deps: OpenAIResponseWebSocketTransportDeps) {}

  private get logger(): AgentTrace {
    return this.deps.logger;
  }

  /**
   * Execute a response request over a (reused or freshly opened) WebSocket
   * connection. Resolves with the terminal response and the stream processor
   * holding its streaming state so the caller can finalize after any
   * background polling.
   */
  async execute(
    client: OpenAI,
    params: ResponseCreateParamsBase,
    signal?: AbortSignal,
  ): Promise<WebSocketExecutionResult> {
    const ws = await this.getOrCreateWebSocket(client, signal);
    return this.executeViaWebSocket(ws, params, signal);
  }

  /** Release all resources held by the transport (WebSocket, keepalive). */
  dispose(): void {
    this.closeWebSocket();
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
      const socketReady = this.wsConnection.socket.readyState === WS_OPEN;
      if (age < WS_MAX_AGE_MS && socketReady) {
        return this.wsConnection;
      }
      // Connection expired or closed — reconnect
      this.logger.debug('WebSocket connection stale: reconnecting', {
        data: { ageSeconds: Math.round(age / 1000), socketReady },
      });
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
      if (ws.socket.readyState === WS_OPEN) {
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
        closeQuietly(ws);
        attachSdkErrorMetadata(err, {
          provider: 'openai',
          kind: 'connection',
        });
        reject(err);
      };
      const onAbort = (): void => {
        cleanup();
        closeQuietly(ws);
        reject(new DOMException('The operation was aborted', 'AbortError'));
      };

      ws.socket.once('open', onOpen);
      ws.socket.once('error', onError);
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    this.wsConnection = ws;
    this.wsConnectionCreatedAt = Date.now();
    // The SDK rejects globally when an error has no listener, so every socket
    // keeps this guard even after it leaves the pool. Capturing `ws` prevents a
    // late orphan error from invalidating a newer connection. During a request,
    // its listener owns settlement and this guard deliberately stays passive.
    ws.on('error', (error) => {
      if (this.wsConnection !== ws || this.activeRequestSocket === ws) {
        return;
      }
      this.logger.debug('WebSocket connection error: invalidating', {
        data: { message: error.message },
      });
      this.closeWebSocket();
    });
    this.startWsKeepalive(ws);

    this.logger.debug('WebSocket connection established');
    return ws;
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

    const processor = this.deps.createStreamProcessor();
    this.activeRequestSocket = ws;

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
        // Close the WebSocket on abort to prevent cross-talk on retry.
        // The server runs responses sequentially, so after client-side abort
        // it continues finishing the current response. If we reuse the socket,
        // the new executeViaWebSocket call's listeners would receive stale
        // events (including response.created) from the prior response, causing
        // the new request to resolve with the wrong response.
        const aborted = new DOMException(
          'The operation was aborted',
          'AbortError',
        );
        failRequest(aborted, { closeConnection: true });
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
        const eventResponseId = getStreamEventResponseId(e);
        if (eventResponseId && eventResponseId !== currentResponseId) {
          return;
        }

        processor.process(e);
      };

      /**
       * Settle the request as a failure: detach listeners, optionally drop the
       * connection, finalize the processor's streams, then reject with any
       * partial-text tail attached. Finalizing the processor here keeps a
       * mid-stream failure from leaving the progress view hanging: unlike the
       * HTTP path (which finalizes via the caller's catch), the processor is
       * owned here and never reaches the caller on a reject. `abort()`
       * preserves any chunks already streamed; `finalize` is idempotent.
       */
      const failRequest = (
        err: unknown,
        options?: { closeConnection?: boolean },
      ): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (options?.closeConnection) {
          this.closeWebSocket();
        }
        processor.abort();
        // Attach the tail the processor accumulated, mirroring the HTTP
        // streaming path. Without it, a WebSocket failure mid-response would
        // lose any text that had already been generated.
        const { streamedText } = processor;
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
        resolve({ response, processor });
      };

      const onCompleted = (event: ResponseCompletedEvent): void =>
        finalizeSuccess(event.response);

      // Failed responses must be rejected so the caller's catch block can run
      // error recovery (e.g., context-window compaction). The response's own
      // `error` (a structured { code, message } object, not just prose) is
      // preserved on the thrown error via wrapResponseError so
      // isContextWindowError() can key off `error.code` instead of relying
      // solely on `error.message` wording that can drift across model
      // generations.
      const onFailed = (event: ResponseFailedEvent): void => {
        if (settled || !isCurrentResponse(event.response)) return;
        const responseError = event.response.error;
        const errorMsg =
          responseError?.message ?? 'Response failed without details';
        failRequest(
          wrapResponseError(
            `OpenAI WebSocket response failed: ${errorMsg}`,
            responseError,
          ),
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
        // The SDK emits both provider error events and socket failures through
        // this channel. Structured provider errors must retain their own code
        // (only an error without an API event is evidence that the route
        // broke), but the connection is invalidated either way: the server may
        // refuse further service on this socket after a structured error
        // (e.g. websocket_connection_limit_reached) without closing it.
        if (!error.error) {
          attachSdkErrorMetadata(error, {
            provider: 'openai',
            kind: 'connection',
          });
        }
        failRequest(error, { closeConnection: true });
      };

      // Handle unexpected socket close during a request
      const onSocketClose = (code: number, reason: Buffer): void => {
        if (settled) return;
        const error = new Error(
          `WebSocket closed unexpectedly (code: ${code}, reason: ${reason.toString()})`,
        );
        attachSdkErrorMetadata(error, {
          provider: 'openai',
          kind: 'connection',
        });
        failRequest(error, { closeConnection: true });
      };

      const cleanup = (): void => {
        if (this.activeRequestSocket === ws) {
          this.activeRequestSocket = null;
        }
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
        // on the reused WebSocket connection, and finalize the processor's
        // streams (via failRequest) so they do not hang.
        failRequest(sendError);
      }
    });
  }

  /** Close the WebSocket connection and clean up resources. */
  private closeWebSocket(): void {
    this.stopWsKeepalive();
    const wsConnection = this.wsConnection;
    if (wsConnection) {
      // Clear ownership before physical teardown. The SDK may emit another
      // error synchronously from close/terminate; the socket-bound guard then
      // absorbs it without recursing or touching a later connection.
      this.wsConnection = null;
      this.wsConnectionCreatedAt = 0;
      closeQuietly(wsConnection);
      // A graceful `close()` only sends the close frame and waits for the
      // server's reply, so the underlying socket stays an active handle and
      // keeps the Node event loop alive — a headless `--websocket` run would
      // hang after finishing. We're done with this connection, so force the
      // socket down to release the handle immediately.
      try {
        wsConnection.socket.platformSocket.terminate();
      } catch {
        /* already closed */
      }
      this.logger.debug('WebSocket connection closed');
    }
  }

  /** Start keepalive pings on the WebSocket connection. */
  private startWsKeepalive(ws: ResponsesWS): void {
    this.stopWsKeepalive();
    this.wsKeepaliveInterval = setInterval(() => {
      try {
        if (ws.socket.readyState === WS_OPEN) {
          ws.socket.platformSocket.ping();
        }
      } catch {
        // Ignore ping errors
      }
    }, WS_KEEPALIVE_INTERVAL_MS);
    // A background ping timer must never, by itself, keep the Node event loop
    // alive: a headless run with the websocket.openai setting enabled would otherwise hang after
    // finishing until the connection ages out. `unref` lets the process exit
    // once the real work is done; an in-flight request is held by its own
    // pending promise, and interactive sessions by the TUI's own handles.
    this.wsKeepaliveInterval.unref?.();
  }

  /** Stop keepalive pings. */
  private stopWsKeepalive(): void {
    if (this.wsKeepaliveInterval) {
      clearInterval(this.wsKeepaliveInterval);
      this.wsKeepaliveInterval = null;
    }
  }
}
