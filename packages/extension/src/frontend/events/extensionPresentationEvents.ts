import { EventEmitter } from 'node:events';

import {
  isRuntimePresentationEvent,
  type RuntimePresentationEvent,
  type RuntimePresentationEventPayloads,
} from '@agent/runtime/runtimePresentationEvents';

/**
 * Extension host-presentation channel: the five UI requests the agent core
 * emits that the VS Code frontend renders (file opens, instruction toasts,
 * banners, errors, progress-view reveals). Payloads are the fact-native
 * presentation types from `@shared/schemas`.
 */
export type ExtensionPresentationEventPayloads =
  RuntimePresentationEventPayloads;

export type ExtensionPresentationEvent = RuntimePresentationEvent;

const MAX_BUFFER_SIZE = 1000;

export function isExtensionPresentationEvent(
  event: string,
): event is ExtensionPresentationEvent {
  return isRuntimePresentationEvent(event);
}

class ExtensionPresentationEventBus {
  private readonly emitter = new EventEmitter();
  private buffer: {
    event: ExtensionPresentationEvent;
    payload: ExtensionPresentationEventPayloads[ExtensionPresentationEvent];
  }[] = [];

  emit(
    event: ExtensionPresentationEvent,
    payload: ExtensionPresentationEventPayloads[ExtensionPresentationEvent],
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
    listener: (payload: ExtensionPresentationEventPayloads[K]) => void,
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
        listener(item.payload as ExtensionPresentationEventPayloads[K]);
      } else {
        remaining.push(item);
      }
    }
    this.buffer = remaining;

    return cleanup;
  }
}

export const extensionPresentationEvents = new ExtensionPresentationEventBus();
