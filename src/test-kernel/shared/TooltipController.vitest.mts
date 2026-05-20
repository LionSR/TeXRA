// Third-party imports
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  Element: globalThis.Element,
  HTMLElement: globalThis.HTMLElement,
  MouseEvent: globalThis.MouseEvent,
  requestAnimationFrame: globalThis.requestAnimationFrame,
};

function installDom(): void {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'http://localhost',
  });

  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.Element = dom.window.Element;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  }) as typeof requestAnimationFrame;
}

function restoreDom(): void {
  globalThis.document = originalGlobals.document;
  globalThis.window = originalGlobals.window;
  globalThis.Element = originalGlobals.Element;
  globalThis.HTMLElement = originalGlobals.HTMLElement;
  globalThis.MouseEvent = originalGlobals.MouseEvent;
  if (originalGlobals.requestAnimationFrame === undefined) {
    delete (globalThis as { requestAnimationFrame?: unknown })
      .requestAnimationFrame;
  } else {
    globalThis.requestAnimationFrame = originalGlobals.requestAnimationFrame;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  restoreDom();
});

describe('toolbar tooltip controller', () => {
  it('does not clobber a wa-button title that changes while hovered', async () => {
    vi.useFakeTimers();
    installDom();

    const { installToolbarTooltips } =
      await import('@shared/controllers/TooltipController');
    installToolbarTooltips();

    const button = document.createElement('wa-button');
    button.setAttribute('title', 'Copy text');
    document.body.append(button);

    button.dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true, composed: true }),
    );
    vi.advanceTimersByTime(501);

    expect(button.hasAttribute('title')).toBe(false);

    button.setAttribute('title', 'Copied!');
    button.dispatchEvent(
      new MouseEvent('mouseout', {
        bubbles: true,
        composed: true,
        relatedTarget: document.body,
      }),
    );

    expect(button.getAttribute('title')).toBe('Copied!');
  });
});
