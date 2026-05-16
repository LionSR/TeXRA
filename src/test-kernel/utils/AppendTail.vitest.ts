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

  it('does not split surrogate pairs at the truncation boundary', () => {
    // "𐍈" (U+10348) is a 4-byte char = 2 UTF-16 code units (D800 DF48).
    const prefix = 'X'.repeat(10);
    const chunk = '𐍈Y';
    // Total length = 10 + 2 + 1 = 13. maxChars = 4 ⇒ slice from index 9.
    // Index 9 is the low surrogate — appendTail must advance to 10 so the
    // pair stays intact (we lose the codepoint rather than yielding a lone
    // low surrogate).
    const out = appendTail(prefix, chunk, 4);
    expect(out.length).toBeLessThanOrEqual(4);
    expect(out.charCodeAt(0)).toBeLessThan(0xdc00);
  });
});
