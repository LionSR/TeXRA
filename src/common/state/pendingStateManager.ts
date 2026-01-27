import type { MainViewPersistedState } from '@shared/schemas';

interface PendingStateData {
  state: MainViewPersistedState;
  executeImmediately?: boolean;
}

const MAX_PENDING_STATES = 10;
const pendingStateQueue: PendingStateData[] = [];

export function setPendingState(
  state: MainViewPersistedState,
  executeImmediately?: boolean,
): void {
  if (pendingStateQueue.length >= MAX_PENDING_STATES) {
    pendingStateQueue.shift();
  }
  pendingStateQueue.push({ state, executeImmediately });
}

export function consumePendingState(): PendingStateData | undefined {
  return pendingStateQueue.shift();
}
