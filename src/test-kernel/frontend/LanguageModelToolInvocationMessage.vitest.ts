// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - extension frontend
import { buildLanguageModelToolInvocationMessage } from '@frontend/lm/languageModelToolInvocationMessage';

describe('buildLanguageModelToolInvocationMessage', () => {
  it('adds validated context and falls back safely for unexpected input', () => {
    expect(
      buildLanguageModelToolInvocationMessage('arxiv_search', {
        query: '  quantum\n  error correction  ',
      }),
    ).toBe('Searching arXiv for “quantum error correction”');
    expect(
      buildLanguageModelToolInvocationMessage('crossref_search', {
        query: 'attention is all you need',
      }),
    ).toBe('Searching Crossref for “attention is all you need”');
    expect(
      buildLanguageModelToolInvocationMessage('crossref_search', {
        command: 'doi',
        doi: '10.1038/nature12373',
      }),
    ).toBe('Looking up DOI “10.1038/nature12373”');
    expect(
      buildLanguageModelToolInvocationMessage('web_fetch', {
        url: 'https://example.com:8443/papers/1',
      }),
    ).toBe('Fetching example.com:8443');

    expect(buildLanguageModelToolInvocationMessage('arxiv_search', null)).toBe(
      'Searching arXiv',
    );
    expect(
      buildLanguageModelToolInvocationMessage('crossref_search', { query: 42 }),
    ).toBe('Searching Crossref');
    expect(
      buildLanguageModelToolInvocationMessage('web_fetch', {
        url: 'not a valid URL',
      }),
    ).toBe('Fetching web content');
    expect(
      buildLanguageModelToolInvocationMessage(
        'crossref_search',
        Object.defineProperty({}, 'query', {
          get: () => {
            throw new Error('unexpected getter');
          },
        }),
      ),
    ).toBe('Searching Crossref');
  });
});
