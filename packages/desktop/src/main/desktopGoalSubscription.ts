/**
 * The desktop host's run edge for goal-change subscriptions (PRD R1: the
 * fork lives at the host entry, not in the store). Mirrors the extension's
 * `runFactSubscriptions`: one fiber draining the session's goal stream, an
 * unsubscribe that interrupts it, and no other runtime contact.
 */
import { Effect, Fiber, Stream } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import { effectRuntime } from '@platform/processRuntime';
import { goalStateChanges, type GoalStateChange } from '@tools/goal';

/** Read a session's goal-state changes from now on. */
export function subscribeDesktopGoalChanges(
  session: Pick<SessionHandle, 'events' | 'now'>,
  listener: (change: GoalStateChange) => void,
): () => void {
  const fiber = effectRuntime().runFork(
    Stream.runForEach(goalStateChanges(session), (change) =>
      Effect.sync(() => listener(change)),
    ),
  );
  return () => {
    effectRuntime().runFork(Fiber.interrupt(fiber));
  };
}
