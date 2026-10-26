import { describe, expect, it } from 'vitest';

import { extractDocuments } from '@texra/utils/text/xmlExtraction';

describe('extractDocuments (packages/texra/src/utils/text/xmlExtraction.ts)', () => {
  it('uses simple path when <documents><document name> is present', () => {
    const xml =
      '<documents><document name="a.tex">Body A</document>' +
      '<document name="b.tex">Body B</document></documents>';

    const result = extractDocuments(xml, 'documents', 'a.tex');

    expect(result.method).toBe('simple');
    expect(result.documents).toEqual([
      { name: 'a.tex', content: 'Body A' },
      { name: 'b.tex', content: 'Body B' },
    ]);
  });
});
