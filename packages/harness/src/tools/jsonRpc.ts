/**
 * JSON-RPC 2.0 over a byte stream and a byte sink, in one of two framings:
 * LSP's `Content-Length: <n>\r\n\r\n<json>` (a language server) or
 * one message per line (an MCP server's stdio transport).
 *
 * Inbound bytes run through the frame decoder (`Stream.mapAccumEffect` over a
 * byte buffer) and are routed: responses complete the `Deferred` registered
 * per request id, notifications go to the owner's handler, and a request the
 * peer sends us is answered by the owner's `onRequest` or refused with
 * `MethodNotFound`. Outbound frames are queued to the sink by a writer
 * fiber. Both fibers live in the connection's scope.
 *
 * The connection has one terminal state: `close(reason)` fails every pending
 * request with {@link JsonRpcConnectionDisposed} carrying that reason, drops
 * later notifications, and refuses later requests. The scope's finalizer
 * closes with a generic reason; the owner with the peer's end when it knows
 * it; a writer failure (stdin gone) with the failure. Ending of the input
 * stream alone does not close: a child process's exit can precede the end of
 * its output, so {@link connectJsonRpcProcess} closes on the exit once every
 * answer written was read, and a writer failure waits for the same (2s at
 * most).
 */

import { Buffer } from 'node:buffer';

import {
  type Cause,
  Deferred,
  type Duration,
  Effect,
  Exit,
  Fiber,
  type PlatformError,
  Queue,
  Ref,
  type Result,
  Schema,
  type Sink,
  Stream,
} from 'effect';
import type { ChildProcessSpawner } from 'effect/process';

import { withLogChannel } from '@logger/effectLog';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { appendTail } from '@utils/text/appendTail';

const CHANNEL = 'JsonRpcConnection';

const METHOD_NOT_FOUND = -32601;

/** The connection was closed; `message` is the closer's reason. */
export class JsonRpcConnectionDisposed extends Schema.TaggedError<JsonRpcConnectionDisposed>()(
  'JsonRpcConnectionDisposed',
  { message: Schema.String },
) {}

/**
 * The peer answered a request with a JSON-RPC error. `code` is the JSON-RPC
 * error code the peer sent.
 */
export class JsonRpcRequestError extends Schema.TaggedError<JsonRpcRequestError>()(
  'JsonRpcRequestError',
  {
    method: Schema.String,
    message: Schema.String,
    code: Schema.optional(Schema.Number),
    cause: Schema.Defect(),
  },
) {}

/** The peer sent bytes that are not an LSP frame. Ends the reader. */
class JsonRpcFrameError extends Schema.TaggedError<JsonRpcFrameError>()(
  'JsonRpcFrameError',
  { message: Schema.String },
) {}

export interface JsonRpcConnection {
  readonly request: (
    method: string,
    params?: unknown,
  ) => Effect.Effect<unknown, JsonRpcRequestError | JsonRpcConnectionDisposed>;
  /** Send a notification; after `close` it is dropped. */
  readonly notify: (method: string, params?: unknown) => Effect.Effect<void>;
  /** Fail every pending request with `reason` and refuse later ones. Idempotent. */
  readonly close: (reason: string) => Effect.Effect<void>;
}

/** What {@link makeJsonRpcConnection} connects: the peer's byte streams,
 *  their framing, and the owner's handlers. */
export interface JsonRpcConnectionOptions {
  /** The peer's output: bytes we decode. */
  readonly input: Stream.Stream<Uint8Array, Error>;
  /** The peer's input: bytes we encode. */
  readonly output: Sink.Sink<void, Uint8Array, never, Error>;
  readonly onNotification: (
    method: string,
    params: unknown,
  ) => Effect.Effect<void>;
  /**
   * `'content-length'` (the default): LSP frames. `'newline'`: one JSON
   * message per line, no embedded newlines (MCP stdio).
   */
  readonly framing?: 'content-length' | 'newline';
  /**
   * The result of a request the peer sends us, or `undefined` to refuse it
   * with `MethodNotFound`.
   */
  readonly onRequest?: (
    method: string,
    params: unknown,
  ) => Effect.Effect<unknown> | undefined;
  /** The notification telling the peer we stopped waiting for unanswered
   *  request `id` (its caller was interrupted, a timeout too). */
  cancel?(
    id: number,
    method: string,
  ): { readonly method: string; readonly params: unknown } | undefined;
}

type PendingError = JsonRpcRequestError | JsonRpcConnectionDisposed;

/** The reason the connection closed with, and the requests awaiting an
 *  answer by id. */
interface ConnectionState {
  readonly closed: string | undefined;
  readonly lastId: number;
  readonly pending: ReadonlyMap<number, PendingRequest>;
}

/** A request's place in the table, or the reason the connection closed with. */
type Registered =
  | {
      readonly id: number;
      readonly deferred: Deferred.Deferred<unknown, PendingError>;
    }
  | { readonly closed: string };

interface PendingRequest {
  readonly method: string;
  readonly deferred: Deferred.Deferred<unknown, PendingError>;
}

const JsonRpcBodySchema = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optional(
      Schema.NullOr(Schema.Union([Schema.Number, Schema.String])),
    ),
    method: Schema.optional(Schema.String),
    params: Schema.optional(Schema.Unknown),
    result: Schema.optional(Schema.Unknown),
    error: Schema.optional(
      Schema.Struct({
        code: Schema.optional(Schema.Number),
        message: Schema.optional(Schema.String),
        data: Schema.optional(Schema.Unknown),
      }),
    ),
  }),
);
type JsonRpcMessage = typeof JsonRpcBodySchema.Type;

const CONTENT_LENGTH = /Content-Length:\s*(\d+)/i;
const HEADER_END = '\r\n\r\n';
/** The longest line a newline-framed peer may send before the reader gives up. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

/** The unconsumed tail of a buffer and the messages split off its front. */
type Decoded = Effect.Effect<
  readonly [rest: Buffer, messages: ReadonlyArray<JsonRpcMessage>],
  JsonRpcFrameError
>;

function encodeFrame(message: object): Uint8Array {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}${HEADER_END}`, 'ascii'),
    body,
  ]);
}

/** Split complete frames off the front of `buffer`, parsing their bodies. */
const takeFrames = (buffer: Buffer): Decoded =>
  Effect.gen(function* () {
    const messages: JsonRpcMessage[] = [];
    let rest = buffer;
    for (;;) {
      const headerEnd = rest.indexOf(HEADER_END);
      if (headerEnd < 0) break;
      const header = rest.subarray(0, headerEnd).toString('ascii');
      const length = CONTENT_LENGTH.exec(header)?.[1];
      if (length === undefined) {
        return yield* new JsonRpcFrameError({
          message: `Frame header without Content-Length: ${header}`,
        });
      }
      const bodyStart = headerEnd + HEADER_END.length;
      const bodyEnd = bodyStart + Number.parseInt(length, 10);
      if (rest.length < bodyEnd) break;
      messages.push(
        yield* parseBody(rest.subarray(bodyStart, bodyEnd).toString('utf8')),
      );
      rest = rest.subarray(bodyEnd);
    }
    // Copy the tail so the consumed prefix is not retained by the slice.
    return [Buffer.from(rest), messages] as const;
  });

function encodeLine(message: object): Uint8Array {
  return Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
}

const parseBody = (
  body: string,
): Effect.Effect<JsonRpcMessage, JsonRpcFrameError> =>
  Schema.decodeEffect(JsonRpcBodySchema)(body).pipe(
    Effect.mapError(
      (error) =>
        new JsonRpcFrameError({
          message: `Frame body is not a JSON-RPC message: ${body.slice(0, 200)}\n${error.message}`,
        }),
    ),
  );

/** Split complete lines off the front of `buffer`, parsing each non-blank one. */
const takeLines = (buffer: Buffer): Decoded =>
  Effect.gen(function* () {
    const messages: JsonRpcMessage[] = [];
    let rest = buffer;
    for (;;) {
      const end = rest.indexOf(0x0a);
      if (end < 0) break;
      const line = rest.subarray(0, end).toString('utf8').trim();
      if (line) messages.push(yield* parseBody(line));
      rest = rest.subarray(end + 1);
    }
    if (rest.length > MAX_LINE_BYTES) {
      return yield* new JsonRpcFrameError({
        message: `Message exceeds ${MAX_LINE_BYTES} bytes without a newline`,
      });
    }
    return [Buffer.from(rest), messages] as const;
  });

export const makeJsonRpcConnection = Effect.fn('JsonRpc.make')(function* (
  options: JsonRpcConnectionOptions,
) {
  // One state, so a request registers and a close drains in one step each:
  // no request can be inserted behind a close that already drained.
  const state = yield* Ref.make<ConnectionState>({
    closed: undefined,
    lastId: 0,
    pending: new Map(),
  });
  const closedReason = Effect.map(Ref.get(state), ({ closed }) => closed);
  const outbound = yield* Queue.make<Uint8Array, Cause.Done>();
  const inputDone = yield* Deferred.make<void>();
  const newline = options.framing === 'newline';
  const encode = newline ? encodeLine : encodeFrame;
  const decode = newline ? takeLines : takeFrames;

  const close = Effect.fn('JsonRpc.close')(function* (reason: string) {
    const waiting = yield* Ref.modify(state, (current) =>
      current.closed === undefined
        ? [current.pending, { ...current, closed: reason, pending: new Map() }]
        : [undefined, current],
    );
    if (waiting === undefined) return;
    yield* Queue.end(outbound);
    for (const { deferred } of waiting.values()) {
      yield* Deferred.fail(
        deferred,
        new JsonRpcConnectionDisposed({ message: reason }),
      );
    }
  });

  /** Queue a frame; a frame offered after the queue ended is dropped. */
  const send = (message: object): Effect.Effect<void> =>
    Effect.asVoid(Queue.offer(outbound, encode(message)));

  const takePending = (id: number) =>
    Ref.modify(state, (current) => {
      const entry = current.pending.get(id);
      if (!entry) return [undefined, current];
      const pending = new Map(current.pending);
      pending.delete(id);
      return [entry, { ...current, pending }];
    });

  const dispatch = Effect.fn('JsonRpc.dispatch')(function* (
    message: JsonRpcMessage,
  ) {
    if (message.method === undefined) {
      if (typeof message.id !== 'number') {
        yield* Effect.logDebug(
          `Ignoring message without method or numeric id`,
        ).pipe(withLogChannel(CHANNEL));
        return;
      }
      const entry = yield* takePending(message.id);
      if (!entry) {
        yield* Effect.logDebug(
          `Response for unknown request id ${message.id}`,
        ).pipe(withLogChannel(CHANNEL));
        return;
      }
      yield* message.error
        ? Deferred.fail(
            entry.deferred,
            new JsonRpcRequestError({
              method: entry.method,
              message: message.error.message ?? 'JSON-RPC error',
              code: message.error.code,
              cause: message.error,
            }),
          )
        : Deferred.succeed(entry.deferred, message.result);
      return;
    }
    if (message.id != null) {
      // A request from the peer: the owner's answer, else refused.
      const answer = options.onRequest?.(message.method, message.params);
      if (answer) {
        yield* send({ jsonrpc: '2.0', id: message.id, result: yield* answer });
        return;
      }
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
      Effect.catch(
        Effect.fnUntraced(function* (error) {
          if ((yield* closedReason) === undefined) {
            yield* Effect.logDebug(
              `stdin write failed: ${toErrorMessage(error)}`,
            ).pipe(withLogChannel(CHANNEL));
          }
          yield* Effect.timeoutOption(Deferred.await(inputDone), '2 seconds');
          yield* close(`JSON-RPC output failed: ${toErrorMessage(error)}`);
        }),
      ),
    ),
  );
  yield* Effect.forkScoped(
    options.input.pipe(
      Stream.mapAccumEffect(
        (): Buffer => Buffer.alloc(0),
        (buffer, chunk) => decode(Buffer.concat([buffer, chunk])),
      ),
      Stream.runForEach(dispatch),
      Effect.catch(
        Effect.fnUntraced(function* (error) {
          if ((yield* closedReason) === undefined) {
            yield* Effect.logDebug(
              `connection error: ${toErrorMessage(error)}`,
            ).pipe(withLogChannel(CHANNEL));
          }
          yield* close(`JSON-RPC input failed: ${toErrorMessage(error)}`);
        }),
      ),
      Effect.ensuring(Deferred.succeed(inputDone, undefined)),
    ),
  );
  // Registered after the fibers, so it runs before they are interrupted:
  // every pending request is failed with a reason, never left to the
  // interruption of its reader.
  yield* Effect.addFinalizer(() => close('JsonRpcConnection disposed'));

  const notify = Effect.fn('JsonRpc.notify')(function* (
    method: string,
    params?: unknown,
  ) {
    if ((yield* closedReason) !== undefined) return;
    yield* send({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined && { params }),
    });
  });

  const request = Effect.fn('JsonRpc.request')(function* (
    method: string,
    params?: unknown,
  ) {
    // The entry is in the table from here until the request ends, however
    // it ends: an answer or `close` takes it, and any other exit takes it
    // here, telling the peer a call it interrupted is no longer wanted.
    return yield* Effect.acquireUseRelease(
      Effect.flatMap(Deferred.make<unknown, PendingError>(), (deferred) =>
        Ref.modify(state, (current): readonly [Registered, ConnectionState] => {
          if (current.closed !== undefined)
            return [{ closed: current.closed }, current];
          const id = current.lastId + 1;
          const pending = new Map(current.pending).set(id, {
            method,
            deferred,
          });
          return [
            { id, deferred },
            { ...current, lastId: id, pending },
          ];
        }),
      ),
      (entry) =>
        'closed' in entry
          ? Effect.fail(
              new JsonRpcConnectionDisposed({ message: entry.closed }),
            )
          : Effect.andThen(
              send({
                jsonrpc: '2.0',
                id: entry.id,
                method,
                ...(params !== undefined && { params }),
              }),
              Deferred.await(entry.deferred),
            ),
      (entry, exit) =>
        'closed' in entry
          ? Effect.void
          : Effect.flatMap(takePending(entry.id), (waiting) => {
              const notice =
                waiting && Exit.hasInterrupts(exit)
                  ? options.cancel?.(entry.id, method)
                  : undefined;
              return notice
                ? notify(notice.method, notice.params)
                : Effect.void;
            }),
    );
  });

  const connection: JsonRpcConnection = { request, notify, close };
  return { connection, inputEnded: Deferred.await(inputDone) };
});

/** How a child process's connection is made and what its end says. */
export interface JsonRpcProcessOptions extends Omit<
  JsonRpcConnectionOptions,
  'input' | 'output'
> {
  /** How much of the end of the process's stderr `end` is given. */
  readonly stderrTailLimit: number;
  /** Each piece of stderr as it arrives. */
  readonly onStderr?: (text: string) => Effect.Effect<void>;
  /** How long the close waits, after the exit, for the process's output to
   *  be read: a grandchild may hold the pipes open. */
  readonly drainTimeout: Duration.Input;
  /** The reason the connection closes with, from the process's exit (a
   *  failure when a signal ended it) and the end of its stderr. */
  readonly end: (
    exit: Result.Result<
      ChildProcessSpawner.ExitCode,
      PlatformError.PlatformError
    >,
    stderrTail: string,
  ) => Effect.Effect<string>;
}

/**
 * A JSON-RPC connection over a child process's stdio, closed with the
 * owner's reason once the process has exited. The exit can precede the end
 * of its output, so the close waits for stdout and stderr to be read: a
 * reply already written still reaches its request instead of failing as
 * disposed. `exited` holds the exit from then on.
 */
export const connectJsonRpcProcess = Effect.fn('JsonRpc.process')(function* (
  handle: ChildProcessSpawner.ChildProcessHandle,
  options: JsonRpcProcessOptions,
) {
  const tail = yield* Ref.make('');
  const stderrRead = yield* Effect.forkScoped(
    handle.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((text) =>
        Effect.andThen(
          options.onStderr?.(text) ?? Effect.void,
          Ref.update(tail, (current) =>
            appendTail(current, text, options.stderrTailLimit),
          ),
        ),
      ),
      Effect.ignore,
    ),
  );
  const { connection, inputEnded } = yield* makeJsonRpcConnection({
    ...options,
    input: handle.stdout,
    output: handle.stdin,
  });
  const exited =
    yield* Deferred.make<
      Result.Result<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>
    >();
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      const exit = yield* Effect.result(handle.exitCode);
      yield* Effect.all([inputEnded, Fiber.await(stderrRead)], {
        concurrency: 'unbounded',
      }).pipe(Effect.timeoutOption(options.drainTimeout));
      yield* connection.close(yield* options.end(exit, yield* Ref.get(tail)));
      yield* Deferred.succeed(exited, exit);
    }),
  );
  return { connection, exited };
});
