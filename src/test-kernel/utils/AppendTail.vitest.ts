import { describe, expect, it } from 'vitest';
import { appendTail } from '@utils/text/appendTail';

describe('appendTail', () => {
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
