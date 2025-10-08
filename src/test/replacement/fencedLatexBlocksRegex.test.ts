import { strict as assert } from 'assert';

import { applyReplacements } from '@replacement/engine';
import { FENCED_LATEX_BLOCK_REPLACEMENTS } from '@replacement/rulesRegex';

function convert(input: string): string {
  return applyReplacements(input, FENCED_LATEX_BLOCK_REPLACEMENTS, {
    processMathUnicode: false,
  });
}

describe('FENCED_LATEX_BLOCK_REPLACEMENTS', () => {
  it('converts a basic aligned fence', () => {
    const input = String.raw`::: aligned
&= a + b\\
:::
`;
    const expected = String.raw`\begin{aligned}
&= a + b\\
\end{aligned}
`;
    assert.strictEqual(convert(input), expected);
  });

  it('preserves indentation for align* blocks', () => {
    const input = String.raw`
  ::: align*
  x &= y\\
  :::
`;
    const expected = String.raw`
  \begin{align*}
  x &= y\\
  \end{align*}
`;
    assert.strictEqual(convert(input), expected);
  });

  it('produces empty environments for blank bodies', () => {
    const input = String.raw`::: aligned
:::
`;
    const expected = String.raw`\begin{aligned}

\end{aligned}
`;
    assert.strictEqual(convert(input), expected);
  });

  it('handles multiple fenced blocks in the same string', () => {
    const input = String.raw`::: aligned
0\\
:::
Text
::: gather
1\\\\
2
:::
`;
    const expected = String.raw`\begin{aligned}
0\\
\end{aligned}
Text
\begin{gather}
1\\\\
2
\end{gather}
`;
    assert.strictEqual(convert(input), expected);
  });

  it('ignores unsupported fence names', () => {
    const input = String.raw`::: tip
content
:::
`;
    assert.strictEqual(convert(input), input);
  });

  it('is idempotent when applied repeatedly', () => {
    const input = String.raw`::: aligned
&= 0
:::
`;
    const once = convert(input);
    assert.strictEqual(convert(once), once);
  });
});
