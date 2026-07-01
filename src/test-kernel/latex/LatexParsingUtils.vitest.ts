import { describe, expect, it } from 'vitest';

import { collectCommaSeparatedMatches } from '@latex/latexParsingUtils';

describe('collectCommaSeparatedMatches', () => {
  it('splits, trims, transforms, and de-duplicates first capture groups', () => {
    const tokens = collectCommaSeparatedMatches(
      String.raw`\cite{ alpha, beta }\cite{beta,gamma}`,
      /\\cite\{([^}]*)\}/g,
      (token) => token.toUpperCase(),
    );

    expect(tokens).toEqual(['ALPHA', 'BETA', 'GAMMA']);
  });

  it('rejects non-global patterns with a clear error', () => {
    expect(() =>
      collectCommaSeparatedMatches(
        String.raw`\cite{alpha}`,
        /\\cite\{([^}]*)\}/,
      ),
    ).toThrow(/global RegExp pattern/);
  });

  it('rejects patterns without a first capture group with a clear error', () => {
    expect(() =>
      collectCommaSeparatedMatches(
        String.raw`\cite{alpha}`,
        /\\cite\{[^}]*\}/g,
      ),
    ).toThrow(/first capture group/);
  });
});
