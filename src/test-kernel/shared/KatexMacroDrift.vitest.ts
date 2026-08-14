import { describe, expect, it } from 'vitest';

import { MAX_STYLE_REPLACEMENTS } from '@replacement/maxRules';
import { katexMacros } from '@shared/markdown/katexMacros';

/** Command tokens that max-style replacements introduce (the shortcut side). */
function maxStyleShortcutTokens(): Set<string> {
  const tokens = new Set<string>();
  const command = /\\[A-Za-z][A-Za-z0-9]*/g;
  for (const destination of Object.values(MAX_STYLE_REPLACEMENTS.patterns)) {
    for (const match of destination.matchAll(command)) {
      tokens.add(match[0]);
    }
  }
  return tokens;
}

/**
 * Shortcuts that KaTeX renders but max-style replacement does not emit.
 * Keep this list explicit: a new katex-only key must be added here or
 * given a max-style destination, so the two tables cannot drift silently.
 */
const KATEX_ONLY_SHORTCUTS = [
  '\\De',
  '\\bGa',
  '\\bLa',
  '\\bal',
  '\\bbt',
  '\\bga',
  '\\bla',
  '\\bom',
  '\\bpsi',
  '\\brho',
  '\\bta',
  '\\btau',
  '\\eZ',
  '\\tv',
] as const;

describe('katexMacros vs maxRules shortcuts', () => {
  it('keeps every KaTeX shortcut key in max-style destinations or the explicit katex-only list', () => {
    const shortcuts = maxStyleShortcutTokens();
    const katexKeys = Object.keys(katexMacros);
    const unexplained = katexKeys
      .filter(
        (key) =>
          !shortcuts.has(key) &&
          !KATEX_ONLY_SHORTCUTS.includes(
            key as (typeof KATEX_ONLY_SHORTCUTS)[number],
          ),
      )
      .toSorted();
    const staleAllowlist = KATEX_ONLY_SHORTCUTS.filter(
      (key) => !katexKeys.includes(key),
    );

    expect(unexplained).toEqual([]);
    expect(staleAllowlist).toEqual([]);
  });
});
