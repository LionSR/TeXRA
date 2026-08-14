import { describe, expect, it } from 'vitest';

import { resolveXtermTheme } from '@shared/wa/xtermTheme';

import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

useLitComponentTestDom();

describe('resolveXtermTheme', () => {
  it('reads tokens from the supplied target and falls cursor back to foreground', () => {
    const target = document.createElement('div');
    target.style.setProperty('--wa-color-surface-default', '#111111');
    target.style.setProperty('--wa-color-text-normal', '#eeeeee');
    target.style.setProperty('--wa-color-terminal-ansi-red', '#ff0000');
    target.style.setProperty('--wa-font-family-mono', '"JetBrains Mono"');
    document.body.append(target);

    const { theme, fontFamily } = resolveXtermTheme(target);

    expect(theme.background).toBe('#111111');
    expect(theme.foreground).toBe('#eeeeee');
    expect(theme.cursor).toBe('#eeeeee');
    expect(theme.red).toBe('#ff0000');
    expect(fontFamily).toBe('"JetBrains Mono"');
  });
});
