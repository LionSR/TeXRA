import { describe, expect, it, vi } from 'vitest';
import { addCdataToTagsMultiple, removeCDATA } from '@utils/text/xmlCdata';
import { formatContent } from '@utils/text/xmlConversion';
import { extractScratchpad } from '@utils/text/xmlExtraction';

// Pin the deterministic Turndown/regex fallback path: Pandoc availability is
// environment-dependent, so the conversion tests below would otherwise assert
// different output depending on whether `pandoc` happens to be installed.
vi.mock('@utils/system/toolUtils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@utils/system/toolUtils')>()),
  checkToolInstalled: async () => false,
}));

describe('xmlUtils.formatContent', () => {
  it('converts HTML scratchpad content to markdown bullets', async () => {
    const htmlInput =
      '<scratchpad><div><strong>Plan</strong><ul><li>Step 1</li><li>Step 2</li></ul></div></scratchpad>';

    // Turndown's list items use the bullet marker plus three spaces.
    expect(await formatContent(htmlInput)).toBe(
      '**Plan**\n\n-   Step 1\n-   Step 2',
    );
  });

  it('converts LaTeX scratchpad content to markdown structure', async () => {
    const latexInput = `\\section{Plan}\\begin{itemize}\\item Step 1\\item Step 2\\end{itemize}`;

    // \section{...} expands to '## ...\n\n' and each \item adds its own
    // leading newline, so a blank-plus-newline separates heading and list.
    expect(await formatContent(latexInput)).toBe(
      '## Plan\n\n\n- Step 1\n- Step 2',
    );
  });

  it('processes mixed HTML and LaTeX content sequentially', async () => {
    const mixedInput =
      '<div><strong>Plan</strong></div>\\begin{itemize}\\item Step 1\\item Step 2\\end{itemize}';

    const result = await formatContent(mixedInput);

    // Contract for mixed content: both fallback passes apply — the HTML half
    // becomes markdown emphasis and the LaTeX items become bullets. The exact
    // escaping of the LaTeX tail is an artifact of running the HTML pass
    // first and is deliberately not pinned.
    expect(result.startsWith('**Plan**')).toBe(true);
    expect(result).toContain('- Step 1');
    expect(result).toContain('- Step 2');
  });

  it('passes through existing markdown content after trimming', async () => {
    expect(await formatContent('Plan:\n-  Step 1\n-   Step 2\n\n')).toBe(
      'Plan:\n-  Step 1\n-   Step 2',
    );
  });

  it('returns empty string for empty content', async () => {
    expect(await formatContent('')).toBe('');
  });
});

describe('xmlUtils.extractScratchpad', () => {
  it('extracts and formats scratchpad blocks', async () => {
    const response = `<?xml version="1.0"?><root><scratchpad>\\section{Plan}\\begin{itemize}\\item Step 1\\item Step 2\\end{itemize}</scratchpad></root>`;

    expect(await extractScratchpad(response)).toBe(
      '## Plan\n\n\n- Step 1\n- Step 2',
    );
  });
});

describe('xmlUtils CDATA handling', () => {
  it.each([
    {
      tag: 'latex_document',
      input:
        '<latex_document><![CDATA[Text with <xml-like> LaTeX & comments]]></latex_document>',
    },
    {
      tag: 'document',
      input:
        '<document name="main.tex"><![CDATA[Text with <xml-like> LaTeX & comments]]></document>',
    },
  ])(
    'does not double-wrap $tag content that is already CDATA-wrapped',
    ({ tag, input }) => {
      expect(addCdataToTagsMultiple(input, [tag])).toBe(input);
    },
  );

  it.each([
    {
      tag: 'latex_document',
      input:
        '<latex_document><![CDATA[Text with <xml-like> LaTeX</latex_document>',
      expected:
        '<latex_document><![CDATA[<![CDATA[Text with <xml-like> LaTeX]]></latex_document>',
    },
    {
      tag: 'document',
      input:
        '<document name="main.tex"><![CDATA[Text with <xml-like> LaTeX</document>',
      expected:
        '<document name="main.tex"><![CDATA[<![CDATA[Text with <xml-like> LaTeX]]></document>',
    },
  ])(
    'wraps malformed CDATA starts in $tag tags',
    ({ tag, input, expected }) => {
      expect(addCdataToTagsMultiple(input, [tag])).toBe(expected);
    },
  );

  it('removes nested CDATA wrappers left by legacy double-wrapping', () => {
    expect(
      removeCDATA('<![CDATA[<![CDATA[Text with <xml-like> LaTeX]]>]]>'),
    ).toBe('Text with <xml-like> LaTeX');
  });
});
