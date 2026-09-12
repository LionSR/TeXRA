import { Effect, Fiber, Stream } from 'effect';

// Local imports - runtime events
import type { SessionHandle } from '@agent/runtime';
import { effectRuntime } from '@platform/processRuntime';
import type { StatusBarUsageTracker } from './StatusBarUsageTracker';

interface StatusBarSessionEventOptions {
  session: Pick<SessionHandle, 'viewChanges'>;
  /** What the two callbacks paint: the subscription refreshes the bar when
   *  one of these projections moves, and nothing else. */
  tracker: Pick<StatusBarUsageTracker, 'activeRunCount' | 'totalUsage'>;
  onStatusChanged: () => void;
  onUsageChanged: () => void;
}

/**
 * Refreshes the extension status bar when the projection it paints moves.
 *
 * The one input is the session's view as a level stream
 * (`SessionHandle.viewChanges`, PRD 7.2): the fold's own state, so it carries
 * both the durable rows and the local facts no row records — an owner proved
 * dead reclassifies its runs as interrupted with nothing committed, and the
 * fold-gated event tail would never wake this listener for it. Nothing is
 * mirrored here: each view is read back through the tracker, and a view that
 * leaves both projections where they were paints nothing.
 */
export function subscribeStatusBarSessionEvents({
  session,
  tracker,
  onStatusChanged,
  onUsageChanged,
}: StatusBarSessionEventOptions): () => void {
  // Unseeded on purpose: `viewChanges` replays the current view on subscribe,
  // and that first emission must paint both projections (a run already
  // RUNNING when the bar subscribes would otherwise read Idle until the count
  // next changes).
  let activeRuns: number | undefined;
  let usage: StatusBarUsageTracker['totalUsage'] | undefined;
  const fiber = effectRuntime().runFork(
    Stream.runForEach(session.viewChanges, () =>
      Effect.sync(() => {
        const nextActiveRuns = tracker.activeRunCount;
        if (nextActiveRuns !== activeRuns) {
          activeRuns = nextActiveRuns;
          onStatusChanged();
        }
        const nextUsage = tracker.totalUsage;
        if (
          usage === undefined ||
          nextUsage.cost !== usage.cost ||
          nextUsage.inputTokens !== usage.inputTokens ||
          nextUsage.outputTokens !== usage.outputTokens
        ) {
          usage = nextUsage;
          onUsageChanged();
        }
      }),
    ),
  );
  return () => {
    effectRuntime().runFork(Fiber.interrupt(fiber));
  };
}
