// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import type { Memento } from 'vscode';

// Local imports - progress view
import { TaskGroupManager } from '@progressView/managers/TaskGroupManager';
import { StatePersistenceManager } from '@progressView/persistence/StatePersistenceManager';

class MemoryMemento implements Memento {
  private readonly store = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.store.keys()];
  }

  get<T>(key: string, defaultValue?: T): T | undefined {
    if (this.store.has(key)) {
      return this.store.get(key) as T;
    }
    return defaultValue;
  }

  update(key: string, value: any): Thenable<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, value);
    }
    return Promise.resolve();
  }
}

describe('TaskGroupManager', () => {
  it('preserves instruction metadata during deserialization', async () => {
    const memento = new MemoryMemento();
    const persistence = new StatePersistenceManager(memento);
    const manager = new TaskGroupManager(persistence);

    const serialized = {
      'group-1': {
        id: 'group-1',
        name: 'Task',
        startTime: '2024-01-01T00:00:00.000Z',
        status: 'running',
        instruction: {
          text: 'Review the introduction',
          metadata: { showToggle: true, expanded: true },
        },
      },
    } as unknown;

    const map = await (manager as any).deserialize(serialized, 'stream-1');
    const group = map.get('group-1');

    assert.ok(group);
    assert.equal(typeof group?.startTime, 'number');
    assert.deepStrictEqual(group?.instruction, {
      text: 'Review the introduction',
      metadata: { showToggle: true, expanded: true },
    });
  });
});
