// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - module under test
import { createContentStore } from '@progressView/frontend/formatters/contentStore';

function createStringStore() {
  return createContentStore<string>({
    max: 10,
    prefix: 'auto',
    serialize: (content) => content,
  });
}

describe('createContentStore', () => {
  it('derives a stable, content-hash-based ID and returns the same ID for equal content', () => {
    const store = createStringStore();

    const id1 = store.register('hello world');
    const id2 = store.register('hello world');

    expect(id1).toBe(id2);
    expect(id1).toMatch(/^auto:\d+:[0-9a-z]+$/);
    expect(store.get(id1)).toBe('hello world');
  });

  it('produces different IDs for different content', () => {
    const store = createStringStore();

    expect(store.register('foo')).not.toBe(store.register('bar'));
  });

  it('honors an explicit ID and overwrites stale content stored under it', () => {
    const store = createStringStore();

    const id = store.register('first version', 'stream-1');
    expect(id).toBe('stream-1');
    expect(store.get('stream-1')).toBe('first version');

    store.register('second version', 'stream-1');
    expect(store.get('stream-1')).toBe('second version');
  });

  it('clears all entries', () => {
    const store = createStringStore();

    const id = store.register('content');
    store.clear();

    expect(store.get(id)).toBeUndefined();
  });

  it('resolves object values re-registered as structurally-equal-but-distinct references to the same ID and content', () => {
    // Mirrors proposalInputStore: freshly parsed objects must re-register to
    // the same ID even though the reference-equality guard sees new references.
    interface Proposal {
      readonly title: string;
      readonly steps: readonly string[];
    }
    const store = createContentStore<Proposal>({
      max: 10,
      prefix: 'proposal',
      serialize: (proposal) => JSON.stringify(proposal),
    });

    const first: Proposal = { title: 'demo', steps: ['a', 'b'] };
    const second: Proposal = { title: 'demo', steps: ['a', 'b'] };
    expect(first).not.toBe(second);

    const id1 = store.register(first);
    const id2 = store.register(second);

    expect(id1).toBe(id2);
    expect(store.get(id1)).toEqual({ title: 'demo', steps: ['a', 'b'] });
  });
});
