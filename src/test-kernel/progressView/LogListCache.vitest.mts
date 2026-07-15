// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - progress view component types
import type { LogList } from '@progressView/frontend/components/LogList';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

useLitComponentTestDom(
  () => import('@progressView/frontend/components/LogList'),
);

interface LogListCacheTestHooks {
  streamCache: {
    readonly size: number;
    has(streamId: string): boolean;
    rkeys(): Generator<string, void, unknown>;
  };
  getOrCreateEntry(streamId: string): unknown;
}

function createCacheHooks(): LogListCacheTestHooks {
  const element = document.createElement('log-list') as LogList;
  return element as unknown as LogListCacheTestHooks;
}

describe('log-list stream cache', () => {
  it('reuses cached entries and promotes them to most recently used', () => {
    const hooks = createCacheHooks();
    const originalEntry = hooks.getOrCreateEntry('stream-1');

    hooks.getOrCreateEntry('stream-2');
    const reusedEntry = hooks.getOrCreateEntry('stream-1');

    expect(reusedEntry).toBe(originalEntry);
    expect([...hooks.streamCache.rkeys()]).toEqual(['stream-2', 'stream-1']);
  });

  it('evicts the least-recently used stream at the five-entry bound', () => {
    const hooks = createCacheHooks();

    for (const streamId of [
      'stream-1',
      'stream-2',
      'stream-3',
      'stream-4',
      'stream-5',
    ]) {
      hooks.getOrCreateEntry(streamId);
    }

    hooks.getOrCreateEntry('stream-6');

    expect(hooks.streamCache.size).toBe(5);
    expect(hooks.streamCache.has('stream-1')).toBe(false);
    expect(hooks.streamCache.has('stream-2')).toBe(true);
    expect([...hooks.streamCache.rkeys()]).toEqual([
      'stream-2',
      'stream-3',
      'stream-4',
      'stream-5',
      'stream-6',
    ]);
  });
});
