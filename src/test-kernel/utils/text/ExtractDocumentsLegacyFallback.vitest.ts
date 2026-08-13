import { describe, expect, it } from 'vitest';

import { extractDocuments } from '@utils/text/xmlExtraction';

describe('extractDocuments legacy fallback', () => {
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

  it('recovers a single doc from <latex_document> when name hint is provided', () => {
    const xml =
      'Preamble prose.<latex_document>\\documentclass{article}\n' +
      '\\begin{document}Hi\\end{document}</latex_document>';

    const result = extractDocuments(xml, 'documents', 'Draft/Draft1.tex');

    expect(result.method).toBe('latex_document');
    expect(result.documents).toEqual([
      {
        name: 'Draft/Draft1.tex',
        content: '\\documentclass{article}\n\\begin{document}Hi\\end{document}',
      },
    ]);
  });

  it('recovers a single doc from a ```latex fenced block', () => {
    const xml =
      'Looking at this...\n```latex\n\\documentclass{article}\n' +
      '\\begin{document}Body\\end{document}\n```\n';

    const result = extractDocuments(xml, 'documents', 'Draft1.tex');

    expect(result.method).toBe('markdown');
    expect(result.documents).toEqual([
      {
        name: 'Draft1.tex',
        content:
          '\\documentclass{article}\n\\begin{document}Body\\end{document}',
      },
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
      '<latex_document>\n\\documentclass{article}\n' +
      '\\begin{document}x\\end{document}\n</latex_document>';

    const result = extractDocuments(xml, 'documents');

    expect(result.method).toBe('none');
    expect(result.documents).toBeNull();
  });

  it('returns none when neither container nor legacy shape is present', () => {
    const result = extractDocuments(
      'Just prose, no LaTeX at all.',
      'documents',
      'paper.tex',
    );

    expect(result.method).toBe('none');
    expect(result.documents).toBeNull();
  });
});
