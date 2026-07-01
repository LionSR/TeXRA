import { describe, expect, it } from 'vitest';

import { appendTail } from '@utils/strings/appendTail';

describe('appendTail', () => {
  it('returns the current string when the chunk is empty', () => {
    expect(appendTail('abc', '', 10)).toBe('abc');
  });

  it('concatenates when within budget', () => {
    expect(appendTail('abc', 'def', 10)).toBe('abcdef');
  });

  it('truncates at the head when over budget', () => {
    // joined = "0123456789abc" (13 chars), keep last 5 → "89abc".
    expect(appendTail('0123456789', 'abc', 5)).toBe('89abc');
  });

  it('trims to retainChars (below the cap) when retainChars < maxChars', () => {
    // joined = "0123456789abc" (13). 13 > maxChars 10 ⇒ reset, keeping the
    // last retainChars (5) → "89abc". Models the 100k→80k webview policy.
    expect(appendTail('0123456789', 'abc', 10, 5)).toBe('89abc');
  });

  it('clamps retainChars to maxChars', () => {
    // Misconfigured callers still get the documented "at most maxChars" tail.
    expect(appendTail('0123456789', 'abc', 5, 100)).toBe('89abc');
  });

  it('clamps negative caps to an empty tail', () => {
    expect(appendTail('0123456789', 'abc', -1, 100)).toBe('');
  });

  it('does not reset while within maxChars even when retainChars is lower', () => {
    // joined = "012345ab" (8) ≤ maxChars 10 ⇒ plain append, no reset.
    expect(appendTail('012345', 'ab', 10, 5)).toBe('012345ab');
  });

  it('keeps a surrogate pair intact when trimming to retainChars', () => {
    // "𐍈" = D800 DF48. joined = "ab𐍈YZ" (length 6); maxChars 4 crossed ⇒
    // cut at index 6-3=3, the low surrogate; the fix advances past it so the
    // whole codepoint is dropped → "YZ".
    const out = appendTail('ab', '𐍈YZ', 4, 3);
    expect(out).toBe('YZ');
    expect(out.charCodeAt(0)).toBeLessThan(0xd800);
  });

  it('does not split surrogate pairs at the truncation boundary', () => {
    // "𐍈" (U+10348) is encoded as two UTF-16 code units: high D800, low DF48.
    // joined = "𐍈Y" (length 3); maxChars = 2 ⇒ cut at index 1, which is the
    // *low* surrogate of the pair. Without the surrogate-aware fix the slice
    // would yield a lone low surrogate ("\uDF48Y"); with the fix the cut
    // advances past it and we drop the whole codepoint.
    const out = appendTail('', '𐍈Y', 2);
    expect(out).toBe('Y');
    // Defense against accidental re-introduction of the dangling low surrogate.
    expect(out.charCodeAt(0)).toBeLessThan(0xd800);
  });
});
