// Suites for @utils/text/appendTail (appendTail + appendHead).

import { describe, expect, it } from 'vitest';
import { appendHead, appendTail } from '@utils/text/appendTail';

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

  it('returns an empty head at maxChars=0 even for a leading low surrogate', () => {
    // A lone low surrogate at index 0 must not push the surrogate-aware cut
    // below 0 — slice(0, -1) would return everything but the last character.
    expect(appendHead('\udc00abc', 'x', 0)).toBe('');
  });
});
