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
    ['foo/bar.tex', 'foo/bar.tex'],
    ['./foo/bar.tex', 'foo/bar.tex'],
    ['.//sections//intro', 'sections/intro'],
    ['sections//intro', 'sections/intro'],
  ])('normalizes %j → %j', (input, expected) => {
    expect(normalizeLatexPath(input)).toBe(expected);
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
