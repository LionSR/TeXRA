import { describe, expect, it } from 'vitest';

import { createCliStyle } from '@cli/runtime/style';

const ESC = '\u001b';

describe('createCliStyle', () => {
  it('wraps text in SGR escapes when enabled', () => {
    const style = createCliStyle(true);
    expect(style.enabled).toBe(true);
    for (const fn of [
      style.success,
      style.warn,
      style.error,
      style.emphasis,
      style.muted,
      style.command,
    ]) {
      const out = fn('text');
      // Styled output keeps the original text but adds opening/closing escapes.
      expect(out).toContain('text');
      expect(out.startsWith(ESC)).toBe(true);
      expect(out).not.toBe('text');
    }
  });

  it('is identity (no escapes) when disabled', () => {
    const style = createCliStyle(false);
    expect(style.enabled).toBe(false);
    for (const fn of [
      style.success,
      style.warn,
      style.error,
      style.emphasis,
      style.muted,
      style.command,
    ]) {
      expect(fn('text')).toBe('text');
    }
  });
});
