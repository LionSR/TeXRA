/**
 * The webview side of the events transport: the decoder that turns host-bridge messages into frame
 * deliveries, request responses, and surface actions, and the signals the
 * root reads. The runtime and the per-session graphs are
 * `webviewSessionLayer`'s; the rest of the frontend reads signals and posts
 * `UpMessage`s, and nothing else touches the session layer. The host names
 * the pipe `UpMessage`s leave by and hands every message that arrives on
 * its session channel to `receive`: the extension's window carries nothing
 * else, and the desktop's session channel is its own.
 */
import {
  Deferred,
  Effect,
  Exit,
  Queue,
  Result,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import {
  Rejected,
  qualifyAggregateId,
  type OutcomeSchema,
  type RunId,
} from '@texra-ai/harness/schemas';
import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import {
  DownMessageSchema,
  type DownMessage,
  type EventsFrame,
  type HostFrame,
  type HostOutcome,
  type Response,
  type Subscribe,
  type UpMessage,
} from '@texra/shared/session/sessionFrames';
import type { SurfaceAction } from '@texra/shared/session/surface';
import { toSignal, type StreamSignal } from '@texra/shared/signals';
import {
  installWebviewRuntime,
  WebviewSessions,
} from '@texra/shared/session/webviewSessionLayer';
import type { SessionView } from '@texra-ai/harness/schemas';
import { Invalid, type BridgeError } from '@texra/shared/session/bridgeErrors';
import { requestErrorText } from '@ui/copy/requestErrors';

/** One session's graph as `WebviewSessions.open` hands it out. */
type WebviewGraph = Effect.Success<ReturnType<typeof WebviewSessions.open>>;

/** What the transport hands the surfaces: the host's `surface.action`, or
 *  its own report of a frame it could not read. */
type WireSurfaceAction =
  | Extract<DownMessage, { kind: 'surface.action' }>['action']
  | Extract<SurfaceAction, { kind: 'reportError' }>;

/** The shell is the one port of a webview graph. */
const SHELL_PORT = 'shell';

/** One open session: its two levels as signals and its `Subscribe`. */
export interface WebviewSession {
  readonly key: string;
  readonly view$: StreamSignal<SessionView>;
  /** Null until the first frame carries the host's snapshot. */
  readonly host$: StreamSignal<HostSnapshot | null>;
  /** Frames of another generation are dropped by the frames service (8.1). */
  generation: number;
}

export interface WebviewTransport {
  /** One message from the host's session channel. */
  receive(data: unknown): void;
  /** Open (or reuse) a session's graph. */
  open(session: string): WebviewSession;
  /** A new generation over the named transcript aggregates. */
  subscribe(session: WebviewSession, aggregates: Subscribe['aggregates']): void;
  /** Answered by the `runtime.response` of its session under its id. Run
   *  it with {@link run}: closing the session interrupts it, and an answer
   *  that arrives after is dropped. */
  runtimeRequest(
    message: Extract<UpMessage, { kind: 'runtime.request' }>,
  ): Effect.Effect<typeof OutcomeSchema.Type, BridgeError>;
  /** Answered by the `host.response` of its session under its id, as
   *  {@link runtimeRequest} is; `timeoutMs` passing fails it `Rejected`. */
  hostRequest(
    message: Extract<UpMessage, { kind: 'host.request' }>,
    timeoutMs?: number,
  ): Effect.Effect<HostOutcome, BridgeError>;
  /** Run `program` as a fiber of the session's scope, so closing the session
   *  interrupts it; a session that is not open runs nothing. */
  run(session: string, program: Effect.Effect<void>): void;
  /** A `host.request` finished with the host's outcome, or failed with its
   *  refusal (a session that closes first, or `timeoutMs` passing, is a
   *  refusal too). */
  answer(
    message: Extract<UpMessage, { kind: 'host.request' }>,
    timeoutMs?: number,
  ): Promise<HostOutcome>;
  onSurfaceAction(
    listener: (session: string, action: WireSurfaceAction) => void,
  ): void;
  /** Release a session's graph: its signals, its scope (the LayerMap
   *  entry, the session view fiber, the frames), and its slot, so a later `open`
   *  of the key builds a fresh one. A key that is not open is a no-op. */
  close(session: string): void;
  dispose(): void;
}

interface OpenSession extends WebviewSession {
  readonly graph: WebviewGraph;
  readonly scope: Scope.Closeable;
  /** This session's requests awaiting their response, by request id. Each
   *  waits in a fiber of the session's scope and removes its own entry. */
  readonly pending: Map<string, Pending>;
  /** The frames the host sent, in arrival order; one fiber of the session's
   *  scope feeds them to the frames service. */
  readonly inbox: Queue.Queue<EventsFrame | HostFrame>;
}

/** One request waiting for its response: `answer` takes the response
 *  that arrived under its id, `fail` a response that could not be read. */
interface Pending {
  readonly answer: (response: Response) => void;
  readonly fail: (error: BridgeError) => void;
}

/** A response's result as its request's answer. */
const answerOf = <A>(
  result:
    | { readonly ok: true; readonly outcome: A }
    | {
        readonly ok: false;
        readonly error: BridgeError;
      },
): Effect.Effect<A, BridgeError> =>
  result.ok ? Effect.succeed(result.outcome) : Effect.fail(result.error);

/** A response of the other kind: the host's defect, said as `Invalid`. */
const mismatched = (response: Response) =>
  Effect.fail(
    new Invalid({
      reason: `The host answered with a ${response.kind} for a request of the other kind.`,
    }),
  );

/** The routing fields of a down-message that failed its schema: enough to
 *  find the session, generation, or request it was for. */
const DownEnvelopeSchema = Schema.Struct({
  kind: Schema.String,
  session: Schema.String,
  generation: Schema.optional(Schema.Number),
  requestId: Schema.optional(Schema.String),
});

export function installWebviewTransport(
  post: (message: UpMessage) => void,
): WebviewTransport {
  const runtime = installWebviewRuntime();
  const sessions = new Map<string, OpenSession>();
  let surfaceListener: (
    session: string,
    action: WireSurfaceAction,
  ) => void = () => undefined;

  /** Queue one frame for its session's feeder, which hands them to the frames
   *  service in arrival order; the frames service drops a frame of another
   *  generation. A frame for a session that is not open is the host's
   *  defect, dropped loudly. */
  const deliver = (frame: EventsFrame | HostFrame): void => {
    const session = sessions.get(frame.session);
    if (!session) {
      console.warn(
        `[progress] dropped a frame for session ${frame.session}: not open`,
      );
      return;
    }
    Queue.offerUnsafe(session.inbox, frame);
  };

  /** A down-message that failed its schema is the host's defect. A response
   *  settles its request `Invalid` rather than hang it; a frame of the live
   *  generation is said on the surface's notice, since its events are lost
   *  until the view reopens. */
  const reportMalformed = (data: unknown, error: Schema.SchemaError): void => {
    console.error('[progress] malformed session message', data, error);
    const envelope = Schema.decodeUnknownResult(DownEnvelopeSchema)(data);
    if (!Result.isSuccess(envelope)) return;
    const { kind, session: key, generation, requestId } = envelope.success;
    const session = sessions.get(key);
    if (!session) return;
    if (
      (kind === 'runtime.response' || kind === 'host.response') &&
      requestId !== undefined
    ) {
      session.pending
        .get(requestId)
        ?.fail(new Invalid({ reason: 'The host sent a malformed response.' }));
    } else if (kind === 'events' && generation === session.generation) {
      surfaceListener(key, {
        kind: 'reportError',
        reason:
          'The host sent a malformed update, so this transcript may be incomplete. Reopen the view to reload it.',
      });
    }
  };

  const receive = (data: unknown): void => {
    const parsed = Schema.decodeUnknownResult(DownMessageSchema)(data);
    if (!Result.isSuccess(parsed)) {
      reportMalformed(data, parsed.failure);
      return;
    }
    const message = parsed.success;
    switch (message.kind) {
      case 'events':
      case 'host':
        deliver(message);
        return;
      case 'runtime.response':
      case 'host.response': {
        const waiting = sessions
          .get(message.session)
          ?.pending.get(message.requestId);
        if (!waiting) {
          console.warn(
            `[progress] dropped a response to request ${message.requestId} of session ${message.session}: not pending`,
          );
          return;
        }
        waiting.answer(message);
        return;
      }
      case 'surface.action':
        surfaceListener(message.session, message.action);
        return;
    }
  };

  const close = (key: string): void => {
    const session = sessions.get(key);
    if (!session) return;
    sessions.delete(key);
    session.view$.dispose();
    session.host$.dispose();
    runtime.runFork(Scope.close(session.scope, Exit.void));
  };

  /** One request to the host, waiting for its response, which `read`
   *  turns into the answer; `timeoutMs` turns a host that never answers
   *  into a `Rejected` (its late answer is then dropped). A session closed
   *  first interrupts the wait. */
  const exchange = <A>(
    message: Extract<UpMessage, { requestId: string }>,
    read: (response: Response) => Effect.Effect<A, BridgeError>,
    timeoutMs?: number,
  ): Effect.Effect<A, BridgeError> =>
    Effect.suspend(() => {
      const session = sessions.get(message.session);
      if (!session) return Effect.interrupt;
      return Effect.acquireUseRelease(
        Effect.flatMap(Deferred.make<A, BridgeError>(), (settled) =>
          Effect.sync(() => {
            session.pending.set(message.requestId, {
              answer: (response) =>
                Deferred.doneUnsafe(settled, read(response)),
              fail: (error) => Deferred.doneUnsafe(settled, Effect.fail(error)),
            });
            post(message);
            return settled;
          }),
        ),
        (settled) =>
          timeoutMs === undefined
            ? Deferred.await(settled)
            : Deferred.await(settled).pipe(
                Effect.timeoutOrElse({
                  duration: timeoutMs,
                  orElse: () =>
                    Effect.fail(
                      new Rejected({
                        reason: 'The host did not answer in time.',
                      }),
                    ),
                }),
              ),
        () =>
          Effect.sync(() => {
            session.pending.delete(message.requestId);
          }),
      );
    });

  const hostRequest: WebviewTransport['hostRequest'] = (message, timeoutMs) =>
    exchange(
      message,
      (response) =>
        response.kind === 'host.response'
          ? answerOf(response.result)
          : mismatched(response),
      timeoutMs,
    );

  return {
    receive,
    open(key) {
      const held = sessions.get(key);
      if (held) return held;
      // The graph lives under this scope: closing it releases the LayerMap
      // entry once the last holder leaves.
      const pending = new Map<string, Pending>();
      const { scope, graph, inbox } = runtime.runSync(
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const graph = yield* WebviewSessions.open(key).pipe(
            Effect.provideService(Scope.Scope, scope),
          );
          const inbox = yield* Queue.unbounded<EventsFrame | HostFrame>();
          yield* Effect.forkIn(
            Stream.runForEach(Stream.fromQueue(inbox), graph.frames.feed),
            scope,
          );
          return { scope, graph, inbox };
        }),
      );
      const session: OpenSession = {
        key,
        graph,
        scope,
        pending,
        inbox,
        view$: toSignal(runtime, graph.view.changes, graph.view.current()),
        host$: toSignal(
          runtime,
          SubscriptionRef.changes(graph.frames.host),
          null,
        ),
        generation: 0,
      };
      sessions.set(key, session);
      return session;
    },
    subscribe(session, aggregates) {
      session.generation += 1;
      const message: Subscribe = {
        kind: 'subscribe',
        session: session.key,
        generation: session.generation,
        debug: session.view$.get().debug,
        cursor: session.view$.get().cursor,
        aggregates,
      };
      // Begin the generation and replace the shell's transcript set before
      // the host answers: the session view reopens its reads on the set.
      const open = sessions.get(session.key);
      if (!open) throw new Error(`Session ${session.key} is not open`);
      const { graph } = open;
      runtime.runSync(
        graph.frames
          .begin(message.generation)
          .pipe(Effect.andThen(graph.view.subscribe(SHELL_PORT, aggregates))),
      );
      post(message);
    },
    runtimeRequest: (message) =>
      exchange(message, (response) =>
        response.kind === 'runtime.response'
          ? answerOf(response.result)
          : mismatched(response),
      ),
    hostRequest,
    run(key, program) {
      const session = sessions.get(key);
      if (session) runtime.runFork(Effect.forkIn(program, session.scope));
    },
    // The desktop editor's file I/O awaits its answer as a promise; the
    // session's close rejects it as interrupted.
    answer: (message, timeoutMs) =>
      runtime.runPromise(
        hostRequest(message, timeoutMs).pipe(
          Effect.mapError((error) => new Error(requestErrorText(error))),
        ),
      ),
    onSurfaceAction(listener) {
      surfaceListener = listener;
    },
    close,
    dispose() {
      for (const key of [...sessions.keys()]) close(key);
      void runtime.dispose();
    },
  };
}

/** The aggregate a surface names for a selected run (contract C7): the
 *  run's own, from the seq the view retained for it. */
export function transcriptAggregates(
  view: SessionView,
  runId: RunId | null,
): Subscribe['aggregates'] {
  if (runId === null) return [];
  const run = view.runs.get(runId);
  if (!run) return [];
  const id = qualifyAggregateId('run', run.id);
  return [{ id, fromSeq: view.transcriptSeq.get(id) ?? 0 }];
}
