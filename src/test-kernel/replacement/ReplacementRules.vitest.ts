// Replacement rules that rewrite user documents: fenced blocks and the
// personal-style rules that must leave macro definitions alone.

import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import replacementEngine from '@replacement/engine';
import { FENCED_LATEX_BLOCK_REPLACEMENTS } from '@replacement/rulesRegex';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';

// ---------------------------------------------------------------------------
// fencedLatexBlocksRegex
// ---------------------------------------------------------------------------

/** The fenced-block rule set alone, applied as the engine applies a regex set. */
function applyFencedBlocks(text: string): string {
  const { patterns, flags } = FENCED_LATEX_BLOCK_REPLACEMENTS;
  return Object.entries(patterns).reduce((current, [pattern, replacement]) => {
    const regex = new RegExp(pattern, flags);
    return typeof replacement === 'string'
      ? current.replace(regex, replacement)
      : current.replace(regex, replacement);
  }, text);
}

describe('FENCED_LATEX_BLOCK_REPLACEMENTS', () => {
  it('preserves CRLF line endings', () => {
    assert.strictEqual(
      applyFencedBlocks('::: align*\r\n&= a + b\\\\\r\n:::\r\n'),
      '\\begin{align*}\r\n&= a + b\\\\\r\n\\end{align*}\r\n',
    );
  });

  it('is idempotent when applied repeatedly', () => {
    const input = String.raw`::: aligned
&= 0
:::
`;
    const once = applyFencedBlocks(input);
    assert.strictEqual(applyFencedBlocks(once), once);
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
