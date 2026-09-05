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
 * drop would leave the sender's latch pending forever.
 */
import { Effect, Fiber, Stream, SubscriptionRef } from 'effect';
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
import type { RequestError } from '@shared/session/requestErrors';
import {
  UpMessageSchema,
  type DownMessage,
  type HostOutcome,
  type RequestErrorWire,
  type Response,
  type Subscribe,
} from '@shared/session/sessionFrames';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('ProgressBackend');

/** Enough of any up message to answer it: a message that names a request
 *  id gets its `Invalid` response even when the rest did not parse. */
const RequestEnvelopeSchema = z.object({
  session: z.string(),
  requestId: z.string().min(1),
});

export interface ProgressBackendOptions {
  readonly session: SessionHandle;
  /** The host's capabilities (8.3), performed on the surface's behalf. */
  readonly handleHostRequest: (request: HostRequest) => Promise<HostOutcome>;
}

/** One attached transport port: the host posts `send`'s messages to it. */
export interface ProgressPort {
  readonly id: string;
  readonly send: (message: DownMessage) => void;
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
    case 'Rejected':
      return { _tag: 'Rejected', reason: error.reason };
  }
}

/**
 * One port's framer fiber on the process runtime: `subscribe` answers a
 * `Subscribe` and supersedes the replay in flight; `close` interrupts it and
 * removes the port's transcript set, so the union the fold sees drops what
 * only this port held.
 */
class PortFramer {
  private fiber: Fiber.Fiber<void> | null = null;

  constructor(
    private readonly source: FramerSource,
    private readonly port: ProgressPort,
    private readonly host: SubscriptionRef.SubscriptionRef<HostSnapshot | null>,
  ) {}

  subscribe(subscribe: Subscribe): void {
    this.interrupt();
    this.fiber = effectRuntime().runFork(
      Stream.runForEach(
        frameSubscription(this.source, this.port.id, this.host, subscribe),
        (frame) => Effect.sync(() => this.port.send(frame)),
      ),
    );
  }

  close(): void {
    this.interrupt();
    effectRuntime().runFork(
      this.source.setTranscriptSubscriptions(this.port.id, []),
    );
  }

  private interrupt(): void {
    if (!this.fiber) return;
    effectRuntime().runFork(Fiber.interrupt(this.fiber));
    this.fiber = null;
  }
}

export class ProgressBackend {
  /** The session key on every message: the session's storage root. */
  readonly key: string;
  private readonly session: SessionHandle;
  private readonly handleHostRequest: ProgressBackendOptions['handleHostRequest'];
  private readonly host = effectRuntime().runSync(
    SubscriptionRef.make<HostSnapshot | null>(null),
  );
  private readonly ports = new Map<string, PortFramer>();
  private disposed = false;

  constructor(options: ProgressBackendOptions) {
    this.session = options.session;
    this.handleHostRequest = options.handleHostRequest;
    this.key = options.session.roots.storage;
  }

  /** The host's producers write the snapshot every port frames (8.1). */
  setHost(snapshot: HostSnapshot): void {
    if (this.disposed) return;
    effectRuntime().runFork(SubscriptionRef.set(this.host, snapshot));
  }

  attach(port: ProgressPort): AttachedPort {
    if (this.disposed) {
      throw new Error('ProgressBackend is disposed; cannot attach a port');
    }
    this.ports.get(port.id)?.close();
    const { session } = this;
    const source: FramerSource = {
      key: this.key,
      view: session.view,
      events: session.events,
      local: session.local,
      chunks: session.chunks,
      setTranscriptSubscriptions: (id, set) =>
        Effect.sync(() => session.setTranscriptSubscriptions(id, set)),
    };
    const framer = new PortFramer(source, port, this.host);
    this.ports.set(port.id, framer);
    return {
      receive: (message) => this.receive(port, framer, message),
      close: () => {
        if (this.ports.get(port.id) !== framer) return;
        this.ports.delete(port.id);
        framer.close();
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const framer of this.ports.values()) framer.close();
    this.ports.clear();
  }

  private receive(
    port: ProgressPort,
    framer: PortFramer,
    message: unknown,
  ): void {
    if (this.disposed) return;
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
        void this.handleHostRequest(up.request).then(
          (outcome) => this.respond(port, up.requestId, { ok: true, outcome }),
          (defect: unknown) => this.defect(port, up.requestId, defect),
        );
        return;
    }
  }

  private respond(
    port: ProgressPort,
    requestId: string,
    result: Response['result'],
  ): void {
    if (this.disposed || !this.ports.has(port.id)) return;
    port.send({ kind: 'response', session: this.key, requestId, result });
  }

  /** A handler died: loud, and answered, so the sender's latch clears. */
  private defect(port: ProgressPort, requestId: string, defect: unknown): void {
    const reason = toErrorMessage(defect);
    log.error(`Request ${requestId} from port ${port.id} failed: ${reason}`);
    this.respond(port, requestId, {
      ok: false,
      error: { _tag: 'Rejected', reason },
    });
  }
}
