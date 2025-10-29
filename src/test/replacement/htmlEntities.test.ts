import { strict as assert } from 'assert';

import { applyReplacements } from '@replacement/engine';
import {
  HTML_ENTITY_REPLACEMENTS,
  LATEX_XML_REPLACEMENTS,
} from '@replacement/rules';

describe('html entity replacements', () => {
  it('converts escaped xml tags into LaTeX environments', () => {
    const input = '&lt;critique&gt;Great job&lt;/critique&gt;';
    const expected = '\\begin{critique}Great job\\end{critique}';

    const result = applyReplacements(
      input,
      [HTML_ENTITY_REPLACEMENTS, LATEX_XML_REPLACEMENTS],
      { processMathUnicode: false },
    );

    assert.strictEqual(result, expected);
  });

  it('decodes common entities to LaTeX-safe output', () => {
    const input = 'Usage&nbsp;&amp;&nbsp;limits remain &le; 10';
    const expected = 'Usage~\\&~limits remain \\leq 10';

    const result = applyReplacements(
      input,
      HTML_ENTITY_REPLACEMENTS,
      { processMathUnicode: false },
    );

    assert.strictEqual(result, expected);
  });
});
