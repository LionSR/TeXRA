// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - tools under test
import { ToolError } from '@shared/schemas/toolResult';
import { replaceLiteralMatches } from '@tools/fileEditFlow';
import { ViewRangeSchema } from '@tools/formatting';

describe('replaceLiteralMatches', () => {
  it('returns the unique replacement and its 1-based line', () => {
    expect(
      replaceLiteralMatches({
        content: 'alpha\nbeta\ngamma',
        search: 'beta',
        replacement: 'delta',
        mode: 'unique',
        notFoundError: () => 'missing',
      }),
    ).toEqual({
      content: 'alpha\ndelta\ngamma',
      count: 1,
      lineNumbers: [2],
    });
  });

  it('reports every matching line through the declared ambiguity error', () => {
    expect(() =>
      replaceLiteralMatches({
        content: 'same\nother same\nsame',
        search: 'same',
        replacement: 'new',
        mode: 'unique',
        notFoundError: () => 'missing',
        multipleMatchesError: ({ count, lineNumbers }) =>
          `${count} matches on ${lineNumbers.join(',')}`,
      }),
    ).toThrow(new ToolError('3 matches on 1,2,3'));
  });

  it('replaces every literal match without interpreting dollar patterns', () => {
    expect(
      replaceLiteralMatches({
        content: 'OLD and OLD',
        search: 'OLD',
        replacement: '$&',
        mode: 'all',
        notFoundError: () => 'missing',
      }),
    ).toEqual({
      content: '$& and $&',
      count: 2,
      lineNumbers: [1],
    });
  });
});

describe('ViewRangeSchema', () => {
  it('accepts an inclusive 1-based range', () => {
    expect(ViewRangeSchema.parse([2, 5])).toEqual([2, 5]);
  });

  it.each([
    [0, 1],
    [2, 1],
    [1, 1.5],
  ])('rejects invalid range %j', (range) => {
    expect(ViewRangeSchema.safeParse(range).success).toBe(false);
  });
});
