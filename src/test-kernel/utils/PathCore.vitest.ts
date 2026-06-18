import { describe, expect, it } from 'vitest';

import {
  getPathSegments,
  normalizeLatexPath,
  toPosixPath,
} from '@utils/core/pathCore';

describe('toPosixPath', () => {
  it('converts backslashes and collapses duplicate separators', () => {
    expect(toPosixPath(String.raw`sections\\intro`)).toBe('sections/intro');
    expect(toPosixPath('sections//intro')).toBe('sections/intro');
    expect(toPosixPath(String.raw`sections\/intro`)).toBe('sections/intro');
  });

  it('strips leading and trailing separators', () => {
    expect(toPosixPath('/sections/intro/')).toBe('sections/intro');
    expect(toPosixPath('\\sections\\intro\\')).toBe('sections/intro');
  });

  it.each([
    ['', '.'],
    ['.', '.'],
    ['foo/bar', 'foo/bar'],
    ['foo\\bar', 'foo/bar'],
    ['foo//bar', 'foo/bar'],
    ['/foo/bar', 'foo/bar'],
    ['foo/bar/', 'foo/bar'],
    ['  foo/bar  ', 'foo/bar'],
    ['a\\\\b\\c', 'a/b/c'],
    // pathe.normalize resolves .. and . segments
    ['foo/../bar', 'bar'],
    ['./foo/bar', 'foo/bar'],
    ['../shared/macros', '../shared/macros'],
  ])('converts %j → %j', (input, expected) => {
    expect(toPosixPath(input)).toBe(expected);
  });
});

describe('normalizeLatexPath', () => {
  it('normalizes redundant separators before removing leading dot segments', () => {
    expect(normalizeLatexPath('.//sections//intro')).toBe('sections/intro');
    expect(normalizeLatexPath(String.raw`.\\sections\\intro`)).toBe(
      'sections/intro',
    );
  });

  it.each([
    ['', ''],
    ['./', '.'],
    ['foo/bar.tex', 'foo/bar.tex'],
    ['./foo/bar.tex', 'foo/bar.tex'],
    ['.//sections//intro', 'sections/intro'],
    ['sections//intro', 'sections/intro'],
    ['sections/../main.tex', 'main.tex'],
  ])('normalizes %j → %j', (input, expected) => {
    expect(normalizeLatexPath(input)).toBe(expected);
  });

  it('preserves non-ASCII escaped path text while normalizing separators', () => {
    const unicodeSegment = '\u00E9tudes';
    expect(normalizeLatexPath(String.raw`./${unicodeSegment}\\intro.tex`)).toBe(
      `${unicodeSegment}/intro.tex`,
    );
  });

  it('handles long paths without changing segment text', () => {
    const longPath = Array.from(
      { length: 40 },
      (_, index) => `section-${index}`,
    ).join('//');
    const expected = Array.from(
      { length: 40 },
      (_, index) => `section-${index}`,
    ).join('/');

    expect(normalizeLatexPath(`./${longPath}`)).toBe(expected);
  });
});

describe('getPathSegments', () => {
  it.each([
    ['', []],
    ['.', []],
    ['foo/bar/baz', ['foo', 'bar', 'baz']],
    ['foo//bar', ['foo', 'bar']],
    ['/foo/bar/', ['foo', 'bar']],
  ])('segments %j → %j', (input, expected) => {
    expect(getPathSegments(input)).toEqual(expected);
  });
});
