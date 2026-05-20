/**
 * Minimal LSP-style JSON-RPC framing over a Node duplex stream.
 *
 * The Lean language server speaks the standard LSP wire format:
 * `Content-Length: <n>\r\n\r\n<json>`. This module owns the framing and
 * routing layer so callers only deal with typed JSON-RPC payloads.
 *
 * Kept dependency-free (no `vscode-jsonrpc`) so it can ship in the CLI and
 * Electron desktop builds without dragging in VS Code's language client.
 */

import type { Readable, Writable } from 'node:stream';

export type RpcId = number | string;

export interface RpcRequest {
  jsonrpc: '2.0';
  id: RpcId;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: RpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export type NotificationHandler = (params: unknown) => void;
export type ServerRequestHandler = (params: unknown) => Promise<unknown>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class JsonRpcConnection {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly notificationHandlers = new Map<
    string,
    NotificationHandler
  >();
  private readonly serverRequestHandlers = new Map<
    string,
    ServerRequestHandler
  >();
  private closed = false;
  private closeError?: Error;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
  ) {
    stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    stdout.on('close', () => this.onClose(new Error('LSP stdout closed')));
    stdout.on('error', (err) => this.onClose(err));
    stdin.on('error', (err) => this.onClose(err));
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  onServerRequest(method: string, handler: ServerRequestHandler): void {
    this.serverRequestHandlers.set(method, handler);
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      throw this.closeError ?? new Error('LSP connection is closed');
    }
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ jsonrpc: '2.0', id, method, params });
    return promise as Promise<T>;
  }

  dispose(reason: string = 'JsonRpcConnection.dispose'): void {
    this.onClose(new Error(reason));
  }

  private write(message: RpcMessage): void {
    if (this.closed) return;
    const json = JSON.stringify(message);
    const body = Buffer.from(json, 'utf8');
    const header = Buffer.from(
      `Content-Length: ${body.length}\r\n\r\n`,
      'ascii',
    );
    this.stdin.write(header);
    this.stdin.write(body);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // Drain as many complete messages as we have in the buffer.
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const headerText = this.buffer.slice(0, headerEnd).toString('ascii');
      const match = headerText.match(/Content-Length: (\d+)/i);
      if (!match) {
        // Malformed header — drop and resync at the next blank line.
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number.parseInt(match[1]!, 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.slice(bodyStart, bodyStart + length);
      this.buffer = this.buffer.slice(bodyStart + length);
      let parsed: RpcMessage | undefined;
      try {
        parsed = JSON.parse(body.toString('utf8')) as RpcMessage;
      } catch {
        // Drop malformed payload and keep going.
      }
      if (parsed) this.dispatch(parsed);
    }
  }

  private dispatch(message: RpcMessage): void {
    if ('id' in message && 'method' in message) {
      // Server-to-client request.
      const handler = this.serverRequestHandlers.get(message.method);
      if (!handler) {
        this.write({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32601,
            message: `Unhandled method: ${message.method}`,
          },
        });
        return;
      }
      handler(message.params).then(
        (result) => this.write({ jsonrpc: '2.0', id: message.id, result }),
        (error: unknown) =>
          this.write({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32603, message: errorMessage(error) },
          }),
      );
      return;
    }
    if ('id' in message) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            `LSP error ${message.error.code}: ${message.error.message}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if ('method' in message) {
      const handler = this.notificationHandlers.get(message.method);
      if (handler) handler(message.params);
    }
  }

  private onClose(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
