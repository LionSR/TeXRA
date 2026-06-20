import {
  StreamStatusService,
  type StreamStatusChange,
} from '@agent/runtime/StreamStatusService';
import { cliState, setStreamStatusInCliState } from './cliState';

export function applyStreamStatusChange(change: StreamStatusChange): void {
  setStreamStatusInCliState({
    streamId: change.streamId,
    status: change.status,
  });
}

export function onStreamStatusChange(
  listener: (change: StreamStatusChange) => void,
): () => void {
  return StreamStatusService.onDidChange(listener);
}
