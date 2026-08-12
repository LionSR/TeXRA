import { describe, expect, it } from 'vitest';

import { createCliStyle } from '@cli/runtime/style';

const ESC = '\u001b';

const STYLE_METHODS = [
  'success',
  'warn',
  'error',
  'emphasis',
  'muted',
  'command',
] as const;

describe('createCliStyle', () => {
  it('wraps text in SGR escapes when enabled', () => {
    const style = createCliStyle(true);
    expect(style.enabled).toBe(true);
    for (const method of STYLE_METHODS) {
      const out = style[method]('text');
      expect(out).toContain('text');
      expect(out.startsWith(ESC)).toBe(true);
      expect(out).not.toBe('text');
    }
  });

  it('is identity (no escapes) when disabled', () => {
    const style = createCliStyle(false);
    expect(style.enabled).toBe(false);
    for (const method of STYLE_METHODS) {
      expect(style[method]('text')).toBe('text');
    }
  });
});
