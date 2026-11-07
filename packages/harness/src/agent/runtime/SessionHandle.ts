/**
 * What opening a session supplies (`SessionHandleInit`) and the shape of
 * its requests (`SessionRequestsShape`, served as `SessionRequests`). A session is one per workspace storage root, built and held
 * by the process's session owner (`SessionOwner`, served by `processLayer`);
 * its layer serves each owner it built as its own service, which a
 * run-scoped caller reads from context, never through a module singleton.
 * It has no readiness gate: a restored session is usable the moment it
 * exists, and the view's `readOnly` and `group` rules decide how a run with
 * no loop here reads.
 */

import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type {
  RequestError,
  OutcomeOf,
  RuntimeCommand,
} from '@shared/session/runtimeRequest';
import type { Effect } from 'effect';

import type { HostInteractions } from './HostInteractions';
import type { SessionServices } from './rootLaunch';

/**
 * What opening a session supplies (`SessionOwner.open`): persistence mode and
 * the host's presentation. The event plane is the session's own, built per
 * workspace root, so a separately injected plane could not silently drop a
 * session's facts onto one nobody reads.
 */
export interface SessionHandleInit {
  /** The workspace this session works on: the opener is the one caller that
   *  knows which project it opened. */
  readonly roots: WorkspaceRoots;
  /** A presentation host the session is born with: it answers while no
   *  host is attached. */
  readonly interactions?: HostInteractions;
  /** Absent, the project's database; ephemeral, a throwaway one. */
  readonly transcriptMode?: { readonly kind: 'ephemeral' };
}

/**
 * Everything one session's requests are: the one handler of every request a
 * surface issues. A run's own questions to a person are rows of the run,
 * opened and decided through `agent/runtime/requests.ts`.
 * Built by the session layer over that session's log (`SessionRequests.ts`);
 * one value per session, so two sessions admit, serialize and answer
 * requests independently. A surface's request reads the session's runs and
 * owners from its caller's context: the session's own, which the SDK and
 * the session's fibers provide.
 */
export interface SessionRequestsShape {
  /** Answer a surface's request once: its kind's {@link OutcomeOf}, or an error. */
  readonly request: <R extends RuntimeCommand>(
    req: R,
  ) => Effect.Effect<OutcomeOf<R['kind']>, RequestError, SessionServices>;
}
