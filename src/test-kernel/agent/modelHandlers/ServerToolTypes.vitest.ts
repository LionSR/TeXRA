import { describe, expect, it } from 'vitest';

import { extractWebFetchResultFields } from '@agent/types/ServerTools';

const page = 'x'.repeat(20_001);

describe('extractWebFetchResultFields', () => {
  it.each([
    {
      shape: 'live',
      block: {
        content: {
          type: 'web_fetch_result',
          url: 'https://example.com/live',
          content: {
            title: 'Live',
            source: { type: 'text', data: page },
          },
        },
      },
    },
    {
      shape: 'archived',
      block: {
        url: 'https://example.com/archived',
        title: 'Archived',
        page_content: page,
      },
    },
  ])('applies the page-content cap to the $shape block shape', ({ block }) => {
    const fields = extractWebFetchResultFields(block);
    expect(fields?.content).toBe(`${'x'.repeat(19_997)}...`);
  });
});
