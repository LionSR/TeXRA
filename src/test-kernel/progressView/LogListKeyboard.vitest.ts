import { describe, expect, it, vi } from 'vitest';

import type { LogList } from '@progressView/frontend/components/LogList';
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

useLitComponentTestDom(
  () => import('@progressView/frontend/components/LogList'),
);

interface LogListTestHooks {
  handleKeyEvent(event: Event): void;
  activateLinkFromEvent(event: Event): boolean;
  streamCache: {
    readonly size: number;
    has(streamId: string): boolean;
    rkeys(): Generator<string, void, unknown>;
  };
  getOrCreateEntry(streamId: string): unknown;
}

function setupEnterKeyOnLink(): {
  event: KeyboardEvent;
  hooks: LogListTestHooks;
  activateLinkFromEvent: ReturnType<typeof vi.fn>;
} {
  const element = document.createElement('log-list') as LogList;
  const link = document.createElement('span');
  link.className = 'file-link clickable-link';

  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  Object.defineProperty(event, 'composedPath', {
    configurable: true,
    value: () => [link, element, document.body, document, window],
  });

  const hooks = element as unknown as LogListTestHooks;
  const activateLinkFromEvent = vi.fn(() => true);
  hooks.activateLinkFromEvent = activateLinkFromEvent;

  return { event, hooks, activateLinkFromEvent };
}

describe('log-list keyboard activation', () => {
  it('uses the composed path for transcript links across shadow roots', () => {
    const { event, hooks, activateLinkFromEvent } = setupEnterKeyOnLink();

    hooks.handleKeyEvent(event);

    expect(activateLinkFromEvent).toHaveBeenCalledWith(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not re-activate links when a child handler consumed the key', () => {
    const { event, hooks, activateLinkFromEvent } = setupEnterKeyOnLink();
    event.preventDefault();

    hooks.handleKeyEvent(event);

    expect(activateLinkFromEvent).not.toHaveBeenCalled();
  });
});

describe('log-list stream cache', () => {
  function createCacheHooks(): LogListTestHooks {
    return document.createElement('log-list') as unknown as LogListTestHooks;
  }

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
