/**
 * LSP-style JSON-RPC framing over a Node duplex stream, backed by vscode-jsonrpc.
 *
 * The Lean language server speaks the standard LSP wire format:
 * `Content-Length: <n>\r\n\r\n<json>`. vscode-jsonrpc handles the framing and
 * routing; this module exposes a simple typed API over those primitives.
 */

import { type Readable, Writable } from 'node:stream';

import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';

export type NotificationHandler = (params: unknown) => void;
export type ServerRequestHandler = (params: unknown) => Promise<unknown>;

/**
 * Wraps `target` in a Writable that silently drops writes once the target is
 * destroyed. This prevents ERR_STREAM_DESTROYED from propagating through
 * vscode-jsonrpc's async Promise executor — which uses `throw` inside an
 * `async new Promise()` constructor and therefore cannot be caught by callers.
 */
function guardedWritable(target: Writable): Writable {
  // Absorb 'error' events so a broken pipe (EPIPE) on the original stream
  // doesn't become an unhandled Node.js exception.
  target.on('error', () => {});
  return new Writable({
    write(chunk, _encoding, callback) {
      if (target.destroyed || !target.writable) {
        callback();
        return;
      }
      try {
        target.write(chunk, () => callback());
      } catch {
        callback();
      }
    },
    final(callback) {
      if (!target.destroyed && target.writable) {
        target.end(callback);
      } else {
        callback();
      }
    },
  });
}

export class JsonRpcConnection {
  private readonly conn: MessageConnection;
  private disposed = false;
  private disposeError?: Error;

  constructor(stdin: Writable, stdout: Readable) {
    this.conn = createMessageConnection(
      new StreamMessageReader(stdout),
      new StreamMessageWriter(guardedWritable(stdin)),
    );
    // Suppress stream-level errors that vscode-jsonrpc may fire after the
    // underlying process exits.
    this.conn.onError(() => {});
    this.conn.listen();
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.conn.onNotification(method, handler);
  }

  onServerRequest(method: string, handler: ServerRequestHandler): void {
    this.conn.onRequest(method, (params: unknown) => handler(params));
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed) return;
    const p =
      params === undefined
        ? this.conn.sendNotification(method)
        : this.conn.sendNotification(method, params);
    // Notifications are fire-and-forget; swallow transport errors so teardown
    // races (e.g. notify('exit') after the process has died) don't surface as
    // unhandled rejections.
    p.catch(() => {});
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
      if (this.disposed && this.disposeError) throw this.disposeError;
      throw err;
    }
  }

  dispose(reason?: string): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeError = new Error(reason ?? 'JsonRpcConnection disposed');
    this.conn.dispose();
  }
}
