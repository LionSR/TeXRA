import { strict as assert } from 'assert';

import { applyReplacements } from '@replacement/engine';
import { EQUATION_STYLE_REPLACEMENTS } from '@replacement/rulesRegex';

function normalize(input: string): string {
  return applyReplacements(input, EQUATION_STYLE_REPLACEMENTS, {
    processMathUnicode: false,
  });
}

describe('EQUATION_STYLE_REPLACEMENTS - blank line normalization', () => {
  it('collapses extra blank lines after equation begins', () => {
    const environments = [
      'align',
      'align*',
      'aligned',
      'aligned*',
      'alignat',
      'alignat*',
      'gather',
      'gather*',
      'multline',
      'multline*',
      'equation',
      'equation*',
    ];

    for (const env of environments) {
      const input = String.raw`\begin{${env}}\n\n\nbody\n\end{${env}}`;
      const expected = String.raw`\begin{${env}}\nbody\n\end{${env}}`;
      assert.strictEqual(normalize(input), expected, `Failed for ${env}`);
    }
  });

  it('collapses extra blank lines before equation ends', () => {
    const input = String.raw`\begin{gather}\nbody\n\n\n\end{gather}`;
    const expected = String.raw`\begin{gather}\nbody\n\end{gather}`;
    assert.strictEqual(normalize(input), expected);
  });

  it('preserves indentation and CRLF line endings', () => {
    const input = String.raw`  \begin{aligned}\r\n\r\n\r\n  content\r\n\r\n  \end{aligned}`;
    const expected = String.raw`  \begin{aligned}\r\n  content\r\n  \end{aligned}`;
    assert.strictEqual(normalize(input), expected);
  });

  it('leaves single blank lines untouched', () => {
    const input = String.raw`\begin{equation}\n\nx\n\n\end{equation}`;
    assert.strictEqual(normalize(input), input);
  });
});
