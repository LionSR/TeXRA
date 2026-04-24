// Standard library imports
import { strict as assert } from 'assert';

// Local imports - utils
import {
  addCdataToTags,
  addCdataToTagsMultiple,
  extractScratchpad,
  formatContent,
  removeCDATA,
} from '@utils/text/xmlUtils';

describe('xmlUtils.formatContent', () => {
  it('converts HTML scratchpad content to markdown bullets', async () => {
    const htmlInput =
      '<scratchpad><div><strong>Plan</strong><ul><li>Step 1</li><li>Step 2</li></ul></div></scratchpad>';

    const result = await formatContent(htmlInput);

    assert.equal(result, '**Plan**\n\n- Step 1\n- Step 2');
  });

  it('converts LaTeX scratchpad content to markdown structure', async () => {
    const latexInput = `\\section{Plan}\\begin{itemize}\\item Step 1\\item Step 2\\end{itemize}`;

    const result = await formatContent(latexInput);

    assert.equal(result, '## Plan\n\n- Step 1\n- Step 2');
  });

  it('processes mixed HTML and LaTeX content sequentially', async () => {
    const mixedInput =
      '<div><strong>Plan</strong></div>\\begin{itemize}\\item Step 1\\item Step 2\\end{itemize>';

    const result = await formatContent(mixedInput);

    assert.equal(result, '**Plan**\n\n- Step 1\n- Step 2');
  });

  it('normalizes existing markdown formatting', async () => {
    const markdownInput = 'Plan:\n-  Step 1\n-   Step 2\n\n';

    const result = await formatContent(markdownInput);

    assert.equal(result, 'Plan:\n- Step 1\n- Step 2');
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

    assert.equal(result, '## Plan\n\n- Step 1\n- Step 2');
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
