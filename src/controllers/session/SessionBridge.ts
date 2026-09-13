/**
 * The host-neutral bridge owner of a session's webview ports (PRD
 * one-fold-three-renderers, 7.4, 8.1 to 8.5): one framer fiber per attached
 * port, the `Subscribe` handler, and the two request handlers. The
 * extension attaches its sidebar webview and its editor tab as two ports,
 * the desktop attaches its renderer per open paper; each port's frames are
 * cut from the same session graph and each port's transcript set is one
 * member of the union the fold sees. What the host renders but does not own
 * rides every port's frames as the `host` snapshot, one level per backend
 * that the host's producers write through `setHost`.
 *
 * Ownership is scoped (7.7): `make` builds the bridge in the scope its host
 * holds and closes; `attach` forks a port scope from it, and the port's
 * framer fiber runs in a scope forked from that one, so closing a port
 * releases its transcript set and tells the host before it interrupts the
 * replay, and closing the bridge closes every port the same way. A request
 * runs in the bridge's scope, not the port's, and uninterruptible: a `stop`
 * or a decision sent just before a tab closes still completes, and closing
 * the bridge drains the requests in flight rather than cutting them; an
 * answer whose port is gone is dropped.
 *
 * A `runtime.request` runs `session.requests.request` and posts one
 * `Response` under the request's id; a `host.request` runs the host's
 * handler the same way. A message the bridge cannot parse is answered
 * `Invalid` when it names a request id, and reported otherwise: a silent
 * drop would leave the sender's latch pending forever. A handler that dies
 * is answered `Internal` under the request id the host log carries the
 * cause under (7.6): the surface hears that it failed, never the text (C3).
 */
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import { z } from 'zod';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  frameSubscription,
  type FramerSource,
} from '@controllers/session/SessionFramer';
import { createLog } from '@logger/logUtils';
import type { HostRequest } from '@shared/session/hostRequest';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import {
  Cancelled,
  Internal,
  Rejected,
  Unavailable,
  type RequestError,
} from '@shared/session/requestErrors';
import {
  UpMessageSchema,
  type DownMessage,
  type HostOutcome,
  type RequestErrorWire,
  type Response,
  type Subscribe,
  type SurfaceActionMessage,
} from '@shared/session/sessionFrames';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('SessionBridge');

/** Enough of any up message to answer it: a message that names a request
 *  id gets its `Invalid` response even when the rest did not parse. */
const RequestEnvelopeSchema = z.object({
  session: z.string(),
  requestId: z.string().min(1),
});

interface SessionBridgeOptions {
  readonly session: SessionHandle;
  readonly onPortClosed: (port: string) => void;
  /** The host's capabilities (8.3), performed on the surface's behalf. A
   *  handler cancels with `Cancelled` or refuses with `Unavailable` or
   *  `Rejected`; anything else it
   *  throws is a defect, logged here and answered `Internal`. */
  readonly handleHostRequest: (
    request: HostRequest,
    port: string,
  ) => Promise<HostOutcome>;
}

/** One attached transport port: the host posts `send`'s messages to it. */
interface SessionPort {
  readonly id: string;
  readonly send: (message: DownMessage) => void;
}

/** What the backend gives a host per attached port. */
export interface AttachedPort {
  /** One message from the port, unparsed. */
  readonly receive: (message: unknown) => Effect.Effect<void>;
  /** The port went away: its transcript set leaves the union, the host
   *  hears it, and its replay is interrupted. A second close is a no-op. */
  readonly close: Effect.Effect<void>;
}

function wireError(error: RequestError): RequestErrorWire {
  switch (error._tag) {
    case 'NotOwner':
      return { _tag: 'NotOwner', runId: error.runId };
    case 'Unavailable':
      return {
        _tag: 'Unavailable',
        runId: error.runId,
        reason: error.reason,
      };
    case 'Cancelled':
      return { _tag: 'Cancelled' };
    case 'Rejected':
      return {
        _tag: 'Rejected',
        reason: error.reason,
        ...(error.docsCommand && { docsCommand: error.docsCommand }),
      };
    case 'Internal':
      return { _tag: 'Internal', ref: error.ref };
  }
}

/** A host handler's refusal, as opposed to its defect. */
function isRefusal(
  error: unknown,
): error is Cancelled | Unavailable | Rejected {
  return (
    error instanceof Cancelled ||
    error instanceof Unavailable ||
    error instanceof Rejected
  );
}

/** One attached port: its transport, its scopes, and the framer in flight. */
interface PortEntry {
  readonly port: SessionPort;
  /** The port's lifetime: `close` closes it, the bridge's scope closes it
   *  last. */
  readonly scope: Scope.Closeable;
  /** The framer fiber's home, forked from {@link scope} before the release
   *  finalizer is registered: finalizers close last-in first-out, so the
   *  port is released (its map entry, its transcript set, the host's
   *  `onPortClosed`) before the replay is interrupted, and a host that
   *  closes a port and re-attaches under the same id in one turn finds the
   *  id free. */
  readonly framers: Scope.Closeable;
  readonly close: Effect.Effect<void>;
  fiber: Fiber.Fiber<void> | null;
}

export class SessionBridge {
  /** The bridge in the caller's scope: the host holds that scope and closes
   *  it when the window it serves goes away. */
  static make(
    options: SessionBridgeOptions,
  ): Effect.Effect<SessionBridge, never, Scope.Scope> {
    return Effect.gen(function* () {
      const host = yield* SubscriptionRef.make<HostSnapshot | null>(null);
      const scope = yield* Effect.scope;
      return new SessionBridge(options, host, scope);
    });
  }

  /** The session key on every message: the session's storage root. */
  readonly key: string;
  private readonly source: FramerSource;
  private readonly ports = new Map<string, PortEntry>();

  private constructor(
    private readonly options: SessionBridgeOptions,
    private readonly host: SubscriptionRef.SubscriptionRef<HostSnapshot | null>,
    private readonly scope: Scope.Scope,
  ) {
    const { session } = options;
    this.key = session.roots.storage;
    this.source = {
      key: this.key,
      view: session.view,
      inputs: session.inputs,
      setTranscriptSubscriptions: session.subscriptions.set,
    };
  }

  /** The host's producers write the snapshot every port frames (8.1). */
  setHost(snapshot: HostSnapshot): Effect.Effect<void> {
    return SubscriptionRef.set(this.host, snapshot);
  }

  /** The host acting on surface-owned state (8.5): every attached port
   *  applies it, so the sidebar and the editor tab follow together. */
  surfaceAction(action: SurfaceActionMessage['action']): void {
    for (const { port } of this.ports.values()) {
      port.send({ kind: 'surface.action', session: this.key, action });
    }
  }

  attach(port: SessionPort): Effect.Effect<AttachedPort, Error> {
    return Effect.gen({ self: this }, function* () {
      // `Scope.state` is the module's documented read of a scope's state
      // (its "Checking scope states" example); `Scope` exports no predicate.
      // The read is load-bearing: `Scope.fork` of a closed parent hands back
      // an already-closed child rather than failing, so without it a closed
      // bridge would register a dead port silently.
      if (this.scope.state._tag === 'Closed') {
        return yield* Effect.fail(
          new Error('SessionBridge is closed; cannot attach a port'),
        );
      }
      // A port re-attaching under a live id supersedes the previous one.
      // Close it to completion before installing the replacement so the old
      // entry's cleanup cannot be skipped by the new map entry.
      const previous = this.ports.get(port.id);
      if (previous) {
        yield* previous.close;
      }
      const scope = yield* Scope.fork(this.scope);
      const framers = yield* Scope.fork(scope);
      const entry: PortEntry = {
        port,
        scope,
        framers,
        close: Scope.close(scope, Exit.void),
        fiber: null,
      };
      const { session, onPortClosed } = this.options;
      yield* Scope.addFinalizer(
        scope,
        Effect.suspend(() => {
          if (this.ports.get(port.id) !== entry) return Effect.void;
          this.ports.delete(port.id);
          return session.subscriptions
            .set(port.id, [])
            .pipe(Effect.andThen(Effect.sync(() => onPortClosed(port.id))));
        }),
      );
      this.ports.set(port.id, entry);
      return {
        receive: (message) => this.receive(entry, message),
        close: entry.close,
      };
    });
  }

  /**
   * Answer a `Subscribe`: the next replay's fiber interrupts the one in
   * flight before its first frame, so the superseded generation stops
   * before the next starts and `receive` never waits on it; the frames a
   * dying fiber still cuts echo its generation and the decoder drops them.
   */
  private subscribe(
    entry: PortEntry,
    subscribe: Subscribe,
  ): Effect.Effect<void> {
    return Effect.suspend(() => {
      const previous = entry.fiber;
      const frames = Stream.runForEach(
        frameSubscription(this.source, entry.port.id, this.host, subscribe),
        (frame) => Effect.sync(() => entry.port.send(frame)),
      );
      return Effect.forkIn(
        previous
          ? Fiber.interrupt(previous).pipe(Effect.andThen(frames))
          : frames,
        entry.framers,
      ).pipe(
        Effect.map((fiber) => {
          entry.fiber = fiber;
        }),
      );
    });
  }

  private receive(entry: PortEntry, message: unknown): Effect.Effect<void> {
    return Effect.suspend(() => {
      const { port } = entry;
      if (this.ports.get(port.id) !== entry) return Effect.void;
      const parsed = UpMessageSchema.safeParse(message);
      if (!parsed.success) {
        const envelope = RequestEnvelopeSchema.safeParse(message);
        const reason = `Unparseable message from port ${port.id}: ${z.prettifyError(parsed.error)}`;
        log.warn(reason);
        if (envelope.success) {
          port.send({
            kind: 'response',
            session: envelope.data.session,
            requestId: envelope.data.requestId,
            result: { ok: false, error: { _tag: 'Invalid', reason } },
          });
        }
        return Effect.void;
      }
      const up = parsed.data;
      if (up.session !== this.key) {
        log.warn(
          `Port ${port.id} addressed session ${up.session}; this backend is ${this.key}`,
        );
        return Effect.void;
      }
      switch (up.kind) {
        case 'subscribe':
          return this.subscribe(entry, up);
        case 'runtime.request':
          return this.answer(
            entry,
            up.requestId,
            this.options.session.requests.request(up.request).pipe(
              Effect.match({
                onFailure: (error): Response['result'] => ({
                  ok: false,
                  error: wireError(error),
                }),
                onSuccess: (outcome): Response['result'] => ({
                  ok: true,
                  outcome,
                }),
              }),
            ),
          );
        case 'host.request':
          return this.answer(
            entry,
            up.requestId,
            Effect.tryPromise({
              try: () => this.options.handleHostRequest(up.request, port.id),
              catch: (error) => error,
            }).pipe(
              Effect.matchEffect({
                onFailure: (error): Effect.Effect<Response['result']> =>
                  isRefusal(error)
                    ? Effect.succeed({ ok: false, error: wireError(error) })
                    : Effect.die(error),
                onSuccess: (outcome): Effect.Effect<Response['result']> =>
                  Effect.succeed({ ok: true, outcome }),
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
  private answer(
    entry: PortEntry,
    requestId: string,
    result: Effect.Effect<Response['result']>,
  ): Effect.Effect<void> {
    return Effect.forkIn(
      result.pipe(
        Effect.catchCause((cause) =>
          Effect.sync((): Response['result'] => {
            log.error(
              `Request ${requestId} from port ${entry.port.id} failed: ${toErrorMessage(Cause.squash(cause))}`,
            );
            return {
              ok: false,
              error: wireError(new Internal({ ref: requestId })),
            };
          }),
        ),
        Effect.flatMap((answer) =>
          Effect.sync(() => {
            if (this.ports.get(entry.port.id) !== entry) return;
            entry.port.send({
              kind: 'response',
              session: this.key,
              requestId,
              result: answer,
            });
          }),
        ),
        Effect.uninterruptible,
      ),
      this.scope,
    ).pipe(Effect.asVoid);
  }
}
