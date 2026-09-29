/**
 * The webview side of the events transport (PRD one-fold-three-renderers,
 * 7.4, 7.7, 8.1): the decoder that turns host-bridge messages into frame
 * deliveries, request responses, and surface actions, and the signals the
 * root reads. The runtime and the per-session graphs are
 * `webviewSessionLayer`'s; the rest of the frontend reads signals and posts
 * `UpMessage`s, and nothing else touches the session layer. The host names
 * the pipe `UpMessage`s leave by and hands every message that arrives on
 * its session channel to `receive`: the extension's window carries nothing
 * else, and the desktop's session channel is its own.
 */
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Queue,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import {
  installWebviewRuntime,
  WebviewSessions,
} from '@controllers/session/webviewSessionLayer';
import { aggregateId as qualifyAggregateId, type RunId } from '@shared/schemas';
import { toSignal, type StreamSignal } from '@shared/signals';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import {
  DownMessageSchema,
  type DownMessage,
  type EventsFrame,
  type Response,
  type Subscribe,
  type UpMessage,
} from '@shared/session/sessionFrames';
import type { SessionView } from '@shared/session/sessionView';

/** One session's graph as `WebviewSessions.open` hands it out. */
type WebviewGraph = Effect.Success<ReturnType<typeof WebviewSessions.open>>;

type WireSurfaceAction = Extract<
  DownMessage,
  { kind: 'surface.action' }
>['action'];

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
  /** Answered on the matching `response` message of its session; answered
   *  `Cancelled` when that session closes first or is not open. */
  request(
    message: Extract<UpMessage, { requestId: string }>,
  ): Promise<Response['result']>;
  onSurfaceAction(
    listener: (session: string, action: WireSurfaceAction) => void,
  ): void;
  /** Release a session's graph: its signals, its scope (the LayerMap
   *  entry, the fold fiber, the frames), and its slot, so a later `open`
   *  of the key builds a fresh one. A key that is not open is a no-op. */
  close(session: string): void;
  dispose(): void;
}

interface OpenSession extends WebviewSession {
  readonly graph: WebviewGraph;
  readonly scope: Scope.Closeable;
  /** This session's requests awaiting their `response`, by request id. The
   *  session's scope interrupts every one still here when it closes. */
  readonly pending: Map<string, Deferred.Deferred<Response['result']>>;
  /** The frames the host sent, in arrival order; one fiber of the session's
   *  scope feeds them to the frames service. */
  readonly inbox: Queue.Queue<EventsFrame>;
}

/** What a request answers when its session closed before the host did. */
const CANCELLED: Response['result'] = {
  ok: false,
  error: { _tag: 'Cancelled' },
};

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
  const deliver = (frame: EventsFrame): void => {
    const session = sessions.get(frame.session);
    if (!session) {
      console.warn(
        `[progress] dropped a frame for session ${frame.session}: not open`,
      );
      return;
    }
    Queue.offerUnsafe(session.inbox, frame);
  };

  const receive = (data: unknown): void => {
    const parsed = DownMessageSchema.safeParse(data);
    if (!parsed.success) {
      console.warn('[progress] malformed session message', data, parsed.error);
      return;
    }
    const message = parsed.data;
    switch (message.kind) {
      case 'events':
        deliver(message);
        return;
      case 'response': {
        const pending = sessions.get(message.session)?.pending;
        const settle = pending?.get(message.requestId);
        if (!pending || !settle) {
          console.warn(
            `[progress] dropped a response to request ${message.requestId} of session ${message.session}: not pending`,
          );
          return;
        }
        pending.delete(message.requestId);
        runtime.runSync(Deferred.succeed(settle, message.result));
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

  return {
    receive,
    open(key) {
      const held = sessions.get(key);
      if (held) return held;
      // The graph lives under this scope: closing it releases the LayerMap
      // entry once the last holder leaves.
      const pending = new Map<string, Deferred.Deferred<Response['result']>>();
      const { scope, graph, inbox } = runtime.runSync(
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const graph = yield* WebviewSessions.open(key).pipe(
            Effect.provideService(Scope.Scope, scope),
          );
          // Requests the host never answered end with the session: each
          // caller's promise settles as `Cancelled` rather than leaking.
          yield* Scope.addFinalizer(
            scope,
            Effect.suspend(() => {
              const open = [...pending.values()];
              pending.clear();
              return Effect.forEach(open, Deferred.interrupt, {
                discard: true,
              });
            }),
          );
          const inbox = yield* Queue.unbounded<EventsFrame>();
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
        view$: toSignal(
          runtime,
          SubscriptionRef.changes(graph.view.ref),
          SubscriptionRef.getUnsafe(graph.view.ref),
        ),
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
      // the host answers (PRD 8.1): the fold reopens its reads on the set.
      const open = sessions.get(session.key);
      if (!open) throw new Error(`Session ${session.key} is not open`);
      const { graph } = open;
      runtime.runSync(
        graph.frames
          .begin(message.generation)
          .pipe(
            Effect.andThen(graph.subscriptions.set(SHELL_PORT, aggregates)),
          ),
      );
      post(message);
    },
    request(message) {
      const session = sessions.get(message.session);
      if (!session) {
        console.warn(
          `[progress] cancelled request ${message.requestId}: session ${message.session} is not open`,
        );
        return Promise.resolve(CANCELLED);
      }
      const settled = Deferred.makeUnsafe<Response['result']>();
      session.pending.set(message.requestId, settled);
      post(message);
      return runtime.runPromise(
        Deferred.await(settled).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.succeed(CANCELLED)
              : Effect.failCause(cause),
          ),
        ),
      );
    },
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
  return [{ id, fromSeq: view.folded.get(id) ?? 0 }];
}
