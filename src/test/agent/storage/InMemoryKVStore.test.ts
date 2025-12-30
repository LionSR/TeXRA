// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import {
  InMemoryKVStore,
  type ExecutionKVStore,
} from '@agent/storage/ExecutionKVStore';
import type { ExecutionId } from '@agent/types/IdentifierTypes';

describe('InMemoryKVStore', () => {
  let store: InMemoryKVStore;
  const executionId = 'test-execution-123' as ExecutionId;

  beforeEach(() => {
    store = new InMemoryKVStore(executionId);
  });

  describe('getExecutionId', () => {
    it('returns the execution ID provided at construction', () => {
      assert.equal(store.getExecutionId(), executionId);
    });

    it('returns correct execution ID for different instances', () => {
      const executionId2 = 'test-execution-456' as ExecutionId;
      const store2 = new InMemoryKVStore(executionId2);
      assert.equal(store2.getExecutionId(), executionId2);
      assert.notEqual(store2.getExecutionId(), executionId);
    });
  });

  describe('write and read', () => {
    it('stores and retrieves string values', async () => {
      await store.write('key1', 'value1');
      const result = await store.read<string>('key1');
      assert.equal(result, 'value1');
    });

    it('stores and retrieves number values', async () => {
      await store.write('count', 42);
      const result = await store.read<number>('count');
      assert.equal(result, 42);
    });

    it('stores and retrieves boolean values', async () => {
      await store.write('flag', true);
      const result = await store.read<boolean>('flag');
      assert.equal(result, true);
    });

    it('stores and retrieves object values', async () => {
      const obj = { name: 'test', count: 42, nested: { value: true } };
      await store.write('object', obj);
      const result = await store.read<typeof obj>('object');
      assert.deepEqual(result, obj);
    });

    it('stores and retrieves array values', async () => {
      const arr = [1, 2, 3, 'four', { five: 5 }];
      await store.write('array', arr);
      const result = await store.read<typeof arr>('array');
      assert.deepEqual(result, arr);
    });

    it('returns undefined for non-existent keys', async () => {
      const result = await store.read('non-existent');
      assert.equal(result, undefined);
    });

    it('overwrites existing values', async () => {
      await store.write('key', 'value1');
      await store.write('key', 'value2');
      const result = await store.read<string>('key');
      assert.equal(result, 'value2');
    });

    it('performs deep cloning via structuredClone', async () => {
      const original = { nested: { value: 'test' } };
      await store.write('key', original);
      const retrieved = await store.read<typeof original>('key');

      // Modify retrieved object
      retrieved!.nested.value = 'modified';

      // Original in store should be unchanged
      const retrievedAgain = await store.read<typeof original>('key');
      assert.equal(retrievedAgain!.nested.value, 'test');
    });

    it('handles null values', async () => {
      await store.write('null-key', null);
      const result = await store.read('null-key');
      assert.equal(result, null);
    });

    it('stores different types under different keys', async () => {
      await store.write('str', 'text');
      await store.write('num', 123);
      await store.write('obj', { key: 'value' });

      assert.equal(await store.read<string>('str'), 'text');
      assert.equal(await store.read<number>('num'), 123);
      assert.deepEqual(await store.read<object>('obj'), { key: 'value' });
    });
  });

  describe('exists', () => {
    it('returns false for non-existent keys', async () => {
      const exists = await store.exists('non-existent');
      assert.equal(exists, false);
    });

    it('returns true for existing keys', async () => {
      await store.write('key', 'value');
      const exists = await store.exists('key');
      assert.equal(exists, true);
    });

    it('returns true for keys with null values', async () => {
      await store.write('null-key', null);
      const exists = await store.exists('null-key');
      assert.equal(exists, true);
    });

    it('returns false after key is deleted', async () => {
      await store.write('key', 'value');
      await store.delete('key');
      const exists = await store.exists('key');
      assert.equal(exists, false);
    });
  });

  describe('delete', () => {
    it('removes existing keys', async () => {
      await store.write('key', 'value');
      await store.delete('key');
      const result = await store.read('key');
      assert.equal(result, undefined);
    });

    it('is idempotent for non-existent keys', async () => {
      // Should not throw
      await store.delete('non-existent');
      await store.delete('non-existent');
    });

    it('only deletes specified key', async () => {
      await store.write('key1', 'value1');
      await store.write('key2', 'value2');
      await store.delete('key1');

      assert.equal(await store.read('key1'), undefined);
      assert.equal(await store.read('key2'), 'value2');
    });

    it('decreases store size', async () => {
      await store.write('key1', 'value1');
      await store.write('key2', 'value2');
      assert.equal(store.size, 2);

      await store.delete('key1');
      assert.equal(store.size, 1);
    });
  });

  describe('listKeys', () => {
    it('returns empty array for empty store', async () => {
      const keys = await store.listKeys();
      assert.deepEqual(keys, []);
    });

    it('returns all keys when no prefix specified', async () => {
      await store.write('key1', 'value1');
      await store.write('key2', 'value2');
      await store.write('other', 'value3');

      const keys = await store.listKeys();
      assert.equal(keys.length, 3);
      assert.ok(keys.includes('key1'));
      assert.ok(keys.includes('key2'));
      assert.ok(keys.includes('other'));
    });

    it('filters keys by prefix', async () => {
      await store.write('user:1', 'alice');
      await store.write('user:2', 'bob');
      await store.write('session:1', 'session1');
      await store.write('session:2', 'session2');
      await store.write('config', 'value');

      const userKeys = await store.listKeys('user:');
      assert.equal(userKeys.length, 2);
      assert.ok(userKeys.includes('user:1'));
      assert.ok(userKeys.includes('user:2'));

      const sessionKeys = await store.listKeys('session:');
      assert.equal(sessionKeys.length, 2);
      assert.ok(sessionKeys.includes('session:1'));
      assert.ok(sessionKeys.includes('session:2'));
    });

    it('returns empty array when prefix matches no keys', async () => {
      await store.write('key1', 'value1');
      await store.write('key2', 'value2');

      const keys = await store.listKeys('prefix:');
      assert.deepEqual(keys, []);
    });

    it('handles exact key name as prefix', async () => {
      await store.write('exact', 'value1');
      await store.write('exact:suffix', 'value2');

      const keys = await store.listKeys('exact');
      assert.equal(keys.length, 2);
      assert.ok(keys.includes('exact'));
      assert.ok(keys.includes('exact:suffix'));
    });

    it('is case-sensitive', async () => {
      await store.write('Key1', 'value1');
      await store.write('key2', 'value2');

      const keys = await store.listKeys('key');
      assert.equal(keys.length, 1);
      assert.ok(keys.includes('key2'));
      assert.ok(!keys.includes('Key1'));
    });

    it('returns keys after deletions', async () => {
      await store.write('key1', 'value1');
      await store.write('key2', 'value2');
      await store.write('key3', 'value3');
      await store.delete('key2');

      const keys = await store.listKeys();
      assert.equal(keys.length, 2);
      assert.ok(keys.includes('key1'));
      assert.ok(keys.includes('key3'));
      assert.ok(!keys.includes('key2'));
    });
  });

  describe('clear', () => {
    it('removes all keys', async () => {
      await store.write('key1', 'value1');
      await store.write('key2', 'value2');
      await store.write('key3', 'value3');

      await store.clear();

      assert.equal(await store.read('key1'), undefined);
      assert.equal(await store.read('key2'), undefined);
      assert.equal(await store.read('key3'), undefined);
      assert.equal(store.size, 0);
    });

    it('results in empty key list', async () => {
      await store.write('key1', 'value1');
      await store.write('key2', 'value2');
      await store.clear();

      const keys = await store.listKeys();
      assert.deepEqual(keys, []);
    });

    it('is idempotent on empty store', async () => {
      await store.clear();
      await store.clear();
      assert.equal(store.size, 0);
    });

    it('allows writing after clear', async () => {
      await store.write('key1', 'value1');
      await store.clear();
      await store.write('key2', 'value2');

      assert.equal(await store.read('key1'), undefined);
      assert.equal(await store.read('key2'), 'value2');
      assert.equal(store.size, 1);
    });
  });

  describe('size property', () => {
    it('returns 0 for empty store', () => {
      assert.equal(store.size, 0);
    });

    it('increases with writes', async () => {
      assert.equal(store.size, 0);
      await store.write('key1', 'value1');
      assert.equal(store.size, 1);
      await store.write('key2', 'value2');
      assert.equal(store.size, 2);
    });

    it('does not increase when overwriting', async () => {
      await store.write('key', 'value1');
      assert.equal(store.size, 1);
      await store.write('key', 'value2');
      assert.equal(store.size, 1);
    });

    it('decreases with deletes', async () => {
      await store.write('key1', 'value1');
      await store.write('key2', 'value2');
      assert.equal(store.size, 2);
      await store.delete('key1');
      assert.equal(store.size, 1);
    });

    it('becomes 0 after clear', async () => {
      await store.write('key1', 'value1');
      await store.write('key2', 'value2');
      await store.clear();
      assert.equal(store.size, 0);
    });
  });

  describe('interface compliance', () => {
    it('implements ExecutionKVStore interface', () => {
      const kvStore: ExecutionKVStore = store;
      assert.ok(kvStore.read);
      assert.ok(kvStore.write);
      assert.ok(kvStore.delete);
      assert.ok(kvStore.exists);
      assert.ok(kvStore.listKeys);
      assert.ok(kvStore.clear);
      assert.ok(kvStore.getExecutionId);
    });
  });

  describe('isolation between instances', () => {
    it('maintains separate stores for different execution IDs', async () => {
      const executionId2 = 'test-execution-456' as ExecutionId;
      const store2 = new InMemoryKVStore(executionId2);

      await store.write('key', 'value1');
      await store2.write('key', 'value2');

      assert.equal(await store.read('key'), 'value1');
      assert.equal(await store2.read('key'), 'value2');
    });

    it('operations on one store do not affect another', async () => {
      const executionId2 = 'test-execution-456' as ExecutionId;
      const store2 = new InMemoryKVStore(executionId2);

      await store.write('key1', 'value1');
      await store2.write('key2', 'value2');

      await store.clear();

      assert.equal(store.size, 0);
      assert.equal(store2.size, 1);
      assert.equal(await store2.read('key2'), 'value2');
    });
  });

  describe('complex data structures', () => {
    it('handles deeply nested objects', async () => {
      const complex = {
        level1: {
          level2: {
            level3: {
              level4: {
                value: 'deep',
                array: [1, 2, 3],
              },
            },
          },
        },
      };

      await store.write('complex', complex);
      const result = await store.read<typeof complex>('complex');
      assert.deepEqual(result, complex);
    });

    it('handles arrays of objects', async () => {
      const data = [
        { id: 1, name: 'Alice', tags: ['admin', 'user'] },
        { id: 2, name: 'Bob', tags: ['user'] },
        { id: 3, name: 'Charlie', tags: ['guest'] },
      ];

      await store.write('users', data);
      const result = await store.read<typeof data>('users');
      assert.deepEqual(result, data);
    });

    it('handles mixed type arrays', async () => {
      const mixed = [1, 'two', { three: 3 }, [4, 5], null, true];
      await store.write('mixed', mixed);
      const result = await store.read<typeof mixed>('mixed');
      assert.deepEqual(result, mixed);
    });

    it('handles Date objects via structuredClone', async () => {
      const date = new Date('2025-01-01T00:00:00Z');
      await store.write('date', date);
      const result = await store.read<Date>('date');
      assert.ok(result instanceof Date);
      assert.equal(result.getTime(), date.getTime());
    });

    it('handles Map objects via structuredClone', async () => {
      const map = new Map([
        ['key1', 'value1'],
        ['key2', 'value2'],
      ]);
      await store.write('map', map);
      const result = await store.read<Map<string, string>>('map');
      assert.ok(result instanceof Map);
      assert.equal(result.get('key1'), 'value1');
      assert.equal(result.get('key2'), 'value2');
    });

    it('handles Set objects via structuredClone', async () => {
      const set = new Set([1, 2, 3, 4, 5]);
      await store.write('set', set);
      const result = await store.read<Set<number>>('set');
      assert.ok(result instanceof Set);
      assert.equal(result.size, 5);
      assert.ok(result.has(3));
    });
  });

  describe('key naming', () => {
    it('supports various key formats', async () => {
      const keys = [
        'simple',
        'kebab-case',
        'snake_case',
        'camelCase',
        'PascalCase',
        'with.dots',
        'with:colons',
        'with/slashes',
        'numbers123',
        '123numbers',
        'special!@#$%',
      ];

      for (const key of keys) {
        await store.write(key, `value-${key}`);
      }

      for (const key of keys) {
        const value = await store.read<string>(key);
        assert.equal(value, `value-${key}`);
      }

      const allKeys = await store.listKeys();
      assert.equal(allKeys.length, keys.length);
    });

    it('treats empty string as valid key', async () => {
      await store.write('', 'empty-key-value');
      assert.equal(await store.read<string>(''), 'empty-key-value');
      assert.equal(await store.exists(''), true);

      const keys = await store.listKeys();
      assert.ok(keys.includes(''));
    });
  });
});
