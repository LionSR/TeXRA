// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - extension frontend
import {
  buildLanguageModelToolInvocationMessage,
  type LanguageModelResearchToolName,
} from '@frontend/lm/languageModelToolInvocationMessage';

describe('buildLanguageModelToolInvocationMessage', () => {
  it.each<[LanguageModelResearchToolName, unknown, string]>([
    [
      'arxiv_search',
      { query: '  quantum\n  error correction  ' },
      'Searching arXiv for “quantum error correction”',
    ],
    [
      'crossref_search',
      { query: 'attention is all you need' },
      'Searching Crossref for “attention is all you need”',
    ],
    [
      'crossref_search',
      { command: 'doi', doi: '10.1038/nature12373' },
      'Looking up DOI “10.1038/nature12373”',
    ],
    [
      'web_fetch',
      { url: 'https://example.com:8443/papers/1' },
      'Fetching example.com:8443',
    ],
    // Unexpected input falls back to the bare action label.
    ['arxiv_search', null, 'Searching arXiv'],
    ['crossref_search', { query: 42 }, 'Searching Crossref'],
    ['web_fetch', { url: 'not a valid URL' }, 'Fetching web content'],
  ])('%s -> %s', (toolName, args, expected) => {
    expect(buildLanguageModelToolInvocationMessage(toolName, args)).toBe(
      expected,
    );
  });

  it('falls back safely when reading the input itself throws', () => {
    // Kept out of the table above: it.each serializes rows at collection
    // time, which would trip this getter outside the tested call.
    const boobyTrapped = Object.defineProperty({}, 'query', {
      get: () => {
        throw new Error('unexpected getter');
      },
    });

    expect(
      buildLanguageModelToolInvocationMessage('crossref_search', boobyTrapped),
    ).toBe('Searching Crossref');
  });
});
