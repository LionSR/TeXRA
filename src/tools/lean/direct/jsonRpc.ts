/**
 * LSP-style JSON-RPC framing over a Node duplex stream, backed by vscode-jsonrpc.
 *
 * The Lean language server speaks the standard LSP wire format:
 * `Content-Length: <n>\r\n\r\n<json>`. vscode-jsonrpc handles the framing and
 * routing; this module exposes a typed Effect API over those primitives.
 * Requests and notifications are Effects; a request pending when the
 * connection is disposed fails with the dispose reason as
 * {@link JsonRpcConnectionDisposed}.
 */

import { type Readable, Writable } from 'node:stream';

import { Data, Effect } from 'effect';
import {
  ConnectionErrors,
  createMessageConnection,
  ErrorCodes,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';

import { createLog } from '@logger/logUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('JsonRpcConnection');

type NotificationHandler = (params: unknown) => void;

/** The connection was disposed; `message` is the caller's dispose reason. */
export class JsonRpcConnectionDisposed extends Data.TaggedError(
  'JsonRpcConnectionDisposed',
)<{ readonly message: string }> {}

/**
 * The peer answered a request with a JSON-RPC error, or the transport failed
 * before it answered. `code` is the JSON-RPC error code when the peer sent one.
 */
export class JsonRpcRequestError extends Data.TaggedError(
  'JsonRpcRequestError',
)<{
  readonly method: string;
  readonly message: string;
  readonly code?: number;
  readonly cause: unknown;
}> {}

export class JsonRpcConnection {
  private readonly conn: MessageConnection;
  private disposeReason?: string;

  constructor(stdin: Writable, stdout: Readable) {
    this.conn = createMessageConnection(
      new StreamMessageReader(stdout),
      new StreamMessageWriter(this.createGuardedWritable(stdin)),
    );
    this.conn.onError(([err]) => {
      this.logLiveError('connection error', err);
    });
    this.conn.listen();
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.conn.onNotification(method, handler);
  }

  /** Send a notification; a failed write is logged, never surfaced. */
  notify(method: string, params?: unknown): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.disposeReason !== undefined) return Effect.void;
      return Effect.tryPromise({
        try: () =>
          params === undefined
            ? this.conn.sendNotification(method)
            : this.conn.sendNotification(method, params),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => this.logLiveError('notification failed', error)),
        ),
      );
    });
  }

  request<T>(
    method: string,
    params?: unknown,
  ): Effect.Effect<T, JsonRpcRequestError | JsonRpcConnectionDisposed> {
    return Effect.suspend(() => {
      if (this.disposeReason !== undefined) {
        return Effect.fail(
          new JsonRpcConnectionDisposed({ message: this.disposeReason }),
        );
      }
      return Effect.tryPromise({
        try: () =>
          params === undefined
            ? this.conn.sendRequest<T>(method)
            : this.conn.sendRequest<T>(method, params),
        // A connection-teardown rejection observed after dispose is the
        // disposal itself: report the caller's reason rather than
        // vscode-jsonrpc's generic message. A peer error that races the
        // dispose keeps its own code and message.
        catch: (error) => {
          const code = (error as { code?: unknown } | null)?.code;
          if (this.disposeReason !== undefined && isTeardownCode(code)) {
            return new JsonRpcConnectionDisposed({
              message: this.disposeReason,
            });
          }
          return new JsonRpcRequestError({
            method,
            message: toErrorMessage(error),
            code: typeof code === 'number' ? code : undefined,
            cause: error,
          });
        },
      });
    });
  }

  dispose(reason = 'JsonRpcConnection disposed'): void {
    if (this.disposeReason !== undefined) return;
    this.disposeReason = reason;
    this.conn.dispose();
  }

  /**
   * Drops writes after the Lean server's stdin is gone. vscode-jsonrpc writes
   * from async internals, so stream teardown errors need to be absorbed here.
   */
  private createGuardedWritable(target: Writable): Writable {
    target.on('error', (err) => {
      this.logLiveError('stdin stream error', err);
    });

    return new Writable({
      write: (chunk, _encoding, callback) => {
        if (target.destroyed || !target.writable) {
          callback();
          return;
        }
        try {
          target.write(chunk, (err?: Error | null) => {
            this.logLiveError('stdin write failed', err);
            callback();
          });
        } catch (err) {
          this.logLiveError('stdin write failed', err);
          callback();
        }
      },
      final: (callback) => {
        if (target.destroyed || !target.writable) {
          callback();
          return;
        }
        try {
          target.end(callback);
        } catch (err) {
          this.logLiveError('stdin close failed', err);
          callback();
        }
      },
    });
  }

  private logLiveError(context: string, err: unknown): void {
    if (this.disposeReason !== undefined || !err) return;
    log.debug(`${context}: ${toErrorMessage(err)}`);
  }
}

/**
 * vscode-jsonrpc rejected because of the connection, not the peer: a send on
 * a closed or disposed connection, or a pending response dropped by dispose.
 */
function isTeardownCode(code: unknown): boolean {
  return (
    code === ConnectionErrors.Closed ||
    code === ConnectionErrors.Disposed ||
    code === ErrorCodes.PendingResponseRejected
  );
}
