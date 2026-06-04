// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - tools
import { extractHoverText } from '@tools/lean/leanTypes';

describe('extractHoverText', () => {
  it('extracts plain string hover contents', () => {
    expect(extractHoverText('Nat.succ')).toBe('Nat.succ');
  });

  it('joins marked string hover contents', () => {
    expect(
      extractHoverText([
        { language: 'lean4', value: '#check Nat' },
        'natural numbers',
      ]),
    ).toBe('#check Nat\n\nnatural numbers');
  });

  it('extracts single marked string hover contents', () => {
    expect(extractHoverText({ language: 'lean4', value: '#check Nat' })).toBe(
      '#check Nat',
    );
  });

  it('extracts markup content hover values', () => {
    expect(
      extractHoverText({ kind: 'markdown', value: '**theorem** foo' }),
    ).toBe('**theorem** foo');
  });
});
