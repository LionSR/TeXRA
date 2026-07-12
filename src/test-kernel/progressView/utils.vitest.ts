// Suites for @progressView/frontend utils (composed-path, state rounds,
// bounded id set).

import { strict as assert } from 'node:assert';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { getComposedPathElement } from '@progressView/frontend/utils';
import { updateRounds } from '@progressView/frontend/stateUtils';
import { createBoundedIdSet } from '@utils/core/boundedIdSet';

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------

type RoundItems = Record<string, string[]>;

type UpdateRoundsCase = {
  title: string;
  current: RoundItems;
  update: { rounds?: RoundItems; reset?: boolean };
  expected: RoundItems;
};

/**
 * Run `body` with `globalThis.Element` / `HTMLElement` pointing at a fresh
 * JSDOM instance so `instanceof Element` checks resolve, restoring the original
 * globals afterwards.
 */
function withDomGlobals<T>(html: string, body: (document: Document) => T): T {
  const dom = new JSDOM(html);
  const originalElement = globalThis.Element;
  const originalHTMLElement = globalThis.HTMLElement;
  globalThis.Element = dom.window.Element;
  globalThis.HTMLElement = dom.window.HTMLElement;
  try {
    return body(dom.window.document);
  } finally {
    globalThis.Element = originalElement;
    globalThis.HTMLElement = originalHTMLElement;
  }
}

describe('getComposedPathElement', () => {
  it('returns the first matching element from the composed path', () => {
    withDomGlobals(
      '<button data-command="run"><span class="inner"></span></button>',
      (document) => {
        const button = document.querySelector('button') as HTMLElement;
        const span = document.querySelector('span') as HTMLElement;
        const event = {
          composedPath: () => [span, button],
        } as unknown as Event;

        assert.equal(
          getComposedPathElement<HTMLElement>(event, '[data-command]'),
          button,
        );
      },
    );
  });

  it('returns null when no element matches', () => {
    withDomGlobals('<div><span class="inner"></span></div>', (document) => {
      const span = document.querySelector('span') as HTMLElement;
      const event = {
        composedPath: () => [span],
      } as unknown as Event;

      assert.equal(
        getComposedPathElement<HTMLElement>(event, '[data-command]'),
        null,
      );
    });
  });
});

describe('updateRounds', () => {
  it.each<UpdateRoundsCase>([
    {
      title: 'replaces all rounds on reset',
      current: { round1: ['a'], round2: ['b'] },
      update: { reset: true, rounds: { round3: ['c'] } },
      expected: { round3: ['c'] },
    },
    {
      title: 'clears all rounds on reset without rounds',
      current: { round1: ['a'], round2: ['b'] },
      update: { reset: true },
      expected: {},
    },
    {
      title: 'merges new rounds into existing ones',
      current: { round1: ['a'] },
      update: { rounds: { round2: ['b'] } },
      expected: { round1: ['a'], round2: ['b'] },
    },
  ])('$title', ({ current, update, expected }) => {
    assert.deepEqual(updateRounds(current, update), expected);
  });
});

// ---------------------------------------------------------------------------
// BoundedIdSet
// ---------------------------------------------------------------------------

describe('createBoundedIdSet', () => {
  it('refreshes recency on repeated add', () => {
    const ids = createBoundedIdSet(2);

    ids.add('a');
    ids.add('b');
    ids.add('a');
    ids.add('c');

    expect(ids.has('a')).toBe(true);
    expect(ids.has('b')).toBe(false);
    expect(ids.has('c')).toBe(true);
  });
});
