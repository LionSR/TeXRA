import { strict as assert } from 'assert';

import { replacementEngine } from '@replacement/engine';

describe('personal style contextual replacements', () => {
  it('keeps macro definitions intact while rewriting usages', () => {
    const input = [
      '\\newcommand{\\tr}{\\mathrm{Tr}}',
      '\\newcommand{\\trace}[1]{\\mathrm{Tr}(#1)}',
      '\\renewcommand{\\Tr}{\\mathrm{tr}}',
      '\\providecommand{\\smalltr}{\\mathrm{tr}}',
      '$\\mathrm{Tr}$ and $\\mathrm{tr}$',
    ].join('\n');

    const result = replacementEngine.applyAll(input);

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
