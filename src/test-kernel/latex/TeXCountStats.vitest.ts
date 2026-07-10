import { describe, expect, it } from 'vitest';

import { parseTeXCountStats } from '@latex/texcount';

describe('parseTeXCountStats', () => {
  it('extracts every recognized stat from a full texcount report', () => {
    const output = [
      'Words in text: 1234',
      'Words in headers: 12',
      'Words in float captions: 34',
      'Number of headers: 5',
      'Number of floats/tables/figures: 6/1/2',
      'Number of math inlines: 0',
      'Number of inline math: 89',
      'Number of displayed math: 7',
    ].join('\n');

    expect(parseTeXCountStats(output)).toEqual([
      { label: 'Text: 1234 words' },
      { label: 'Headers: 12' },
      { label: 'Captions: 34' },
      { label: 'Inline math: 89' },
      { label: 'Display math: 7' },
    ]);
  });

  it('omits stats missing from the report instead of padding with blanks', () => {
    expect(parseTeXCountStats('Words in text: 10')).toEqual([
      { label: 'Text: 10 words' },
    ]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(parseTeXCountStats('texcount produced no usable output')).toEqual(
      [],
    );
  });
});
