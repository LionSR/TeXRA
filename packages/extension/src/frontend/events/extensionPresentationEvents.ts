import { EventEmitter } from 'node:events';

import type { ProgressEventPayloads } from '@eventBus/ProgressEventContract';

export const EXTENSION_PRESENTATION_EVENTS = [
  'requestOpenFile',
  'requestShowInstruction',
  'showAgentConfigBanner',
  'requestShowError',
  'requestEnsureProgressView',
] as const satisfies readonly (keyof ProgressEventPayloads)[];

export type ExtensionPresentationEvent =
  (typeof EXTENSION_PRESENTATION_EVENTS)[number];

const EVENT_SET = new Set<keyof ProgressEventPayloads>(
  EXTENSION_PRESENTATION_EVENTS,
);

const MAX_BUFFER_SIZE = 1000;

export function isExtensionPresentationEvent(
  event: keyof ProgressEventPayloads,
): event is ExtensionPresentationEvent {
  return EVENT_SET.has(event);
}

class ExtensionPresentationEventBus {
  private readonly emitter = new EventEmitter();
  private buffer: {
    event: ExtensionPresentationEvent;
    payload: ProgressEventPayloads[ExtensionPresentationEvent];
  }[] = [];

  emit(
    event: ExtensionPresentationEvent,
    payload: ProgressEventPayloads[ExtensionPresentationEvent],
  ): void {
    if (this.emitter.listenerCount(event) === 0) {
      this.buffer.push({ event, payload });
      if (this.buffer.length > MAX_BUFFER_SIZE) {
        this.buffer.shift();
      }
      return;
    }
    this.emitter.emit(event, payload);
  }

  on<K extends ExtensionPresentationEvent>(
    event: K,
    listener: (payload: ProgressEventPayloads[K]) => void,
    options?: { signal?: AbortSignal },
  ): () => void {
    if (options?.signal?.aborted) return () => {};

    this.emitter.on(event, listener);
    const cleanup = (): void => {
      this.emitter.off(event, listener);
    };
    options?.signal?.addEventListener('abort', cleanup, { once: true });

    const remaining: typeof this.buffer = [];
    for (const item of this.buffer) {
      if (item.event === event) {
        listener(item.payload as ProgressEventPayloads[K]);
      } else {
        remaining.push(item);
      }
    }
    this.buffer = remaining;

    return cleanup;
  }
}

export const extensionPresentationEvents = new ExtensionPresentationEventBus();
