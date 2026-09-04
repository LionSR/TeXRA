/**
 * The session graph port: how a `SessionHandle` reaches the Effect services
 * of its session (PRD one-fold-three-renderers, 7.2, 7.3, 7.7) without this
 * layer importing them. The services are built per workspace root by the
 * `Sessions` layer map in `src/controllers/session/sessionLayer.ts`, on the
 * one `ManagedRuntime` each process makes at its entry
 * (`installProcessRuntime`), which installs the opener here beside
 * `initPlatform()`, exactly as it installs the process roots. `src/agent`
 * never imports `src/controllers`, so the graph arrives through this port
 * rather than by import; the runtime itself is reached through
 * `effectRuntime()` (`@platform/processRuntime`).
 */

import type {
  CommitOrdinal,
  LocalRuntimeState,
  TranscriptSubscription,
} from '@shared/schemas';
import type { RequestError } from '@shared/session/requestErrors';
import type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
import type { SessionView } from '@shared/session/sessionView';
import type { Effect, SubscriptionRef } from 'effect';
import type { SessionEventsShape } from './SessionEvents';
import type { SessionHandle } from './SessionHandle';

/** What a session holds of its graph, resolved once at construction. */
export interface SessionGraph {
  readonly events: SessionEventsShape;
  /** The one session state every renderer reads: the fold fiber's level. */
  readonly view: SubscriptionRef.SubscriptionRef<SessionView>;
  /** This process's local truth; the status machine writes `unreadable`. */
  readonly local: SubscriptionRef.SubscriptionRef<LocalRuntimeState>;
  /** The transcript subscription set, one set per port (PRD 7.2). */
  readonly subscriptions: {
    readonly set: (
      port: string,
      set: readonly TranscriptSubscription[],
    ) => Effect.Effect<void>;
  };
  /** The one handler of every request a surface issues to this session
   *  (PRD 7.6, 8.2): answered exactly once, an outcome or a request error. */
  readonly requests: {
    readonly request: (
      req: RuntimeRequest,
    ) => Effect.Effect<Outcome, RequestError>;
  };
  /** The session's current commit ordinal: where a reader attaching now
   *  starts its `all` read (PRD 10.3). */
  readonly now: () => CommitOrdinal;
  /** Release this session's hold on the graph. */
  readonly close: () => void;
}

export type SessionGraphOpener = (session: SessionHandle) => SessionGraph;

let opener: SessionGraphOpener | undefined;

/** Install the process's graph opener. Called by `installProcessRuntime`
 *  exactly once at startup, right beside `initPlatform()`. */
export function initSessionGraphs(open: SessionGraphOpener): void {
  opener = open;
}

/** Open the graph of `session`'s workspace root. */
export function openSessionGraph(session: SessionHandle): SessionGraph {
  if (!opener) {
    throw new Error(
      'Session graphs not initialized: call installProcessRuntime() before constructing a session.',
    );
  }
  return opener(session);
}
