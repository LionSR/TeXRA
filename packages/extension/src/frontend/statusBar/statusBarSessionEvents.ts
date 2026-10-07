import { Effect, Stream } from 'effect';

// Local imports - runtime events
import type { SessionBackend } from '@texra/controllers/session/sessionBackend';
import type { StatusBarUsageTracker } from './StatusBarUsageTracker';

interface StatusBarSessionEventOptions {
  session: Pick<SessionBackend, 'view'>;
  /** What the two callbacks paint: the subscription refreshes the bar when
   *  one of these projections moves, and nothing else. */
  tracker: Pick<
    StatusBarUsageTracker,
    'activity' | 'activeRunCount' | 'totalUsage'
  >;
  onStatusChanged: () => void;
  onUsageChanged: () => void;
}

/**
 * Refreshes the extension status bar when the projection it paints moves,
 * for as long as the caller's fiber runs it (activation forks it into its
 * scope).
 *
 * The one input is the session's view as a level stream
 * (`SessionHandle.view.changes`, PRD 7.2): the fold's own state, so it carries
 * both the durable rows and the local facts no row records — an owner proved
 * dead reclassifies its runs as interrupted with nothing committed, and the
 * fold-gated event tail would never wake this listener for it. Nothing is
 * mirrored here: each view is read back through the tracker, and a view that
 * leaves both projections where they were paints nothing.
 */
export function refreshStatusBarOnViewChanges({
  session,
  tracker,
  onStatusChanged,
  onUsageChanged,
}: StatusBarSessionEventOptions): Effect.Effect<void> {
  // Unseeded on purpose: `view.changes` replays the current view on subscribe,
  // and that first emission must paint both projections (a run already
  // RUNNING when the bar subscribes would otherwise read Idle until the count
  // next changes).
  let status: string | undefined;
  let usage: StatusBarUsageTracker['totalUsage'] | undefined;
  return Stream.runForEach(session.view.changes, () =>
    Effect.sync(() => {
      const nextStatus = `${tracker.activity}/${tracker.activeRunCount}`;
      if (nextStatus !== status) {
        status = nextStatus;
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
  );
}
