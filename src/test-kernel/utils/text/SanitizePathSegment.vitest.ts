// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { sanitizePathSegment } from '@utils/text/sanitizePathSegment';

describe('sanitizePathSegment', () => {
  it('lowercases, replaces disallowed chars, collapses runs, and trims edges', () => {
    expect(
      sanitizePathSegment('Claude Sonnet 4.5!!', {
        lowercase: true,
        invalidCharPattern: /[^a-z0-9-]/g,
        replacement: '-',
        collapseRepeats: true,
        trimReplacement: true,
      }),
    ).toBe('claude-sonnet-4-5');
  });

  it('falls back to a default when the result is empty', () => {
    expect(
      sanitizePathSegment('!!!', {
        invalidCharPattern: /[^A-Za-z0-9._-]/g,
        replacement: '-',
        collapseRepeats: true,
        trimReplacement: true,
        fallback: 'workspace',
      }),
    ).toBe('workspace');
  });

  it('returns an empty string when there is no fallback', () => {
    expect(
      sanitizePathSegment('!!!', {
        lowercase: true,
        invalidCharPattern: /[^a-z0-9-]/g,
        replacement: '-',
        collapseRepeats: true,
        trimReplacement: true,
      }),
    ).toBe('');
  });

  it('replaces without collapsing or trimming when those options are off', () => {
    expect(
      sanitizePathSegment('a:b<c>d', {
        invalidCharPattern: /[:<>"|?*\\/]/g,
        replacement: '_',
        fallback: 'document.pdf',
        maxLength: 255,
      }),
    ).toBe('a_b_c_d');
  });

  it('applies maxLength after fallback substitution', () => {
    expect(
      sanitizePathSegment('', {
        invalidCharPattern: /x/g,
        replacement: '_',
        fallback: 'abcdefgh',
        maxLength: 4,
      }),
    ).toBe('abcd');
  });
});
