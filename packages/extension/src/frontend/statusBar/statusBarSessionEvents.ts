// Local imports - runtime events
import type { SessionHandle } from '@agent/runtime';

export interface StatusBarSessionEventOptions {
  session: Pick<SessionHandle, 'events' | 'status'>;
  onStatusChanged: () => void;
  onUsageChanged: () => void;
}

/**
 * Refreshes the extension status bar when the canonical session status and
 * usage facts change. The facts themselves are not mirrored here: the status
 * bar's tracker projects live from the session status plane and the session
 * snapshot store, which the runtime updates before these subscribers run.
 */
export function subscribeStatusBarSessionEvents({
  session,
  onStatusChanged,
  onUsageChanged,
}: StatusBarSessionEventOptions): () => void {
  const disposeStatus = session.events.subscribeStatus(onStatusChanged);

  const disposeUsage = session.events.subscribe(
    (sessionEvent) => {
      if (sessionEvent.scope !== 'run') return;
      if (sessionEvent.event.type !== 'usage') return;
      // The runtime publishes the in-flight status before usage for a round;
      // usage for a stream not in flight cannot change the projected total,
      // so stale async events skip the refresh.
      if (session.status.isInFlight(sessionEvent.event.payload.streamId)) {
        onUsageChanged();
      }
    },
    { scope: 'run', types: ['usage'] },
  );

  return () => {
    disposeStatus();
    disposeUsage();
  };
}
