// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  sanitizePathSegment,
  type SanitizePathSegmentOptions,
} from '@utils/text/sanitizePathSegment';

describe('sanitizePathSegment', () => {
  it.each([
    {
      name: 'lowercases, replaces disallowed chars, collapses runs, and trims edges',
      input: 'Claude Sonnet 4.5!!',
      options: {
        lowercase: true,
        invalidCharPattern: /[^a-z0-9-]/g,
        replacement: '-',
        collapseRepeats: true,
        trimReplacement: true,
      },
      expected: 'claude-sonnet-4-5',
    },
    {
      name: 'falls back to a default when the result is empty',
      input: '!!!',
      options: {
        invalidCharPattern: /[^A-Za-z0-9._-]/g,
        replacement: '-',
        collapseRepeats: true,
        trimReplacement: true,
        fallback: 'workspace',
      },
      expected: 'workspace',
    },
    {
      name: 'returns an empty string when there is no fallback',
      input: '!!!',
      options: {
        lowercase: true,
        invalidCharPattern: /[^a-z0-9-]/g,
        replacement: '-',
        collapseRepeats: true,
        trimReplacement: true,
      },
      expected: '',
    },
    {
      name: 'replaces without collapsing or trimming when those options are off',
      input: 'a:b<c>d',
      options: {
        invalidCharPattern: /[:<>"|?*\\/]/g,
        replacement: '_',
        fallback: 'document.pdf',
        maxLength: 255,
      },
      expected: 'a_b_c_d',
    },
    {
      name: 'applies maxLength after fallback substitution',
      input: '',
      options: {
        invalidCharPattern: /x/g,
        replacement: '_',
        fallback: 'abcdefgh',
        maxLength: 4,
      },
      expected: 'abcd',
    },
  ] satisfies Array<{
    name: string;
    input: string;
    options: SanitizePathSegmentOptions;
    expected: string;
  }>)('$name', ({ input, options, expected }) => {
    expect(sanitizePathSegment(input, options)).toBe(expected);
  });
});
