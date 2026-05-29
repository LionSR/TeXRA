import { describe, expect, it } from 'vitest';

import { wolframRunSummary } from '@tools/wolfram/WolframTool';

describe('wolframRunSummary', () => {
  it('embeds the first code line so concurrent calls render as distinct rows', () => {
    const a = wolframRunSummary('Print[Prime[10]]');
    const b = wolframRunSummary('Integrate[x^2, x]');
    expect(a).toBe('Executed: Print[Prime[10]]');
    expect(b).toBe('Executed: Integrate[x^2, x]');
    expect(a).not.toBe(b);
  });

  it('skips leading blank lines and uses the first meaningful line', () => {
    expect(wolframRunSummary('\n\n  Solve[x + 1 == 0, x]  \nPrint[x]')).toBe(
      'Executed: Solve[x + 1 == 0, x]',
    );
  });

  it('truncates a long first line with an ellipsis', () => {
    const long =
      'Table[Prime[k], {k, 1, 100}] (* a deliberately very long inline comment *)';
    const out = wolframRunSummary(long);
    expect(out.startsWith('Executed: ')).toBe(true);
    expect(out).toContain('…');
    // 'Executed: ' (10) + truncateWithEllipsis budget (60)
    expect(out.length).toBe('Executed: '.length + 60);
  });

  it('falls back to plain "Executed" when the code is empty or blank', () => {
    expect(wolframRunSummary('')).toBe('Executed');
    expect(wolframRunSummary('   \n  \t ')).toBe('Executed');
  });
});
