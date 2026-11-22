/**
 * The host-neutral bridge owner of a session's webview ports: one
 * `RpcServer` of the session's procedures (`SessionRpcs`) per attached
 * port. The extension attaches its sidebar webview and its editor tab as
 * two ports, the desktop attaches its renderer per open project; each port's
 * frames are cut from the same session graph and each port's transcript set
 * is one member of the union the view sees. What the host renders but does
 * not own rides every port as the `host` snapshot, one level per session
 * that the host's producers write.
 *
 * Ownership is scoped: `make` builds the bridge in the scope its host
 * holds and closes; `attach` forks a port scope from it, and the port's
 * server runs in that scope, so closing a port releases its transcript set
 * and tells the host before it interrupts the port's calls, and closing the
 * bridge closes every port the same way. A request's work runs in the
 * bridge's set of requests, not the port's scope, so a `stop` or a decision
 * sent just before a tab closes still completes: closing the bridge waits
 * for the requests in flight, up to the session's close deadline, then
 * interrupts what still hangs. A launch answers once its run is started, so
 * nothing here waits for a run to end. An answer whose port is gone is
 * dropped.
 *
 * A handler that dies is answered `Internal` under a reference the host log
 * carries the cause under: the surface hears that it failed, never the
 * text (`rpc` would send a defect's text). A message `rpc` cannot read it
 * answers itself, under the request's id.
 */
import { randomUUID } from 'node:crypto';

import {
  Cause,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Queue,
  Result,
  Schema,
  Scope,
  Stream,
} from 'effect';
import { RpcServer } from 'effect/rpc';

import { type Session } from '@texra-ai/worldline';
import {
  SESSION_CLOSE_DEADLINE_MS,
  withLogChannel,
} from '@texra-ai/worldline/plugins';
import { toErrorMessage } from '@texra-ai/worldline/schemas';
import type { HostCommand } from '@texra/shared/session/hostRequest';
import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import {
  ClientEnvelopeSchema,
  SessionRpcs,
  type HostOutcome,
  type HostSurfaceAction,
  type SessionWire,
} from '@texra/shared/session/sessionFrames';
import { serveOverMessages } from '@texra/shared/rpcOverMessages';
import { frameSubscription } from '@texra/controllers/session/SessionFramer';
import type { ProcessServices } from '@texra-ai/worldline/host';
import {
  isRequestRefusal,
  type HostCommandFailure,
} from '@texra/controllers/session/hostCallFailure';
import { Internal, type BridgeError } from '@texra/shared/session/bridgeErrors';

const CHANNEL = 'SessionBridge';

/** Host actions a port holds that its surface has not taken yet. A surface
 *  that has not read this many is not showing (a sidebar VS Code never
 *  loaded), so the oldest go first: the newest are the ones still meant. */
const HELD_ACTIONS = 64;

interface SessionBridgeOptions {
  /** The session this bridge frames and requests through. */
  readonly session: Session;
  /** The host snapshot every port frames, which the host's producers
   *  write. */
  readonly host: Stream.Stream<HostSnapshot>;
  readonly onPortClosed: (port: string) => Effect.Effect<void>;
  /** The host's capabilities, performed on the surface's behalf, as
   *  one program per request over the process services `attach` ran with.
   *  A handler cancels with `Cancelled` or refuses with `Unavailable` or
   *  `Rejected`; anything else it fails or dies with is a defect, logged
   *  here and answered `Internal`. The channel is
   *  {@link HostCommandFailure}: each host lifts a Promise-faced capability
   *  once, under the member's name, so every case fails with a tag and a
   *  bare rejection value can no longer reach this channel. */
  readonly handleHostCommand: (
    request: HostCommand,
    port: string,
  ) => Effect.Effect<HostOutcome, HostCommandFailure, ProcessServices>;
}

/** One attached transport port: the host posts `send`'s messages to it. */
interface SessionPort {
  readonly id: string;
  readonly send: (message: SessionWire) => void;
}

/** What the bridge gives a host per attached port. */
export interface AttachedPort {
  /** One message from the port, unparsed. */
  readonly receive: (message: unknown) => Effect.Effect<void>;
  /** One host action for this port alone (the composer's Send, the
   *  drawer, the chime), held until the port's surface takes it. */
  readonly surfaceAction: (action: HostSurfaceAction) => void;
  /** The port went away: its transcript set leaves the union, the host
   *  hears it, and its calls are interrupted. A second close is a no-op. */
  readonly close: Effect.Effect<void>;
}

/** Expected refusal when a host attaches after the bridge has closed. */
class SessionBridgeClosedError extends Schema.TaggedError<SessionBridgeClosedError>()(
  'SessionBridgeClosedError',
  {},
) {
  override get message(): string {
    return 'SessionBridge is closed; cannot attach a port';
  }
}

/** One attached port: the actions it holds and its scope's close. */
interface PortEntry {
  readonly actions: Queue.Queue<HostSurfaceAction>;
  /** Closes the port's scope; the bridge's scope closes it last. */
  readonly close: Effect.Effect<void>;
}

export class SessionBridge {
  /** The bridge in the caller's scope: the host holds that scope and closes
   *  it when the window it serves goes away. */
  static make(
    options: SessionBridgeOptions,
  ): Effect.Effect<SessionBridge, never, Scope.Scope> {
    return Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const requests = yield* FiberSet.make<unknown, never>();
      // Added after the set, so it runs first: a close waits for the
      // requests in flight, up to the session's close deadline, before the
      // set interrupts what is still running.
      yield* Effect.addFinalizer(() =>
        FiberSet.awaitEmpty(requests).pipe(
          Effect.timeoutOption(SESSION_CLOSE_DEADLINE_MS),
          Effect.asVoid,
        ),
      );
      return new SessionBridge(options, scope, requests);
    });
  }

  /** The session key on every message: the session's storage root. */
  readonly key: string;
  private readonly ports = new Map<string, PortEntry>();

  private readonly options: SessionBridgeOptions;
  private readonly scope: Scope.Scope;
  /** The requests in flight, which the bridge's close waits for. */
  private readonly requests: FiberSet.FiberSet<unknown, never>;
  private constructor(
    options: SessionBridgeOptions,
    scope: Scope.Scope,
    requests: FiberSet.FiberSet<unknown, never>,
  ) {
    this.options = options;
    this.scope = scope;
    this.requests = requests;
    this.key = options.session.roots.storage;
  }

  /** The host acting on surface-owned state: every attached port
   *  applies it, so the sidebar and the editor tab follow together. */
  surfaceAction(action: HostSurfaceAction): void {
    for (const entry of this.ports.values())
      Queue.offerUnsafe(entry.actions, action);
  }

  readonly attach = Effect.fn('SessionBridge.attach')(
    { self: this },
    function* (
      port: SessionPort,
    ): Effect.fn.Return<
      AttachedPort,
      SessionBridgeClosedError,
      ProcessServices
    > {
      // A port re-attaching under a live id supersedes the previous one.
      // Close it to completion before installing the replacement so the old
      // entry's cleanup cannot be skipped by the new map entry.
      const previous = this.ports.get(port.id);
      if (previous) {
        yield* previous.close;
      }
      // `Scope.fork` of a closed parent hands back an already-closed child
      // rather than failing, so the bridge's own scope is the check.
      if (this.scope.state._tag === 'Closed')
        return yield* new SessionBridgeClosedError();
      const scope = yield* Scope.fork(this.scope);
      const entry: PortEntry = {
        actions: yield* Queue.sliding<HostSurfaceAction>(HELD_ACTIONS),
        close: Scope.close(scope, Exit.void),
      };
      const { protocol, receive } = yield* serveOverMessages(
        (client, message) =>
          Effect.sync(() => port.send({ session: this.key, client, message })),
      );
      // Forked before the release finalizer is registered: finalizers run
      // last-in first-out, so the port is released (its map entry, its
      // transcript set, the host's `onPortClosed`) before its calls are
      // interrupted, and a host that closes a port and re-attaches under the
      // same id in one turn finds the id free.
      yield* RpcServer.make(SessionRpcs).pipe(
        Effect.provide(SessionRpcs.toLayer(this.handlers(port.id, entry))),
        Effect.provideService(RpcServer.Protocol, protocol),
        Effect.forkIn(scope),
      );
      const { onPortClosed } = this.options;
      yield* Scope.addFinalizer(
        scope,
        Effect.suspend(() => {
          if (this.ports.get(port.id) !== entry) return Effect.void;
          this.ports.delete(port.id);
          return onPortClosed(port.id);
        }),
      );
      this.ports.set(port.id, entry);
      return {
        receive: (message) =>
          Effect.suspend(() => {
            if (this.ports.get(port.id) !== entry) return Effect.void;
            const parsed =
              Schema.decodeUnknownResult(ClientEnvelopeSchema)(message);
            if (!Result.isSuccess(parsed))
              return Effect.logWarning(
                `Unparseable message from port ${port.id}: ${parsed.failure.message}`,
              ).pipe(withLogChannel(CHANNEL));
            const envelope = parsed.success;
            if (envelope.session !== this.key)
              return Effect.logWarning(
                `Port ${port.id} addressed session ${envelope.session}; this session is ${this.key}`,
              ).pipe(withLogChannel(CHANNEL));
            return receive(envelope.client, envelope.message);
          }),
        surfaceAction: (action) => {
          if (this.ports.get(port.id) === entry)
            Queue.offerUnsafe(entry.actions, action);
        },
        close: entry.close,
      };
    },
  );

  /** The procedures one port is served. */
  private handlers(port: string, entry: PortEntry) {
    const { session, host, handleHostCommand } = this.options;
    return {
      'session.frames': (subscribe: Parameters<typeof frameSubscription>[1]) =>
        frameSubscription(session.view, subscribe).pipe(
          endLogged(`Transcript frames for port ${port} stopped`),
        ),
      'session.host': () =>
        host.pipe(endLogged(`The host snapshot for port ${port} stopped`)),
      'session.actions': () => Stream.fromQueue(entry.actions),
      'session.request': ({
        request,
      }: {
        readonly request: Parameters<Session['request']>[0];
      }) => this.answer(port, session.request(request)),
      'host.request': ({ request }: { readonly request: HostCommand }) =>
        this.answer(
          port,
          handleHostCommand(request, port).pipe(
            Effect.catch((error) =>
              isRequestRefusal(error) ? Effect.fail(error) : Effect.die(error),
            ),
          ),
        ),
    };
  }

  /**
   * One request's work, run in the bridge's set of requests so that it
   * finishes even when its caller is interrupted or its port closes; the
   * handler only waits for it. A defect has its cause logged here and is
   * answered `Internal`.
   */
  private answer<A, R>(
    port: string,
    work: Effect.Effect<A, BridgeError, R>,
  ): Effect.Effect<A, BridgeError, R> {
    return FiberSet.run(
      this.requests,
      Effect.exit(
        work.pipe(
          Effect.catchDefect((defect) => {
            const ref = randomUUID();
            return Effect.logError(
              `Request ${ref} from port ${port} failed: ${toErrorMessage(defect)}`,
            ).pipe(
              withLogChannel(CHANNEL),
              Effect.andThen(Effect.fail(new Internal({ ref }))),
            );
          }),
        ),
      ),
    ).pipe(Effect.flatMap(Fiber.join), Effect.flatten);
  }
}

/** A stream served to a port that ends, logged, where it would fail: a
 *  defect would end every call of the port's connection, and nothing on the
 *  surface can act on it. */
const endLogged =
  (message: string) =>
  <A>(stream: Stream.Stream<A>): Stream.Stream<A> =>
    stream.pipe(
      Stream.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Stream.failCause(cause)
          : Stream.fromEffect(
              Effect.logError(message, cause).pipe(withLogChannel(CHANNEL)),
            ).pipe(Stream.drain),
      ),
    );
