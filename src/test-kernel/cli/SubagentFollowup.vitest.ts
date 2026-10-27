import { describe, expect, it } from 'vitest';

import { decodeXmlEntities } from '@shared/subagentFollowup';

describe('decodeXmlEntities', () => {
  it('decodes only XML entities in a single pass', () => {
    expect(decodeXmlEntities('&quot;&apos;&lt;&gt;&amp;')).toBe('"\'<>&');
    expect(decodeXmlEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeXmlEntities('&copy; &#39;')).toBe('&copy; &#39;');
  });
});
