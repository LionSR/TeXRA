/**
 * LSP-style JSON-RPC framing over a Node duplex stream, backed by vscode-jsonrpc.
 *
 * The Lean language server speaks the standard LSP wire format:
 * `Content-Length: <n>\r\n\r\n<json>`. vscode-jsonrpc handles the framing and
 * routing; this module exposes a simple typed API over those primitives.
 */

import { type Readable, Writable } from 'node:stream';

import {
  ConnectionErrors,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';

import * as logger from '@logger/logUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

type NotificationHandler = (params: unknown) => void;
type ServerRequestHandler = (params: unknown) => Promise<unknown>;

export class JsonRpcConnection {
  private readonly conn: MessageConnection;
  private disposed = false;
  private disposeError?: Error;

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

  onServerRequest(method: string, handler: ServerRequestHandler): void {
    this.conn.onRequest(method, handler);
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed) return;
    const p =
      params === undefined
        ? this.conn.sendNotification(method)
        : this.conn.sendNotification(method, params);
    p.catch((err) => {
      this.logLiveError('notification failed', err);
    });
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (this.disposed) {
      throw this.disposeError ?? new Error('JsonRpcConnection is disposed');
    }
    try {
      return await (params === undefined
        ? this.conn.sendRequest<T>(method)
        : this.conn.sendRequest<T>(method, params));
    } catch (err) {
      // Propagate the caller's dispose reason rather than vscode-jsonrpc's
      // generic "connection got disposed" message.
      if (
        this.disposed &&
        this.disposeError &&
        isConnectionDisposedError(err)
      ) {
        throw this.disposeError;
      }
      throw err;
    }
  }

  dispose(reason?: string): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeError = new Error(reason ?? 'JsonRpcConnection disposed');
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
    if (this.disposed || !err) return;
    logger.debug('JsonRpcConnection', `${context}: ${toErrorMessage(err)}`);
  }
}

function isConnectionDisposedError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === ConnectionErrors.Disposed || code === ConnectionErrors.Closed) {
    return true;
  }
  return /\bconnection\b.*\b(disposed|closed)\b/i.test(toErrorMessage(err));
}
