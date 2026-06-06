import {
  StreamStatusService,
  type StreamStatusChange,
} from '@agent/runtime/StreamStatusService';
import { type StreamStatus, type StreamTabId } from '@shared/schemas';

import { cliState, setStreamStatusInCliState } from './cliState';

export function applyStreamStatusChange(change: StreamStatusChange): void {
  setStreamStatusInCliState({
    streamId: change.streamId,
    status: change.status,
  });
}

export function streamStatusFromState(
  streamId: StreamTabId,
): StreamStatus | undefined {
  return cliState.streams.get().get(streamId)?.status;
}

export function onStreamStatusChange(
  listener: (change: StreamStatusChange) => void,
): () => void {
  return StreamStatusService.onDidChange(listener);
}
