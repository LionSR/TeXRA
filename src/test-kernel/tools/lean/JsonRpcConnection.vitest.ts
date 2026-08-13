/**
 * Vitests for the LSP-style JSON-RPC framer. Uses an in-memory
 * `PassThrough` pair to feed bytes both ways without spawning anything.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { JsonRpcConnection } from '@tools/lean/direct/jsonRpc';

function makePair(): {
  connection: JsonRpcConnection;
  serverOut: PassThrough;
  serverSends: (json: unknown) => void;
  collectClientFrames: () => Promise<Record<string, unknown>[]>;
} {
  const serverIn = new PassThrough(); // what the client writes (i.e. the server reads)
  const serverOut = new PassThrough(); // what the server writes (i.e. the client reads)
  const connection = new JsonRpcConnection(serverIn, serverOut);
  let clientFrameBuffer = '';

  const serverSends = (json: unknown): void => {
    const body = Buffer.from(JSON.stringify(json), 'utf8');
    serverOut.write(`Content-Length: ${body.length}\r\n\r\n`);
    serverOut.write(body);
  };

  /** Wait until serverIn has data, then parse and return all LSP frames. */
  const collectClientFrames = () =>
    vi.waitFor(
      (): Record<string, unknown>[] => {
        let raw = serverIn.read() as Buffer | string | null;
        while (raw) {
          clientFrameBuffer += Buffer.isBuffer(raw)
            ? raw.toString('utf8')
            : raw;
          raw = serverIn.read() as Buffer | string | null;
        }
        if (!clientFrameBuffer) throw new Error('no data in serverIn yet');
        const frames: Record<string, unknown>[] = [];
        let offset = 0;
        while (offset < clientFrameBuffer.length) {
          const headerEnd = clientFrameBuffer.indexOf('\r\n\r\n', offset);
          if (headerEnd < 0) break;
          const header = clientFrameBuffer.slice(offset, headerEnd);
          const lengthMatch = header.match(/Content-Length: (\d+)/i);
          if (!lengthMatch) break;
          const length = Number.parseInt(lengthMatch[1]!, 10);
          const bodyStart = headerEnd + 4;
          const bodyEnd = bodyStart + length;
          if (clientFrameBuffer.length < bodyEnd) break;
          const body = clientFrameBuffer.slice(bodyStart, bodyEnd);
          frames.push(JSON.parse(body) as Record<string, unknown>);
          offset = bodyEnd;
        }
        if (frames.length === 0) throw new Error('no complete frames yet');
        clientFrameBuffer = clientFrameBuffer.slice(offset);
        return frames;
      },
      { timeout: 500, interval: 5 },
    );

  return {
    connection,
    serverOut,
    serverSends,
    collectClientFrames,
  };
}

describe('JsonRpcConnection', () => {
  it('emits a request frame with Content-Length and resolves on response', async () => {
    const { connection, serverSends, collectClientFrames } = makePair();
    const pending = connection.request<{ ok: boolean }>('test/method', {
      x: 1,
    });
    const frames = await collectClientFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'test/method',
      params: { x: 1 },
    });
    const id = frames[0]?.id;
    expect(typeof id).toBe('number');

    serverSends({ jsonrpc: '2.0', id, result: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('rejects when the server returns an error', async () => {
    const { connection, serverSends, collectClientFrames } = makePair();
    const pending = connection.request('boom').catch((err: Error) => err);
    const frames = await collectClientFrames();
    serverSends({
      jsonrpc: '2.0',
      id: frames[0]?.id,
      error: { code: -32601, message: 'unknown method' },
    });
    const err = await pending;
    expect(err).toBeInstanceOf(Error);
    // vscode-jsonrpc surfaces the code on the ResponseError object separately
    // from the message string.
    expect((err as Error).message).toContain('unknown method');
    expect((err as { code?: number }).code).toBe(-32601);
  });

  it('routes notifications from the server to subscribed handlers', async () => {
    const { connection, serverSends } = makePair();
    const handler = vi.fn();
    connection.onNotification('window/logMessage', handler);

    serverSends({
      jsonrpc: '2.0',
      method: 'window/logMessage',
      params: { type: 3, message: 'hello' },
    });

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledWith({ type: 3, message: 'hello' });
    });
  });

  it('reassembles a frame whose body arrives across multiple chunks', async () => {
    const { connection, serverOut } = makePair();
    const handler = vi.fn();
    connection.onNotification('split', handler);

    const body = Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', method: 'split', params: { ok: true } }),
      'utf8',
    );
    serverOut.write(`Content-Length: ${body.length}\r\n\r\n`);
    serverOut.write(body.slice(0, 5));
    serverOut.write(body.slice(5));

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledWith({ ok: true });
    });
  });

  it('reassembles a frame whose header arrives across multiple chunks', async () => {
    const { connection, serverOut } = makePair();
    const handler = vi.fn();
    connection.onNotification('split-header', handler);

    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'split-header',
        params: { ok: true },
      }),
      'utf8',
    );
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`);
    serverOut.write(header.subarray(0, 6));
    serverOut.write(header.subarray(6));
    serverOut.write(body);

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledWith({ ok: true });
    });
  });

  it('reassembles two frames written back-to-back', async () => {
    const { connection, serverSends } = makePair();
    const a = vi.fn();
    const b = vi.fn();
    connection.onNotification('a', a);
    connection.onNotification('b', b);

    serverSends({ jsonrpc: '2.0', method: 'a', params: 1 });
    serverSends({ jsonrpc: '2.0', method: 'b', params: 2 });

    await vi.waitFor(() => {
      expect(a).toHaveBeenCalledWith(1);
      expect(b).toHaveBeenCalledWith(2);
    });
  });

  it('replies to server-to-client requests via the registered handler', async () => {
    const { connection, serverSends, collectClientFrames } = makePair();
    connection.onServerRequest('client/echo', async (params) => params);

    serverSends({
      jsonrpc: '2.0',
      id: 99,
      method: 'client/echo',
      params: { hello: 'world' },
    });

    const frames = await collectClientFrames();
    expect(frames).toEqual([
      {
        jsonrpc: '2.0',
        id: 99,
        result: { hello: 'world' },
      },
    ]);
  });

  it('rejects pending requests when the connection is disposed', async () => {
    const { connection } = makePair();
    const pending = connection.request('never').catch((err: Error) => err);
    connection.dispose('test teardown');
    const err = await pending;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('test teardown');
  });
});
