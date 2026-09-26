/**
 * How a test ends what it started: a run's handle registration, or a whole
 * session. Side-effect free, unlike the default-session setup, so any suite
 * can import it.
 */

import { Effect } from 'effect';

import type { RunRegistry } from '@agent/runtime/runRegistry';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { closeSession } from '@agent/runtime/sessionGraph';
import type { RunId } from '@shared/schemas';

/** End a tracked run's handle registration the way its lifecycle does at
 *  its terminal, for a test that stands in for that lifecycle. */
export function untrackRun(runs: RunRegistry, runId: RunId): void {
  const handle = runs.getHandle(runId);
  if (handle) runs.untrackIfCurrent(handle);
}

/** Close a session through the one close every session takes, for a test
 *  that ends a session it opened. */
export function closeSessionOf(session: SessionHandle): Effect.Effect<void> {
  return Effect.asVoid(closeSession(session.roots.storage));
}
