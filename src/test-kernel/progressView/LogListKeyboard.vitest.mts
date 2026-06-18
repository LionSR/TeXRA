// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - progress view component types
import type { LogList } from '@progressView/frontend/components/LogList';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

useLitComponentTestDom(
  () => import('@progressView/frontend/components/LogList'),
);

interface LogListTestHooks {
  handleKeyEvent(event: Event): void;
  activateLinkFromEvent(event: Event): boolean;
}

describe('log-list keyboard activation', () => {
  it('uses the composed path for transcript links across shadow roots', () => {
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

    hooks.handleKeyEvent(event);

    expect(activateLinkFromEvent).toHaveBeenCalledWith(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not re-activate links when a child handler consumed the key', () => {
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
    event.preventDefault();

    const hooks = element as unknown as LogListTestHooks;
    const activateLinkFromEvent = vi.fn(() => true);
    hooks.activateLinkFromEvent = activateLinkFromEvent;

    hooks.handleKeyEvent(event);

    expect(activateLinkFromEvent).not.toHaveBeenCalled();
  });
});
