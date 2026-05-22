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

import { toErrorMessage } from '@common/errors';
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
  private readonly chunks: Buffer[] = [];
  private bufferedLength = 0;
  private pendingBodyLength: number | undefined;
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
    this.chunks.push(chunk);
    this.bufferedLength += chunk.length;
    // Drain as many complete messages as we have in the buffer.
    for (;;) {
      if (this.pendingBodyLength !== undefined) {
        if (this.bufferedLength < this.pendingBodyLength) return;
        this.dispatchBody(this.consumeBytes(this.pendingBodyLength));
        this.pendingBodyLength = undefined;
        continue;
      }

      const headerEnd = this.findHeaderEnd();
      if (headerEnd < 0) return;
      const headerText = this.consumeBytes(headerEnd).toString('ascii');
      this.discardBytes(4);
      const match = headerText.match(/Content-Length: (\d+)/i);
      if (!match) {
        // Malformed header — drop and resync at the next blank line.
        continue;
      }
      const length = Number.parseInt(match[1]!, 10);
      if (this.bufferedLength < length) {
        this.pendingBodyLength = length;
        return;
      }
      this.dispatchBody(this.consumeBytes(length));
    }
  }

  private dispatchBody(body: Buffer): void {
    let parsed: RpcMessage | undefined;
    try {
      parsed = JSON.parse(body.toString('utf8')) as RpcMessage;
    } catch {
      // Drop malformed payload and keep going.
    }
    if (parsed) this.dispatch(parsed);
  }

  private findHeaderEnd(): number {
    const delimiter = [13, 10, 13, 10];
    let matched = 0;
    let offset = 0;
    for (const chunk of this.chunks) {
      for (const byte of chunk) {
        if (byte === delimiter[matched]) {
          matched += 1;
          if (matched === delimiter.length) {
            return offset - delimiter.length + 1;
          }
        } else {
          matched = byte === delimiter[0] ? 1 : 0;
        }
        offset += 1;
      }
    }
    return -1;
  }

  private consumeBytes(length: number): Buffer {
    if (length === 0) return Buffer.alloc(0);
    const parts: Buffer[] = [];
    let remaining = length;
    while (remaining > 0) {
      const head = this.chunks[0];
      if (!head) {
        throw new Error('JSON-RPC buffer underflow');
      }
      if (head.length <= remaining) {
        parts.push(head);
        this.chunks.shift();
        this.bufferedLength -= head.length;
        remaining -= head.length;
      } else {
        parts.push(head.subarray(0, remaining));
        this.chunks[0] = head.subarray(remaining);
        this.bufferedLength -= remaining;
        remaining = 0;
      }
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, length);
  }

  private discardBytes(length: number): void {
    let remaining = length;
    while (remaining > 0) {
      const head = this.chunks[0];
      if (!head) {
        throw new Error('JSON-RPC buffer underflow');
      }
      if (head.length <= remaining) {
        this.chunks.shift();
        this.bufferedLength -= head.length;
        remaining -= head.length;
      } else {
        this.chunks[0] = head.subarray(remaining);
        this.bufferedLength -= remaining;
        remaining = 0;
      }
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
            error: { code: -32603, message: toErrorMessage(error) },
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
    this.chunks.length = 0;
    this.bufferedLength = 0;
    this.pendingBodyLength = undefined;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
