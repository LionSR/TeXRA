/**
 * LSP-style JSON-RPC framing over a Node duplex stream, backed by vscode-jsonrpc.
 *
 * The Lean language server speaks the standard LSP wire format:
 * `Content-Length: <n>\r\n\r\n<json>`. vscode-jsonrpc handles the framing and
 * routing; this module exposes a simple typed API over those primitives.
 */

import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import type { Readable, Writable } from 'node:stream';

export type NotificationHandler = (params: unknown) => void;
export type ServerRequestHandler = (params: unknown) => Promise<unknown>;

export class JsonRpcConnection {
  private readonly conn: MessageConnection;

  constructor(stdin: Writable, stdout: Readable) {
    this.conn = createMessageConnection(
      new StreamMessageReader(stdout),
      new StreamMessageWriter(stdin),
    );
    this.conn.listen();
  }

  onNotification(method: string, handler: NotificationHandler): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.conn.onNotification(method, handler as any);
  }

  onServerRequest(method: string, handler: ServerRequestHandler): void {
    this.conn.onRequest(method, (params: unknown) => handler(params));
  }

  notify(method: string, params?: unknown): void {
    if (params === undefined) {
      this.conn.sendNotification(method);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.conn.sendNotification(method, params as any);
    }
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (params === undefined) {
      return this.conn.sendRequest<T>(method);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.conn.sendRequest<T>(method, params as any);
  }

  dispose(_reason?: string): void {
    this.conn.dispose();
  }
}
