import { describe, expect, it } from 'vitest';

import { resolveArxivPaperDirectoryRelative } from '@latex/arxivProcessor';

describe('arXiv processor paths', () => {
  it('keeps custom arxiv destinations id-specific', () => {
    expect(
      resolveArxivPaperDirectoryRelative('2404.12175', {
        into: 'papers',
      }),
    ).toBe('papers/2404.12175');
    expect(
      resolveArxivPaperDirectoryRelative('math/0501234', {
        into: 'papers/',
      }),
    ).toBe('papers/math_0501234');
    expect(resolveArxivPaperDirectoryRelative('2404.12175')).toBe(
      'References/2404.12175',
    );
  });
});
