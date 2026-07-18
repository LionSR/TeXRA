// Local imports - runtime events
import type { SessionHandle } from '@agent/runtime/SessionHandle';

// Local imports - status bar state
import type { StatusBarUsageTracker } from './StatusBarUsageTracker';

export interface StatusBarSessionEventOptions {
  session: Pick<SessionHandle, 'events' | 'status'>;
  tracker: StatusBarUsageTracker;
  onStatusChanged: () => void;
  onUsageChanged: () => void;
}

/**
 * Mirrors the canonical session status and usage facts into the extension
 * status-bar usage tracker.
 */
export function subscribeStatusBarSessionEvents({
  session,
  tracker,
  onStatusChanged,
  onUsageChanged,
}: StatusBarSessionEventOptions): () => void {
  const disposeStatus = session.status.onDidChange(({ streamId, status }) => {
    tracker.updateStreamStatus(streamId, status);
    onStatusChanged();
  });

  const disposeUsage = session.events.subscribe(
    (sessionEvent) => {
      if (sessionEvent.scope !== 'run') return;
      if (sessionEvent.event.type !== 'usage') return;
      const { payload } = sessionEvent.event;
      if (tracker.recordUsage(payload.streamId, payload.usage)) {
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
