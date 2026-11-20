import { describe, expect, it } from 'vitest';

import {
  bareLatexDocument,
  extractDocuments,
} from '@texra/agent/output/extraction/xmlExtraction';

describe('extractDocuments (packages/texra/src/agent/output/extraction/xmlExtraction.ts)', () => {
  it('reads <documents><document name> children', () => {
    const xml =
      '<documents><document name="a.tex">Body A</document>' +
      '<document name="b.tex">Body B</document></documents>';

    expect(extractDocuments(xml, 'documents')).toEqual([
      { name: 'a.tex', content: 'Body A' },
      { name: 'b.tex', content: 'Body B' },
    ]);
  });

  it('reads a bare \\documentclass block as the one named document', () => {
    const bare = '\\documentclass{article}\\begin{document}x\\end{document}';

    expect(extractDocuments(bare, 'documents')).toBeNull();
    expect(bareLatexDocument(bare, 'a.tex')).toEqual({
      name: 'a.tex',
      content: bare,
    });
  });
});
