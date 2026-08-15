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
  '\\bpsi',
  '\\brho',
  '\\btau',
  '\\eZ',
  '\\tv',
] as const;

/**
 * Destination tokens max-style emits that are not `katexMacros` keys.
 * Built-in TeX stays here when it appears inside a destination; custom
 * shortcuts stay here only when the progress-view renderer should not
 * define them. A new max-only token must be added here or given a KaTeX
 * macro, so unknown control sequences cannot land in the progress view
 * unnoticed.
 */
const MAX_ONLY_SHORTCUTS = [
  // Built-in TeX / KaTeX commands that appear inside destinations
  '\\beta',
  '\\cref',
  '\\frac',
  '\\infty',
  '\\int',
  '\\label',
  '\\log',
  '\\mathbf',
  '\\mathcal',
  '\\mathrm',
  '\\phi',
  '\\ref',
  '\\tau',
  '\\text',
  '\\top',

  // Math operators and text commands without a KaTeX shortcut
  '\\AdaLN',
  '\\Attention',
  '\\Cat',
  '\\Dropout',
  '\\FFN',
  '\\Ito',
  '\\MultiHead',
  '\\Output',
  '\\PE',
  '\\Strat',
  '\\TransformerEncoder',
  '\\accept',
  '\\argmax',
  '\\argmin',
  '\\argsort',
  '\\class',
  '\\decoder',
  '\\discrete',
  '\\diss',
  '\\encoder',
  '\\full',
  '\\head',
  '\\irr',
  '\\mar',
  '\\nc',
  '\\observed',
  '\\pool',
  '\\pos',
  '\\rev',
  '\\sort',
  '\\window',

  // Single-letter and Greek destinations without a KaTeX shortcut
  '\\M',
  '\\N',
  '\\S',
  '\\Ta',
  '\\be',
  '\\bf',
  '\\io',
  '\\ka',
  '\\t',
  '\\ups',
  '\\x',

  // Mathcal / mathbb letters without a KaTeX shortcut
  '\\cA',
  '\\cB',
  '\\cC',
  '\\cD',
  '\\cE',
  '\\cG',
  '\\cI',
  '\\cJ',
  '\\cK',
  '\\cQ',
  '\\cR',
  '\\cU',
  '\\cV',
  '\\cX',
  '\\cY',
  '\\cZ',
  '\\eI',
  '\\eT',
  '\\eV',

  // Differential, tilde, and hat destinations without a KaTeX shortcut
  '\\ddS',
  '\\ddbeta',
  '\\ddbx',
  '\\ddbxi',
  '\\ddbz',
  '\\ddbze',
  '\\ddtau',
  '\\ddttau',
  '\\hpi',
  '\\tJ',
  '\\tM',
  '\\tP',
  '\\tT',
  '\\tZ',
  '\\tbGa',
  '\\tbT',
  '\\tbX',
  '\\tba',
  '\\tbeta',
  '\\tbla',
  '\\tbp',
  '\\tbpi',
  '\\tbv',
  '\\tbw',
  '\\tbxi',
  '\\tcQ',
  '\\tla',
  '\\tmu',
  '\\tq',
  '\\ttauf',
  '\\ttf',
  '\\tze',
  '\\wtit',
] as const;

describe('katexMacros vs maxRules shortcuts', () => {
  it('maps bold Greek destinations to KaTeX short forms', () => {
    const { patterns } = MAX_STYLE_REPLACEMENTS;
    expect(patterns['\\boldsymbol{\\alpha}']).toBe('\\bal');
    expect(patterns['\\boldsymbol{\\eta}']).toBe('\\bet');
    expect(patterns['\\boldsymbol{\\Lambda}']).toBe('\\bLa');
    expect(patterns['\\boldsymbol{\\sigma}']).toBe('\\bsg');
    expect(patterns['\\boldsymbol{\\varphi}']).toBe('\\bvphi');
  });

  it('keeps KaTeX keys and max-style destinations from drifting', () => {
    const shortcuts = maxStyleShortcutTokens();
    const katexKeys = Object.keys(katexMacros);

    const unexplainedKatex = katexKeys
      .filter(
        (key) =>
          !shortcuts.has(key) &&
          !KATEX_ONLY_SHORTCUTS.includes(
            key as (typeof KATEX_ONLY_SHORTCUTS)[number],
          ),
      )
      .toSorted();
    const staleKatexAllowlist = KATEX_ONLY_SHORTCUTS.filter(
      (key) => !katexKeys.includes(key),
    );

    const unexplainedMax = [...shortcuts]
      .filter(
        (token) =>
          !Object.hasOwn(katexMacros, token) &&
          !MAX_ONLY_SHORTCUTS.includes(
            token as (typeof MAX_ONLY_SHORTCUTS)[number],
          ),
      )
      .toSorted();
    const staleMaxAllowlist = MAX_ONLY_SHORTCUTS.filter(
      (token) => !shortcuts.has(token),
    );

    expect(unexplainedKatex).toEqual([]);
    expect(staleKatexAllowlist).toEqual([]);
    expect(unexplainedMax).toEqual([]);
    expect(staleMaxAllowlist).toEqual([]);
  });
});
