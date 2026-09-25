import { describe, expect, it } from 'vitest';

import { extractDocuments } from '@utils/text/xmlExtraction';

describe('extractDocuments legacy fallback (src/utils/text/xmlExtraction.ts)', () => {
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

  it('recovers a single doc from a bare \\documentclass block', () => {
    const xml =
      'No wrapper at all. \\documentclass[prl]{revtex4-2}\n' +
      '\\begin{document}Body\\end{document}\nafter';

    const result = extractDocuments(xml, 'documents', 'paper.tex');

    expect(result.method).toBe('latex');
    expect(result.documents).toEqual([
      {
        name: 'paper.tex',
        content:
          '\\documentclass[prl]{revtex4-2}\n\\begin{document}Body\\end{document}',
      },
    ]);
  });

  it('skips fallback when no name hint is provided', () => {
    const xml =
      'No wrapper at all. \\documentclass{article}\n' +
      '\\begin{document}x\\end{document}';

    const result = extractDocuments(xml, 'documents');

    expect(result.method).toBe('none');
    expect(result.documents).toBeNull();
  });
});
