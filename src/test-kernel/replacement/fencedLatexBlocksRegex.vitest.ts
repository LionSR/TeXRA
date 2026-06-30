// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Node.js built-in imports

// Internal imports
import { applyReplacements } from '@replacement/engine';
import { FENCED_LATEX_BLOCK_REPLACEMENTS } from '@replacement/rulesRegex';

function convert(input: string): string {
  return applyReplacements(input, FENCED_LATEX_BLOCK_REPLACEMENTS, {
    processMathUnicode: false,
  });
}

describe('FENCED_LATEX_BLOCK_REPLACEMENTS', () => {
  it.each([
    {
      name: 'converts a basic aligned fence',
      input: String.raw`::: aligned
&= a + b\\
:::
`,
      expected: String.raw`\begin{aligned}
&= a + b\\
\end{aligned}
`,
    },
    {
      name: 'preserves indentation for align* blocks',
      input: String.raw`
  ::: align*
  x &= y\\
  :::
`,
      expected: String.raw`
  \begin{align*}
  x &= y\\
  \end{align*}
`,
    },
    {
      name: 'produces empty environments for blank bodies',
      input: String.raw`::: aligned
:::
`,
      expected: String.raw`\begin{aligned}

\end{aligned}
`,
    },
    {
      // Whitespace between the body and the closing fence stays part of the
      // body (see the trailing-spaces case below).
      name: 'converts inline fenced aligned blocks',
      input: '::: aligned {_i=1^n X_i t} &(-) :::',
      expected: '\\begin{aligned}\n{_i=1^n X_i t} &(-) \n\\end{aligned}',
    },
    {
      name: 'captures inline bodies with trailing spaces before the fence',
      input: '::: aligned a + b    :::',
      expected: '\\begin{aligned}\na + b    \n\\end{aligned}',
    },
    {
      name: 'preserves CRLF line endings',
      input: '::: align*\r\n&= a + b\\\\\r\n:::\r\n',
      expected: '\\begin{align*}\r\n&= a + b\\\\\r\n\\end{align*}\r\n',
    },
    {
      name: 'appends a trailing newline when the body lacks one',
      input: String.raw`::: gather
1\\
2
:::
`,
      expected: String.raw`\begin{gather}
1\\
2
\end{gather}
`,
    },
    {
      name: 'handles multiple fenced blocks in the same string',
      input: String.raw`::: aligned
0\\
:::
Text
::: gather
1\\\\
2
:::
`,
      expected: String.raw`\begin{aligned}
0\\
\end{aligned}
Text
\begin{gather}
1\\\\
2
\end{gather}
`,
    },
    {
      name: 'ignores unsupported fence names',
      input: String.raw`::: tip
content
:::
`,
      expected: String.raw`::: tip
content
:::
`,
    },
  ])('$name', ({ input, expected }) => {
    assert.strictEqual(convert(input), expected);
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
