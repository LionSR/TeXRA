import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

import { resolveXtermTheme } from '@shared/wa/xtermTheme';

import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

useLitComponentTestDom();

const ANSI_TOKENS = [
  ['black', '--wa-color-terminal-ansi-black', '#010101'],
  ['red', '--wa-color-terminal-ansi-red', '#ff0000'],
  ['green', '--wa-color-terminal-ansi-green', '#00ff00'],
  ['yellow', '--wa-color-terminal-ansi-yellow', '#ffff00'],
  ['blue', '--wa-color-terminal-ansi-blue', '#0000ff'],
  ['magenta', '--wa-color-terminal-ansi-magenta', '#ff00ff'],
  ['cyan', '--wa-color-terminal-ansi-cyan', '#00ffff'],
  ['white', '--wa-color-terminal-ansi-white', '#f0f0f0'],
  ['brightBlack', '--wa-color-terminal-ansi-bright-black', '#111111'],
  ['brightRed', '--wa-color-terminal-ansi-bright-red', '#ff1111'],
  ['brightGreen', '--wa-color-terminal-ansi-bright-green', '#11ff11'],
  ['brightYellow', '--wa-color-terminal-ansi-bright-yellow', '#ffff11'],
  ['brightBlue', '--wa-color-terminal-ansi-bright-blue', '#1111ff'],
  ['brightMagenta', '--wa-color-terminal-ansi-bright-magenta', '#ff11ff'],
  ['brightCyan', '--wa-color-terminal-ansi-bright-cyan', '#11ffff'],
  ['brightWhite', '--wa-color-terminal-ansi-bright-white', '#ffffff'],
] as const;

describe('resolveXtermTheme', () => {
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('reads the full token map from the supplied target', () => {
    const target = document.createElement('div');
    target.style.setProperty('--wa-color-terminal-background', '#111111');
    target.style.setProperty('--wa-color-terminal-foreground', '#eeeeee');
    target.style.setProperty('--wa-color-surface-default', '#222222');
    target.style.setProperty('--wa-color-text-normal', '#dddddd');
    target.style.setProperty('--wa-color-terminal-cursor', '#00aa00');
    target.style.setProperty('--wa-color-terminal-selection-bg', '#264f78');
    target.style.setProperty('--wa-font-family-mono', '"JetBrains Mono"');
    for (const [, cssVar, value] of ANSI_TOKENS) {
      target.style.setProperty(cssVar, value);
    }
    document.body.append(target);

    const { theme, fontFamily } = resolveXtermTheme(target);

    expect(theme.background).toBe('#111111');
    expect(theme.foreground).toBe('#eeeeee');
    expect(theme.cursor).toBe('#00aa00');
    expect(theme.selectionBackground).toBe('#264f78');
    expect(fontFamily).toBe('"JetBrains Mono"');
    for (const [key, , value] of ANSI_TOKENS) {
      expect(theme[key]).toBe(value);
    }
    expect(warn).not.toHaveBeenCalled();
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

  it('uses hardcoded fallbacks when surface tokens are unset', () => {
    const target = document.createElement('div');
    document.body.append(target);

    const { theme, fontFamily } = resolveXtermTheme(target);
    expect(theme.background).toBe('#1e1e1e');
    expect(theme.foreground).toBe('#cccccc');
    expect(theme.selectionBackground).toBeUndefined();
    expect(theme.red).toBeUndefined();
    expect(fontFamily).toBe('monospace');
  });
});
