// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it, vi } from 'vitest';

// Local imports - utils
import {
  addCdataToTags,
  addCdataToTagsMultiple,
  removeCDATA,
} from '@utils/text/xmlCdata';
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

    const result = await formatContent(htmlInput);

    // Turndown's list items use the bullet marker plus three spaces.
    assert.equal(result, '**Plan**\n\n-   Step 1\n-   Step 2');
  });

  it('converts LaTeX scratchpad content to markdown structure', async () => {
    const latexInput = `\\section{Plan}\\begin{itemize}\\item Step 1\\item Step 2\\end{itemize}`;

    const result = await formatContent(latexInput);

    // \section{...} expands to '## ...\n\n' and each \item adds its own
    // leading newline, so a blank-plus-newline separates heading and list.
    assert.equal(result, '## Plan\n\n\n- Step 1\n- Step 2');
  });

  it('processes mixed HTML and LaTeX content sequentially', async () => {
    const mixedInput =
      '<div><strong>Plan</strong></div>\\begin{itemize}\\item Step 1\\item Step 2\\end{itemize}';

    const result = await formatContent(mixedInput);

    // Contract for mixed content: both fallback passes apply — the HTML half
    // becomes markdown emphasis and the LaTeX items become bullets. The exact
    // escaping of the LaTeX tail is an artifact of running the HTML pass
    // first and is deliberately not pinned.
    assert.ok(result.startsWith('**Plan**'));
    assert.ok(result.includes('- Step 1'));
    assert.ok(result.includes('- Step 2'));
  });

  it('passes through existing markdown content after trimming', async () => {
    const markdownInput = 'Plan:\n-  Step 1\n-   Step 2\n\n';

    const result = await formatContent(markdownInput);

    assert.equal(result, 'Plan:\n-  Step 1\n-   Step 2');
  });

  it('returns empty string for empty content', async () => {
    const result = await formatContent('');

    assert.equal(result, '');
  });
});

describe('xmlUtils.extractScratchpad', () => {
  it('extracts and formats scratchpad blocks', async () => {
    const response = `<?xml version="1.0"?><root><scratchpad>\\section{Plan}\\begin{itemize}\\item Step 1\\item Step 2\\end{itemize}</scratchpad></root>`;

    const result = await extractScratchpad(response);

    assert.equal(result, '## Plan\n\n\n- Step 1\n- Step 2');
  });
});

describe('xmlUtils CDATA handling', () => {
  it('does not double-wrap content that is already CDATA-wrapped', () => {
    const input =
      '<latex_document><![CDATA[Text with <xml-like> LaTeX & comments]]></latex_document>';

    const result = addCdataToTags(input, ['latex_document']);

    assert.equal(result, input);
  });

  it('does not double-wrap attributed tags that are already CDATA-wrapped', () => {
    const input =
      '<document name="main.tex"><![CDATA[Text with <xml-like> LaTeX & comments]]></document>';

    const result = addCdataToTagsMultiple(input, ['document']);

    assert.equal(result, input);
  });

  it('wraps malformed CDATA starts instead of treating them as complete', () => {
    const input =
      '<latex_document><![CDATA[Text with <xml-like> LaTeX</latex_document>';

    const result = addCdataToTags(input, ['latex_document']);

    assert.equal(
      result,
      '<latex_document><![CDATA[<![CDATA[Text with <xml-like> LaTeX]]></latex_document>',
    );
  });

  it('wraps malformed CDATA starts in attributed tags', () => {
    const input =
      '<document name="main.tex"><![CDATA[Text with <xml-like> LaTeX</document>';

    const result = addCdataToTagsMultiple(input, ['document']);

    assert.equal(
      result,
      '<document name="main.tex"><![CDATA[<![CDATA[Text with <xml-like> LaTeX]]></document>',
    );
  });

  it('removes nested CDATA wrappers left by legacy double-wrapping', () => {
    const input = '<![CDATA[<![CDATA[Text with <xml-like> LaTeX]]>]]>';

    const result = removeCDATA(input);

    assert.equal(result, 'Text with <xml-like> LaTeX');
  });
});
