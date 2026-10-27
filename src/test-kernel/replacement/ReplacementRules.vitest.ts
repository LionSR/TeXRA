// Replacement rules that rewrite user documents: fenced blocks and the
// personal-style rules that must leave macro definitions alone.

import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import replacementEngine, { applyReplacements } from '@replacement/engine';
import { FENCED_LATEX_BLOCK_REPLACEMENTS } from '@replacement/rulesRegex';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';

// ---------------------------------------------------------------------------
// fencedLatexBlocksRegex
// ---------------------------------------------------------------------------

describe('FENCED_LATEX_BLOCK_REPLACEMENTS', () => {
  it.each([
    {
      name: 'preserves CRLF line endings',
      input: '::: align*\r\n&= a + b\\\\\r\n:::\r\n',
      expected: '\\begin{align*}\r\n&= a + b\\\\\r\n\\end{align*}\r\n',
    },
  ])('$name', ({ input, expected }) => {
    assert.strictEqual(
      applyReplacements(input, FENCED_LATEX_BLOCK_REPLACEMENTS).text,
      expected,
    );
  });

  it('is idempotent when applied repeatedly', () => {
    const input = String.raw`::: aligned
&= 0
:::
`;
    const once = applyReplacements(input, FENCED_LATEX_BLOCK_REPLACEMENTS).text;
    assert.strictEqual(
      applyReplacements(once, FENCED_LATEX_BLOCK_REPLACEMENTS).text,
      once,
    );
  });
});

// ---------------------------------------------------------------------------
// personalStyleContextual
// ---------------------------------------------------------------------------

describe('personal style contextual replacements', () => {
  it('keeps macro definitions intact while rewriting usages', () => {
    const input = [
      '\\newcommand{\\tr}{\\mathrm{Tr}}',
      '\\newcommand{\\trace}[1]{\\mathrm{Tr}(#1)}',
      '\\renewcommand{\\Tr}{\\mathrm{tr}}',
      '\\providecommand{\\smalltr}{\\mathrm{tr}}',
      '$\\mathrm{Tr}$ and $\\mathrm{tr}$',
    ].join('\n');

    const result = replacementEngine.applyAll(input, (key) =>
      testWorkspaceRoots().config.get(key),
    ).text;

    const expected = [
      '\\newcommand{\\tr}{\\mathrm{Tr}}',
      '\\newcommand{\\trace}[1]{\\mathrm{Tr}(#1)}',
      '\\renewcommand{\\Tr}{\\mathrm{tr}}',
      '\\providecommand{\\smalltr}{\\mathrm{tr}}',
      '$\\Tr$ and $\\tr$',
    ].join('\n');

    assert.strictEqual(result, expected);
  });
});
