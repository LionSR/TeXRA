// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import { JSDOM } from 'jsdom';

// Local imports
import { getComposedPathElement } from '@progressView/frontend/utils';
import { updateRounds } from '@progressView/frontend/stateUtils';

describe('getComposedPathElement', () => {
  it('returns the first matching element from the composed path', () => {
    const dom = new JSDOM(
      '<button data-command="run"><span class="inner"></span></button>',
    );
    const originalElement = globalThis.Element;
    const originalHTMLElement = globalThis.HTMLElement;
    try {
      globalThis.Element = dom.window.Element;
      globalThis.HTMLElement = dom.window.HTMLElement;

      const button = dom.window.document.querySelector('button') as HTMLElement;
      const span = dom.window.document.querySelector('span') as HTMLElement;
      const event = {
        composedPath: () => [span, button],
      } as unknown as Event;

      const result = getComposedPathElement<HTMLElement>(
        event,
        '[data-command]',
      );

      assert.equal(result, button);
    } finally {
      globalThis.Element = originalElement;
      globalThis.HTMLElement = originalHTMLElement;
    }
  });

  it('returns null when no element matches', () => {
    const dom = new JSDOM('<div><span class="inner"></span></div>');
    const originalElement = globalThis.Element;
    const originalHTMLElement = globalThis.HTMLElement;
    try {
      globalThis.Element = dom.window.Element;
      globalThis.HTMLElement = dom.window.HTMLElement;

      const span = dom.window.document.querySelector('span') as HTMLElement;
      const event = {
        composedPath: () => [span],
      } as unknown as Event;

      const result = getComposedPathElement<HTMLElement>(
        event,
        '[data-command]',
      );

      assert.equal(result, null);
    } finally {
      globalThis.Element = originalElement;
      globalThis.HTMLElement = originalHTMLElement;
    }
  });
});

describe('updateRounds', () => {
  it('replaces all rounds on reset', () => {
    const current = { round1: ['a'], round2: ['b'] };
    const result = updateRounds(current, {
      reset: true,
      rounds: { round3: ['c'] },
    });
    assert.deepEqual(result, { round3: ['c'] });
  });

  it('clears all rounds on reset without rounds', () => {
    const current = { round1: ['a'], round2: ['b'] };
    const result = updateRounds(current, { reset: true });
    assert.deepEqual(result, {});
  });

  it('merges new rounds into existing ones', () => {
    const current = { round1: ['a'] };
    const result = updateRounds(current, { rounds: { round2: ['b'] } });
    assert.deepEqual(result, { round1: ['a'], round2: ['b'] });
  });
});
