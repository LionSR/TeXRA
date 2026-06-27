import {
  onRuntimeStreamStatusChange,
  type RuntimeStreamStatusChange,
} from '@agent/runtime/streamControl';
import { cliState, setStreamStatusInCliState } from './cliState';

export function applyStreamStatusChange(
  change: RuntimeStreamStatusChange,
): void {
  setStreamStatusInCliState({
    streamId: change.streamId,
    status: change.status,
  });
}

export function onStreamStatusChange(
  listener: (change: RuntimeStreamStatusChange) => void,
): () => void {
  return onRuntimeStreamStatusChange(listener);
}
