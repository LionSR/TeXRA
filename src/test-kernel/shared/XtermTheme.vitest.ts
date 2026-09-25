import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

import { resolveXtermTheme } from '@ui/wa/xtermTheme';

import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

useLitComponentTestDom();

describe('resolveXtermTheme', () => {
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('falls cursor back to text-normal, then to foreground', () => {
    const target = document.createElement('div');
    target.style.setProperty('--wa-color-text-normal', '#eeeeee');
    document.body.append(target);

    expect(resolveXtermTheme(target).theme.cursor).toBe('#eeeeee');

    target.style.removeProperty('--wa-color-text-normal');
    expect(resolveXtermTheme(target).theme.cursor).toBe('#cccccc');
  });

  it('falls background and foreground back to surface tokens, then hardcoded', () => {
    const target = document.createElement('div');
    target.style.setProperty('--wa-color-surface-default', '#111111');
    target.style.setProperty('--wa-color-text-normal', '#eeeeee');
    document.body.append(target);

    const themed = resolveXtermTheme(target).theme;
    expect(themed.background).toBe('#111111');
    expect(themed.foreground).toBe('#eeeeee');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('--wa-color-terminal-background'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('--wa-color-terminal-foreground'),
    );

    target.style.removeProperty('--wa-color-surface-default');
    target.style.removeProperty('--wa-color-text-normal');
    const fallback = resolveXtermTheme(target).theme;
    expect(fallback.background).toBe('#1e1e1e');
    expect(fallback.foreground).toBe('#cccccc');
  });

  it('names each unresolved terminal token in a console warning', () => {
    // A host that maps the terminal pair to variables it never injects
    // resolves them to ''; the warning is what keeps that broken mapping
    // visible instead of silently keeping the surface palette.
    const target = document.createElement('div');
    target.style.setProperty('--wa-color-terminal-background', '#111111');
    document.body.append(target);

    const { theme } = resolveXtermTheme(target);

    expect(theme.background).toBe('#111111');
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0];
    expect(message).toContain('--wa-color-terminal-foreground');
    expect(message).not.toContain('--wa-color-terminal-background');
  });
});
