/**
 * Vitests for the LSP-style JSON-RPC pipeline. Uses an in-memory
 * `PassThrough` pair to feed bytes both ways without spawning anything.
 */
import { PassThrough } from 'node:stream';

import { it } from '@effect/vitest';
import { Effect, Fiber, Queue, Sink, Stream } from 'effect';
import { describe, expect, vi } from 'vitest';

import { makeJsonRpcConnection } from '@tools/lean/direct/jsonRpc';

/** The peer's output as chunks; the listeners go when the consumer does. */
const chunksOf = (stream: PassThrough) =>
  Stream.callback<Uint8Array>((queue) =>
    Effect.gen(function* () {
      const onData = (chunk: Uint8Array) => {
        Queue.offerUnsafe(queue, chunk);
      };
      stream.on('data', onData);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          stream.off('data', onData);
        }),
      );
    }),
  );

const makePair = Effect.gen(function* () {
  const serverIn = new PassThrough(); // what the client writes (i.e. the server reads)
  const serverOut = new PassThrough(); // what the server writes (i.e. the client reads)
  const notifications: Array<[method: string, params: unknown]> = [];
  const connection = yield* makeJsonRpcConnection({
    input: chunksOf(serverOut),
    output: Sink.forEach((chunk: Uint8Array) =>
      Effect.sync(() => {
        serverIn.write(chunk);
      }),
    ),
    onNotification: (method, params) =>
      Effect.sync(() => {
        notifications.push([method, params]);
      }),
  });
  let clientFrameBuffer = '';

  const serverSends = (json: unknown): void => {
    const body = Buffer.from(JSON.stringify(json), 'utf8');
    serverOut.write(`Content-Length: ${body.length}\r\n\r\n`);
    serverOut.write(body);
  };

  /** Wait until serverIn has data, then parse and return all LSP frames. */
  const collectClientFrames = Effect.promise(() =>
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
    ),
  );

  const notified = (expected: Array<[string, unknown]>) =>
    Effect.promise(() =>
      vi.waitFor(
        () => {
          expect(notifications).toEqual(expected);
        },
        { timeout: 2000, interval: 5 },
      ),
    );

  return { connection, serverOut, serverSends, collectClientFrames, notified };
});

describe('JsonRpcConnection', () => {
  it.effect(
    'emits a request frame with Content-Length and resolves on response',
    () =>
      Effect.gen(function* () {
        const { connection, serverSends, collectClientFrames } =
          yield* makePair;
        const pending = yield* Effect.forkChild(
          connection.request<{ ok: boolean }>('test/method', { x: 1 }),
        );
        const frames = yield* collectClientFrames;
        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
          jsonrpc: '2.0',
          method: 'test/method',
          params: { x: 1 },
        });
        const id = frames[0]?.id;
        expect(typeof id).toBe('number');

        serverSends({ jsonrpc: '2.0', id, result: { ok: true } });
        expect(yield* Fiber.join(pending)).toEqual({ ok: true });
      }),
  );

  it.effect('fails the request when the server returns an error', () =>
    Effect.gen(function* () {
      const { connection, serverSends, collectClientFrames } = yield* makePair;
      const pending = yield* Effect.forkChild(
        Effect.flip(connection.request('boom')),
      );
      const frames = yield* collectClientFrames;
      serverSends({
        jsonrpc: '2.0',
        id: frames[0]?.id,
        error: { code: -32601, message: 'unknown method' },
      });
      const error = yield* Fiber.join(pending);
      expect(error).toMatchObject({
        _tag: 'JsonRpcRequestError',
        method: 'boom',
        code: -32601,
      });
      expect(error.message).toContain('unknown method');
    }),
  );

  it.effect('routes notifications from the server to the handler', () =>
    Effect.gen(function* () {
      const { serverSends, notified } = yield* makePair;
      serverSends({
        jsonrpc: '2.0',
        method: 'window/logMessage',
        params: { type: 3, message: 'hello' },
      });
      yield* notified([['window/logMessage', { type: 3, message: 'hello' }]]);
    }),
  );

  it.effect(
    'reassembles a frame whose body arrives across multiple chunks',
    () =>
      Effect.gen(function* () {
        const { serverOut, notified } = yield* makePair;
        const body = Buffer.from(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'split',
            params: { ok: true },
          }),
          'utf8',
        );
        serverOut.write(`Content-Length: ${body.length}\r\n\r\n`);
        serverOut.write(body.subarray(0, 5));
        serverOut.write(body.subarray(5));
        yield* notified([['split', { ok: true }]]);
      }),
  );

  it.effect(
    'reassembles a frame whose header arrives across multiple chunks',
    () =>
      Effect.gen(function* () {
        const { serverOut, notified } = yield* makePair;
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
        yield* notified([['split-header', { ok: true }]]);
      }),
  );

  it.effect('reassembles two frames written back-to-back', () =>
    Effect.gen(function* () {
      const { serverSends, notified } = yield* makePair;
      serverSends({ jsonrpc: '2.0', method: 'a', params: 1 });
      serverSends({ jsonrpc: '2.0', method: 'b', params: 2 });
      yield* notified([
        ['a', 1],
        ['b', 2],
      ]);
    }),
  );

  it.effect('fails pending and later requests with the close reason', () =>
    Effect.gen(function* () {
      const { connection, collectClientFrames } = yield* makePair;
      const pending = yield* Effect.forkChild(
        Effect.flip(connection.request('never')),
      );
      yield* collectClientFrames;
      yield* connection.close('test teardown');
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: 'JsonRpcConnectionDisposed',
        message: 'test teardown',
      });
      expect(yield* Effect.flip(connection.request('late'))).toMatchObject({
        _tag: 'JsonRpcConnectionDisposed',
        message: 'test teardown',
      });
    }),
  );
});
