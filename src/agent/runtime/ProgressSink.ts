import { bus, type ProgressEventPayloads } from '@eventBus/ProgressEventBus';

export interface ProgressSink {
  emit<K extends keyof ProgressEventPayloads>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void;
}

export class EventBusProgressSink implements ProgressSink {
  constructor(private readonly eventBus: ProgressSink) {}

  emit<K extends keyof ProgressEventPayloads>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void {
    this.eventBus.emit(event, payload);
  }
}

export const defaultProgressSink: ProgressSink = new EventBusProgressSink(bus);
