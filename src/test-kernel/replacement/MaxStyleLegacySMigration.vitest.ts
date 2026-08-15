import { beforeEach, describe, expect, it, vi } from 'vitest';

import replacementEngine, { applyReplacements } from '@replacement/engine';
import {
  MAX_REGEX_REPLACEMENTS,
  restoreLatexSectionSign,
} from '@replacement/maxRules';

const configState = vi.hoisted(() => ({
  enabledReplacements: [] as string[],
  enabledReplacementsRegex: [] as string[],
}));

vi.mock('@utils/config/configUtils', () => ({
  getConfig: <T>(key: string, fallback: T): T => {
    if (key === 'texra.latex.enabledReplacements') {
      return configState.enabledReplacements as T;
    }
    if (key === 'texra.latex.enabledReplacementsRegex') {
      return configState.enabledReplacementsRegex as T;
    }
    return fallback;
  },
}));

describe('legacy unbraced S migration gating', () => {
  beforeEach(() => {
    configState.enabledReplacements = [];
    configState.enabledReplacementsRegex = [];
  });

  it('runs the migration when max_style is enabled without max_style_regex', () => {
    configState.enabledReplacements = ['max_style'];

    expect(replacementEngine.applyAll('_\\S')).toBe('_\\sS');
    expect(replacementEngine.applyAll('^\\S')).toBe('^\\sS');
  });

  it('still runs the migration through max_style_regex when it is enabled', () => {
    configState.enabledReplacementsRegex = ['max_style_regex'];

    expect(replacementEngine.applyAll('_\\S')).toBe('_\\sS');
    expect(replacementEngine.applyAll('^\\S')).toBe('^\\sS');
  });

  it('does not run the migration when neither max-style group is enabled', () => {
    expect(replacementEngine.applyAll('_\\S')).toBe('_\\S');
    expect(replacementEngine.applyAll('^\\S')).toBe('^\\S');
  });

  it('keeps the migration boundary-aware under the max_style gate', () => {
    configState.enabledReplacements = ['max_style'];

    expect(replacementEngine.applyAll('_\\Strat')).toBe('_\\Strat');
    expect(replacementEngine.applyAll('^\\Sig')).toBe('^\\Sig');
    expect(replacementEngine.applyAll('\\_\\S')).toBe('\\_\\S');
    expect(replacementEngine.applyAll('\\^\\S')).toBe('\\^\\S');
    // The documented digit ambiguity is still migrated.
    expect(replacementEngine.applyAll('x^\\S2')).toBe('x^\\sS2');
  });
});

describe('restoreLatexSectionSign', () => {
  it('converts the KaTeX-only destination back to the LaTeX built-in', () => {
    expect(restoreLatexSectionSign('_\\sS')).toBe('_\\S');
    expect(restoreLatexSectionSign('^\\sS')).toBe('^\\S');
    expect(restoreLatexSectionSign('x^\\sS2')).toBe('x^\\S2');
  });

  it('keeps the boundary-aware behavior for S-prefixed commands', () => {
    expect(restoreLatexSectionSign('_\\sStrat')).toBe('_\\sStrat');
    expect(restoreLatexSectionSign('^\\sSig')).toBe('^\\sSig');
    expect(restoreLatexSectionSign('\\sS')).toBe('\\sS');
  });

  it('leaves max-style braced sources for the replacement engine', () => {
    expect(restoreLatexSectionSign('_{\\S}')).toBe('_{\\S}');
    expect(restoreLatexSectionSign('^{\\S}')).toBe('^{\\S}');
  });
});

// Keep the direct category pins explicit: MAX_REGEX still carries the same
// migration rule through the shared pattern spread.
describe('MAX_REGEX direct migration', () => {
  it('migrates the legacy unbraced forms through the regex category', () => {
    expect(applyReplacements('_\\S', MAX_REGEX_REPLACEMENTS)).toBe('_\\sS');
    expect(applyReplacements('^\\S', MAX_REGEX_REPLACEMENTS)).toBe('^\\sS');
  });
});
