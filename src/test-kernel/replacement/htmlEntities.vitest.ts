// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Node.js built-in imports

// Internal imports
import { applyReplacements } from '@replacement/engine';
import {
  HTML_ENTITY_REPLACEMENTS,
  LATEX_XML_REPLACEMENTS,
} from '@replacement/rules';

describe('html entity replacements', () => {
  it('converts escaped xml tags into LaTeX environments', () => {
    // 'response' is one of the LATEX_ENVIRONMENTS covered by the XML-to-LaTeX
    // conversions; arbitrary tag names are intentionally left untouched.
    const input = '&lt;response&gt;Great job&lt;/response&gt;';
    const expected = '\\begin{response}Great job\\end{response}';

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

    const result = applyReplacements(input, HTML_ENTITY_REPLACEMENTS, {
      processMathUnicode: false,
    });

    assert.strictEqual(result, expected);
  });

  it('covers extended math and greek entities safely', () => {
    const input =
      'Angles &ne; 0 &alpha;&rArr;&infin; &sum;=1 45&deg; &quot;quoted&quot; &frac12;&nbsp;items &Delta;&theta;';
    const expected =
      'Angles \\neq 0 \\alpha\\Rightarrow\\infty \\sum=1 45^{\\circ} "quoted" \\frac{1}{2}~items \\Delta\\theta';

    const result = applyReplacements(input, HTML_ENTITY_REPLACEMENTS, {
      processMathUnicode: false,
    });

    assert.strictEqual(result, expected);
  });
});
