// One paper's session bridge for one renderer window (PRD
// one-fold-three-renderers, 7.4, 8.1 to 8.5): the transport port between
// the paper's session graph in this process and the fold the renderer runs.
// Down go frames, responses, and surface actions; up come the subscribe and
// the two request kinds. The framer owns the reads, the 16 ms framing, and
// the `host` snapshot level on the wire; this module owns the request round
// trip and the port's teardown.

import { Cause, Effect, Exit, Fiber, Stream, SubscriptionRef } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import {
  frameSubscription,
  type FramerSource,
} from '@controllers/session/SessionFramer';
import { effectRuntime } from '@platform/processRuntime';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import { Rejected, Unavailable } from '@shared/session/requestErrors';
import {
  UpMessageSchema,
  type DownMessage,
  type Response,
  type RequestErrorWire,
} from '@shared/session/sessionFrames';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { toLogData } from './desktopLogUtils.js';
import type { DesktopHostRequests } from './desktopHostRequests.js';
import type { DesktopHostSnapshotSource } from './desktopHostSnapshot.js';

/** The host-initiated surface actions the wire carries (PRD 8.5). */
export type DesktopSurfaceAction = Extract<
  DownMessage,
  { kind: 'surface.action' }
>['action'];

interface DesktopSessionBridgeOptions {
  session: SessionHandle;
  /** The session key the renderer addresses this paper by (`view.key`). */
  sessionKey: string;
  /** The port name the runtime keys this window's transcript set under. */
  port: string;
  postToRenderer(message: unknown): boolean | void;
  hostRequests: DesktopHostRequests;
  snapshot: DesktopHostSnapshotSource;
  logger: {
    error(message: string, data?: { data?: unknown }): void;
  };
}

export interface DesktopSessionBridge {
  /** Claims the message when it is this session's; false otherwise. */
  handleMessage(message: unknown): boolean;
  postSurfaceAction(action: DesktopSurfaceAction): void;
  dispose(): void;
}

/** A request error as it crosses the bridge: its wire shape, never an
 *  `Error` instance (structured clone would keep the stack and lose the
 *  class); anything else a handler threw is a worded rejection. */
function errorWire(error: unknown): RequestErrorWire {
  if (error instanceof Unavailable) {
    return {
      _tag: 'Unavailable',
      streamId: error.streamId,
      reason: error.reason,
    };
  }
  if (error instanceof Rejected)
    return { _tag: 'Rejected', reason: error.reason };
  return { _tag: 'Rejected', reason: toErrorMessage(error) };
}

export function createDesktopSessionBridge(
  options: DesktopSessionBridgeOptions,
): DesktopSessionBridge {
  const { session, sessionKey, logger } = options;
  let disposed = false;

  const post = (message: DownMessage) => {
    if (disposed) return;
    options.postToRenderer(message);
  };

  // The framer reads the host level: on every subscribe and on every change
  // the snapshot rides the next frame.
  const host = effectRuntime().runSync(
    SubscriptionRef.make<HostSnapshot | null>(options.snapshot.current()),
  );
  const detachHost = options.snapshot.onChange((snapshot) => {
    effectRuntime().runFork(SubscriptionRef.set(host, snapshot));
  });
  const source: FramerSource = {
    key: sessionKey,
    view: session.view,
    events: session.events,
    local: session.local,
    chunks: session.chunks,
    setTranscriptSubscriptions: (port, set) =>
      Effect.sync(() => session.setTranscriptSubscriptions(port, set)),
  };
  // The framer of this port: one fiber per `Subscribe`, the previous one
  // interrupted, so a later `Subscribe` supersedes the replay in flight.
  let framing: Fiber.Fiber<void> | null = null;
  const stopFraming = () => {
    if (!framing) return;
    effectRuntime().runFork(Fiber.interrupt(framing));
    framing = null;
  };
  const frame = (subscribe: Parameters<typeof frameSubscription>[3]) => {
    stopFraming();
    framing = effectRuntime().runFork(
      Stream.runForEach(
        frameSubscription(source, options.port, host, subscribe),
        (next) => Effect.sync(() => post(next)),
      ),
    );
  };

  const respond = (requestId: string, result: Response['result']) =>
    post({ kind: 'response', session: sessionKey, requestId, result });

  function runtimeRequest(
    requestId: string,
    request: Parameters<SessionHandle['requests']['request']>[0],
  ): void {
    void effectRuntime()
      .runPromiseExit(session.requests.request(request))
      .then((exit) => {
        if (Exit.isSuccess(exit)) {
          respond(requestId, { ok: true, outcome: exit.value });
          return;
        }
        const failure = Cause.findErrorOption(exit.cause);
        if (failure._tag === 'Some') {
          const error = failure.value;
          respond(requestId, {
            ok: false,
            error:
              error._tag === 'NotOwner'
                ? { _tag: 'NotOwner', streamId: error.streamId }
                : errorWire(error),
          });
          return;
        }
        // A defect answers too: one response per request, even a dying
        // one (7.6), logged under the id the surface can quote.
        const ref = `${sessionKey}#${requestId}`;
        logger.error(`Runtime request ${request.kind} died (${ref})`, {
          data: toLogData(Cause.squash(exit.cause)),
        });
        respond(requestId, {
          ok: false,
          error: { _tag: 'Rejected', reason: `Internal error (${ref}).` },
        });
      });
  }

  function hostRequest(
    requestId: string,
    request: Parameters<DesktopHostRequests['handle']>[0],
  ): void {
    options.hostRequests.handle(request).then(
      (outcome) => respond(requestId, { ok: true, outcome }),
      (error: unknown) => {
        if (!(error instanceof Unavailable) && !(error instanceof Rejected)) {
          logger.error(`Host request ${request.kind} failed`, {
            data: toLogData(error),
          });
        }
        respond(requestId, { ok: false, error: errorWire(error) });
      },
    );
  }

  return {
    handleMessage(message) {
      if (disposed) return false;
      const parsed = UpMessageSchema.safeParse(message);
      if (!parsed.success) return false;
      const up = parsed.data;
      if (up.session !== sessionKey) return false;
      switch (up.kind) {
        case 'subscribe':
          frame(up);
          return true;
        case 'runtime.request':
          runtimeRequest(up.requestId, up.request);
          return true;
        case 'host.request':
          hostRequest(up.requestId, up.request);
          return true;
      }
    },
    postSurfaceAction(action) {
      post({ kind: 'surface.action', session: sessionKey, action });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      detachHost();
      stopFraming();
      // The port's transcript set leaves the union the fold sees.
      session.setTranscriptSubscriptions(options.port, []);
      options.hostRequests.dispose();
    },
  };
}
