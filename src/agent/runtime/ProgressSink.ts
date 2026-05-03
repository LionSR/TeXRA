import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

export interface ProgressSink {
  emit<K extends keyof ProgressEventPayloads>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void;
}

export const noopProgressSink: ProgressSink = {
  emit: () => {},
};

let defaultProgressSink: ProgressSink = noopProgressSink;

export function setDefaultProgressSink(progressSink: ProgressSink): void {
  defaultProgressSink = progressSink;
}

export function getDefaultProgressSink(): ProgressSink {
  return defaultProgressSink;
}
