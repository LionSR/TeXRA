/**
 * Vitests for the LSP-style JSON-RPC pipeline. Uses an in-memory
 * `PassThrough` pair to feed bytes both ways without spawning anything.
 */
import { PassThrough } from 'node:stream';

import { it } from '@effect/vitest';
import { Effect, Fiber, Queue, Sink, Stream } from 'effect';
import { describe, expect } from 'vitest';

import { makeJsonRpcConnection } from '@tools/jsonRpc';

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
  const serverOut = new PassThrough(); // what the server writes (i.e. the client reads)
  const clientBytes = yield* Queue.make<Uint8Array>();
  const notifications = yield* Queue.make<readonly [string, unknown]>();
  const connection = yield* makeJsonRpcConnection({
    input: chunksOf(serverOut),
    output: Sink.forEach((chunk: Uint8Array) =>
      Queue.offer(clientBytes, chunk),
    ),
    onNotification: (method, params) =>
      Queue.offer(notifications, [method, params]),
  });
  let clientFrameBuffer = '';

  const serverSends = (json: unknown): void => {
    const body = Buffer.from(JSON.stringify(json), 'utf8');
    serverOut.write(`Content-Length: ${body.length}\r\n\r\n`);
    serverOut.write(body);
  };

  /** Parse as many complete LSP frames as the buffer currently holds. */
  function parseFrames(): Record<string, unknown>[] {
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
    clientFrameBuffer = clientFrameBuffer.slice(offset);
    return frames;
  }

  /** Take client bytes until at least one complete LSP frame parses out. */
  const collectClientFrames = Effect.gen(function* () {
    for (;;) {
      const frames = parseFrames();
      if (frames.length > 0) return frames;
      clientFrameBuffer += Buffer.from(yield* Queue.take(clientBytes)).toString(
        'utf8',
      );
    }
  });

  const notified = (expected: Array<[string, unknown]>) =>
    Effect.gen(function* () {
      expect(
        yield* Effect.forEach(expected, () => Queue.take(notifications)),
      ).toEqual(expected);
    });

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
