import { strict as assert } from 'assert';

import { cleanSessionDescription } from '@agent/runtime/sessionDescription';

describe('cleanSessionDescription', () => {
  it('returns short text unchanged', () => {
    assert.equal(
      cleanSessionDescription('Reviewing introduction for clarity'),
      'Reviewing introduction for clarity',
    );
  });

  it('collapses newlines into single spaces', () => {
    assert.equal(
      cleanSessionDescription('Reviewing\nintroduction\n  for clarity'),
      'Reviewing introduction for clarity',
    );
  });

  it('strips surrounding quotes and backticks', () => {
    assert.equal(
      cleanSessionDescription('"Fixing TikZ arrows"'),
      'Fixing TikZ arrows',
    );
    assert.equal(
      cleanSessionDescription('`Fixing TikZ arrows`'),
      'Fixing TikZ arrows',
    );
    assert.equal(
      cleanSessionDescription("'Fixing TikZ arrows'"),
      'Fixing TikZ arrows',
    );
  });

  it('strips trailing sentence punctuation', () => {
    assert.equal(cleanSessionDescription('Fixing arrows.'), 'Fixing arrows');
    assert.equal(cleanSessionDescription('Fixing arrows!?'), 'Fixing arrows');
    assert.equal(cleanSessionDescription('Fixing arrows…'), 'Fixing arrows');
  });

  it('returns empty string when input is only quotes/punctuation', () => {
    assert.equal(cleanSessionDescription('"..."'), '');
    assert.equal(cleanSessionDescription('``'), '');
    assert.equal(cleanSessionDescription('   '), '');
  });

  it('truncates with ellipsis at 80 characters', () => {
    const long = 'a'.repeat(120);
    const result = cleanSessionDescription(long);
    assert.equal(result.length, 80);
    assert.ok(result.endsWith('…'));
  });
});
