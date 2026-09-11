import { Effect, Fiber, Stream } from 'effect';

// Local imports - runtime events
import type { SessionHandle } from '@agent/runtime';
import { effectRuntime } from '@platform/processRuntime';
import { aggregateTarget } from '@shared/schemas';

interface StatusBarSessionEventOptions {
  session: Pick<SessionHandle, 'events' | 'now' | 'status'>;
  onStatusChanged: () => void;
  onUsageChanged: () => void;
}

/**
 * Refreshes the extension status bar when the canonical session status and
 * usage facts change. The facts themselves are not mirrored here: the status
 * bar's tracker projects live from the session status plane and the session
 * snapshot store, which the runtime updates before these readers run. Reads
 * the session's event plane from now on (PRD one-fold-three-renderers, 7.1).
 */
export function subscribeStatusBarSessionEvents({
  session,
  onStatusChanged,
  onUsageChanged,
}: StatusBarSessionEventOptions): () => void {
  const fiber = effectRuntime().runFork(
    Stream.runForEach(session.events.all(session.now()), (event) =>
      Effect.sync(() => {
        // A run's terminal phase rides `run.end`, not a `status` row (one run
        // model, section 3.3), so both rows are status changes here exactly as
        // the session treats them for its own status readers.
        if (event.type === 'status' || event.type === 'run.end') {
          onStatusChanged();
        }
        // The runtime publishes the in-flight status before usage for a
        // round; usage for a run not in flight cannot change the projected
        // total, so stale async events skip the refresh.
        if (event.type === 'usage') {
          const target = aggregateTarget(event.aggregateId);
          if (target.kind === 'run' && session.status.isInFlight(target.id)) {
            onUsageChanged();
          }
        }
      }),
    ),
  );
  return () => {
    effectRuntime().runFork(Fiber.interrupt(fiber));
  };
}
