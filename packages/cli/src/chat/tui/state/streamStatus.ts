import type { StreamStatusChange } from '@agent/runtime/StreamStatusService';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { setStreamStatusInCliState } from './cliState';

export function applyStreamStatusChange(change: StreamStatusChange): boolean {
  return setStreamStatusInCliState({
    streamId: change.streamId,
    status: change.status,
    ...(change.substate ? { substate: change.substate } : {}),
  });
}

export function onStreamStatusChange(
  listener: (change: StreamStatusChange) => void,
): () => void {
  return defaultSession().status.onDidChange(listener);
}
