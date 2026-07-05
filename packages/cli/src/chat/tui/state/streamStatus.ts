import {
  StreamStatusService,
  type StreamStatusChange,
} from '@agent/runtime/StreamStatusService';
import { setStreamStatusInCliState } from './cliState/streamsSlice';

export function applyStreamStatusChange(change: StreamStatusChange): void {
  setStreamStatusInCliState({
    streamId: change.streamId,
    status: change.status,
    ...(change.substate ? { substate: change.substate } : {}),
  });
}

export function onStreamStatusChange(
  listener: (change: StreamStatusChange) => void,
): () => void {
  return StreamStatusService.onDidChange(listener);
}
