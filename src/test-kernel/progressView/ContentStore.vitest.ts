// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - module under test
import { createContentStore } from '@progressView/frontend/formatters/contentStore';

describe('createContentStore', () => {
  it('derives a stable, content-hash-based ID and returns the same ID for equal content', () => {
    const store = createContentStore<string>({
      max: 10,
      prefix: 'auto',
      serialize: (content) => content,
    });

    const id1 = store.register('hello world');
    const id2 = store.register('hello world');

    expect(id1).toBe(id2);
    expect(id1).toMatch(/^auto:\d+:[0-9a-z]+$/);
    expect(store.get(id1)).toBe('hello world');
  });

  it('produces different IDs for different content', () => {
    const store = createContentStore<string>({
      max: 10,
      prefix: 'auto',
      serialize: (content) => content,
    });

    expect(store.register('foo')).not.toBe(store.register('bar'));
  });

  it('honors an explicit ID and overwrites stale content stored under it', () => {
    const store = createContentStore<string>({
      max: 10,
      prefix: 'auto',
      serialize: (content) => content,
    });

    const id = store.register('first version', 'stream-1');
    expect(id).toBe('stream-1');
    expect(store.get('stream-1')).toBe('first version');

    store.register('second version', 'stream-1');
    expect(store.get('stream-1')).toBe('second version');
  });

  it('clears all entries', () => {
    const store = createContentStore<string>({
      max: 10,
      prefix: 'auto',
      serialize: (content) => content,
    });

    const id = store.register('content');
    store.clear();

    expect(store.get(id)).toBeUndefined();
  });
});
