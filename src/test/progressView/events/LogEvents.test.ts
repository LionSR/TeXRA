// Standard library imports
import { strict as assert } from 'assert';

// Local imports - logger
import type { LogMessageData } from '@logger/LogTypes';
import { MESSAGE_TYPES } from '@logger/messageTypes';

// Local imports - progress view
import {
  handleAddLogMessage,
  handleUpdateLogMessage,
} from '@progressView/events/handlers';
import {
  createStatefulEventDisposable,
  type ProgressEventBusLike,
} from '@progressView/events/types';
import { StreamTabsManager } from '@progressView/managers/StreamTabsManager';
import type { WebviewUpdater } from '@progressView/managers/WebviewUpdater';
import type { StateStorage } from '@progressView/persistence/PersistentMapManager';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';

class InMemoryStateStorage implements StateStorage {
  private store = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T | undefined {
    if (this.store.has(key)) {
      return this.store.get(key) as T;
    }

    return defaultValue;
  }

  update<T>(key: string, value: T): Thenable<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
}

class TestBus implements ProgressEventBusLike {
  private listeners: Record<string, ((payload: any) => void)[]> = {};

  on<K extends keyof any>(
    event: K,
    listener: (payload: any) => void,
  ): () => void {
    const existing = this.listeners[event as string] ?? [];
    existing.push(listener);
    this.listeners[event as string] = existing;

    return () => {
      this.listeners[event as string] = (
        this.listeners[event as string] ?? []
      ).filter((handler) => handler !== listener);
    };
  }

  emit<K extends keyof any>(event: K, payload: any): void {
    (this.listeners[event as string] ?? []).forEach((listener) =>
      listener(payload),
    );
  }
}

const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

describe('LogEvents', () => {
  it('does not append duplicate thinking entries when a replayed message is updated', async () => {
    const storage = new InMemoryStateStorage();
    const streamTabs = new StreamTabsManager(storage);
    const state = {
      streamTabs,
      activeStream: 'stream:123',
    } as unknown as ProgressViewState;

    const appended: LogMessageData[] = [];
    const updated: LogMessageData[] = [];
    const updater = {
      isAvailable: () => true,
      appendLogMessage: (_stream: string, log: LogMessageData) =>
        appended.push(log),
      updateLogMessage: (_stream: string, log: LogMessageData) =>
        updated.push(log),
    } as unknown as WebviewUpdater;

    const bus = new TestBus();
    const disposables = [
      createStatefulEventDisposable(
        bus,
        'addLogMessage',
        state,
        updater,
        handleAddLogMessage,
      ),
      createStatefulEventDisposable(
        bus,
        'updateLogMessage',
        state,
        updater,
        handleUpdateLogMessage,
      ),
    ];

    const thinkingMessage: LogMessageData = {
      id: 'log-1',
      text: 'thinking...',
      level: 'info',
      timestamp: Date.now(),
      messageType: MESSAGE_TYPES.THINKING,
    };

    bus.emit('addLogMessage', {
      stream: state.activeStream,
      logMessage: thinkingMessage,
    });
    await flushMicrotasks();

    bus.emit('addLogMessage', {
      stream: state.activeStream,
      logMessage: { ...thinkingMessage, text: 'still thinking...' },
    });
    await flushMicrotasks();

    bus.emit('updateLogMessage', {
      stream: state.activeStream,
      logMessage: {
        id: thinkingMessage.id,
        text: 'finished thinking',
      },
    });
    await flushMicrotasks();

    assert.equal(appended.length, 1);
    assert.equal(appended[0].text, 'thinking...');
    assert.equal(updated.length, 1);
    assert.equal(updated[0].text, 'finished thinking');

    disposables.forEach((disposable) => disposable.dispose());
  });
});
