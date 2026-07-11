import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

import { extractWebFetchResultFields } from '@agent/types/ServerToolTypes';

describe('extractWebFetchResultFields', () => {
  it('applies the page-content cap to live and archived block shapes', () => {
    const page = 'x'.repeat(20_001);
    const blocks = [
      {
        content: {
          type: 'web_fetch_result',
          url: 'https://example.com/live',
          content: {
            title: 'Live',
            source: { type: 'text', data: page },
          },
        },
      },
      {
        url: 'https://example.com/archived',
        title: 'Archived',
        page_content: page,
      },
    ];

    for (const block of blocks) {
      const fields = extractWebFetchResultFields(block);
      assert.equal(fields?.content?.length, 20_000);
      assert.equal(fields?.content?.endsWith('...'), true);
      assert.equal(fields?.content, `${'x'.repeat(19_997)}...`);
    }
  });
});
