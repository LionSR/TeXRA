// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  pluralize,
  splitContentLines,
  splitOutputLines,
} from '@utils/text/stringUtils';

describe('splitContentLines', () => {
  it('normalizes CRLF and drops the phantom line after a trailing newline', () => {
    const lines = splitContentLines('a\r\nb\r\nc\r\n');

    expect(lines).toEqual(['a', 'b', 'c']);
  });

  it('splits content without a trailing newline', () => {
    expect(splitContentLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('returns no lines for empty input', () => {
    expect(splitContentLines('')).toEqual([]);
  });
});

describe('splitOutputLines', () => {
  it('splits Unix-newline output and drops the trailing blank', () => {
    expect(splitOutputLines('foo\nbar\n')).toEqual(['foo', 'bar']);
  });

  it('normalizes CRLF before splitting', () => {
    expect(splitOutputLines('foo\r\nbar\r\n')).toEqual(['foo', 'bar']);
  });

  it('drops interior blank lines', () => {
    expect(splitOutputLines('foo\n\nbar')).toEqual(['foo', 'bar']);
  });

  it('returns an empty array for empty input', () => {
    expect(splitOutputLines('')).toEqual([]);
  });

  it('returns an empty array for a blank-only string', () => {
    expect(splitOutputLines('\n\n')).toEqual([]);
  });
});

describe('pluralize', () => {
  it('uses the singular form for one item', () => {
    expect(pluralize(1, 'entry')).toBe('entry');
  });

  it('uses library-backed pluralization when no override is provided', () => {
    expect(pluralize(2, 'entry')).toBe('entries');
  });

  it('honors explicit plural overrides', () => {
    expect(pluralize(2, 'person', 'people')).toBe('people');
  });
});
