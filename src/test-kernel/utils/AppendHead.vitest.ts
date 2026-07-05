import { describe, expect, it } from 'vitest';

import { appendHead } from '@utils/strings/appendHead';

describe('appendHead', () => {
  it('returns the current string when the chunk is empty', () => {
    expect(appendHead('abc', '', 10)).toBe('abc');
  });

  it('concatenates when within budget', () => {
    expect(appendHead('abc', 'def', 10)).toBe('abcdef');
  });

  it('truncates at the tail when over budget', () => {
    // joined = "0123456789abc" (13 chars), keep first 5 → "01234".
    expect(appendHead('0123456789', 'abc', 5)).toBe('01234');
  });

  it('freezes once the cap is reached — later chunks are dropped', () => {
    const first = appendHead('', 'FIRST-FATAL-ERROR', 8);
    expect(first).toBe('FIRST-FA');
    // Once the head is full, further chunks (even much later, much larger
    // ones) must not overwrite or extend it.
    const stillFrozen = appendHead(first, 'x'.repeat(10_000), 8);
    expect(stillFrozen).toBe('FIRST-FA');
  });

  it('clamps a negative cap to an empty head', () => {
    expect(appendHead('0123456789', 'abc', -1)).toBe('');
  });

  it('does not split surrogate pairs at the truncation boundary', () => {
    // "𐍈" (U+10348) is encoded as two UTF-16 code units: high D800, low DF48.
    // joined = "Y𐍈" (length 3); maxChars = 2 ⇒ cut at index 2, the low
    // surrogate of the pair. Without the surrogate-aware fix the slice would
    // yield a lone high surrogate + a dangling context; with the fix the cut
    // backs off before the whole codepoint.
    const out = appendHead('', 'Y𐍈', 2);
    expect(out).toBe('Y');
  });
});
