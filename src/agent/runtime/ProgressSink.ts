import { bus, type ProgressEventPayloads } from '@eventBus/ProgressEventBus';

export interface ProgressSink {
  emit<K extends keyof ProgressEventPayloads>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void;
}

export const defaultProgressSink: ProgressSink = bus;
