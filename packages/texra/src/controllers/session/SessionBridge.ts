/**
 * The host-neutral bridge owner of a session's webview ports: one framer
 * fiber per attached
 * port, the `Subscribe` handler, and the two request handlers. The
 * extension attaches its sidebar webview and its editor tab as two ports,
 * the desktop attaches its renderer per open project; each port's frames are
 * cut from the same session graph and each port's transcript set is one
 * member of the union the view sees. What the host renders but does not own
 * rides every port's frames as the `host` snapshot, one level per session
 * that the host's producers write.
 *
 * Ownership is scoped: `make` builds the bridge in the scope its host
 * holds and closes; `attach` forks a port scope from it, and the port's
 * framer fiber runs in a scope forked from that one, so closing a port
 * releases its transcript set and tells the host before it interrupts the
 * replay, and closing the bridge closes every port the same way. A request
 * runs in the bridge's scope, not the port's, and uninterruptible: a `stop`
 * or a decision sent just before a tab closes still completes, and closing
 * the bridge drains the requests in flight rather than cutting them; an
 * answer whose port is gone is dropped.
 *
 * A `runtime.request` runs the session's `request` and posts one
 * `runtime.response` under the request's id; a `host.request` runs the
 * host's handler the same way and posts a `host.response`. A message the bridge cannot parse is answered
 * `Invalid` when it names a request id, and reported otherwise: a silent
 * drop would leave the sender's latch pending forever. A handler that dies
 * is answered `Internal` under the request id the host log carries the
 * cause under: the surface hears that it failed, never the text.
 */
import {
  Cause,
  Effect,
  Exit,
  FiberHandle,
  Result,
  Schema,
  Scope,
  Stream,
} from 'effect';

import { type Session } from '@texra-ai/harness';
import { withLogChannel } from '@texra-ai/harness/host';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import type { HostRequest } from '@texra/shared/session/hostRequest';
import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import {
  DownMessageSchema,
  UpMessageSchema,
  type DownMessage,
  type DownWire,
  type HostOutcome,
  type HostResponse,
  type Response,
  type RuntimeResponse,
  type Subscribe,
  type SurfaceActionMessage,
} from '@texra/shared/session/sessionFrames';
import { frameSubscription } from '@texra/controllers/session/SessionFramer';
import type { ProcessServices } from '@texra-ai/harness/host';
import {
  isRequestRefusal,
  type HostRequestFailure,
} from '@texra/controllers/session/hostCallFailure';
import {
  Internal,
  Invalid,
  type BridgeError,
} from '@texra/shared/session/bridgeErrors';

const CHANNEL = 'SessionBridge';

/** Enough of any up message to answer it: a message that names a request
 *  id gets its `Invalid` response even when the rest did not parse. */
const RequestEnvelopeSchema = Schema.Struct({
  kind: Schema.Literals(['runtime.request', 'host.request']),
  session: Schema.String,
  requestId: Schema.String.check(Schema.isMinLength(1)),
});

interface SessionBridgeOptions {
  /** The session this bridge frames and requests through. */
  readonly session: Session;
  /** The host snapshot every port frames, which the host's producers
   *  write. */
  readonly host: Stream.Stream<HostSnapshot>;
  readonly onPortClosed: (port: string) => Effect.Effect<void>;
  /** The host's capabilities, performed on the surface's behalf, as
   *  one program per request that takes the process services from the fiber
   *  the host's transport runs `receive` on. A handler cancels with
   *  `Cancelled` or refuses with `Unavailable` or `Rejected`; anything else
   *  it fails or dies with is a defect, logged here and answered
   *  `Internal`. The channel is {@link HostRequestFailure}: each host lifts
   *  a Promise-faced capability once, under the member's name, so every case
   *  fails with a tag and a bare rejection value can no longer reach this
   *  channel. The last case that widened it to `Error` was the transcript
   *  export; its steps carry tags now. */
  readonly handleHostRequest: (
    request: HostRequest,
    port: string,
  ) => Effect.Effect<HostOutcome, HostRequestFailure, ProcessServices>;
}

/** One attached transport port: the host posts `send`'s messages to it. */
interface SessionPort {
  readonly id: string;
  readonly send: (message: DownWire) => void;
}

/** What the bridge gives a host per attached port. */
export interface AttachedPort {
  /** One message from the port, unparsed. */
  readonly receive: (
    message: unknown,
  ) => Effect.Effect<void, never, ProcessServices>;
  /** One host action for this port alone (the composer's Send, the
   *  drawer, the chime), held like {@link SessionBridge.surfaceAction}'s
   *  until the port is live. */
  readonly surfaceAction: (action: SurfaceActionMessage['action']) => void;
  /** The port went away: its transcript set leaves the union, the host
   *  hears it, and its replay is interrupted. A second close is a no-op. */
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

/** A response as the wire carries it: its error as the class's fields,
 *  which the surface's one decode makes the class again (a `postMessage`
 *  keeps no Error prototype). */
const encodeResponse: (response: Response) => DownWire =
  Schema.encodeSync(DownMessageSchema);

const refused = (error: BridgeError) => ({ ok: false, error }) as const;

/** The response kind that answers each request kind. */
const RESPONSE_KIND = {
  'runtime.request': 'runtime.response',
  'host.request': 'host.response',
} as const;

/** One attached port: its transport, its scope, and the framer in flight. */
interface PortEntry {
  readonly port: SessionPort;
  /** The replay in flight. Made in the port's scope before the release
   *  finalizer is registered: finalizers close last-in first-out, so the
   *  port is released (its map entry, its transcript set, the host's
   *  `onPortClosed`) before the replay is interrupted, and a host that
   *  closes a port and re-attaches under the same id in one turn finds the
   *  id free. */
  readonly frames: FiberHandle.FiberHandle<void>;
  /** Closes the port's scope; the bridge's scope closes it last. */
  readonly close: Effect.Effect<void>;
  /** Host actions sent before the port's first `Subscribe`, in order, or
   *  null once it has subscribed. A port is live only when its surface has
   *  mounted and asked for frames: a message posted to a webview whose
   *  document is still loading is dropped, so an action that opens a fresh
   *  surface would otherwise never reach it (#12495). */
  held: SurfaceActionMessage[] | null;
}

export class SessionBridge {
  /** The bridge in the caller's scope: the host holds that scope and closes
   *  it when the window it serves goes away. */
  static make(
    options: SessionBridgeOptions,
  ): Effect.Effect<SessionBridge, never, Scope.Scope> {
    return Effect.map(
      Effect.scope,
      (scope) => new SessionBridge(options, scope),
    );
  }

  /** The session key on every message: the session's storage root. */
  readonly key: string;
  private readonly ports = new Map<string, PortEntry>();

  private readonly options: SessionBridgeOptions;
  private readonly scope: Scope.Scope;
  private constructor(options: SessionBridgeOptions, scope: Scope.Scope) {
    this.options = options;
    this.scope = scope;
    this.key = options.session.roots.storage;
  }

  /** The host acting on surface-owned state: every attached port
   *  applies it, so the sidebar and the editor tab follow together. */
  surfaceAction(action: SurfaceActionMessage['action']): void {
    for (const entry of this.ports.values()) this.act(entry, action);
  }

  private act(entry: PortEntry, action: SurfaceActionMessage['action']): void {
    const message: SurfaceActionMessage = {
      kind: 'surface.action',
      session: this.key,
      action,
    };
    if (entry.held) entry.held.push(message);
    else entry.port.send(message);
  }

  readonly attach = Effect.fn('SessionBridge.attach')(
    { self: this },
    function* (
      port: SessionPort,
    ): Effect.fn.Return<AttachedPort, SessionBridgeClosedError> {
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
        port,
        frames: yield* FiberHandle.make<void>().pipe(Scope.provide(scope)),
        close: Scope.close(scope, Exit.void),
        held: [],
      };
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
        receive: (message) => this.receive(entry, message),
        surfaceAction: (action) => {
          if (this.ports.get(port.id) === entry) this.act(entry, action);
        },
        close: entry.close,
      };
    },
  );

  /**
   * Answer a `Subscribe`: the next replay replaces the one in flight, which
   * is interrupted, so `receive` never waits on it; the frames a dying
   * fiber still cuts echo its generation and the decoder drops them.
   */
  private subscribe(
    entry: PortEntry,
    subscribe: Subscribe,
  ): Effect.Effect<void> {
    return Effect.suspend(() => {
      // Nothing joins this fiber: a failed replay or tail read would stop the
      // port's transcript with no trace, so its death is logged here.
      const frames = Stream.runForEach(
        Stream.merge(
          frameSubscription(
            { key: this.key, view: this.options.session.view },
            subscribe,
          ),
          // What the host renders but does not own, as its producers write
          // it: its own message beside the frames.
          this.options.host.pipe(
            Stream.map((host): DownMessage => ({
              kind: 'host',
              session: this.key,
              host,
            })),
          ),
        ),
        (message) => Effect.sync(() => entry.port.send(message)),
      ).pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError(
                `Transcript frames for port ${entry.port.id} stopped; the port no longer updates`,
                cause,
              ).pipe(withLogChannel(CHANNEL)),
        ),
      );
      return Effect.asVoid(FiberHandle.run(entry.frames, frames));
    });
  }

  private receive(
    entry: PortEntry,
    message: unknown,
  ): Effect.Effect<void, never, ProcessServices> {
    return Effect.suspend(() => {
      const { port } = entry;
      if (this.ports.get(port.id) !== entry) return Effect.void;
      const parsed = Schema.decodeUnknownResult(UpMessageSchema)(message);
      if (!Result.isSuccess(parsed)) {
        const envelope = Schema.decodeUnknownResult(RequestEnvelopeSchema)(
          message,
        );
        const reason = `Unparseable message from port ${port.id}: ${parsed.failure.message}`;
        return Effect.logWarning(reason).pipe(
          withLogChannel(CHANNEL),
          Effect.andThen(
            Effect.sync(() => {
              if (!Result.isSuccess(envelope)) return;
              const { kind, session, requestId } = envelope.success;
              port.send(
                encodeResponse({
                  kind: RESPONSE_KIND[kind],
                  session,
                  requestId,
                  result: refused(new Invalid({ reason })),
                }),
              );
            }),
          ),
        );
      }
      const up = parsed.success;
      if (up.session !== this.key) {
        return Effect.logWarning(
          `Port ${port.id} addressed session ${up.session}; this session is ${this.key}`,
        ).pipe(withLogChannel(CHANNEL));
      }
      switch (up.kind) {
        case 'subscribe': {
          // The surface is live: what the host did while it loaded lands
          // now, once, before its first frame.
          const held = entry.held;
          entry.held = null;
          for (const message of held ?? []) port.send(message);
          return this.subscribe(entry, up);
        }
        case 'runtime.request':
          return this.answer<RuntimeResponse>(
            entry,
            up.requestId,
            (result) => ({
              kind: 'runtime.response',
              session: this.key,
              requestId: up.requestId,
              result,
            }),
            this.options.session.request(up.request).pipe(
              Effect.match({
                onFailure: refused,
                onSuccess: (outcome) => ({ ok: true, outcome }) as const,
              }),
            ),
          );
        case 'host.request':
          return this.answer<HostResponse>(
            entry,
            up.requestId,
            (result) => ({
              kind: 'host.response',
              session: this.key,
              requestId: up.requestId,
              result,
            }),
            this.options.handleHostRequest(up.request, port.id).pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  isRequestRefusal(error)
                    ? Effect.succeed(refused(error))
                    : Effect.die(error),
                onSuccess: (outcome) =>
                  Effect.succeed({ ok: true, outcome } as const),
              }),
            ),
          );
      }
    });
  }

  /**
   * Run one request's answer in the bridge's scope and post it under the
   * request id. A handler that died has its cause logged here and the port
   * answered `Internal`, so the sender's latch clears.
   */
  private answer<R extends Response>(
    entry: PortEntry,
    requestId: string,
    respond: (result: R['result']) => R,
    result: Effect.Effect<R['result'], never, ProcessServices>,
  ): Effect.Effect<void, never, ProcessServices> {
    return Effect.forkIn(
      result.pipe(
        Effect.catchCause((cause) =>
          Effect.logError(
            `Request ${requestId} from port ${entry.port.id} failed: ${toErrorMessage(Cause.squash(cause))}`,
          ).pipe(
            withLogChannel(CHANNEL),
            Effect.as(refused(new Internal({ ref: requestId }))),
          ),
        ),
        Effect.flatMap((answer) =>
          Effect.sync(() => {
            if (this.ports.get(entry.port.id) !== entry) return;
            entry.port.send(encodeResponse(respond(answer)));
          }),
        ),
        Effect.uninterruptible,
      ),
      this.scope,
    ).pipe(Effect.asVoid);
  }
}
