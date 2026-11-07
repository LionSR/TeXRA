// Replacement rules that rewrite user documents: fenced blocks and the
// personal-style rules that must leave macro definitions alone.

import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import replacementEngine from '@replacement/engine';
import { fakeConfig } from '@test/support/FakePlatform';
import { TEXRA_APP } from '@test/support/texraApp';

// ---------------------------------------------------------------------------
// fencedLatexBlocksRegex
// ---------------------------------------------------------------------------

describe('fenced LaTeX blocks', () => {
  // XML output normalization runs the fenced-block pass whatever the config
  // enables; no other category is enabled here, so only that pass rewrites.
  const fencedOnly = (text: string) =>
    replacementEngine.applyToXmlContent(
      text,
      fakeConfig({ 'latex.enabledReplacements': [] }, TEXRA_APP.settings),
    ).text;

  it('preserves CRLF line endings', () => {
    assert.strictEqual(
      fencedOnly('::: align*\r\n&= a + b\\\\\r\n:::\r\nnext\r\n'),
      '\\begin{align*}\r\n&= a + b\\\\\r\n\\end{align*}\r\nnext',
    );
  });

  it('is idempotent when applied repeatedly', () => {
    const input = String.raw`::: aligned
&= 0
:::
`;
    const once = fencedOnly(input);
    assert.strictEqual(fencedOnly(once), once);
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

// ---------------------------------------------------------------------------
// rule order
// ---------------------------------------------------------------------------

describe('rule order', () => {
  // A rule whose key contains a shorter rule's key must run first, or the
  // shorter rule rewrites its input away: `\;` alone becomes a space, which
  // left `\;+\;` as ` + ` instead of `+`.
  it('applies a rule before the shorter rules its key contains', () => {
    const result = replacementEngine.applyAll(
      String.raw`$a\;+\;b$`,
      fakeConfig({}, TEXRA_APP.settings),
    ).text;

    assert.strictEqual(result, '$a+b$');
  });
});
