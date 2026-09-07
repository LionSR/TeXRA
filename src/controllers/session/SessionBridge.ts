/**
 * The host-neutral bridge owner of a session's webview ports (PRD
 * one-fold-three-renderers, 7.4, 8.1 to 8.5): one `SessionFramer` per
 * attached port, the `Subscribe` handler, and the two request handlers.
 * The extension attaches its sidebar webview and its editor tab as two
 * ports, the desktop attaches its renderer per open paper; each port's
 * frames are cut from the same session graph and each port's transcript set
 * is one member of the union the fold sees. What the host renders but does
 * not own rides every port's frames as the `host` snapshot, one level per
 * backend that the host's producers write through `setHost`.
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
  Deferred,
  Effect,
  Fiber,
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
import { effectRuntime } from '@platform/processRuntime';
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
  type ReaderProgress,
  type Subscribe,
  type SurfaceActionMessage,
} from '@shared/session/sessionFrames';
import { SessionReaderError } from '@shared/session/sessionReadBudget';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('SessionBridge');

/** Enough of any up message to answer it: a message that names a request
 *  id gets its `Invalid` response even when the rest did not parse. */
const RequestEnvelopeSchema = z.object({
  session: z.string(),
  requestId: z.string().min(1),
});

export interface SessionBridgeOptions {
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
export interface SessionPort {
  readonly id: string;
  /** Resolves when the host accepted delivery; receiver progress is separate. */
  readonly send: (message: DownMessage) => Promise<void>;
}

/** What the backend gives a host per attached port. */
export interface AttachedPort {
  /** One message from the port, unparsed. */
  readonly receive: (message: unknown) => void;
  /** The port went away: its replay is interrupted and its transcript set
   *  leaves the union. */
  readonly close: () => void;
}

function wireError(error: RequestError): RequestErrorWire {
  switch (error._tag) {
    case 'NotOwner':
      return { _tag: 'NotOwner', streamId: error.streamId };
    case 'Unavailable':
      return {
        _tag: 'Unavailable',
        streamId: error.streamId,
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

/**
 * One port's framer fiber on the process runtime: `subscribe` answers a
 * `Subscribe` and supersedes the replay in flight; `close` interrupts it and
 * removes the port's transcript set, so the union the fold sees drops what
 * only this port held.
 */
class PortFramer {
  private static nextInstance = 0;
  /** Public port ids can be reused after detach. Only this attachment can
   * clear its own transcript interest, even while old cleanup is pending. */
  private readonly subscriptionPort = `bridge/${(PortFramer.nextInstance += 1)}`;
  private fiber: Fiber.Fiber<void> | null = null;
  private generation = -1;
  private pending: {
    readonly sequence: number;
    readonly done: Deferred.Deferred<void>;
  } | null = null;

  constructor(
    private readonly source: FramerSource,
    private readonly port: SessionPort,
    private readonly host: SubscriptionRef.SubscriptionRef<HostSnapshot | null>,
  ) {}

  subscribe(subscribe: Subscribe): void {
    if (subscribe.generation <= this.generation) return;
    const previous = this.fiber;
    this.generation = subscribe.generation;
    this.pending = null;
    this.fiber = effectRuntime().runFork(
      Effect.gen({ self: this }, function* () {
        // A replacement waits for the old read's cleanup before acquiring
        // this port's transcript interests, so its finalizer cannot clear ours.
        if (previous) yield* Fiber.interrupt(previous);
        yield* Stream.runForEach(
          frameSubscription(
            this.source,
            this.subscriptionPort,
            this.host,
            subscribe,
          ),
          (frame) =>
            Effect.gen({ self: this }, function* () {
              const done = yield* Deferred.make<void>();
              this.pending = { sequence: frame.sequence, done };
              // One frame in flight. The receiver acknowledges only after
              // staging/consuming it; posting alone cannot release this credit.
              yield* Effect.tryPromise({
                try: () => this.port.send(frame),
                catch: (error) => error,
              }).pipe(
                Effect.andThen(Deferred.await(done)),
                Effect.timeoutOrElse({
                  duration: '30 seconds',
                  orElse: () =>
                    Effect.fail(
                      new Error(
                        'The conversation view stopped receiving updates.',
                      ),
                    ),
                }),
              );
              this.pending = null;
            }),
        );
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.void;
          const failure = Cause.squash(cause);
          const error =
            failure instanceof Error &&
            failure.cause instanceof SessionReaderError
              ? failure.cause
              : failure;
          log.warn(
            `Conversation reader ${this.port.id} stopped: ${toErrorMessage(error)}`,
          );
          return Effect.tryPromise({
            try: () =>
              this.port.send({
                kind: 'reader.error',
                session: this.source.key,
                generation: subscribe.generation,
                reason:
                  error instanceof SessionReaderError
                    ? error.message
                    : 'Conversation delivery was interrupted. Reload the conversation to continue.',
                retryable: !(error instanceof SessionReaderError),
              }),
            catch: (deliveryError) => deliveryError,
          }).pipe(
            Effect.timeout('5 seconds'),
            // The root failure is logged above; this port cannot receive a notice.
            Effect.catch(() => Effect.void),
          );
        }),
        Effect.ensuring(
          this.source.setTranscriptSubscriptions(this.subscriptionPort, []),
        ),
      ),
    );
  }

  acknowledge(progress: ReaderProgress): void {
    if (
      progress.generation !== this.generation ||
      progress.sequence !== this.pending?.sequence
    )
      return;
    Deferred.doneUnsafe(this.pending.done, Effect.void);
  }

  stop(generation: number): void {
    if (generation === this.generation) this.interrupt();
  }

  close(): void {
    this.interrupt();
  }

  private interrupt(): void {
    if (!this.fiber) return;
    effectRuntime().runFork(Fiber.interrupt(this.fiber));
    // Keep the interrupted fiber as the cleanup barrier for a restart
    // within this attachment.
    this.pending = null;
  }
}

export class SessionBridge {
  /** The session key on every message: the session's storage root. */
  readonly key: string;
  private readonly session: SessionHandle;
  private readonly handleHostRequest: SessionBridgeOptions['handleHostRequest'];
  private readonly onPortClosed: SessionBridgeOptions['onPortClosed'];
  private readonly host = effectRuntime().runSync(
    SubscriptionRef.make<HostSnapshot | null>(null),
  );
  private readonly ports = new Map<
    string,
    { readonly port: SessionPort; readonly framer: PortFramer }
  >();
  private disposed = false;

  constructor(options: SessionBridgeOptions) {
    this.session = options.session;
    this.handleHostRequest = options.handleHostRequest;
    this.onPortClosed = options.onPortClosed;
    this.key = options.session.roots.storage;
  }

  /** The host's producers write the snapshot every port frames (8.1). */
  setHost(snapshot: HostSnapshot): void {
    if (this.disposed) return;
    effectRuntime().runFork(SubscriptionRef.set(this.host, snapshot));
  }

  /** The host acting on surface-owned state (8.5): every attached port
   *  applies it, so the sidebar and the editor tab follow together. */
  surfaceAction(action: SurfaceActionMessage['action']): void {
    if (this.disposed) return;
    for (const port of this.ports.keys()) {
      const target = this.portOf(port);
      if (target)
        this.send(target, {
          kind: 'surface.action',
          session: this.key,
          action,
        });
    }
  }

  attach(port: SessionPort): AttachedPort {
    if (this.disposed) {
      throw new Error('SessionBridge is disposed; cannot attach a port');
    }
    this.closePort(port.id);
    const { session } = this;
    const source: FramerSource = {
      key: this.key,
      view: session.view,
      inputs: session.inputs,
      setTranscriptSubscriptions: session.subscriptions.set,
    };
    const framer = new PortFramer(source, port, this.host);
    this.ports.set(port.id, { port, framer });
    return {
      receive: (message) => this.receive(port, framer, message),
      close: () => {
        if (this.ports.get(port.id)?.framer !== framer) return;
        this.closePort(port.id);
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.ports.keys()) this.closePort(id);
  }

  private closePort(id: string): void {
    const held = this.ports.get(id);
    if (!held) return;
    this.ports.delete(id);
    held.framer.close();
    this.onPortClosed(id);
  }

  private receive(
    port: SessionPort,
    framer: PortFramer,
    message: unknown,
  ): void {
    if (this.disposed || this.portOf(port.id) !== port) return;
    const parsed = UpMessageSchema.safeParse(message);
    if (!parsed.success) {
      const envelope = RequestEnvelopeSchema.safeParse(message);
      const reason = `Unparseable message from port ${port.id}: ${z.prettifyError(parsed.error)}`;
      log.warn(reason);
      if (envelope.success) {
        this.send(port, {
          kind: 'response',
          session: envelope.data.session,
          requestId: envelope.data.requestId,
          result: { ok: false, error: { _tag: 'Invalid', reason } },
        });
      }
      return;
    }
    const up = parsed.data;
    if (up.session !== this.key) {
      log.warn(
        `Port ${port.id} addressed session ${up.session}; this backend is ${this.key}`,
      );
      return;
    }
    switch (up.kind) {
      case 'subscribe':
        framer.subscribe(up);
        return;
      case 'reader.stop':
        framer.stop(up.generation);
        return;
      case 'reader.progress':
        framer.acknowledge(up);
        return;
      case 'runtime.request':
        void effectRuntime()
          .runPromise(
            this.session.requests.request(up.request).pipe(
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
          )
          .then(
            (result) => this.respond(port, up.requestId, result),
            (defect: unknown) => this.defect(port, up.requestId, defect),
          );
        return;
      case 'host.request':
        void this.handleHostRequest(up.request, port.id).then(
          (outcome) => this.respond(port, up.requestId, { ok: true, outcome }),
          (error: unknown) => {
            if (
              error instanceof Cancelled ||
              error instanceof Unavailable ||
              error instanceof Rejected
            ) {
              this.respond(port, up.requestId, {
                ok: false,
                error: wireError(error),
              });
              return;
            }
            this.defect(port, up.requestId, error);
          },
        );
        return;
    }
  }

  private portOf(id: string): SessionPort | undefined {
    return this.ports.get(id)?.port;
  }

  private respond(
    port: SessionPort,
    requestId: string,
    result: Response['result'],
  ): void {
    if (this.disposed || this.portOf(port.id) !== port) return;
    this.send(port, { kind: 'response', session: this.key, requestId, result });
  }

  /** Requests have their own lifetime; a reader restart never cancels them. */
  private send(port: SessionPort, message: DownMessage): void {
    void port.send(message).then(undefined, (error: unknown) => {
      log.warn(
        `Posting ${message.kind} to ${port.id} failed: ${toErrorMessage(error)}`,
      );
    });
  }

  /** A handler died: the cause goes to the host log under the request id,
   *  and the port is answered so the sender's latch clears. */
  private defect(port: SessionPort, requestId: string, defect: unknown): void {
    log.error(
      `Request ${requestId} from port ${port.id} failed: ${toErrorMessage(defect)}`,
    );
    this.respond(port, requestId, {
      ok: false,
      error: wireError(new Internal({ ref: requestId })),
    });
  }
}
