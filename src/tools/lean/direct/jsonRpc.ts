/**
 * LSP-style JSON-RPC over a byte stream and a byte sink.
 *
 * The Lean language server speaks the standard LSP wire format:
 * `Content-Length: <n>\r\n\r\n<json>`. Inbound bytes run through a
 * `Content-Length` frame decoder (`Stream.mapAccumEffect` over a byte
 * buffer) and are routed: responses complete the `Deferred` registered per
 * request id, notifications go to the owner's handler, and a request the
 * peer sends us is refused with `MethodNotFound`. Outbound frames are queued
 * to the sink by a writer fiber. Both fibers live in the connection's scope.
 *
 * The connection has one terminal state: `close(reason)` fails every pending
 * request with {@link JsonRpcConnectionDisposed} carrying that reason, drops
 * later notifications, and refuses later requests. The scope's finalizer
 * closes with a generic reason; a writer failure (the peer's stdin is gone)
 * closes with the failure; the owner closes with the peer's end when it
 * knows it. Ending of the input stream alone does not close: the owner sees
 * the process end right after and closes with the better reason.
 */

import { Buffer } from 'node:buffer';

import {
  type Cause,
  Data,
  Deferred,
  Effect,
  Queue,
  Ref,
  type Sink,
  Stream,
} from 'effect';

import { createLog } from '@logger/logUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('JsonRpcConnection');

const METHOD_NOT_FOUND = -32601;

/** The connection was closed; `message` is the closer's reason. */
export class JsonRpcConnectionDisposed extends Data.TaggedError(
  'JsonRpcConnectionDisposed',
)<{ readonly message: string }> {}

/**
 * The peer answered a request with a JSON-RPC error. `code` is the JSON-RPC
 * error code the peer sent.
 */
export class JsonRpcRequestError extends Data.TaggedError(
  'JsonRpcRequestError',
)<{
  readonly method: string;
  readonly message: string;
  readonly code?: number;
  readonly cause: unknown;
}> {}

/** The peer sent bytes that are not an LSP frame. Ends the reader. */
class JsonRpcFrameError extends Data.TaggedError('JsonRpcFrameError')<{
  readonly message: string;
}> {}

export interface JsonRpcConnection {
  readonly request: <T>(
    method: string,
    params?: unknown,
  ) => Effect.Effect<T, JsonRpcRequestError | JsonRpcConnectionDisposed>;
  /** Send a notification; after `close` it is dropped. */
  readonly notify: (method: string, params?: unknown) => Effect.Effect<void>;
  /** Fail every pending request with `reason` and refuse later ones. Idempotent. */
  readonly close: (reason: string) => Effect.Effect<void>;
}

interface JsonRpcConnectionOptions {
  /** The peer's output: bytes we decode. */
  readonly input: Stream.Stream<Uint8Array, unknown>;
  /** The peer's input: bytes we encode. */
  readonly output: Sink.Sink<void, Uint8Array, never, unknown>;
  readonly onNotification: (
    method: string,
    params: unknown,
  ) => Effect.Effect<void>;
}

type PendingError = JsonRpcRequestError | JsonRpcConnectionDisposed;

interface PendingRequest {
  readonly method: string;
  readonly deferred: Deferred.Deferred<unknown, PendingError>;
}

interface JsonRpcMessage {
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { code?: number; message?: string; data?: unknown };
}

const CONTENT_LENGTH = /Content-Length:\s*(\d+)/i;
const HEADER_END = '\r\n\r\n';

function encodeFrame(message: object): Uint8Array {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}${HEADER_END}`, 'ascii'),
    body,
  ]);
}

/** Split complete frames off the front of `buffer`, parsing their bodies. */
const takeFrames = (
  buffer: Buffer,
): Effect.Effect<
  readonly [rest: Buffer, messages: ReadonlyArray<JsonRpcMessage>],
  JsonRpcFrameError
> =>
  Effect.gen(function* () {
    const messages: JsonRpcMessage[] = [];
    let rest = buffer;
    for (;;) {
      const headerEnd = rest.indexOf(HEADER_END);
      if (headerEnd < 0) break;
      const header = rest.subarray(0, headerEnd).toString('ascii');
      const match = CONTENT_LENGTH.exec(header);
      if (!match) {
        return yield* new JsonRpcFrameError({
          message: `Frame header without Content-Length: ${header}`,
        });
      }
      const bodyStart = headerEnd + HEADER_END.length;
      const bodyEnd = bodyStart + Number.parseInt(match[1]!, 10);
      if (rest.length < bodyEnd) break;
      const body = rest.subarray(bodyStart, bodyEnd).toString('utf8');
      messages.push(
        yield* Effect.try({
          try: (): JsonRpcMessage => JSON.parse(body) as JsonRpcMessage,
          catch: (error) =>
            new JsonRpcFrameError({
              message: `Frame body is not JSON: ${toErrorMessage(error)}`,
            }),
        }),
      );
      rest = rest.subarray(bodyEnd);
    }
    // Copy the tail so the consumed prefix is not retained by the slice.
    return [Buffer.from(rest), messages] as const;
  });

export const makeJsonRpcConnection = Effect.fn('JsonRpc.make')(function* (
  options: JsonRpcConnectionOptions,
) {
  const pending = yield* Ref.make<ReadonlyMap<number, PendingRequest>>(
    new Map(),
  );
  const ids = yield* Ref.make(0);
  const closedReason = yield* Ref.make<string | undefined>(undefined);
  const outbound = yield* Queue.make<Uint8Array, Cause.Done>();

  const close = Effect.fn('JsonRpc.close')(function* (reason: string) {
    const first = yield* Ref.modify(
      closedReason,
      (current) => [current === undefined, current ?? reason] as const,
    );
    if (!first) return;
    yield* Queue.end(outbound);
    const waiting = yield* Ref.getAndSet(pending, new Map());
    for (const { deferred } of waiting.values()) {
      yield* Deferred.fail(
        deferred,
        new JsonRpcConnectionDisposed({ message: reason }),
      );
    }
  });

  /** Queue a frame; a frame offered after the queue ended is dropped. */
  const send = (message: object): Effect.Effect<void> =>
    Effect.asVoid(Queue.offer(outbound, encodeFrame(message)));

  const takePending = (id: number) =>
    Ref.modify(pending, (map) => {
      const entry = map.get(id);
      if (!entry) return [undefined, map] as const;
      const next = new Map(map);
      next.delete(id);
      return [entry, next] as const;
    });

  const dispatch = Effect.fn('JsonRpc.dispatch')(function* (
    message: JsonRpcMessage,
  ) {
    if (message.method === undefined) {
      if (typeof message.id !== 'number') {
        log.debug(`Ignoring message without method or numeric id`);
        return;
      }
      const entry = yield* takePending(message.id);
      if (!entry) {
        log.debug(`Response for unknown request id ${message.id}`);
        return;
      }
      if (message.error) {
        yield* Deferred.fail(
          entry.deferred,
          new JsonRpcRequestError({
            method: entry.method,
            message: message.error.message ?? 'JSON-RPC error',
            code: message.error.code,
            cause: message.error,
          }),
        );
      } else {
        yield* Deferred.succeed(entry.deferred, message.result);
      }
      return;
    }
    if (message.id != null) {
      // A request from the peer: we serve none.
      yield* send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: METHOD_NOT_FOUND,
          message: `Method not found: ${message.method}`,
        },
      });
      return;
    }
    yield* options.onNotification(message.method, message.params);
  });

  yield* Effect.forkScoped(
    Stream.fromQueue(outbound).pipe(
      Stream.run(options.output),
      Effect.catch((error) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(closedReason)) === undefined) {
            log.debug(`stdin write failed: ${toErrorMessage(error)}`);
          }
          yield* close(`JSON-RPC output failed: ${toErrorMessage(error)}`);
        }),
      ),
    ),
  );
  yield* Effect.forkScoped(
    options.input.pipe(
      Stream.mapAccumEffect(
        (): Buffer => Buffer.alloc(0),
        (buffer, chunk) => takeFrames(Buffer.concat([buffer, chunk])),
      ),
      Stream.runForEach(dispatch),
      Effect.catch((error) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(closedReason)) === undefined) {
            log.debug(`connection error: ${toErrorMessage(error)}`);
          }
          yield* close(`JSON-RPC input failed: ${toErrorMessage(error)}`);
        }),
      ),
    ),
  );
  // Registered after the fibers, so it runs before they are interrupted:
  // every pending request is failed with a reason, never left to the
  // interruption of its reader.
  yield* Effect.addFinalizer(() => close('JsonRpcConnection disposed'));

  const request = Effect.fn('JsonRpc.request')(function* <T>(
    method: string,
    params?: unknown,
  ) {
    const reason = yield* Ref.get(closedReason);
    if (reason !== undefined) {
      return yield* new JsonRpcConnectionDisposed({ message: reason });
    }
    const id = yield* Ref.updateAndGet(ids, (n) => n + 1);
    const deferred = yield* Deferred.make<unknown, PendingError>();
    yield* Ref.update(pending, (map) =>
      new Map(map).set(id, { method, deferred }),
    );
    // `close` fails the table it drained, so a close that landed between the
    // check above and this insert leaves this entry with nobody to fail it and
    // no frame on the wire: re-read and fail it here rather than await forever.
    const closedSince = yield* Ref.get(closedReason);
    if (closedSince !== undefined) {
      yield* takePending(id);
      return yield* new JsonRpcConnectionDisposed({ message: closedSince });
    }
    yield* send({
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined && { params }),
    });
    const result = yield* Deferred.await(deferred).pipe(
      Effect.onInterrupt(() => takePending(id)),
    );
    return result as T;
  });

  const notify = Effect.fn('JsonRpc.notify')(function* (
    method: string,
    params?: unknown,
  ) {
    if ((yield* Ref.get(closedReason)) !== undefined) return;
    yield* send({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined && { params }),
    });
  });

  const connection: JsonRpcConnection = { request, notify, close };
  return connection;
});
