import { Effect, Fiber, Stream } from 'effect';

// Local imports - runtime events
import type { SessionHandle } from '@agent/runtime';
import { effectRuntime } from '@platform/processRuntime';
import { aggregateTarget } from '@shared/schemas';
import { isInFlightPhase } from '@shared/runs/runStatus';

interface StatusBarSessionEventOptions {
  session: Pick<SessionHandle, 'events' | 'now' | 'runView'>;
  onStatusChanged: () => void;
  onUsageChanged: () => void;
}

/**
 * Refreshes the extension status bar when a run's phase or usage moves. The
 * facts themselves are not mirrored here: the status bar's tracker projects
 * live from the session's fold, which lands the state before these readers
 * run. Reads the session's event plane from now on (PRD
 * one-fold-three-renderers, 7.1).
 */
export function subscribeStatusBarSessionEvents({
  session,
  onStatusChanged,
  onUsageChanged,
}: StatusBarSessionEventOptions): () => void {
  const fiber = effectRuntime().runFork(
    Stream.runForEach(session.events.all(session.now()), (event) =>
      Effect.sync(() => {
        // The rows the phase is folded from (one run model, section 3.3):
        // an activation, a step (the park and the steps that leave it), and
        // the terminal `run.end`.
        if (
          event.type === 'run.activate' ||
          event.type === 'flow.step' ||
          event.type === 'run.end'
        ) {
          onStatusChanged();
        }
        // The runtime publishes the in-flight status before usage for a
        // round; usage for a run not in flight cannot change the projected
        // total, so stale async events skip the refresh.
        if (event.type === 'usage') {
          const target = aggregateTarget(event.aggregateId);
          if (
            target.kind === 'run' &&
            isInFlightPhase(session.runView(target.id)?.status)
          ) {
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
