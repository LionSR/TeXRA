import { createLog } from '@logger/logUtils';
import type { MainViewPersistedState } from '@shared/schemas';

interface PendingStateData {
  state: MainViewPersistedState;
  executeImmediately?: boolean;
}

const MAX_PENDING_STATES = 10;
const pendingStateQueue: PendingStateData[] = [];

const log = createLog('pendingStateManager');

export function setPendingState(
  state: MainViewPersistedState,
  executeImmediately?: boolean,
): void {
  if (pendingStateQueue.length >= MAX_PENDING_STATES) {
    // Bounded queue: drop the oldest pending restore, but never silently.
    const dropped = pendingStateQueue.shift();
    log.warn('Pending-state queue full; dropping the oldest pending restore', {
      data: {
        droppedExecuteImmediately: dropped?.executeImmediately,
        queueLength: pendingStateQueue.length,
      },
    });
  }
  pendingStateQueue.push({ state, executeImmediately });
}

export function consumePendingState(): PendingStateData | undefined {
  return pendingStateQueue.shift();
}
