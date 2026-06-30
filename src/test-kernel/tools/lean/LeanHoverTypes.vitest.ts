// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - tools
import { extractHoverText } from '@tools/lean/leanTypes';

describe('extractHoverText', () => {
  it.each<{
    name: string;
    contents: Parameters<typeof extractHoverText>[0];
    expected: string;
  }>([
    {
      name: 'extracts plain string hover contents',
      contents: 'Nat.succ',
      expected: 'Nat.succ',
    },
    {
      name: 'joins marked string hover contents',
      contents: [{ language: 'lean4', value: '#check Nat' }, 'natural numbers'],
      expected: '#check Nat\n\nnatural numbers',
    },
    {
      name: 'extracts single marked string hover contents',
      contents: { language: 'lean4', value: '#check Nat' },
      expected: '#check Nat',
    },
    {
      name: 'extracts markup content hover values',
      contents: { kind: 'markdown', value: '**theorem** foo' },
      expected: '**theorem** foo',
    },
  ])('$name', ({ contents, expected }) => {
    expect(extractHoverText(contents)).toBe(expected);
  });
});
