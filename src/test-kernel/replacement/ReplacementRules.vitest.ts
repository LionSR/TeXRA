// Replacement rules that rewrite user documents: fenced blocks and the
// personal-style rules that must leave macro definitions alone.

import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import replacementEngine, { applyReplacements } from '@replacement/engine';
import { FENCED_LATEX_BLOCK_REPLACEMENTS } from '@replacement/rulesRegex';
import { fakeConfig } from '@test/support/FakePlatform';
import { TEXRA_APP } from '@test/support/texraApp';

// ---------------------------------------------------------------------------
// fencedLatexBlocksRegex
// ---------------------------------------------------------------------------

describe('FENCED_LATEX_BLOCK_REPLACEMENTS', () => {
  it('preserves CRLF line endings', () => {
    assert.strictEqual(
      applyReplacements(
        '::: align*\r\n&= a + b\\\\\r\n:::\r\n',
        FENCED_LATEX_BLOCK_REPLACEMENTS,
      ).text,
      '\\begin{align*}\r\n&= a + b\\\\\r\n\\end{align*}\r\n',
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

    // A fake host's config, with every rule at its catalog default.
    const result = replacementEngine.applyAll(
      input,
      fakeConfig({}, TEXRA_APP.settings),
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
