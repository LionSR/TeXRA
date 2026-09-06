/**
 * The webview side of the events transport (PRD one-fold-three-renderers,
 * 7.4, 7.7, 8.1): the decoder that turns host-bridge messages into frame
 * deliveries, request responses, and surface actions, and the signals the
 * root reads. The runtime and the per-session graphs are
 * `webviewSessionLayer`'s; the rest of the frontend reads signals and posts
 * `UpMessage`s, and nothing else touches the session layer. The entry owns
 * the window's one message listener and hands each message to `receive`;
 * the desktop renderer runs it as the last of its routes.
 */
import { Effect, Exit, Scope, SubscriptionRef } from 'effect';
import { z } from 'zod';

import {
  installWebviewRuntime,
  WebviewSessions,
} from '@controllers/session/webviewSessionLayer';
import { hostBridge } from '@shared/hostBridge';
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
  /** One message from the host bridge: true when it was a session message
   *  and this transport took it, false when it belongs to another route. */
  receive(data: unknown): boolean;
  /** Open (or reuse) a session's graph. */
  open(session: string): WebviewSession;
  /** A new generation over the named transcript aggregates. */
  subscribe(session: WebviewSession, aggregates: Subscribe['aggregates']): void;
  /** Answered on the matching `response` message. */
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
}

/** The discriminator alone: a message of one of the session kinds that
 *  still fails the schema is malformed, not another route's. */
const DownKindSchema = z.object({
  kind: z.enum(
    DownMessageSchema.options.map((option) => option.shape.kind.value),
  ),
});

export function installWebviewTransport(): WebviewTransport {
  const runtime = installWebviewRuntime();
  const sessions = new Map<string, OpenSession>();
  const pending = new Map<string, (result: Response['result']) => void>();
  let surfaceListener: (
    session: string,
    action: WireSurfaceAction,
  ) => void = () => undefined;

  /** Route one frame to its session's frames service; the frames service
   *  drops a frame of another generation. A frame for a session that is
   *  not open is the host's defect, dropped loudly. `feed` is synchronous,
   *  so frames are fed in arrival order on the caller's turn: a forked
   *  fiber per frame would let the scheduler interleave two frames' rows. */
  const deliver = (frame: EventsFrame): void => {
    const session = sessions.get(frame.session);
    if (!session) {
      console.warn(
        `[progress] dropped a frame for session ${frame.session}: not open`,
      );
      return;
    }
    runtime.runSync(session.graph.frames.feed(frame));
  };

  const receive = (data: unknown): boolean => {
    const parsed = DownMessageSchema.safeParse(data);
    if (!parsed.success) {
      if (!DownKindSchema.safeParse(data).success) return false;
      console.warn('[progress] malformed session message', data, parsed.error);
      return true;
    }
    const message = parsed.data;
    switch (message.kind) {
      case 'events':
        deliver(message);
        return true;
      case 'response': {
        const settle = pending.get(message.requestId);
        if (!settle) {
          console.warn(
            `[progress] dropped a response to request ${message.requestId}: not pending`,
          );
          return true;
        }
        pending.delete(message.requestId);
        settle(message.result);
        return true;
      }
      case 'surface.action':
        surfaceListener(message.session, message.action);
        return true;
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
      const scope = runtime.runSync(Scope.make());
      const graph = runtime.runSync(
        WebviewSessions.open(key).pipe(
          Effect.provideService(Scope.Scope, scope),
        ),
      );
      const session: OpenSession = {
        key,
        graph,
        scope,
        view$: toSignal(
          runtime,
          SubscriptionRef.changes(graph.view.ref),
          SubscriptionRef.getUnsafe(graph.view.ref),
        ),
        host$: toSignal(runtime, graph.host.changes, null),
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
      hostBridge.postMessage(message);
    },
    request(message) {
      return new Promise((resolve) => {
        pending.set(message.requestId, resolve);
        hostBridge.postMessage(message);
      });
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

/** The aggregates a surface names for a selected stream (contract C7): the
 *  stream's own and, through `run.start`, its execution aggregate, each from
 *  the seq the view retained for it. */
export function transcriptAggregates(
  view: SessionView,
  streamId: string | null,
): Subscribe['aggregates'] {
  if (streamId === null) return [];
  const stream = view.streams.get(streamId);
  if (!stream) return [];
  return [streamId, stream.executionId].map((id) => ({
    id,
    fromSeq: view.folded.get(id) ?? 0,
  }));
}
