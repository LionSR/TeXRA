import { describe, expect, it } from 'vitest';

import { applyReplacements } from '@replacement/engine';
import { MAX_STYLE_REPLACEMENTS } from '@replacement/maxRules';
import { katexMacros } from '@shared/markdown/katexMacros';

const MAX_COMMAND = /\\[A-Za-z][A-Za-z0-9]*/g;

/** Command tokens that max-style replacements introduce (the shortcut side). */
function maxStyleShortcutTokens(): Set<string> {
  const tokens = new Set<string>();
  for (const destination of Object.values(MAX_STYLE_REPLACEMENTS.patterns)) {
    for (const match of destination.matchAll(MAX_COMMAND)) {
      tokens.add(match[0]);
    }
  }
  return tokens;
}

/** Command tokens that `applyReplacements` actually emits for max-style sources. */
function runtimeMaxStyleShortcutTokens(): Set<string> {
  const tokens = new Set<string>();
  for (const source of Object.keys(MAX_STYLE_REPLACEMENTS.patterns)) {
    const output = applyReplacements(source, MAX_STYLE_REPLACEMENTS, {
      cleanupPasses: false,
    });
    for (const match of output.matchAll(MAX_COMMAND)) {
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
  '\\beta',
  '\\cref',
  '\\frac',
  '\\hat',
  '\\infty',
  '\\int',
  '\\log',
  '\\mathbf',
  '\\mathcal',
  '\\mathrm',
  '\\phi',
  '\\ref',
  '\\tau',
  '\\text',
  '\\top',
] as const;

/**
 * Built-in TeX / KaTeX commands that appear in runtime max-style output
 * even though they are not `katexMacros` keys. Kept separate from
 * `MAX_ONLY_SHORTCUTS` because the runtime pass surfaces commands that
 * never appear verbatim in a destination table entry.
 */
const RUNTIME_ONLY_SHORTCUTS = [
  '\\bar',
  '\\boldsymbol',
  '\\cref',
  '\\frac',
  '\\hat',
  '\\infty',
  '\\int',
  '\\log',
  '\\mathbf',
  '\\mathcal',
  '\\mathrm',
  '\\phi',
  '\\ref',
  '\\rho',
  '\\tau',
  '\\text',
  '\\tilde',
  '\\top',
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

  it('maps bold Greek destinations to KaTeX short forms at runtime', () => {
    expect(
      applyReplacements('\\boldsymbol{\\alpha}', MAX_STYLE_REPLACEMENTS),
    ).toBe('\\bal');
    expect(
      applyReplacements('\\boldsymbol{\\eta}', MAX_STYLE_REPLACEMENTS),
    ).toBe('\\bet');
    expect(
      applyReplacements('\\boldsymbol{\\Lambda}', MAX_STYLE_REPLACEMENTS),
    ).toBe('\\bLa');
    expect(
      applyReplacements('\\boldsymbol{\\sigma}', MAX_STYLE_REPLACEMENTS),
    ).toBe('\\bsg');
    expect(
      applyReplacements('\\boldsymbol{\\varphi}', MAX_STYLE_REPLACEMENTS),
    ).toBe('\\bvphi');
  });

  it('keeps KaTeX built-ins out of the macro table', () => {
    // '\S' (section sign) and '\bf' (legacy bold switch) are KaTeX
    // built-ins; as settings macros they would override the built-ins on
    // every rendering surface, not just max-style output.
    expect(Object.hasOwn(katexMacros, '\\S')).toBe(false);
    expect(Object.hasOwn(katexMacros, '\\bf')).toBe(false);
    expect(Object.hasOwn(katexMacros, '\\sS')).toBe(true);
    expect(Object.hasOwn(katexMacros, '\\bbf')).toBe(true);
    const { patterns } = MAX_STYLE_REPLACEMENTS;
    expect(patterns['_{\\S}']).toBe('_\\sS');
    expect(patterns['^{\\S}']).toBe('^\\sS');
    expect(patterns['\\mathbf{f}']).toBe('\\bbf');
  });

  it('maps built-in-colliding sources to safe destinations at runtime', () => {
    expect(applyReplacements('_{\\S}', MAX_STYLE_REPLACEMENTS)).toBe('_\\sS');
    expect(applyReplacements('^{\\S}', MAX_STYLE_REPLACEMENTS)).toBe('^\\sS');
    expect(applyReplacements('\\mathbf{f}', MAX_STYLE_REPLACEMENTS)).toBe(
      '\\bbf',
    );
    expect(applyReplacements('{\\bf f}', MAX_STYLE_REPLACEMENTS)).toBe('\\bbf');
  });

  it('keeps decorated-H eff combinations intact at runtime', () => {
    expect(
      applyReplacements('\\mathcal{H}^{\\text{eff}}', MAX_STYLE_REPLACEMENTS),
    ).toBe('\\ceffH');
    expect(
      applyReplacements('\\cH^{\\text{eff}}', MAX_STYLE_REPLACEMENTS),
    ).toBe('\\ceffH');
    expect(
      applyReplacements('\\hat{H}^{\\text{eff}}', MAX_STYLE_REPLACEMENTS),
    ).toBe('\\hat{\\effH}');
    expect(
      applyReplacements('\\hH^{\\text{eff}}', MAX_STYLE_REPLACEMENTS),
    ).toBe('\\hat{\\effH}');
  });

  it('fires the eq/st compaction family at runtime', () => {
    expect(applyReplacements('p^{\\text{eq}}', MAX_STYLE_REPLACEMENTS)).toBe(
      '\\peq',
    );
    expect(applyReplacements('q^{\\text{eq}}', MAX_STYLE_REPLACEMENTS)).toBe(
      '\\qeq',
    );
    expect(applyReplacements('p^{\\text{st}}', MAX_STYLE_REPLACEMENTS)).toBe(
      '\\pst',
    );
    expect(applyReplacements('q^{\\text{st}}', MAX_STYLE_REPLACEMENTS)).toBe(
      '\\qst',
    );
    expect(
      applyReplacements('\\rho^{\\text{eq}}', MAX_STYLE_REPLACEMENTS),
    ).toBe('\\rhoeq');
    expect(
      applyReplacements('\\rho_{\\text{eq}}', MAX_STYLE_REPLACEMENTS),
    ).toBe('\\rhoeq');
    expect(
      applyReplacements('\\rho^{\\text{st}}', MAX_STYLE_REPLACEMENTS),
    ).toBe('\\rhost');
    expect(
      applyReplacements('\\rho_{\\text{st}}', MAX_STYLE_REPLACEMENTS),
    ).toBe('\\rhost');
  });

  it('keeps runtime max-style output resolvable by the renderer macros', () => {
    const runtimeShortcuts = runtimeMaxStyleShortcutTokens();
    const unexplainedRuntime = [...runtimeShortcuts]
      .filter(
        (token) =>
          !Object.hasOwn(katexMacros, token) &&
          !RUNTIME_ONLY_SHORTCUTS.includes(
            token as (typeof RUNTIME_ONLY_SHORTCUTS)[number],
          ),
      )
      .toSorted();
    const staleRuntimeAllowlist = RUNTIME_ONLY_SHORTCUTS.filter(
      (token) => !runtimeShortcuts.has(token),
    );

    expect(unexplainedRuntime).toEqual([]);
    expect(staleRuntimeAllowlist).toEqual([]);
  });
});
