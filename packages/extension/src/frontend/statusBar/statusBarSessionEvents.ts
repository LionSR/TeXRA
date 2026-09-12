import { Effect, Fiber, Stream } from 'effect';

// Local imports - runtime events
import type { SessionHandle } from '@agent/runtime';
import { effectRuntime } from '@platform/processRuntime';
import { aggregateTarget } from '@shared/schemas';
import { isInFlightPhase } from '@shared/runs/runStatus';

interface StatusBarSessionEventOptions {
  session: Pick<SessionHandle, 'folded' | 'now' | 'runView'>;
  onStatusChanged: () => void;
  onUsageChanged: () => void;
}

/**
 * Refreshes the extension status bar when a run's phase or usage moves. The
 * facts themselves are not mirrored here: both callbacks read the session's
 * fold, so this reads the fold-gated tail (`SessionHandle.folded`, PRD 7.2)
 * and not the raw plane. A row reaches these readers only once the view holds
 * the state that row produced, so a terminal `run.end` never refreshes a
 * status bar that still projects the run as running.
 */
export function subscribeStatusBarSessionEvents({
  session,
  onStatusChanged,
  onUsageChanged,
}: StatusBarSessionEventOptions): () => void {
  const fiber = effectRuntime().runFork(
    Stream.runForEach(session.folded(session.now()), (event) =>
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
