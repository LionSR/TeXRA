/**
 * The webview side of the session channel: one `RpcClient` of the
 * session's procedures (`SessionRpcs`) per open session, its view built
 * from the frames it reads, and the signals the root reads. The rest of the
 * frontend reads signals and calls `runtimeRequest` / `hostRequest`. The
 * host names the pipe messages leave by and hands every message that
 * arrives on its session channel to `receive`: the extension's window
 * carries nothing else, and the desktop's session channel is its own.
 */
import {
  Cause,
  Effect,
  Exit,
  type ManagedRuntime,
  Result,
  Schema,
  Scope,
  Stream,
} from 'effect';
import { RpcClient, type RpcClientError, type RpcMessage } from 'effect/rpc';

import {
  Rejected,
  toErrorMessage,
  type OutcomeSchema,
  type RunId,
  type RuntimeCommand,
} from '@texra-ai/worldline/schemas';
import type { TranscriptInterest } from '@texra-ai/worldline/transcript';
import type { HostCommand } from '@texra/shared/session/hostRequest';
import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import {
  ServerEnvelopeSchema,
  SessionRpcs,
  type HostOutcome,
  type HostSurfaceAction,
  type SessionWire,
  type Subscribe,
} from '@texra/shared/session/sessionFrames';
import type { SurfaceAction } from '@texra/shared/session/surface';
import { toSignal, type StreamSignal } from '@texra/shared/signals';
import {
  installWebviewRuntime,
  remoteSessionView,
} from '@texra/shared/session/webviewSessionLayer';
import { callOverMessages } from '@texra/shared/rpcOverMessages';
import type { SessionView } from '@texra-ai/worldline/schemas';
import { Invalid, type BridgeError } from '@texra/shared/session/bridgeErrors';

/** What the transport hands the surfaces: the host's action, or its own
 *  report of a frame it could not read. */
type WireSurfaceAction =
  | HostSurfaceAction
  | Extract<SurfaceAction, { kind: 'reportError' }>;

/** One open session: its two levels as signals. */
export interface WebviewSession {
  readonly key: string;
  readonly view$: StreamSignal<SessionView>;
  /** Null until the host's first snapshot arrives. */
  readonly host$: StreamSignal<HostSnapshot | null>;
}

export interface WebviewTransport {
  /** The webview's one runtime, for a pane that owns Effect work outside
   *  any session's graph: it makes its own scope and runs its fibers there. */
  readonly runtime: ManagedRuntime.ManagedRuntime<never, never>;
  /** One message from the host's session channel. */
  receive(data: unknown): void;
  /** Open (or reuse) a session's graph. */
  open(session: string): WebviewSession;
  /** Name the transcripts the session's view holds; the view asks the host
   *  again from where it stands. */
  subscribe(session: string, aggregates: Subscribe['aggregates']): void;
  /** One runtime command, answered with its outcome. Run it with
   *  {@link run}: closing the session interrupts it. */
  runtimeRequest(message: {
    readonly session: string;
    readonly request: RuntimeCommand;
  }): Effect.Effect<typeof OutcomeSchema.Type, BridgeError>;
  /** One host command, as {@link runtimeRequest}; `timeoutMs` passing
   *  fails it `Rejected`. */
  hostRequest(
    message: { readonly session: string; readonly request: HostCommand },
    timeoutMs?: number,
  ): Effect.Effect<HostOutcome, BridgeError>;
  /** Run `program` as a fiber of the session's scope, so closing the session
   *  interrupts it; a session that is not open runs nothing. */
  run(session: string, program: Effect.Effect<void>): void;
  onSurfaceAction(
    listener: (session: string, action: WireSurfaceAction) => void,
  ): void;
  /** Release a session's graph: its signals, its scope (its client and the
   *  calls in flight, its view), and its slot, so a later `open` of the key
   *  builds a fresh one. A key that is not open is a no-op. */
  close(session: string): void;
  dispose(): void;
}

type SessionClient = RpcClient.FromGroup<
  typeof SessionRpcs,
  RpcClientError.RpcClientError
>;

interface OpenSession extends WebviewSession {
  readonly client: SessionClient;
  readonly scope: Scope.Closeable;
  /** The shell's transcript set, held for the session's scope. */
  readonly shell: TranscriptInterest;
  /** One message from the host to this session's client. */
  readonly deliver: (
    message: RpcMessage.FromServerEncoded,
  ) => Effect.Effect<void>;
}

/** A call the host could not answer as its procedure says (a reply that
 *  did not decode, a request it could not read): the host's defect, said as
 *  `Invalid`. */
const unanswered = (cause: unknown) =>
  new Invalid({
    reason: `The host could not answer this request: ${toErrorMessage(cause)}`,
  });

export function installWebviewTransport(
  post: (message: SessionWire) => void,
): WebviewTransport {
  const runtime = installWebviewRuntime();
  /** This page's name on the channel: a reloaded page is a new client. */
  const self = crypto.randomUUID();
  const sessions = new Map<string, OpenSession>();
  let surfaceListener: (
    session: string,
    action: WireSurfaceAction,
  ) => void = () => undefined;

  const receive = (data: unknown): void => {
    const parsed = Schema.decodeUnknownResult(ServerEnvelopeSchema)(data);
    if (!Result.isSuccess(parsed)) {
      console.error(
        '[progress] malformed session message',
        data,
        parsed.failure,
      );
      return;
    }
    const { session: key, client, message } = parsed.success;
    // An answer to this page's predecessor on the same channel.
    if (client !== self) return;
    const session = sessions.get(key);
    if (!session) {
      console.warn(`[progress] dropped a message for session ${key}: not open`);
      return;
    }
    runtime.runFork(session.deliver(message));
  };

  const close = (key: string): void => {
    const session = sessions.get(key);
    if (!session) return;
    sessions.delete(key);
    session.view$.dispose();
    session.host$.dispose();
    runtime.runFork(Scope.close(session.scope, Exit.void));
  };

  /** One call of an open session's client; a session closed first
   *  interrupts it. */
  const call = <A>(
    key: string,
    use: (
      client: SessionClient,
    ) => Effect.Effect<A, BridgeError | RpcClientError.RpcClientError>,
  ): Effect.Effect<A, BridgeError> =>
    Effect.suspend(() => {
      const session = sessions.get(key);
      if (!session) return Effect.interrupt;
      return use(session.client).pipe(
        Effect.catchTag('RpcClientError', (error) =>
          Effect.fail(unanswered(error)),
        ),
        Effect.catchDefect((defect) => Effect.fail(unanswered(defect))),
      );
    });

  /** A frame the host sent malformed loses its events until the view
   *  reopens: said on the surface's notice, and the read ends. */
  const framesOf =
    (key: string, client: SessionClient) =>
    (
      aggregates: Subscribe['aggregates'],
      cursor: Subscribe['cursor'],
      debug: boolean,
    ) =>
      client['session.frames']({ aggregates, cursor, debug }).pipe(
        Stream.map((frame) => frame.inputs),
        Stream.catchCause((cause) => {
          // Ended either way, and never the view's updates with it; only a
          // failure is the host's defect, not the host ending the call (its
          // port closing).
          if (Cause.hasFails(cause) || Cause.hasDies(cause)) {
            console.error('[progress] malformed session frame', cause);
            surfaceListener(key, {
              kind: 'reportError',
              reason:
                'The host sent a malformed update, so this transcript may be incomplete. Reopen the view to reload it.',
            });
          }
          return Stream.empty;
        }),
      );

  /** A host stream that failed is the host's defect: logged, and ended. */
  const logged =
    (what: string) =>
    <A, E>(stream: Stream.Stream<A, E>): Stream.Stream<A> =>
      stream.pipe(
        Stream.catchCause((cause) => {
          if (Cause.hasFails(cause) || Cause.hasDies(cause))
            console.error(`[progress] the host's ${what} stopped`, cause);
          return Stream.empty;
        }),
      );

  return {
    runtime,
    receive,
    open(key) {
      const held = sessions.get(key);
      if (held) return held;
      const opened = runtime.runSync(
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const { protocol, receive: deliver } = yield* callOverMessages(
            (message) =>
              Effect.sync(() => post({ session: key, client: self, message })),
          );
          const client = yield* RpcClient.make(SessionRpcs).pipe(
            Effect.provideService(RpcClient.Protocol, protocol),
            Scope.provide(scope),
          );
          // The view lives under this scope, and holds the shell's set.
          const view = yield* remoteSessionView(
            key,
            framesOf(key, client),
          ).pipe(Scope.provide(scope));
          const shell = yield* view
            .subscribe([])
            .pipe(Effect.provideService(Scope.Scope, scope));
          yield* Effect.forkIn(
            client['session.actions']().pipe(
              logged('actions'),
              Stream.runForEach((action) =>
                Effect.sync(() => surfaceListener(key, action)),
              ),
            ),
            scope,
          );
          return { scope, client, view, shell, deliver };
        }),
      );
      const session: OpenSession = {
        key,
        client: opened.client,
        scope: opened.scope,
        shell: opened.shell,
        deliver: opened.deliver,
        view$: toSignal(runtime, opened.view.changes, opened.view.current()),
        host$: toSignal<HostSnapshot | null>(
          runtime,
          opened.client['session.host']().pipe(logged('snapshot')),
          null,
        ),
      };
      sessions.set(key, session);
      return session;
    },
    subscribe(key, aggregates) {
      const open = sessions.get(key);
      if (!open) throw new Error(`Session ${key} is not open`);
      runtime.runFork(open.shell.set(aggregates));
    },
    runtimeRequest: ({ session, request }) =>
      call(session, (client) => client['session.request']({ request })),
    hostRequest: ({ session, request }, timeoutMs) => {
      const asked = call(session, (client) =>
        client['host.request']({ request }),
      );
      return timeoutMs === undefined
        ? asked
        : asked.pipe(
            Effect.timeoutOrElse({
              duration: timeoutMs,
              orElse: () =>
                Effect.fail(
                  new Rejected({ reason: 'The host did not answer in time.' }),
                ),
            }),
          );
    },
    run(key, program) {
      const session = sessions.get(key);
      if (session) runtime.runFork(Effect.forkIn(program, session.scope));
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

/** The aggregate a surface names for a selected run: the
 *  run's own, from the seq the view retained for it. */
export function transcriptAggregates(
  view: SessionView,
  runId: RunId | null,
): Subscribe['aggregates'] {
  if (runId === null) return [];
  const run = view.runs.get(runId);
  if (!run) return [];
  const id = run.id;
  return [{ id, fromSeq: view.transcriptSeq.get(id) ?? 0 }];
}
