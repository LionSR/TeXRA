// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import { WorkspaceStateKey } from '@common/state/stateManager';
import { StreamTabsManager } from '@progressView/managers/StreamTabsManager';
import type { MementoStorage } from '@progressView/persistence/PersistentMapManager';

describe('StreamTabsManager', () => {
  class InMemoryMementoStorage implements MementoStorage {
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

  it('replaces duplicate message ids instead of appending', async () => {
    const storage = new InMemoryMementoStorage();
    const manager = new StreamTabsManager(storage);
    const streamId = 'stream:abc';

    const firstMessage = {
      id: 'log-1',
      text: 'first entry',
      level: 'info' as const,
      timestamp: Date.now(),
    };

    const updatedMessage = {
      ...firstMessage,
      text: 'updated entry',
      timestamp: Date.now() + 1,
    };

    const wasAdded = await manager.addMessage(streamId, firstMessage);
    const wasUpdated = await manager.addMessage(streamId, updatedMessage);

    const messages = manager.getMessages(streamId);
    assert.equal(wasAdded, true);
    assert.equal(wasUpdated, false);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], updatedMessage);

    const persisted = storage.get<Record<string, unknown>>(
      WorkspaceStateKey.STREAM_TABS,
      {},
    );
    assert.ok(persisted);
    assert.equal(Object.keys(persisted!).length, 1);
  });
});
