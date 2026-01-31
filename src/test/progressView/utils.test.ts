// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import { JSDOM } from 'jsdom';

// Local imports
import { getComposedPathElement } from '@progressView/frontend/utils';

describe('getComposedPathElement', () => {
  it('returns the first matching element from the composed path', () => {
    const dom = new JSDOM(
      '<button data-command="run"><span class="inner"></span></button>',
    );
    const originalElement = globalThis.Element;
    const originalHTMLElement = globalThis.HTMLElement;
    globalThis.Element = dom.window.Element;
    globalThis.HTMLElement = dom.window.HTMLElement;

    const button = dom.window.document.querySelector('button') as HTMLElement;
    const span = dom.window.document.querySelector('span') as HTMLElement;
    const event = {
      composedPath: () => [span, button],
    } as Event;

    const result = getComposedPathElement<HTMLElement>(event, '[data-command]');

    assert.equal(result, button);

    globalThis.Element = originalElement;
    globalThis.HTMLElement = originalHTMLElement;
  });

  it('returns null when no element matches', () => {
    const dom = new JSDOM('<div><span class="inner"></span></div>');
    const originalElement = globalThis.Element;
    const originalHTMLElement = globalThis.HTMLElement;
    globalThis.Element = dom.window.Element;
    globalThis.HTMLElement = dom.window.HTMLElement;

    const span = dom.window.document.querySelector('span') as HTMLElement;
    const event = {
      composedPath: () => [span],
    } as Event;

    const result = getComposedPathElement<HTMLElement>(event, '[data-command]');

    assert.equal(result, null);

    globalThis.Element = originalElement;
    globalThis.HTMLElement = originalHTMLElement;
  });
});
