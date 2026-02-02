// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import { JSDOM } from 'jsdom';

// Local imports
import { getComposedPathElement } from '@progressView/frontend/utils';
import { updateNestedRounds } from '@progressView/frontend/stateUtils';

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

describe('updateNestedRounds', () => {
  it('clears only the target run when resetting with a runId', () => {
    const current = {
      runA: { round1: ['a'] },
      runB: { round1: ['b'] },
    };

    const result = updateNestedRounds(current, {
      runId: 'runA',
      reset: true,
      rounds: { round2: ['c'] },
    });

    assert.deepEqual(result, {
      runA: { round2: ['c'] },
      runB: { round1: ['b'] },
    });
  });

  it('removes a run on reset when no rounds are provided', () => {
    const current = {
      runA: { round1: ['a'] },
      runB: { round1: ['b'] },
    };

    const result = updateNestedRounds(current, {
      runId: 'runA',
      reset: true,
    });

    assert.deepEqual(result, {
      runB: { round1: ['b'] },
    });
  });
});
