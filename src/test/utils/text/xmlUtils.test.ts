// Standard library imports
import { strict as assert } from 'assert';

// Local imports - utils
import { extractScratchpad, formatContent } from '../../../utils/text/xmlUtils';

describe('xmlUtils.formatContent', () => {
  it('converts HTML scratchpad content to markdown bullets', async () => {
    const htmlInput = '<scratchpad><div><strong>Plan</strong><ul><li>Step 1</li><li>Step 2</li></ul></div></scratchpad>';

    const result = await formatContent(htmlInput);

    assert.equal(result, '**Plan**\n\n- Step 1\n- Step 2');
  });

  it('converts LaTeX scratchpad content to markdown structure', async () => {
    const latexInput = `\\section{Plan}\\begin{itemize}\\item Step 1\\item Step 2\\end{itemize}`;

    const result = await formatContent(latexInput);

    assert.equal(result, '## Plan\n- Step 1\n- Step 2');
  });
});

describe('xmlUtils.extractScratchpad', () => {
  it('extracts and formats scratchpad blocks', async () => {
    const response = `<?xml version="1.0"?><root><scratchpad>\\section{Plan}\\begin{itemize}\\item Step 1\\item Step 2\\end{itemize}</scratchpad></root>`;

    const result = await extractScratchpad(response);

    assert.equal(result, '## Plan\n- Step 1\n- Step 2');
  });
});
